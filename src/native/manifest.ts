/**
 * The native messaging host manifest, and where it belongs.
 *
 * The location matters and is easy to get wrong: Zen does **not** patch
 * Firefox's manifest directory, despite third-party installers guessing
 * `.../Zen/`. It reads the Mozilla path, so that is where the manifest goes.
 * DEV-261 confirmed this by installing there and having Zen launch the host.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Must match `HOST_NAME` in the extension's background script. */
export const NATIVE_HOST_NAME = "to.nodus.zen_agent";

/** Must match the add-on id in `extension/manifest.json`. */
export const EXTENSION_ID = "zen-agent@zen-agent.local";

export interface NativeHostManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_extensions: readonly string[];
}

/**
 * Where Firefox and Zen look for per-user host manifests on macOS.
 *
 * Deliberately not the system-wide location: installing there would need
 * elevated privileges and would affect every user on the machine.
 */
export function manifestDirectory(home: string = homedir()): string {
  return join(
    home,
    "Library",
    "Application Support",
    "Mozilla",
    "NativeMessagingHosts",
  );
}

export function manifestPath(home?: string): string {
  return join(manifestDirectory(home), `${NATIVE_HOST_NAME}.json`);
}

/**
 * Build the manifest for a host executable at an absolute path.
 *
 * `allowed_extensions` is restricted to Zen Agent's own add-on id: any other
 * extension installed in the profile is refused the port, which matters because
 * this host is a bridge to a privileged API.
 */
export function nativeHostManifest(executablePath: string): NativeHostManifest {
  if (!executablePath.startsWith("/")) {
    throw new TypeError(
      "A native messaging host path must be absolute; Firefox does not resolve PATH.",
    );
  }

  return {
    name: NATIVE_HOST_NAME,
    description: "Zen Agent native messaging host",
    path: executablePath,
    type: "stdio",
    allowed_extensions: [EXTENSION_ID],
  };
}
