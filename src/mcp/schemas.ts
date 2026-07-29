import { z } from "zod";

import { TRANSPORT_CAPABILITIES } from "../transport/capabilities.js";

const nonEmptyString = z.string().trim().min(1);

export const profileIdSchema = z
  .object({
    kind: z.literal("profile"),
    transportId: nonEmptyString,
  })
  .strict();

export const sessionIdSchema = z
  .object({
    kind: z.literal("session"),
    profileId: profileIdSchema,
    transportId: nonEmptyString,
  })
  .strict();

export const windowIdSchema = z
  .object({
    kind: z.literal("window"),
    sessionId: sessionIdSchema,
    transportId: nonEmptyString,
  })
  .strict();

export const spaceIdSchema = z
  .object({
    kind: z.literal("space"),
    sessionId: sessionIdSchema,
    transportId: nonEmptyString,
  })
  .strict();

export const tabIdSchema = z
  .object({
    kind: z.literal("tab"),
    sessionId: sessionIdSchema,
    transportId: nonEmptyString,
  })
  .strict();

const browsingContextIdSchema = z
  .object({
    kind: z.literal("browsing-context"),
    sessionId: sessionIdSchema,
    transportId: nonEmptyString,
  })
  .strict();

function observationSchema<Value extends z.ZodType>(
  value: Value,
): z.ZodUnion<
  readonly [
    z.ZodObject<{
      status: z.ZodLiteral<"known">;
      value: Value;
    }>,
    z.ZodObject<{
      status: z.ZodLiteral<"unknown">;
      reason: z.ZodEnum<{
        "not-reported": "not-reported";
        "not-loaded": "not-loaded";
        "permission-denied": "permission-denied";
        "temporarily-unavailable": "temporarily-unavailable";
      }>;
    }>,
    z.ZodObject<{
      status: z.ZodLiteral<"unsupported">;
      capability: z.ZodString;
    }>,
  ]
> {
  return z.union([
    z.object({ status: z.literal("known"), value }).strict(),
    z
      .object({
        status: z.literal("unknown"),
        reason: z.enum([
          "not-reported",
          "not-loaded",
          "permission-denied",
          "temporarily-unavailable",
        ]),
      })
      .strict(),
    z
      .object({
        status: z.literal("unsupported"),
        capability: nonEmptyString,
      })
      .strict(),
  ]);
}

export const spaceSchema = z
  .object({
    kind: z.literal("space"),
    id: spaceIdSchema,
    windowId: windowIdSchema,
    name: observationSchema(z.string()),
    order: observationSchema(z.number().int()),
    containerId: observationSchema(z.string().nullable()),
  })
  .strict();

export const tabSchema = z
  .object({
    kind: z.literal("tab"),
    id: tabIdSchema,
    windowId: windowIdSchema,
    spaceId: observationSchema(spaceIdSchema.nullable()),
    browsingContextId: observationSchema(browsingContextIdSchema.nullable()),
    url: observationSchema(z.string()),
    title: observationSchema(z.string()),
    loadState: observationSchema(
      z.enum(["unloaded", "loading", "interactive", "complete"]),
    ),
    selected: observationSchema(z.boolean()),
    mediaState: observationSchema(
      z.enum(["none", "playing", "paused", "picture-in-picture"]),
    ),
    containerId: observationSchema(z.string().nullable()),
    private: observationSchema(z.boolean()),
    lifecycleState: z.enum(["open", "discarded", "crashed"]),
  })
  .strict();

