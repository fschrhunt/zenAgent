/**
 * The bridge between the privileged `zenAgent` API and the native host.
 *
 * This event page exists mainly to hold the native messaging port open. A port
 * is the only supported way to keep a Firefox MV3 event page alive past its
 * idle timeout — a WebSocket is not, and the default MV3 content security
 * policy silently upgrades `ws://` to `wss://`. DEV-261 measured this: with a
 * port held, the page survived 35 seconds of idleness with its in-memory state
 * intact.
 *
 * It contains no policy. Requests name a method and explicit identifiers; this
 * file dispatches them and reports what happened.
 */

"use strict";

const PROTOCOL_VERSION = 1;
const HOST_NAME = "to.nodus.zen_agent";

/** Backoff between reconnect attempts when the host is not running. */
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

let port = null;
let reconnectDelayMs = RECONNECT_DELAY_MS;
let listeningToChanges = false;

const METHODS = {
  "session.describe": () => browser.zenAgent.describe(),
  "browser.snapshot": () => browser.zenAgent.snapshot(),
  "tabs.open": (params) => browser.zenAgent.openTab(params ?? {}),
  "tabs.move": (params) =>
    browser.zenAgent.moveTab(params?.tabId, params?.zenSpaceUuid),
  "tabs.navigate": (params) =>
    browser.zenAgent.navigateTab(params?.tabId, params?.url),
  "tabs.close": (params) => browser.zenAgent.closeTab(params?.tabId),
};

function send(message) {
  try {
    port?.postMessage(message);
  } catch {
    // The host went away between the check and the write. The disconnect
    // handler will reconnect; dropping this message is correct, because the
    // host reconciles with a fresh snapshot when it reconnects.
  }
}

/**
 * Map a failure onto a protocol error code.
 *
 * The message is passed through, but nothing else is: an error thrown while
 * loading a page can carry a URL, and URLs stay out of the transport's error
 * channel by default.
 */
function toError(error) {
  const code = typeof error?.code === "string" ? error.code : "internal";

  return {
    code,
    message: String(error?.message ?? error ?? "Unknown failure"),
  };
}

async function handleRequest(message) {
  const method = METHODS[message.method];

  if (method === undefined) {
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      id: message.id,
      error: {
        code: "invalid-request",
        message: `Unknown method ${message.method}.`,
      },
    });
    return;
  }

  try {
    // The privileged API returns an outcome envelope rather than throwing, so
    // that a real failure message survives WebExtension's error masking.
    const outcome = await method(message.params);

    if (outcome && outcome.ok === false) {
      send({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        id: message.id,
        error: {
          code: outcome.error?.code ?? "internal",
          message: String(outcome.error?.message ?? "Unknown failure"),
          data: { stack: outcome.error?.stack ?? null },
        },
      });
      return;
    }

    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "response",
      id: message.id,
      result: outcome?.value,
    });
  } catch (error) {
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      id: message.id,
      error: toError(error),
    });
  }
}

function onHostMessage(message) {
  if (message?.protocolVersion !== PROTOCOL_VERSION) {
    // Refuse rather than guess. The add-on and the host are installed
    // separately and will drift; a clear refusal is much cheaper to diagnose.
    send({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      id: typeof message?.id === "string" ? message.id : "unknown",
      error: {
        code: "protocol-version-mismatch",
        message: `The Zen Agent extension speaks protocol version ${PROTOCOL_VERSION}.`,
      },
    });
    return;
  }

  if (message.type === "request") {
    void handleRequest(message);
  }
}

function onChanged(change) {
  const { event, ...payload } = change;
  send({
    protocolVersion: PROTOCOL_VERSION,
    type: "event",
    event,
    payload,
  });
}

function connect() {
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch {
    scheduleReconnect();
    return;
  }

  reconnectDelayMs = RECONNECT_DELAY_MS;
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleReconnect();
  });

  if (!listeningToChanges) {
    browser.zenAgent.onChanged.addListener(onChanged);
    listeningToChanges = true;
  }
}

function scheduleReconnect() {
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  setTimeout(connect, delay);
}

connect();
