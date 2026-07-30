/**
 * The terminal-side transport client.
 *
 * Owns exactly one connection to one Zen session, correlates requests with
 * responses, and turns what the extension reports into browser-model snapshots
 * and deltas. Policy lives above this: the client refuses unsafe requests but
 * never chooses a Space, a tab, or a fallback on the caller's behalf.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
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
  MAX_PAGE_FRAMES,
  MAX_PAGE_MEDIA,
  MAX_PAGE_MEDIA_BYTES,
  MAX_PAGE_NODES,
  MAX_PAGE_QUERY_RESULTS,
  MAX_PAGE_RESOURCE_BYTES,
  MAX_PAGE_SCREENSHOT_BYTES,
  MAX_PAGE_SCREENSHOT_DIMENSION,
  MAX_PAGE_SELECT_VALUES,
  MAX_PAGE_STRING_CHARS,
  MAX_PAGE_UPLOAD_FILES,
  PAGE_SCHEMA_VERSION,
  type PageDocumentTarget,
  type PageElementTarget,
  type PageFrame,
  type PageFrameTarget,
  type PageLocator,
  type PageMediaListResult,
  type PageMutationResult,
  type PagePressOptions,
  type PageQueryResult,
  type PageResourceResult,
  type PageScreenshotOptions,
  type PageScreenshotResult,
  type PageSemanticNode,
  type PageSnapshot,
  type PageUploadResult,
} from "../page/model.js";
import {
  acceptedCapabilities,
  assertRequiredCapabilities,
  assertSupportedZenBuild,
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
const RESOURCE_REQUEST_TIMEOUT_MS = 60_000;

export interface PageInspection {
  readonly url: string;
  readonly title: string;
  readonly loadState: "loading" | "interactive" | "complete";
  readonly visibleText: string;
  readonly truncated: boolean;
  readonly visitedTextNodes: number;
}

export interface TransportCompatibilityDescriptor {
  readonly browserVersion: string;
  readonly geckoVersion: string;
  readonly operatingSystem: string;
  readonly operatingSystemVersion: string;
  readonly xpcomAbi: string;
  readonly extensionVersion: string;
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
  #compatibility: TransportCompatibilityDescriptor | undefined;
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

  public get compatibility(): TransportCompatibilityDescriptor | undefined {
    return this.#compatibility;
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
      operatingSystem?: unknown;
      operatingSystemVersion?: unknown;
      xpcomAbi?: unknown;
      extensionVersion?: unknown;
    };
    const browserVersion =
      typeof description.browserVersion === "string"
        ? description.browserVersion
        : "unreported";
    const geckoVersion =
      typeof description.geckoVersion === "string"
        ? description.geckoVersion
        : "unreported";
    const operatingSystem =
      typeof description.operatingSystem === "string"
        ? description.operatingSystem
        : "unreported";
    const operatingSystemVersion =
      typeof description.operatingSystemVersion === "string"
        ? description.operatingSystemVersion
        : "unreported";
    const xpcomAbi =
      typeof description.xpcomAbi === "string"
        ? description.xpcomAbi
        : "unreported";
    const extensionVersion =
      typeof description.extensionVersion === "string" &&
      description.extensionVersion.length > 0 &&
      description.extensionVersion.length <= 256
        ? description.extensionVersion
        : "unreported";

    const build = {
      browserVersion,
      geckoVersion,
      operatingSystem,
      operatingSystemVersion,
      xpcomAbi,
    };
    assertSupportedZenBuild(build);
    this.#compatibility = {
      ...build,
      extensionVersion,
    };
    this.#capabilities = acceptedCapabilities(
      Array.isArray(description.capabilities) ? description.capabilities : [],
      build,
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
      capabilities: this.#capabilities,
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

  /** Capture a bounded semantic page snapshot without selecting the tab. */
  public async snapshotPage(
    tabId: string,
    options: { readonly maxNodes?: number } = {},
  ): Promise<PageSnapshot> {
    const stableTabId = transportIdentifier(tabId, "tab");
    requireCapability(
      this.#capabilities,
      "browser.pages.snapshot",
      "Capturing a semantic page snapshot",
    );
    const maxNodes = options.maxNodes ?? 1_000;

    if (
      !Number.isInteger(maxNodes) ||
      maxNodes < 1 ||
      maxNodes > MAX_PAGE_NODES
    ) {
      throw new TransportProtocolError(
        "invalid-request",
        `maxNodes must be an integer from 1 through ${String(MAX_PAGE_NODES)}.`,
      );
    }

    return parsePageSnapshot(
      await this.#send("pages.snapshot", {
        tabId: stableTabId,
        maxNodes,
      }),
      stableTabId,
      maxNodes,
    );
  }

  /** Query one frame of a still-live snapshot by an explicit locator. */
  public async queryPage(
    target: PageFrameTarget,
    options: {
      readonly locator: PageLocator;
      readonly maxResults?: number;
    },
  ): Promise<PageQueryResult> {
    const stableTarget = pageFrameTarget(target);
    const locator = pageLocator(options.locator);
    const maxResults = options.maxResults ?? 20;
    requireCapability(
      this.#capabilities,
      "browser.pages.query",
      "Querying a semantic page snapshot",
    );

    if (
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > MAX_PAGE_QUERY_RESULTS
    ) {
      throw new TransportProtocolError(
        "invalid-request",
        `maxResults must be an integer from 1 through ${String(MAX_PAGE_QUERY_RESULTS)}.`,
      );
    }

    return parsePageQueryResult(
      await this.#send("pages.query", {
        target: stableTarget,
        locator,
        maxResults,
      }),
      maxResults,
      stableTarget.frameRef,
    );
  }

  public async clickPage(
    target: PageElementTarget,
  ): Promise<PageMutationResult> {
    return this.#elementMutation(
      "pages.click",
      "browser.pages.click",
      "Clicking a page element",
      target,
    );
  }

  public async fillPage(
    target: PageElementTarget,
    value: string,
  ): Promise<PageMutationResult> {
    return this.#elementMutation(
      "pages.fill",
      "browser.pages.fill",
      "Filling a page element",
      target,
      { value: pageContentString(value, "fill value") },
    );
  }

  public async typePage(
    target: PageElementTarget,
    value: string,
  ): Promise<PageMutationResult> {
    return this.#elementMutation(
      "pages.type",
      "browser.pages.type",
      "Typing into a page element",
      target,
      { value: pageString(value, "typed value") },
    );
  }

  public async pressPage(
    target: PageElementTarget,
    options: PagePressOptions,
  ): Promise<PageMutationResult> {
    const key = pageString(options.key, "key", 256);
    const code =
      options.code === undefined
        ? undefined
        : pageString(options.code, "key code", 256);
    return this.#elementMutation(
      "pages.press",
      "browser.pages.press",
      "Pressing a key on a page element",
      target,
      {
        key,
        ...(code === undefined ? {} : { code }),
        altKey: options.altKey ?? false,
        ctrlKey: options.ctrlKey ?? false,
        metaKey: options.metaKey ?? false,
        shiftKey: options.shiftKey ?? false,
      },
    );
  }

  public async selectPage(
    target: PageElementTarget,
    values: readonly string[],
  ): Promise<PageMutationResult> {
    if (values.length < 1 || values.length > MAX_PAGE_SELECT_VALUES) {
      throw new TransportProtocolError(
        "invalid-request",
        `Select values must contain 1 through ${String(MAX_PAGE_SELECT_VALUES)} entries.`,
      );
    }

    return this.#elementMutation(
      "pages.select",
      "browser.pages.select",
      "Selecting page options",
      target,
      {
        values: values.map((value) => pageContentString(value, "select value")),
      },
    );
  }

  public async checkPage(
    target: PageElementTarget,
  ): Promise<PageMutationResult> {
    return this.#elementMutation(
      "pages.check",
      "browser.pages.check",
      "Checking a page element",
      target,
    );
  }

  public async uncheckPage(
    target: PageElementTarget,
  ): Promise<PageMutationResult> {
    return this.#elementMutation(
      "pages.uncheck",
      "browser.pages.check",
      "Unchecking a page element",
      target,
    );
  }

  public async submitPage(
    target: PageElementTarget,
  ): Promise<PageMutationResult> {
    return this.#elementMutation(
      "pages.submit",
      "browser.pages.submit",
      "Submitting a page form",
      target,
    );
  }

  public async uploadPage(
    target: PageElementTarget,
    stagedPaths: readonly string[],
  ): Promise<PageUploadResult> {
    requireCapability(
      this.#capabilities,
      "browser.pages.upload",
      "Uploading staged files",
    );

    if (
      stagedPaths.length < 1 ||
      stagedPaths.length > MAX_PAGE_UPLOAD_FILES ||
      !stagedPaths.every(
        (path) =>
          typeof path === "string" &&
          path.length > 0 &&
          path.length <= 4_096 &&
          isAbsolute(path),
      )
    ) {
      throw new TransportProtocolError(
        "invalid-request",
        `Upload requires 1 through ${String(MAX_PAGE_UPLOAD_FILES)} absolute staged paths.`,
      );
    }

    const stableTarget = pageElementTarget(target);
    const result = pageRecord(
      await this.#send("pages.upload", {
        target: stableTarget,
        paths: [...stagedPaths],
      }),
      "pages.upload",
    );
    const mutation = parsePageMutationResult(result, stableTarget.documentId);

    if (
      result["fileCount"] !== stagedPaths.length ||
      !Number.isSafeInteger(result["fileCount"])
    ) {
      throw new TransportProtocolError(
        "invalid-request",
        "The extension returned an invalid upload result.",
      );
    }

    return { ...mutation, fileCount: result["fileCount"] };
  }

  public async listPageMedia(
    target: PageFrameTarget,
  ): Promise<PageMediaListResult> {
    requireCapability(
      this.#capabilities,
      "browser.pages.media",
      "Inspecting page media",
    );
    const stableTarget = pageFrameTarget(target);
    return parsePageMediaList(
      await this.#send("pages.media.list", { target: stableTarget }),
      stableTarget.frameRef,
    );
  }

  public async fetchPageMedia(
    target: PageElementTarget,
    options: { readonly maxBytes?: number } = {},
  ): Promise<PageResourceResult> {
    requireCapability(
      this.#capabilities,
      "browser.pages.media",
      "Fetching page media bytes",
    );
    const stableTarget = pageElementTarget(target);
    const maxBytes = pageByteLimit(
      options.maxBytes,
      MAX_PAGE_MEDIA_BYTES,
      "media",
    );
    return parsePageResource(
      await this.#send(
        "pages.media.fetch",
        {
          target: stableTarget,
          maxBytes,
        },
        MAX_REQUEST_TIMEOUT_MS,
      ),
      maxBytes,
      "pages.media.fetch",
    );
  }

  public async fetchPageResource(
    target: PageFrameTarget,
    url: string,
    options: { readonly maxBytes?: number } = {},
  ): Promise<PageResourceResult> {
    requireCapability(
      this.#capabilities,
      "browser.pages.resource-fetch",
      "Fetching page resource bytes",
    );
    const stableTarget = pageFrameTarget(target);
    const maxBytes = pageByteLimit(
      options.maxBytes,
      MAX_PAGE_RESOURCE_BYTES,
      "resource",
    );
    return parsePageResource(
      await this.#send(
        "pages.resource.fetch",
        {
          target: stableTarget,
          url: pageString(url, "resource URL"),
          maxBytes,
        },
        RESOURCE_REQUEST_TIMEOUT_MS,
      ),
      maxBytes,
      "pages.resource.fetch",
    );
  }

  public async screenshotPage(
    target: PageFrameTarget | PageElementTarget,
    options: PageScreenshotOptions = {},
  ): Promise<PageScreenshotResult> {
    requireCapability(
      this.#capabilities,
      "browser.pages.screenshot",
      "Capturing a background page screenshot",
    );
    const stableTarget =
      "elementRef" in target
        ? pageElementTarget(target)
        : pageFrameTarget(target);
    const scale = options.scale ?? 1;

    if (
      typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale < 0.25 ||
      scale > 2
    ) {
      throw new TransportProtocolError(
        "invalid-request",
        "Screenshot scale must be between 0.25 and 2.",
      );
    }

    const background = options.background ?? "transparent";

    if (!(
      background === "transparent" ||
      /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(background)
    )) {
      throw new TransportProtocolError(
        "invalid-request",
        "Screenshot background must be transparent or a six/eight digit hex color.",
      );
    }

    return parsePageScreenshot(
      await this.#send("pages.screenshot", {
        target: stableTarget,
        scale,
        background,
      }),
    );
  }

  public async backPage(
    target: PageDocumentTarget,
  ): Promise<PageMutationResult> {
    return this.#historyMutation("pages.back", "back", target);
  }

  public async forwardPage(
    target: PageDocumentTarget,
  ): Promise<PageMutationResult> {
    return this.#historyMutation("pages.forward", "forward", target);
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

  async #elementMutation(
    method:
      | "pages.click"
      | "pages.fill"
      | "pages.type"
      | "pages.press"
      | "pages.select"
      | "pages.check"
      | "pages.uncheck"
      | "pages.submit",
    capability:
      | "browser.pages.click"
      | "browser.pages.fill"
      | "browser.pages.type"
      | "browser.pages.press"
      | "browser.pages.select"
      | "browser.pages.check"
      | "browser.pages.submit",
    operation: string,
    target: PageElementTarget,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<PageMutationResult> {
    requireCapability(this.#capabilities, capability, operation);
    const stableTarget = pageElementTarget(target);
    return parsePageMutationResult(
      await this.#send(method, { target: stableTarget, ...params }),
      stableTarget.documentId,
    );
  }

  async #historyMutation(
    method: "pages.back" | "pages.forward",
    direction: string,
    target: PageDocumentTarget,
  ): Promise<PageMutationResult> {
    requireCapability(
      this.#capabilities,
      "browser.pages.history",
      `Navigating a page ${direction}`,
    );
    const stableTarget = pageDocumentTarget(target);
    return parsePageMutationResult(
      await this.#send(method, { target: stableTarget }),
      stableTarget.documentId,
    );
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  async #send(
    method: TransportMethod,
    params?: unknown,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
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
            `${method} did not answer within ${String(timeoutMs)}ms.`,
          ),
        );
      }, timeoutMs);

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

