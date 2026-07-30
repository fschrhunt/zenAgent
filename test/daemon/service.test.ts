import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_MODEL_VERSION,
  known,
  sessionEntityId,
  type BrowserTab,
} from "../../src/browser/model.js";
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

    const first = service.handle({
      ...request(
        "tabs.navigate",
        { tabId: fixture.tab.id, url: "https://first.example/" },
        "first",
      ),
      id: "tabs.navigate-first",
    });
    const second = service.handle({
      ...request(
        "tabs.navigate",
        { tabId: fixture.tab.id, url: "https://second.example/" },
        "second",
      ),
      id: "tabs.navigate-second",
    });
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

  it("rejects a queued tab mutation when its registry precondition is stale", async () => {
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
        {
          tabId: fixture.tab.id,
          url: "https://first.example/",
          expectedRegistrySequence: 1,
        },
        "first-versioned",
      ),
    );
    const stale = service
      .handle({
        ...request(
          "tabs.navigate",
          {
            tabId: fixture.tab.id,
            url: "https://stale.example/",
            expectedRegistrySequence: 1,
          },
          "stale-versioned",
        ),
        id: "stale-versioned-operation",
      })
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    await vi.waitFor(() => {
      expect(
        transport.calls.filter((call) => call.startsWith("navigate:")),
      ).toHaveLength(1);
    });
    transport.mutationGate.release();

    await expect(first).resolves.toMatchObject({
      outcome: "navigated",
      registrySequence: 2,
    });

    await expect(stale).resolves.toMatchObject({
      status: "rejected",
      reason: {
        code: "stale-id",
        data: {
          reason: "registry-version-conflict",
          resource: "registry",
          retryable: true,
          recovery: "refresh-and-replan",
          performed: false,
          expectedRegistrySequence: 1,
          actualRegistrySequence: 2,
        },
      },
    });
    expect(
      transport.calls.filter((call) => call.startsWith("navigate:")),
    ).toHaveLength(1);
    await service.stop();
  });

  it("runs bounded load from multiple clients concurrently across tabs and FIFO within each tab", async () => {
    const fixture = browserFixture();
    const secondTab = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "second-tab"),
      browsingContextId: known(null),
      selected: known(false),
    } satisfies BrowserTab;
    const transport = fakeDaemonTransport({
      ...fixture.snapshot,
      tabs: [fixture.tab, secondTab],
    });
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    transport.mutationGate.wait = true;

    const operations = Array.from({ length: 12 }, (_, index) => {
      const tab = index % 2 === 0 ? fixture.tab : secondTab;
      const clientId = `client-${String(index % 4)}`;
      return service.handle({
        ...request(
          "tabs.navigate",
          {
            tabId: tab.id,
            url: `https://load-${String(index)}.example/`,
          },
          `load-key-${String(index)}`,
          clientId,
        ),
        id: `load-operation-${String(index)}`,
      });
    });

    await vi.waitFor(() => {
      expect(
        transport.calls.filter((call) => call.startsWith("navigate:")),
      ).toHaveLength(2);
    });
    expect(
      transport.calls.filter((call) => call.startsWith("navigate:")),
    ).toEqual([
      expect.stringContaining("load-0.example"),
      expect.stringContaining("load-1.example"),
    ]);

    transport.mutationGate.release();
    await expect(Promise.all(operations)).resolves.toHaveLength(12);
    const calls = transport.calls.filter((call) =>
      call.startsWith("navigate:"),
    );
    expect(
      calls.filter((call) => call.includes(fixture.tab.id.transportId)),
    ).toEqual(
      [0, 2, 4, 6, 8, 10].map(
        (index) =>
          `navigate:${fixture.tab.id.transportId}:https://load-${String(index)}.example/`,
      ),
    );
    expect(
      calls.filter((call) => call.includes(secondTab.id.transportId)),
    ).toEqual(
      [1, 3, 5, 7, 9, 11].map(
        (index) =>
          `navigate:${secondTab.id.transportId}:https://load-${String(index)}.example/`,
      ),
    );
    await service.stop();
  });

  it("owns bounded tab leases and blocks other clients' tab mutations", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    const acquired = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id, ttlMs: 45_000 },
        "acquire",
        "owner",
      ),
    )) as {
      lease: {
        leaseId: string;
        tabId: unknown;
        acquiredAt: number;
        expiresAt: number;
      };
    };
    expect(typeof acquired.lease.leaseId).toBe("string");
    expect(acquired.lease.tabId).toEqual(fixture.tab.id);
    expect(acquired.lease.expiresAt - acquired.lease.acquiredAt).toBe(45_000);

    const blocked = [
      {
        method: "tabs.navigate" as const,
        params: { tabId: fixture.tab.id, url: "https://blocked.example/" },
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

    for (const [index, mutation] of blocked.entries()) {
      await expect(
        service.handle(
          request(
            mutation.method,
            JSON.parse(JSON.stringify(mutation.params)) as unknown,
            `blocked-${String(index)}`,
            "other",
          ),
        ),
      ).rejects.toMatchObject({
        code: "lease-conflict",
        data: { reason: "tab-leased" },
      });
    }

    await expect(
      service.handle(
        request(
          "tabs.resolve",
          {
            url: "https://changed.example/",
            spaceId: fixture.space.id,
            navigateReusedTab: true,
            rules: ["domain"],
            domain: "example.com",
          },
          "blocked-resolve",
          "other",
        ),
      ),
    ).rejects.toMatchObject({ code: "lease-conflict" });

    await expect(
      service.handle(
        request(
          "tabs.navigate",
          { tabId: fixture.tab.id, url: "https://owner.example/" },
          "owner-navigate",
          "owner",
        ),
      ),
    ).resolves.toMatchObject({ outcome: "navigated" });
    expect(transport.calls).toContain(
      `navigate:${fixture.tab.id.transportId}:https://owner.example/`,
    );
    await service.stop();
  });

  it("renews, releases, expires, and bounds leases explicitly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
      const fixture = browserFixture();
      const transport = fakeDaemonTransport(fixture.snapshot);
      const service = new DaemonService({
        transportFactory: () => transport,
        reconcileIntervalMs: 0,
      });
      await service.start();
      const acquired = (await service.handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id },
          "acquire",
          "owner",
        ),
      )) as { lease: { leaseId: string; expiresAt: number } };
      expect(acquired.lease.expiresAt).toBe(Date.now() + 30_000);

      await expect(
        service.handle(
          request(
            "tabs.lease.renew",
            { leaseId: acquired.lease.leaseId, ttlMs: 999 },
            "too-short",
            "owner",
          ),
        ),
      ).rejects.toThrow(/1000 through 300000/);
      await expect(
        service.handle(
          request(
            "tabs.lease.renew",
            { leaseId: acquired.lease.leaseId, ttlMs: 300_001 },
            "too-long",
            "owner",
          ),
        ),
      ).rejects.toThrow(/1 through 300000/);
      await expect(
        service.handle(
          request(
            "tabs.lease.renew",
            { leaseId: acquired.lease.leaseId },
            "wrong-renew",
            "other",
          ),
        ),
      ).rejects.toMatchObject({ code: "lease-conflict" });
      await expect(
        service.handle(
          request(
            "tabs.lease.release",
            { leaseId: acquired.lease.leaseId },
            "wrong-release",
            "other",
          ),
        ),
      ).rejects.toMatchObject({ code: "lease-conflict" });

      vi.setSystemTime(new Date("2026-07-29T12:00:20.000Z"));
      const renewed = (await service.handle(
        request(
          "tabs.lease.renew",
          { leaseId: acquired.lease.leaseId, ttlMs: 60_000 },
          "renew",
          "owner",
        ),
      )) as { lease: { expiresAt: number } };
      expect(renewed.lease.expiresAt).toBe(Date.now() + 60_000);

      await expect(
        service.handle(
          request(
            "tabs.lease.release",
            { leaseId: acquired.lease.leaseId },
            "release",
            "owner",
          ),
        ),
      ).resolves.toMatchObject({
        released: true,
        leaseId: acquired.lease.leaseId,
        tabId: fixture.tab.id,
      });

      const expiring = (await service.handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id, ttlMs: 1_000 },
          "expiring",
          "owner",
        ),
      )) as { lease: { leaseId: string } };
      vi.setSystemTime(new Date("2026-07-29T12:00:21.000Z"));
      await expect(
        service.handle(
          request(
            "tabs.lease.renew",
            { leaseId: expiring.lease.leaseId },
            "expired-renew",
            "owner",
          ),
        ),
      ).rejects.toMatchObject({
        code: "stale-id",
        data: { reason: "lease-expired" },
      });
      await expect(
        service.handle(
          request(
            "tabs.navigate",
            { tabId: fixture.tab.id, url: "https://after-expiry.example/" },
            "after-expiry",
            "other",
          ),
        ),
      ).resolves.toMatchObject({ outcome: "navigated" });
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reacquires the same client lease without extending it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
      const fixture = browserFixture();
      const service = new DaemonService({
        transportFactory: () => fakeDaemonTransport(fixture.snapshot),
        reconcileIntervalMs: 0,
      });
      await service.start();
      const first = (await service.handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id, ttlMs: 30_000 },
          "first-acquire",
          "owner",
        ),
      )) as { lease: { leaseId: string; expiresAt: number } };

      vi.setSystemTime(new Date("2026-07-29T12:00:10.000Z"));
      const reacquired = (await service.handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id, ttlMs: 300_000 },
          "reacquire",
          "owner",
        ),
      )) as { lease: { leaseId: string; expiresAt: number } };
      expect(reacquired.lease).toEqual(first.lease);
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for tab leases in FIFO order without blocking release", async () => {
    const fixture = browserFixture();
    const service = new DaemonService({
      transportFactory: () => fakeDaemonTransport(fixture.snapshot),
      reconcileIntervalMs: 0,
    });
    await service.start();
    const owner = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "owner-acquire",
        "owner",
      ),
    )) as { lease: { leaseId: string } };
    const order: string[] = [];
    const first = service
      .handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id, waitMs: 60_000 },
          "first-wait",
          "first",
        ),
      )
      .then((result) => {
        order.push("first");
        return result as { lease: { leaseId: string } };
      });
    const second = service
      .handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id, waitMs: 60_000 },
          "second-wait",
          "second",
        ),
      )
      .then((result) => {
        order.push("second");
        return result as { lease: { leaseId: string } };
      });

    await service.handle(
      request(
        "tabs.lease.release",
        { leaseId: owner.lease.leaseId },
        "owner-release",
        "owner",
      ),
    );
    const firstLease = await first;
    expect(order).toEqual(["first"]);
    await service.handle(
      request(
        "tabs.lease.release",
        { leaseId: firstLease.lease.leaseId },
        "first-release",
        "first",
      ),
    );
    await expect(second).resolves.toMatchObject({
      lease: { tabId: fixture.tab.id },
    });
    expect(order).toEqual(["first", "second"]);
    await service.stop();
  });

  it("cancels a bounded tab lease wait by operation ID", async () => {
    const fixture = browserFixture();
    const service = new DaemonService({
      transportFactory: () => fakeDaemonTransport(fixture.snapshot),
      reconcileIntervalMs: 0,
    });
    await service.start();
    await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "owner-acquire",
        "owner",
      ),
    );
    const waiting = service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id, waitMs: 60_000 },
        "waiting-acquire",
        "waiter",
      ),
    );
    await Promise.resolve();
    await expect(
      service.handle(
        request(
          "operations.cancel",
          { operationId: "tabs.lease.acquire-request" },
          undefined,
          "waiter",
        ),
      ),
    ).resolves.toEqual({
      cancelled: true,
      operationId: "tabs.lease.acquire-request",
    });
    await expect(waiting).rejects.toMatchObject({
      code: "cancelled",
      data: {
        reason: "lease-wait-cancelled",
        resource: "lease",
      },
    });
    await service.stop();
  });

  it("treats selecting a leased tab as user takeover", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const acquired = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "acquire",
        "owner",
      ),
    )) as { lease: { leaseId: string } };

    transport.replaceSnapshot({
      ...fixture.snapshot,
      tabs: [{ ...fixture.tab, selected: known(true) }],
    });
    await service.refresh();
    await expect(
      service.handle(
        request(
          "tabs.lease.renew",
          { leaseId: acquired.lease.leaseId },
          "renew-after-takeover",
          "owner",
        ),
      ),
    ).rejects.toMatchObject({
      code: "stale-id",
      data: {
        reason: "lease-expired",
        resource: "lease",
      },
    });
    await expect(
      service.handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id },
          "acquire-selected",
          "other",
        ),
      ),
    ).rejects.toMatchObject({
      code: "policy-rejection",
      data: {
        reason: "selected-tab",
        resource: "tab",
        userActionRequired: true,
        leaseDisposition: "revoked",
      },
    });
    await service.stop();
  });

  it("returns structured recovery metadata for playing media", async () => {
    const fixture = browserFixture();
    const service = new DaemonService({
      transportFactory: () =>
        fakeDaemonTransport({
          ...fixture.snapshot,
          tabs: [{ ...fixture.tab, mediaState: known("playing") }],
        }),
      reconcileIntervalMs: 0,
    });
    await service.start();

    await expect(
      service.handle(
        request(
          "tabs.lease.acquire",
          { tabId: fixture.tab.id },
          "acquire-playing",
          "owner",
        ),
      ),
    ).rejects.toMatchObject({
      code: "policy-rejection",
      data: {
        reason: "playing-media",
        resource: "tab",
        retryable: false,
        userActionRequired: true,
      },
    });
    await service.stop();
  });

  it("releases leases and client-scoped retries when a client disconnects", async () => {
    const fixture = browserFixture();
    const service = new DaemonService({
      transportFactory: () => fakeDaemonTransport(fixture.snapshot),
      reconcileIntervalMs: 0,
    });
    await service.start();
    const first = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "same-key",
        "owner",
      ),
    )) as { lease: { leaseId: string } };

    await service.disconnectClient("owner");
    const second = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "same-key",
        "owner",
      ),
    )) as { lease: { leaseId: string } };
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);
    await service.stop();
  });

  it("invalidates a lease when its tab crashes", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const acquired = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "acquire",
        "owner",
      ),
    )) as { lease: { leaseId: string } };

    transport.replaceSnapshot({
      ...fixture.snapshot,
      tabs: [{ ...fixture.tab, lifecycleState: "crashed" }],
    });
    await service.refresh();
    await expect(
      service.handle(
        request(
          "tabs.lease.renew",
          { leaseId: acquired.lease.leaseId },
          "renew-crashed",
          "owner",
        ),
      ),
    ).rejects.toMatchObject({ code: "stale-id" });
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

  it("passes Zen's bare Space UUID rather than the model's window-scoped ID", async () => {
    const fixture = browserFixture();
    const bareUuid = "{00000000-0000-0000-0000-000000000123}";
    const space = {
      ...fixture.space,
      id: {
        ...fixture.space.id,
        transportId: `${fixture.window.id.transportId}/${bareUuid}`,
      },
    };
    const transport = fakeDaemonTransport({
      ...fixture.snapshot,
      spaces: [space],
      tabs: [{ ...fixture.tab, spaceId: known(space.id) }],
    });
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    await service.handle(
      request(
        "tabs.open",
        JSON.parse(
          JSON.stringify({
            url: "https://new.example/",
            windowId: fixture.window.id,
            spaceId: space.id,
          }),
        ) as unknown,
        "composed-space-open",
      ),
    );

    expect(transport.calls.filter((call) => call.startsWith("open:"))).toEqual([
      `open:${fixture.window.id.transportId}:${bareUuid}`,
    ]);
    await service.stop();
  });

  it("closes only an explicit same-client unchanged temporary tab", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const opened = (await service.handle(
      request(
        "tabs.open",
        JSON.parse(
          JSON.stringify({
            url: "https://temporary.example/",
            windowId: fixture.window.id,
            spaceId: fixture.space.id,
            temporary: true,
          }),
        ) as unknown,
        "open-temporary",
        "creator",
      ),
    )) as { tabId: unknown };

    await service.disconnectClient("creator");
    expect(transport.calls.filter((call) => call.startsWith("close:"))).toEqual(
      [],
    );
    await expect(
      service.handle(
        request(
          "tabs.cleanup",
          { tabId: opened.tabId, action: "close" },
          "cleanup-temporary",
          "creator",
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "closed",
      tabId: opened.tabId,
    });
    expect(transport.calls.filter((call) => call.startsWith("close:"))).toEqual(
      ["close:opened-tab"],
    );
    await service.stop();
  });

  it("keeps changed temporary tabs and refuses untracked cleanup", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const opened = (await service.handle(
      request(
        "tabs.open",
        JSON.parse(
          JSON.stringify({
            url: "https://temporary.example/",
            windowId: fixture.window.id,
            spaceId: fixture.space.id,
            temporary: true,
          }),
        ) as unknown,
        "open-temporary",
        "creator",
      ),
    )) as { tabId: unknown };
    await service.handle(
      request(
        "tabs.navigate",
        { tabId: opened.tabId, url: "https://changed.example/" },
        "change-temporary",
        "creator",
      ),
    );
    await expect(
      service.handle(
        request(
          "tabs.cleanup",
          { tabId: opened.tabId, action: "close" },
          "cleanup-changed",
          "creator",
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "kept",
      reason: "changed",
    });
    expect(transport.calls.filter((call) => call.startsWith("close:"))).toEqual(
      [],
    );
    await expect(
      service.handle(
        request(
          "tabs.cleanup",
          { tabId: opened.tabId },
          "keep-changed",
          "creator",
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "kept",
      reason: "explicit-keep",
    });

    await expect(
      service.handle(
        request(
          "tabs.cleanup",
          { tabId: fixture.tab.id, action: "close" },
          "cleanup-untracked",
          "creator",
        ),
      ),
    ).rejects.toMatchObject({
      code: "policy-rejection",
      data: { reason: "cleanup-not-temporary" },
    });
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

  it("scopes semantic page references to one daemon client", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    const snapshot = (await service.handle(
      request(
        "pages.snapshot",
        { tabId: fixture.tab.id, maxNodes: 50 },
        undefined,
        "owner",
      ),
    )) as {
      snapshotId: string;
      documentId: string;
      rootFrameRef: string;
      tabId: unknown;
    };
    expect(snapshot.tabId).toEqual(fixture.tab.id);

    const target = {
      tabId: fixture.tab.id,
      documentId: snapshot.documentId,
      snapshotId: snapshot.snapshotId,
      frameRef: snapshot.rootFrameRef,
    };
    await expect(
      service.handle(
        request(
          "pages.query",
          { target, locator: { kind: "role", role: "button" } },
          undefined,
          "owner",
        ),
      ),
    ).resolves.toEqual({ nodes: [], truncated: false });
    await expect(
      service.handle(
        request(
          "pages.query",
          { target, locator: { kind: "text", text: "copied" } },
          undefined,
          "other",
        ),
      ),
    ).rejects.toMatchObject({
      code: "policy-rejection",
      data: { reason: "snapshot-owner" },
    });
    await service.stop();
  });

  it("requires the caller's exact live tab lease for page mutations", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    const snapshot = (await service.handle(
      request("pages.snapshot", { tabId: fixture.tab.id }, undefined, "owner"),
    )) as {
      snapshotId: string;
      documentId: string;
      rootFrameRef: string;
    };
    const elementTarget = {
      tabId: fixture.tab.id,
      documentId: snapshot.documentId,
      snapshotId: snapshot.snapshotId,
      frameRef: snapshot.rootFrameRef,
      elementRef: "element-1",
    };

    await expect(
      service.handle(
        request(
          "pages.click",
          { target: elementTarget, leaseId: "missing" },
          "missing-lease",
          "owner",
        ),
      ),
    ).rejects.toMatchObject({ code: "stale-id" });

    const acquired = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "acquire-page",
        "owner",
      ),
    )) as { lease: { leaseId: string } };
    await expect(
      service.handle(
        request(
          "pages.click",
          { target: elementTarget, leaseId: acquired.lease.leaseId },
          "click-page",
          "owner",
        ),
      ),
    ).resolves.toEqual({
      performed: true,
      documentId: snapshot.documentId,
    });
    expect(transport.calls).toContain(
      `page-click:${fixture.tab.id.transportId}:element-1`,
    );

    await expect(
      service.handle(
        request(
          "pages.click",
          { target: elementTarget, leaseId: acquired.lease.leaseId },
          "copied-lease",
          "other",
        ),
      ),
    ).rejects.toMatchObject({ code: "lease-conflict" });

    await service.handle(
      request(
        "tabs.navigate",
        { tabId: fixture.tab.id, url: "https://next.example/" },
        "navigate-page",
        "owner",
      ),
    );
    await expect(
      service.handle(
        request(
          "pages.query",
          {
            target: {
              ...elementTarget,
              elementRef: undefined,
            },
            locator: { kind: "element", elementRef: "element-1" },
          },
          undefined,
          "owner",
        ),
      ),
    ).rejects.toMatchObject({ code: "stale-element" });
    await service.stop();
  });

  it("refuses a page mutation planned from a superseded client snapshot", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const snapshotPage = transport.snapshotPage.bind(transport);
    let snapshotNumber = 0;
    vi.spyOn(transport, "snapshotPage").mockImplementation(
      async (tabId, options) => ({
        ...(await snapshotPage(tabId, options)),
        snapshotId: `snapshot-${String(++snapshotNumber)}`,
      }),
    );
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const older = (await service.handle(
      request("pages.snapshot", { tabId: fixture.tab.id }, undefined, "owner"),
    )) as {
      snapshotId: string;
      documentId: string;
      rootFrameRef: string;
    };
    const latest = (await service.handle(
      request("pages.snapshot", { tabId: fixture.tab.id }, undefined, "owner"),
    )) as {
      snapshotId: string;
      documentId: string;
      rootFrameRef: string;
    };
    const acquired = (await service.handle(
      request(
        "tabs.lease.acquire",
        { tabId: fixture.tab.id },
        "snapshot-lease",
        "owner",
      ),
    )) as { lease: { leaseId: string } };

    await expect(
      service.handle(
        request(
          "pages.click",
          {
            target: {
              tabId: fixture.tab.id,
              documentId: older.documentId,
              snapshotId: older.snapshotId,
              frameRef: older.rootFrameRef,
              elementRef: "element-older",
            },
            leaseId: acquired.lease.leaseId,
          },
          "stale-snapshot-mutation",
          "owner",
        ),
      ),
    ).rejects.toMatchObject({
      code: "stale-element",
      data: {
        reason: "snapshot-superseded",
        resource: "snapshot",
        retryable: true,
        performed: false,
      },
    });
    expect(
      transport.calls.filter((call) => call.startsWith("page-click:")),
    ).toHaveLength(0);

    await expect(
      service.handle(
        request(
          "pages.click",
          {
            target: {
              tabId: fixture.tab.id,
              documentId: latest.documentId,
              snapshotId: latest.snapshotId,
              frameRef: latest.rootFrameRef,
              elementRef: "element-latest",
            },
            leaseId: acquired.lease.leaseId,
          },
          "latest-snapshot-mutation",
          "owner",
        ),
      ),
    ).resolves.toMatchObject({ performed: true });
    await service.stop();
  });

  it("waits with daemon timers and returns a client-owned semantic snapshot", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    const waited = (await service.handle(
      request(
        "pages.wait",
        {
          tabId: fixture.tab.id,
          condition: {
            kind: "url-exact",
            url: "https://example.com/",
          },
          timeoutMs: 1_000,
          pollIntervalMs: 100,
        },
        undefined,
        "waiter",
      ),
    )) as {
      matched: boolean;
      snapshot: {
        tabId: unknown;
        snapshotId: string;
        documentId: string;
        rootFrameRef: string;
      };
    };
    expect(waited.matched).toBe(true);
    expect(waited.snapshot.tabId).toEqual(fixture.tab.id);
    await expect(
      service.handle(
        request(
          "pages.query",
          {
            target: {
              tabId: fixture.tab.id,
              documentId: waited.snapshot.documentId,
              snapshotId: waited.snapshot.snapshotId,
              frameRef: waited.snapshot.rootFrameRef,
            },
            locator: { kind: "text", text: "anything" },
          },
          undefined,
          "waiter",
        ),
      ),
    ).resolves.toEqual({ nodes: [], truncated: false });
    await service.stop();
  });

  it("cancels an in-flight page wait by operation ID", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();

    const waiting = service.handle(
      request(
        "pages.wait",
        {
          tabId: fixture.tab.id,
          condition: { kind: "text-present", text: "never appears" },
          timeoutMs: 60_000,
          pollIntervalMs: 100,
        },
        undefined,
        "waiter",
      ),
    );
    await Promise.resolve();
    await expect(
      service.handle(
        request(
          "operations.cancel",
          { operationId: "pages.wait-request" },
          undefined,
          "waiter",
        ),
      ),
    ).resolves.toEqual({
      cancelled: true,
      operationId: "pages.wait-request",
    });
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
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
