import type { BrowserTab } from "../browser/model.js";
import {
  hostnameMatchesDomain,
  isSensitiveOrStatefulUrl,
  normalizedHostname,
  normalizedOrigin,
  normalizeDomain,
  normalizeUrl,
} from "./url.js";

export type TabMatchRule =
  "exact-url" | "normalized-url" | "origin" | "domain" | "title" | "query";

export interface TabMatchRequest {
  readonly url: string;
  /**
   * Rules are considered in this fixed safety order, regardless of the order
   * supplied here. URL rules are the safe default; every weaker rule is opt-in.
   */
  readonly rules?: readonly TabMatchRule[];
  /** Expected title for the `title` rule. Compared case-insensitively. */
  readonly title?: string;
  /** Host or parent domain for the `domain` rule. Defaults to the URL's host. */
  readonly domain?: string;
  /** Case-insensitive text sought in the known title or URL. */
  readonly query?: string;
  /**
   * Permit origin/domain/title/query matching on sensitive or stateful pages.
   * Exact and normalized URL matches do not need this override.
   */
  readonly allowSensitiveWeakMatch?: boolean;
}

export interface TabMatch {
  readonly rule: TabMatchRule;
  readonly strength: number;
}

export type TabMatchEvaluation =
  | Readonly<{
      status: "matched";
      best: TabMatch;
      matches: readonly TabMatch[];
      sensitiveOrStateful: boolean;
    }>
  | Readonly<{
      status: "not-matched";
      reason:
        | "crashed"
        | "url-unknown"
        | "no-rule-matched"
        | "sensitive-weak-match-refused";
      sensitiveOrStateful: boolean | "unknown";
    }>;

const DEFAULT_RULES: readonly TabMatchRule[] = ["exact-url", "normalized-url"];

const MATCH_STRENGTH: Readonly<Record<TabMatchRule, number>> = {
  "exact-url": 600,
  "normalized-url": 500,
  origin: 300,
  domain: 200,
  title: 150,
  query: 100,
};

function includesRule(
  rules: readonly TabMatchRule[],
  rule: TabMatchRule,
): boolean {
  return rules.includes(rule);
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

/**
 * Pure tab matcher. It never guesses values hidden behind Observation:
 * URL-dependent matching requires a known URL, and title matching requires a
 * known title.
 */
export function matchTab(
  tab: BrowserTab,
  request: TabMatchRequest,
): TabMatchEvaluation {
  if (tab.lifecycleState === "crashed") {
    return {
      status: "not-matched",
      reason: "crashed",
      sensitiveOrStateful: "unknown",
    };
  }

  const rules = request.rules ?? DEFAULT_RULES;
  const targetNormalized = normalizeUrl(request.url);
  const targetSensitive = isSensitiveOrStatefulUrl(request.url);
  const tabUrl = tab.url.status === "known" ? tab.url.value : undefined;
  const tabNormalized =
    tabUrl === undefined
      ? undefined
      : (() => {
          try {
            return normalizeUrl(tabUrl);
          } catch {
            return undefined;
          }
        })();
  const tabSensitive =
    tabUrl === undefined || tabNormalized === undefined
      ? "unknown"
      : isSensitiveOrStatefulUrl(tabNormalized);
  const matches: TabMatch[] = [];

  if (
    includesRule(rules, "exact-url") &&
    tabUrl !== undefined &&
    tabUrl === request.url
  ) {
    matches.push({
      rule: "exact-url",
      strength: MATCH_STRENGTH["exact-url"],
    });
  }

  if (
    includesRule(rules, "normalized-url") &&
    tabNormalized === targetNormalized
  ) {
    matches.push({
      rule: "normalized-url",
      strength: MATCH_STRENGTH["normalized-url"],
    });
  }

  const weakMatchRefused =
    request.allowSensitiveWeakMatch !== true &&
    (targetSensitive || tabSensitive !== false);

  if (!weakMatchRefused && tabNormalized !== undefined) {
    if (
      includesRule(rules, "origin") &&
      normalizedOrigin(tabNormalized) === normalizedOrigin(targetNormalized)
    ) {
      matches.push({ rule: "origin", strength: MATCH_STRENGTH["origin"] });
    }

    if (
      includesRule(rules, "domain") &&
      hostnameMatchesDomain(
        normalizedHostname(tabNormalized),
        request.domain ?? normalizedHostname(targetNormalized),
      )
    ) {
      matches.push({ rule: "domain", strength: MATCH_STRENGTH["domain"] });
    }
  }

  if (!weakMatchRefused && includesRule(rules, "title")) {
    const requestedTitle = normalizedText(request.title);
    const tabTitle =
      tab.title.status === "known"
        ? normalizedText(tab.title.value)
        : undefined;

    if (requestedTitle !== undefined && tabTitle === requestedTitle) {
      matches.push({ rule: "title", strength: MATCH_STRENGTH["title"] });
    }
  }

  if (!weakMatchRefused && includesRule(rules, "query")) {
    const query = normalizedText(request.query);
    const title =
      tab.title.status === "known"
        ? normalizedText(tab.title.value)
        : undefined;
    const url = normalizedText(tabUrl);

    if (
      query !== undefined &&
      (title?.includes(query) === true || url?.includes(query) === true)
    ) {
      matches.push({ rule: "query", strength: MATCH_STRENGTH["query"] });
    }
  }

  const ordered = matches.toSorted(
    (left, right) => right.strength - left.strength,
  );
  const best = ordered[0];

  if (best !== undefined) {
    return {
      status: "matched",
      best,
      matches: ordered,
      sensitiveOrStateful: targetSensitive || tabSensitive === true,
    };
  }

  if (tabUrl === undefined && !includesRule(rules, "title")) {
    return {
      status: "not-matched",
      reason: "url-unknown",
      sensitiveOrStateful: "unknown",
    };
  }

  return {
    status: "not-matched",
    reason: weakMatchRefused
      ? "sensitive-weak-match-refused"
      : "no-rule-matched",
    sensitiveOrStateful: tabSensitive,
  };
}

export function validateMatchRequest(request: TabMatchRequest): void {
  normalizeUrl(request.url);

  const rules = request.rules ?? DEFAULT_RULES;

  if (rules.length === 0) {
    throw new TypeError("At least one tab matching rule is required.");
  }

  if (
    includesRule(rules, "title") &&
    normalizedText(request.title) === undefined
  ) {
    throw new TypeError("The title matching rule requires a non-empty title.");
  }

  if (
    includesRule(rules, "query") &&
    normalizedText(request.query) === undefined
  ) {
    throw new TypeError("The query matching rule requires a non-empty query.");
  }

  if (request.domain !== undefined) {
    normalizeDomain(request.domain);
  }
}
