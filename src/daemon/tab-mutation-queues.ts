import { Buffer } from "node:buffer";

import {
  DaemonProtocolError,
  MAX_DAEMON_IDENTIFIER_BYTES,
} from "./protocol.js";

export const DEFAULT_MAX_ACTIVE_TAB_MUTATION_QUEUES = 128;
export const DEFAULT_MAX_PENDING_TAB_MUTATIONS = 1_024;
export const DEFAULT_MAX_PENDING_MUTATIONS_PER_QUEUE = 64;

export type TabSpecificMutationQueueKey = Readonly<{
  kind: "tab";
  tabId: string;
}>;

export type TabMutationQueueKey =
  TabSpecificMutationQueueKey | Readonly<{ kind: "global" }>;

/** Queue key for mutations such as opening a tab that have no target tab yet. */
export const GLOBAL_TAB_MUTATION_QUEUE_KEY: TabMutationQueueKey = Object.freeze(
  {
    kind: "global",
  },
);

export function tabMutationQueueKey(
  tabId: string,
): TabSpecificMutationQueueKey {
  if (
    tabId.trim().length === 0 ||
    Buffer.byteLength(tabId, "utf8") > MAX_DAEMON_IDENTIFIER_BYTES
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      "A tab mutation queue requires a bounded non-empty tab identifier.",
    );
  }

  return Object.freeze({ kind: "tab", tabId });
}

export interface TabMutationQueuesOptions {
  /** Running or queued tab-specific keys. The global key is not included. */
  readonly maxActiveTabQueues?: number;
  /** Running and queued operations across tab-specific and global queues. */
  readonly maxPendingMutations?: number;
  /** Running and queued operations accepted for any one queue key. */
  readonly maxPendingPerQueue?: number;
}

interface MutationQueue {
  readonly tabSpecific: boolean;
  pending: number;
  tail: Promise<void>;
}

/**
 * Bounded FIFO mutation scheduling keyed by an explicit tab identity.
 *
 * Operations for one key never overlap. Different tab keys, and the global
 * key, may run concurrently. A queue exists only while it has unsettled work.
 */
export class TabMutationQueues {
  readonly #maxActiveTabQueues: number;
  readonly #maxPendingMutations: number;
  readonly #maxPendingPerQueue: number;
  readonly #queues = new Map<string, MutationQueue>();

  #activeTabQueues = 0;
  #pendingMutations = 0;

  public constructor(options: TabMutationQueuesOptions = {}) {
    this.#maxActiveTabQueues = positiveLimit(
      options.maxActiveTabQueues,
      DEFAULT_MAX_ACTIVE_TAB_MUTATION_QUEUES,
      "maxActiveTabQueues",
    );
    this.#maxPendingMutations = positiveLimit(
      options.maxPendingMutations,
      DEFAULT_MAX_PENDING_TAB_MUTATIONS,
      "maxPendingMutations",
    );
    this.#maxPendingPerQueue = positiveLimit(
      options.maxPendingPerQueue,
      DEFAULT_MAX_PENDING_MUTATIONS_PER_QUEUE,
      "maxPendingPerQueue",
    );
  }

  public get activeQueueCount(): number {
    return this.#queues.size;
  }

  public get activeTabQueueCount(): number {
    return this.#activeTabQueues;
  }

  public get pendingMutationCount(): number {
    return this.#pendingMutations;
  }

  public schedule<T>(
    key: TabMutationQueueKey,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const canonical = canonicalKey(key);
    let queue = this.#queues.get(canonical);

    if (this.#pendingMutations >= this.#maxPendingMutations) {
      throw queueCeiling(
        "pending-mutations",
        this.#maxPendingMutations,
        this.#pendingMutations,
      );
    }

    if (queue !== undefined && queue.pending >= this.#maxPendingPerQueue) {
      throw queueCeiling(
        "pending-mutations-per-queue",
        this.#maxPendingPerQueue,
        queue.pending,
      );
    }

    if (
      queue === undefined &&
      key.kind === "tab" &&
      this.#activeTabQueues >= this.#maxActiveTabQueues
    ) {
      throw queueCeiling(
        "active-tab-queues",
        this.#maxActiveTabQueues,
        this.#activeTabQueues,
      );
    }

    if (queue === undefined) {
      queue = {
        tabSpecific: key.kind === "tab",
        pending: 0,
        tail: Promise.resolve(),
      };
      this.#queues.set(canonical, queue);

      if (queue.tabSpecific) {
        this.#activeTabQueues += 1;
      }
    }

    queue.pending += 1;
    this.#pendingMutations += 1;
    const acceptedQueue = queue;
    const result = acceptedQueue.tail.then(operation, operation);
    acceptedQueue.tail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => this.#settled(canonical, acceptedQueue),
      () => this.#settled(canonical, acceptedQueue),
    );
    return result;
  }

  /** Wait for all work accepted before this call to settle. */
  public async idle(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((queue) => queue.tail));
  }

  #settled(canonical: string, queue: MutationQueue): void {
    queue.pending -= 1;
    this.#pendingMutations -= 1;

    if (queue.pending !== 0 || this.#queues.get(canonical) !== queue) {
      return;
    }

    this.#queues.delete(canonical);

    if (queue.tabSpecific) {
      this.#activeTabQueues -= 1;
    }
  }
}

function canonicalKey(key: TabMutationQueueKey): string {
  if (key.kind === "global") {
    return "global";
  }

  if (key.kind === "tab") {
    return `tab:${tabMutationQueueKey(key.tabId).tabId}`;
  }

  throw new DaemonProtocolError(
    "invalid-request",
    "A mutation must name an explicit tab queue or the global queue.",
  );
}

function positiveLimit(
  configured: number | undefined,
  fallback: number,
  name: string,
): number {
  const value = configured ?? fallback;

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }

  return value;
}

function queueCeiling(
  scope: string,
  limit: number,
  current: number,
): DaemonProtocolError {
  return new DaemonProtocolError(
    "policy-rejection",
    "The daemon mutation scheduler reached a configured queue ceiling.",
    {
      reason: "mutation-queue-cap",
      resource: "mutation-queue",
      retryable: true,
      scope,
      limit,
      current,
    },
  );
}