function pageRecord(
  value: unknown,
  operation: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TransportProtocolError(
      "invalid-request",
      `${operation} did not return an object.`,
    );
  }

  return value as Readonly<Record<string, unknown>>;
}

function pageString(
  value: string,
  kind: string,
  max = MAX_PAGE_STRING_CHARS,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new TransportProtocolError(
      "invalid-request",
      `The ${kind} must contain 1 through ${String(max)} characters.`,
    );
  }

  return value;
}

function pageContentString(value: string, kind: string): string {
  if (typeof value !== "string" || value.length > MAX_PAGE_STRING_CHARS) {
    throw new TransportProtocolError(
      "invalid-request",
      `The ${kind} must contain at most ${String(MAX_PAGE_STRING_CHARS)} characters.`,
    );
  }

  return value;
}

function pageFrameTarget(target: PageFrameTarget): PageFrameTarget {
  return {
    tabId: transportIdentifier(target.tabId, "tab"),
    documentId: transportIdentifier(target.documentId, "document"),
    snapshotId: transportIdentifier(target.snapshotId, "snapshot"),
    frameRef: transportIdentifier(target.frameRef, "frame"),
  };
}

function pageElementTarget(target: PageElementTarget): PageElementTarget {
  return {
    ...pageFrameTarget(target),
    elementRef: transportIdentifier(target.elementRef, "element"),
  };
}

