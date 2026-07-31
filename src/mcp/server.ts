import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { entityIdKey } from "../browser/model.js";
import {
  DaemonProtocolError,
  type DaemonErrorBody,
  type DaemonMethod,
} from "../daemon/protocol.js";
import {
  capabilitiesResultSchema,
  closeResultSchema,
  emptyInputSchema,
  navigateResultSchema,
  openResultSchema,
  outputEnvelope,
  pageElementMutationInputSchema,
  pageDownloadInputSchema,
  pageDownloadResultSchema,
  pageFillInputSchema,
  pageHistoryInputSchema,
  pageInspectInputSchema,
  pageInspectionResultSchema,
  pageMediaListInputSchema,
  pageMediaListResultSchema,
  pageMediaTranscriptResultSchema,
  pageMediaTranscribeInputSchema,
  pageMutationResultSchema,
  pagePressInputSchema,
  pageQueryInputSchema,
  pageQueryResultSchema,
  pageScreenshotInputSchema,
  pageScreenshotResultSchema,
  pageSelectInputSchema,
  pageSnapshotInputSchema,
  pageSnapshotResultSchema,
  pageTypeInputSchema,
  pageUploadInputSchema,
  pageUploadResultSchema,
  pageWaitInputSchema,
  pageWaitResultSchema,
  reloadResultSchema,
  resolutionResultSchema,
  spaceSchema,
  spacesResultSchema,
  statusResultSchema,
  tabLeaseAcquireInputSchema,
  tabLeaseReleaseInputSchema,
  tabLeaseReleaseResultSchema,
  tabLeaseRenewInputSchema,
  tabLeaseResultSchema,
  tabCleanupInputSchema,
  tabCleanupResultSchema,
  tabIdSchema,
  tabMutationInputSchema,
  tabsListInputSchema,
  tabsNavigateInputSchema,
  tabsOpenInputSchema,
  tabsResolveInputSchema,
  tabsResultSchema,
  tabSchema,
} from "./schemas.js";

export const MCP_SERVER_NAME = "zen-agent";
export const MCP_SERVER_TITLE = "Zen Agent";
export const MCP_SERVER_VERSION = "0.1.0";

const PAGE_MEDIA_TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 60_000 + 5_000;
const PAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface McpDaemonClient {
  request(
    method: DaemonMethod,
    params?: unknown,
    idempotencyKey?: string,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<unknown>;
  close(): void;
}

export interface ZenAgentMcpServer {
  readonly server: McpServer;
  close(): Promise<void>;
}

function daemonError(error: unknown): DaemonErrorBody {
  if (error instanceof DaemonProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED")
  ) {
    return {
      code: "browser-unavailable",
      message: "The Zen Agent daemon is not available.",
    };
  }

  return {
    code: "internal",
    message: "The Zen Agent MCP server could not complete the request.",
  };
}

function resultContent(
  structuredContent: Record<string, unknown>,
  text = JSON.stringify(structuredContent),
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent,
  };
}

async function execute(
  operation: () => Promise<Record<string, unknown>>,
  successText?: string,
): Promise<CallToolResult> {
  try {
    return resultContent({ ok: true, result: await operation() }, successText);
  } catch (error) {
    const structuredContent = {
      ok: false,
      error: daemonError(error),
    };
    return {
      ...resultContent(structuredContent),
      isError: true,
    };
  }
}

async function executeScreenshot(
  operation: () => Promise<z.infer<typeof pageScreenshotResultSchema>>,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return {
      content: [
        {
          type: "image",
          data: result.dataBase64,
          mimeType: result.mimeType,
        },
      ],
      structuredContent: { ok: true, result },
    };
  } catch (error) {
    const structuredContent = {
      ok: false,
      error: daemonError(error),
    };
    return {
      ...resultContent(structuredContent),
      isError: true,
    };
  }
}

const registryResultSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    entities: z.array(z.unknown()),
  })
  .strict();

function parseRegistryEntities(
  value: unknown,
): z.infer<typeof registryResultSchema> {
  return registryResultSchema.parse(value);
}

function sameSpace(
  tab: z.infer<typeof tabSchema>,
  requested: z.infer<typeof tabsListInputSchema>["spaceId"],
): boolean {
  return (
    requested === undefined ||
    (tab.spaceId.status === "known" &&
      tab.spaceId.value !== null &&
      entityIdKey(tab.spaceId.value) === entityIdKey(requested))
  );
}

