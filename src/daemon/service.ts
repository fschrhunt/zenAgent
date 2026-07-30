import {
  entityIdKey,
  type BrowserDelta,
  type BrowserEntity,
  type BrowserEntityId,
  type BrowserSessionId,
  type BrowserSnapshot,
  type BrowserSpaceId,
  type BrowserTab,
  type BrowserTabId,
  type BrowserWindowId,
  type EntityKind,
} from "../browser/model.js";
import {
  BrowserModelError,
  BrowserRegistry,
  type EntityLookup,
} from "../browser/registry.js";
import {
  DEFAULT_DOWNLOAD_DIRECTORY,
  type ZenAgentConfig,
} from "../config/schema.js";
import {
  isSensitiveOrStatefulUrl,
  TabResolutionError,
  TabResolver,
  type ResolveTabRequest,
  type TabMatchRule,
} from "../resolution/index.js";
import { routeSpace, type ExplicitSpaceOverride } from "../routing/policy.js";
import {
  assertJsonResourceLimits,
  ResourceLimitError,
} from "../security/limits.js";
import type { TransportCapability } from "../transport/capabilities.js";
import {
  TransportProtocolError,
  type TransportErrorCode,
} from "../transport/protocol.js";
import { zenSpaceUuid } from "../transport/snapshot.js";
import type {
  PageInspection,
  ZenTransportEvent,
  ZenTransportListener,
} from "../transport/client.js";
import type {
  PageDocumentTarget,
  PageElementTarget,
  PageFrameTarget,
  PageLocator,
  PageMedia,
  PageMutationResult,
  PagePressOptions,
  PageQueryResult,
  PageMediaListResult,
  PageSnapshot,
  PageResourceResult,
  PageScreenshotOptions,
  PageScreenshotResult,
  PageUploadResult,
} from "../page/model.js";
import {
  MAX_PAGE_MEDIA_BYTES,
  MAX_PAGE_RESOURCE_BYTES,
  MAX_PAGE_UPLOAD_FILES,
} from "../page/model.js";
import {
  evaluatePageWaitCondition,
  pageWaitConditionLocator,
  PageWaitConditionError,
  validatePageWaitCondition,
  type PageWaitCondition,
} from "../page/wait.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonProtocolError,
  type DaemonErrorCode,
  type DaemonMethod,
  type DaemonRequest,
} from "./protocol.js";
import {
  silentDaemonLogger,
  type DaemonLogLevel,
  type DaemonLogger,
} from "./logger.js";
import {
  DEFAULT_TAB_LEASE_TTL_MS,
  MAX_TAB_LEASE_WAIT_MS,
  MAX_TAB_LEASE_TTL_MS,
  MIN_TAB_LEASE_TTL_MS,
  TabLeaseManager,
} from "./leases.js";
import { PageReferenceRegistry } from "./page-references.js";
import { SerialQueue } from "./serial.js";
import {
  GLOBAL_TAB_MUTATION_QUEUE_KEY,
  TabMutationQueues,
  tabMutationQueueKey,
  type TabMutationQueueKey,
} from "./tab-mutation-queues.js";
import { TemporaryTabProvenanceRegistry } from "./tab-provenance.js";
import { UploadStagingRegistry, writeAtomicResource } from "./files.js";
import {
  SpeechHelperError,
  canonicalSpeechLocale,
  transcribeAudioAsync,
} from "../cli/speech.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const DAEMON_IMPLEMENTATION_VERSION = "0.1.0";

export type DaemonConnectionState =
  | "starting"
  | "connected"
  | "reconnecting"
  | "unavailable"
  | "stopping"
  | "stopped";

/**
 * The policy-facing subset of ZenTransport.
 *
 * Keeping this structural makes the real transport injectable and allows all
 * daemon correctness tests to run without Zen or a native host.
 */
export interface DaemonTransport {
  readonly capabilities: readonly TransportCapability[];
  readonly sessionId: BrowserSessionId | undefined;
  readonly compatibility?:
    | Readonly<{
        browserVersion: string;
        geckoVersion: string;
        extensionVersion: string;
      }>
    | undefined;
  connect(): Promise<BrowserSnapshot>;
  snapshot(): Promise<BrowserSnapshot>;
  openTab(options: {
    readonly url: string;
    readonly windowId?: string;
    readonly zenSpaceUuid?: string;
  }): Promise<string>;
  moveTab(tabId: string, zenSpaceUuid: string): Promise<void>;
  navigateTab(tabId: string, url: string): Promise<void>;
  inspectPage(
    tabId: string,
    options?: { readonly maxChars?: number },
  ): Promise<PageInspection>;
  snapshotPage(
    tabId: string,
    options?: { readonly maxNodes?: number },
  ): Promise<PageSnapshot>;
  queryPage(
    target: PageFrameTarget,
    options: { readonly locator: PageLocator; readonly maxResults?: number },
  ): Promise<PageQueryResult>;
  clickPage(target: PageElementTarget): Promise<PageMutationResult>;
  fillPage(
    target: PageElementTarget,
    value: string,
  ): Promise<PageMutationResult>;
  typePage(
    target: PageElementTarget,
    value: string,
  ): Promise<PageMutationResult>;
  pressPage(
    target: PageElementTarget,
    options: PagePressOptions,
  ): Promise<PageMutationResult>;
  selectPage(
    target: PageElementTarget,
    values: readonly string[],
  ): Promise<PageMutationResult>;
  checkPage(target: PageElementTarget): Promise<PageMutationResult>;
  uncheckPage(target: PageElementTarget): Promise<PageMutationResult>;
  submitPage(target: PageElementTarget): Promise<PageMutationResult>;
  uploadPage?(
    target: PageElementTarget,
    stagedPaths: readonly string[],
  ): Promise<PageUploadResult>;
  listPageMedia?(target: PageFrameTarget): Promise<PageMediaListResult>;
  fetchPageMedia?(
    target: PageElementTarget,
    options?: { readonly maxBytes?: number },
  ): Promise<PageResourceResult>;
  fetchPageResource?(
    target: PageFrameTarget,
    url: string,
    options?: { readonly maxBytes?: number },
  ): Promise<PageResourceResult>;
  screenshotPage?(
    target: PageFrameTarget | PageElementTarget,
    options?: PageScreenshotOptions,
  ): Promise<PageScreenshotResult>;
  backPage(target: PageDocumentTarget): Promise<PageMutationResult>;
  forwardPage(target: PageDocumentTarget): Promise<PageMutationResult>;
  /** Optional until the native transport adds its explicit reload primitive. */
  reloadTab?(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  on(listener: ZenTransportListener): () => void;
  close(): void;
}

export type DaemonTransportFactory = () =>
  DaemonTransport | Promise<DaemonTransport>;

export interface DaemonStatus {
  readonly state: DaemonConnectionState;
  readonly daemonVersion: string;
  readonly protocolVersion: number;
  readonly profileId: string | null;
  readonly sessionId: string | null;
  readonly registrySequence: number | null;
  readonly capabilities: readonly TransportCapability[];
  readonly compatibility: Readonly<{
    browserVersion: string;
    geckoVersion: string;
    extensionVersion: string;
  }> | null;
  readonly privateWindowPolicy: "hidden" | "explicit";
  readonly counts: Readonly<{
    profiles: number;
    sessions: number;
    windows: number;
    spaces: number;
    tabs: number;
  }>;
  readonly reconnectAttempts: number;
}

export interface DaemonServiceEvent {
  readonly event: "registry.updated" | "status.changed" | "daemon.stopping";
  readonly payload: unknown;
}

export interface DaemonServiceOptions {
  readonly transportFactory: DaemonTransportFactory;
  /** Expected transport profile id. A mismatch is refused, never guessed. */
  readonly profileId?: string;
  readonly reconcileIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly idempotencyTtlMs?: number;
  readonly maxIdempotencyEntries?: number;
  readonly logger?: DaemonLogger;
  /** Routing policy used by tabs.resolve when no stable Space ID is supplied. */
  readonly config?: ZenAgentConfig;
  /** Reloads the validated routing config after an atomic config-file update. */
  readonly configLoader?: () => Promise<ZenAgentConfig | undefined>;
  /** Test seam around the bundled on-device speech helper. */
  readonly transcribeAudio?: typeof transcribeAudioAsync;
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly result: Promise<unknown>;
}

interface ActiveOperation {
  readonly clientId: string;
  readonly controller: AbortController;
  readonly tabId?: BrowserTabId;
}

const READ_METHODS: readonly DaemonMethod[] = [
  "health",
  "version",
  "capabilities",
  "status",
  "registry.entities",
  "registry.lookup",
  "pages.inspect",
  "pages.snapshot",
  "pages.query",
  "pages.wait",
  "pages.screenshot",
  "pages.media.list",
  "operations.cancel",
];

const MUTATION_METHODS: readonly DaemonMethod[] = [
  "config.reload",
  "tabs.resolve",
  "tabs.open",
  "tabs.navigate",
  "tabs.reload",
  "tabs.close",
  "tabs.cleanup",
  "tabs.move",
  "tabs.lease.renew",
  "tabs.lease.release",
  "pages.click",
  "pages.fill",
  "pages.type",
  "pages.press",
  "pages.select",
  "pages.check",
  "pages.uncheck",
  "pages.submit",
  "pages.upload",
  "pages.media.transcribe",
  "pages.resource.download",
  "pages.back",
  "pages.forward",
];

const ENTITY_KINDS: readonly EntityKind[] = [
  "profile",
  "session",
  "window",
  "space",
  "tab",
  "browsing-context",
  "frame",
  "element",
];

const TAB_MATCH_RULES: readonly TabMatchRule[] = [
  "exact-url",
  "normalized-url",
  "origin",
  "domain",
  "title",
  "query",
];

export class DaemonService {
  readonly #options: DaemonServiceOptions;
  readonly #logger: DaemonLogger;
  readonly #mutationQueues = new TabMutationQueues();
  readonly #registryQueue = new SerialQueue();
  readonly #listeners = new Set<(event: DaemonServiceEvent) => void>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #leases = new TabLeaseManager();
  readonly #pageReferences = new PageReferenceRegistry();
  readonly #tabProvenance = new TemporaryTabProvenanceRegistry();
  readonly #uploadStaging = new UploadStagingRegistry();
  readonly #activeOperations = new Map<string, ActiveOperation>();