function pageDocumentTarget(target: PageDocumentTarget): PageDocumentTarget {
  return {
    tabId: transportIdentifier(target.tabId, "tab"),
    documentId: transportIdentifier(target.documentId, "document"),
  };
}

function pageLocator(locator: PageLocator): PageLocator {
  switch (locator.kind) {
    case "role": {
      const role = pageString(locator.role, "locator role", 256);
      return locator.name === undefined
        ? { kind: "role", role }
        : {
            kind: "role",
            role,
            name: pageString(locator.name, "locator name"),
          };
    }
    case "label":
      return {
        kind: "label",
        label: pageString(locator.label, "locator label"),
      };
    case "text":
      return {
        kind: "text",
        text: pageString(locator.text, "locator text"),
      };
    case "placeholder":
      return {
        kind: "placeholder",
        placeholder: pageString(locator.placeholder, "locator placeholder"),
      };
    case "css":
      return {
        kind: "css",
        selector: pageString(locator.selector, "CSS selector"),
      };
    case "element":
      return {
        kind: "element",
        elementRef: transportIdentifier(locator.elementRef, "element"),
      };
  }
}

function parsePageSnapshot(
  value: unknown,
  expectedTabId: string,
  maxNodes: number,
): PageSnapshot {
  const result = pageRecord(value, "pages.snapshot");
  const frames = result["frames"];
  const nodes = result["nodes"];
  const truncation = pageRecord(result["truncation"], "pages.snapshot");

  if (
    result["schemaVersion"] !== PAGE_SCHEMA_VERSION ||
    typeof result["snapshotId"] !== "string" ||
    typeof result["documentId"] !== "string" ||
    result["tabId"] !== expectedTabId ||
    typeof result["capturedAt"] !== "string" ||
    typeof result["url"] !== "string" ||
    result["url"].length > MAX_PAGE_STRING_CHARS ||
    typeof result["title"] !== "string" ||
    result["title"].length > 1_024 ||
    !isPageLoadState(result["loadState"]) ||
    typeof result["rootFrameRef"] !== "string" ||
    !Array.isArray(frames) ||
    frames.length < 1 ||
    frames.length > MAX_PAGE_FRAMES ||
    !Array.isArray(nodes) ||
    nodes.length > maxNodes ||
    nodes.length > MAX_PAGE_NODES ||
    typeof truncation["frames"] !== "boolean" ||
    typeof truncation["nodes"] !== "boolean" ||
    typeof truncation["strings"] !== "boolean" ||
    typeof truncation["totalBytes"] !== "boolean"
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.snapshot returned an invalid or unbounded page snapshot.",
    );
  }

  const parsedFrames = frames.map(parsePageFrame);
  const frameRefs = new Set(parsedFrames.map((frame) => frame.frameRef));
  const parsedNodes = nodes.map((node) => parsePageNode(node, frameRefs));

  if (!frameRefs.has(result["rootFrameRef"])) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.snapshot returned an unknown root frame reference.",
    );
  }

  return {
    schemaVersion: PAGE_SCHEMA_VERSION,
    snapshotId: result["snapshotId"],
    documentId: result["documentId"],
    tabId: expectedTabId,
    capturedAt: result["capturedAt"],
    url: result["url"],
    title: result["title"],
    loadState: result["loadState"],
    rootFrameRef: result["rootFrameRef"],
    frames: parsedFrames,
    nodes: parsedNodes,
    truncation: {
      frames: truncation["frames"],
      nodes: truncation["nodes"],
      strings: truncation["strings"],
      totalBytes: truncation["totalBytes"],
    },
  };
}

