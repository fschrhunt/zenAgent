import { createHash } from "node:crypto";

import {
  entityIdKey,
  type BrowserTab,
  type BrowserTabId,
} from "../browser/model.js";
import { DaemonProtocolError } from "./protocol.js";

export const MAX_TEMPORARY_TABS_PER_CLIENT = 16;
export const MAX_TEMPORARY_TABS_PER_SESSION = 128;

interface TemporaryTabProvenance {
  readonly clientId: string;
  readonly tabId: BrowserTabId;
  readonly requestedUrlHash: string;
  readonly createdAt: number;
  reused: boolean;
  changed: boolean;
  selected: boolean;
  playedMedia: boolean;
}

export type TemporaryTabCleanupReason =
  "reused" | "changed" | "selected" | "played-media";

/**
 * Retains only bounded ownership and safety metadata for explicitly temporary
 * agent-created tabs. Raw URLs, titles, and page content are never retained.
 */
export class TemporaryTabProvenanceRegistry {
  readonly #byTab = new Map<string, TemporaryTabProvenance>();

  public assertCapacity(clientId: string): void {
    const clientTabs = [...this.#byTab.values()].filter(
      (entry) => entry.clientId === clientId,
    ).length;

    if (clientTabs >= MAX_TEMPORARY_TABS_PER_CLIENT) {
      throw provenanceCap("client", MAX_TEMPORARY_TABS_PER_CLIENT);
    }

    if (this.#byTab.size >= MAX_TEMPORARY_TABS_PER_SESSION) {
      throw provenanceCap("session", MAX_TEMPORARY_TABS_PER_SESSION);
    }
  }

  public remember(
    clientId: string,
    tabId: BrowserTabId,
    requestedUrl: string,
    now = Date.now(),
  ): void {
    this.assertCapacity(clientId);
    const key = entityIdKey(tabId);

    if (this.#byTab.has(key)) {
      throw new DaemonProtocolError(
        "internal",
        "The daemon already tracks provenance for that temporary tab.",
      );
    }

    this.#byTab.set(key, {
      clientId,
      tabId,
      requestedUrlHash: urlHash(requestedUrl),
      createdAt: now,
      reused: false,
      changed: false,
      selected: false,
      playedMedia: false,
    });
  }

  public observe(tab: BrowserTab): void {
    const entry = this.#byTab.get(entityIdKey(tab.id));

    if (entry === undefined) {
      return;
    }

    if (
      tab.url.status === "known" &&
      urlHash(tab.url.value) !== entry.requestedUrlHash
    ) {
      entry.changed = true;
    }

    if (tab.selected.status === "known" && tab.selected.value) {
      entry.selected = true;
    }

    if (
      tab.mediaState.status === "known" &&
      tab.mediaState.value === "playing"
    ) {
      entry.playedMedia = true;
    }
  }

  public markReused(tabId: BrowserTabId): void {
    const entry = this.#byTab.get(entityIdKey(tabId));

    if (entry !== undefined) {
      entry.reused = true;
    }
  }

  public markChanged(tabId: BrowserTabId): void {
    const entry = this.#byTab.get(entityIdKey(tabId));

    if (entry !== undefined) {
      entry.changed = true;
    }
  }

  public cleanupEligibility(
    clientId: string,
    tab: BrowserTab,
  ):
    | Readonly<{ eligible: true }>
    | Readonly<{ eligible: false; reason: TemporaryTabCleanupReason }> {
    const entry = this.#owned(clientId, tab.id);
    this.observe(tab);

    if (entry.reused) {
      return { eligible: false, reason: "reused" };
    }

    if (entry.selected) {
      return { eligible: false, reason: "selected" };
    }

    if (entry.playedMedia) {
      return { eligible: false, reason: "played-media" };
    }

    if (entry.changed) {
      return { eligible: false, reason: "changed" };
    }

    return { eligible: true };
  }

  /**
   * Stop tracking a tab that the caller explicitly keeps or successfully
   * closes.
   */
  public release(clientId: string, tabId: BrowserTabId): void {
    this.#owned(clientId, tabId);
    this.#byTab.delete(entityIdKey(tabId));
  }

  public releaseTab(tabId: BrowserTabId): void {
    this.#byTab.delete(entityIdKey(tabId));
  }

  public retainTabs(predicate: (tabId: BrowserTabId) => boolean): void {
    for (const [key, entry] of this.#byTab) {
      if (!predicate(entry.tabId)) {
        this.#byTab.delete(key);
      }
    }
  }

  public clear(): void {
    this.#byTab.clear();
  }

  #owned(clientId: string, tabId: BrowserTabId): TemporaryTabProvenance {
    const entry = this.#byTab.get(entityIdKey(tabId));

    if (entry === undefined) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "That tab is not tracked as an explicitly temporary agent-created tab.",
        {
          reason: "cleanup-not-temporary",
          resource: "tab",
          retryable: false,
        },
      );
    }

    if (entry.clientId !== clientId) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "The temporary tab was created by another daemon client.",
        {
          reason: "cleanup-owner",
          resource: "tab",
          retryable: false,
        },
      );
    }

    return entry;
  }
}

function urlHash(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

function provenanceCap(scope: string, limit: number): DaemonProtocolError {
  return new DaemonProtocolError(
    "policy-rejection",
    `The ${scope} temporary-tab tracking limit has been reached.`,
    {
      reason: "temporary-tab-cap",
      resource: "tab",
      retryable: false,
      limit,
    },
  );
}
