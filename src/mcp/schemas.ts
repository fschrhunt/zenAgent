import { z } from "zod";

import {
  MAX_PAGE_FRAMES,
  MAX_PAGE_MEDIA,
  MAX_PAGE_MEDIA_BYTES,
  MAX_PAGE_NODES,
  MAX_PAGE_QUERY_RESULTS,
  MAX_PAGE_RESOURCE_BYTES,
  MAX_PAGE_SCREENSHOT_BYTES,
  MAX_PAGE_SCREENSHOT_DIMENSION,
  MAX_PAGE_SELECT_VALUES,
  MAX_PAGE_STRING_CHARS,
  MAX_PAGE_UPLOAD_FILES,
  PAGE_SCHEMA_VERSION,
} from "../page/model.js";
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
      "stale-frame",
      "stale-element",
      "timeout",
      "payload-too-large",
      "already-running",
      "policy-rejection",
      "lease-conflict",
      "cancelled",
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
    compatibility: z
      .object({
        browserVersion: z.string(),
        geckoVersion: z.string(),
        extensionVersion: z.string(),
      })
      .strict()
      .nullable(),
    privateWindowPolicy: z.enum(["hidden", "explicit"]),
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

export const pageInspectionResultSchema = z
  .object({
    url: z.string().max(16_384),
    title: z.string().max(1_024),
    loadState: z.enum(["loading", "interactive", "complete"]),
    visibleText: z.string().max(10_000),
    truncated: z.boolean(),
    visitedTextNodes: z.number().int().min(0).max(10_000),
  })
  .strict();

const pageStringSchema = z.string().max(MAX_PAGE_STRING_CHARS);
const pageInputStringSchema = pageStringSchema.min(1);
const pageReferenceSchema = z.string().trim().min(1).max(4_096);

export const pageSemanticStateSchema = z
  .object({
    disabled: z.boolean().nullable(),
    editable: z.boolean(),
    checked: z.boolean().nullable(),
    selected: z.boolean().nullable(),
    expanded: z.boolean().nullable(),
    pressed: z.boolean().nullable(),
    required: z.boolean().nullable(),
    readonly: z.boolean().nullable(),
    invalid: z.boolean(),
    level: z.number().int().nullable(),
    orientation: pageStringSchema.nullable(),
  })
  .strict();

export const pageSemanticNodeSchema = z
  .object({
    elementRef: pageReferenceSchema,
    frameRef: pageReferenceSchema,
    parentElementRef: pageReferenceSchema.nullable(),
    role: pageStringSchema.nullable(),
    name: z.string().max(512),
    visibleText: z.string().max(512),
    visible: z.boolean(),
    geometry: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
        viewportX: z.number().finite(),
        viewportY: z.number().finite(),
        viewportWidth: z.number().finite().nonnegative(),
        viewportHeight: z.number().finite().nonnegative(),
      })
      .strict(),
    shadowRoot: z.enum(["none", "open", "closed"]),
    backgroundUrl: z.string().url().max(MAX_PAGE_STRING_CHARS).optional(),
    state: pageSemanticStateSchema,
    actionHints: z.array(
      z.enum([
        "click",
        "fill",
        "type",
        "press",
        "select",
        "check",
        "submit",
        "upload",
        "open-background",
      ]),
    ),
  })
  .strict();

export const pageFrameSchema = z
  .object({
    frameRef: pageReferenceSchema,
    parentFrameRef: pageReferenceSchema.nullable(),
    documentId: pageReferenceSchema.nullable(),
    url: pageStringSchema,
    loadState: z.enum(["loading", "interactive", "complete", "unavailable"]),
    availability: z.enum(["available", "stale", "unsupported"]),
  })
  .strict();

