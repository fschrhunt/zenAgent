import type {
  DomainRoutingRule,
  RoutingRule,
  SpaceMappings,
  ZenAgentConfig,
} from "../config/schema.js";

export type ExplicitSpaceOverride =
  | Readonly<{ kind: "space-id"; spaceId: string }>
  | Readonly<{ kind: "name"; name: string }>;

export interface RouteRequest {
  readonly url?: string;
  readonly override?: ExplicitSpaceOverride;
  readonly taskContext?: string;
}

export type RouteSource =
  | "explicit-space-id"
  | "explicit-space-name"
  | "url-rule"
  | "task-context"
  | "safe-default";

export interface RoutingExplanationStep {
  readonly stage:
    "explicit-override" | "url-rules" | "task-context" | "safe-default";
  readonly outcome: "selected" | "not-provided" | "no-match" | "superseded";
  readonly detail: string;
  readonly ruleIds?: readonly string[];
}

export interface ResolvedRoute {
  readonly status: "resolved";
  readonly profileId: string;
  readonly spaceId: string;
  readonly spaceName?: string;
  readonly source: RouteSource;
  readonly matchedRuleIds: readonly string[];
  readonly explanation: readonly RoutingExplanationStep[];
}

export interface AmbiguousRouteCandidate {
  readonly spaceId: string;
  readonly spaceNames: readonly string[];
  readonly ruleIds: readonly string[];
}

export interface AmbiguousRoute {
  readonly status: "ambiguous";
  readonly code: "conflicting-rules";
  readonly profileId: string;
  readonly message: string;
  readonly candidates: readonly AmbiguousRouteCandidate[];
  readonly explanation: readonly RoutingExplanationStep[];
}

export interface UnresolvedRoute {
  readonly status: "unresolved";
  readonly code:
    "invalid-url" | "invalid-override" | "unknown-space-name" | "no-route";
  readonly profileId: string;
  readonly message: string;
  readonly explanation: readonly RoutingExplanationStep[];
}

export type RouteDecision = ResolvedRoute | AmbiguousRoute | UnresolvedRoute;

interface RuleMatch {
  readonly rule: RoutingRule;
  readonly specificity: number;
  readonly spaceId: string;
}

function spaceIdForName(
  spaces: SpaceMappings,
  name: string,
): string | undefined {
  if (name === "personal") {
    return spaces.personal;
  }
  if (name === "work") {
    return spaces.work;
  }
  return Object.hasOwn(spaces.aliases, name) ? spaces.aliases[name] : undefined;
}

function domainMatches(rule: DomainRoutingRule, hostname: string): boolean {
  return (
    hostname === rule.domain ||
    (rule.includeSubdomains && hostname.endsWith(`.${rule.domain}`))
  );
}

function matchRule(
  rule: RoutingRule,
  url: URL,
  spaces: SpaceMappings,
): RuleMatch | undefined {
  const spaceId = spaceIdForName(spaces, rule.space);
  if (spaceId === undefined) {
    return undefined;
  }

  if (rule.kind === "domain") {
    if (!domainMatches(rule, url.hostname.toLowerCase())) {
      return undefined;
    }
    return {
      rule,
      // A more deeply nested domain wins over its parent domain.
      specificity:
        1_000_000 + rule.domain.split(".").length * 1_000 + rule.domain.length,
      spaceId,
    };
  }

  const configuredUrl = new URL(rule.url);
  if (
    url.origin !== configuredUrl.origin ||
    (rule.match === "exact" && url.href !== configuredUrl.href) ||
    (rule.match === "prefix" && !url.href.startsWith(configuredUrl.href))
  ) {
    return undefined;
  }
  return {
    rule,
    // Exact URL > longest URL prefix > most-specific domain.
    specificity:
      (rule.match === "exact" ? 3_000_000 : 2_000_000) + rule.url.length,
    spaceId,
  };
}

function supersededStep(
  stage: RoutingExplanationStep["stage"],
  detail: string,
): RoutingExplanationStep {
  return { stage, outcome: "superseded", detail };
}

