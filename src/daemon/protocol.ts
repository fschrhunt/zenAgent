/**
 * Versioned protocol between local setup/MCP clients and the shared daemon.
 *
 * The daemon protocol is deliberately independent from the extension protocol:
 * clients and the native host can be upgraded independently, and neither side
 * should mistake a coincidentally similar message for one it understands.
 */

import {
  assertJsonResourceLimits,
  ResourceLimitError,
} from "../security/limits.js";

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_PROTOCOL_RECOVERY =
  "upgrade-client-host-and-extension-together";
export const DEFAULT_DAEMON_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DAEMON_IDENTIFIER_BYTES = 256;
export const MAX_DAEMON_IDEMPOTENCY_KEY_BYTES = 512;

export const DAEMON_METHODS = [
  "health",
  "version",
  "capabilities",
  "status",
  "registry.entities",
  "registry.lookup",
  "registry.refresh",
  "config.reload",
  "pages.inspect",
  "pages.snapshot",
  "pages.query",
  "pages.wait",
  "pages.click",
  "pages.fill",
  "pages.type",
  "pages.press",
  "pages.select",
  "pages.check",
  "pages.uncheck",
  "pages.submit",
  "pages.upload",
  "pages.screenshot",
  "pages.media.list",
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
  "tabs.move",
  "tabs.lease.acquire",
  "tabs.lease.renew",
  "tabs.lease.release",
  "operations.cancel",
  "daemon.shutdown",
] as const;

export type DaemonMethod = (typeof DAEMON_METHODS)[number];

export type DaemonErrorCode =
  | "protocol-version-mismatch"
  | "invalid-request"
  | "method-not-found"
  | "browser-unavailable"
  | "unsupported-capability"
  | "stale-id"
  | "stale-document"
  | "stale-frame"
  | "stale-element"
  | "timeout"
  | "payload-too-large"
  | "already-running"
  | "policy-rejection"
  | "lease-conflict"
  | "cancelled"
  | "internal";

export interface DaemonErrorBody {
  readonly code: DaemonErrorCode;
  readonly message: string;
  /** Sanitized detail only. Never page content, URLs, titles, or form values. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DaemonRequest {
  readonly protocolVersion: number;
  readonly type: "request";
  readonly id: string;
  readonly clientId: string;
  readonly method: DaemonMethod;
  readonly params?: unknown;
  readonly idempotencyKey?: string;
}

export interface DaemonResponse {
  readonly protocolVersion: number;
  readonly type: "response";
  readonly id: string;
  readonly result: unknown;
}

export interface DaemonErrorResponse {
  readonly protocolVersion: number;
  readonly type: "error";
  readonly id: string;
  readonly error: DaemonErrorBody;
}

export interface DaemonEvent {
  readonly protocolVersion: number;
  readonly type: "event";
  readonly event: "registry.updated" | "status.changed" | "daemon.stopping";
  readonly payload: unknown;
}

export type DaemonMessage =
  DaemonRequest | DaemonResponse | DaemonErrorResponse | DaemonEvent;

export class DaemonProtocolError extends Error {
  public readonly code: DaemonErrorCode;
  public readonly data:
    Readonly<Record<string, string | number | boolean | null>> | undefined;

  public constructor(
    code: DaemonErrorCode,
    message: string,
    data?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "DaemonProtocolError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Produce one stable, content-free recovery contract on both sides of the
 * socket. A protocol mismatch is never safe to retry against the same
 * processes: every installed Zen Agent component must be upgraded together,
 * then the browser-provided daemon must be restarted.
 */
export function daemonProtocolVersionMismatch(
  receivedProtocolVersion: unknown,
): DaemonProtocolError {
  return new DaemonProtocolError(
    "protocol-version-mismatch",
    `This Zen Agent component speaks daemon protocol version ${String(DAEMON_PROTOCOL_VERSION)}. Upgrade the client, native host, and extension together, restart Zen, then run zen-agent doctor.`,
    {
      reason: "protocol-version-mismatch",
      retryable: false,
      performed: false,
      resource: "daemon-protocol",
      recovery: DAEMON_PROTOCOL_RECOVERY,
      expectedProtocolVersion: DAEMON_PROTOCOL_VERSION,
      receivedProtocolVersion:
        typeof receivedProtocolVersion === "number" &&
        Number.isSafeInteger(receivedProtocolVersion)
          ? receivedProtocolVersion
          : null,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDaemonMethod(value: unknown): value is DaemonMethod {
  return (
    typeof value === "string" &&
    (DAEMON_METHODS as readonly string[]).includes(value)
  );
}

function requireNonEmptyString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maxBytes = MAX_DAEMON_IDENTIFIER_BYTES,
): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DaemonProtocolError(
      "invalid-request",
      `A daemon request must carry a non-empty ${key}.`,
    );
  }

  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new DaemonProtocolError(
      "invalid-request",
      `A daemon request ${key} exceeds the ${String(maxBytes)} byte limit.`,
    );
  }

