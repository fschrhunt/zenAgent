/**
 * The terminal-side transport client.
 *
 * Owns exactly one connection to one Zen session, correlates requests with
 * responses, and turns what the extension reports into browser-model snapshots
 * and deltas. Policy lives above this: the client refuses unsafe requests but
 * never chooses a Space, a tab, or a fallback on the caller's behalf.
 */

import { randomUUID } from "node:crypto";
import type {
  BrowserDelta,
  BrowserSnapshot,
  BrowserSessionId,
  PrivateWindowPolicy,
} from "../browser/model.js";
import {
  assertRequiredCapabilities,
  knownCapabilities,
  requireCapability,
  type TransportCapability,
} from "./capabilities.js";
import { ChunkAssembler, encodeChunked } from "./chunking.js";
import { deltaContext, toDelta, type DeltaContext } from "./delta.js";
import { MessageDecoder } from "./framing.js";
import { parseSnapshotPayload } from "./payload.js";
import {
  parseMessage,
  request,
  TransportProtocolError,
  TRANSPORT_EVENTS,
  type TransportEventName,
  type TransportMethod,
} from "./protocol.js";
import { toBrowserSnapshot } from "./snapshot.js";

/**
 * A byte-level duplex to the native messaging host.
 *
 * Deliberately not a Node stream: the host process, a test harness, and a
 * future daemon socket all satisfy this, and none of them should have to agree
 * on stream semantics.
 */
export interface TransportConnection {
  send(frame: Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type ZenTransportEvent =
  | Readonly<{ type: "delta"; delta: BrowserDelta }>
  /** The extension cannot describe a change incrementally; re-snapshot. */
  | Readonly<{ type: "invalidated"; reason: string }>
  | Readonly<{
      type: "session-replaced";
      previous: BrowserSessionId;
      current: BrowserSessionId;
    }>
  | Readonly<{ type: "closed" }>;

export type ZenTransportListener = (event: ZenTransportEvent) => void;

export interface ZenTransportOptions {
  readonly requestTimeoutMs?: number;
  readonly privateWindowPolicy?: PrivateWindowPolicy;
  /** Injectable clock, so tests do not depend on wall time. */
  readonly now?: () => string;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ZenTransport {
  readonly #connection: TransportConnection;
  readonly #decoder = new MessageDecoder();
  readonly #assembler = new ChunkAssembler();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<ZenTransportListener>();
  readonly #requestTimeoutMs: number;
  readonly #privateWindowPolicy: PrivateWindowPolicy | undefined;
  readonly #now: () => string;

  #capabilities: readonly TransportCapability[] = [];
  #connectedAt: string | undefined;
  #sequence = 0;
  #context: DeltaContext | undefined;
  #sessionId: BrowserSessionId | undefined;
  #closed = false;

  public constructor(
    connection: TransportConnection,
    options: ZenTransportOptions = {},
  ) {
    this.#connection = connection;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#privateWindowPolicy = options.privateWindowPolicy;
    this.#now = options.now ?? (() => new Date().toISOString());

    connection.onData((chunk) => {
      this.#receive(chunk);
    });
    connection.onClose(() => {
      this.#handleClose();
    });
  }

  /** Capabilities this Zen build reported. Empty until `connect` resolves. */
  public get capabilities(): readonly TransportCapability[] {
    return this.#capabilities;
  }

  public get sessionId(): BrowserSessionId | undefined {
    return this.#sessionId;
  }

  public on(listener: ZenTransportListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Handshake, then take a first snapshot.
   *
   * Capabilities are checked before anything else is attempted, so a Zen build
   * that moved an internal produces a refusal rather than a half-executed
   * operation against internals that no longer mean what we think.
   */
  public async connect(): Promise<BrowserSnapshot> {
    const described = await this.#send("session.describe");

    if (typeof described !== "object" || described === null) {
      throw new TransportProtocolError(
        "invalid-request",
        "session.describe did not return a session description.",
      );
    }

    const description = described as {
      capabilities?: unknown;
      browserVersion?: unknown;
    };
    this.#capabilities = knownCapabilities(
      Array.isArray(description.capabilities) ? description.capabilities : [],
    );
    assertRequiredCapabilities(
      this.#capabilities,
      typeof description.browserVersion === "string"
        ? description.browserVersion
        : "of an unreported version",
    );
    this.#connectedAt = this.#now();

    return this.snapshot();
  }

  /**
   * Take a complete snapshot and advance the sequence.
   *
   * Snapshots and deltas share one monotonic sequence, because the registry
   * rejects anything that does not move forward — which is what stops a delay
   * on one path from silently reordering the other.
   */
  public async snapshot(): Promise<BrowserSnapshot> {
    const payload = parseSnapshotPayload(await this.#send("browser.snapshot"));
    const snapshot = toBrowserSnapshot(payload, {
      sequence: this.#nextSequence(),
      connectedAt: this.#connectedAt ?? this.#now(),
      ...(this.#privateWindowPolicy === undefined
        ? {}
        : { privateWindowPolicy: this.#privateWindowPolicy }),
    });

    const previous = this.#sessionId;
    const current = snapshot.sessions[0]?.id;

    if (current !== undefined) {
      this.#sessionId = current;

      if (
        previous !== undefined &&
        previous.transportId !== current.transportId
      ) {
        this.#emit({ type: "session-replaced", previous, current });
      }
    }

    this.#context = deltaContext(snapshot);
    return snapshot;
  }

  /**
   * Open a background tab, optionally routed into a named Space.
   *
   * There is no foreground option, by design. The Space is an explicit Zen
   * uuid supplied by the caller; this method never picks one.
   */
  public async openTab(options: {
    readonly url: string;
    readonly windowId?: string;
    readonly zenSpaceUuid?: string;
  }): Promise<string> {
    requireCapability(
      this.#capabilities,
      "zen.tabs.open-background",
      "Opening a background tab",
    );

    if (options.zenSpaceUuid !== undefined) {
      requireCapability(
        this.#capabilities,
        "zen.spaces.route",
        "Routing a tab into a Space",
      );
    }

    const result = await this.#send("tabs.open", options);
    const tabId = (result as { tabId?: unknown } | null)?.tabId;

    if (typeof tabId !== "string") {
      throw new TransportProtocolError(
        "internal",
        "tabs.open did not return the new tab's identifier.",
      );
    }

    return tabId;
  }

  /**
   * Route an existing tab into an explicit Space.
   *
   * A DOM-and-attribute move that leaves the visible Space and the selected tab
   * alone. The tab keeps its identifier, which is what makes "reuse the tab you
   * already have, in the right Space" possible without opening a duplicate.
   */
  public async moveTab(tabId: string, zenSpaceUuid: string): Promise<void> {
    requireCapability(
      this.#capabilities,
      "zen.spaces.route",
      "Routing a tab into a Space",
    );
    await this.#send("tabs.move", { tabId, zenSpaceUuid });
  }

  /** Navigate a tab named by explicit identifier. Never the selected tab implicitly. */
  public async navigateTab(tabId: string, url: string): Promise<void> {
    await this.#send("tabs.navigate", { tabId, url });
  }

  public async closeTab(tabId: string): Promise<void> {
    await this.#send("tabs.close", { tabId });
  }

  public close(): void {
    this.#connection.close();
    this.#handleClose();
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  async #send(method: TransportMethod, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      throw new TransportProtocolError(
        "browser-unavailable",
        "The Zen transport connection is closed.",
      );
    }

    const id = randomUUID();
    const message = request(id, method, params);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new TransportProtocolError(
            "timeout",
            `${method} did not answer within ${String(this.#requestTimeoutMs)}ms.`,
          ),
        );
      }, this.#requestTimeoutMs);

      // Do not hold the process open purely for an in-flight request.
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });

      try {
        for (const frame of encodeChunked(message)) {
          this.#connection.send(frame);
        }
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #receive(chunk: Uint8Array): void {
    let messages: readonly unknown[];

    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#failAll(error);
      this.close();
      return;
    }

    for (const raw of messages) {
      try {
        const assembled = this.#assembler.accept(raw);

        if (assembled === undefined) {
          continue;
        }

        this.#dispatch(parseMessage(assembled));
      } catch (error) {
        // A malformed frame means the peer is not the peer we think it is.
        // Failing every in-flight request is safer than answering some of them.
        this.#failAll(error);
        this.close();
        return;
      }
    }
  }