export const daemonErrorSchema = z
  .object({
    code: z.enum([
      "protocol-version-mismatch",
      "invalid-request",
      "method-not-found",
      "browser-unavailable",
      "unsupported-capability",
      "stale-id",
      "stale-document",
      "timeout",
      "payload-too-large",
      "already-running",
      "policy-rejection",
      "internal",
    ]),
    message: z.string(),
    data: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();

export function outputEnvelope<Result extends z.ZodType>(result: Result) {
  return z
    .object({
      ok: z.boolean(),
      result: result.optional(),
      error: daemonErrorSchema.optional(),
    })
    .strict()
    .refine(
      ({ ok, result: value, error }) =>
        ok ? value !== undefined && error === undefined : error !== undefined,
      "A tool result must contain exactly one success result or daemon error.",
    );
}

export const statusResultSchema = z
  .object({
    state: z.enum([
      "starting",
      "connected",
      "reconnecting",
      "unavailable",
      "stopping",
      "stopped",
    ]),
    daemonVersion: z.string(),
    protocolVersion: z.number().int().nonnegative(),
    profileId: z.string().nullable(),
    sessionId: z.string().nullable(),
    registrySequence: z.number().int().nonnegative().nullable(),
    capabilities: z.array(z.enum(TRANSPORT_CAPABILITIES)),
    counts: z
      .object({
        profiles: z.number().int().nonnegative(),
        sessions: z.number().int().nonnegative(),
        windows: z.number().int().nonnegative(),
        spaces: z.number().int().nonnegative(),
        tabs: z.number().int().nonnegative(),
      })
      .strict(),
    reconnectAttempts: z.number().int().nonnegative(),
  })
  .strict();

export const capabilitiesResultSchema = z
  .object({
    browserConnected: z.boolean(),
    capabilities: z.array(z.enum(TRANSPORT_CAPABILITIES)),
  })
  .strict();

export const spacesResultSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    spaces: z.array(spaceSchema),
  })
  .strict();

export const tabsResultSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    tabs: z.array(tabSchema),
  })
  .strict();

export const resolutionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.enum(["reused", "opened"]),
      tabId: tabIdSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("ambiguous"),
      candidateTabIds: z.array(tabIdSchema),
    })
    .strict(),
  z.object({ status: z.literal("not-found") }).strict(),
]);

export const openResultSchema = z
  .object({
    outcome: z.literal("opened"),
    tabId: tabIdSchema.nullable(),
    registrySequence: z.number().int().nonnegative().nullable(),
  })
  .strict();

function tabMutationResultSchema<
  Outcome extends "navigated" | "reloaded" | "closed",
>(outcome: Outcome) {
  return z
    .object({
      outcome: z.literal(outcome),
      tabId: tabIdSchema,
      registrySequence: z.number().int().nonnegative().nullable(),
    })
    .strict();
}

export const navigateResultSchema = tabMutationResultSchema("navigated");
export const reloadResultSchema = tabMutationResultSchema("reloaded");
export const closeResultSchema = tabMutationResultSchema("closed");

export const emptyInputSchema = z.object({}).strict();

export const tabsListInputSchema = z
  .object({
    spaceId: spaceIdSchema.optional(),
  })
  .strict();

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Tab URLs must use the HTTP or HTTPS scheme.");

export const tabsResolveInputSchema = z
  .object({
    url: httpUrlSchema.optional(),
    query: nonEmptyString.optional(),
    spaceId: spaceIdSchema.optional(),
    space: nonEmptyString.optional(),
    taskContext: nonEmptyString.optional(),
    rules: z
      .array(
        z.enum([
          "exact-url",
          "normalized-url",
          "origin",
          "domain",
          "title",
          "query",
        ]),
      )
      .min(1)
      .optional(),
    title: nonEmptyString.optional(),
    domain: nonEmptyString.optional(),
    allowSensitiveWeakMatch: z.boolean().optional(),
    allowCrossSpaceReuse: z.boolean().optional(),
    navigateReusedTab: z.boolean().optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict()
  .refine(
    ({ url, query }) => url !== undefined || query !== undefined,
    "Either url or query is required.",
  )
  .refine(
    ({ spaceId, space }) => spaceId === undefined || space === undefined,
    "Supply spaceId or space, not both.",
  );

export const tabsOpenInputSchema = z
  .object({
    url: httpUrlSchema,
    windowId: windowIdSchema,
    spaceId: spaceIdSchema,
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabsNavigateInputSchema = z
  .object({
    tabId: tabIdSchema,
    url: httpUrlSchema,
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabMutationInputSchema = z
  .object({
    tabId: tabIdSchema,
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();