  #state: DaemonConnectionState = "stopped";
  #transport: DaemonTransport | undefined;
  #unsubscribeTransport: (() => void) | undefined;
  #registry: BrowserRegistry | undefined;
  #reconcileTimer: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #connectPromise: Promise<void> | undefined;
  #config: ZenAgentConfig | undefined;
  #generation = 0;
  #reconnectAttempts = 0;

  public constructor(options: DaemonServiceOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentDaemonLogger;
    this.#config = options.config;
  }

  public get state(): DaemonConnectionState {
    return this.#state;
  }

  public on(listener: (event: DaemonServiceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Releases process-local resources after the socket that established a
   * client identity closes. Lease waits are outside the browser mutation queue,
   * so abort and release them synchronously before queueing the remaining
   * cleanup. Temporary-tab provenance deliberately survives disconnect; a
   * disconnect never closes browser tabs.
   */
  public async disconnectClient(clientId: string): Promise<void> {
    for (const operation of this.#activeOperations.values()) {
      if (operation.clientId === clientId) {
        operation.controller.abort();
      }
    }
    this.#leases.releaseClient(clientId);

    // Work already dispatched to the browser cannot be truthfully cancelled or
    // replayed. Let accepted operations settle before releasing staged files.
    await this.#mutationQueues.idle();
    this.#pageReferences.releaseClient(clientId);
    await this.#uploadStaging.releaseClient(clientId);
    const prefix = `${clientId}\u0000`;

    for (const key of this.#idempotency.keys()) {
      if (key.startsWith(prefix)) {
        this.#idempotency.delete(key);
      }
    }
  }

  /**
   * Starts on demand. Browser absence does not prevent the local daemon from
   * answering health/status; it enters unavailable and reconnects.
   */
  public async start(): Promise<void> {
    if (this.#state !== "stopped") {
      return;
    }

    this.#setState("starting");
    await this.#connectOnce();

    const interval = this.#options.reconcileIntervalMs ?? 30_000;

    if (interval > 0) {
      this.#reconcileTimer = setInterval(() => {
        void this.refresh().catch(() => undefined);
      }, interval);
      this.#reconcileTimer.unref?.();
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "stopping") {
      return;
    }

    this.#setState("stopping");
    this.#emit({ event: "daemon.stopping", payload: {} });
    this.#generation += 1;

    if (this.#reconcileTimer !== undefined) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = undefined;
    }

    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }

    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;
    this.#transport?.close();
    this.#transport = undefined;
    await Promise.all([
      this.#mutationQueues.idle(),
      this.#registryQueue.idle(),
    ]);
    this.#leases.clear();
    this.#pageReferences.clear();
    this.#tabProvenance.clear();
    await this.#uploadStaging.clear();
    for (const operation of this.#activeOperations.values()) {
      operation.controller.abort();
    }
    this.#activeOperations.clear();
    this.#idempotency.clear();
    this.#setState("stopped");
  }

  public status(): DaemonStatus {
    const registry = this.#registry;
    const session = registry
      ?.entities("session")
      .find((entity) => entity.kind === "session");
    const profile = registry
      ?.entities("profile")
      .find((entity) => entity.kind === "profile");

    return {
      state: this.#state,
      daemonVersion: DAEMON_IMPLEMENTATION_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      profileId: profile?.id.transportId ?? this.#options.profileId ?? null,
      sessionId:
        session !== undefined && session.kind === "session"
          ? session.id.transportId
          : null,
      registrySequence:
        registry === undefined || registry.sequence < 0
          ? null
          : registry.sequence,
      capabilities: [...(this.#transport?.capabilities ?? [])],
      compatibility: this.#transport?.compatibility ?? null,
      privateWindowPolicy: this.#config?.privateWindows ?? "hidden",
      counts: {
        profiles: registry?.entities("profile").length ?? 0,
        sessions: registry?.entities("session").length ?? 0,
        windows: registry?.entities("window").length ?? 0,
        spaces: registry?.entities("space").length ?? 0,
        tabs: registry?.entities("tab").length ?? 0,
      },
      reconnectAttempts: this.#reconnectAttempts,
    };
  }

  public async refresh(): Promise<void> {
    const transport = this.#requireTransport();
    const generation = this.#generation;
    const snapshot = await transport.snapshot();

    if (generation !== this.#generation || transport !== this.#transport) {
      return;
    }

    await this.#acceptSnapshot(snapshot, false);
  }

  /**
   * Dispatches one parsed client request. Reads bypass the mutation queue;
   * browser mutations are FIFO and retryable mutations are deduplicated by a
   * client-scoped idempotency key.
   */
  public async handle(request: DaemonRequest): Promise<unknown> {
    try {
      assertJsonResourceLimits(request.params);
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        throw new DaemonProtocolError("payload-too-large", error.message, {
          limit: error.limit,
        });
      }

      throw error;
    }

    this.#logger.log("debug", "daemon", "request.received", {
      clientId: request.clientId,
      operationId: request.id,
      data: { method: request.method },
    });

    if ((READ_METHODS as readonly string[]).includes(request.method)) {
      return this.#handleRead(request);
    }

    if (request.method === "tabs.lease.acquire") {
      if (request.idempotencyKey === undefined) {
        throw new DaemonProtocolError(
          "invalid-request",
          "tabs.lease.acquire requires an idempotency key.",
        );
      }

      return this.#idempotent(request, () => this.#handleLeaseAcquire(request));
    }