function parsePageFrame(value: unknown): PageFrame {
  const frame = pageRecord(value, "pages.snapshot frame");
  const availability = frame["availability"];
  const loadState = frame["loadState"];

  if (
    typeof frame["frameRef"] !== "string" ||
    !(
      frame["parentFrameRef"] === null ||
      typeof frame["parentFrameRef"] === "string"
    ) ||
    !(
      frame["documentId"] === null || typeof frame["documentId"] === "string"
    ) ||
    typeof frame["url"] !== "string" ||
    frame["url"].length > MAX_PAGE_STRING_CHARS ||
    !(loadState === "unavailable" || isPageLoadState(loadState)) ||
    !["available", "stale", "unsupported"].includes(String(availability))
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.snapshot returned an invalid frame.",
    );
  }

  return {
    frameRef: frame["frameRef"],
    parentFrameRef: frame["parentFrameRef"],
    documentId: frame["documentId"],
    url: frame["url"],
    loadState,
    availability: availability as PageFrame["availability"],
  };
}

function parsePageNode(
  value: unknown,
  allowedFrameRefs?: ReadonlySet<string>,
): PageSemanticNode {
  const node = pageRecord(value, "page semantic node");
  const state = pageRecord(node["state"], "page semantic state");
  const actionHints = node["actionHints"];
  const backgroundUrl = node["backgroundUrl"];
  const geometry = pageRecord(node["geometry"], "page node geometry");
  const parsedGeometry = {
    x: pageFiniteNumber(geometry["x"], "geometry x"),
    y: pageFiniteNumber(geometry["y"], "geometry y"),
    width: pageFiniteNumber(geometry["width"], "geometry width"),
    height: pageFiniteNumber(geometry["height"], "geometry height"),
    viewportX: pageFiniteNumber(geometry["viewportX"], "viewport x"),
    viewportY: pageFiniteNumber(geometry["viewportY"], "viewport y"),
    viewportWidth: pageFiniteNumber(
      geometry["viewportWidth"],
      "viewport width",
    ),
    viewportHeight: pageFiniteNumber(
      geometry["viewportHeight"],
      "viewport height",
    ),
  };
  const disabled = pageBooleanOrNull(state["disabled"]);
  const checked = pageBooleanOrNull(state["checked"]);
  const selected = pageBooleanOrNull(state["selected"]);
  const expanded = pageBooleanOrNull(state["expanded"]);
  const pressed = pageBooleanOrNull(state["pressed"]);
  const required = pageBooleanOrNull(state["required"]);
  const readonly = pageBooleanOrNull(state["readonly"]);

  if (
    typeof node["elementRef"] !== "string" ||
    typeof node["frameRef"] !== "string" ||
    (allowedFrameRefs !== undefined &&
      !allowedFrameRefs.has(node["frameRef"])) ||
    !(
      node["parentElementRef"] === null ||
      typeof node["parentElementRef"] === "string"
    ) ||
    !(node["role"] === null || typeof node["role"] === "string") ||
    typeof node["name"] !== "string" ||
    node["name"].length > 512 ||
    typeof node["visibleText"] !== "string" ||
    node["visibleText"].length > 512 ||
    typeof node["visible"] !== "boolean" ||
    !(
      backgroundUrl === undefined ||
      (typeof backgroundUrl === "string" &&
        backgroundUrl.length <= MAX_PAGE_STRING_CHARS &&
        /^https?:\/\//u.test(backgroundUrl))
    ) ||
    parsedGeometry.width < 0 ||
    parsedGeometry.height < 0 ||
    parsedGeometry.viewportWidth < 0 ||
    parsedGeometry.viewportHeight < 0 ||
    !["none", "open", "closed"].includes(String(node["shadowRoot"])) ||
    typeof state["editable"] !== "boolean" ||
    typeof state["invalid"] !== "boolean" ||
    !(
      state["level"] === null ||
      (typeof state["level"] === "number" &&
        Number.isSafeInteger(state["level"]))
    ) ||
    !(
      state["orientation"] === null || typeof state["orientation"] === "string"
    ) ||
    !Array.isArray(actionHints) ||
    !actionHints.every(isPageActionHint)
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "The extension returned an invalid or unbounded semantic node.",
    );
  }

  return {
    elementRef: node["elementRef"],
    frameRef: node["frameRef"],
    parentElementRef: node["parentElementRef"],
    role: node["role"],
    name: node["name"],
    visibleText: node["visibleText"],
    visible: node["visible"],
    geometry: parsedGeometry,
    shadowRoot: node["shadowRoot"] as PageSemanticNode["shadowRoot"],
    ...(typeof backgroundUrl === "string" ? { backgroundUrl } : {}),
    state: {
      disabled,
      editable: state["editable"],
      checked,
      selected,
      expanded,
      pressed,
      required,
      readonly,
      invalid: state["invalid"],
      level: state["level"],
      orientation: state["orientation"],
    },
    actionHints,
  };
}

