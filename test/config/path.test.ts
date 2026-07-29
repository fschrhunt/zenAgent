import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configPath,
  loadConfig,
  ZEN_AGENT_CONFIG_ENV,
} from "../../src/config/path.js";

describe("configuration path", () => {
  it("uses the documented macOS Application Support path", () => {
    expect(
      configPath({
        environment: {},
        homeDirectory: "/Users/tester",
        platform: "darwin",
      }),
    ).toBe("/Users/tester/Library/Application Support/zen-agent/config.json");
  });

  it("supports explicit and XDG paths for automation and non-macOS systems", () => {
    expect(
      configPath({
        environment: { [ZEN_AGENT_CONFIG_ENV]: "./fixture.json" },
        currentDirectory: "/workspace",
        homeDirectory: "/home/tester",
        platform: "linux",
      }),
    ).toBe("/workspace/fixture.json");
    expect(
      configPath({
        environment: { XDG_CONFIG_HOME: "/settings" },
        homeDirectory: "/home/tester",
        platform: "linux",
      }),
    ).toBe("/settings/zen-agent/config.json");
  });

  it("loads and validates a config file with its path in errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zen-agent-config-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: "daily",
        spaces: { personal: "space-personal" },
        routing: { rules: [], safeDefault: "personal" },
      }),
    );

    await expect(loadConfig(path)).resolves.toMatchObject({
      profile: "daily",
    });

    await writeFile(path, "{}");
    await expect(loadConfig(path)).rejects.toThrow(
      `Configuration '${path}' is invalid`,
    );
  });
});