    if ((MUTATION_METHODS as readonly string[]).includes(request.method)) {
      if (request.idempotencyKey === undefined) {
        throw new DaemonProtocolError(
          "invalid-request",
          `${request.method} requires an idempotency key.`,
        );
      }

      const queueKey = this.#mutationQueueKey(request);
      return this.#idempotent(request, () =>
        this.#scheduleMutation(request, queueKey),
      );
    }

    switch (request.method) {
      case "registry.refresh":
        await this.refresh();
        return { refreshed: true, registrySequence: this.#registry?.sequence };
      case "daemon.shutdown":
        // Let the socket server send the response before it observes this
        // event and closes listeners.
        queueMicrotask(() => {
          this.#emit({
            event: "daemon.stopping",
            payload: { requested: true },
          });
        });
        return { stopping: true };
      default:
        throw new DaemonProtocolError(
          "method-not-found",
          `Unknown daemon method ${JSON.stringify(request.method)}.`,
        );
    }
  }

  async #handleRead(request: DaemonRequest): Promise<unknown> {
    switch (request.method) {
      case "health":
        return {
          ok: true,
          state: this.#state,
          browserConnected: this.#state === "connected",
        };
      case "version":
        return {
          daemonVersion: DAEMON_IMPLEMENTATION_VERSION,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        };
      case "capabilities":
        return {
          browserConnected: this.#state === "connected",
          capabilities: [...(this.#transport?.capabilities ?? [])],
        };
      case "status":
        return this.status();
      case "registry.entities": {
        const params = optionalRecord(request.params);
        const kind = params?.["kind"];

        if (
          kind !== undefined &&
          (typeof kind !== "string" ||
            !(ENTITY_KINDS as readonly string[]).includes(kind))
        ) {
          throw new DaemonProtocolError(
            "invalid-request",
            "registry.entities kind is not a browser entity kind.",
          );
        }

        return {
          sequence: this.#requireRegistry().sequence,
          entities: this.#requireRegistry().entities(
            typeof kind === "string" ? (kind as EntityKind) : undefined,
          ),
        };
      }
      case "registry.lookup": {
        const params = requireRecord(request.params);
        const id = requireEntityId(params["id"]);
        return {
          sequence: this.#requireRegistry().sequence,
          lookup: this.#requireRegistry().lookup(id),
        };
      }
      case "pages.inspect": {
        const params = requireRecord(request.params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#activeTab(tabId);
        const maxChars = optionalPositiveInteger(params, "maxChars", 10_000);

        return this.#requireTransport().inspectPage(tab.id.transportId, {
          ...(maxChars === undefined ? {} : { maxChars }),
        });
      }
      case "pages.snapshot": {
        const params = requireRecord(request.params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#activeTab(tabId);
        const maxNodes = optionalPositiveInteger(params, "maxNodes", 5_000);
        const snapshot = await this.#requireTransport().snapshotPage(
          tab.id.transportId,
          maxNodes === undefined ? {} : { maxNodes },
        );
        this.#pageReferences.remember(request.clientId, tab.id, snapshot);
        return { ...snapshot, tabId: tab.id };
      }
      case "pages.query": {
        const params = requireRecord(request.params);
        const target = requireDaemonPageFrameTarget(params["target"]);
        const tab = this.#activeTab(target.tabId);
        this.#pageReferences.assertOwned(request.clientId, target);
        const locator = requirePageLocator(params["locator"]);
        const maxResults = optionalPositiveInteger(params, "maxResults", 100);
        return this.#requireTransport().queryPage(
          {
            ...target,
            tabId: tab.id.transportId,
          },
          {
            locator,
            ...(maxResults === undefined ? {} : { maxResults }),
          },
        );
      }
      case "pages.screenshot": {
        const params = requireRecord(request.params);
        const rawTarget = requireRecord(params["target"]);
        const target =
          typeof rawTarget["elementRef"] === "string"
            ? requireDaemonPageElementTarget(rawTarget)
            : requireDaemonPageFrameTarget(rawTarget);
        const tab = this.#activeTab(target.tabId);
        this.#pageReferences.assertOwned(request.clientId, target);
        const transport = this.#requireTransport();

        if (transport.screenshotPage === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport has not proven background screenshots.",
          );
        }

        return transport.screenshotPage(
          { ...target, tabId: tab.id.transportId },
          {
            ...optionalNumberProperty(params, "scale"),
            ...optionalStringProperty(params, "background"),
          },
        );
      }
      case "pages.media.list": {
        const params = requireRecord(request.params);
        const target = requireDaemonPageFrameTarget(params["target"]);
        const tab = this.#activeTab(target.tabId);
        this.#pageReferences.assertOwned(request.clientId, target);
        const transport = this.#requireTransport();

        if (transport.listPageMedia === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport does not expose bounded page media.",
          );
        }

        return transport.listPageMedia({
          ...target,
          tabId: tab.id.transportId,
        });
      }
      case "pages.wait": {
        const params = requireRecord(request.params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#activeTab(tabId);
        let condition: PageWaitCondition;

        try {
          condition = validatePageWaitCondition(params["condition"]);
        } catch (error) {
          if (error instanceof PageWaitConditionError) {
            throw new DaemonProtocolError("invalid-request", error.message);
          }
          throw error;
        }

        const timeoutMs =
          optionalPositiveInteger(params, "timeoutMs", 60_000) ?? 10_000;
        const pollIntervalMs =
          optionalPositiveInteger(params, "pollIntervalMs", 2_000) ?? 250;
        const maxNodes =
          optionalPositiveInteger(params, "maxNodes", 5_000) ?? 1_000;

        if (pollIntervalMs < 100) {
          throw new DaemonProtocolError(
            "invalid-request",
            "pollIntervalMs must be an integer from 100 through 2000.",
          );
        }

        const operationKey = activeOperationKey(request.clientId, request.id);

        if (this.#activeOperations.has(operationKey)) {
          throw new DaemonProtocolError(
            "invalid-request",
            "The operation identifier is already active.",
          );
        }

        const controller = new AbortController();
        this.#activeOperations.set(operationKey, {
          clientId: request.clientId,
          controller,
          tabId: tab.id,
        });

        try {
          return await this.#waitForPage(
            request.clientId,
            tab,
            condition,
            timeoutMs,
            pollIntervalMs,
            maxNodes,
            controller.signal,
          );
        } finally {
          this.#activeOperations.delete(operationKey);
        }
      }
      case "operations.cancel": {
        const params = requireRecord(request.params);
        const operationId = requireString(params, "operationId");
        const operation = this.#activeOperations.get(
          activeOperationKey(request.clientId, operationId),
        );

        if (operation === undefined) {
          return { cancelled: false, operationId };
        }

        operation.controller.abort();
        return { cancelled: true, operationId };
      }
      default:
        throw new DaemonProtocolError(
          "method-not-found",
          `Unknown read method ${JSON.stringify(request.method)}.`,
        );
    }
  }

  async #handleLeaseAcquire(request: DaemonRequest): Promise<unknown> {
    this.#requireTransport();
    const params = requireRecord(request.params);
    const tabId = requireEntityIdOfKind(params["tabId"], "tab");
    const tab = this.#leasableTab(tabId);
    const waitMs =
      optionalNonnegativeInteger(params, "waitMs", MAX_TAB_LEASE_WAIT_MS) ?? 0;
    const operationKey = activeOperationKey(request.clientId, request.id);
    const controller = new AbortController();

    if (this.#activeOperations.has(operationKey)) {
      throw new DaemonProtocolError(
        "invalid-request",
        "The operation identifier is already active.",
      );
    }

    this.#activeOperations.set(operationKey, {
      clientId: request.clientId,
      controller,
      tabId: tab.id,
    });

    try {
      const lease = await this.#leases.acquireWhenAvailable(
        request.clientId,
        tab.id,
        tabLeaseTtlMs(params),
        waitMs,
        controller.signal,
      );

      // The tab can become selected, start media, crash, or disappear while
      // this request waits. Recheck before exposing ownership.
      this.#leasableTab(tab.id);
      return { lease };
    } catch (error) {
      if (
        error instanceof DaemonProtocolError &&
        (error.code === "browser-unavailable" ||
          error.data?.["reason"] === "selected-tab" ||
          error.data?.["reason"] === "crashed" ||
          error.data?.["reason"] === "not-active")
      ) {
        this.#leases.revokeTab(tab.id, error);
      }

      throw error;
    } finally {
      this.#activeOperations.delete(operationKey);
    }
  }

  async #handleMutation(
    request: DaemonRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal !== undefined) {
      assertNotCancelled(signal);
    }
    const params = requireRecord(request.params);

    switch (request.method) {
      case "tabs.lease.renew": {
        const leaseId = requireString(params, "leaseId");
        const lease = this.#leases.renew(
          request.clientId,
          leaseId,
          tabLeaseTtlMs(params),
        );

        try {
          this.#leasableTab(lease.tabId);
        } catch (error) {
          this.#leases.revokeTab(
            lease.tabId,
            error instanceof DaemonProtocolError
              ? error
              : new DaemonProtocolError(
                  "internal",
                  "The daemon could not confirm that the leased tab is safe.",
                  { resource: "lease", retryable: true },
                ),
          );
          throw error;
        }

        return { lease };
      }
      case "tabs.lease.release": {
        const lease = this.#leases.release(
          request.clientId,
          requireString(params, "leaseId"),
        );
        await this.#uploadStaging.releaseLease(request.clientId, lease.leaseId);
        return {
          released: true,
          leaseId: lease.leaseId,
          tabId: lease.tabId,
        };
      }
    }

    const transport = this.#requireTransport();

    switch (request.method) {
      case "pages.click":
      case "pages.check":
      case "pages.uncheck":
      case "pages.submit": {
        const target = this.#pageElementMutationTarget(request, params);
        const result = await (request.method === "pages.click"
          ? transport.clickPage(target)
          : request.method === "pages.check"
            ? transport.checkPage(target)
            : request.method === "pages.uncheck"
              ? transport.uncheckPage(target)
              : transport.submitPage(target));
        this.#markPageMutationChanged(params);
        return result;
      }
      case "pages.fill":
      case "pages.type": {
        const target = this.#pageElementMutationTarget(request, params);
        const value =
          request.method === "pages.fill"
            ? requireBoundedString(params, "value", 64 * 1024, true)
            : requireBoundedString(params, "value", 64 * 1024, false);
        const result = await (request.method === "pages.fill"
          ? transport.fillPage(target, value)
          : transport.typePage(target, value));
        this.#markPageMutationChanged(params);
        return result;
      }
      case "pages.press": {
        const target = this.#pageElementMutationTarget(request, params);
        const result = await transport.pressPage(target, {
          key: requireString(params, "key"),
          ...optionalStringProperty(params, "code"),
          ...optionalBooleanProperty(params, "altKey"),
          ...optionalBooleanProperty(params, "ctrlKey"),
          ...optionalBooleanProperty(params, "metaKey"),
          ...optionalBooleanProperty(params, "shiftKey"),
        });
        this.#markPageMutationChanged(params);
        return result;
      }
      case "pages.select": {
        const target = this.#pageElementMutationTarget(request, params);
        const values = requireStringArray(
          params["values"],
          "values",
          100,
          true,
        );
        const result = await transport.selectPage(target, values);
        this.#markPageMutationChanged(params);
        return result;
      }
      case "pages.upload": {
        const daemonTarget = requireDaemonPageElementTarget(params["target"]);
        const target = this.#pageElementMutationTarget(request, params);
        const leaseId = requireString(params, "leaseId");
        const sourcePaths = requireStringArray(
          params["paths"],
          "paths",
          MAX_PAGE_UPLOAD_FILES,
        );

        if (transport.uploadPage === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport does not expose background file uploads.",
          );
        }

        const staged = await this.#uploadStaging.stage(
          request.clientId,
          daemonTarget.tabId,
          leaseId,
          sourcePaths,
        );

        try {
          if (signal !== undefined) {
            assertNotCancelled(signal);
          }
          const result = await transport.uploadPage(
            target,
            staged.files.map((file) => file.path),
          );
          this.#markPageMutationChanged(params);
          return result;
        } catch (error) {
          await this.#uploadStaging.release(request.clientId, staged.stagingId);
          throw error;
        }
      }
      case "pages.media.transcribe": {
        const target = requireDaemonPageElementTarget(params["target"]);
        const tab = this.#activeTab(target.tabId);
        this.#pageReferences.assertOwned(request.clientId, target);
        const locale = canonicalDaemonSpeechLocale(
          requireString(params, "locale"),
        );
        const maxBytes =
          optionalPositiveInteger(params, "maxBytes", MAX_PAGE_MEDIA_BYTES) ??
          MAX_PAGE_MEDIA_BYTES;

        if (transport.listPageMedia === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport does not expose bounded page media.",
          );
        }

        const transportTarget = {
          ...target,
          tabId: tab.id.transportId,
        };
        const media = findTargetMedia(
          await cancellableResult(
            transport.listPageMedia(transportTarget),
            signal ?? new AbortController().signal,
          ),
          target,
        );
        const captions = captionTranscript(media, locale);

        if (captions !== undefined) {
          return {
            source: "captions",
            locale,
            text: captions.text,
            truncated: captions.truncated,
            mediaElementRef: target.elementRef,
          };
        }

        if (media.drm) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "Protected media cannot be passed to on-device transcription.",
            {
              reason: "drm-media",
              resource: "media",
              retryable: false,
              userActionRequired: true,
            },
          );
        }

        assertSpeechModelInstalled(this.#config, locale);

        if (transport.fetchPageMedia === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport cannot fetch bounded media bytes.",
          );
        }

        const resource = await cancellableResult(
          transport.fetchPageMedia(transportTarget, {
            maxBytes,
          }),
          signal ?? new AbortController().signal,
        );
        const bytes = decodeBoundedResource(resource, maxBytes, "media");
        const temporaryRoot = await mkdtemp(join(tmpdir(), "zen-agent-media-"));
        const inputPath = join(
          temporaryRoot,
          `input${resourceFileExtension(resource.mimeType)}`,
        );

        try {
          await writeFile(inputPath, bytes, { mode: 0o600, flag: "wx" });
          const transcript = await (
            this.#options.transcribeAudio ?? transcribeAudioAsync
          )(locale, inputPath, signal === undefined ? {} : { signal });

          if (transcript.locale !== locale) {
            throw new DaemonProtocolError(
              "internal",
              "The on-device speech helper returned an unexpected locale.",
              { reason: "speech-locale-mismatch", resource: "speech-helper" },
            );
          }

          const bounded = boundedTranscript(transcript.text);
          return {
            source: "on-device-speech",
            locale,
            text: bounded.text,
            truncated: bounded.truncated,
            mediaElementRef: target.elementRef,
          };
        } catch (error) {
          if (error instanceof SpeechHelperError) {
            throw mapSpeechHelperError(error);
          }
          throw error;
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }
      case "pages.resource.download": {
        const target = requireDaemonPageFrameTarget(params["target"]);
        const tab = this.#activeTab(target.tabId);
        this.#pageReferences.assertOwned(request.clientId, target);
        const url = requireString(params, "url");
        const maxBytes =
          optionalPositiveInteger(
            params,
            "maxBytes",
            MAX_PAGE_RESOURCE_BYTES,
          ) ?? MAX_PAGE_RESOURCE_BYTES;
        const downloadDirectory =
          this.#config?.downloads?.directory ?? DEFAULT_DOWNLOAD_DIRECTORY;

        if (transport.fetchPageResource === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport cannot fetch bounded page resources.",
          );
        }

        const resource = await cancellableResult(
          transport.fetchPageResource(
            { ...target, tabId: tab.id.transportId },
            url,
            { maxBytes },
          ),
          signal ?? new AbortController().signal,
        );
        const bytes = decodeBoundedResource(resource, maxBytes, "resource");
        if (signal !== undefined) {
          assertNotCancelled(signal);
        }
        const explicitName = optionalString(params, "fileName");
        const written = await writeAtomicResource({
          directory: downloadDirectory,
          fileName:
            explicitName ??
            `download${resourceFileExtension(resource.mimeType)}`,
          bytes,
          maxBytes,
        });
        return {
          path: written.path,
          bytes: written.bytesWritten,
          mimeType: resource.mimeType,
        };
      }
      case "pages.back":
      case "pages.forward": {
        const target = requireDaemonPageDocumentTarget(params["target"]);
        const tab = this.#safeMutationTab(target.tabId, request.clientId);
        this.#leases.assertOwned(
          request.clientId,
          requireString(params, "leaseId"),
          tab.id,
        );
        this.#pageReferences.releaseTab(tab.id);
        await this.#uploadStaging.releaseTab(tab.id);
        const transportTarget = {
          tabId: tab.id.transportId,
          documentId: target.documentId,
        };
        const result = await (request.method === "pages.back"
          ? transport.backPage(transportTarget)
          : transport.forwardPage(transportTarget));
        this.#tabProvenance.markChanged(tab.id);
        return result;
      }
      case "config.reload": {
        const loader = this.#options.configLoader;

        if (loader === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "This daemon was not started with a configuration source.",
          );
        }

        const config = await loader();
        const profileId = this.status().profileId;

        if (
          config !== undefined &&
          profileId !== null &&
          config.profile !== profileId
        ) {
          throw new DaemonProtocolError(
            "policy-rejection",
            "The updated configuration targets a different Zen profile.",
          );
        }

        this.#config = config;
        return {
          loaded: config !== undefined,
          profileId: config?.profile ?? profileId,
        };
      }
      case "tabs.resolve": {
        if (params["url"] === undefined) {
          await this.#freshSnapshot();
          return this.#resolveQuery(params);
        }

        const temporary = optionalBoolean(params, "temporary") === true;
        const resolutionRequest = this.#resolutionRequest(params);
        const resolver = new TabResolver({
          snapshot: () => this.#freshSnapshot(),
          openTab: async (options) => {
            if (temporary) {
              this.#tabProvenance.assertCapacity(request.clientId);
            }

            const activeWindow = this.#activeEntity(options.windowId, "window");
            const activeSpace = this.#activeEntity(options.spaceId, "space");
            const tabTransportId = await transport.openTab({
              url: options.url,
              windowId: activeWindow.id.transportId,
              zenSpaceUuid: zenSpaceUuid(activeSpace.id.transportId),
            });
            await this.#freshSnapshot();
            const opened = this.#findTransportEntity("tab", tabTransportId);

            if (opened === undefined || opened.kind !== "tab") {
              throw new DaemonProtocolError(
                "internal",
                "Zen opened a tab but the refreshed registry did not contain it.",
              );
            }

            if (temporary) {
              this.#tabProvenance.remember(
                request.clientId,
                opened.id,
                options.url,
              );
            }

            return opened.id;
          },
          navigateTab: async (tabId, url) => {
            const tab = this.#safeMutationTab(tabId, request.clientId);
            this.#pageReferences.releaseTab(tab.id);
            await this.#uploadStaging.releaseTab(tab.id);
            await transport.navigateTab(tab.id.transportId, url);
            await this.#freshSnapshot();
          },
        });
        const result = await resolver
          .resolve(resolutionRequest)
          .catch((error: unknown) => {
            if (error instanceof TabResolutionError) {
              throw new DaemonProtocolError(
                error.code === "invalid-created-tab-id"
                  ? "internal"
                  : "stale-id",
                error.message,
                { reason: error.code },
              );
            }

            if (error instanceof TypeError) {
              throw new DaemonProtocolError("invalid-request", error.message);
            }

            throw error;
          });

        if (result.status === "reused") {
          this.#tabProvenance.markReused(result.tabId);
        }

        return result;
      }
      case "tabs.open": {
        const url = requireString(params, "url");
        const temporary = optionalBoolean(params, "temporary") === true;
        const windowId = requireEntityIdOfKind(params["windowId"], "window");
        const window = this.#activeEntity(windowId, "window");
        const spaceId = requireEntityIdOfKind(params["spaceId"], "space");
        const space = this.#activeEntity(spaceId, "space");

        if (
          space.kind !== "space" ||
          window.kind !== "window" ||
          entityIdKey(space.windowId) !== entityIdKey(window.id)
        ) {
          throw new DaemonProtocolError(
            "policy-rejection",
            "The requested Space does not belong to the requested window.",
          );
        }

        if (temporary) {
          this.#tabProvenance.assertCapacity(request.clientId);
        }

        const tabTransportId = await transport.openTab({
          url,
          windowId: windowId.transportId,
          zenSpaceUuid: zenSpaceUuid(spaceId.transportId),
        });
        await this.refresh();
        const opened = this.#findTransportEntity("tab", tabTransportId);

        if (temporary && opened?.kind === "tab") {
          this.#tabProvenance.remember(request.clientId, opened.id, url);
        }

        return {
          outcome: "opened",
          tabId: opened?.id ?? null,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.navigate": {
        this.#assertExpectedRegistrySequence(params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#safeMutationTab(tabId, request.clientId);
        const url = requireString(params, "url");
        this.#pageReferences.releaseTab(tab.id);
        await this.#uploadStaging.releaseTab(tab.id);
        this.#assertExpectedRegistrySequence(params);
        await transport.navigateTab(tab.id.transportId, url);
        this.#tabProvenance.markChanged(tab.id);
        await this.refresh();
        return {
          outcome: "navigated",
          tabId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.reload": {
        this.#assertExpectedRegistrySequence(params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#safeMutationTab(tabId, request.clientId);

        if (transport.reloadTab === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport does not expose explicit background tab reload yet.",
          );
        }

        this.#pageReferences.releaseTab(tab.id);
        await this.#uploadStaging.releaseTab(tab.id);
        this.#assertExpectedRegistrySequence(params);
        await transport.reloadTab(tab.id.transportId);
        this.#tabProvenance.markChanged(tab.id);
        await this.refresh();
        return {
          outcome: "reloaded",
          tabId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.close": {
        this.#assertExpectedRegistrySequence(params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#safeMutationTab(tabId, request.clientId);
        await transport.closeTab(tab.id.transportId);
        this.#leases.revokeTab(tab.id, closedTab());
        this.#pageReferences.releaseTab(tab.id);
        await this.#uploadStaging.releaseTab(tab.id);
        this.#tabProvenance.releaseTab(tab.id);
        await this.refresh();
        return {
          outcome: "closed",
          tabId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.cleanup": {
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#activeTab(tabId);
        const action = optionalCleanupAction(params);

        if (action === "keep") {
          this.#tabProvenance.release(request.clientId, tab.id);
          return {
            outcome: "kept",
            tabId: tab.id,
            reason: "explicit-keep",
          };
        }

        const eligibility = this.#tabProvenance.cleanupEligibility(
          request.clientId,
          tab,
        );

        if (!eligibility.eligible) {
          return {
            outcome: "kept",
            tabId: tab.id,
            reason: eligibility.reason,
          };
        }

        this.#assertExpectedRegistrySequence(params);
        const safeTab = this.#safeMutationTab(tab.id, request.clientId);
        await transport.closeTab(safeTab.id.transportId);
        this.#leases.revokeTab(safeTab.id, closedTab());
        this.#pageReferences.releaseTab(safeTab.id);
        await this.#uploadStaging.releaseTab(safeTab.id);
        this.#tabProvenance.release(request.clientId, safeTab.id);
        await this.refresh();
        return {
          outcome: "closed",
          tabId: safeTab.id,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.move": {
        this.#assertExpectedRegistrySequence(params);
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const spaceId = requireEntityIdOfKind(params["spaceId"], "space");
        const tab = this.#safeMutationTab(tabId, request.clientId);
        const space = this.#activeEntity(spaceId, "space");

        if (
          tab.kind !== "tab" ||
          space.kind !== "space" ||
          entityIdKey(tab.windowId) !== entityIdKey(space.windowId)
        ) {
          throw new DaemonProtocolError(
            "policy-rejection",
            "A tab may only move to a Space in its current window.",
          );
        }

        await transport.moveTab(
          tab.id.transportId,
          zenSpaceUuid(space.id.transportId),
        );
        this.#tabProvenance.markChanged(tab.id);
        await this.refresh();
        return {
          outcome: "moved",
          tabId,
          spaceId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      default:
        throw new DaemonProtocolError(
          "method-not-found",
          `Unknown mutation method ${JSON.stringify(request.method)}.`,
        );
    }
  }

  #mutationQueueKey(request: DaemonRequest): TabMutationQueueKey {
    const tabId = this.#mutationTabId(request);
    return tabId === undefined
      ? GLOBAL_TAB_MUTATION_QUEUE_KEY
      : tabMutationQueueKey(tabId.transportId);
  }

  #mutationTabId(request: DaemonRequest): BrowserTabId | undefined {
    const params = requireRecord(request.params);

    switch (request.method) {
      case "tabs.lease.renew":
      case "tabs.lease.release":
        return this.#leases.ownedTabId(
          request.clientId,
          requireString(params, "leaseId"),
        );
      case "pages.click":
      case "pages.fill":
      case "pages.type":
      case "pages.press":
      case "pages.select":
      case "pages.check":
      case "pages.uncheck":
      case "pages.submit":
      case "pages.upload":
      case "pages.media.transcribe":
        return requireDaemonPageElementTarget(params["target"]).tabId;
      case "pages.resource.download":
        return requireDaemonPageFrameTarget(params["target"]).tabId;
      case "pages.back":
      case "pages.forward":
        return requireDaemonPageDocumentTarget(params["target"]).tabId;
      case "tabs.navigate":
      case "tabs.reload":
      case "tabs.close":
      case "tabs.cleanup":
      case "tabs.move":
        return requireEntityIdOfKind(params["tabId"], "tab");
      case "config.reload":
      case "tabs.resolve":
      case "tabs.open":
        return undefined;
      default:
        throw new DaemonProtocolError(
          "method-not-found",
          `Unknown mutation method ${JSON.stringify(request.method)}.`,
        );
    }
  }

  #scheduleMutation(
    request: DaemonRequest,
    queueKey: TabMutationQueueKey,
  ): Promise<unknown> {
    const operationKey = activeOperationKey(request.clientId, request.id);

    if (this.#activeOperations.has(operationKey)) {
      throw new DaemonProtocolError(
        "invalid-request",
        "The operation identifier is already active.",
      );
    }

    const controller = new AbortController();
    const tabId = this.#mutationTabId(request);
    this.#activeOperations.set(operationKey, {
      clientId: request.clientId,
      controller,
      ...(tabId === undefined ? {} : { tabId }),
    });

    let result: Promise<unknown>;
    try {
      result = this.#mutationQueues.schedule(queueKey, () =>
        this.#handleMutation(request, controller.signal),
      );
    } catch (error) {
      this.#activeOperations.delete(operationKey);
      throw error;
    }

    return result.finally(() => {
      const active = this.#activeOperations.get(operationKey);
      if (active?.controller === controller) {
        this.#activeOperations.delete(operationKey);
      }
    });
  }

  #idempotent(
    request: DaemonRequest,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = `${request.clientId}\u0000${request.method}\u0000${request.idempotencyKey ?? ""}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request.params ?? null))
      .digest("base64url");
    const now = Date.now();
    this.#pruneIdempotency(now);
    const existing = this.#idempotency.get(key);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new DaemonProtocolError(
          "invalid-request",
          "An idempotency key was reused with different parameters.",
        );
      }

      return existing.result;
    }

    const result = operation();
    this.#idempotency.set(key, {
      fingerprint,
      expiresAt: now + (this.#options.idempotencyTtlMs ?? 5 * 60_000),
      result,
    });
    return result;
  }

  #pruneIdempotency(now: number): void {
    for (const [key, entry] of this.#idempotency) {
      if (entry.expiresAt <= now) {
        this.#idempotency.delete(key);
      }
    }

    const maximum = Math.max(1, this.#options.maxIdempotencyEntries ?? 1_000);

    while (this.#idempotency.size >= maximum) {
      const oldest = this.#idempotency.keys().next().value;

      if (typeof oldest !== "string") {
        break;
      }

      this.#idempotency.delete(oldest);
    }
  }

  async #connectOnce(): Promise<void> {
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }

    const generation = ++this.#generation;
    const connect = async (): Promise<void> => {
      let transport: DaemonTransport | undefined;
      let unsubscribe: (() => void) | undefined;

      try {
        const connectedTransport = await this.#options.transportFactory();
        transport = connectedTransport;

        if (generation !== this.#generation || this.#isStopping()) {
          connectedTransport.close();
          return;
        }

        unsubscribe = connectedTransport.on((event) => {
          this.#onTransportEvent(generation, connectedTransport, event);
        });
        const snapshot = await connectedTransport.connect();

        if (generation !== this.#generation || this.#isStopping()) {
          unsubscribe();
          connectedTransport.close();
          return;
        }

        this.#transport = connectedTransport;
        this.#unsubscribeTransport = unsubscribe;
        await this.#acceptSnapshot(snapshot, this.#registry === undefined);
        this.#reconnectAttempts = 0;
        this.#setState("connected");
        this.#logger.log("info", "transport", "connected", {
          data: {
            capabilities: connectedTransport.capabilities.length,
            registrySequence: this.#registry?.sequence ?? -1,
          },
        });
      } catch (error) {
        unsubscribe?.();

        if (transport === this.#transport) {
          this.#transport = undefined;
          this.#unsubscribeTransport = undefined;
        }

        transport?.close();
        this.#logger.log("warn", "transport", "connect.failed", {
          data: { code: errorCode(error) },
        });
        this.#setState("unavailable");
        this.#scheduleReconnect();
      }
    };

    this.#connectPromise = connect().finally(() => {
      this.#connectPromise = undefined;
    });
    return this.#connectPromise;
  }

  #onTransportEvent(
    generation: number,
    transport: DaemonTransport,
    event: ZenTransportEvent,
  ): void {
    if (generation !== this.#generation || transport !== this.#transport) {
      return;
    }

    switch (event.type) {
      case "delta":
        void this.#acceptDelta(event.delta).catch(() => {
          void this.refresh().catch(() => undefined);
        });
        break;
      case "invalidated":
      case "session-replaced":
        void this.refresh().catch(() => undefined);
        break;
      case "closed":
        this.#disconnectTransport(transport);
        break;
    }
  }

  #disconnectTransport(transport: DaemonTransport): void {
    if (transport !== this.#transport) {
      return;
    }

    this.#generation += 1;
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;
    this.#transport = undefined;
    this.#leases.clear();
    this.#pageReferences.clear();
    this.#tabProvenance.clear();
    void this.#uploadStaging.clear();
    for (const operation of this.#activeOperations.values()) {
      operation.controller.abort();
    }
    this.#activeOperations.clear();

    if (this.#state !== "stopping" && this.#state !== "stopped") {
      this.#setState("reconnecting");
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (
      this.#reconnectTimer !== undefined ||
      this.#state === "stopping" ||
      this.#state === "stopped"
    ) {
      return;
    }

    this.#reconnectAttempts += 1;
    const delay = this.#options.reconnectDelayMs ?? 1_000;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#setState("reconnecting");
      void this.#connectOnce();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #acceptSnapshot(
    snapshot: BrowserSnapshot,
    initial: boolean,
  ): Promise<BrowserSnapshot> {
    return this.#registryQueue.run(() => {
      this.#assertProfile(snapshot);
      const registry = this.#registry;
      const sequence = registry === undefined ? 1 : registry.sequence + 1;
      const sequenced = { ...snapshot, sequence };

      if (registry === undefined) {
        this.#registry = new BrowserRegistry(sequenced);
      } else if (initial) {
        throw new BrowserModelError(
          "Cannot load a second initial daemon snapshot.",
        );
      } else {
        registry.reconcileAfterReconnect(sequenced);
      }

      this.#retainActiveLeases();
      this.#emit({
        event: "registry.updated",
        payload: { sequence, source: "snapshot" },
      });
      return sequenced;
    });
  }

  #acceptDelta(delta: BrowserDelta): Promise<void> {
    return this.#registryQueue.run(() => {
      const registry = this.#requireRegistry();
      const sequence = registry.sequence + 1;
      registry.applyDelta({ ...delta, sequence });
      this.#retainActiveLeases();
      this.#emit({
        event: "registry.updated",
        payload: { sequence, source: "delta" },
      });
    });
  }

  #assertProfile(snapshot: BrowserSnapshot): void {
    const expected = this.#options.profileId ?? this.#config?.profile;

    if (snapshot.profiles.length !== 1) {
      throw new DaemonProtocolError(
        "browser-unavailable",
        "A daemon transport must describe exactly one Zen profile.",
      );
    }

    const actual = snapshot.profiles[0]?.id.transportId;

    if (expected !== undefined && actual !== expected) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "The transport connected to a different Zen profile than configured.",
      );
    }
  }

  #activeEntity(id: BrowserEntityId, expectedKind: EntityKind): BrowserEntity {
    const lookup = this.#requireRegistry().lookup(id);

    if (lookup.status === "stale") {
      throw new DaemonProtocolError(
        "stale-id",
        `The ${expectedKind} identifier is stale (${lookup.stale.reason}).`,
        {
          reason: lookup.stale.reason,
          resource: expectedKind,
          retryable: false,
        },
      );
    }

    if (lookup.status === "missing" || lookup.entity.kind !== expectedKind) {
      throw new DaemonProtocolError(
        "stale-id",
        `The ${expectedKind} identifier is not active in this browser session.`,
        {
          reason: "not-active",
          resource: expectedKind,
          retryable: false,
        },
      );
    }

    return lookup.entity;
  }

  #safeMutationTab(id: BrowserTabId, clientId?: string): BrowserTab {
    const entity = this.#activeTab(id);

    if (clientId !== undefined) {
      this.#leases.assertMutationAllowed(clientId, entity.id);
    }

    if (entity.selected.status === "known" && entity.selected.value) {
      const error = selectedTabTakeover();
      this.#revokeSelectedTab(entity, error);
      throw error;
    }

    if (
      entity.mediaState.status === "known" &&
      entity.mediaState.value === "playing"
    ) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "Zen Agent will not mutate a tab that is playing media.",
        {
          reason: "playing-media",
          resource: "tab",
          retryable: false,
          userActionRequired: true,
        },
      );
    }

    return entity;
  }

  #activeTab(id: BrowserTabId): BrowserTab {
    const entity = this.#activeEntity(id, "tab");

    if (entity.kind !== "tab") {
      throw new DaemonProtocolError(
        "internal",
        "The browser registry returned a non-tab for a tab identity.",
      );
    }

    return entity;
  }

  #pageElementMutationTarget(
    request: DaemonRequest,
    params: Readonly<Record<string, unknown>>,
  ): PageElementTarget {
    const target = requireDaemonPageElementTarget(params["target"]);
    const tab = this.#safeMutationTab(target.tabId, request.clientId);
    this.#pageReferences.assertLatestOwned(request.clientId, target);
    this.#leases.assertOwned(
      request.clientId,
      requireString(params, "leaseId"),
      tab.id,
    );
    return {
      ...target,
      tabId: tab.id.transportId,
    };
  }

  #assertExpectedRegistrySequence(
    params: Readonly<Record<string, unknown>>,
  ): void {
    const expected = params["expectedRegistrySequence"];

    if (expected === undefined) {
      return;
    }

    if (
      typeof expected !== "number" ||
      !Number.isSafeInteger(expected) ||
      expected < 0
    ) {
      throw new DaemonProtocolError(
        "invalid-request",
        "expectedRegistrySequence must be a non-negative safe integer.",
      );
    }

    const actual = this.#requireRegistry().sequence;
    if (expected !== actual) {
      throw new DaemonProtocolError(
        "stale-id",
        "The browser registry changed after the mutation was planned.",
        {
          reason: "registry-version-conflict",
          resource: "registry",
          retryable: true,
          recovery: "refresh-and-replan",
          performed: false,
          expectedRegistrySequence: expected,
          actualRegistrySequence: actual,
        },
      );
    }
  }

  #markPageMutationChanged(params: Readonly<Record<string, unknown>>): void {
    const target = requireDaemonPageElementTarget(params["target"]);
    this.#tabProvenance.markChanged(target.tabId);
  }

  #revokeSelectedTab(tab: BrowserTab, error = selectedTabTakeover()): void {
    this.#leases.revokeTab(tab.id, error);
    this.#pageReferences.releaseTab(tab.id);
    void this.#uploadStaging.releaseTab(tab.id);
    this.#tabProvenance.observe(tab);

    for (const operation of this.#activeOperations.values()) {
      if (
        operation.tabId !== undefined &&
        entityIdKey(operation.tabId) === entityIdKey(tab.id)
      ) {
        operation.controller.abort(error);
      }
    }
  }

  async #waitForPage(
    clientId: string,
    tab: BrowserTab,
    condition: PageWaitCondition,
    timeoutMs: number,
    pollIntervalMs: number,
    maxNodes: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const transport = this.#requireTransport();
    const locator = pageWaitConditionLocator(condition);

    while (true) {
      assertNotCancelled(signal);

      try {
        const snapshot = await cancellableResult(
          transport.snapshotPage(tab.id.transportId, { maxNodes }),
          signal,
        );
        const query =
          locator === undefined
            ? undefined
            : await cancellableResult(
                transport.queryPage(
                  {
                    tabId: tab.id.transportId,
                    documentId: snapshot.documentId,
                    snapshotId: snapshot.snapshotId,
                    frameRef: snapshot.rootFrameRef,
                  },
                  { locator, maxResults: 100 },
                ),
                signal,
              );
        assertNotCancelled(signal);

        if (
          evaluatePageWaitCondition(condition, {
            documentId: snapshot.documentId,
            url: snapshot.url,
            loadState: snapshot.loadState,
            nodes: snapshot.nodes,
            ...(query === undefined ? {} : { query }),
          })
        ) {
          this.#pageReferences.remember(clientId, tab.id, snapshot);
          return {
            matched: true,
            elapsedMs: Date.now() - startedAt,
            snapshot: { ...snapshot, tabId: tab.id },
          };
        }
      } catch (error) {
        if (!(
          error instanceof TransportProtocolError &&
          (error.code === "stale-document" ||
            error.code === "stale-frame" ||
            error.code === "stale-element")
        )) {
          throw error;
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw new DaemonProtocolError(
          "timeout",
          "The page wait condition was not met before its deadline.",
        );
      }

      await cancellableDelay(
        Math.min(pollIntervalMs, timeoutMs - elapsedMs),
        signal,
      );
    }
  }

  #leasableTab(id: BrowserTabId): BrowserTab {
    const tab = this.#safeMutationTab(id);

    if (tab.lifecycleState === "crashed") {
      throw new DaemonProtocolError(
        "stale-id",
        "A crashed tab cannot be leased.",
        {
          reason: "crashed",
          resource: "tab",
          retryable: false,
        },
      );
    }

    return tab;
  }

  #retainActiveLeases(): void {
    const registry = this.#registry;

    if (registry === undefined) {
      this.#leases.clear();
      this.#pageReferences.clear();
      this.#tabProvenance.clear();
      void this.#uploadStaging.clear();
      return;
    }

    this.#leases.retainTabs((tabId) => {
      const lookup = registry.lookup(tabId);
      return (
        lookup.status === "active" &&
        lookup.entity.kind === "tab" &&
        lookup.entity.lifecycleState !== "crashed"
      );
    });
    this.#pageReferences.retainTabs((tabId) => {
      const lookup = registry.lookup(tabId);
      return (
        lookup.status === "active" &&
        lookup.entity.kind === "tab" &&
        lookup.entity.lifecycleState !== "crashed"
      );
    });
    this.#tabProvenance.retainTabs((tabId) => {
      const lookup = registry.lookup(tabId);
      return (
        lookup.status === "active" &&
        lookup.entity.kind === "tab" &&
        lookup.entity.lifecycleState !== "crashed"
      );
    });

    for (const entity of registry.entities("tab")) {
      if (entity.kind !== "tab") {
        continue;
      }

      this.#tabProvenance.observe(entity);

      if (entity.selected.status === "known" && entity.selected.value) {
        this.#revokeSelectedTab(entity);
      }
    }
  }

  #findTransportEntity(
    kind: EntityKind,
    transportId: string,
  ): BrowserEntity | undefined {
    return this.#registry
      ?.entities(kind)
      .find((entity) => entity.id.transportId === transportId);
  }

  async #freshSnapshot(): Promise<BrowserSnapshot> {
    const transport = this.#requireTransport();
    const generation = this.#generation;
    const snapshot = await transport.snapshot();

    if (generation !== this.#generation || transport !== this.#transport) {
      throw new DaemonProtocolError(
        "browser-unavailable",
        "Zen disconnected while refreshing the browser registry.",
      );
    }

    return this.#acceptSnapshot(snapshot, false);
  }

  #resolutionRequest(
    params: Readonly<Record<string, unknown>>,
  ): ResolveTabRequest {
    const url = requireString(params, "url");
    const stableSpace =
      params["spaceId"] === undefined
        ? this.#routedSpaceId(params, url)
        : requireEntityIdOfKind(params["spaceId"], "space");
    const rules = optionalMatchRules(params["rules"]);
    const title = optionalString(params, "title");
    const domain = optionalString(params, "domain");
    const query = optionalString(params, "query");
    const allowSensitiveWeakMatch = optionalBoolean(
      params,
      "allowSensitiveWeakMatch",
    );
    const allowCrossSpaceReuse = optionalBoolean(
      params,
      "allowCrossSpaceReuse",
    );
    const navigateReusedTab = optionalBoolean(params, "navigateReusedTab");

    return {
      url,
      spaceId: stableSpace,
      ...(rules === undefined ? {} : { rules }),
      ...(title === undefined ? {} : { title }),
      ...(domain === undefined ? {} : { domain }),
      ...(query === undefined ? {} : { query }),
      ...(allowSensitiveWeakMatch === undefined
        ? {}
        : { allowSensitiveWeakMatch }),
      ...(allowCrossSpaceReuse === undefined ? {} : { allowCrossSpaceReuse }),
      ...(navigateReusedTab === undefined ? {} : { navigateReusedTab }),
    };
  }

  #resolveQuery(params: Readonly<Record<string, unknown>>): unknown {
    const query = requireString(params, "query").toLocaleLowerCase("en-US");
    const chosenSpace =
      params["spaceId"] === undefined
        ? this.#routedSpaceId(params)
        : requireEntityIdOfKind(params["spaceId"], "space");
    this.#activeEntity(chosenSpace, "space");
    const allowCrossSpaceReuse =
      optionalBoolean(params, "allowCrossSpaceReuse") === true;
    const candidates = this.#requireRegistry()
      .entities("tab")
      .filter((entity) => {
        if (entity.kind !== "tab" || entity.lifecycleState === "crashed") {
          return false;
        }

        if (
          (entity.selected.status === "known" && entity.selected.value) ||
          (entity.mediaState.status === "known" &&
            entity.mediaState.value === "playing")
        ) {
          return false;
        }

        if (
          entity.spaceId.status !== "known" ||
          entity.spaceId.value === null ||
          entity.url.status !== "known"
        ) {
          return false;
        }

        const inChosenSpace =
          entityIdKey(entity.spaceId.value) === entityIdKey(chosenSpace);

        if (!inChosenSpace && !allowCrossSpaceReuse) {
          return false;
        }

        try {
          if (isSensitiveOrStatefulUrl(entity.url.value)) {
            return false;
          }
        } catch {
          return false;
        }

        const title =
          entity.title.status === "known"
            ? entity.title.value.toLocaleLowerCase("en-US")
            : "";
        return (
          title.includes(query) ||
          entity.url.value.toLocaleLowerCase("en-US").includes(query)
        );
      })
      .map((entity) => {
        if (
          entity.kind !== "tab" ||
          entity.spaceId.status !== "known" ||
          entity.spaceId.value === null
        ) {
          throw new DaemonProtocolError(
            "internal",
            "A query candidate lost its Space identity.",
          );
        }

        return {
          tabId: entity.id,
          windowId: entity.windowId,
          spaceId: entity.spaceId.value,
          lifecycleState: entity.lifecycleState,
          inChosenSpace:
            entityIdKey(entity.spaceId.value) === entityIdKey(chosenSpace),
          bestMatch: { rule: "query" as const, strength: 100 },
          matches: [{ rule: "query" as const, strength: 100 }],
          sensitiveOrStateful: false,
        };
      });
    const inChosenSpace = candidates.filter(
      (candidate) => candidate.inChosenSpace,
    );
    const eligible = inChosenSpace.length > 0 ? inChosenSpace : candidates;
    const explanation = {
      chosenSpaceId: chosenSpace,
      consideredTabCount: this.#requireRegistry().entities("tab").length,
      eligibleCandidates: eligible,
      crossSpaceReuse: allowCrossSpaceReuse
        ? ("explicitly-allowed" as const)
        : ("forbidden" as const),
      staleRetryCount: 0,
    };

    if (eligible.length === 0) {
      return {
        status: "not-found",
        candidates: [],
        explanation: {
          ...explanation,
          outcome: "not-found",
          reason: "query-has-no-safe-match",
        },
      };
    }

    const match = eligible[0];

    if (eligible.length > 1 || match === undefined) {
      return {
        status: "ambiguous",
        candidates: eligible,
        explanation: {
          ...explanation,
          outcome: "ambiguous",
          reason: "equally-safe-matches",
          match: { rule: "query", strength: 100 },
        },
      };
    }

    return {
      status: "reused",
      tabId: match.tabId,
      explanation: {
        ...explanation,
        outcome: "reused",
        reason: "best-safe-match",
        match: match.bestMatch,
        navigated: false,
      },
    };
  }

  #routedSpaceId(
    params: Readonly<Record<string, unknown>>,
    url?: string,
  ): BrowserSpaceId {
    const configured = this.#config;
    const space = optionalString(params, "space");
    const taskContext = optionalString(params, "taskContext");

    if (configured === undefined) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "Tab resolution requires a stable spaceId or loaded routing configuration.",
      );
    }

    const override: ExplicitSpaceOverride | undefined =
      space === undefined
        ? undefined
        : this.#findSpaceByTransportId(space) === undefined
          ? { kind: "name", name: space }
          : { kind: "space-id", spaceId: space };
    const decision = routeSpace(configured, {
      ...(url === undefined ? {} : { url }),
      ...(override === undefined ? {} : { override }),
      ...(taskContext === undefined ? {} : { taskContext }),
    });

    if (decision.status === "ambiguous") {
      throw new DaemonProtocolError("policy-rejection", decision.message, {
        reason: decision.code,
        candidates: decision.candidates.length,
      });
    }

    if (decision.status === "unresolved") {
      throw new DaemonProtocolError("policy-rejection", decision.message, {
        reason: decision.code,
      });
    }

    const resolved = this.#findSpaceByTransportId(decision.spaceId);

    if (resolved === undefined) {
      throw new DaemonProtocolError(
        "stale-id",
        "The routed Space is not active in the current Zen session.",
      );
    }

    return resolved;
  }

  #findSpaceByTransportId(transportId: string): BrowserSpaceId | undefined {
    const entity = this.#findTransportEntity("space", transportId);
    return entity?.kind === "space" ? entity.id : undefined;
  }

  #requireRegistry(): BrowserRegistry {
    if (this.#registry === undefined) {
      throw new DaemonProtocolError(
        "browser-unavailable",
        "The browser registry is unavailable until Zen connects.",
      );
    }

    return this.#registry;
  }

  #requireTransport(): DaemonTransport {
    if (this.#state !== "connected" || this.#transport === undefined) {
      throw new DaemonProtocolError(
        "browser-unavailable",
        "Zen is not connected.",
      );
    }

    return this.#transport;
  }

  #setState(state: DaemonConnectionState): void {
    if (this.#state === state) {
      return;
    }

    this.#state = state;
    this.#emit({
      event: "status.changed",
      payload: { state },
    });
  }

  #isStopping(): boolean {
    return this.#state === "stopping" || this.#state === "stopped";
  }

  #emit(event: DaemonServiceEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

function canonicalDaemonSpeechLocale(locale: string): string {
  try {
    return canonicalSpeechLocale(locale);
  } catch (error) {
    if (error instanceof SpeechHelperError) {
      throw new DaemonProtocolError(
        "invalid-request",
        "locale must be a canonical BCP-47 identifier such as en-US.",
        { reason: "invalid-locale", resource: "locale" },
      );
    }
    throw error;
  }
}

function assertSpeechModelInstalled(
  config: ZenAgentConfig | undefined,
  locale: string,
): void {
  if (config?.speech?.installedLocales.includes(locale) === true) {
    return;
  }

  throw new DaemonProtocolError(
    "unsupported-capability",
    "The requested on-device speech model is not installed.",
    {
      reason: "speech-model-not-installed",
      resource: "speech-model",
      retryable: false,
      userActionRequired: true,
    },
  );
}

function findTargetMedia(
  result: PageMediaListResult,
  target: Readonly<{ frameRef: string; elementRef: string }>,
): PageMedia {
  const media = result.media.find(
    (candidate) =>
      candidate.frameRef === target.frameRef &&
      candidate.elementRef === target.elementRef,
  );

  if (media === undefined) {
    throw new DaemonProtocolError(
      "stale-element",
      "The referenced media element is no longer available.",
      {
        reason: "media-not-found",
        resource: "element",
        retryable: false,
        recovery: "snapshot-and-query",
        performed: false,
      },
    );
  }

  return media;
}

function captionTranscript(
  media: PageMedia,
  locale: string,
): Readonly<{ text: string; truncated: boolean }> | undefined {
  const tracks = media.captions.filter(
    (track) => track.cuesAvailable && track.cues.length > 0,
  );
  const preferred =
    tracks.find((track) => track.language === locale) ?? tracks[0];

  if (preferred === undefined) {
    return undefined;
  }

  const text = [...preferred.cues]
    .sort((left, right) => left.startTime - right.startTime)
    .map((cue) => cue.text.trim())
    .filter((cue) => cue.length > 0)
    .join("\n");

  if (text.length === 0) {
    return undefined;
  }

  const bounded = boundedTranscript(text);
  return {
    text: bounded.text,
    truncated: preferred.truncated || bounded.truncated,
  };
}

function boundedTranscript(
  text: string,
): Readonly<{ text: string; truncated: boolean }> {
  const bytes = Buffer.from(text, "utf8");

  if (bytes.byteLength <= MAX_TRANSCRIPT_BYTES) {
    return { text, truncated: false };
  }

  return {
    text: new TextDecoder().decode(bytes.subarray(0, MAX_TRANSCRIPT_BYTES)),
    truncated: true,
  };
}

function decodeBoundedResource(
  resource: PageResourceResult,
  maximum: number,
  resourceKind: "media" | "resource",
): Buffer {
  const compact = resource.dataBase64.replaceAll(/\s/gu, "");
  const bytes = Buffer.from(compact, "base64");
  const normalizedInput = compact.replace(/=+$/u, "");
  const normalizedDecoded = bytes.toString("base64").replace(/=+$/u, "");

  if (
    bytes.byteLength < 1 ||
    bytes.byteLength !== resource.bytes ||
    bytes.byteLength > maximum ||
    normalizedInput !== normalizedDecoded
  ) {
    throw new DaemonProtocolError(
      bytes.byteLength > maximum ? "payload-too-large" : "internal",
      `The transport returned invalid bounded ${resourceKind} bytes.`,
      {
        reason: `${resourceKind}-bytes`,
        resource: resourceKind,
        retryable: false,
        ...(bytes.byteLength > maximum ? { limit: maximum } : {}),
      },
    );
  }

  return bytes;
}

function resourceFileExtension(mimeType: string): string {
  switch (mimeType.toLowerCase().split(";", 1)[0]) {
    case "audio/aac":
      return ".aac";
    case "audio/m4a":
    case "audio/mp4":
      return ".m4a";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "application/json":
      return ".json";
    case "application/pdf":
      return ".pdf";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "text/css":
      return ".css";
    case "text/html":
      return ".html";
    case "text/plain":
      return ".txt";
    default:
      return ".bin";
  }
}

function mapSpeechHelperError(error: SpeechHelperError): DaemonProtocolError {
  switch (error.code) {
    case "cancelled":
      return new DaemonProtocolError(
        "cancelled",
        "On-device speech transcription was cancelled.",
        {
          reason: "cancelled",
          resource: "speech-helper",
          retryable: false,
          performed: false,
        },
      );
    case "invalid-locale":
    case "invalid-input":
      return new DaemonProtocolError(
        "invalid-request",
        "The on-device transcription request is invalid.",
        { reason: error.code, resource: "speech-helper" },
      );
    case "model-not-installed":
      return new DaemonProtocolError(
        "unsupported-capability",
        "The requested on-device speech model is not installed.",
        {
          reason: "speech-model-not-installed",
          resource: "speech-model",
          retryable: false,
          userActionRequired: true,
        },
      );
    case "unsupported-locale":
      return new DaemonProtocolError(
        "unsupported-capability",
        "The requested locale is not supported for on-device speech.",
        {
          reason: "speech-locale-unsupported",
          resource: "speech-model",
          retryable: false,
          userActionRequired: true,
        },
      );
    case "speech-helper-unavailable":
    case "unsupported-platform":
    case "unsupported-version":
    case "protocol-version-mismatch":
      return new DaemonProtocolError(
        "unsupported-capability",
        "On-device speech transcription is unavailable.",
        {
          reason: "speech-helper-unavailable",
          resource: "speech-helper",
          retryable: false,
          userActionRequired: true,
        },
      );
    default:
      return new DaemonProtocolError(
        "internal",
        "On-device speech transcription could not be completed.",
        {
          reason: "speech-helper-failed",
          resource: "speech-helper",
          retryable: true,
        },
      );
  }
}

export function daemonErrorBody(error: unknown): Readonly<{
  code: DaemonErrorCode;
  message: string;
  data?: Readonly<Record<string, string | number | boolean | null>>;
}> {
  if (error instanceof DaemonProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }

  if (error instanceof TransportProtocolError) {
    const recovery = transportRecoveryData(error.code);
    return {
      code: mapTransportErrorCode(error.code),
      message: error.message,
      ...(recovery === undefined ? {} : { data: recovery }),
    };
  }

  if (error instanceof BrowserModelError) {
    return {
      code: "internal",
      message: "The browser registry rejected an inconsistent update.",
    };
  }

  return {
    code: "internal",
    message: "The daemon could not complete the request.",
  };
}

function mapTransportErrorCode(code: TransportErrorCode): DaemonErrorCode {
  switch (code) {
    case "protocol-version-mismatch":
    case "invalid-request":
    case "browser-unavailable":
    case "unsupported-capability":
    case "stale-id":
    case "stale-document":
    case "stale-frame":
    case "stale-element":
    case "timeout":
    case "payload-too-large":
    case "policy-rejection":
    case "internal":
      return code;
  }
}

function transportRecoveryData(
  code: TransportErrorCode,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  switch (code) {
    case "stale-document":
      return {
        reason: "document-replaced",
        resource: "document",
        recovery: "snapshot-and-query",
        performed: false,
      };
    case "stale-frame":
      return {
        reason: "frame-replaced",
        resource: "frame",
        recovery: "snapshot-and-query",
        performed: false,
      };
    case "stale-element":
      return {
        reason: "element-replaced",
        resource: "element",
        recovery: "snapshot-and-query",
        performed: false,
      };
    default:
      return undefined;
  }
}

function errorCode(error: unknown): string {
  return daemonErrorBody(error).code;
}

function optionalRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireRecord(value);
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonProtocolError(
      "invalid-request",
      "Request parameters must be an object.",
    );
  }

  return value as Readonly<Record<string, unknown>>;
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const field = value[key];

  if (typeof field !== "string" || field.trim().length === 0) {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must be a non-empty string.`,
    );
  }

  return field;
}

