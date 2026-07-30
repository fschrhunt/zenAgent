import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZenAgentConfig } from "../src/config/schema.js";
import {
  CLI_EXIT_CODES,
  runCli,
  type CliDependencies,
} from "../src/cli/run.js";
import { formatEntityReference } from "../src/cli/entity-reference.js";
import type { SetupWizardServices } from "../src/cli/wizard.js";
import {
  DaemonProtocolError,
  type DaemonMethod,
} from "../src/daemon/protocol.js";
import { browserFixture } from "./browser/fixtures.js";

interface DaemonCall {
  readonly method: DaemonMethod;
  readonly params: unknown;
  readonly idempotencyKey: string | undefined;
}

function cliHarness(
  handle: (call: DaemonCall) => unknown,
  overrides: Partial<CliDependencies> = {},
): {
  readonly dependencies: Partial<CliDependencies>;
  readonly calls: DaemonCall[];
  readonly close: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
} {
  const calls: DaemonCall[] = [];
  const close = vi.fn();
  const connect = vi.fn(() => Promise.resolve());
  return {
    calls,
    close,
    connect,
    dependencies: {
      configPath: () => "/tmp/zen-agent-test-config.json",
      readConfig: () => Promise.resolve(undefined),
      createDaemonClient: () => ({
        connect,
        request(method, params, idempotencyKey) {
          const call = { method, params, idempotencyKey };
          calls.push(call);
          return Promise.resolve(handle(call));
        },
        close,
      }),
      ...overrides,
    },
  };
}

