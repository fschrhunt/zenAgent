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
  reloadResultSchema,
  resolutionResultSchema,
  spaceSchema,
  spacesResultSchema,
  statusResultSchema,
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
export const MCP_SERVER_VERSION = "0.1.0";

export interface McpDaemonClient {
  request(
    method: DaemonMethod,
    params?: unknown,
    idempotencyKey?: string,
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
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
}

async function execute(
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    return resultContent({ ok: true, result: await operation() });
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
      version: MCP_SERVER_VERSION,
    },
    {
      instructions:
        "Zen Agent operates only on explicitly identified background tabs. It never focuses Zen, selects a tab, or switches the visible Space. List current entities before mutating them; stable IDs become stale after reconnects.",
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
