import { createHash } from "node:crypto";
import {
  entityIdKey,
  type BrowserSnapshot,
  type BrowserSpace,
  type BrowserSpaceId,
  type BrowserTab,
  type BrowserTabId,
  type BrowserWindowId,
} from "../browser/model.js";
import {
  matchTab,
  validateMatchRequest,
  type TabMatch,
  type TabMatchRequest,
} from "./match.js";
import { normalizeUrl } from "./url.js";

export interface TabResolutionTransport {
  /** Always perform fresh discovery before choosing or opening. */
  snapshot(): Promise<BrowserSnapshot>;
  /**
   * The implementation must reject foreground creation. `background` is
   * literal `true` so an adapter cannot accidentally pass a caller choice
   * through to `active`/`selected`. It must also treat `idempotencyKey`
   * atomically: repeated calls with one key return the same tab identifier.
   */
  openTab(options: {
    readonly url: string;
    readonly windowId: BrowserWindowId;
    readonly spaceId: BrowserSpaceId;
    readonly background: true;
    readonly idempotencyKey: string;
  }): Promise<BrowserTabId>;
  /** Navigate the explicitly identified tab; never an implicit active tab. */
  navigateTab(tabId: BrowserTabId, url: string): Promise<void>;
}

export interface ResolveTabRequest extends TabMatchRequest {
  readonly spaceId: BrowserSpaceId;
  /**
   * Search another Space only when the chosen Space has no safe match.
   * Disabled by default and intentionally verbose at the call site.
   */
  readonly allowCrossSpaceReuse?: boolean;
  /**
   * Navigate a reused tab to `url`. Useful with weak matches and discarded
   * tabs. A stale tab triggers one fresh discovery/retry.
   */
  readonly navigateReusedTab?: boolean;
}

export interface ResolutionCandidate {
  readonly tabId: BrowserTabId;
  readonly windowId: BrowserWindowId;
  readonly spaceId: BrowserSpaceId;
  readonly lifecycleState: BrowserTab["lifecycleState"];
  readonly inChosenSpace: boolean;
  readonly bestMatch: TabMatch;
  readonly matches: readonly TabMatch[];
  readonly sensitiveOrStateful: boolean;
}

interface ResolutionExplanationBase {
  readonly chosenSpaceId: BrowserSpaceId;
  readonly consideredTabCount: number;
  readonly eligibleCandidates: readonly ResolutionCandidate[];
  readonly crossSpaceReuse: "forbidden" | "explicitly-allowed";
}

export interface ReusedResolution {
  readonly status: "reused";
  readonly tabId: BrowserTabId;
  readonly explanation: ResolutionExplanationBase &
    Readonly<{
      outcome: "reused";
      reason: "best-safe-match";
      match: TabMatch;
      navigated: boolean;
      staleRetryCount: number;
    }>;
}

export interface OpenedResolution {
  readonly status: "opened";
  readonly tabId: BrowserTabId;
  readonly explanation: ResolutionExplanationBase &
    Readonly<{
      outcome: "opened";
      reason: "no-safe-match";
      background: true;
      idempotencyKey: string;
      staleRetryCount: number;
    }>;
}

export interface AmbiguousResolution {
  readonly status: "ambiguous";
  readonly candidates: readonly ResolutionCandidate[];
  readonly explanation: ResolutionExplanationBase &
    Readonly<{
      outcome: "ambiguous";
      reason: "equally-safe-matches";
      match: TabMatch;
      staleRetryCount: number;
    }>;
}

export type TabResolution =
  ReusedResolution | OpenedResolution | AmbiguousResolution;

export class TabResolutionError extends Error {
  public readonly code:
    | "chosen-space-missing"
    | "chosen-space-ambiguous"
    | "invalid-created-tab-id";

  public constructor(code: TabResolutionError["code"], message: string) {
    super(message);
    this.name = "TabResolutionError";
    this.code = code;
  }
}

function isStaleIdError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "stale-id"
  );
}

function findChosenSpace(
  snapshot: BrowserSnapshot,
  requested: BrowserSpaceId,
): BrowserSpace {
  const key = entityIdKey(requested);
  const matches = snapshot.spaces.filter(
    (space) => entityIdKey(space.id) === key,
  );

  if (matches.length === 0) {
    throw new TabResolutionError(
      "chosen-space-missing",
      "The chosen Space is not present in the latest browser snapshot.",
    );
  }

  const match = matches[0];

  if (matches.length > 1 || match === undefined) {
    throw new TabResolutionError(
      "chosen-space-ambiguous",
      "The latest browser snapshot contains the chosen Space more than once.",
    );
  }

  return match;
}

function sameSpace(
  tab: BrowserTab,
  requested: BrowserSpaceId,
): tab is BrowserTab & {
  readonly spaceId: Readonly<{ status: "known"; value: BrowserSpaceId }>;
} {
  return (
    tab.spaceId.status === "known" &&
    tab.spaceId.value !== null &&
    entityIdKey(tab.spaceId.value) === entityIdKey(requested)
  );
}

