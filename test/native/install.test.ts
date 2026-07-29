import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  installNativeHost,
  nativeHostLauncherPath,
  uninstallNativeHost,
} from "../../src/native/install.js";
import {
  EXTENSION_ID,
  manifestPath,
  NATIVE_HOST_NAME,
} from "../../src/native/manifest.js";

const temporaryRoots: string[] = [];

function fixture(): { home: string; hostModulePath: string } {
  const root = mkdtempSync(join(tmpdir(), "zen-agent-install-"));
  const home = join(root, "home");
  const hostModulePath = join(root, "native-host.js");
  temporaryRoots.push(root);
  writeFileSync(hostModulePath, "#!/usr/bin/env node\n");
  return { home, hostModulePath };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native host installer", () => {
  it("writes an owner-only launcher and manifest to the macOS user paths", () => {
    const { home, hostModulePath } = fixture();
    const result = installNativeHost({
      home,
      hostModulePath,
      nodePath: process.execPath,
      platform: "darwin",
    });

    expect(result.launcherPath).toBe(nativeHostLauncherPath(home));
    expect(result.manifestPath).toBe(manifestPath(home));
    expect(statSync(result.launcherPath).mode & 0o777).toBe(0o700);
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);

    const launcher = readFileSync(result.launcherPath, "utf8");
    expect(launcher).toContain(process.execPath);
    expect(launcher).toContain(hostModulePath);

    const manifest: unknown = JSON.parse(
      readFileSync(result.manifestPath, "utf8"),
    );
    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: "Zen Agent native messaging host",
      path: result.launcherPath,
      type: "stdio",
      allowed_extensions: [EXTENSION_ID],
    });
  });

  it("refuses an existing manifest without creating a launcher", () => {
    const { home, hostModulePath } = fixture();
    const destinationManifestPath = manifestPath(home);
    mkdirSync(dirname(destinationManifestPath), { recursive: true });
    writeFileSync(destinationManifestPath, "existing");

    expect(() =>
      installNativeHost({
        home,
        hostModulePath,
        nodePath: process.execPath,
        platform: "darwin",
      }),
    ).toThrow(/Refusing to overwrite/);
    expect(existsSync(nativeHostLauncherPath(home))).toBe(false);
    expect(readFileSync(destinationManifestPath, "utf8")).toBe("existing");
  });

  it("refuses an existing launcher without creating a manifest", () => {
    const { home, hostModulePath } = fixture();
    const launcherPath = nativeHostLauncherPath(home);
    mkdirSync(dirname(launcherPath), { recursive: true });
    writeFileSync(launcherPath, "existing");

    expect(() =>
      installNativeHost({
        home,
        hostModulePath,
        nodePath: process.execPath,
        platform: "darwin",
      }),
    ).toThrow(/Refusing to overwrite/);
    expect(readFileSync(launcherPath, "utf8")).toBe("existing");
    expect(existsSync(manifestPath(home))).toBe(false);
  });

  it("refreshes a complete installation owned by Zen Agent", () => {
    const { home, hostModulePath } = fixture();
    const root = dirname(home);
    const replacementHostModulePath = join(root, "replacement-native-host.js");
    writeFileSync(replacementHostModulePath, "#!/usr/bin/env node\n");

    const installed = installNativeHost({
      home,
      hostModulePath,
      nodePath: process.execPath,
      platform: "darwin",
    });
    const originalManifest = readFileSync(installed.manifestPath, "utf8");

    const refreshed = installNativeHost({
      home,
      hostModulePath: replacementHostModulePath,
      nodePath: "/bin/sh",
      platform: "darwin",
    });

    expect(refreshed).toEqual({
      manifestPath: installed.manifestPath,
      launcherPath: installed.launcherPath,
      hostModulePath: replacementHostModulePath,
    });
    expect(readFileSync(refreshed.launcherPath, "utf8")).toContain(
      replacementHostModulePath,
    );
    expect(readFileSync(refreshed.launcherPath, "utf8")).toContain("/bin/sh");
    expect(readFileSync(refreshed.launcherPath, "utf8")).not.toContain(
      hostModulePath,
    );
    expect(readFileSync(refreshed.manifestPath, "utf8")).toBe(originalManifest);
    expect(statSync(refreshed.launcherPath).mode & 0o777).toBe(0o700);
  });

  it("refuses to refresh a launcher that is not owned by Zen Agent", () => {
    const { home, hostModulePath } = fixture();
    const installed = installNativeHost({
      home,
      hostModulePath,
      nodePath: process.execPath,
      platform: "darwin",
    });
    writeFileSync(installed.launcherPath, "#!/bin/sh\nforeign\n");

    expect(() =>
      installNativeHost({
        home,
        hostModulePath,
        nodePath: process.execPath,
        platform: "darwin",
      }),
    ).toThrow(/Refusing to overwrite/);
    expect(readFileSync(installed.launcherPath, "utf8")).toBe(
      "#!/bin/sh\nforeign\n",
    );
  });

  it("preserves a colliding replacement file during refresh", () => {
    const { home, hostModulePath } = fixture();
    const installed = installNativeHost({
      home,
      hostModulePath,
      nodePath: process.execPath,
      platform: "darwin",
    });
    const replacementPath = `${installed.launcherPath}.${String(process.pid)}.tmp`;
    writeFileSync(replacementPath, "foreign");

    expect(() =>
      installNativeHost({
        home,
        hostModulePath,
        nodePath: process.execPath,
        platform: "darwin",
      }),
    ).toThrow();
    expect(readFileSync(replacementPath, "utf8")).toBe("foreign");
  });

  it("uninstalls only the launcher and manifest it owns", () => {
    const { home, hostModulePath } = fixture();
    const installed = installNativeHost({
      home,
      hostModulePath,
      nodePath: process.execPath,
      platform: "darwin",
    });

    const result = uninstallNativeHost({ home, platform: "darwin" });

    expect(result.removed).toBe(true);
    expect(existsSync(installed.launcherPath)).toBe(false);
    expect(existsSync(installed.manifestPath)).toBe(false);
  });

  it("preserves a manifest that no longer matches Zen Agent's installation", () => {
    const { home, hostModulePath } = fixture();
    const installed = installNativeHost({
      home,
      hostModulePath,
      nodePath: process.execPath,
      platform: "darwin",
    });
    writeFileSync(
      installed.manifestPath,
      JSON.stringify({
        name: "someone.else",
        path: installed.launcherPath,
        type: "stdio",
        allowed_extensions: [EXTENSION_ID],
      }),
    );

    expect(() => uninstallNativeHost({ home, platform: "darwin" })).toThrow(
      /manifest not owned/,
    );
    expect(existsSync(installed.launcherPath)).toBe(true);
    expect(existsSync(installed.manifestPath)).toBe(true);
  });

  it("refuses to install outside macOS", () => {
    const { home, hostModulePath } = fixture();

    expect(() =>
      installNativeHost({
        home,
        hostModulePath,
        nodePath: process.execPath,
        platform: "linux",
      }),
    ).toThrow(/macOS only/);
  });

  it("treats uninstalling an absent host as a successful no-op", () => {
    const { home } = fixture();

    expect(uninstallNativeHost({ home, platform: "darwin" }).removed).toBe(
      false,
    );
  });
});