export const pageSnapshotResultSchema = z
  .object({
    schemaVersion: z.literal(PAGE_SCHEMA_VERSION),
    snapshotId: pageReferenceSchema,
    documentId: pageReferenceSchema,
    tabId: tabIdSchema,
    capturedAt: z.string(),
    url: pageStringSchema,
    title: z.string().max(1_024),
    loadState: z.enum(["loading", "interactive", "complete"]),
    rootFrameRef: pageReferenceSchema,
    frames: z.array(pageFrameSchema).min(1).max(MAX_PAGE_FRAMES),
    nodes: z.array(pageSemanticNodeSchema).max(MAX_PAGE_NODES),
    truncation: z
      .object({
        frames: z.boolean(),
        nodes: z.boolean(),
        strings: z.boolean(),
        totalBytes: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const pageQueryResultSchema = z
  .object({
    nodes: z.array(pageSemanticNodeSchema).max(MAX_PAGE_QUERY_RESULTS),
    truncated: z.boolean(),
  })
  .strict();

export const pageWaitResultSchema = z
  .object({
    matched: z.literal(true),
    elapsedMs: z.number().int().nonnegative(),
    snapshot: pageSnapshotResultSchema,
  })
  .strict();

export const pageMutationResultSchema = z
  .object({
    performed: z.literal(true),
    documentId: pageReferenceSchema,
  })
  .strict();

export const pageUploadResultSchema = pageMutationResultSchema
  .extend({
    fileCount: z.number().int().min(1).max(MAX_PAGE_UPLOAD_FILES),
  })
  .strict();

export const pageScreenshotResultSchema = z
  .object({
    mimeType: z.literal("image/png"),
    width: z.number().int().min(1).max(MAX_PAGE_SCREENSHOT_DIMENSION),
    height: z.number().int().min(1).max(MAX_PAGE_SCREENSHOT_DIMENSION),
    bytes: z.number().int().min(1).max(MAX_PAGE_SCREENSHOT_BYTES),
    dataBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_PAGE_SCREENSHOT_BYTES * 4) / 3) + 4),
  })
  .strict();

const pageCaptionCueSchema = z
  .object({
    startTime: z.number().finite().nonnegative(),
    endTime: z.number().finite().nonnegative(),
    text: pageStringSchema,
  })
  .strict();

const pageCaptionTrackSchema = z
  .object({
    kind: pageStringSchema,
    label: pageStringSchema,
    language: pageStringSchema,
    mode: z.enum(["disabled", "hidden", "showing"]),
    cues: z.array(pageCaptionCueSchema).max(1_000),
    cuesAvailable: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();

const pageMediaSchema = z
  .object({
    elementRef: pageReferenceSchema,
    frameRef: pageReferenceSchema,
    kind: z.enum(["audio", "video"]),
    sourceUrl: pageStringSchema,
    duration: z.number().finite().nonnegative().nullable(),
    currentTime: z.number().finite().nonnegative(),
    paused: z.boolean(),
    muted: z.boolean(),
    volume: z.number().finite().min(0).max(1),
    readyState: z.number().int().min(0).max(4),
    drm: z.boolean(),
    captions: z.array(pageCaptionTrackSchema).max(100),
  })
  .strict();

export const pageMediaListResultSchema = z
  .object({
    media: z.array(pageMediaSchema).max(MAX_PAGE_MEDIA),
    truncated: z.boolean(),
  })
  .strict();

export const pageMediaTranscriptResultSchema = z
  .object({
    source: z.enum(["captions", "on-device-speech"]),
    locale: z.string().min(1).max(128),
    text: z.string().max(4 * 1024 * 1024),
    truncated: z.boolean(),
    mediaElementRef: pageReferenceSchema,
  })
  .strict();

export const pageDownloadResultSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    bytes: z.number().int().min(1).max(MAX_PAGE_RESOURCE_BYTES),
    mimeType: z.string().min(1).max(256),
  })
  .strict();

export const tabCleanupResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("kept"),
      tabId: tabIdSchema,
      reason: nonEmptyString,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("closed"),
      tabId: tabIdSchema,
      registrySequence: z.number().int().nonnegative().nullable(),
    })
    .strict(),
]);

export const tabLeaseSchema = z
  .object({
    leaseId: nonEmptyString,
    tabId: tabIdSchema,
    acquiredAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export const tabLeaseResultSchema = z
  .object({
    lease: tabLeaseSchema,
  })
  .strict();

export const tabLeaseReleaseResultSchema = z
  .object({
    released: z.literal(true),
    leaseId: nonEmptyString,
    tabId: tabIdSchema,
  })
  .strict();

export const emptyInputSchema = z.object({}).strict();

const leaseTtlSchema = z.number().int().min(1_000).max(300_000);
const expectedRegistrySequenceSchema = z.number().int().nonnegative();

export const pageLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("role"),
      role: z.string().min(1).max(256),
      name: pageInputStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("label"),
      label: pageInputStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: pageInputStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("placeholder"),
      placeholder: pageInputStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("css"),
      selector: pageInputStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("element"),
      elementRef: pageReferenceSchema,
    })
    .strict(),
]);

export const pageFrameTargetSchema = z
  .object({
    tabId: tabIdSchema,
    documentId: pageReferenceSchema,
    snapshotId: pageReferenceSchema,
    frameRef: pageReferenceSchema,
  })
  .strict();

export const pageElementTargetSchema = pageFrameTargetSchema.extend({
  elementRef: pageReferenceSchema,
});

const pageDocumentTargetSchema = z
  .object({
    tabId: tabIdSchema,
    documentId: pageReferenceSchema,
  })
  .strict();

export const pageSnapshotInputSchema = z
  .object({
    tabId: tabIdSchema,
    maxNodes: z.number().int().min(1).max(MAX_PAGE_NODES).optional(),
  })
  .strict();

export const pageQueryInputSchema = z
  .object({
    target: pageFrameTargetSchema,
    locator: pageLocatorSchema,
    maxResults: z.number().int().min(1).max(MAX_PAGE_QUERY_RESULTS).optional(),
  })
  .strict();

const pageWaitConditionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("load-state"),
      state: z.enum(["loading", "interactive", "complete"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("url-exact"), url: pageInputStringSchema })
    .strict(),
  z
    .object({
      kind: z.literal("url-contains"),
      value: pageInputStringSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("text-present"), text: pageInputStringSchema })
    .strict(),
  z
    .object({ kind: z.literal("text-absent"), text: pageInputStringSchema })
    .strict(),
  z
    .object({
      kind: z.literal("locator"),
      locator: pageLocatorSchema,
      state: z.enum([
        "attached",
        "detached",
        "visible",
        "hidden",
        "enabled",
        "disabled",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("document-changed"),
      fromDocumentId: pageReferenceSchema,
    })
    .strict(),
]);

export const pageWaitInputSchema = z
  .object({
    tabId: tabIdSchema,
    condition: pageWaitConditionSchema,
    timeoutMs: z.number().int().min(1).max(60_000).optional(),
    pollIntervalMs: z.number().int().min(100).max(2_000).optional(),
    maxNodes: z.number().int().min(1).max(MAX_PAGE_NODES).optional(),
  })
  .strict();

export const pageElementMutationInputSchema = z
  .object({
    target: pageElementTargetSchema,
    leaseId: pageReferenceSchema,
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const pageFillInputSchema = pageElementMutationInputSchema.extend({
  value: pageStringSchema,
});

export const pageTypeInputSchema = pageElementMutationInputSchema.extend({
  value: pageInputStringSchema,
});

export const pagePressInputSchema = pageElementMutationInputSchema.extend({
  key: z.string().min(1).max(256),
  code: z.string().min(1).max(256).optional(),
  altKey: z.boolean().optional(),
  ctrlKey: z.boolean().optional(),
  metaKey: z.boolean().optional(),
  shiftKey: z.boolean().optional(),
});

export const pageSelectInputSchema = pageElementMutationInputSchema.extend({
  values: z.array(pageStringSchema).min(1).max(MAX_PAGE_SELECT_VALUES),
});

export const pageUploadInputSchema = pageElementMutationInputSchema.extend({
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(4_096)
        .refine((path) => path.startsWith("/")),
    )
    .min(1)
    .max(MAX_PAGE_UPLOAD_FILES),
});

export const pageScreenshotInputSchema = z
  .object({
    target: z.union([pageFrameTargetSchema, pageElementTargetSchema]),
    scale: z.number().min(0.25).max(2).optional(),
    background: z
      .string()
      .refine(
        (value) =>
          value === "transparent" ||
          /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value),
      )
      .optional(),
  })
  .strict();

export const pageMediaListInputSchema = z
  .object({ target: pageFrameTargetSchema })
  .strict();

export const pageMediaTranscribeInputSchema = z
  .object({
    target: pageElementTargetSchema,
    locale: z.string().min(1).max(128),
    maxBytes: z.number().int().min(1).max(MAX_PAGE_MEDIA_BYTES).optional(),
  })
  .strict();

export const pageDownloadInputSchema = z
  .object({
    target: pageFrameTargetSchema,
    url: z.string().url(),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          value !== "." &&
          value !== ".." &&
          !value.includes("/") &&
          !value.includes("\0"),
      )
      .optional(),
    maxBytes: z.number().int().min(1).max(MAX_PAGE_RESOURCE_BYTES).optional(),
  })
  .strict();

export const pageHistoryInputSchema = z
  .object({
    target: pageDocumentTargetSchema,
    leaseId: pageReferenceSchema,
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabLeaseAcquireInputSchema = z
  .object({
    tabId: tabIdSchema,
    ttlMs: leaseTtlSchema.optional(),
    waitMs: z.number().int().min(0).max(60_000).optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabLeaseRenewInputSchema = z
  .object({
    leaseId: nonEmptyString,
    ttlMs: leaseTtlSchema.optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabLeaseReleaseInputSchema = z
  .object({
    leaseId: nonEmptyString,
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const pageInspectInputSchema = z
  .object({
    tabId: tabIdSchema,
    maxChars: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

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
    temporary: z.boolean().optional(),
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
    temporary: z.boolean().optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabsNavigateInputSchema = z
  .object({
    tabId: tabIdSchema,
    url: httpUrlSchema,
    expectedRegistrySequence: expectedRegistrySequenceSchema.optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabMutationInputSchema = z
  .object({
    tabId: tabIdSchema,
    expectedRegistrySequence: expectedRegistrySequenceSchema.optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();

export const tabCleanupInputSchema = z
  .object({
    tabId: tabIdSchema,
    action: z.enum(["keep", "close"]).optional(),
    expectedRegistrySequence: expectedRegistrySequenceSchema.optional(),
    idempotencyKey: nonEmptyString.optional(),
  })
  .strict();