function requireBoundedString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  allowEmpty: boolean,
): string {
  const field = value[key];

  if (
    typeof field !== "string" ||
    (!allowEmpty && field.length === 0) ||
    Buffer.byteLength(field, "utf8") > maximum
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must be ${allowEmpty ? "a string" : "a non-empty string"} no more than ${String(maximum)} UTF-8 bytes.`,
    );
  }

  return field;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return value[key] === undefined ? undefined : requireString(value, key);
}

function optionalBoolean(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const field = value[key];

  if (field === undefined) {
    return undefined;
  }

  if (typeof field !== "boolean") {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must be a boolean.`,
    );
  }

  return field;
}

function optionalStringProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const field = optionalString(value, key);
  return field === undefined ? {} : { [key]: field };
}

function optionalBooleanProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, boolean>> {
  const field = optionalBoolean(value, key);
  return field === undefined ? {} : { [key]: field };
}

function optionalNumberProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, number>> {
  const field = value[key];

  if (field === undefined) {
    return {};
  }

  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must be a finite number.`,
    );
  }

  return { [key]: field };
}

function requireStringArray(
  value: unknown,
  key: string,
  maximum: number,
  allowEmpty = false,
): readonly string[] {
  const entries: readonly unknown[] = Array.isArray(value) ? value : [];

  if (
    !Array.isArray(value) ||
    entries.length < 1 ||
    entries.length > maximum ||
    entries.some(
      (entry) =>
        typeof entry !== "string" ||
        (!allowEmpty && entry.length === 0) ||
        (typeof entry === "string" &&
          Buffer.byteLength(entry, "utf8") > 64 * 1024),
    )
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must contain 1 through ${String(maximum)} non-empty strings.`,
    );
  }

  return entries.map((entry) => String(entry));
}

