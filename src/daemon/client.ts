import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  DAEMON_PROTOCOL_VERSION,
  daemonErrorResponse,
  DaemonMessageDecoder,
  DaemonProtocolError,
  encodeDaemonMessage,
  type DaemonErrorResponse,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
} from "./protocol.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface DaemonClientOptions {
  readonly socketPath: string;
  readonly clientId?: string;
  readonly requestTimeoutMs?: number;
}

export class DaemonClient {
  readonly #options: DaemonClientOptions;
  readonly #clientId: string;
  readonly #decoder = new DaemonMessageDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(event: DaemonEvent) => void>();
  #socket: Socket | undefined;

  public constructor(options: DaemonClientOptions) {
    this.#options = options;
    this.#clientId = options.clientId ?? randomUUID();
  }

  public async connect(): Promise<void> {
    if (this.#socket !== undefined) {
      return;
    }

    const socket = createConnection(this.#options.socketPath);
    this.#socket = socket;
    socket.on("data", (chunk) => {
      try {
        const bytes =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;

        for (const message of this.#decoder.push(bytes)) {
          this.#dispatch(message);
        }
      } catch (error) {
        this.#failAll(error);
        socket.destroy();
      }
    });
    socket.on("close", () => {
      this.#socket = undefined;
      this.#failAll(
        new DaemonProtocolError(
          "browser-unavailable",
          "The daemon connection closed.",
        ),
      );
    });
    socket.on("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
  }

  public onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public request(
    method: DaemonMethod,
    params?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const socket = this.#socket;

    if (socket === undefined) {
      throw new DaemonProtocolError(
        "browser-unavailable",
        "The daemon client is not connected.",
      );
    }

    const id = randomUUID();
    const request: DaemonRequest = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "request",
      id,
      clientId: this.#clientId,
      method,
      ...(params === undefined ? {} : { params }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new DaemonProtocolError(
            "timeout",
            `${method} did not answer before the client timeout.`,
          ),
        );
      }, this.#options.requestTimeoutMs ?? 10_000);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(encodeDaemonMessage(request));
    });
  }

  public close(): void {
    this.#socket?.end();
    this.#socket?.destroy();
    this.#socket = undefined;
  }

  #dispatch(value: unknown): void {
    const message = parseServerMessage(value);

    if (message.type === "event") {
      for (const listener of this.#listeners) {
        listener(message);
      }
      return;
    }

    const pending = this.#pending.get(message.id);

    if (pending === undefined) {
      return;
    }

    this.#pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.type === "error") {
      pending.reject(
        new DaemonProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #failAll(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));

    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
  }
}

function parseServerMessage(
  value: unknown,
): DaemonResponse | DaemonErrorResponse | DaemonEvent {
  if (typeof value !== "object" || value === null) {
    throw new DaemonProtocolError(
      "invalid-request",
      "The daemon sent a non-object message.",
    );
  }

  const record = value as Readonly<Record<string, unknown>>;

  if (record["protocolVersion"] !== DAEMON_PROTOCOL_VERSION) {
    throw new DaemonProtocolError(
      "protocol-version-mismatch",
      "The daemon and client protocol versions differ.",
    );
  }

  if (record["type"] === "response" && typeof record["id"] === "string") {
    return value as DaemonResponse;
  }

  if (
    record["type"] === "error" &&
    typeof record["id"] === "string" &&
    typeof record["error"] === "object" &&
    record["error"] !== null
  ) {
    return value as DaemonErrorResponse;
  }

  if (
    record["type"] === "event" &&
    (record["event"] === "registry.updated" ||
      record["event"] === "status.changed" ||
      record["event"] === "daemon.stopping")
  ) {
    return value as DaemonEvent;
  }

  // Reference the constructor so a malformed "error" cannot accidentally be
  // mistaken for a successful response by dead-code elimination or refactors.
  void daemonErrorResponse;
  throw new DaemonProtocolError(
    "invalid-request",
    "The daemon sent a malformed response.",
  );
}