function lowerPrecedenceSteps(
  after: "explicit-override" | "url-rules" | "task-context" | "safe-default",
): readonly RoutingExplanationStep[] {
  const stages: readonly RoutingExplanationStep["stage"][] = [
    "explicit-override",
    "url-rules",
    "task-context",
    "safe-default",
  ];
  const start = stages.indexOf(after) + 1;
  return stages
    .slice(start)
    .map((stage) =>
      supersededStep(
        stage,
        "A higher-precedence routing input selected a Space.",
      ),
    );
}

function resolved(
  config: ZenAgentConfig,
  spaceId: string,
  spaceName: string | undefined,
  source: RouteSource,
  matchedRuleIds: readonly string[],
  explanation: readonly RoutingExplanationStep[],
): ResolvedRoute {
  return {
    status: "resolved",
    profileId: config.profile,
    spaceId,
    ...(spaceName === undefined ? {} : { spaceName }),
    source,
    matchedRuleIds,
    explanation,
  };
}

function routeExplicitOverride(
  config: ZenAgentConfig,
  override: ExplicitSpaceOverride,
): RouteDecision {
  if (override.kind === "space-id") {
    if (override.spaceId.trim().length === 0) {
      return {
        status: "unresolved",
        code: "invalid-override",
        profileId: config.profile,
        message: "An explicit stable Space ID must not be empty.",
        explanation: [
          {
            stage: "explicit-override",
            outcome: "selected",
            detail: "The explicit stable Space ID was invalid.",
          },
        ],
      };
    }
    return resolved(
      config,
      override.spaceId,
      undefined,
      "explicit-space-id",
      [],
      [
        {
          stage: "explicit-override",
          outcome: "selected",
          detail: "Used the caller's explicit stable Space ID.",
        },
        ...lowerPrecedenceSteps("explicit-override"),
      ],
    );
  }

  const spaceId = spaceIdForName(config.spaces, override.name);
  if (spaceId === undefined) {
    return {
      status: "unresolved",
      code: "unknown-space-name",
      profileId: config.profile,
      message: `Explicit Space name '${override.name}' is not mapped in configuration.`,
      explanation: [
        {
          stage: "explicit-override",
          outcome: "selected",
          detail: `The explicit Space name '${override.name}' has no stable ID mapping.`,
        },
      ],
    };
  }

  return resolved(
    config,
    spaceId,
    override.name,
    "explicit-space-name",
    [],
    [
      {
        stage: "explicit-override",
        outcome: "selected",
        detail: `Used the caller's explicit '${override.name}' Space mapping.`,
      },
      ...lowerPrecedenceSteps("explicit-override"),
    ],
  );
}

function routeRules(
  config: ZenAgentConfig,
  url: URL,
  explanation: RoutingExplanationStep[],
): ResolvedRoute | AmbiguousRoute | undefined {
  const matches = config.routing.rules
    .map((rule) => matchRule(rule, url, config.spaces))
    .filter((match) => match !== undefined);
  if (matches.length === 0) {
    explanation.push({
      stage: "url-rules",
      outcome: "no-match",
      detail: "No configured URL or domain rule matched.",
    });
    return undefined;
  }

  const highestSpecificity = Math.max(
    ...matches.map((match) => match.specificity),
  );
  const bestMatches = matches.filter(
    (match) => match.specificity === highestSpecificity,
  );
  const bySpace = new Map<string, { names: Set<string>; ruleIds: string[] }>();
  for (const match of bestMatches) {
    const candidate = bySpace.get(match.spaceId) ?? {
      names: new Set<string>(),
      ruleIds: [],
    };
    candidate.names.add(match.rule.space);
    candidate.ruleIds.push(match.rule.id);
    bySpace.set(match.spaceId, candidate);
  }

  if (bySpace.size > 1) {
    const ruleIds = bestMatches.map((match) => match.rule.id).sort();
    return {
      status: "ambiguous",
      code: "conflicting-rules",
      profileId: config.profile,
      message: `Equally specific routing rules conflict: ${ruleIds.join(", ")}.`,
      candidates: [...bySpace.entries()]
        .map(([spaceId, candidate]) => ({
          spaceId,
          spaceNames: [...candidate.names].sort(),
          ruleIds: candidate.ruleIds.sort(),
        }))
        .sort((left, right) => left.spaceId.localeCompare(right.spaceId)),
      explanation: [
        ...explanation,
        {
          stage: "url-rules",
          outcome: "selected",
          detail:
            "Multiple equally specific rules mapped the URL to different Spaces; no Space was chosen.",
          ruleIds,
        },
      ],
    };
  }

  const firstMatch = bestMatches[0];
  if (firstMatch === undefined) {
    return undefined;
  }
  const matchingRuleIds = bestMatches.map((match) => match.rule.id).sort();
  return resolved(
    config,
    firstMatch.spaceId,
    firstMatch.rule.space,
    "url-rule",
    matchingRuleIds,
    [
      ...explanation,
      {
        stage: "url-rules",
        outcome: "selected",
        detail: `The highest-specificity configured rule selected '${firstMatch.rule.space}'.`,
        ruleIds: matchingRuleIds,
      },
      ...lowerPrecedenceSteps("url-rules"),
    ],
  );
}