interface DaemonPageFrameTarget extends Omit<PageFrameTarget, "tabId"> {
  readonly tabId: BrowserTabId;
}

interface DaemonPageElementTarget extends Omit<PageElementTarget, "tabId"> {
  readonly tabId: BrowserTabId;
}

interface DaemonPageDocumentTarget extends Omit<PageDocumentTarget, "tabId"> {
  readonly tabId: BrowserTabId;
}

function requireDaemonPageFrameTarget(value: unknown): DaemonPageFrameTarget {
  const target = requireRecord(value);
  return {
    tabId: requireEntityIdOfKind(target["tabId"], "tab"),
    documentId: requireString(target, "documentId"),
    snapshotId: requireString(target, "snapshotId"),
    frameRef: requireString(target, "frameRef"),
  };
}

function requireDaemonPageElementTarget(
  value: unknown,
): DaemonPageElementTarget {
  const target = requireRecord(value);
  return {
    ...requireDaemonPageFrameTarget(target),
    elementRef: requireString(target, "elementRef"),
  };
}

function requireDaemonPageDocumentTarget(
  value: unknown,
): DaemonPageDocumentTarget {
  const target = requireRecord(value);
  return {
    tabId: requireEntityIdOfKind(target["tabId"], "tab"),
    documentId: requireString(target, "documentId"),
  };
}

