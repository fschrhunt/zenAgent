import { randomUUID } from "node:crypto";

import { entityIdKey, type BrowserTabId } from "../browser/model.js";
import { DaemonProtocolError } from "./protocol.js";

export const MIN_TAB_LEASE_TTL_MS = 1_000;
export const DEFAULT_TAB_LEASE_TTL_MS = 30_000;
export const MAX_TAB_LEASE_TTL_MS = 5 * 60_000;
export const MAX_TAB_LEASE_WAIT_MS = 60_000;
export const MAX_TAB_LEASES_PER_CLIENT = 16;
export const MAX_TAB_LEASES_PER_SESSION = 256;
export const MAX_TAB_LEASE_WAITERS_PER_TAB = 16;
export const MAX_TAB_LEASE_WAITERS_PER_CLIENT = 16;
export const MAX_TAB_LEASE_WAITERS_PER_SESSION = 256;

export interface TabLease {
  readonly leaseId: string;
  readonly tabId: BrowserTabId;
  readonly clientId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export type PublicTabLease = Omit<TabLease, "clientId">;

interface LeaseWaiter {
  readonly waiterId: string;
  readonly clientId: string;
  readonly tabId: BrowserTabId;
  readonly ttlMs: number;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (lease: PublicTabLease) => void;
  readonly reject: (error: DaemonProtocolError) => void;
  readonly onAbort: (() => void) | undefined;
}

/**
 * Owns bounded exclusive tab leases and request-scoped FIFO acquisition waits.
 *
 * Waiters are resolved atomically when ownership becomes available. There is
 * no availability notification followed by a racy second acquire.
 */
export class TabLeaseManager {
  readonly #byTab = new Map<string, TabLease>();
  readonly #byId = new Map<string, TabLease>();
  readonly #waitersByTab = new Map<string, LeaseWaiter[]>();
  readonly #wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Acquire immediately. Reacquiring a lease already owned by this client
   * returns the existing lease without extending its expiry.
   */
  public acquire(
    clientId: string,
    tabId: BrowserTabId,
    ttlMs: number,
    now = Date.now(),
  ): PublicTabLease {
    this.pruneExpired(now);
    const tabKey = entityIdKey(tabId);
    const existing = this.#byTab.get(tabKey);

    if (existing !== undefined) {
      if (existing.clientId === clientId) {
        return publicLease(existing);
      }

      throw leaseConflict(
        "The requested tab is leased by another client.",
        existing,
        now,
      );
    }

    if ((this.#waitersByTab.get(tabKey)?.length ?? 0) > 0) {
      throw leaseConflict(
        "The requested tab has queued lease waiters.",
        undefined,
        now,
      );
    }

    return publicLease(this.#createLease(clientId, tabId, ttlMs, now));
  }

  /**
   * Acquire immediately or wait in bounded FIFO order for this tab.
   */
  public acquireWhenAvailable(
    clientId: string,
    tabId: BrowserTabId,
    ttlMs: number,
    waitMs: number,
    signal?: AbortSignal,
    now = Date.now(),
  ): Promise<PublicTabLease> {
    this.pruneExpired(now);
    const tabKey = entityIdKey(tabId);
    const existing = this.#byTab.get(tabKey);

    if (existing?.clientId === clientId) {
      return Promise.resolve(publicLease(existing));
    }

    if (
      existing === undefined &&
      (this.#waitersByTab.get(tabKey)?.length ?? 0) === 0
    ) {
      return Promise.resolve(
        publicLease(this.#createLease(clientId, tabId, ttlMs, now)),
      );
    }

    if (waitMs <= 0) {
      return Promise.reject(
        leaseConflict(
          "The requested tab is leased by another client.",
          existing,
          now,
        ),
      );
    }

    if (signal?.aborted === true) {
      return Promise.reject(cancelledLeaseWait());
    }

    this.#assertWaiterCapacity(clientId, tabKey);

    return new Promise<PublicTabLease>((resolve, reject) => {
      const waiterId = randomUUID();
      const onAbort =
        signal === undefined
          ? undefined
          : (): void => {
              this.#cancelWaiter(tabKey, waiterId, cancelledLeaseWait());
            };
      const waiter: LeaseWaiter = {
        waiterId,
        clientId,
        tabId,
        ttlMs,
        deadline: now + waitMs,
        signal,
        resolve,
        reject,
        onAbort,
      };
      const waiters = this.#waitersByTab.get(tabKey) ?? [];
      waiters.push(waiter);
      this.#waitersByTab.set(tabKey, waiters);
      signal?.addEventListener("abort", onAbort ?? (() => undefined), {
        once: true,
      });
      this.#scheduleWake(tabKey, now);
    });
  }

  public renew(
    clientId: string,
    leaseId: string,
    ttlMs: number,
    now = Date.now(),
  ): PublicTabLease {
    this.pruneExpired(now);
    const existing = this.#byId.get(leaseId);

    if (existing === undefined) {
      throw staleLease();
    }

    if (existing.clientId !== clientId) {
      throw leaseConflict("The tab lease belongs to another client.", existing);
    }

    const renewed: TabLease = {
      ...existing,
      expiresAt: now + ttlMs,
    };
    this.#byTab.set(entityIdKey(existing.tabId), renewed);
    this.#byId.set(leaseId, renewed);
    this.#scheduleWake(entityIdKey(existing.tabId), now);
    return publicLease(renewed);
  }

  public release(
    clientId: string,
    leaseId: string,
    now = Date.now(),
  ): PublicTabLease {
    this.pruneExpired(now);
    const existing = this.#byId.get(leaseId);

    if (existing === undefined) {
      throw staleLease();
    }

    if (existing.clientId !== clientId) {
      throw leaseConflict("The tab lease belongs to another client.", existing);
    }

    const tabKey = entityIdKey(existing.tabId);
    this.#remove(existing);
    this.#processTab(tabKey, now);
    return publicLease(existing);
  }

  /** Resolve an owned lease to its stable tab before scheduling tab work. */
  public ownedTabId(
    clientId: string,
    leaseId: string,
    now = Date.now(),
  ): BrowserTabId {
    this.pruneExpired(now);
    const existing = this.#byId.get(leaseId);

    if (existing === undefined) {
      throw staleLease();
    }
    if (existing.clientId !== clientId) {
      throw leaseConflict("The tab lease belongs to another client.", existing);
    }
    return existing.tabId;
  }

  public assertMutationAllowed(
    clientId: string,
    tabId: BrowserTabId,
    now = Date.now(),
  ): void {
    this.pruneExpired(now);
    const existing = this.#byTab.get(entityIdKey(tabId));

    if (existing !== undefined && existing.clientId !== clientId) {
      throw leaseConflict(
        "The requested tab is leased by another client.",
        existing,
        now,
      );
    }
  }

  /**
   * Page mutations are stricter than tab maintenance: the caller must present
   * the exact live lease it owns for the target tab.
   */
  public assertOwned(
    clientId: string,
    leaseId: string,
    tabId: BrowserTabId,
    now = Date.now(),
  ): void {
    this.pruneExpired(now);
    const lease = this.#byId.get(leaseId);

    if (lease === undefined) {
      throw staleLease();
    }

    if (
      lease.clientId !== clientId ||
      entityIdKey(lease.tabId) !== entityIdKey(tabId)
    ) {
      throw leaseConflict(
        "The supplied lease does not belong to this client and tab.",
        lease,
        now,
      );
    }
  }

  public releaseClient(clientId: string, now = Date.now()): void {
    const affectedTabs = new Set<string>();

    for (const lease of this.#byId.values()) {
      if (lease.clientId === clientId) {
        affectedTabs.add(entityIdKey(lease.tabId));
        this.#remove(lease);
      }
    }

    for (const [tabKey, waiters] of this.#waitersByTab) {
      for (const waiter of [...waiters]) {
        if (waiter.clientId === clientId) {
          this.#cancelWaiter(tabKey, waiter.waiterId, cancelledLeaseWait());
        }
      }
    }

    for (const tabKey of affectedTabs) {
      this.#processTab(tabKey, now);
    }
  }

  public releaseTab(tabId: BrowserTabId, now = Date.now()): void {
    const tabKey = entityIdKey(tabId);
    const lease = this.#byTab.get(tabKey);

    if (lease !== undefined) {
      this.#remove(lease);
    }

    this.#processTab(tabKey, now);
  }

  /**
   * Revoke ownership and reject queued waiters because the tab is no longer
   * safe or available. Selection uses this as an explicit user takeover.
   */
  public revokeTab(tabId: BrowserTabId, error: DaemonProtocolError): void {
    const tabKey = entityIdKey(tabId);
    const lease = this.#byTab.get(tabKey);

    if (lease !== undefined) {
      this.#remove(lease);
    }

    this.#rejectTabWaiters(tabKey, error);
  }

  public retainTabs(predicate: (tabId: BrowserTabId) => boolean): void {
    for (const lease of [...this.#byId.values()]) {
      if (!predicate(lease.tabId)) {
        this.revokeTab(
          lease.tabId,
          staleTab("The leased tab is no longer active."),
        );
      }
    }

    for (const waiters of this.#waitersByTab.values()) {
      const tabId = waiters[0]?.tabId;

      if (tabId !== undefined && !predicate(tabId)) {
        this.revokeTab(
          tabId,
          staleTab("The requested tab is no longer active."),
        );
      }
    }
  }

  public pruneExpired(now = Date.now()): void {
    const expiredTabs = new Set<string>();

    for (const lease of [...this.#byId.values()]) {
      if (lease.expiresAt <= now) {
        expiredTabs.add(entityIdKey(lease.tabId));
        this.#remove(lease);
      }
    }

    for (const tabKey of expiredTabs) {
      this.#processTab(tabKey, now);
    }
  }

  public clear(
    error = new DaemonProtocolError(
      "browser-unavailable",
      "The browser transport is unavailable.",
      { resource: "lease", retryable: true },
    ),
  ): void {
    this.#byTab.clear();
    this.#byId.clear();

    for (const tabKey of [...this.#waitersByTab.keys()]) {
      this.#rejectTabWaiters(tabKey, error);
    }

    for (const timer of this.#wakeTimers.values()) {
      clearTimeout(timer);
    }
    this.#wakeTimers.clear();
  }

  #createLease(
    clientId: string,
    tabId: BrowserTabId,
    ttlMs: number,
    now: number,
  ): TabLease {
    this.#assertLeaseCapacity(clientId);
    const lease: TabLease = {
      leaseId: randomUUID(),
      tabId,
      clientId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };
    this.#byTab.set(entityIdKey(tabId), lease);
    this.#byId.set(lease.leaseId, lease);
    return lease;
  }

  #assertLeaseCapacity(clientId: string): void {
    const clientLeases = [...this.#byId.values()].filter(
      (lease) => lease.clientId === clientId,
    ).length;

    if (clientLeases >= MAX_TAB_LEASES_PER_CLIENT) {
      throw leaseCap("client", MAX_TAB_LEASES_PER_CLIENT);
    }

    if (this.#byId.size >= MAX_TAB_LEASES_PER_SESSION) {
      throw leaseCap("session", MAX_TAB_LEASES_PER_SESSION);
    }
  }

  #assertWaiterCapacity(clientId: string, tabKey: string): void {
    const tabWaiters = this.#waitersByTab.get(tabKey)?.length ?? 0;
    const clientWaiters = [...this.#waitersByTab.values()]
      .flat()
      .filter((waiter) => waiter.clientId === clientId).length;
    const totalWaiters = [...this.#waitersByTab.values()].reduce(
      (total, waiters) => total + waiters.length,
      0,
    );

    if (tabWaiters >= MAX_TAB_LEASE_WAITERS_PER_TAB) {
      throw waiterCap("tab", MAX_TAB_LEASE_WAITERS_PER_TAB);
    }

    if (clientWaiters >= MAX_TAB_LEASE_WAITERS_PER_CLIENT) {
      throw waiterCap("client", MAX_TAB_LEASE_WAITERS_PER_CLIENT);
    }

    if (totalWaiters >= MAX_TAB_LEASE_WAITERS_PER_SESSION) {
      throw waiterCap("session", MAX_TAB_LEASE_WAITERS_PER_SESSION);
    }
  }

  #processTab(tabKey: string, now = Date.now()): void {
    const timer = this.#wakeTimers.get(tabKey);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.#wakeTimers.delete(tabKey);
    }

    const existing = this.#byTab.get(tabKey);

    if (existing !== undefined && existing.expiresAt <= now) {
      this.#remove(existing);
    }

    const waiters = this.#waitersByTab.get(tabKey) ?? [];

    for (const waiter of [...waiters]) {
      if (waiter.signal?.aborted === true) {
        this.#settleWaiter(tabKey, waiter, cancelledLeaseWait());
      } else if (waiter.deadline <= now) {
        this.#settleWaiter(tabKey, waiter, timedOutLeaseWait());
      }
    }

    const liveWaiters = this.#waitersByTab.get(tabKey) ?? [];

    if (this.#byTab.has(tabKey) || liveWaiters.length === 0) {
      this.#scheduleWake(tabKey, now);
      return;
    }

    const waiter = liveWaiters[0];

    if (waiter === undefined) {
      return;
    }

    try {
      const lease = this.#createLease(
        waiter.clientId,
        waiter.tabId,
        waiter.ttlMs,
        now,
      );
      this.#settleWaiter(tabKey, waiter, undefined, publicLease(lease));
    } catch (error) {
      this.#settleWaiter(
        tabKey,
        waiter,
        error instanceof DaemonProtocolError
          ? error
          : new DaemonProtocolError(
              "internal",
              "The daemon could not grant a queued tab lease.",
            ),
      );
      this.#processTab(tabKey, now);
      return;
    }

    this.#scheduleWake(tabKey, now);
  }

  #scheduleWake(tabKey: string, now: number): void {
    const existingTimer = this.#wakeTimers.get(tabKey);

    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.#wakeTimers.delete(tabKey);
    }

