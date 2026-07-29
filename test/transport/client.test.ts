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

describe("ZenTransport", () => {
  it("handshakes and returns a first snapshot", async () => {
    const { transport, extension } = connectedTransport();
    const snapshot = await transport.connect();

    expect(extension.methodsCalled).toEqual([
      "session.describe",
      "browser.snapshot",
    ]);
    expect(snapshot.tabs).toHaveLength(1);
    expect(transport.capabilities).toContain("zen.tabs.enumerate-all-spaces");
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