/**
 * Resolves routing policy without reading browser state or causing side
 * effects. Its result doubles as machine-readable dry-run/explain output.
 */
export function routeSpace(
  config: ZenAgentConfig,
  request: RouteRequest,
): RouteDecision {
  if (request.override !== undefined) {
    return routeExplicitOverride(config, request.override);
  }

  const explanation: RoutingExplanationStep[] = [
    {
      stage: "explicit-override",
      outcome: "not-provided",
      detail: "No explicit Space override was provided.",
    },
  ];

  if (request.url !== undefined) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return {
        status: "unresolved",
        code: "invalid-url",
        profileId: config.profile,
        message:
          "Cannot evaluate routing rules because the provided URL is not a valid absolute URL.",
        explanation,
      };
    }
    const ruleDecision = routeRules(config, url, explanation);
    if (ruleDecision !== undefined) {
      return ruleDecision;
    }
  } else {
    explanation.push({
      stage: "url-rules",
      outcome: "not-provided",
      detail:
        "No URL was provided, so URL and domain rules were not evaluated.",
    });
  }

  if (request.taskContext !== undefined) {
    const spaceId = spaceIdForName(config.spaces, request.taskContext);
    if (spaceId === undefined) {
      return {
        status: "unresolved",
        code: "unknown-space-name",
        profileId: config.profile,
        message: `Task-context Space '${request.taskContext}' is not mapped in configuration.`,
        explanation: [
          ...explanation,
          {
            stage: "task-context",
            outcome: "selected",
            detail: `The task-context hint '${request.taskContext}' has no stable ID mapping.`,
          },
        ],
      };
    }
    return resolved(
      config,
      spaceId,
      request.taskContext,
      "task-context",
      [],
      [
        ...explanation,
        {
          stage: "task-context",
          outcome: "selected",
          detail: `Used the '${request.taskContext}' task-context mapping.`,
        },
        ...lowerPrecedenceSteps("task-context"),
      ],
    );
  }
  explanation.push({
    stage: "task-context",
    outcome: "not-provided",
    detail: "No task-context Space hint was provided.",
  });

  const safeDefault = config.routing.safeDefault;
  if (safeDefault !== undefined) {
    const spaceId = spaceIdForName(config.spaces, safeDefault);
    if (spaceId !== undefined) {
      return resolved(
        config,
        spaceId,
        safeDefault,
        "safe-default",
        [],
        [
          ...explanation,
          {
            stage: "safe-default",
            outcome: "selected",
            detail: `Used the configured safe default '${safeDefault}'.`,
          },
        ],
      );
    }
  }

  return {
    status: "unresolved",
    code: "no-route",
    profileId: config.profile,
    message:
      "No explicit override, configured rule, task-context hint, or safe default selected a Space.",
    explanation: [
      ...explanation,
      {
        stage: "safe-default",
        outcome: "not-provided",
        detail:
          "No safe default is configured. Routing remains unresolved instead of guessing.",
      },
    ],
  };
}
