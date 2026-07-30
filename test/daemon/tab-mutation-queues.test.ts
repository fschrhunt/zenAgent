import { describe, expect, it } from "vitest";

import { DaemonProtocolError } from "../../src/daemon/protocol.js";
import {
  GLOBAL_TAB_MUTATION_QUEUE_KEY,
  TabMutationQueues,
  tabMutationQueueKey,
} from "../../src/daemon/tab-mutation-queues.js";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

describe("TabMutationQueues", () => {
  it("runs mutations FIFO within one explicit tab even after a rejection", async () => {
    const queues = new TabMutationQueues();
    const gate = deferred();
    const events: string[] = [];
    const key = tabMutationQueueKey("tab-1");
    const first = queues.schedule(key, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
      throw new Error("expected failure");
    });
    const second = queues.schedule(key, () => {
      events.push("second");
      return 2;
    });
    const third = queues.schedule(key, () => {
      events.push("third");
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    gate.resolve();
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe(2);
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("runs unrelated tab and global queues concurrently", async () => {
    const queues = new TabMutationQueues();
    const gate = deferred();
    const started: string[] = [];
    const run = (name: string): Promise<string> =>
      queues.schedule(
        name === "global"
          ? GLOBAL_TAB_MUTATION_QUEUE_KEY
          : tabMutationQueueKey(name),
        async () => {
          started.push(name);
          await gate.promise;
          return name;
        },
      );

    const results = [run("tab-1"), run("tab-2"), run("global")];
    await Promise.resolve();
    expect(started).toEqual(["tab-1", "tab-2", "global"]);
    gate.resolve();
    await expect(Promise.all(results)).resolves.toEqual([
      "tab-1",
      "tab-2",
      "global",
    ]);
  });

  it("bounds active tab queues while preserving existing and global queues", async () => {
    const queues = new TabMutationQueues({ maxActiveTabQueues: 1 });
    const gate = deferred();
    const tab = tabMutationQueueKey("tab-1");
    const first = queues.schedule(tab, () => gate.promise);
    const second = queues.schedule(tab, () => undefined);
    const global = queues.schedule(
      GLOBAL_TAB_MUTATION_QUEUE_KEY,
      () => undefined,
    );

    expect(() =>
      queues.schedule(tabMutationQueueKey("tab-2"), () => undefined),
    ).toThrowError(
      expect.objectContaining({
        name: "DaemonProtocolError",
        code: "policy-rejection",
        data: {
          reason: "mutation-queue-cap",
          resource: "mutation-queue",
          retryable: true,
          scope: "active-tab-queues",
          limit: 1,
          current: 1,
        },
      }),
    );

    gate.resolve();
    await Promise.all([first, second, global]);
  });

  it("returns structured errors for per-queue and total pending ceilings", async () => {
    const perQueue = new TabMutationQueues({ maxPendingPerQueue: 1 });
    const firstGate = deferred();
    const first = perQueue.schedule(tabMutationQueueKey("tab-1"), () => {
      return firstGate.promise;
    });

    expect(() =>
      perQueue.schedule(tabMutationQueueKey("tab-1"), () => undefined),
    ).toThrowError(
      expect.objectContaining({
        name: "DaemonProtocolError",
        code: "policy-rejection",
        data: {
          reason: "mutation-queue-cap",
          resource: "mutation-queue",
          retryable: true,
          scope: "pending-mutations-per-queue",
          limit: 1,
          current: 1,
        },
      }),
    );

    const total = new TabMutationQueues({ maxPendingMutations: 1 });
    const totalGate = deferred();
    const totalFirst = total.schedule(tabMutationQueueKey("tab-a"), () => {
      return totalGate.promise;
    });
    let totalError: unknown;

    try {
      void total.schedule(GLOBAL_TAB_MUTATION_QUEUE_KEY, () => undefined);
    } catch (error) {
      totalError = error;
    }

    expect(totalError).toBeInstanceOf(DaemonProtocolError);
    expect(totalError).toMatchObject({
      code: "policy-rejection",
      data: {
        reason: "mutation-queue-cap",
        resource: "mutation-queue",
        retryable: true,
        scope: "pending-mutations",
        limit: 1,
        current: 1,
      },
    });

    firstGate.resolve();
    totalGate.resolve();
    await Promise.all([first, totalFirst]);
  });

  it("removes tab and global queue state after all accepted work is idle", async () => {
    const queues = new TabMutationQueues();
    const tab = tabMutationQueueKey("tab-1");

    await Promise.all([
      queues.schedule(tab, () => "tab"),
      queues.schedule(GLOBAL_TAB_MUTATION_QUEUE_KEY, () => "global"),
    ]);
    await queues.idle();

    expect(queues.pendingMutationCount).toBe(0);
    expect(queues.activeQueueCount).toBe(0);
    expect(queues.activeTabQueueCount).toBe(0);
    await expect(queues.schedule(tab, () => "reused")).resolves.toBe("reused");
    expect(queues.activeQueueCount).toBe(0);
  });

  it("rejects malformed tab keys before scheduling work", () => {
    expect(() => tabMutationQueueKey(" ")).toThrow(DaemonProtocolError);
    expect(() => tabMutationQueueKey("x".repeat(257))).toThrow(
      DaemonProtocolError,
    );
  });
});