function pageBooleanOrNull(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  throw new TransportProtocolError(
    "invalid-request",
    "The extension returned an invalid semantic boolean state.",
  );
}

function pageFiniteNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new TransportProtocolError(
    "invalid-request",
    `The extension returned an invalid ${label}.`,
  );
}

function parsePageQueryResult(
  value: unknown,
  maxResults: number,
  expectedFrameRef: string,
): PageQueryResult {
  const result = pageRecord(value, "pages.query");
  const nodes = result["nodes"];

  if (
    !Array.isArray(nodes) ||
    nodes.length > maxResults ||
    typeof result["truncated"] !== "boolean"
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.query returned an invalid or unbounded query result.",
    );
  }

  return {
    nodes: nodes.map((node) =>
      parsePageNode(node, new Set([expectedFrameRef])),
    ),
    truncated: result["truncated"],
  };
}

function parsePageMutationResult(
  value: unknown,
  expectedDocumentId: string,
): PageMutationResult {
  const result = pageRecord(value, "page mutation");

  if (
    result["performed"] !== true ||
    result["documentId"] !== expectedDocumentId
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "The extension returned an invalid page mutation result.",
    );
  }

  return { performed: true, documentId: expectedDocumentId };
}

function pageByteLimit(
  requested: number | undefined,
  maximum: number,
  label: string,
): number {
  const value = requested ?? maximum;

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TransportProtocolError(
      "invalid-request",
      `${label} maxBytes must be an integer from 1 through ${String(maximum)}.`,
    );
  }

  return value;
}

