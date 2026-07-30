/**
 * The versioned wire protocol between the Zen extension and the terminal-side
 * host.
 *
 * Both ends stamp every message with `protocolVersion` and refuse a mismatch
 * outright. The extension and the host are installed separately — the add-on
 * lives in a browser profile and the host on disk — so they will drift, and a
 * clear refusal is much cheaper to diagnose than a field that quietly went
 * missing.
 */

/** Incremented on any breaking change to the messages in this file. */
export const TRANSPORT_PROTOCOL_VERSION = 1;

export type TransportErrorCode =
  /** The peer speaks a different `TRANSPORT_PROTOCOL_VERSION`. */
  | "protocol-version-mismatch"
  /** This Zen build does not expose an internal the operation needs. */
  | "unsupported-capability"
  /** No Zen window is available yet, or the browser is shutting down. */
  | "browser-unavailable"
  /** The request was malformed or referred to something that cannot exist. */
  | "invalid-request"
  /** The identifier referred to a tab, Space, or window that is gone. */
  | "stale-id"
  /** The top-level page document was replaced after a reference was minted. */
  | "stale-document"
  /** A child frame detached or navigated after a reference was minted. */
  | "stale-frame"
  /** A referenced node disconnected or its short-lived snapshot expired. */
  | "stale-element"
  /** The operation did not complete within its deadline. */
  | "timeout"
  /** The result could not be delivered within the message size limits. */
  | "payload-too-large"
  /** The operation would violate a background-safety policy. */
  | "policy-rejection"
  /** An unexpected failure inside the extension or host. */
  | "internal";

export const TRANSPORT_ERROR_CODES: readonly TransportErrorCode[] = [
  "protocol-version-mismatch",
  "unsupported-capability",
  "browser-unavailable",
  "invalid-request",
  "stale-id",
  "stale-document",
  "stale-frame",
  "stale-element",
  "timeout",
  "payload-too-large",
  "policy-rejection",
  "internal",
];

const MAX_PROTOCOL_STRING_BYTES = 4 * 1024;

export interface TransportErrorBody {
  readonly code: TransportErrorCode;
  readonly message: string;
  /** Structured detail. Must never carry page content, URLs, or form values. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TransportRequest {
  readonly protocolVersion: number;
  readonly type: "request";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface TransportResponse {
  readonly protocolVersion: number;
  readonly type: "response";
  readonly id: string;
  readonly result: unknown;
}

export interface TransportErrorResponse {
  readonly protocolVersion: number;
  readonly type: "error";
  readonly id: string;
  readonly error: TransportErrorBody;
}

export interface TransportEvent {
  readonly protocolVersion: number;
  readonly type: "event";
  readonly event: string;
  readonly payload: unknown;
}

export type TransportMessage =
  | TransportRequest
  | TransportResponse
  | TransportErrorResponse
  | TransportEvent;

/**
 * Methods the extension answers.
 *
 * `browser.snapshot` is the only one required for discovery. The mutating
 * methods exist so that policy stays on the terminal side: the extension
 * performs exactly what it is told, by explicit identifier, and never chooses.
 */
export const TRANSPORT_METHODS = [
  "session.describe",
  "browser.snapshot",
  "pages.inspect",
  "pages.snapshot",
  "pages.query",
  "pages.click",
  "pages.fill",
  "pages.type",
  "pages.press",
  "pages.select",
  "pages.check",
  "pages.uncheck",
  "pages.submit",
  "pages.upload",
  "pages.media.list",
  "pages.media.fetch",
  "pages.resource.fetch",
  "pages.screenshot",
  "pages.back",
  "pages.forward",
  "tabs.open",
  "tabs.navigate",
  "tabs.reload",
  "tabs.close",
  "tabs.move",
] as const;

export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

/**
 * Events the extension emits between snapshots.
 *
 * These are advisory. A client that misses one is expected to reconcile with a
 * fresh snapshot rather than assume its registry is correct, because the DOM
 * events they derive from are not a guaranteed-complete change feed.
 */
export const TRANSPORT_EVENTS = [
  "session.ready",
  "session.ending",
  "tab.created",
  "tab.removed",
  "tab.updated",
  "tab.crashed",
  "registry.invalidated",
] as const;

export type TransportEventName = (typeof TRANSPORT_EVENTS)[number];

export class TransportProtocolError extends Error {
  public readonly code: TransportErrorCode;

