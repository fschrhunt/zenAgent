import { describe, expect, it } from "vitest";

import { BrowserRegistry } from "../../src/browser/registry.js";
import { encodeChunked } from "../../src/transport/chunking.js";
import {
  ZenTransport,
  type TransportConnection,
  type ZenTransportEvent,
} from "../../src/transport/client.js";
import { MessageDecoder } from "../../src/transport/framing.js";
import {
  errorResponse,
  event,
  parseMessage,
  response,
  TransportProtocolError,
  type TransportEventName,
} from "../../src/transport/protocol.js";
import { toBrowserSnapshot } from "../../src/transport/snapshot.js";
import { snapshotPayload, tabPayload } from "./fixtures.js";

type Handler = (params: unknown) => unknown;

interface FakeExtension {
  readonly connection: TransportConnection;
  emit(name: TransportEventName, payload: unknown): void;
  readonly methodsCalled: readonly string[];
}

/**
 * A stand-in for the extension across a real frame stream.
 *
 * Requests are encoded, framed, and decoded exactly as they would be over the
 * native messaging port, so this exercises the wire rather than mocking it.
 */
function fakeExtension(handlers: Record<string, Handler>): FakeExtension {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  const decoder = new MessageDecoder();
  const methodsCalled: string[] = [];

  const deliver = (value: unknown): void => {
    for (const frame of encodeChunked(value)) {
      for (const listener of dataListeners) {
        listener(frame);
      }
    }
  };

  const connection: TransportConnection = {
    send(frame) {
      for (const raw of decoder.push(frame)) {
        const message = parseMessage(raw);

        if (message.type !== "request") {
          continue;
        }

        methodsCalled.push(message.method);
        const handler = handlers[message.method];

        if (handler === undefined) {
          // Silence, not an error: this is how an extension that is wedged or
          // that never got the message behaves, which is what the timeout and
          // disconnect cases need to exercise.
          continue;
        }

        try {
          deliver(response(message.id, handler(message.params)));
        } catch (error) {
          deliver(
            errorResponse(message.id, {
              code: "internal",
              message: String(error),
            }),
          );
        }
      }
    },
    onData(listener) {
      dataListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
    close() {
      for (const listener of closeListeners) {
        listener();
      }
    },
  };

  return {
    connection,
    emit(name, payload) {
      deliver(event(name, payload));
    },
    methodsCalled,
  };
}

function describeResult(capabilities: readonly string[]): unknown {
  return {
    ...snapshotPayload().session,
    extensionVersion: "0.1.0",
    capabilities,
  };
}

const allCapabilities = snapshotPayload().session.capabilities;

function connectedTransport(handlers: Record<string, Handler> = {}): {
  transport: ZenTransport;
  extension: FakeExtension;
  events: ZenTransportEvent[];
} {
  const extension = fakeExtension({
    "session.describe": () => describeResult(allCapabilities),
    "browser.snapshot": () => snapshotPayload(),
    ...handlers,
  });
  const transport = new ZenTransport(extension.connection, {
    now: () => "2026-07-28T00:00:00.000Z",
  });
  const events: ZenTransportEvent[] = [];
  transport.on((received) => events.push(received));

  return { transport, extension, events };
}

const pageTarget = {
  tabId: "tab-1",
  documentId: "document-1",
  snapshotId: "snapshot-1",
  frameRef: "frame-1",
  elementRef: "element-1",
} as const;

function semanticNode(overrides: Record<string, unknown> = {}): unknown {
  return {
    elementRef: "element-1",
    frameRef: "frame-1",
    parentElementRef: null,
    role: "button",
    name: "Save",
    visibleText: "Save",
    visible: true,
    geometry: {
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      viewportX: 10,
      viewportY: 20,
      viewportWidth: 100,
      viewportHeight: 30,
    },
    shadowRoot: "none",
    state: {
      disabled: false,
      editable: false,
      checked: null,
      selected: null,
      expanded: null,
      pressed: null,
      required: false,
      readonly: false,
      invalid: false,
      level: null,
      orientation: null,
    },
    actionHints: ["click", "press"],
    ...overrides,
  };
}

function pageSnapshotResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    snapshotId: "snapshot-1",
    documentId: "document-1",
    tabId: "tab-1",
    capturedAt: "2026-07-29T00:00:00.000Z",
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
    nodes: [semanticNode()],
    truncation: {
      frames: false,
      nodes: false,
      strings: false,
      totalBytes: false,
    },
    ...overrides,
  };
}

