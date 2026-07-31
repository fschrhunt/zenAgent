import { describe, expect, it, vi } from "vitest";

import { sessionEntityId } from "../../src/browser/model.js";
import {
  MAX_TAB_LEASES_PER_CLIENT,
  TabLeaseManager,
} from "../../src/daemon/leases.js";
import { DaemonProtocolError } from "../../src/daemon/protocol.js";
import { browserFixture } from "../browser/fixtures.js";

describe("TabLeaseManager", () => {
  it("returns a same-client lease without extending its expiry", () => {
    const fixture = browserFixture();
    const leases = new TabLeaseManager();
    const first = leases.acquire("owner", fixture.tab.id, 30_000, 1_000);
    const reacquired = leases.acquire("owner", fixture.tab.id, 300_000, 2_000);

    expect(reacquired).toEqual(first);
    expect(reacquired.expiresAt).toBe(31_000);
  });

  it("grants bounded waiters in FIFO order", async () => {
    const fixture = browserFixture();
    const leases = new TabLeaseManager();
    const owner = leases.acquire("owner", fixture.tab.id, 30_000, 1_000);
    const order: string[] = [];
    const first = leases
      .acquireWhenAvailable(
        "first",
        fixture.tab.id,
        30_000,
        60_000,
        undefined,
        1_000,
      )
      .then((lease) => {
        order.push("first");
        return lease;
      });
    const second = leases
      .acquireWhenAvailable(
        "second",
        fixture.tab.id,
        30_000,
        60_000,
        undefined,
        1_000,
      )
      .then((lease) => {
        order.push("second");
        return lease;
      });

    leases.release("owner", owner.leaseId, 2_000);
    const firstLease = await first;
    expect(order).toEqual(["first"]);
    leases.release("first", firstLease.leaseId, 3_000);
    await expect(second).resolves.toMatchObject({ tabId: fixture.tab.id });
    expect(order).toEqual(["first", "second"]);
    leases.clear();
  });

  it("cancels and times out acquisition waits with structured metadata", async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(1_000);
      const fixture = browserFixture();
      const leases = new TabLeaseManager();
      leases.acquire("owner", fixture.tab.id, 30_000);
      const controller = new AbortController();
      const cancelled = leases.acquireWhenAvailable(
        "cancelled",
        fixture.tab.id,
        30_000,
        60_000,
        controller.signal,
      );
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({
        code: "cancelled",
        data: {
          reason: "lease-wait-cancelled",
          resource: "lease",
        },
      });

      const timedOut = leases.acquireWhenAvailable(
        "timed-out",
        fixture.tab.id,
        30_000,
        1_000,
      );
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({
        code: "timeout",
        data: {
          reason: "lease-wait-timeout",
          resource: "lease",
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await timedOutExpectation;
      leases.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects waiters when a leased tab is revoked", async () => {
    const fixture = browserFixture();
    const leases = new TabLeaseManager();
    leases.acquire("owner", fixture.tab.id, 30_000, 1_000);
    const waiting = leases.acquireWhenAvailable(
      "waiting",
      fixture.tab.id,
      30_000,
      60_000,
      undefined,
      1_000,
    );
    const closed = new DaemonProtocolError(
      "stale-id",
      "The requested tab was closed.",
      {
        reason: "tab-closed",
        resource: "tab",
        retryable: false,
      },
    );

    leases.revokeTab(fixture.tab.id, closed);

    await expect(waiting).rejects.toBe(closed);
  });

  it("caps active leases per client", () => {
    const fixture = browserFixture();
    const leases = new TabLeaseManager();

    for (let index = 0; index < MAX_TAB_LEASES_PER_CLIENT; index += 1) {
      leases.acquire(
        "owner",
        sessionEntityId("tab", fixture.session.id, `tab-${String(index)}`),
        30_000,
        1_000,
      );
    }

    expect(() =>
      leases.acquire(
        "owner",
        sessionEntityId("tab", fixture.session.id, "over-cap"),
        30_000,
        1_000,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "policy-rejection",
        data: {
          reason: "lease-cap",
          resource: "lease",
          retryable: false,
          limit: MAX_TAB_LEASES_PER_CLIENT,
        },
      }),
    );
    leases.clear();
  });
});