function requirePageLocator(value: unknown): PageLocator {
  const locator = requireRecord(value);
  const kind = requireString(locator, "kind");

  switch (kind) {
    case "role": {
      const name = optionalString(locator, "name");
      return {
        kind,
        role: requireString(locator, "role"),
        ...(name === undefined ? {} : { name }),
      };
    }
    case "label":
      return { kind, label: requireString(locator, "label") };
    case "text":
      return { kind, text: requireString(locator, "text") };
    case "placeholder":
      return {
        kind,
        placeholder: requireString(locator, "placeholder"),
      };
    case "css":
      return { kind, selector: requireString(locator, "selector") };
    case "element":
      return { kind, elementRef: requireString(locator, "elementRef") };
    default:
      throw new DaemonProtocolError(
        "invalid-request",
        "The page locator kind is unsupported.",
      );
  }
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortFailure(signal);
  }
}

function activeOperationKey(clientId: string, operationId: string): string {
  return `${clientId}\u0000${operationId}`;
}

function cancellableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  assertNotCancelled(signal);

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortFailure(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancellableResult<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  assertNotCancelled(signal);

  return new Promise<Result>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortFailure(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortFailure(signal: AbortSignal): DaemonProtocolError {
  return signal.reason instanceof DaemonProtocolError
    ? signal.reason
    : new DaemonProtocolError(
        "cancelled",
        "The daemon operation was cancelled.",
        {
          reason: "operation-cancelled",
          retryable: true,
        },
      );
}

function optionalPositiveInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): number | undefined {
  const field = value[key];

  if (field === undefined) {
    return undefined;
  }

  if (
    typeof field !== "number" ||
    !Number.isSafeInteger(field) ||
    field < 1 ||
    field > maximum
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must be an integer from 1 through ${String(maximum)}.`,
    );
  }

  return field;
}

function optionalNonnegativeInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): number | undefined {
  const field = value[key];

  if (field === undefined) {
    return undefined;
  }

  if (
    typeof field !== "number" ||
    !Number.isSafeInteger(field) ||
    field < 0 ||
    field > maximum
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      `${key} must be an integer from 0 through ${String(maximum)}.`,
    );
  }

  return field;
}

function tabLeaseTtlMs(value: Readonly<Record<string, unknown>>): number {
  const ttlMs =
    optionalPositiveInteger(value, "ttlMs", MAX_TAB_LEASE_TTL_MS) ??
    DEFAULT_TAB_LEASE_TTL_MS;

  if (ttlMs < MIN_TAB_LEASE_TTL_MS) {
    throw new DaemonProtocolError(
      "invalid-request",
      `ttlMs must be an integer from ${String(MIN_TAB_LEASE_TTL_MS)} through ${String(MAX_TAB_LEASE_TTL_MS)}.`,
    );
  }

  return ttlMs;
}

function optionalCleanupAction(
  value: Readonly<Record<string, unknown>>,
): "keep" | "close" {
  const action = value["action"];

  if (action === undefined || action === "keep") {
    return "keep";
  }

  if (action === "close") {
    return action;
  }

  throw new DaemonProtocolError(
    "invalid-request",
    "action must be keep or close.",
  );
}

function selectedTabTakeover(): DaemonProtocolError {
  return new DaemonProtocolError(
    "policy-rejection",
    "The user selected this tab, so Zen Agent relinquished control.",
    {
      reason: "selected-tab",
      resource: "tab",
      retryable: false,
      userActionRequired: true,
      leaseDisposition: "revoked",
    },
  );
}

function closedTab(): DaemonProtocolError {
  return new DaemonProtocolError("stale-id", "The requested tab was closed.", {
    reason: "tab-closed",
    resource: "tab",
    retryable: false,
  });
}

function optionalMatchRules(
  value: unknown,
): readonly TabMatchRule[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some(
      (rule) =>
        typeof rule !== "string" ||
        !(TAB_MATCH_RULES as readonly string[]).includes(rule),
    )
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      "rules must contain only supported tab matching rules.",
    );
  }

  return value as readonly TabMatchRule[];
}

function requireEntityId(value: unknown): BrowserEntityId {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonProtocolError(
      "invalid-request",
      "A stable browser entity identifier is required.",
    );
  }

  const record = value as Readonly<Record<string, unknown>>;
  const kind = record["kind"];
  const transportId = record["transportId"];

  if (
    typeof kind !== "string" ||
    !(ENTITY_KINDS as readonly string[]).includes(kind) ||
    typeof transportId !== "string" ||
    transportId.trim().length === 0
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      "The browser entity identifier is malformed.",
    );
  }

  if (kind === "profile") {
    return value as BrowserEntityId;
  }

  if (kind === "session") {
    requireEntityIdOfKind(record["profileId"], "profile");
    return value as BrowserEntityId;
  }

  requireEntityIdOfKind(record["sessionId"], "session");

  if (
    kind === "element" &&
    (typeof record["snapshotSequence"] !== "number" ||
      !Number.isSafeInteger(record["snapshotSequence"]))
  ) {
    throw new DaemonProtocolError(
      "invalid-request",
      "An element identifier requires a snapshot sequence.",
    );
  }

  return value as BrowserEntityId;
}

function requireEntityIdOfKind<Kind extends BrowserEntityId["kind"]>(
  value: unknown,
  kind: Kind,
): Extract<BrowserEntityId, Readonly<{ kind: Kind }>> {
  const id = requireEntityId(value);

  if (id.kind !== kind) {
    throw new DaemonProtocolError(
      "invalid-request",
      `Expected a stable ${kind} identifier.`,
    );
  }

  return id as Extract<BrowserEntityId, Readonly<{ kind: Kind }>>;
}

// Keep the public contract types obvious to generated declarations.
export type DaemonLookupResult = EntityLookup;
export type DaemonTabId = BrowserTabId;
export type DaemonWindowId = BrowserWindowId;
export type DaemonSpaceId = BrowserSpaceId;
export type DaemonLogConfiguration = Readonly<{ level: DaemonLogLevel }>;
