import { entityIdKey, type BrowserTabId } from "../browser/model.js";
import type { PageSnapshot } from "../page/model.js";
import { DaemonProtocolError } from "./protocol.js";

export const PAGE_REFERENCE_TTL_MS = 60_000;
export const MAX_PAGE_SNAPSHOTS_PER_CLIENT = 64;
export const MAX_PAGE_SNAPSHOTS_PER_SESSION = 256;

interface PageReferenceOwner {
  readonly clientId: string;
  readonly tabId: BrowserTabId;
  readonly documentId: string;
  readonly frameRefs: ReadonlySet<string>;
  readonly createdAt: number;
}

/**
 * Keeps only ownership and generation metadata. Page content remains in the
 * response path and is never duplicated into daemon-global state.
 */
export class PageReferenceRegistry {
  readonly #snapshots = new Map<string, PageReferenceOwner>();
  readonly #latestByClientTab = new Map<string, string>();

  public remember(
    clientId: string,
    tabId: BrowserTabId,
    snapshot: PageSnapshot,
    now = Date.now(),
  ): void {
    this.pruneExpired(now);

    if (this.#snapshots.has(snapshot.snapshotId)) {
      throw new DaemonProtocolError(
        "internal",
        "The browser reused a live page snapshot identifier.",
      );
    }

    this.#evictClientOverflow(clientId);
    this.#evictGlobalOverflow();
    this.#snapshots.set(snapshot.snapshotId, {
      clientId,
      tabId,
      documentId: snapshot.documentId,
      frameRefs: new Set(snapshot.frames.map((frame) => frame.frameRef)),
      createdAt: now,
    });
    this.#latestByClientTab.set(
      clientTabKey(clientId, tabId),
      snapshot.snapshotId,
    );
  }

  public assertOwned(
    clientId: string,
    target: {
      readonly tabId: BrowserTabId;
      readonly documentId: string;
      readonly snapshotId: string;
      readonly frameRef: string;
    },
    now = Date.now(),
  ): void {
    this.pruneExpired(now);
    const owner = this.#snapshots.get(target.snapshotId);

    if (owner === undefined) {
      throw new DaemonProtocolError(
        "stale-element",
        "The page snapshot is missing or expired.",
        {
          reason: "snapshot-expired",
          resource: "element",
          recovery: "snapshot-and-query",
          performed: false,
        },
      );
    }

    if (owner.clientId !== clientId) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "The page snapshot belongs to another daemon client.",
        { reason: "snapshot-owner" },
      );
    }

    if (entityIdKey(owner.tabId) !== entityIdKey(target.tabId)) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "The page snapshot does not belong to the requested tab.",
        { reason: "snapshot-tab" },
      );
    }

    if (owner.documentId !== target.documentId) {
      throw new DaemonProtocolError(
        "stale-document",
        "The page snapshot belongs to a replaced document.",
        {
          reason: "document-replaced",
          resource: "document",
          recovery: "snapshot-and-query",
          performed: false,
        },
      );
    }

    if (!owner.frameRefs.has(target.frameRef)) {
      throw new DaemonProtocolError(
        "stale-frame",
        "The frame reference does not belong to the page snapshot.",
        {
          reason: "frame-replaced",
          resource: "frame",
          recovery: "snapshot-and-query",
          performed: false,
        },
      );
    }
  }

  /**
   * Mutations use the client's newest snapshot for the tab as an optimistic
   * generation precondition. Older snapshots remain usable for bounded reads,
   * but cannot redirect a mutation after the client has observed newer state.
   */
  public assertLatestOwned(
    clientId: string,
    target: {
      readonly tabId: BrowserTabId;
      readonly documentId: string;
      readonly snapshotId: string;
      readonly frameRef: string;
    },
    now = Date.now(),
  ): void {
    this.assertOwned(clientId, target, now);

    if (
      this.#latestByClientTab.get(clientTabKey(clientId, target.tabId)) !==
      target.snapshotId
    ) {
      throw new DaemonProtocolError(
        "stale-element",
        "A newer page snapshot superseded this mutation target.",
        {
          reason: "snapshot-superseded",
          resource: "snapshot",
          retryable: true,
          recovery: "query-latest-snapshot",
          performed: false,
        },
      );
    }
  }

  public releaseClient(clientId: string): void {
    for (const [snapshotId, owner] of this.#snapshots) {
      if (owner.clientId === clientId) {
        this.#delete(snapshotId, owner);
      }
    }
  }

  public releaseTab(tabId: BrowserTabId): void {
    const key = entityIdKey(tabId);

    for (const [snapshotId, owner] of this.#snapshots) {
      if (entityIdKey(owner.tabId) === key) {
        this.#delete(snapshotId, owner);
      }
    }
  }

  public retainTabs(predicate: (tabId: BrowserTabId) => boolean): void {
    for (const [snapshotId, owner] of this.#snapshots) {
      if (!predicate(owner.tabId)) {
        this.#delete(snapshotId, owner);
      }
    }
  }

  public pruneExpired(now = Date.now()): void {
    const expiresBefore = now - PAGE_REFERENCE_TTL_MS;

    for (const [snapshotId, owner] of this.#snapshots) {
      if (owner.createdAt <= expiresBefore) {
        this.#delete(snapshotId, owner);
      }
    }
  }

  public clear(): void {
    this.#snapshots.clear();
    this.#latestByClientTab.clear();
  }

  #evictClientOverflow(clientId: string): void {
    const clientSnapshots = [...this.#snapshots]
      .filter(([, owner]) => owner.clientId === clientId)
      .map(([snapshotId]) => snapshotId);

    while (clientSnapshots.length >= MAX_PAGE_SNAPSHOTS_PER_CLIENT) {
      const oldest = clientSnapshots.shift();

      if (oldest !== undefined) {
        const owner = this.#snapshots.get(oldest);
        if (owner !== undefined) {
          this.#delete(oldest, owner);
        }
      }
    }
  }

  #evictGlobalOverflow(): void {
    while (this.#snapshots.size >= MAX_PAGE_SNAPSHOTS_PER_SESSION) {
      const oldest = this.#snapshots.keys().next().value;

      if (oldest === undefined) {
        return;
      }

      const owner = this.#snapshots.get(oldest);
      if (owner !== undefined) {
        this.#delete(oldest, owner);
      }
    }
  }

  #delete(snapshotId: string, owner: PageReferenceOwner): void {
    this.#snapshots.delete(snapshotId);
    const key = clientTabKey(owner.clientId, owner.tabId);

    if (this.#latestByClientTab.get(key) !== snapshotId) {
      return;
    }

    let latest: string | undefined;
    for (const [candidateId, candidate] of this.#snapshots) {
      if (
        candidate.clientId === owner.clientId &&
        entityIdKey(candidate.tabId) === entityIdKey(owner.tabId)
      ) {
        latest = candidateId;
      }
    }

    if (latest === undefined) {
      this.#latestByClientTab.delete(key);
    } else {
      this.#latestByClientTab.set(key, latest);
    }
  }
}

function clientTabKey(clientId: string, tabId: BrowserTabId): string {
  return `${clientId}\u0000${entityIdKey(tabId)}`;
}