describe("ZenTransport", () => {
  it("bounds configured request deadlines", () => {
    const extension = fakeExtension({});

    expect(
      () =>
        new ZenTransport(extension.connection, {
          requestTimeoutMs: 0,
        }),
    ).toThrow(/request timeout/);
    expect(
      () =>
        new ZenTransport(extension.connection, {
          requestTimeoutMs: 10 * 60_000,
        }),
    ).toThrow(/request timeout/);
  });

  it("handshakes and returns a first snapshot", async () => {
    const { transport, extension } = connectedTransport();
    const snapshot = await transport.connect();

    expect(extension.methodsCalled).toEqual([
      "session.describe",
      "browser.snapshot",
    ]);
    expect(snapshot.tabs).toHaveLength(1);
    expect(transport.capabilities).toContain("zen.tabs.enumerate-all-spaces");
    expect(transport.compatibility).toEqual({
      browserVersion: "1.21.9b",
      geckoVersion: "153.0",
      extensionVersion: "0.1.0",
    });
  });

  it("refuses to operate on a build missing a required capability", async () => {
    // The capability that decided the architecture. Without it the transport is
    // blind to whichever Space the user is not looking at, which is exactly the
    // failure ADR 0001 rejected — so it must refuse, not degrade.
    const { transport } = connectedTransport({
      "session.describe": () =>
        describeResult(["zen.spaces.enumerate", "browser.windows.private"]),
    });

    await expect(transport.connect()).rejects.toThrow(
      /zen\.tabs\.enumerate-all-spaces/,
    );
  });

  it("refuses an unproven browser build before requesting a snapshot", async () => {
    const { transport, extension } = connectedTransport({
      "session.describe": () => ({
        ...snapshotPayload().session,
        browserVersion: "1.22.0b",
        capabilities: allCapabilities,
      }),
    });

    await expect(transport.connect()).rejects.toThrow(
      /Zen 1\.22\.0b .* has not passed/,
    );
    expect(extension.methodsCalled).toEqual(["session.describe"]);
  });

  it("advances the sequence across snapshots so the registry accepts them", async () => {
    const { transport } = connectedTransport();
    const registry = new BrowserRegistry();

    registry.loadInitialSnapshot(await transport.connect());
    registry.reconcileAfterReconnect(await transport.snapshot());

    expect(registry.sequence).toBe(2);
  });

  it("turns a tab.created event into a delta the registry accepts", async () => {
    const { transport, extension, events } = connectedTransport();
    const registry = new BrowserRegistry();
    registry.loadInitialSnapshot(await transport.connect());

    extension.emit("tab.created", {
      windowId: "window-1",
      tab: tabPayload({ id: "tab-2", title: "Second" }),
    });

    const delta = events.find((received) => received.type === "delta");
    expect(delta?.type).toBe("delta");

    if (delta?.type === "delta") {
      registry.applyDelta(delta.delta);
    }

    expect(registry.entities("tab")).toHaveLength(2);
  });

  it("asks for a snapshot instead of guessing at an unplaceable event", async () => {
    const { transport, extension, events } = connectedTransport();
    await transport.connect();

    // A window the last snapshot never contained means the client's view is
    // already stale; patching it in would invent a window.
    extension.emit("tab.created", {
      windowId: "window-never-seen",
      tab: tabPayload({ id: "tab-9" }),
    });

    expect(events.at(-1)).toEqual({
      type: "invalidated",
      reason: "unusable tab.created event",
    });
  });

  it("reports a replaced session rather than reusing stale identities", async () => {
    let sessionId = "session-1";
    const { transport, events } = connectedTransport({
      "browser.snapshot": () =>
        snapshotPayload({
          session: { ...snapshotPayload().session, sessionId },
        }),
    });

    await transport.connect();
    sessionId = "session-2";
    await transport.snapshot();

    const replaced = events.find(
      (received) => received.type === "session-replaced",
    );
    expect(replaced?.type).toBe("session-replaced");

    if (replaced?.type === "session-replaced") {
      expect(replaced.previous.transportId).toBe("session-1");
      expect(replaced.current.transportId).toBe("session-2");
    }
  });

  it("stales the old session's entities after a restart", () => {
    // The registry does the staling; this proves the transport hands it what it
    // needs to, so identifiers from the previous browser run cannot be reused.
    const registry = new BrowserRegistry();
    const first = toBrowserSnapshot(snapshotPayload(), {
      sequence: 1,
      connectedAt: "2026-07-28T00:00:00.000Z",
    });
    registry.loadInitialSnapshot(first);

    const second = toBrowserSnapshot(
      snapshotPayload({
        session: { ...snapshotPayload().session, sessionId: "session-2" },
      }),
      { sequence: 2, connectedAt: "2026-07-28T00:01:00.000Z" },
    );
    registry.reconcileAfterReconnect(second);

    const staleTab = registry.lookup(first.tabs[0]!.id);
    expect(staleTab.status).toBe("stale");

    if (staleTab.status === "stale") {
      expect(staleTab.stale.reason).toBe("session-replaced");
      expect(staleTab.stale.replacementSessionId?.transportId).toBe(
        "session-2",
      );
    }
  });

  it("refuses to route a tab on a build that cannot route", async () => {
    const { transport } = connectedTransport({
      "session.describe": () =>
        describeResult(
          allCapabilities.filter(
            (capability) => capability !== "zen.spaces.route",
          ),
        ),
    });
    await transport.connect();

    await expect(
      transport.openTab({
        url: "https://example.com/",
        zenSpaceUuid: "{work}",
      }),
    ).rejects.toThrow(TransportProtocolError);
  });

  it("rejects privileged URLs before sending a browser mutation", async () => {
    const { transport, extension } = connectedTransport({
      "tabs.open": () => ({ tabId: "should-not-open" }),
      "tabs.navigate": () => ({}),
    });
    await transport.connect();
    const before = [...extension.methodsCalled];

    await expect(
      transport.openTab({ url: "file:///Users/example/private.txt" }),
    ).rejects.toThrow(/Only HTTP and HTTPS/);
    await expect(
      transport.navigateTab("tab-1", "javascript:alert(1)"),
    ).rejects.toThrow(/Only HTTP and HTTPS/);
    expect(extension.methodsCalled).toEqual(before);
  });

  it("rejects embedded URL credentials without copying them into errors", async () => {
    const { transport } = connectedTransport();
    await transport.connect();
    const secret = "https://user:top-secret@example.com/";

    try {
      await transport.navigateTab("tab-1", secret);
      throw new Error("expected navigation refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(TransportProtocolError);
      expect(String(error)).not.toContain("top-secret");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("bounds explicit transport identifiers before sending", async () => {
    const { transport, extension } = connectedTransport({
      "tabs.close": () => ({}),
    });
    await transport.connect();
    const before = [...extension.methodsCalled];

    await expect(transport.closeTab("x".repeat(5_000))).rejects.toThrow(
      /between 1 and 4096 bytes/,
    );
    expect(extension.methodsCalled).toEqual(before);
  });

  it("surfaces a structured error from the extension", async () => {
    const extension = fakeExtension({
      "session.describe": () => describeResult(allCapabilities),
      "browser.snapshot": () => snapshotPayload(),
      "tabs.close": () => {
        throw new Error("gone");
      },
    });
    const transport = new ZenTransport(extension.connection);
    await transport.connect();

    await expect(transport.closeTab("tab-1")).rejects.toThrow(
      TransportProtocolError,
    );
  });

  it("reloads only the tab named by stable identifier", async () => {
    let reloaded: unknown;
    const { transport, extension } = connectedTransport({
      "tabs.reload": (params) => {
        reloaded = params;
        return {};
      },
    });
    await transport.connect();

    await transport.reloadTab("tab-1");

    expect(reloaded).toEqual({ tabId: "tab-1" });
    expect(extension.methodsCalled.at(-1)).toBe("tabs.reload");
  });

  it("inspects bounded page content only through an explicit tab ID", async () => {
    let inspected: unknown;
    const { transport, extension } = connectedTransport({
      "pages.inspect": (params) => {
        inspected = params;
        return {
          url: "https://example.com/",
          title: "Example",
          loadState: "complete",
          visibleText: "bounded text",
          truncated: false,
          visitedTextNodes: 2,
        };
      },
    });
    await transport.connect();

    await expect(
      transport.inspectPage("tab-1", { maxChars: 64 }),
    ).resolves.toMatchObject({
      visibleText: "bounded text",
      visitedTextNodes: 2,
    });
    expect(inspected).toEqual({ tabId: "tab-1", maxChars: 64 });
    expect(extension.methodsCalled.at(-1)).toBe("pages.inspect");
  });

  it("rejects invalid or oversized page inspection results", async () => {
    const { transport } = connectedTransport({
      "pages.inspect": () => ({
        url: "https://example.com/",
        title: "Example",
        loadState: "complete",
        visibleText: "too long",
        truncated: true,
        visitedTextNodes: 1,
      }),
    });
    await transport.connect();

    await expect(
      transport.inspectPage("tab-1", { maxChars: 4 }),
    ).rejects.toThrow(/invalid or unbounded/);
    await expect(
      transport.inspectPage("tab-1", { maxChars: 10_001 }),
    ).rejects.toThrow(/1 through 10000/);
  });

  it("captures and validates a bounded semantic page snapshot", async () => {
    let requested: unknown;
    const { transport } = connectedTransport({
      "pages.snapshot": (params) => {
        requested = params;
        return pageSnapshotResult({
          nodes: [
            semanticNode({
              actionHints: ["open-background", "press"],
              backgroundUrl: "https://example.com/new",
            }),
          ],
        });
      },
    });
    await transport.connect();

    const page = await transport.snapshotPage("tab-1", { maxNodes: 50 });

    expect(requested).toEqual({ tabId: "tab-1", maxNodes: 50 });
    expect(page.rootFrameRef).toBe("frame-1");
    expect(page.nodes[0]).toMatchObject({
      role: "button",
      name: "Save",
      actionHints: ["open-background", "press"],
      backgroundUrl: "https://example.com/new",
    });
  });

  it("rejects snapshots that exceed the requested semantic-node bound", async () => {
    const { transport } = connectedTransport({
      "pages.snapshot": () =>
        pageSnapshotResult({
          nodes: [semanticNode(), semanticNode({ elementRef: "element-2" })],
        }),
    });
    await transport.connect();

    await expect(
      transport.snapshotPage("tab-1", { maxNodes: 1 }),
    ).rejects.toThrow(/invalid or unbounded page snapshot/);
    await expect(
      transport.snapshotPage("tab-1", { maxNodes: 5_001 }),
    ).rejects.toThrow(/1 through 5000/);
  });

  it("queries a live snapshot frame and validates returned frame identity", async () => {
    let requested: unknown;
    const { transport } = connectedTransport({
      "pages.query": (params) => {
        requested = params;
        return { nodes: [semanticNode()], truncated: false };
      },
    });
    await transport.connect();

    const result = await transport.queryPage(pageTarget, {
      locator: { kind: "role", role: "button", name: "Save" },
      maxResults: 5,
    });

    expect(requested).toEqual({
      target: {
        tabId: "tab-1",
        documentId: "document-1",
        snapshotId: "snapshot-1",
        frameRef: "frame-1",
      },
      locator: { kind: "role", role: "button", name: "Save" },
      maxResults: 5,
    });
    expect(result.nodes).toHaveLength(1);
  });

  it("refuses unbounded locators before page content is queried", async () => {
    const { transport, extension } = connectedTransport({
      "pages.query": () => ({ nodes: [], truncated: false }),
    });
    await transport.connect();
    const before = [...extension.methodsCalled];

    await expect(
      transport.queryPage(pageTarget, {
        locator: { kind: "text", text: "x".repeat(65_537) },
      }),
    ).rejects.toThrow(/locator text/);
    expect(extension.methodsCalled).toEqual(before);
  });

  it("sends every targeted page mutation with complete reference scope", async () => {
    const calls: unknown[] = [];
    const mutation = (params: unknown): unknown => {
      calls.push(params);
      return { performed: true, documentId: "document-1" };
    };
    const { transport, extension } = connectedTransport({
      "pages.click": mutation,
      "pages.fill": mutation,
      "pages.type": mutation,
      "pages.press": mutation,
      "pages.select": mutation,
      "pages.check": mutation,
      "pages.uncheck": mutation,
      "pages.submit": mutation,
      "pages.back": mutation,
      "pages.forward": mutation,
    });
    await transport.connect();

    await transport.clickPage(pageTarget);
    await transport.fillPage(pageTarget, "");
    await transport.typePage(pageTarget, " appended");
    await transport.pressPage(pageTarget, { key: "Enter" });
    await transport.selectPage(pageTarget, ["one"]);
    await transport.checkPage(pageTarget);
    await transport.uncheckPage(pageTarget);
    await transport.submitPage(pageTarget);
    await transport.backPage(pageTarget);
    await transport.forwardPage(pageTarget);

    expect(extension.methodsCalled.slice(-10)).toEqual([
      "pages.click",
      "pages.fill",
      "pages.type",
      "pages.press",
      "pages.select",
      "pages.check",
      "pages.uncheck",
      "pages.submit",
      "pages.back",
      "pages.forward",
    ]);
    expect(calls[0]).toEqual({ target: pageTarget });
    expect(calls[1]).toEqual({
      target: pageTarget,
      value: "",
    });
    expect(calls.at(-1)).toEqual({
      target: {
        tabId: "tab-1",
        documentId: "document-1",
      },
    });
  });

  it("assigns only explicit absolute staged upload paths", async () => {
    let requested: unknown;
    const { transport, extension } = connectedTransport({
      "pages.upload": (params) => {
        requested = params;
        return {
          performed: true,
          documentId: "document-1",
          fileCount: 1,
        };
      },
    });
    await transport.connect();

    await expect(
      transport.uploadPage(pageTarget, ["/private/tmp/zen-stage/report.pdf"]),
    ).resolves.toEqual({
      performed: true,
      documentId: "document-1",
      fileCount: 1,
    });
    expect(requested).toEqual({
      target: pageTarget,
      paths: ["/private/tmp/zen-stage/report.pdf"],
    });
    const before = [...extension.methodsCalled];
    await expect(
      transport.uploadPage(pageTarget, ["relative.pdf"]),
    ).rejects.toThrow(/absolute staged paths/);
    expect(extension.methodsCalled).toEqual(before);
  });

  it("validates bounded media metadata, captions, and non-DRM bytes", async () => {
    const bytes = Buffer.from("speech");
    const { transport } = connectedTransport({
      "pages.media.list": () => ({
        media: [
          {
            elementRef: "media-1",
            frameRef: "frame-1",
            kind: "audio",
            sourceUrl: "https://example.com/speech.wav",
            duration: 1.5,
            currentTime: 0,
            paused: true,
            muted: false,
            volume: 1,
            readyState: 4,
            drm: false,
            captions: [
              {
                kind: "captions",
                label: "English",
                language: "en",
                mode: "showing",
                cues: [{ startTime: 0, endTime: 1, text: "Hello" }],
                cuesAvailable: true,
                truncated: false,
              },
            ],
          },
        ],
        truncated: false,
      }),
      "pages.media.fetch": () => ({
        mimeType: "audio/wav",
        bytes: bytes.byteLength,
        dataBase64: bytes.toString("base64"),
      }),
    });
    await transport.connect();

    const listed = await transport.listPageMedia(pageTarget);
    expect(listed.media[0]).toMatchObject({
      elementRef: "media-1",
      drm: false,
      captions: [{ cues: [{ text: "Hello" }] }],
    });
    await expect(
      transport.fetchPageMedia(
        { ...pageTarget, elementRef: "media-1" },
        { maxBytes: 32 * 1024 * 1024 },
      ),
    ).resolves.toMatchObject({
      mimeType: "audio/wav",
      bytes: 6,
    });
  });

  it("validates resource bytes and background PNG screenshots", async () => {
    const resource = Buffer.from("download");
    const png = Buffer.from([137, 80, 78, 71]);
    const { transport } = connectedTransport({
      "pages.resource.fetch": () => ({
        mimeType: "application/octet-stream",
        bytes: resource.byteLength,
        dataBase64: resource.toString("base64"),
      }),
      "pages.screenshot": () => ({
        mimeType: "image/png",
        width: 640,
        height: 480,
        bytes: png.byteLength,
        dataBase64: png.toString("base64"),
      }),
    });
    await transport.connect();

    await expect(
      transport.fetchPageResource(pageTarget, "/download", { maxBytes: 64 }),
    ).resolves.toMatchObject({ bytes: 8 });
    await expect(
      transport.screenshotPage(pageTarget, {
        scale: 1,
        background: "#ffffff",
      }),
    ).resolves.toMatchObject({
      mimeType: "image/png",
      width: 640,
      height: 480,
    });
  });

  it("requires each granular page capability before sending", async () => {
    const { transport, extension } = connectedTransport({
      "session.describe": () =>
        describeResult(
          allCapabilities.filter(
            (capability) => capability !== "browser.pages.fill",
          ),
        ),
      "pages.fill": () => ({ performed: true, documentId: "document-1" }),
    });
    await transport.connect();
    const before = [...extension.methodsCalled];

    await expect(transport.fillPage(pageTarget, "secret")).rejects.toThrow(
      /browser\.pages\.fill/,
    );
    expect(extension.methodsCalled).toEqual(before);
  });

  it("recognizes stale page reference errors from the extension", () => {
    expect(
      parseMessage(
        errorResponse("unused", {
          code: "stale-document",
          message: "The document reference is stale.",
        }),
      ),
    ).toMatchObject({
      type: "error",
      error: { code: "stale-document" },
    });
  });

  it("times out a request the extension never answers", async () => {
    const extension = fakeExtension({
      "session.describe": () => describeResult(allCapabilities),
    });
    const transport = new ZenTransport(extension.connection, {
      requestTimeoutMs: 10,
    });

    await expect(transport.connect()).rejects.toThrow(/did not answer/);
  });

  it("fails in-flight requests when the browser disconnects", async () => {
    const extension = fakeExtension({});
    const transport = new ZenTransport(extension.connection, {
      requestTimeoutMs: 1000,
    });
    const pending = transport.connect();

    extension.connection.close();

    await expect(pending).rejects.toThrow(/closed/);
  });
});
