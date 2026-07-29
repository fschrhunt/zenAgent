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
  assertBrowserSnapshotLimits,
  ResourceLimitError,
} from "../security/limits.js";
import {
  BrowserUrlPolicyError,
  validateBrowserUrl,
} from "../security/url-policy.js";
import {
  assertRequiredCapabilities,
  assertSupportedZenBuild,
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
export const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const MAX_PAGE_INSPECTION_CHARS = 10_000;

export interface PageInspection {
  readonly url: string;
  readonly title: string;
  readonly loadState: "loading" | "interactive" | "complete";
  readonly visibleText: string;
  readonly truncated: boolean;
  readonly visitedTextNodes: number;
}

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
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new TypeError(
        `A transport request timeout must be an integer from 1 through ${String(MAX_REQUEST_TIMEOUT_MS)} milliseconds.`,
      );
    }

    this.#connection = connection;
    this.#requestTimeoutMs = requestTimeoutMs;
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
      geckoVersion?: unknown;
    };
    const browserVersion =
      typeof description.browserVersion === "string"
        ? description.browserVersion
        : "unreported";
    const geckoVersion =
      typeof description.geckoVersion === "string"
        ? description.geckoVersion
        : "unreported";

    assertSupportedZenBuild({ browserVersion, geckoVersion });
    this.#capabilities = knownCapabilities(
      Array.isArray(description.capabilities) ? description.capabilities : [],
    );
    assertRequiredCapabilities(this.#capabilities, browserVersion);
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

    try {
      assertBrowserSnapshotLimits(snapshot);
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        throw new TransportProtocolError("payload-too-large", error.message);
      }

      throw error;
    }

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
    const url = transportBrowserUrl(options.url);
    const windowId =
      options.windowId === undefined
        ? undefined
        : transportIdentifier(options.windowId, "window");
    const zenSpaceUuid =
      options.zenSpaceUuid === undefined
        ? undefined
        : transportIdentifier(options.zenSpaceUuid, "Space");

    requireCapability(
      this.#capabilities,
      "zen.tabs.open-background",
      "Opening a background tab",
    );

    if (zenSpaceUuid !== undefined) {
      requireCapability(
        this.#capabilities,
        "zen.spaces.route",
        "Routing a tab into a Space",
      );
    }

    const result = await this.#send("tabs.open", {
      url,
      ...(windowId === undefined ? {} : { windowId }),
      ...(zenSpaceUuid === undefined ? {} : { zenSpaceUuid }),
    });
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
    const stableTabId = transportIdentifier(tabId, "tab");
    const stableSpaceId = transportIdentifier(zenSpaceUuid, "Space");
    requireCapability(
      this.#capabilities,
      "zen.spaces.route",
      "Routing a tab into a Space",
    );
    await this.#send("tabs.move", {
      tabId: stableTabId,
      zenSpaceUuid: stableSpaceId,
    });
  }

  /** Navigate a tab named by explicit identifier. Never the selected tab implicitly. */
  public async navigateTab(tabId: string, url: string): Promise<void> {
    await this.#send("tabs.navigate", {
      tabId: transportIdentifier(tabId, "tab"),
      url: transportBrowserUrl(url),
    });
  }

  /** Reload a tab named by explicit identifier. Never the selected tab implicitly. */
  public async reloadTab(tabId: string): Promise<void> {
    await this.#send("tabs.reload", {
      tabId: transportIdentifier(tabId, "tab"),
    });
  }

  /**
   * Inspect one loaded HTTP(S) document by explicit stable tab identifier.
   *
   * The extension enforces the same bound again; checking here gives a useful
   * refusal before page content is touched.
   */
  public async inspectPage(
    tabId: string,
    options: { readonly maxChars?: number } = {},
  ): Promise<PageInspection> {
    const stableTabId = transportIdentifier(tabId, "tab");
    requireCapability(
      this.#capabilities,
      "browser.pages.inspect",
      "Inspecting page content",
    );

    const maxChars = options.maxChars ?? 2_000;

    if (
      !Number.isInteger(maxChars) ||
      maxChars < 1 ||
      maxChars > MAX_PAGE_INSPECTION_CHARS
    ) {
      throw new TransportProtocolError(
        "invalid-request",
        `maxChars must be an integer from 1 through ${String(MAX_PAGE_INSPECTION_CHARS)}.`,
      );
    }

    const result = await this.#send("pages.inspect", {
      tabId: stableTabId,
      maxChars,
    });
    return parsePageInspection(result, maxChars);
  }

  public async closeTab(tabId: string): Promise<void> {
    await this.#send("tabs.close", {
      tabId: transportIdentifier(tabId, "tab"),
    });
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

function parsePageInspection(value: unknown, maxChars: number): PageInspection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.inspect did not return an inspection object.",
    );
  }

  const result = value as Readonly<Record<string, unknown>>;
  const loadState = result["loadState"];
  const visibleText = result["visibleText"];
  const visitedTextNodes = result["visitedTextNodes"];

  if (
    typeof result["url"] !== "string" ||
    result["url"].length > 16_384 ||
    typeof result["title"] !== "string" ||
    result["title"].length > 1_024 ||
    !["loading", "interactive", "complete"].includes(String(loadState)) ||
    typeof visibleText !== "string" ||
    visibleText.length > maxChars ||
    typeof result["truncated"] !== "boolean" ||
    !Number.isInteger(visitedTextNodes) ||
    Number(visitedTextNodes) < 0 ||
    Number(visitedTextNodes) > 10_000
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.inspect returned an invalid or unbounded inspection.",
    );
  }

  return {
    url: result["url"],
    title: result["title"],
    loadState: loadState as PageInspection["loadState"],
    visibleText,
    truncated: result["truncated"],
    visitedTextNodes: Number(visitedTextNodes),
  };
}

function transportBrowserUrl(value: string): string {
  try {
    return validateBrowserUrl(value);
  } catch (error) {
    if (error instanceof BrowserUrlPolicyError) {
      throw new TransportProtocolError("invalid-request", error.message);
    }

    throw error;
  }
}

function transportIdentifier(value: string, kind: string): string {
  if (
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 4 * 1024
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      `An explicit ${kind} identifier must be between 1 and 4096 bytes.`,
    );
  }

  return value;
}

function reasonOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}