    const waiters = this.#waitersByTab.get(tabKey);

    if (waiters === undefined || waiters.length === 0) {
      return;
    }

    const leaseExpiry = this.#byTab.get(tabKey)?.expiresAt;
    const wakeAt = Math.min(
      ...waiters.map((waiter) => waiter.deadline),
      leaseExpiry ?? Number.POSITIVE_INFINITY,
    );
    const timer = setTimeout(
      () => {
        this.#wakeTimers.delete(tabKey);
        this.#processTab(tabKey);
      },
      Math.max(0, wakeAt - now),
    );
    timer.unref?.();
    this.#wakeTimers.set(tabKey, timer);
  }

  #cancelWaiter(
    tabKey: string,
    waiterId: string,
    error: DaemonProtocolError,
  ): void {
    const waiter = this.#waitersByTab
      .get(tabKey)
      ?.find((candidate) => candidate.waiterId === waiterId);

    if (waiter !== undefined) {
      this.#settleWaiter(tabKey, waiter, error);
      this.#processTab(tabKey);
    }
  }

  #settleWaiter(
    tabKey: string,
    waiter: LeaseWaiter,
    error?: DaemonProtocolError,
    lease?: PublicTabLease,
  ): void {
    const waiters = this.#waitersByTab.get(tabKey);

    if (waiters === undefined || !waiters.includes(waiter)) {
      return;
    }

    const remaining = waiters.filter((candidate) => candidate !== waiter);

    if (remaining.length === 0) {
      this.#waitersByTab.delete(tabKey);
    } else {
      this.#waitersByTab.set(tabKey, remaining);
    }

    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }

    if (error !== undefined) {
      waiter.reject(error);
    } else if (lease !== undefined) {
      waiter.resolve(lease);
    }
  }

  #rejectTabWaiters(tabKey: string, error: DaemonProtocolError): void {
    for (const waiter of [...(this.#waitersByTab.get(tabKey) ?? [])]) {
      this.#settleWaiter(tabKey, waiter, error);
    }

    const timer = this.#wakeTimers.get(tabKey);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.#wakeTimers.delete(tabKey);
    }
  }

  #remove(lease: TabLease): void {
    this.#byId.delete(lease.leaseId);
    this.#byTab.delete(entityIdKey(lease.tabId));
  }
}

