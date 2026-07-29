import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  DaemonProtocolError,
  type DaemonMethod,
} from "../../src/daemon/protocol.js";
import {
  createZenAgentMcpServer,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type McpDaemonClient,
  type ZenAgentMcpServer,
} from "../../src/mcp/server.js";
import { browserFixture } from "../browser/fixtures.js";

interface DaemonCall {
  readonly method: DaemonMethod;
  readonly params: unknown;
  readonly idempotencyKey: string | undefined;
}

class FakeDaemonClient implements McpDaemonClient {
  public readonly calls: DaemonCall[] = [];
  public closed = false;
  public failure: Error | undefined;
  readonly #fixture = browserFixture();

  public request(
    method: DaemonMethod,
    params?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    this.calls.push({ method, params, idempotencyKey });

    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    switch (method) {
      case "status":
        return Promise.resolve({
          state: "connected",
          daemonVersion: "0.1.0",
          protocolVersion: 1,
          profileId: this.#fixture.profile.id.transportId,
          sessionId: this.#fixture.session.id.transportId,
          registrySequence: this.#fixture.snapshot.sequence,
          capabilities: ["zen.spaces.enumerate"],
          counts: {
            profiles: 1,
            sessions: 1,
            windows: 1,
            spaces: 1,
            tabs: 1,
          },
          reconnectAttempts: 0,
        });
      case "capabilities":
        return Promise.resolve({
          browserConnected: true,
          capabilities: ["zen.spaces.enumerate"],
        });
      case "registry.entities":
        return Promise.resolve({
          sequence: this.#fixture.snapshot.sequence,
          entities:
            typeof params === "object" &&
            params !== null &&
            "kind" in params &&
            params.kind === "space"
              ? [this.#fixture.space]
              : [this.#fixture.tab],
        });
      case "tabs.resolve":
        return Promise.resolve({
          status: "reused",
          tabId: this.#fixture.tab.id,
          explanation: {},
        });
      case "tabs.open":
        return Promise.resolve({
          outcome: "opened",
          tabId: this.#fixture.tab.id,
          registrySequence: 2,
        });
      case "tabs.navigate":
        return Promise.resolve({
          outcome: "navigated",
          tabId: this.#fixture.tab.id,
          registrySequence: 2,
        });
      case "tabs.reload":
        return Promise.resolve({
          outcome: "reloaded",
          tabId: this.#fixture.tab.id,
          registrySequence: 2,
        });
      case "tabs.close":
        return Promise.resolve({
          outcome: "closed",
          tabId: this.#fixture.tab.id,
          registrySequence: 2,
        });
      default:
        return Promise.reject(
          new DaemonProtocolError(
            "method-not-found",
            `Unexpected fake method ${method}.`,
          ),
        );
    }
  }

  public close(): void {
    this.closed = true;
  }

  public get fixture() {
    return this.#fixture;
  }
}

interface Harness {
  readonly client: Client;
  readonly daemon: FakeDaemonClient;
  readonly adapter: ZenAgentMcpServer;
}

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const daemon = new FakeDaemonClient();
  const adapter = createZenAgentMcpServer(daemon);
  const client = new Client({ name: "zen-agent-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    adapter.server.connect(serverTransport),
  ]);
  const value = { client, daemon, adapter };
  harnesses.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async ({ client, adapter }) => {
      await client.close();
      await adapter.close();
    }),
  );
});

function structured(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return "structuredContent" in result ? result.structuredContent : undefined;
}

function firstTextContent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    return undefined;
  }

  const { content } = value;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const first: unknown = content[0];

  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    return undefined;
  }

  return first.text;
}

describe("Zen Agent MCP server", () => {
  it("completes MCP initialization and advertises its identity", async () => {
    const { client } = await harness();

    expect(client.getServerVersion()).toEqual({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  it("lists the complete annotated tool surface with strict object schemas", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name)).toEqual([
      "zen_status",
      "zen_capabilities",
      "zen_spaces_list",
      "zen_tabs_list",
      "zen_tabs_resolve",
      "zen_tabs_open",
      "zen_tabs_navigate",
      "zen_tabs_reload",
      "zen_tabs_close",
    ]);

    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
    }
  });

  it("routes reads and every tab operation through daemon methods", async () => {
    const { client, daemon } = await harness();
    const { fixture } = daemon;
    const calls = [
      ["zen_status", {}],
      ["zen_capabilities", {}],
      ["zen_spaces_list", {}],
      ["zen_tabs_list", { spaceId: fixture.space.id }],
      [
        "zen_tabs_resolve",
        {
          url: "https://example.com/",
          spaceId: fixture.space.id,
          idempotencyKey: "resolve-test",
        },
      ],
      [
        "zen_tabs_open",
        {
          url: "https://example.com/new",
          windowId: fixture.window.id,
          spaceId: fixture.space.id,
          idempotencyKey: "open-test",
        },
      ],
      [
        "zen_tabs_navigate",
        {
          tabId: fixture.tab.id,
          url: "https://example.com/next",
          idempotencyKey: "navigate-test",
        },
      ],
      [
        "zen_tabs_reload",
        { tabId: fixture.tab.id, idempotencyKey: "reload-test" },
      ],
      [
        "zen_tabs_close",
        { tabId: fixture.tab.id, idempotencyKey: "close-test" },
      ],
    ] as const;

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toMatchObject({ ok: true });
    }

    expect(daemon.calls.map(({ method }) => method)).toEqual([
      "status",
      "capabilities",
      "registry.entities",
      "registry.entities",
      "tabs.resolve",
      "tabs.open",
      "tabs.navigate",
      "tabs.reload",
      "tabs.close",
    ]);
    expect(
      daemon.calls.slice(4).map(({ idempotencyKey }) => idempotencyKey),
    ).toEqual([
      "resolve-test",
      "open-test",
      "navigate-test",
      "reload-test",
      "close-test",
    ]);
  });

  it("rejects malformed tool input before calling the daemon", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_status",
      arguments: { unexpected: true },
    });

    expect(result.isError).toBe(true);
    expect(firstTextContent(result)).toContain("Input validation error");
    expect(daemon.calls).toEqual([]);
  });

  it("requires an explicit Space for the always-create tool", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_tabs_open",
      arguments: {
        url: "https://example.com/new",
        windowId: daemon.fixture.window.id,
      },
    });

    expect(result.isError).toBe(true);
    expect(firstTextContent(result)).toContain("Input validation error");
    expect(daemon.calls).toEqual([]);
  });

  it("returns daemon failures as stable structured errors", async () => {
    const { client, daemon } = await harness();
    daemon.failure = new DaemonProtocolError(
      "stale-id",
      "The stable tab ID is no longer active.",
      { reason: "closed" },
    );
    const result = await client.callTool({
      name: "zen_tabs_reload",
      arguments: { tabId: daemon.fixture.tab.id },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      ok: false,
      error: {
        code: "stale-id",
        message: "The stable tab ID is no longer active.",
        data: { reason: "closed" },
      },
    });
  });

  it("closes its daemon client when the MCP connection shuts down", async () => {
    const { client, daemon } = await harness();

    await client.close();

    expect(daemon.closed).toBe(true);
  });
});