function candidatesFor(
  snapshot: BrowserSnapshot,
  request: ResolveTabRequest,
  excludedTabKeys: ReadonlySet<string>,
): readonly ResolutionCandidate[] {
  const matched: ResolutionCandidate[] = [];

  for (const tab of snapshot.tabs) {
    if (excludedTabKeys.has(entityIdKey(tab.id))) {
      continue;
    }

    if (
      (tab.selected.status === "known" && tab.selected.value) ||
      (tab.mediaState.status === "known" && tab.mediaState.value === "playing")
    ) {
      continue;
    }

    const inChosenSpace = sameSpace(tab, request.spaceId);

    if (
      entityIdKey(tab.id.sessionId) !== entityIdKey(request.spaceId.sessionId)
    ) {
      continue;
    }

    if (!inChosenSpace && request.allowCrossSpaceReuse !== true) {
      continue;
    }

    if (tab.spaceId.status !== "known" || tab.spaceId.value === null) {
      continue;
    }

    const evaluation = matchTab(tab, request);

    if (evaluation.status !== "matched") {
      continue;
    }

    matched.push({
      tabId: tab.id,
      windowId: tab.windowId,
      spaceId: tab.spaceId.value,
      lifecycleState: tab.lifecycleState,
      inChosenSpace,
      bestMatch: evaluation.best,
      matches: evaluation.matches,
      sensitiveOrStateful: evaluation.sensitiveOrStateful,
    });
  }

  const hasChosenSpaceMatch = matched.some(
    (candidate) => candidate.inChosenSpace,
  );

  return matched
    .filter((candidate) => !hasChosenSpaceMatch || candidate.inChosenSpace)
    .toSorted(
      (left, right) => right.bestMatch.strength - left.bestMatch.strength,
    );
}

function assertCreatedTabId(
  tabId: BrowserTabId,
  chosenSpace: BrowserSpace,
): void {
  if (
    tabId.kind !== "tab" ||
    entityIdKey(tabId.sessionId) !== entityIdKey(chosenSpace.id.sessionId) ||
    tabId.transportId.trim().length === 0
  ) {
    throw new TabResolutionError(
      "invalid-created-tab-id",
      "The transport did not return a stable tab identifier from the chosen browser session.",
    );
  }
}

function requestKey(request: ResolveTabRequest): string {
  return JSON.stringify({
    space: entityIdKey(request.spaceId),
    url: normalizeUrl(request.url),
    rules: request.rules ?? ["exact-url", "normalized-url"],
    title: request.title ?? null,
    domain: request.domain ?? null,
    query: request.query ?? null,
    allowSensitiveWeakMatch: request.allowSensitiveWeakMatch === true,
    allowCrossSpaceReuse: request.allowCrossSpaceReuse === true,
    navigateReusedTab: request.navigateReusedTab === true,
  });
}

function opaqueIdempotencyKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Shared discovery/resolution policy.
 *
 * Concurrent equivalent requests share one promise, so a single daemon
 * instance cannot produce duplicate tabs. The deterministic key is also sent
 * to the transport, allowing a future cross-process adapter to make creation
 * atomic at the browser boundary.
 */
export class TabResolver {
  readonly #transport: TabResolutionTransport;
  readonly #inFlight = new Map<string, Promise<TabResolution>>();

  public constructor(transport: TabResolutionTransport) {
    this.#transport = transport;
  }

  public resolve(request: ResolveTabRequest): Promise<TabResolution> {
    validateMatchRequest(request);
    const key = requestKey(request);
    const existing = this.#inFlight.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const operation = this.#resolve(
      request,
      opaqueIdempotencyKey(key),
      new Set(),
      0,
    ).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, operation);
    return operation;
  }

  async #resolve(
    request: ResolveTabRequest,
    idempotencyKey: string,
    excludedTabKeys: ReadonlySet<string>,
    staleRetryCount: number,
  ): Promise<TabResolution> {
    const snapshot = await this.#transport.snapshot();
    const chosenSpace = findChosenSpace(snapshot, request.spaceId);
    const candidates = candidatesFor(snapshot, request, excludedTabKeys);
    const base = {
      chosenSpaceId: chosenSpace.id,
      consideredTabCount: snapshot.tabs.length,
      eligibleCandidates: candidates,
      crossSpaceReuse:
        request.allowCrossSpaceReuse === true
          ? ("explicitly-allowed" as const)
          : ("forbidden" as const),
    };
    const strongest = candidates[0];

    if (strongest !== undefined) {
      const equallySafe = candidates.filter(
        (candidate) =>
          candidate.bestMatch.strength === strongest.bestMatch.strength,
      );

      if (equallySafe.length > 1) {
        return {
          status: "ambiguous",
          candidates: equallySafe,
          explanation: {
            ...base,
            outcome: "ambiguous",
            reason: "equally-safe-matches",
            match: strongest.bestMatch,
            staleRetryCount,
          },
        };
      }

      if (request.navigateReusedTab === true) {
        try {
          await this.#transport.navigateTab(strongest.tabId, request.url);
        } catch (error) {
          if (staleRetryCount === 0 && isStaleIdError(error)) {
            const excluded = new Set(excludedTabKeys);
            excluded.add(entityIdKey(strongest.tabId));
            return this.#resolve(request, idempotencyKey, excluded, 1);
          }

          throw error;
        }
      }

      return {
        status: "reused",
        tabId: strongest.tabId,
        explanation: {
          ...base,
          outcome: "reused",
          reason: "best-safe-match",
          match: strongest.bestMatch,
          navigated: request.navigateReusedTab === true,
          staleRetryCount,
        },
      };
    }

    const tabId = await this.#transport.openTab({
      url: request.url,
      windowId: chosenSpace.windowId,
      spaceId: chosenSpace.id,
      background: true,
      idempotencyKey,
    });
    assertCreatedTabId(tabId, chosenSpace);

    return {
      status: "opened",
      tabId,
      explanation: {
        ...base,
        outcome: "opened",
        reason: "no-safe-match",
        background: true,
        idempotencyKey,
        staleRetryCount,
      },
    };
  }
}