function publicLease(lease: TabLease): PublicTabLease {
  return {
    leaseId: lease.leaseId,
    tabId: lease.tabId,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

function staleLease(): DaemonProtocolError {
  return new DaemonProtocolError(
    "stale-id",
    "The tab lease is missing or expired.",
    {
      reason: "lease-expired",
      resource: "lease",
      retryable: true,
    },
  );
}

function staleTab(message: string): DaemonProtocolError {
  return new DaemonProtocolError("stale-id", message, {
    reason: "tab-inactive",
    resource: "tab",
    retryable: false,
  });
}

function leaseConflict(
  message: string,
  lease?: TabLease,
  now = Date.now(),
): DaemonProtocolError {
  return new DaemonProtocolError("lease-conflict", message, {
    reason: "tab-leased",
    resource: "lease",
    retryable: true,
    ...(lease === undefined
      ? {}
      : {
          leaseExpiresAt: lease.expiresAt,
          retryAfterMs: Math.max(0, lease.expiresAt - now),
        }),
  });
}

function leaseCap(scope: string, limit: number): DaemonProtocolError {
  return new DaemonProtocolError(
    "policy-rejection",
    `The ${scope} tab lease limit has been reached.`,
    {
      reason: "lease-cap",
      resource: "lease",
      retryable: false,
      limit,
    },
  );
}

function waiterCap(scope: string, limit: number): DaemonProtocolError {
  return new DaemonProtocolError(
    "policy-rejection",
    `The ${scope} tab lease waiter limit has been reached.`,
    {
      reason: "lease-waiter-cap",
      resource: "lease",
      retryable: false,
      limit,
    },
  );
}

function timedOutLeaseWait(): DaemonProtocolError {
  return new DaemonProtocolError(
    "timeout",
    "The tab lease was not available before the acquisition deadline.",
    {
      reason: "lease-wait-timeout",
      resource: "lease",
      retryable: true,
    },
  );
}

function cancelledLeaseWait(): DaemonProtocolError {
  return new DaemonProtocolError(
    "cancelled",
    "The tab lease acquisition wait was cancelled.",
    {
      reason: "lease-wait-cancelled",
      resource: "lease",
      retryable: true,
    },
  );
}
