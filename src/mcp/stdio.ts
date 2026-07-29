import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadOptionalConfig } from "../config/path.js";
import { DaemonClient } from "../daemon/client.js";
import { discoverDaemonSocket } from "../daemon/paths.js";
import { DaemonProtocolError } from "../daemon/protocol.js";
import {
  createZenAgentMcpServer,
  type McpDaemonClient,
  type ZenAgentMcpServer,
} from "./server.js";

export interface McpStdioOptions {
  readonly profileId?: string;
  readonly createDaemonClient?: (socketPath: string) => DaemonClient;
}

function unavailableDaemonError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED")
  ) {
    return new DaemonProtocolError(
      "browser-unavailable",
      "The Zen Agent daemon is not available.",
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

export async function startMcpStdio(
  options: McpStdioOptions = {},
): Promise<ZenAgentMcpServer> {
  const config =
    options.profileId === undefined ? await loadOptionalConfig() : undefined;
  const socketPath = await discoverDaemonSocket(
    options.profileId ?? config?.profile,
  );
  const daemon =
    options.createDaemonClient?.(socketPath) ??
    new DaemonClient({
      socketPath,
      clientId: `mcp:${String(process.pid)}`,
    });

  try {
    await daemon.connect();
  } catch (error) {
    daemon.close();
    throw unavailableDaemonError(error);
  }

  const adapter = createZenAgentMcpServer(daemon satisfies McpDaemonClient);
  const transport = new StdioServerTransport();
  const closeOnInputEnd = (): void => {
    void adapter.close();
  };
  process.stdin.once("end", closeOnInputEnd);
  transport.onclose = () => {
    process.stdin.off("end", closeOnInputEnd);
    daemon.close();
  };

  try {
    await adapter.server.connect(transport);
    return adapter;
  } catch (error) {
    process.stdin.off("end", closeOnInputEnd);
    await adapter.close();
    throw error;
  }
}
