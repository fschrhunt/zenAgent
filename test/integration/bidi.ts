/**
 * A minimal WebDriver BiDi client built on Node's global `WebSocket`.
 *
 * This exists so the DEV-261 transport spike can be reproduced without adding a
 * production dependency on a full automation framework. It deliberately
 * implements only what the spike needs.
 */

export interface BidiError {
  readonly error: string;
  readonly message: string;
}

export class BidiCommandError extends Error {
  readonly bidiError: string;

  constructor(method: string, error: BidiError) {
    super(`${method} failed: ${error.error}: ${error.message}`);
    this.name = "BidiCommandError";
    this.bidiError = error.error;
  }
}

export interface BidiEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface IncomingMessage {
  readonly id?: number;
  readonly type?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly message?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface Pending {
  readonly resolve: (message: IncomingMessage) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface BidiClientOptions {
  /** Per-command timeout. Every command is bounded; nothing may hang forever. */
  readonly timeoutMs?: number;
}

export class BidiClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #events: BidiEvent[] = [];
  readonly #timeoutMs: number;
  #nextId = 0;
  #sessionId: string | undefined;

  private constructor(socket: WebSocket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    this.#socket.onmessage = (event: MessageEvent) => {
      this.#handleMessage(String(event.data));
    };
  }

  /** The current WebDriver session id, once `newSession` has succeeded. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** Every event received since connecting, in arrival order. */
  get events(): readonly BidiEvent[] {
    return this.#events;
  }

  static async connect(
    webSocketUrl: string,
    options: BidiClientOptions = {},
  ): Promise<BidiClient> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = new WebSocket(webSocketUrl);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out connecting to ${webSocketUrl}`));
      }, timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`failed to connect to ${webSocketUrl}`));
      };
    });

    return new BidiClient(socket, timeoutMs);
  }

  #handleMessage(raw: string): void {
    const message = JSON.parse(raw) as IncomingMessage;

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending !== undefined) {
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      return;
    }

    if (message.type === "event" && message.method !== undefined) {
      this.#events.push({
        method: message.method,
        params: message.params ?? {},
      });
    }
  }

  /** Sends a command and resolves with the raw envelope, error or not. */
  async trySend(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<IncomingMessage> {
    const id = ++this.#nextId;

    return new Promise<IncomingMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, this.#timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Sends a command, throwing `BidiCommandError` if the browser rejects it. */
  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const message = await this.trySend(method, params);

    if (message.result === undefined) {
      throw new BidiCommandError(method, {
        error: message.error ?? "unknown error",
        message: (message.message ?? "").split("\n")[0] ?? "",
      });
    }

    return message.result as T;
  }

  async newSession(): Promise<{ sessionId: string }> {
    const result = await this.send<{
      sessionId: string;
      capabilities: Record<string, unknown>;
    }>("session.new", { capabilities: {} });
    this.#sessionId = result.sessionId;
    return result;
  }

  async subscribe(events: readonly string[]): Promise<void> {
    await this.send("session.subscribe", { events: [...events] });
  }

  /**
   * Ends the session and closes the socket.
   *
   * This is not optional hygiene. Firefox allows exactly one active BiDi
   * session, and a socket that closes without `session.end` leaks that session
   * permanently -- the browser must be restarted before anything can attach
   * again. See docs/spikes/dev-261-transport.md.
   */
  async close(): Promise<void> {
    if (this.#sessionId !== undefined) {
      try {
        await this.trySend("session.end");
      } catch {
        // The socket may already be gone; closing below is still correct.
      }
      this.#sessionId = undefined;
    }

    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("client closed"));
      this.#pending.delete(id);
    }

    this.#socket.close();
  }
}
