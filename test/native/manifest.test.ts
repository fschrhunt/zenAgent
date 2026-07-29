import { describe, expect, it } from "vitest";

import {
  EXTENSION_ID,
  manifestPath,
  nativeHostManifest,
  NATIVE_HOST_NAME,
} from "../../src/native/manifest.js";

describe("native messaging host manifest", () => {
  it("installs under the Mozilla directory, not a Zen-specific one", () => {
    // Zen does not patch this path, despite third-party installers guessing
    // `.../Zen/`. DEV-261 confirmed Zen reads the Mozilla location.
    const path = manifestPath("/Users/example");

    expect(path).toBe(
      `/Users/example/Library/Application Support/Mozilla/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    );
  });

  it("restricts the port to Zen Agent's own add-on", () => {
    const manifest = nativeHostManifest("/opt/zen-agent/bin/zen-agent-host");

    expect(manifest.allowed_extensions).toEqual([EXTENSION_ID]);
    expect(manifest.type).toBe("stdio");
  });

  it("refuses a relative executable path", () => {
    // Firefox does not resolve PATH, so a relative path silently never launches.
    expect(() => nativeHostManifest("bin/zen-agent-host")).toThrow(TypeError);
  });
});