  #dispatch(message: ReturnType<typeof parseMessage>): void {
    if (message.type === "event") {
      this.#handleEvent(message.event, message.payload);
      return;
    }

    if (message.type === "request") {
      // The extension does not call the host; ignoring is safer than replying
      // to something we have no contract for.
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
        new TransportProtocolError(message.error.code, message.error.message),
      );
      return;
    }

    pending.resolve(message.result);
  }

  #handleEvent(name: string, payload: unknown): void {
    if (!(TRANSPORT_EVENTS as readonly string[]).includes(name)) {
      return;
    }

    const eventName = name as TransportEventName;

    if (eventName === "registry.invalidated" || eventName === "session.ready") {
      this.#emit({
        type: "invalidated",
        reason: reasonOf(payload) ?? eventName,
      });
      return;
    }

    if (eventName === "session.ending") {
      this.#emit({ type: "invalidated", reason: "session.ending" });
      return;
    }

    const context = this.#context;

    if (context === undefined) {
      this.#emit({ type: "invalidated", reason: "no snapshot yet" });
      return;
    }

    try {
      const delta = toDelta(eventName, payload, context, {
        sequence: this.#nextSequence(),
        observedAt: this.#now(),
      });

      if (delta !== undefined) {
        this.#emit({ type: "delta", delta });
      }
    } catch {
      // An event we cannot place means the incremental view is already wrong.
      // Ask for a snapshot instead of guessing, and do not surface the raw
      // event, which may carry a URL or title.
      this.#emit({
        type: "invalidated",
        reason: `unusable ${eventName} event`,
      });
    }
  }

  #handleClose(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#assembler.reset();
    this.#failAll(
      new TransportProtocolError(
        "browser-unavailable",
        "The Zen transport connection closed.",
      ),
    );
    this.#emit({ type: "closed" });
  }

  #failAll(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));

    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
  }

  #emit(event: ZenTransportEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function reasonOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}
