import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DaemonProtocolError,
  type DaemonMethod,
} from "../../src/daemon/protocol.js";
import {
  createZenAgentMcpServer,
  MCP_SERVER_NAME,
  MCP_SERVER_TITLE,
  MCP_SERVER_VERSION,
  type McpDaemonClient,
  type ZenAgentMcpServer,
} from "../../src/mcp/server.js";
import { browserFixture } from "../browser/fixtures.js";

interface DaemonCall {
  readonly method: DaemonMethod;
  readonly params: unknown;
  readonly idempotencyKey: string | undefined;
  readonly options?: Readonly<{
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }>;
}

class FakeDaemonClient implements McpDaemonClient {
  public readonly calls: DaemonCall[] = [];
  public closed = false;
  public failure: Error | undefined;
  public readonly stalledMethods = new Set<DaemonMethod>();
  readonly #fixture = browserFixture();

  public request(
    method: DaemonMethod,
    params?: unknown,
    idempotencyKey?: string,
    options?: Readonly<{
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    }>,
  ): Promise<unknown> {
    this.calls.push({
      method,
      params,
      idempotencyKey,
      ...(options === undefined ? {} : { options }),
    });

    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    if (this.stalledMethods.has(method)) {
      return new Promise((_, reject) => {
        const cancel = (): void => {
          reject(
            new DaemonProtocolError(
              "cancelled",
              "The daemon operation was cancelled.",
            ),
          );
        };

        if (options?.signal?.aborted === true) {
          cancel();
        } else {
          options?.signal?.addEventListener("abort", cancel, { once: true });
        }
      });
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
          compatibility: {
            browserVersion: "1.21.9b",
            geckoVersion: "153.0",
            operatingSystem: "Darwin",
            operatingSystemVersion: "27.0.0",
            xpcomAbi: "aarch64-gcc3",
            extensionVersion: "0.1.0",
          },
          privateWindowPolicy: "hidden",
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
      case "pages.inspect":
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          loadState: "complete",
          visibleText: "Example page",
          truncated: false,
          visitedTextNodes: 1,
        });
      case "pages.snapshot":
        return Promise.resolve({
          schemaVersion: 1,
          snapshotId: "snapshot-1",
          documentId: "document-1",
          tabId: this.#fixture.tab.id,
          capturedAt: "2026-07-29T20:00:00.000Z",
          url: "https://example.com/",
          title: "Example",
          loadState: "complete",
          rootFrameRef: "frame-1",
          frames: [
            {
              frameRef: "frame-1",
              parentFrameRef: null,
              documentId: "document-1",
              url: "https://example.com/",
              loadState: "complete",
              availability: "available",
            },
          ],
          nodes: [this.#pageNode],
          truncation: {
            frames: false,
            nodes: false,
            strings: false,
            totalBytes: false,
          },
        });
      case "pages.query":
        return Promise.resolve({
          nodes: [this.#pageNode],
          truncated: false,
        });
      case "pages.screenshot":
        return Promise.resolve({
          mimeType: "image/png",
          width: 2,
          height: 1,
          bytes: 8,
          dataBase64: "iVBORw0KGgo=",
        });
      case "pages.media.list":
        return Promise.resolve({
          media: [
            {
              elementRef: "media-1",
              frameRef: "frame-1",
              kind: "video",
              sourceUrl: "https://example.com/video.mp4",
              duration: 120,
              currentTime: 12,
              paused: true,
              muted: false,
              volume: 1,
              readyState: 4,
              drm: false,
              captions: [],
            },
          ],
          truncated: false,
        });
      case "pages.wait":
        return Promise.resolve({
          matched: true,
          elapsedMs: 25,
          snapshot: {
            schemaVersion: 1,
            snapshotId: "snapshot-wait",
            documentId: "document-wait",
            tabId: this.#fixture.tab.id,
            capturedAt: "2026-07-29T20:00:00.000Z",
            url: "https://example.com/",
            title: "Example",
            loadState: "complete",
            rootFrameRef: "frame-wait",
            frames: [
              {
                frameRef: "frame-wait",
                parentFrameRef: null,
                documentId: "document-wait",
                url: "https://example.com/",
                loadState: "complete",
                availability: "available",
              },
            ],
            nodes: [this.#pageNode],
            truncation: {
              frames: false,
              nodes: false,
              strings: false,
              totalBytes: false,
            },
          },
        });
      case "pages.click":
      case "pages.fill":
      case "pages.type":
      case "pages.press":
      case "pages.select":
      case "pages.check":
      case "pages.uncheck":
      case "pages.submit":
      case "pages.back":
      case "pages.forward":
        return Promise.resolve({
          performed: true,
          documentId: "document-1",
        });
      case "pages.upload":
        return Promise.resolve({
          performed: true,
          documentId: "document-1",
          fileCount: 1,
        });
      case "pages.media.transcribe":
        return Promise.resolve({
          source: "captions",
          locale: "en-US",
          text: "Example transcript",
          truncated: false,
          mediaElementRef: "media-1",
        });
      case "pages.resource.download":
        return Promise.resolve({
          path: "/tmp/zen-agent-downloads/example.pdf",
          bytes: 1_024,
          mimeType: "application/pdf",
        });
      case "tabs.lease.acquire":
      case "tabs.lease.renew":
        return Promise.resolve({
          lease: {
            leaseId: "lease-1",
            tabId: this.#fixture.tab.id,
            acquiredAt: 1_753_814_400_000,
            expiresAt: 1_753_814_430_000,
          },
        });
      case "tabs.lease.release":
        return Promise.resolve({
          released: true,
          leaseId: "lease-1",
          tabId: this.#fixture.tab.id,
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
      case "tabs.cleanup":
        return Promise.resolve({
          outcome: "kept",
          tabId: this.#fixture.tab.id,
          reason: "explicit-keep",
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

  get #pageNode() {
    return {
      elementRef: "element-1",
      frameRef: "frame-1",
      parentElementRef: null,
      role: "button",
      name: "Continue",
      visibleText: "Continue",
      visible: true,
      geometry: {
        x: 10,
        y: 20,
        width: 100,
        height: 30,
        viewportX: 0,
        viewportY: 0,
        viewportWidth: 1_280,
        viewportHeight: 720,
      },
      shadowRoot: "none",
      state: {
        disabled: false,
        editable: false,
        checked: null,
        selected: null,
        expanded: null,
        pressed: null,
        required: null,
        readonly: null,
        invalid: false,
        level: null,
        orientation: null,
      },
      actionHints: ["click", "press"],
    };
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
      title: MCP_SERVER_TITLE,
      version: MCP_SERVER_VERSION,
    });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(client.getInstructions()).toContain(
      "report exactly one terminal outcome: completed, partial, or blocked",
    );
    expect(client.getInstructions()).toContain(
      "Release every tab lease before reporting",
    );
    expect(client.getInstructions()).toContain(
      "Do not send progress notifications",
    );
    expect(client.getInstructions()).toContain(
      "Dialogs, native pickers, permission UI",
    );
  });

  it("lists the complete annotated tool surface with strict object schemas", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name)).toEqual([
      "zen_status",
      "zen_capabilities",
      "zen_spaces_list",
      "zen_tabs_list",
      "zen_page_inspect",
      "zen_page_snapshot",
      "zen_page_screenshot",
      "zen_page_query",
      "zen_page_media_list",
      "zen_page_wait",
      "zen_tab_lease_acquire",
      "zen_tab_lease_renew",
      "zen_tab_lease_release",
      "zen_page_click",
      "zen_page_fill",
      "zen_page_type",
      "zen_page_press",
      "zen_page_select",
      "zen_page_check",
      "zen_page_uncheck",
      "zen_page_submit",
      "zen_page_upload",
      "zen_page_media_transcribe",
      "zen_page_download",
      "zen_page_back",
      "zen_page_forward",
      "zen_tabs_resolve",
      "zen_tabs_open",
      "zen_tabs_navigate",
      "zen_tabs_reload",
      "zen_tabs_close",
      "zen_tabs_cleanup",
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

  it("advertises exact lease and page-operation side effects", async () => {
    const { client } = await harness();
    const byName = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    const expectAnnotations = (
      names: readonly string[],
      annotations: Readonly<{
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
      }>,
    ): void => {
      for (const name of names) {
        expect(byName.get(name)?.annotations).toEqual(annotations);
      }
    };

    expectAnnotations(
      [
        "zen_page_inspect",
        "zen_page_snapshot",
        "zen_page_screenshot",
        "zen_page_query",
        "zen_page_media_list",
        "zen_page_wait",
      ],
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    );
    expectAnnotations(
      ["zen_tab_lease_acquire", "zen_tab_lease_renew", "zen_tab_lease_release"],
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    );
    expectAnnotations(
      [
        "zen_page_fill",
        "zen_page_type",
        "zen_page_press",
        "zen_page_select",
        "zen_page_check",
        "zen_page_uncheck",
        "zen_page_upload",
        "zen_page_download",
      ],
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    );
    expectAnnotations(["zen_page_media_transcribe"], {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expectAnnotations(
      [
        "zen_page_click",
        "zen_page_submit",
        "zen_page_back",
        "zen_page_forward",
      ],
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    );
    expectAnnotations(["zen_tabs_cleanup"], {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("describes the new background-only tools without advertising dialogs", async () => {
    const { client } = await harness();
    const tools = (await client.listTools()).tools;
    const descriptions = new Map(
      tools.map(({ name, description }) => [name, description]),
    );

    expect(descriptions.get("zen_page_screenshot")).toBe(
      "Capture a bounded PNG of one explicit background page frame or element and return it directly to the caller. Does not select the tab, focus Zen, switch Spaces, open browser UI, or change page or network state.",
    );
    expect(descriptions.get("zen_page_upload")).toBe(
      "Assign explicitly named absolute regular-file paths to one live file input in a leased background tab without opening a native picker. Page scripts may react or make network requests; file paths are never echoed in the result.",
    );
    expect(descriptions.get("zen_page_media_list")).toBe(
      "Read bounded audio, video, playback, DRM, and caption metadata from one explicit live background page frame. Does not change playback, select the tab, focus Zen, switch Spaces, or change network state.",
    );
    expect(descriptions.get("zen_page_media_transcribe")).toBe(
      "Transcribe one explicit live media element from bounded captions or an accessible bounded media resource using on-device speech. Does not capture system audio, change playback, select the tab, focus Zen, switch Spaces, or open browser UI.",
    );
    expect(descriptions.get("zen_page_download")).toBe(
      "Fetch one bounded HTTP(S) page resource to the configured download directory without opening Firefox download UI. Writes a local file and may contact the resource URL; does not select the tab, focus Zen, or switch Spaces.",
    );
    expect(descriptions.get("zen_tabs_cleanup")).toBe(
      "Keep by default, or explicitly close only a same-client temporary tab that Zen Agent can prove was not reused, changed, selected, or media-playing. Never closes an untracked or final result tab.",
    );
    expect(descriptions.get("zen_tab_lease_acquire")).toBe(
      "Acquire exclusive, time-bounded page-mutation ownership of one explicitly identified tab for this MCP session. May wait up to waitMs in FIFO order, but never takes over another lease or changes browser or network state.",
    );
    expect(tools.some(({ name }) => name.includes("dialog"))).toBe(false);
  });

  it("routes reads and every tab operation through daemon methods", async () => {
    const { client, daemon } = await harness();
    const { fixture } = daemon;
    const frameTarget = {
      tabId: fixture.tab.id,
      documentId: "document-1",
      snapshotId: "snapshot-1",
      frameRef: "frame-1",
    };
    const elementTarget = {
      ...frameTarget,
      elementRef: "element-1",
    };
    const documentTarget = {
      tabId: fixture.tab.id,
      documentId: "document-1",
    };
    const calls = [
      ["zen_status", {}],
      ["zen_capabilities", {}],
      ["zen_spaces_list", {}],
      ["zen_tabs_list", { spaceId: fixture.space.id }],
      ["zen_page_inspect", { tabId: fixture.tab.id, maxChars: 256 }],
      ["zen_page_snapshot", { tabId: fixture.tab.id, maxNodes: 100 }],
      [
        "zen_page_screenshot",
        { target: frameTarget, scale: 1, background: "transparent" },
      ],
      [
        "zen_page_query",
        {
          target: frameTarget,
          locator: { kind: "role", role: "button", name: "Continue" },
          maxResults: 10,
        },
      ],
      ["zen_page_media_list", { target: frameTarget }],
      [
        "zen_page_wait",
        {
          tabId: fixture.tab.id,
          condition: { kind: "load-state", state: "complete" },
          timeoutMs: 1_000,
          pollIntervalMs: 100,
        },
      ],
      [
        "zen_tab_lease_acquire",
        {
          tabId: fixture.tab.id,
          ttlMs: 30_000,
          waitMs: 5_000,
          idempotencyKey: "lease-acquire-test",
        },
      ],
      [
        "zen_tab_lease_renew",
        {
          leaseId: "lease-1",
          ttlMs: 60_000,
          idempotencyKey: "lease-renew-test",
        },
      ],
      [
        "zen_tab_lease_release",
        {
          leaseId: "lease-1",
          idempotencyKey: "lease-release-test",
        },
      ],
      [
        "zen_page_click",
        {
          target: elementTarget,
          leaseId: "lease-1",
          idempotencyKey: "page-click-test",
        },
      ],
      [
        "zen_page_fill",
        {
          target: elementTarget,
          leaseId: "lease-1",
          value: "",
          idempotencyKey: "page-fill-test",
        },
      ],
      [
        "zen_page_type",
        {
          target: elementTarget,
          leaseId: "lease-1",
          value: "hello",
          idempotencyKey: "page-type-test",
        },
      ],
      [
        "zen_page_press",
        {
          target: elementTarget,
          leaseId: "lease-1",
          key: "Enter",
          code: "Enter",
          shiftKey: true,
          idempotencyKey: "page-press-test",
        },
      ],
      [
        "zen_page_select",
        {
          target: elementTarget,
          leaseId: "lease-1",
          values: ["", "second"],
          idempotencyKey: "page-select-test",
        },
      ],
      [
        "zen_page_check",
        {
          target: elementTarget,
          leaseId: "lease-1",
          idempotencyKey: "page-check-test",
        },
      ],
      [
        "zen_page_uncheck",
        {
          target: elementTarget,
          leaseId: "lease-1",
          idempotencyKey: "page-uncheck-test",
        },
      ],
      [
        "zen_page_submit",
        {
          target: elementTarget,
          leaseId: "lease-1",
          idempotencyKey: "page-submit-test",
        },
      ],
      [
        "zen_page_upload",
        {
          target: elementTarget,
          leaseId: "lease-1",
          paths: ["/tmp/example.txt"],
          idempotencyKey: "page-upload-test",
        },
      ],
      [
        "zen_page_media_transcribe",
        {
          target: { ...elementTarget, elementRef: "media-1" },
          locale: "en-US",
        },
      ],
      [
        "zen_page_download",
        {
          target: frameTarget,
          url: "https://example.com/example.pdf",
          fileName: "example.pdf",
          idempotencyKey: "page-download-test",
        },
      ],
      [
        "zen_page_back",
        {
          target: documentTarget,
          leaseId: "lease-1",
          idempotencyKey: "page-back-test",
        },
      ],
      [
        "zen_page_forward",
        {
          target: documentTarget,
          leaseId: "lease-1",
          idempotencyKey: "page-forward-test",
        },
      ],
      [
        "zen_tabs_resolve",
        {
          url: "https://example.com/",
          spaceId: fixture.space.id,
          temporary: true,
          idempotencyKey: "resolve-test",
        },
      ],
      [
        "zen_tabs_open",
        {
          url: "https://example.com/new",
          windowId: fixture.window.id,
          spaceId: fixture.space.id,
          temporary: true,
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
      [
        "zen_tabs_cleanup",
        {
          tabId: fixture.tab.id,
          action: "keep",
          idempotencyKey: "cleanup-test",
        },
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
      "pages.inspect",
      "pages.snapshot",
      "pages.screenshot",
      "pages.query",
      "pages.media.list",
      "pages.wait",
      "tabs.lease.acquire",
      "tabs.lease.renew",
      "tabs.lease.release",
      "pages.click",
      "pages.fill",
      "pages.type",
      "pages.press",
      "pages.select",
      "pages.check",
      "pages.uncheck",
      "pages.submit",
      "pages.upload",
      "pages.media.transcribe",
      "pages.resource.download",
      "pages.back",
      "pages.forward",
      "tabs.resolve",
      "tabs.open",
      "tabs.navigate",
      "tabs.reload",
      "tabs.close",
      "tabs.cleanup",
    ]);
    expect(
      daemon.calls.find(({ method }) => method === "tabs.lease.acquire"),
    ).toMatchObject({
      params: {
        tabId: fixture.tab.id,
        ttlMs: 30_000,
        waitMs: 5_000,
      },
      idempotencyKey: "lease-acquire-test",
      options: { timeoutMs: 10_000 },
    });
    expect(
      daemon.calls.find(({ method }) => method === "pages.upload"),
    ).toMatchObject({
      idempotencyKey: "page-upload-test",
    });
    expect(
      daemon.calls.find(({ method }) => method === "tabs.resolve"),
    ).toMatchObject({
      params: {
        url: "https://example.com/",
        spaceId: fixture.space.id,
        temporary: true,
      },
      idempotencyKey: "resolve-test",
    });
    expect(
      daemon.calls.find(({ method }) => method === "tabs.open"),
    ).toMatchObject({
      params: {
        url: "https://example.com/new",
        windowId: fixture.window.id,
        spaceId: fixture.space.id,
        temporary: true,
      },
      idempotencyKey: "open-test",
    });
    expect(
      daemon.calls.find(({ method }) => method === "tabs.cleanup"),
    ).toMatchObject({
      params: { tabId: fixture.tab.id, action: "keep" },
      idempotencyKey: "cleanup-test",
    });
    expect(
      daemon.calls.find(({ method }) => method === "pages.media.transcribe")
        ?.idempotencyKey,
    ).toMatch(/^mcp:/u);
    expect(
      daemon.calls.find(({ method }) => method === "pages.resource.download"),
    ).toMatchObject({
      params: {
        target: frameTarget,
        url: "https://example.com/example.pdf",
        fileName: "example.pdf",
      },
      idempotencyKey: "page-download-test",
    });
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

  it("returns a structured bounded page inspection", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_page_inspect",
      arguments: { tabId: daemon.fixture.tab.id, maxChars: 256 },
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toEqual({
      ok: true,
      result: {
        url: "https://example.com/",
        title: "Example",
        loadState: "complete",
        visibleText: "Example page",
        truncated: false,
        visitedTextNodes: 1,
      },
    });
    expect(firstTextContent(result)).toBe("Page inspection completed.");
    expect(daemon.calls).toEqual([
      {
        method: "pages.inspect",
        params: { tabId: daemon.fixture.tab.id, maxChars: 256 },
        idempotencyKey: undefined,
      },
    ]);
  });

  it("rejects malformed page inspection input before calling the daemon", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_page_inspect",
      arguments: {
        tabId: daemon.fixture.tab.id,
        maxChars: 10_001,
        unexpected: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(firstTextContent(result)).toContain("Input validation error");
    expect(daemon.calls).toEqual([]);
  });

  it("returns semantic page content only as structured output", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_page_snapshot",
      arguments: { tabId: daemon.fixture.tab.id, maxNodes: 100 },
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      ok: true,
      result: {
        schemaVersion: 1,
        tabId: daemon.fixture.tab.id,
        snapshotId: "snapshot-1",
        documentId: "document-1",
        nodes: [{ elementRef: "element-1", name: "Continue" }],
      },
    });
    expect(firstTextContent(result)).toBe("Semantic page snapshot captured.");
    expect(firstTextContent(result)).not.toContain("Continue");
  });

  it("returns screenshots as MCP image content and structured output", async () => {
    const { client, daemon } = await harness();
    const target = {
      tabId: daemon.fixture.tab.id,
      documentId: "document-1",
      snapshotId: "snapshot-1",
      frameRef: "frame-1",
    };
    const result = await client.callTool({
      name: "zen_page_screenshot",
      arguments: { target },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      },
    ]);
    expect(structured(result)).toEqual({
      ok: true,
      result: {
        mimeType: "image/png",
        width: 2,
        height: 1,
        bytes: 8,
        dataBase64: "iVBORw0KGgo=",
      },
    });
  });

  it("forwards cancellation and bounded timeouts for long page operations", async () => {
    const { client, daemon } = await harness();
    const frameTarget = {
      tabId: daemon.fixture.tab.id,
      documentId: "document-1",
      snapshotId: "snapshot-1",
      frameRef: "frame-1",
    };
    const cases = [
      {
        tool: "zen_page_media_transcribe",
        method: "pages.media.transcribe" as const,
        arguments: {
          target: { ...frameTarget, elementRef: "media-1" },
          locale: "en-US",
        },
        timeoutMs: 2 * 60 * 60_000 + 5_000,
      },
      {
        tool: "zen_page_download",
        method: "pages.resource.download" as const,
        arguments: {
          target: frameTarget,
          url: "https://example.com/example.pdf",
        },
        timeoutMs: 60_000,
      },
    ] as const;

    for (const testCase of cases) {
      daemon.stalledMethods.add(testCase.method);
      const controller = new AbortController();
      const pending = client.callTool(
        { name: testCase.tool, arguments: testCase.arguments },
        undefined,
        { signal: controller.signal, timeout: 10_000 },
      );

      await vi.waitFor(() => {
        expect(
          daemon.calls.some(({ method }) => method === testCase.method),
        ).toBe(true);
      });
      const call = daemon.calls.find(
        ({ method }) => method === testCase.method,
      );
      const forwardedSignal = call?.options?.signal;

      expect(call?.options?.timeoutMs).toBe(testCase.timeoutMs);
      expect(forwardedSignal?.aborted).toBe(false);

      controller.abort();
      await expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => {
        expect(forwardedSignal?.aborted).toBe(true);
      });
      daemon.stalledMethods.delete(testCase.method);
    }
  });

  it("routes page mutations with nested targets and retry keys outside params", async () => {
    const { client, daemon } = await harness();
    const target = {
      tabId: daemon.fixture.tab.id,
      documentId: "document-1",
      snapshotId: "snapshot-1",
      frameRef: "frame-1",
      elementRef: "element-1",
    };
    const result = await client.callTool({
      name: "zen_page_fill",
      arguments: {
        target,
        leaseId: "lease-1",
        value: "",
        idempotencyKey: "fill-retry",
      },
    });

    expect(structured(result)).toEqual({
      ok: true,
      result: { performed: true, documentId: "document-1" },
    });
    expect(daemon.calls).toEqual([
      {
        method: "pages.fill",
        params: { target, leaseId: "lease-1", value: "" },
        idempotencyKey: "fill-retry",
      },
    ]);
  });

  it("forwards optimistic registry versions for tab mutations", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_tabs_navigate",
      arguments: {
        tabId: daemon.fixture.tab.id,
        url: "https://example.com/next",
        expectedRegistrySequence: 7,
        idempotencyKey: "versioned-navigate",
      },
    });

    expect(structured(result)).toMatchObject({ ok: true });
    expect(daemon.calls).toEqual([
      {
        method: "tabs.navigate",
        params: {
          tabId: daemon.fixture.tab.id,
          url: "https://example.com/next",
          expectedRegistrySequence: 7,
        },
        idempotencyKey: "versioned-navigate",
      },
    ]);
  });

  it("rejects malformed optimistic registry versions before calling the daemon", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_tabs_close",
      arguments: {
        tabId: daemon.fixture.tab.id,
        expectedRegistrySequence: -1,
      },
    });

    expect(result.isError).toBe(true);
    expect(firstTextContent(result)).toContain("Input validation error");
    expect(daemon.calls).toEqual([]);
  });

  it("rejects malformed semantic page input before calling the daemon", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_page_query",
      arguments: {
        target: {
          tabId: daemon.fixture.tab.id,
          documentId: "document-1",
          snapshotId: "snapshot-1",
          frameRef: "frame-1",
          unexpected: true,
        },
        locator: { kind: "role", role: "" },
      },
    });

    expect(result.isError).toBe(true);
    expect(firstTextContent(result)).toContain("Input validation error");
    expect(daemon.calls).toEqual([]);
  });

  it("rejects malformed tab lease input before calling the daemon", async () => {
    const { client, daemon } = await harness();
    const result = await client.callTool({
      name: "zen_tab_lease_acquire",
      arguments: {
        tabId: daemon.fixture.tab.id,
        ttlMs: 999,
      },
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

  it("returns page inspection daemon failures as stable structured errors", async () => {
    const { client, daemon } = await harness();
    daemon.failure = new DaemonProtocolError(
      "unsupported-capability",
      "The connected Zen transport cannot inspect pages.",
      { capability: "browser.pages.inspect" },
    );
    const result = await client.callTool({
      name: "zen_page_inspect",
      arguments: { tabId: daemon.fixture.tab.id },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      ok: false,
      error: {
        code: "unsupported-capability",
        message: "The connected Zen transport cannot inspect pages.",
        data: { capability: "browser.pages.inspect" },
      },
    });
  });

  it("returns tab lease conflicts as stable structured errors", async () => {
    const { client, daemon } = await harness();
    daemon.failure = new DaemonProtocolError(
      "lease-conflict",
      "The tab is leased by another daemon client.",
      { reason: "owned-by-another-client" },
    );
    const result = await client.callTool({
      name: "zen_tab_lease_acquire",
      arguments: { tabId: daemon.fixture.tab.id },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      ok: false,
      error: {
        code: "lease-conflict",
        message: "The tab is leased by another daemon client.",
        data: { reason: "owned-by-another-client" },
      },
    });
  });

  it("returns stale page references as stable structured errors", async () => {
    const { client, daemon } = await harness();
    daemon.failure = new DaemonProtocolError(
      "stale-element",
      "That page element reference is stale.",
    );
    const result = await client.callTool({
      name: "zen_page_click",
      arguments: {
        target: {
          tabId: daemon.fixture.tab.id,
          documentId: "document-1",
          snapshotId: "snapshot-1",
          frameRef: "frame-1",
          elementRef: "element-1",
        },
        leaseId: "lease-1",
      },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      ok: false,
      error: {
        code: "stale-element",
        message: "That page element reference is stale.",
      },
    });
  });

  it("closes its daemon client when the MCP connection shuts down", async () => {
    const { client, daemon } = await harness();

    await client.close();

    expect(daemon.closed).toBe(true);
  });
});