  public constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "TransportProtocolError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PROTOCOL_STRING_BYTES
  );
}

function isTransportErrorCode(value: unknown): value is TransportErrorCode {
  return (
    typeof value === "string" &&
    (TRANSPORT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validate a decoded frame as a protocol message.
 *
 * Throws `TransportProtocolError` rather than returning a boolean, because
 * every rejection reason here is something the operator needs to see.
 */
export function parseMessage(value: unknown): TransportMessage {
  if (!isRecord(value)) {
    throw new TransportProtocolError(
      "invalid-request",
      "A protocol message must be an object.",
    );
  }

  const { protocolVersion, type } = value;

  if (protocolVersion !== TRANSPORT_PROTOCOL_VERSION) {
    throw new TransportProtocolError(
      "protocol-version-mismatch",
      `This build speaks protocol version ${String(TRANSPORT_PROTOCOL_VERSION)}; the peer sent a different version. Reinstall the Zen Agent extension and host together.`,
    );
  }

  switch (type) {
    case "request": {
      if (!isBoundedString(value["id"]) || !isBoundedString(value["method"])) {
        throw new TransportProtocolError(
          "invalid-request",
          "A request must carry a string id and method.",
        );
      }

      return value as unknown as TransportRequest;
    }
    case "response": {
      if (!isBoundedString(value["id"])) {
        throw new TransportProtocolError(
          "invalid-request",
          "A response must carry a string id.",
        );
      }

      return value as unknown as TransportResponse;
    }
    case "error": {
      if (!isBoundedString(value["id"]) || !isRecord(value["error"])) {
        throw new TransportProtocolError(
          "invalid-request",
          "An error response must carry a string id and an error body.",
        );
      }

      if (
        !isTransportErrorCode(value["error"]["code"]) ||
        !isBoundedString(value["error"]["message"])
      ) {
        throw new TransportProtocolError(
          "invalid-request",
          "An error response must carry a recognized code and bounded message.",
        );
      }

      return value as unknown as TransportErrorResponse;
    }
    case "event": {
      if (!isBoundedString(value["event"])) {
        throw new TransportProtocolError(
          "invalid-request",
          "An event must carry a string event name.",
        );
      }

      return value as unknown as TransportEvent;
    }
    default:
      throw new TransportProtocolError(
        "invalid-request",
        "Unknown protocol message type.",
      );
  }
}

export function request(
  id: string,
  method: TransportMethod,
  params?: unknown,
): TransportRequest {
  return params === undefined
    ? {
        protocolVersion: TRANSPORT_PROTOCOL_VERSION,
        type: "request",
        id,
        method,
      }
    : {
        protocolVersion: TRANSPORT_PROTOCOL_VERSION,
        type: "request",
        id,
        method,
        params,
      };
}

export function response(id: string, result: unknown): TransportResponse {
  return {
    protocolVersion: TRANSPORT_PROTOCOL_VERSION,
    type: "response",
    id,
    result,
  };
}

export function errorResponse(
  id: string,
  error: TransportErrorBody,
): TransportErrorResponse {
  return {
    protocolVersion: TRANSPORT_PROTOCOL_VERSION,
    type: "error",
    id,
    error,
  };
}

export function event(
  name: TransportEventName,
  payload: unknown,
): TransportEvent {
  return {
    protocolVersion: TRANSPORT_PROTOCOL_VERSION,
    type: "event",
    event: name,
    payload,
  };
}