describe("runCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the version", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["version"])).resolves.toBe(CLI_EXIT_CODES.success);
    expect(stdout).toHaveBeenCalledWith("0.1.0\n");
  });

  it("opens the setup wizard when invoked without arguments in a TTY", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const startSetupWizard = vi.fn(() => Promise.resolve());

    await expect(
      runCli([], {
        isInteractive: () => true,
        startSetupWizard,
      }),
    ).resolves.toBe(CLI_EXIT_CODES.success);
    expect(startSetupWizard).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("backs the wizard with sanitized daemon services", async () => {
    const fixture = browserFixture();
    const harness = cliHarness(({ method }) =>
      method === "status"
        ? {
            state: "connected",
            profileId: fixture.profile.id.transportId,
            counts: { spaces: 1, tabs: 1 },
          }
        : { sequence: 1, entities: [fixture.space] },
    );
    const startSetupWizard = vi.fn(async (services: SetupWizardServices) => {
      await expect(services.status()).resolves.toEqual({
        state: "connected",
        profileId: fixture.profile.id.transportId,
        spaces: 1,
        tabs: 1,
      });
      await expect(services.spaces()).resolves.toEqual([
        { id: fixture.space.id, name: "Personal" },
      ]);
    });

    await expect(
      runCli([], {
        ...harness.dependencies,
        isInteractive: () => true,
        startSetupWizard,
      }),
    ).resolves.toBe(CLI_EXIT_CODES.success);
    expect(harness.calls.map(({ method }) => method)).toEqual([
      "status",
      "registry.entities",
    ]);
  });

  it("prints help instead of prompting when invoked without a TTY", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const startSetupWizard = vi.fn(() => Promise.resolve());

    await expect(
      runCli([], {
        isInteractive: () => false,
        startSetupWizard,
      }),
    ).resolves.toBe(CLI_EXIT_CODES.success);
    expect(startSetupWizard).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining(
        "Agents and scripts should use explicit commands and --json where supported.",
      ),
    );
  });

  it("refuses an interactive setup prompt without a TTY", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      runCli(["setup"], { isInteractive: () => false }),
    ).resolves.toBe(CLI_EXIT_CODES.invalidInput);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("requires an interactive terminal"),
    );
  });

  it("uses the stable invalid-input exit code for an unknown command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(runCli(["drive-my-screen"])).resolves.toBe(
      CLI_EXIT_CODES.invalidInput,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Unknown command: drive-my-screen"),
    );
  });

  it("installs the native host and reports both created paths", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const installNativeHost = vi.fn(() => ({
      manifestPath: "/Users/example/manifest.json",
      launcherPath: "/Users/example/zen-agent-host",
      hostModulePath: "/opt/zen-agent/native-host.js",
    }));

    await expect(
      runCli(["native-host", "install"], { installNativeHost }),
    ).resolves.toBe(CLI_EXIT_CODES.success);
    expect(installNativeHost).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Manifest: /Users/example/manifest.json"),
    );
  });

  it("passes an explicit host module path to the installer", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const installNativeHost = vi.fn(() => ({
      manifestPath: "/Users/example/manifest.json",
      launcherPath: "/Users/example/zen-agent-host",
      hostModulePath: "/opt/zen-agent/native-host.js",
    }));

    await expect(
      runCli(
        [
          "native-host",
          "install",
          "--host-path",
          "/opt/zen-agent/native-host.js",
        ],
        { installNativeHost },
      ),
    ).resolves.toBe(CLI_EXIT_CODES.success);
    expect(installNativeHost).toHaveBeenCalledWith({
      hostModulePath: "/opt/zen-agent/native-host.js",
    });
  });

  it("surfaces installer refusals without a stack trace", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const installNativeHost = vi.fn(() => {
      throw new Error("Refusing to overwrite an existing manifest");
    });

    await expect(
      runCli(["native-host", "install"], { installNativeHost }),
    ).resolves.toBe(CLI_EXIT_CODES.internal);
    expect(stderr).toHaveBeenCalledWith(
      "zen-agent: internal: Refusing to overwrite an existing manifest\n",
    );
  });

  it("gets status through the daemon and always closes the client", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({
      state: "connected",
      profileId: "profile",
      sessionId: "session",
      counts: { spaces: 2, tabs: 4 },
    }));

    await expect(runCli(["status"], harness.dependencies)).resolves.toBe(0);
    expect(harness.connect).toHaveBeenCalledOnce();
    expect(harness.calls).toEqual([
      { method: "status", params: undefined, idempotencyKey: undefined },
    ]);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Tabs: 4"));
  });

  it("keeps the JSON status envelope stable", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({
      state: "connected",
      profileId: "profile",
      sessionId: "session",
      counts: { spaces: 2, tabs: 4 },
    }));

    await expect(
      runCli(["status", "--json"], harness.dependencies),
    ).resolves.toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "{
        "ok": true,
        "command": "status",
        "result": {
          "state": "connected",
          "profileId": "profile",
          "sessionId": "session",
          "counts": {
            "spaces": 2,
            "tabs": 4
          }
        }
      }
      "
    `);
  });

  it("reports sanitized doctor policy and speech state", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({
      state: "connected",
      daemonVersion: "0.1.0",
      protocolVersion: 1,
      profileId: "opaque-profile",
      compatibility: {
        browserVersion: "1.21.9b",
        geckoVersion: "153.0",
        extensionVersion: "0.1.0",
      },
      counts: { spaces: 2, tabs: 4 },
    }));

    await expect(
      runCli(["doctor", "--json"], {
        ...harness.dependencies,
        inspectNativeHost: () => ({
          status: "installed",
          manifestPath: "/private/manifest",
          launcherPath: "/private/launcher",
        }),
        inspectSpeechHelper: () => ({
          status: "available",
          contractVersion: 1,
        }),
        speechLocales: () => ({
          supportedLocales: ["en-US"],
          installedLocales: ["en-US"],
        }),
        inspectDownloadDirectory: () => Promise.resolve("writable"),
      }),
    ).resolves.toBe(0);

    const output = String(stdout.mock.calls[0]?.[0]);
    expect(output).toContain('"privateWindows": "hidden"');
    expect(output).toContain('"downloadsStatus": "writable"');
    expect(output).toContain('"browserVersion": "1.21.9b"');
    expect(output).toContain('"extensionVersion": "0.1.0"');
    expect(output).toContain('"installedLocales": [');
    expect(output).not.toContain("/private/");
  });

  it.each([
    ["browser-unavailable", CLI_EXIT_CODES.browserUnavailable],
    ["unsupported-capability", CLI_EXIT_CODES.unsupportedCapability],
    ["timeout", CLI_EXIT_CODES.timeout],
  ] as const)(
    "maps status %s to its stable exit code",
    async (code, expected) => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const harness = cliHarness(() => {
        throw new DaemonProtocolError(code, "sanitized failure");
      });

      await expect(runCli(["status"], harness.dependencies)).resolves.toBe(
        expected,
      );
    },
  );

  it("lists opaque Space IDs without a mutation request", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const harness = cliHarness(() => ({
      sequence: 1,
      entities: [fixture.space],
    }));

    await expect(
      runCli(["spaces", "list"], harness.dependencies),
    ).resolves.toBe(0);
    expect(harness.calls.map(({ method }) => method)).toEqual([
      "registry.entities",
    ]);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining(formatEntityReference(fixture.space.id)),
    );
  });

  it("does not expose browser operations through the setup CLI", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({}));

    await expect(runCli(["tabs", "list"], harness.dependencies)).resolves.toBe(
      CLI_EXIT_CODES.invalidInput,
    );
    expect(harness.calls).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Unknown command: tabs"),
    );
  });

  it("maps only currently discovered Spaces and preserves routing", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const destination = "/tmp/config.json";
    const write = vi.fn(() => Promise.resolve());
    const existing = {
      version: 1,
      profile: fixture.profile.id.transportId,
      spaces: {
        personal: fixture.space.id.transportId,
        aliases: {},
      },
      routing: {
        rules: [],
        safeDefault: "personal",
      },
    } satisfies ZenAgentConfig;
    const harness = cliHarness(
      ({ method }) =>
        method === "status"
          ? { profileId: fixture.profile.id.transportId }
          : { sequence: 1, entities: [fixture.space] },
      {
        readConfig: () => Promise.resolve(existing),
        writeConfig: write,
      },
    );

    await expect(
      runCli(
        [
          "config",
          "map",
          "--config",
          destination,
          "--alias",
          `research=${formatEntityReference(fixture.space.id)}`,
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.calls.map(({ method }) => method).toSorted()).toEqual([
      "registry.entities",
      "status",
    ]);
    expect(write).toHaveBeenCalledWith(
      destination,
      expect.objectContaining({
        routing: existing.routing,
        spaces: {
          personal: fixture.space.id.transportId,
          aliases: { research: fixture.space.id.transportId },
        },
      }),
    );
  });

  it("explicitly installs a speech locale and records it in config v2", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const write = vi.fn(() => Promise.resolve());
    const existing = {
      version: 1,
      profile: "profile",
      spaces: { personal: "space", aliases: {} },
      routing: { rules: [] },
    } satisfies ZenAgentConfig;

    await expect(
      runCli(["speech", "install", "--locale", "en-US", "--json"], {
        configPath: () => "/tmp/config.json",
        readConfig: () => Promise.resolve(existing),
        writeConfig: write,
        installSpeechLocale: () => ({ locale: "en-US", installed: true }),
      }),
    ).resolves.toBe(0);

    expect(write).toHaveBeenCalledWith(
      "/tmp/config.json",
      expect.objectContaining({
        version: 2,
        speech: { installedLocales: ["en-US"] },
        privateWindows: "hidden",
        backgroundLaunch: { policy: "disabled" },
      }),
    );
    expect(stdout).toHaveBeenCalled();
  });

  it("transcribes prerecorded audio without daemon access", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const transcribe = vi.fn(() => ({
      locale: "en-US",
      text: "Entirely local",
    }));

    await expect(
      runCli(
        [
          "speech",
          "transcribe",
          "--locale",
          "en-US",
          "--input",
          "/tmp/audio.wav",
          "--json",
        ],
        { transcribeAudio: transcribe },
      ),
    ).resolves.toBe(0);
    expect(transcribe).toHaveBeenCalledWith("en-US", "/tmp/audio.wav");
    expect(String(stdout.mock.calls[0]?.[0])).toContain("Entirely local");
  });

  it("rewrites legacy configuration only through explicit migration", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const write = vi.fn(() => Promise.resolve());
    const existing = {
      version: 1,
      profile: "profile",
      spaces: { personal: "space", aliases: {} },
      routing: { rules: [] },
    } satisfies ZenAgentConfig;

    await expect(
      runCli(["config", "migrate"], {
        configPath: () => "/tmp/config.json",
        readConfig: () => Promise.resolve(existing),
        writeConfig: write,
      }),
    ).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(
      "/tmp/config.json",
      expect.objectContaining({
        version: 2,
        profileMatch: "exact",
        downloads: { directory: "~/Downloads" },
      }),
    );
  });

  it("reloads the daemon after writing the default configuration", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const write = vi.fn(() => Promise.resolve());
    const harness = cliHarness(
      ({ method }) => {
        if (method === "status") {
          return { profileId: fixture.profile.id.transportId };
        }

        if (method === "config.reload") {
          return { loaded: true, profileId: fixture.profile.id.transportId };
        }

        return { sequence: 1, entities: [fixture.space] };
      },
      { writeConfig: write },
    );

    await expect(
      runCli(
        [
          "config",
          "map",
          "--personal",
          formatEntityReference(fixture.space.id),
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(CLI_EXIT_CODES.success);
    expect(harness.calls.map(({ method }) => method).toSorted()).toEqual([
      "config.reload",
      "registry.entities",
      "status",
    ]);
    expect(write).toHaveBeenCalledOnce();
  });

  it("refuses a stale session-scoped Space during configuration mapping", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const current = browserFixture("current");
    const stale = browserFixture("stale", 1, current.profile.id.transportId);
    const write = vi.fn(() => Promise.resolve());
    const harness = cliHarness(
      ({ method }) =>
        method === "status"
          ? { profileId: current.profile.id.transportId }
          : { sequence: 1, entities: [current.space] },
      { writeConfig: write },
    );

    await expect(
      runCli(
        ["config", "map", "--personal", formatEntityReference(stale.space.id)],
        harness.dependencies,
      ),
    ).resolves.toBe(CLI_EXIT_CODES.invalidInput);
    expect(write).not.toHaveBeenCalled();
  });

  it("describes itself as setup and maintenance only", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["--help"])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Setup and maintenance for Zen Agent."),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.not.stringContaining("tabs open"),
    );
  });
});
