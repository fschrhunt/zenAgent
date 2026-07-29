import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZenAgentConfig } from "../src/config/schema.js";
import {
  CLI_EXIT_CODES,
  runCli,
  type CliDependencies,
} from "../src/cli/run.js";
import { formatEntityReference } from "../src/cli/entity-reference.js";
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

  it("filters listed tabs by an exact opaque Space ID", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const other = browserFixture("other");
    const harness = cliHarness(({ method }) =>
      method === "registry.lookup"
        ? { sequence: 1, lookup: { status: "active", entity: fixture.space } }
        : {
            sequence: 1,
            entities: [fixture.tab, other.tab],
          },
    );

    await expect(
      runCli(
        ["tabs", "list", "--space", formatEntityReference(fixture.space.id)],
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Example"));
    expect(stdout).toHaveBeenCalledWith(
      expect.not.stringContaining(formatEntityReference(other.tab.id)),
    );
  });

  it("rejects a stale Space filter instead of returning an empty list", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const harness = cliHarness(() => ({
      sequence: 1,
      lookup: { status: "missing" },
    }));

    await expect(
      runCli(
        ["tabs", "list", "--space", formatEntityReference(fixture.space.id)],
        harness.dependencies,
      ),
    ).resolves.toBe(CLI_EXIT_CODES.staleId);
    expect(harness.calls.map(({ method }) => method)).toEqual([
      "registry.lookup",
    ]);
  });

  it("refuses a bare transport ID before an existing-tab mutation", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({}));

    await expect(
      runCli(["tabs", "close", "primary-tab"], harness.dependencies),
    ).resolves.toBe(CLI_EXIT_CODES.invalidInput);
    expect(harness.calls).toHaveLength(0);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Expected an opaque ID"),
    );
  });

  it("navigates only the explicit stable tab through the daemon", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const harness = cliHarness(() => ({
      outcome: "navigated",
      tabId: fixture.tab.id,
    }));

    await expect(
      runCli(
        [
          "tabs",
          "navigate",
          formatEntityReference(fixture.tab.id),
          "https://example.org/",
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({
      method: "tabs.navigate",
      params: { tabId: fixture.tab.id, url: "https://example.org/" },
    });
    expect(harness.calls[0]?.idempotencyKey).toMatch(/^cli:navigate:/u);
  });

  it("resolves an HTTP URL in an explicit Space through daemon policy", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const harness = cliHarness(() => ({
      status: "reused",
      tabId: fixture.tab.id,
      explanation: { outcome: "reused" },
    }));

    await expect(
      runCli(
        [
          "tabs",
          "resolve",
          "https://example.com",
          "--space",
          formatEntityReference(fixture.space.id),
          "--explain",
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.calls[0]).toMatchObject({
      method: "tabs.resolve",
      params: {
        url: "https://example.com/",
        spaceId: fixture.space.id,
      },
    });
    expect(harness.calls[0]?.idempotencyKey).toMatch(/^cli:resolve:/u);
  });

  it("passes a non-URL resolve input as a reuse-only query", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({ status: "not-found", candidates: [] }));

    await expect(
      runCli(
        ["tabs", "resolve", "quarterly report", "--space", "work"],
        harness.dependencies,
      ),
    ).resolves.toBe(CLI_EXIT_CODES.policyRejection);
    expect(harness.calls[0]).toMatchObject({
      method: "tabs.resolve",
      params: { query: "quarterly report", space: "work" },
    });
  });

  it("returns the ambiguity exit code without hiding candidates", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const harness = cliHarness(() => ({
      status: "ambiguous",
      candidates: [{ reason: "candidate" }],
    }));

    await expect(
      runCli(
        ["tabs", "resolve", "https://example.com/", "--json"],
        harness.dependencies,
      ),
    ).resolves.toBe(CLI_EXIT_CODES.ambiguity);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"status": "ambiguous"'),
    );
  });

  it.each([
    ["stale-id", CLI_EXIT_CODES.staleId],
    ["browser-unavailable", CLI_EXIT_CODES.browserUnavailable],
    ["unsupported-capability", CLI_EXIT_CODES.unsupportedCapability],
    ["timeout", CLI_EXIT_CODES.timeout],
    ["policy-rejection", CLI_EXIT_CODES.policyRejection],
  ] as const)("maps %s to its stable exit code", async (code, expected) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fixture = browserFixture();
    const harness = cliHarness(() => {
      throw new DaemonProtocolError(code, "sanitized failure");
    });

    await expect(
      runCli(
        ["tabs", "reload", formatEntityReference(fixture.tab.id)],
        harness.dependencies,
      ),
    ).resolves.toBe(expected);
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

  it("documents side effects and intentionally omits foreground behavior", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["tabs", "--help"])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Side effects:"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("There is intentionally no foreground option."),
    );
  });
});