function resolutionResult(
  value: unknown,
): z.infer<typeof resolutionResultSchema> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The daemon returned a malformed tab resolution.");
  }

  const record = value as Readonly<Record<string, unknown>>;

  if (record["status"] === "reused" || record["status"] === "opened") {
    return resolutionResultSchema.parse({
      status: record["status"],
      tabId: record["tabId"],
    });
  }

  if (record["status"] === "ambiguous") {
    const candidates = z
      .array(
        z
          .object({
            tabId: tabIdSchema,
          })
          .passthrough(),
      )
      .parse(record["candidates"]);
    return {
      status: "ambiguous",
      candidateTabIds: candidates.map(({ tabId }) => tabId),
    };
  }

  if (record["status"] === "not-found") {
    return { status: "not-found" };
  }

  throw new TypeError("The daemon returned a malformed tab resolution.");
}

function mutationKey(provided: string | undefined): string {
  return provided ?? `mcp:${randomUUID()}`;
}

/**
 * Build the MCP protocol surface over one already-connected daemon client.
 *
 * Tool handlers never reach the browser transport directly. Closing the MCP
 * connection closes only this adapter's daemon socket; it does not stop the
 * shared daemon or Zen.
 */
export function createZenAgentMcpServer(
  daemon: McpDaemonClient,
): ZenAgentMcpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      title: MCP_SERVER_TITLE,
      version: MCP_SERVER_VERSION,
    },
    {
      instructions:
        "Zen Agent operates only on explicitly identified background tabs. It never focuses Zen, selects a tab, or switches the visible Space. List current entities before mutating them; stable IDs become stale after reconnects. Do not send progress notifications while a browser workflow is running. After verification and cleanup, report exactly one terminal outcome: completed, partial, or blocked. Release every tab lease before reporting or waiting for the user. Retain result tabs and clean up only tabs explicitly created as temporary. Dialogs, native pickers, permission UI, and other foreground-only interactions are unsupported.",
    },
  );

  server.registerTool(
    "zen_status",
    {
      title: "Zen Agent status",
      description:
        "Read sanitized daemon, browser connection, registry-count, and version state. No browser or network state changes.",
      inputSchema: emptyInputSchema,
      outputSchema: outputEnvelope(statusResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      execute(async () => {
        const result = statusResultSchema.parse(await daemon.request("status"));
        return result;
      }),
  );

  server.registerTool(
    "zen_capabilities",
    {
      title: "Zen capabilities",
      description:
        "Read the background-safe capabilities reported by the connected Zen transport. No browser or network state changes.",
      inputSchema: emptyInputSchema,
      outputSchema: outputEnvelope(capabilitiesResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      execute(async () =>
        capabilitiesResultSchema.parse(await daemon.request("capabilities")),
      ),
  );

  server.registerTool(
    "zen_spaces_list",
    {
      title: "List Zen Spaces",
      description:
        "List known Spaces and stable IDs without selecting a Space, focusing Zen, or changing network state.",
      inputSchema: emptyInputSchema,
      outputSchema: outputEnvelope(spacesResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      execute(async () => {
        const raw = parseRegistryEntities(
          await daemon.request("registry.entities", { kind: "space" }),
        );
        return spacesResultSchema.parse({
          sequence: raw.sequence,
          spaces: raw.entities.map((entity) => spaceSchema.parse(entity)),
        });
      }),
  );

  server.registerTool(
    "zen_tabs_list",
    {
      title: "List Zen tabs",
      description:
        "List known tabs and stable IDs, optionally filtered to one Space. Returns known page metadata but does not select a tab, focus Zen, or change network state.",
      inputSchema: tabsListInputSchema,
      outputSchema: outputEnvelope(tabsResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ spaceId }) =>
      execute(async () => {
        const raw = parseRegistryEntities(
          await daemon.request("registry.entities", { kind: "tab" }),
        );
        const tabs = raw.entities
          .map((entity) => tabSchema.parse(entity))
          .filter((tab) => sameSpace(tab, spaceId));
        return tabsResultSchema.parse({ sequence: raw.sequence, tabs });
      }),
  );

  server.registerTool(
    "zen_page_inspect",
    {
      title: "Inspect a Zen page",
      description:
        "Read a bounded snapshot of URL, title, load state, and visible text from one explicitly identified background tab. Does not select the tab, focus Zen, switch the visible Space, or change browser or network state.",
      inputSchema: pageInspectInputSchema,
      outputSchema: outputEnvelope(pageInspectionResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (params) =>
      execute(
        async () =>
          pageInspectionResultSchema.parse(
            await daemon.request("pages.inspect", params),
          ),
        "Page inspection completed.",
      ),
  );

  server.registerTool(
    "zen_page_snapshot",
    {
      title: "Capture a semantic Zen page snapshot",
      description:
        "Read a bounded semantic snapshot from one explicitly identified background tab. Returns short-lived document, frame, snapshot, and element references without selecting the tab, focusing Zen, switching Spaces, or changing network state.",
      inputSchema: pageSnapshotInputSchema,
      outputSchema: outputEnvelope(pageSnapshotResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (params) =>
      execute(
        async () =>
          pageSnapshotResultSchema.parse(
            await daemon.request("pages.snapshot", params),
          ),
        "Semantic page snapshot captured.",
      ),
  );

  server.registerTool(
    "zen_page_screenshot",
    {
      title: "Capture a Zen page screenshot",
      description:
        "Capture a bounded PNG of one explicit background page frame or element and return it directly to the caller. Does not select the tab, focus Zen, switch Spaces, open browser UI, or change page or network state.",
      inputSchema: pageScreenshotInputSchema,
      outputSchema: outputEnvelope(pageScreenshotResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (params) =>
      executeScreenshot(async () =>
        pageScreenshotResultSchema.parse(
          await daemon.request("pages.screenshot", params),
        ),
      ),
  );

  server.registerTool(
    "zen_page_query",
    {
      title: "Query a semantic Zen page snapshot",
      description:
        "Find bounded semantic nodes in one explicit frame of a still-live page snapshot. Returns ambiguity as multiple nodes and does not select the tab, focus Zen, switch Spaces, or change network state.",
      inputSchema: pageQueryInputSchema,
      outputSchema: outputEnvelope(pageQueryResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (params) =>
      execute(
        async () =>
          pageQueryResultSchema.parse(
            await daemon.request("pages.query", params),
          ),
        "Semantic page query completed.",
      ),
  );

  server.registerTool(
    "zen_page_media_list",
    {
      title: "List media in a Zen page",
      description:
        "Read bounded audio, video, playback, DRM, and caption metadata from one explicit live background page frame. Does not change playback, select the tab, focus Zen, switch Spaces, or change network state.",
      inputSchema: pageMediaListInputSchema,
      outputSchema: outputEnvelope(pageMediaListResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (params) =>
      execute(
        async () =>
          pageMediaListResultSchema.parse(
            await daemon.request("pages.media.list", params),
          ),
        "Page media listed.",
      ),
  );

  server.registerTool(
    "zen_page_wait",
    {
      title: "Wait for a Zen page condition",
      description:
        "Poll one explicitly identified background tab with privileged parent-side timers until a bounded load-state, URL, text, locator, or document-generation condition matches. Does not select the tab, focus Zen, switch Spaces, or depend on throttled page timers.",
      inputSchema: pageWaitInputSchema,
      outputSchema: outputEnvelope(pageWaitResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (params, extra) =>
      execute(
        async () =>
          pageWaitResultSchema.parse(
            await daemon.request("pages.wait", params, undefined, {
              signal: extra.signal,
              timeoutMs: (params.timeoutMs ?? 10_000) + 5_000,
            }),
          ),
        "Page wait condition matched.",
      ),
  );

  server.registerTool(
    "zen_tab_lease_acquire",
    {
      title: "Acquire a Zen tab lease",
      description:
        "Acquire exclusive, time-bounded page-mutation ownership of one explicitly identified tab for this MCP session. May wait up to waitMs in FIFO order, but never takes over another lease or changes browser or network state.",
      inputSchema: tabLeaseAcquireInputSchema,
      outputSchema: outputEnvelope(tabLeaseResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ idempotencyKey, ...params }, extra) =>
      execute(async () =>
        tabLeaseResultSchema.parse(
          await daemon.request(
            "tabs.lease.acquire",
            params,
            mutationKey(idempotencyKey),
            {
              signal: extra.signal,
              timeoutMs: (params.waitMs ?? 0) + 5_000,
            },
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tab_lease_renew",
    {
      title: "Renew a Zen tab lease",
      description:
        "Extend one unexpired tab lease owned by this MCP session. Does not change browser or network state or take over another session's lease.",
      inputSchema: tabLeaseRenewInputSchema,
      outputSchema: outputEnvelope(tabLeaseResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        tabLeaseResultSchema.parse(
          await daemon.request(
            "tabs.lease.renew",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tab_lease_release",
    {
      title: "Release a Zen tab lease",
      description:
        "Release one tab lease owned by this MCP session. Does not change browser or network state.",
      inputSchema: tabLeaseReleaseInputSchema,
      outputSchema: outputEnvelope(tabLeaseReleaseResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        tabLeaseReleaseResultSchema.parse(
          await daemon.request(
            "tabs.lease.release",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_page_click",
    {
      title: "Click a Zen page element",
      description:
        "Click one explicit live element reference in a leased background tab. Page scripts may perform destructive actions or network requests; Zen Agent never focuses the element, selects the tab, focuses Zen, or switches Spaces.",
      inputSchema: pageElementMutationInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.click",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page element clicked.",
      ),
  );

  server.registerTool(
    "zen_page_fill",
    {
      title: "Fill a Zen page element",
      description:
        "Replace the value of one explicit editable element in a leased background tab. Page scripts may react or make network requests; the submitted value is never echoed in the result.",
      inputSchema: pageFillInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.fill",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page element filled.",
      ),
  );

  server.registerTool(
    "zen_page_type",
    {
      title: "Type into a Zen page element",
      description:
        "Append text through targeted input events on one explicit editable element in a leased background tab. Page scripts may react or make network requests; the typed value is never echoed in the result.",
      inputSchema: pageTypeInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.type",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Text typed into page element.",
      ),
  );

  server.registerTool(
    "zen_page_press",
    {
      title: "Press a key on a Zen page element",
      description:
        "Dispatch one bounded targeted key operation to an explicit element in a leased background tab without native input or focus. Page scripts may react or make network requests.",
      inputSchema: pagePressInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.press",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Key operation dispatched to page element.",
      ),
  );

  server.registerTool(
    "zen_page_select",
    {
      title: "Select Zen page options",
      description:
        "Set explicit option values on one referenced select element in a leased background tab. Page scripts may react or make network requests; selected values are never echoed in the result.",
      inputSchema: pageSelectInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.select",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page options selected.",
      ),
  );

  server.registerTool(
    "zen_page_check",
    {
      title: "Check a Zen page element",
      description:
        "Set one explicit checkbox, radio, or switch reference to checked in a leased background tab. Page scripts may react or make network requests.",
      inputSchema: pageElementMutationInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.check",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page element checked.",
      ),
  );

  server.registerTool(
    "zen_page_uncheck",
    {
      title: "Uncheck a Zen page element",
      description:
        "Set one explicit checkbox reference to unchecked in a leased background tab. Page scripts may react or make network requests.",
      inputSchema: pageElementMutationInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.uncheck",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page element unchecked.",
      ),
  );

  server.registerTool(
    "zen_page_submit",
    {
      title: "Submit a Zen page form",
      description:
        "Submit the form associated with one explicit element reference in a leased background tab. This may perform destructive actions, navigate, or make network requests; form values are never echoed in the result.",
      inputSchema: pageElementMutationInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.submit",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page form submitted.",
      ),
  );

  server.registerTool(
    "zen_page_upload",
    {
      title: "Upload files to a Zen page",
      description:
        "Assign explicitly named absolute regular-file paths to one live file input in a leased background tab without opening a native picker. Page scripts may react or make network requests; file paths are never echoed in the result.",
      inputSchema: pageUploadInputSchema,
      outputSchema: outputEnvelope(pageUploadResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageUploadResultSchema.parse(
            await daemon.request(
              "pages.upload",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Files assigned to page input.",
      ),
  );

  server.registerTool(
    "zen_page_media_transcribe",
    {
      title: "Transcribe Zen page media",
      description:
        "Transcribe one explicit live media element from bounded captions or an accessible bounded media resource using on-device speech. Does not capture system audio, change playback, select the tab, focus Zen, switch Spaces, or open browser UI.",
      inputSchema: pageMediaTranscribeInputSchema,
      outputSchema: outputEnvelope(pageMediaTranscriptResultSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (params, extra) =>
      execute(
        async () =>
          pageMediaTranscriptResultSchema.parse(
            await daemon.request(
              "pages.media.transcribe",
              params,
              mutationKey(undefined),
              {
                signal: extra.signal,
                timeoutMs: PAGE_MEDIA_TRANSCRIBE_TIMEOUT_MS,
              },
            ),
          ),
        "Page media transcribed.",
      ),
  );

  server.registerTool(
    "zen_page_download",
    {
      title: "Download a Zen page resource",
      description:
        "Fetch one bounded HTTP(S) page resource to the configured download directory without opening Firefox download UI. Writes a local file and may contact the resource URL; does not select the tab, focus Zen, or switch Spaces.",
      inputSchema: pageDownloadInputSchema,
      outputSchema: outputEnvelope(pageDownloadResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }, extra) =>
      execute(
        async () =>
          pageDownloadResultSchema.parse(
            await daemon.request(
              "pages.resource.download",
              params,
              mutationKey(idempotencyKey),
              {
                signal: extra.signal,
                timeoutMs: PAGE_DOWNLOAD_TIMEOUT_MS,
              },
            ),
          ),
        "Page resource downloaded.",
      ),
  );

  server.registerTool(
    "zen_page_back",
    {
      title: "Navigate a Zen page back",
      description:
        "Navigate one explicitly identified leased background tab back after validating its document generation. This replaces the document and may make network requests without selecting the tab, focusing Zen, or switching Spaces.",
      inputSchema: pageHistoryInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.back",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page navigated back.",
      ),
  );

  server.registerTool(
    "zen_page_forward",
    {
      title: "Navigate a Zen page forward",
      description:
        "Navigate one explicitly identified leased background tab forward after validating its document generation. This replaces the document and may make network requests without selecting the tab, focusing Zen, or switching Spaces.",
      inputSchema: pageHistoryInputSchema,
      outputSchema: outputEnvelope(pageMutationResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(
        async () =>
          pageMutationResultSchema.parse(
            await daemon.request(
              "pages.forward",
              params,
              mutationKey(idempotencyKey),
            ),
          ),
        "Page navigated forward.",
      ),
  );

  server.registerTool(
    "zen_tabs_resolve",
    {
      title: "Resolve a Zen tab",
      description:
        "Discover before acting, safely reuse a matching background tab, or open one when no safe match exists. May navigate or create a background tab and contact the supplied URL; never selects it or focuses Zen. Ambiguity is returned explicitly.",
      inputSchema: tabsResolveInputSchema,
      outputSchema: outputEnvelope(resolutionResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        resolutionResult(
          await daemon.request(
            "tabs.resolve",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tabs_open",
    {
      title: "Open a background Zen tab",
      description:
        "Always create one background tab in the explicitly identified window and Space. Contacts the supplied URL but never selects the new tab, focuses Zen, or switches the visible Space. Prefer zen_tabs_resolve when reuse is acceptable.",
      inputSchema: tabsOpenInputSchema,
      outputSchema: outputEnvelope(openResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        openResultSchema.parse(
          await daemon.request(
            "tabs.open",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tabs_navigate",
    {
      title: "Navigate a background Zen tab",
      description:
        "Replace the document in the explicitly identified stable tab and contact the supplied URL. Does not select the tab, focus Zen, or switch the visible Space.",
      inputSchema: tabsNavigateInputSchema,
      outputSchema: outputEnvelope(navigateResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        navigateResultSchema.parse(
          await daemon.request(
            "tabs.navigate",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tabs_reload",
    {
      title: "Reload a background Zen tab",
      description:
        "Reload the document in the explicitly identified stable tab, which may repeat network requests. Does not select the tab, focus Zen, or switch the visible Space.",
      inputSchema: tabMutationInputSchema,
      outputSchema: outputEnvelope(reloadResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        reloadResultSchema.parse(
          await daemon.request(
            "tabs.reload",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tabs_close",
    {
      title: "Close a Zen tab",
      description:
        "Close only the explicitly identified stable tab. This is destructive and may discard unsaved page state; it does not select another tab or focus Zen.",
      inputSchema: tabMutationInputSchema,
      outputSchema: outputEnvelope(closeResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        closeResultSchema.parse(
          await daemon.request(
            "tabs.close",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  server.registerTool(
    "zen_tabs_cleanup",
    {
      title: "Clean up a temporary Zen tab",
      description:
        "Keep by default, or explicitly close only a same-client temporary tab that Zen Agent can prove was not reused, changed, selected, or media-playing. Never closes an untracked or final result tab.",
      inputSchema: tabCleanupInputSchema,
      outputSchema: outputEnvelope(tabCleanupResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ idempotencyKey, ...params }) =>
      execute(async () =>
        tabCleanupResultSchema.parse(
          await daemon.request(
            "tabs.cleanup",
            params,
            mutationKey(idempotencyKey),
          ),
        ),
      ),
  );

  let closed = false;
  const closeDaemon = (): void => {
    if (!closed) {
      closed = true;
      daemon.close();
    }
  };
  server.server.onclose = closeDaemon;

  return {
    server,
    async close(): Promise<void> {
      try {
        await server.close();
      } finally {
        closeDaemon();
      }
    },
  };
}
