/**
 * Per-user installation for the Zen Agent native messaging host.
 *
 * Firefox needs an absolute executable path in its manifest. TypeScript emits
 * `native-host.js` as a non-executable module, so the installer creates a small
 * owner-only launcher that invokes the current Node executable with that
 * module. Nothing is installed system-wide and no target is ever overwritten.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTENSION_ID,
  manifestDirectory,
  manifestPath,
  nativeHostManifest,
  NATIVE_HOST_NAME,
} from "./manifest.js";

const LAUNCHER_MARKER = "# Managed by Zen Agent's native-host installer.";

export interface NativeHostInstallOptions {
  readonly home?: string;
  readonly hostModulePath?: string;
  readonly nodePath?: string;
  /** Injectable so portable tests can exercise the macOS installer. */
  readonly platform?: NodeJS.Platform;
}

export interface NativeHostInstallResult {
  readonly manifestPath: string;
  readonly launcherPath: string;
  readonly hostModulePath: string;
}

export interface NativeHostUninstallResult {
  readonly manifestPath: string;
  readonly launcherPath: string;
  readonly removed: boolean;
}

export function nativeHostInstallDirectory(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "Zen Agent");
}

export function nativeHostLauncherPath(home?: string): string {
  return join(nativeHostInstallDirectory(home), "zen-agent-host");
}

/**
 * The sibling module emitted by `npm run build`.
 *
 * In an installed package this resolves inside `dist/`; callers running from
 * TypeScript source can pass `--host-path` explicitly.
 */
export function defaultNativeHostModulePath(): string {
  return fileURLToPath(new URL("../native-host.js", import.meta.url));
}

function requireMacOS(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error(
      `Native host installation is supported on macOS only; detected ${platform}.`,
    );
  }
}

function requireAbsoluteFile(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path: ${path}`);
  }

  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist or is not a file: ${path}`);
  }
}

function requireExecutableFile(path: string, label: string): void {
  requireAbsoluteFile(path, label);

  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${path}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launcherContents(nodePath: string, hostModulePath: string): string {
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    `exec ${shellQuote(nodePath)} ${shellQuote(hostModulePath)} "$@"`,
    "",
  ].join("\n");
}

function refusal(path: string): Error {
  return new Error(
    `Refusing to overwrite existing native-host installation target: ${path}`,
  );
}

/**
 * Install the launcher and Firefox manifest without overwriting either target.
 */
export function installNativeHost(
  options: NativeHostInstallOptions = {},
): NativeHostInstallResult {
  requireMacOS(options.platform ?? process.platform);

  const home = options.home ?? homedir();
  const hostModulePath =
    options.hostModulePath ?? defaultNativeHostModulePath();
  const nodePath = options.nodePath ?? process.execPath;
  const launcherPath = nativeHostLauncherPath(home);
  const destinationManifestPath = manifestPath(home);

  requireAbsoluteFile(hostModulePath, "Native host module");
  requireExecutableFile(nodePath, "Node executable");

  for (const target of [launcherPath, destinationManifestPath]) {
    if (existsSync(target)) {
      throw refusal(target);
    }
  }

  mkdirSync(nativeHostInstallDirectory(home), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(manifestDirectory(home), {
    recursive: true,
    mode: 0o700,
  });

  let launcherCreated = false;

  try {
    writeFileSync(launcherPath, launcherContents(nodePath, hostModulePath), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o700,
    });
    launcherCreated = true;

    writeFileSync(
      destinationManifestPath,
      `${JSON.stringify(nativeHostManifest(launcherPath), null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    if (launcherCreated) {
      rmSync(launcherPath, { force: true });
    }
    throw error;
  }

  return {
    manifestPath: destinationManifestPath,
    launcherPath,
    hostModulePath,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isOwnedManifest(value: unknown, launcherPath: string): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const allowedExtensions = value["allowed_extensions"];

  return (
    value["name"] === NATIVE_HOST_NAME &&
    value["path"] === launcherPath &&
    value["type"] === "stdio" &&
    Array.isArray(allowedExtensions) &&
    allowedExtensions.length === 1 &&
    allowedExtensions[0] === EXTENSION_ID
  );
}

/**
 * Remove only files recognisably created by this installer.
 *
 * Both files are validated before either is removed, so a hand-edited or
 * third-party file is preserved and reported rather than partially uninstalling
 * the host.
 */
export function uninstallNativeHost(
  options: Pick<NativeHostInstallOptions, "home" | "platform"> = {},
): NativeHostUninstallResult {
  requireMacOS(options.platform ?? process.platform);

  const home = options.home ?? homedir();
  const launcherPath = nativeHostLauncherPath(home);
  const destinationManifestPath = manifestPath(home);
  const hasLauncher = existsSync(launcherPath);
  const hasManifest = existsSync(destinationManifestPath);

  if (!hasLauncher && !hasManifest) {
    return {
      manifestPath: destinationManifestPath,
      launcherPath,
      removed: false,
    };
  }

  if (
    hasLauncher &&
    !readFileSync(launcherPath, "utf8").startsWith(
      `#!/bin/sh\n${LAUNCHER_MARKER}\n`,
    )
  ) {
    throw new Error(
      `Refusing to remove a launcher not owned by Zen Agent: ${launcherPath}`,
    );
  }

  if (hasManifest) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(destinationManifestPath, "utf8"));
    } catch {
      throw new Error(
        `Refusing to remove an invalid native-host manifest: ${destinationManifestPath}`,
      );
    }

    if (!isOwnedManifest(parsed, launcherPath)) {
      throw new Error(
        `Refusing to remove a manifest not owned by Zen Agent: ${destinationManifestPath}`,
      );
    }
  }

  rmSync(destinationManifestPath, { force: true });
  rmSync(launcherPath, { force: true });

  return {
    manifestPath: destinationManifestPath,
    launcherPath,
    removed: true,
  };
}
