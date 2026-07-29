import { describe, expect, it, vi } from "vitest";

import { BROWSER_MODEL_VERSION, known } from "../../src/browser/model.js";
import type { ZenAgentConfig } from "../../src/config/schema.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonMethod,
  type DaemonRequest,
} from "../../src/daemon/protocol.js";
import {
  createDaemonLogger,
  type DaemonLogEntry,
} from "../../src/daemon/logger.js";
import { DaemonService } from "../../src/daemon/service.js";
import { browserFixture } from "../browser/fixtures.js";
import { fakeDaemonTransport, transportSequence } from "./fixtures.js";

function request(
  method: DaemonMethod,
  params?: unknown,
  idempotencyKey?: string,
  clientId = "test-client",
): DaemonRequest {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "request",
    id: `${method}-request`,
    clientId,
    method,
    ...(params === undefined ? {} : { params }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

describe("DaemonService", () => {
  it("rejects cyclic in-process params before logging or fingerprinting", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const service = new DaemonService({
      transportFactory: () => fakeDaemonTransport(),
      reconcileIntervalMs: 0,
    });

    await expect(
      service.handle(request("health", cyclic)),
    ).rejects.toMatchObject({
      code: "payload-too-large",
      data: { limit: "json-cycle" },
    });
  });

  it("owns one transport and exposes sanitized status and registry reads", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    expect(service.status()).toMatchObject({
      state: "connected",
      profileId: fixture.profile.id.transportId,
      sessionId: fixture.session.id.transportId,
      registrySequence: 1,
      counts: { tabs: 1, spaces: 1, windows: 1 },
    });
    expect(transport.calls).toEqual(["connect"]);

    const listed = await service.handle(
      request("registry.entities", { kind: "tab" }),
    );
    expect(listed).toMatchObject({ sequence: 1 });
    expect((listed as { entities: readonly unknown[] }).entities).toHaveLength(
      1,
    );
    await service.stop();
  });

  it("allows reads while serializing conflicting mutations", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    transport.mutationGate.wait = true;

    const first = service.handle(
      request(
        "tabs.navigate",
        { tabId: fixture.tab.id, url: "https://first.example/" },
        "first",
      ),
    );
    const second = service.handle(
      request(
        "tabs.navigate",
        { tabId: fixture.tab.id, url: "https://second.example/" },
        "second",
      ),
    );
    await vi.waitFor(() => {
      expect(
        transport.calls.filter((call) => call.startsWith("navigate:")),
      ).toHaveLength(1);
    });

    await expect(service.handle(request("status"))).resolves.toMatchObject({
      state: "connected",
    });
    transport.mutationGate.release();
    await Promise.all([first, second]);

    expect(
      transport.calls.filter((call) => call.startsWith("navigate:")),
    ).toEqual([
      expect.stringContaining("https://first.example/"),
      expect.stringContaining("https://second.example/"),
    ]);
    await service.stop();
  });

  it("deduplicates concurrent retries and rejects key reuse with new params", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const operation = request(
      "tabs.navigate",
      { tabId: fixture.tab.id, url: "https://same.example/" },
      "retry-key",
    );

    const [first, retry] = await Promise.all([
      service.handle(operation),
      service.handle({ ...operation, id: "retry-request" }),
    ]);
    expect(first).toEqual(retry);
    expect(
      transport.calls.filter((call) => call.startsWith("navigate:")),
    ).toHaveLength(1);

    await expect(
      service.handle({
        ...operation,
        id: "bad-retry",
        params: {
          tabId: fixture.tab.id,
          url: "https://different.example/",
        },
      }),
    ).rejects.toThrow(/different parameters/);
    await service.stop();
  });

  it("resolves by fresh discovery and opens only when no safe match exists", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    await expect(
      service.handle(
        request(
          "tabs.resolve",
          {
            url: "https://example.com/",
            spaceId: fixture.space.id,
          },
          "resolve-existing",
        ),
      ),
    ).resolves.toMatchObject({
      status: "reused",
      tabId: fixture.tab.id,
      explanation: {
        reason: "best-safe-match",
        crossSpaceReuse: "forbidden",
      },
    });
    expect(
      transport.calls.filter((call) => call.startsWith("open:")),
    ).toHaveLength(0);

    await expect(
      service.handle(
        request(
          "tabs.resolve",
          { query: "Example", spaceId: fixture.space.id },
          "resolve-query",
        ),
      ),
    ).resolves.toMatchObject({
      status: "reused",
      tabId: fixture.tab.id,
      explanation: { match: { rule: "query" } },
    });

    await expect(
      service.handle(
        request(
          "tabs.resolve",
          {
            url: "https://new.example/",
            spaceId: fixture.space.id,
          },
          "resolve-new",
        ),
      ),
    ).resolves.toMatchObject({
      status: "opened",
      tabId: { kind: "tab", transportId: "opened-tab" },
      explanation: { reason: "no-safe-match", background: true },
    });
    expect(
      transport.calls.filter((call) => call.startsWith("open:")),
    ).toHaveLength(1);
    await service.stop();
  });

  it("prevents duplicate opens across simultaneous clients", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport({
      ...fixture.snapshot,
      tabs: [],
      browsingContexts: [],
      frames: [],
      elements: [],
    });
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    const params = {
      url: "https://new.example/",
      spaceId: fixture.space.id,
    };
    const [first, second] = await Promise.all([
      service.handle(request("tabs.resolve", params, "resolve-a", "agent-a")),
      service.handle(request("tabs.resolve", params, "resolve-b", "agent-b")),
    ]);

    expect(first).toMatchObject({ status: "opened" });
    expect(second).toMatchObject({ status: "reused" });
    expect(
      transport.calls.filter((call) => call.startsWith("open:")),
    ).toHaveLength(1);
    await service.stop();
  });

  it("keeps routing policy inside tabs.resolve and reloads by stable ID", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      config: {
        version: 1,
        profile: fixture.profile.id.transportId,
        spaces: {
          personal: fixture.space.id.transportId,
          aliases: {},
        },
        routing: { rules: [], safeDefault: "personal" },
      },
    });
    await service.start();

    await expect(
      service.handle(
        request(
          "tabs.resolve",
          { url: "https://example.com/", taskContext: "personal" },
          "routed-resolve",
        ),
      ),
    ).resolves.toMatchObject({ status: "reused" });
    await expect(
      service.handle(
        request("tabs.reload", { tabId: fixture.tab.id }, "reload"),
      ),
    ).resolves.toMatchObject({
      outcome: "reloaded",
      tabId: fixture.tab.id,
    });
    expect(transport.calls).toContain(`reload:${fixture.tab.id.transportId}`);
    await service.stop();
  });

  it.each([
    {
      name: "selected",
      selected: known(true),
      mediaState: known("none" as const),
      reason: "selected-tab",
    },
    {
      name: "playing media",
      selected: known(false),
      mediaState: known("playing" as const),
      reason: "playing-media",
    },
  ])(
    "rejects every existing-tab mutation for a $name tab",
    async ({ selected, mediaState, reason }) => {
      const fixture = browserFixture();
      const transport = fakeDaemonTransport({
        ...fixture.snapshot,
        tabs: [{ ...fixture.tab, selected, mediaState }],
      });
      const service = new DaemonService({
        transportFactory: () => transport,
        reconcileIntervalMs: 0,
      });
      await service.start();
      const mutations = [
        {
          method: "tabs.navigate" as const,
          params: {
            tabId: fixture.tab.id,
            url: "https://target.example/",
          },
        },
        {
          method: "tabs.reload" as const,
          params: { tabId: fixture.tab.id },
        },
        {
          method: "tabs.close" as const,
          params: { tabId: fixture.tab.id },
        },
        {
          method: "tabs.move" as const,
          params: { tabId: fixture.tab.id, spaceId: fixture.space.id },
        },
      ];

      await expect(
        service.handle(
          request(
            "tabs.resolve",
            { query: "Example", spaceId: fixture.space.id },
            "protected-query",
          ),
        ),
      ).resolves.toMatchObject({ status: "not-found" });
      await expect(
        service.handle(
          request(
            "tabs.resolve",
            {
              url: "https://example.com/",
              spaceId: fixture.space.id,
              navigateReusedTab: true,
            },
            "protected-url",
          ),
        ),
      ).resolves.toMatchObject({ status: "opened" });

      for (const [index, mutation] of mutations.entries()) {
        await expect(
          service.handle(
            request(
              mutation.method,
              JSON.parse(JSON.stringify(mutation.params)) as unknown,
              `unsafe-mutation-${String(index)}`,
            ),
          ),
        ).rejects.toMatchObject({
          code: "policy-rejection",
          data: { reason },
        });
      }

      expect(
        transport.calls.filter((call) =>
          /^(navigate|reload|close|move):/u.test(call),
        ),
      ).toEqual([]);
      expect(
        transport.calls.filter((call) => call.startsWith("open:")),
      ).toHaveLength(1);
      await service.stop();
    },
  );

  it("requires a stable Space ID for direct tab creation", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    await expect(
      service.handle(
        request(
          "tabs.open",
          {
            url: "https://new.example/",
            windowId: fixture.window.id,
          },
          "missing-space",
        ),
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(transport.calls.filter((call) => call.startsWith("open:"))).toEqual(
      [],
    );
    await service.stop();
  });

  it("inspects a page as a read through an explicit stable tab ID", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    await expect(
      service.handle(
        request("pages.inspect", {
          tabId: fixture.tab.id,
          maxChars: 128,
        }),
      ),
    ).resolves.toMatchObject({
      url: "https://example.com/",
      visibleText: "Visible fixture text",
      truncated: false,
    });
    expect(transport.calls).toContain(
      `inspect:${fixture.tab.id.transportId}:128`,
    );

    await expect(
      service.handle(
        request("pages.inspect", {
          tabId: fixture.tab.id,
          maxChars: 10_001,
        }),
      ),
    ).rejects.toThrow(/1 through 10000/);
    await service.stop();
  });

  it("hot-reloads validated routing configuration after first-run mapping", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const configState: { current: ZenAgentConfig | undefined } = {
      current: undefined,
    };
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      configLoader: () => Promise.resolve(configState.current),
    });
    await service.start();

    await expect(
      service.handle(
        request(
          "tabs.resolve",
          { url: "https://example.com/", taskContext: "personal" },
          "before-config",
        ),
      ),
    ).rejects.toThrow(/routing configuration/);

    configState.current = {
      version: 1,
      profile: fixture.profile.id.transportId,
      spaces: {
        personal: fixture.space.id.transportId,
        aliases: {},
      },
      routing: { rules: [] },
    };
    await expect(
      service.handle(request("config.reload", {}, "reload-config")),
    ).resolves.toEqual({
      loaded: true,
      profileId: fixture.profile.id.transportId,
    });
    await expect(
      service.handle(
        request(
          "tabs.resolve",
          { url: "https://example.com/", taskContext: "personal" },
          "after-config",
        ),
      ),
    ).resolves.toMatchObject({ status: "reused" });
    await service.stop();
  });

  it("requires explicit stable IDs and marks old IDs stale after reconnect", async () => {
    const firstFixture = browserFixture("first", 1, "shared-profile");
    const secondFixture = browserFixture("second", 1, "shared-profile");
    const firstTransport = fakeDaemonTransport(firstFixture.snapshot);
    const secondTransport = fakeDaemonTransport(secondFixture.snapshot);
    const service = new DaemonService({
      transportFactory: transportSequence(firstTransport, secondTransport),
      reconcileIntervalMs: 0,
      reconnectDelayMs: 1,
    });
    await service.start();

    await expect(
      service.handle(
        request("tabs.close", { tabId: "first-tab" }, "not-a-stable-id"),
      ),
    ).rejects.toThrow(/stable browser entity identifier/);

    firstTransport.emit({ type: "closed" });
    await vi.waitFor(() => {
      expect(service.status()).toMatchObject({
        state: "connected",
        sessionId: secondFixture.session.id.transportId,
        registrySequence: 2,
      });
    });

    const lookup = await service.handle(
      request("registry.lookup", { id: firstFixture.tab.id }),
    );
    expect(lookup).toMatchObject({
      lookup: {
        status: "stale",
        stale: { reason: "session-replaced" },
      },
    });
    await expect(
      service.handle(
        request(
          "tabs.navigate",
          {
            tabId: firstFixture.tab.id,
            url: "https://example.invalid/",
          },
          "stale-op",
        ),
      ),
    ).rejects.toThrow(/identifier is stale/);
    await service.stop();
  });

  it("stays available for health while Zen is unavailable and retries", async () => {
    const transport = fakeDaemonTransport();
    let attempts = 0;
    const service = new DaemonService({
      transportFactory: () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Zen absent");
        }

        return transport;
      },
      reconcileIntervalMs: 0,
      reconnectDelayMs: 1,
    });
    await service.start();

    expect(await service.handle(request("health"))).toEqual({
      ok: true,
      state: "unavailable",
      browserConnected: false,
    });
    await vi.waitFor(() => {
      expect(service.state).toBe("connected");
    });
    await service.stop();
  });

  it("never includes request params or URLs in diagnostic logs", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const entries: DaemonLogEntry[] = [];
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      logger: createDaemonLogger({
        level: "debug",
        sink: (entry) => entries.push(entry),
        now: () => "2026-07-29T00:00:00.000Z",
      }),
    });
    await service.start();
    await service.handle(
      request(
        "tabs.navigate",
        {
          tabId: fixture.tab.id,
          url: "https://secret.example/?token=never-log-this",
        },
        "logging",
      ),
    );

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("never-log-this");
    expect(serialized).not.toContain(fixture.tab.title);
    await service.stop();
  });

  it("normalizes transport sequences onto one daemon sequence", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    transport.emit({
      type: "delta",
      delta: {
        schemaVersion: BROWSER_MODEL_VERSION,
        sequence: 999,
        observedAt: "2026-07-29T00:00:00.000Z",
        changes: [],
      },
    });
    await vi.waitFor(() => {
      expect(service.status().registrySequence).toBe(2);
    });
    await service.stop();
  });
});
