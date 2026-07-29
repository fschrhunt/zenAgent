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
import type { ZenAgentConfig } from "../config/schema.js";
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
import type {
  PageInspection,
  ZenTransportEvent,
  ZenTransportListener,
} from "../transport/client.js";
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
import { SerialQueue } from "./serial.js";

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
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly result: Promise<unknown>;
}

const READ_METHODS: readonly DaemonMethod[] = [
  "health",
  "version",
  "capabilities",
  "status",
  "registry.entities",
  "registry.lookup",
  "pages.inspect",
];

const MUTATION_METHODS: readonly DaemonMethod[] = [
  "config.reload",
  "tabs.resolve",
  "tabs.open",
  "tabs.navigate",
  "tabs.reload",
  "tabs.close",
  "tabs.move",
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
  readonly #mutationQueue = new SerialQueue();
  readonly #registryQueue = new SerialQueue();
  readonly #listeners = new Set<(event: DaemonServiceEvent) => void>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();

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
    await Promise.all([this.#mutationQueue.idle(), this.#registryQueue.idle()]);
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

    if ((MUTATION_METHODS as readonly string[]).includes(request.method)) {
      if (request.idempotencyKey === undefined) {
        throw new DaemonProtocolError(
          "invalid-request",
          `${request.method} requires an idempotency key.`,
        );
      }

      return this.#idempotent(request, () =>
        this.#mutationQueue.run(() => this.#handleMutation(request)),
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

  #handleRead(request: DaemonRequest): unknown {
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
        const tab = this.#activeEntity(tabId, "tab");
        const maxChars = optionalPositiveInteger(params, "maxChars", 10_000);

        return this.#requireTransport().inspectPage(tab.id.transportId, {
          ...(maxChars === undefined ? {} : { maxChars }),
        });
      }
      default:
        throw new DaemonProtocolError(
          "method-not-found",
          `Unknown read method ${JSON.stringify(request.method)}.`,
        );
    }
  }

  async #handleMutation(request: DaemonRequest): Promise<unknown> {
    const transport = this.#requireTransport();
    const params = requireRecord(request.params);

    switch (request.method) {
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

        const resolutionRequest = this.#resolutionRequest(params);
        const resolver = new TabResolver({
          snapshot: () => this.#freshSnapshot(),
          openTab: async (options) => {
            const activeWindow = this.#activeEntity(options.windowId, "window");
            const activeSpace = this.#activeEntity(options.spaceId, "space");
            const tabTransportId = await transport.openTab({
              url: options.url,
              windowId: activeWindow.id.transportId,
              zenSpaceUuid: activeSpace.id.transportId,
            });
            await this.#freshSnapshot();
            const opened = this.#findTransportEntity("tab", tabTransportId);

            if (opened === undefined || opened.kind !== "tab") {
              throw new DaemonProtocolError(
                "internal",
                "Zen opened a tab but the refreshed registry did not contain it.",
              );
            }

            return opened.id;
          },
          navigateTab: async (tabId, url) => {
            const tab = this.#safeMutationTab(tabId);
            await transport.navigateTab(tab.id.transportId, url);
            await this.#freshSnapshot();
          },
        });
        return resolver.resolve(resolutionRequest).catch((error: unknown) => {
          if (error instanceof TabResolutionError) {
            throw new DaemonProtocolError(
              error.code === "invalid-created-tab-id" ? "internal" : "stale-id",
              error.message,
              { reason: error.code },
            );
          }

          if (error instanceof TypeError) {
            throw new DaemonProtocolError("invalid-request", error.message);
          }

          throw error;
        });
      }
      case "tabs.open": {
        const url = requireString(params, "url");
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

        const tabTransportId = await transport.openTab({
          url,
          windowId: windowId.transportId,
          zenSpaceUuid: spaceId.transportId,
        });
        await this.refresh();
        const opened = this.#findTransportEntity("tab", tabTransportId);

        return {
          outcome: "opened",
          tabId: opened?.id ?? null,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.navigate": {
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#safeMutationTab(tabId);
        const url = requireString(params, "url");
        await transport.navigateTab(tab.id.transportId, url);
        await this.refresh();
        return {
          outcome: "navigated",
          tabId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.reload": {
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#safeMutationTab(tabId);

        if (transport.reloadTab === undefined) {
          throw new DaemonProtocolError(
            "unsupported-capability",
            "The connected Zen transport does not expose explicit background tab reload yet.",
          );
        }

        await transport.reloadTab(tab.id.transportId);
        await this.refresh();
        return {
          outcome: "reloaded",
          tabId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.close": {
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const tab = this.#safeMutationTab(tabId);
        await transport.closeTab(tab.id.transportId);
        await this.refresh();
        return {
          outcome: "closed",
          tabId,
          registrySequence: this.#registry?.sequence ?? null,
        };
      }
      case "tabs.move": {
        const tabId = requireEntityIdOfKind(params["tabId"], "tab");
        const spaceId = requireEntityIdOfKind(params["spaceId"], "space");
        const tab = this.#safeMutationTab(tabId);
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

        await transport.moveTab(tab.id.transportId, space.id.transportId);
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

  #idempotent(
    request: DaemonRequest,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = `${request.clientId}\u0000${request.method}\u0000${request.idempotencyKey ?? ""}`;
    const fingerprint = JSON.stringify(request.params ?? null);
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
        { reason: lookup.stale.reason },
      );
    }

    if (lookup.status === "missing" || lookup.entity.kind !== expectedKind) {
      throw new DaemonProtocolError(
        "stale-id",
        `The ${expectedKind} identifier is not active in this browser session.`,
      );
    }

    return lookup.entity;
  }

  #safeMutationTab(id: BrowserTabId): BrowserTab {
    const entity = this.#activeEntity(id, "tab");

    if (entity.kind !== "tab") {
      throw new DaemonProtocolError(
        "internal",
        "The browser registry returned a non-tab for a tab identity.",
      );
    }

    if (entity.selected.status === "known" && entity.selected.value) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "Zen Agent will not mutate the currently selected tab.",
        { reason: "selected-tab" },
      );
    }

    if (
      entity.mediaState.status === "known" &&
      entity.mediaState.value === "playing"
    ) {
      throw new DaemonProtocolError(
        "policy-rejection",
        "Zen Agent will not mutate a tab that is playing media.",
        { reason: "playing-media" },
      );
    }

    return entity;
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
    return {
      code: mapTransportErrorCode(error.code),
      message: error.message,
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
    case "timeout":
    case "payload-too-large":
    case "policy-rejection":
    case "internal":
      return code;
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