  return value;
}

export function parseDaemonRequest(value: unknown): DaemonRequest {
  if (!isRecord(value)) {
    throw new DaemonProtocolError(
      "invalid-request",
      "A daemon request must be an object.",
    );
  }

  if (value["protocolVersion"] !== DAEMON_PROTOCOL_VERSION) {
    throw daemonProtocolVersionMismatch(value["protocolVersion"]);
  }

  if (value["type"] !== "request") {
    throw new DaemonProtocolError(
      "invalid-request",
      "A daemon client may send request messages only.",
    );
  }

  const id = requireNonEmptyString(value, "id");
  const clientId = requireNonEmptyString(value, "clientId");
  const method = value["method"];

  if (!isDaemonMethod(method)) {
    throw new DaemonProtocolError(
      "method-not-found",
      `Unknown daemon method ${JSON.stringify(method)}.`,
    );
  }

  const idempotencyKey =
    value["idempotencyKey"] === undefined
      ? undefined
      : requireNonEmptyString(
          value,
          "idempotencyKey",
          MAX_DAEMON_IDEMPOTENCY_KEY_BYTES,
        );

  try {
    assertJsonResourceLimits(value["params"]);
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      throw new DaemonProtocolError("payload-too-large", error.message, {
        limit: error.limit,
      });
    }

    throw error;
  }

  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "request",
    id,
    clientId,
    method,
    ...(value["params"] === undefined ? {} : { params: value["params"] }),
    ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
  };
}

export function daemonResponse(id: string, result: unknown): DaemonResponse {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "response",
    id,
    result,
  };
}

export function daemonErrorResponse(
  id: string,
  error: DaemonErrorBody,
): DaemonErrorResponse {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "error",
    id,
    error,
  };
}

export function daemonEvent(
  event: DaemonEvent["event"],
  payload: unknown,
): DaemonEvent {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "event",
    event,
    payload,
  };
}

/**
 * A four-byte big-endian byte length followed by one UTF-8 JSON value.
 *
 * Unlike newline-delimited JSON this permits arbitrary strings without an
 * escaping convention and permits a strict size check before allocation.
 */
export function encodeDaemonMessage(
  message: DaemonMessage,
  maxBytes = DEFAULT_DAEMON_MAX_MESSAGE_BYTES,
): Uint8Array {
  const payload = Buffer.from(JSON.stringify(message), "utf8");

  if (payload.byteLength > maxBytes) {
    throw new DaemonProtocolError(
      "payload-too-large",
      `Daemon message exceeds the ${String(maxBytes)} byte limit.`,
    );
  }

  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class DaemonMessageDecoder {
  readonly #maxBytes: number;
  #buffer = Buffer.alloc(0);

  public constructor(maxBytes = DEFAULT_DAEMON_MAX_MESSAGE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  public push(chunk: Uint8Array): readonly unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const decoded: unknown[] = [];

    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);

      if (length > this.#maxBytes) {
        throw new DaemonProtocolError(
          "payload-too-large",
          `Daemon message declares ${String(length)} bytes; the limit is ${String(this.#maxBytes)}.`,
        );
      }

      if (this.#buffer.byteLength < 4 + length) {
        break;
      }

      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);

      try {
        decoded.push(JSON.parse(payload.toString("utf8")) as unknown);
      } catch {
        throw new DaemonProtocolError(
          "invalid-request",
          "A daemon message contained invalid JSON.",
        );
      }
    }

    return decoded;
  }
}