function parsePageResource(
  value: unknown,
  maxBytes: number,
  operation: string,
): PageResourceResult {
  const result = pageRecord(value, operation);
  const bytes = result["bytes"];

  if (
    typeof result["mimeType"] !== "string" ||
    result["mimeType"].length < 1 ||
    result["mimeType"].length > 512 ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > maxBytes ||
    typeof result["dataBase64"] !== "string"
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      `${operation} returned an invalid or unbounded resource.`,
    );
  }

  const decoded = Buffer.from(result["dataBase64"], "base64");

  if (
    decoded.byteLength !== bytes ||
    decoded.toString("base64") !== result["dataBase64"]
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      `${operation} returned malformed resource encoding.`,
    );
  }

  return {
    mimeType: result["mimeType"],
    bytes,
    dataBase64: result["dataBase64"],
  };
}

function parsePageScreenshot(value: unknown): PageScreenshotResult {
  const result = parsePageResource(
    value,
    MAX_PAGE_SCREENSHOT_BYTES,
    "pages.screenshot",
  );
  const record = pageRecord(value, "pages.screenshot");
  const width = record["width"];
  const height = record["height"];

  if (
    result.mimeType !== "image/png" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_PAGE_SCREENSHOT_DIMENSION ||
    height > MAX_PAGE_SCREENSHOT_DIMENSION
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.screenshot returned invalid image dimensions.",
    );
  }

  return {
    ...result,
    mimeType: "image/png",
    width,
    height,
  };
}

function parsePageMediaList(
  value: unknown,
  expectedFrameRef: string,
): PageMediaListResult {
  const result = pageRecord(value, "pages.media.list");
  const media = result["media"];

  if (
    !Array.isArray(media) ||
    media.length > MAX_PAGE_MEDIA ||
    typeof result["truncated"] !== "boolean"
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "pages.media.list returned an invalid or unbounded media list.",
    );
  }

  return {
    media: media.map((entry) => {
      const item = pageRecord(entry, "page media");
      const captions = item["captions"];
      const readyState = item["readyState"];

      if (
        typeof item["elementRef"] !== "string" ||
        item["frameRef"] !== expectedFrameRef ||
        !["audio", "video"].includes(String(item["kind"])) ||
        typeof item["sourceUrl"] !== "string" ||
        item["sourceUrl"].length > MAX_PAGE_STRING_CHARS ||
        !(
          item["duration"] === null ||
          (typeof item["duration"] === "number" &&
            Number.isFinite(item["duration"]))
        ) ||
        typeof item["currentTime"] !== "number" ||
        !Number.isFinite(item["currentTime"]) ||
        typeof item["paused"] !== "boolean" ||
        typeof item["muted"] !== "boolean" ||
        typeof item["volume"] !== "number" ||
        !Number.isFinite(item["volume"]) ||
        typeof readyState !== "number" ||
        !Number.isSafeInteger(readyState) ||
        typeof item["drm"] !== "boolean" ||
        !Array.isArray(captions) ||
        captions.length > 100
      ) {
        throw new TransportProtocolError(
          "invalid-request",
          "pages.media.list returned invalid media metadata.",
        );
      }

      return {
        elementRef: item["elementRef"],
        frameRef: expectedFrameRef,
        kind: item["kind"] as "audio" | "video",
        sourceUrl: item["sourceUrl"],
        duration: item["duration"],
        currentTime: item["currentTime"],
        paused: item["paused"],
        muted: item["muted"],
        volume: item["volume"],
        readyState,
        drm: item["drm"],
        captions: captions.map(parseCaptionTrack),
      };
    }),
    truncated: result["truncated"],
  };
}

function parseCaptionTrack(
  value: unknown,
): PageMediaListResult["media"][number]["captions"][number] {
  const track = pageRecord(value, "caption track");
  const cues = track["cues"];

  if (
    typeof track["kind"] !== "string" ||
    track["kind"].length > 64 ||
    typeof track["label"] !== "string" ||
    track["label"].length > 512 ||
    typeof track["language"] !== "string" ||
    track["language"].length > 128 ||
    !["disabled", "hidden", "showing"].includes(String(track["mode"])) ||
    !Array.isArray(cues) ||
    cues.length > 1_000 ||
    typeof track["cuesAvailable"] !== "boolean" ||
    typeof track["truncated"] !== "boolean"
  ) {
    throw new TransportProtocolError(
      "invalid-request",
      "The extension returned invalid caption metadata.",
    );
  }

  return {
    kind: track["kind"],
    label: track["label"],
    language: track["language"],
    mode: track["mode"] as "disabled" | "hidden" | "showing",
    cues: cues.map((value) => {
      const cue = pageRecord(value, "caption cue");

      if (
        typeof cue["startTime"] !== "number" ||
        !Number.isFinite(cue["startTime"]) ||
        typeof cue["endTime"] !== "number" ||
        !Number.isFinite(cue["endTime"]) ||
        typeof cue["text"] !== "string" ||
        cue["text"].length > 4_096
      ) {
        throw new TransportProtocolError(
          "invalid-request",
          "The extension returned an invalid caption cue.",
        );
      }

      return {
        startTime: cue["startTime"],
        endTime: cue["endTime"],
        text: cue["text"],
      };
    }),
    cuesAvailable: track["cuesAvailable"],
    truncated: track["truncated"],
  };
}

function isPageLoadState(value: unknown): value is PageSnapshot["loadState"] {
  return ["loading", "interactive", "complete"].includes(String(value));
}

function isPageActionHint(
  value: unknown,
): value is PageSemanticNode["actionHints"][number] {
  return (
    typeof value === "string" &&
    [
      "click",
      "fill",
      "type",
      "press",
      "select",
      "check",
      "submit",
      "upload",
      "open-background",
    ].includes(value)
  );
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
