export const BROWSER_MODEL_VERSION = 1 as const;

export type BrowserModelVersion = typeof BROWSER_MODEL_VERSION;

export const DEFAULT_PRIVATE_WINDOW_POLICY = "hidden" as const;

export type PrivateWindowPolicy =
  typeof DEFAULT_PRIVATE_WINDOW_POLICY | "explicit";

export type UnknownReason =
  | "not-reported"
  | "not-loaded"
  | "permission-denied"
  | "temporarily-unavailable";

export type Observation<T> =
  | Readonly<{ status: "known"; value: T }>
  | Readonly<{ status: "unknown"; reason: UnknownReason }>
  | Readonly<{ status: "unsupported"; capability: string }>;

export function known<T>(value: T): Observation<T> {
  return { status: "known", value };
}

export function unknown<T>(reason: UnknownReason): Observation<T> {
  return { status: "unknown", reason };
}

export function unsupported<T>(capability: string): Observation<T> {
  return { status: "unsupported", capability };
}

export type EntityKind =
  | "profile"
  | "session"
  | "window"
  | "space"
  | "tab"
  | "browsing-context"
  | "frame"
  | "element";

export type SessionEntityKind = Exclude<
  EntityKind,
  "profile" | "session" | "element"
>;

export type BrowserProfileId = Readonly<{
  kind: "profile";
  transportId: string;
}>;

export type BrowserSessionId = Readonly<{
  kind: "session";
  profileId: BrowserProfileId;
  transportId: string;
}>;

export type SessionEntityId<Kind extends SessionEntityKind> = Readonly<{
  kind: Kind;
  sessionId: BrowserSessionId;
  transportId: string;
}>;

export type BrowserWindowId = SessionEntityId<"window">;
export type BrowserSpaceId = SessionEntityId<"space">;
export type BrowserTabId = SessionEntityId<"tab">;
export type BrowsingContextId = SessionEntityId<"browsing-context">;
export type BrowserFrameId = SessionEntityId<"frame">;
export type BrowserElementId = Readonly<{
  kind: "element";
  sessionId: BrowserSessionId;
  transportId: string;
  snapshotSequence: number;
}>;

export type BrowserEntityId =
  | BrowserProfileId
  | BrowserSessionId
  | BrowserWindowId
  | BrowserSpaceId
  | BrowserTabId
  | BrowsingContextId
  | BrowserFrameId
  | BrowserElementId;

function requireTransportId(transportId: string): string {
  if (transportId.trim().length === 0) {
    throw new TypeError("A transport identifier must not be empty.");
  }

  return transportId;
}

export function profileId(transportId: string): BrowserProfileId {
  return {
    kind: "profile",
    transportId: requireTransportId(transportId),
  };
}

export function sessionId(
  browserProfileId: BrowserProfileId,
  transportId: string,
): BrowserSessionId {
  return {
    kind: "session",
    profileId: browserProfileId,
    transportId: requireTransportId(transportId),
  };
}

export function sessionEntityId<Kind extends SessionEntityKind>(
  kind: Kind,
  browserSessionId: BrowserSessionId,
  transportId: string,
): SessionEntityId<Kind> {
  return {
    kind,
    sessionId: browserSessionId,
    transportId: requireTransportId(transportId),
  };
}

export function elementId(
  browserSessionId: BrowserSessionId,
  transportId: string,
  snapshotSequence: number,
): BrowserElementId {
  if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence < 0) {
    throw new TypeError(
      "An element snapshot sequence must be a non-negative safe integer.",
    );
  }

  return {
    kind: "element",
    sessionId: browserSessionId,
    transportId: requireTransportId(transportId),
    snapshotSequence,
  };
}

export function entityIdKey(id: BrowserEntityId): string {
  if (id.kind === "profile") {
    return `${id.kind}\u0000${id.transportId}`;
  }

  if (id.kind === "session") {
    return `${id.kind}\u0000${id.profileId.transportId}\u0000${id.transportId}`;
  }

  const sessionScopedKey = `${id.kind}\u0000${entityIdKey(id.sessionId)}\u0000${id.transportId}`;

  if (id.kind === "element") {
    return `${sessionScopedKey}\u0000${String(id.snapshotSequence)}`;
  }

  return sessionScopedKey;
}

export interface BrowserProfile {
  readonly kind: "profile";
  readonly id: BrowserProfileId;
  readonly name: Observation<string>;
  readonly isDefault: Observation<boolean>;
}

export interface BrowserSession {
  readonly kind: "session";
  readonly id: BrowserSessionId;
  readonly profileId: BrowserProfileId;
  readonly transport: "native-messaging";
  readonly browserVersion: Observation<string>;
  readonly geckoVersion: Observation<string>;
  readonly connectedAt: string;
  readonly state: "connected" | "disconnected";
  readonly capabilities: readonly string[];
}

export interface BrowserWindow {
  readonly kind: "window";
  readonly id: BrowserWindowId;
  readonly profileId: BrowserProfileId;
  readonly focused: Observation<boolean>;
  readonly private: Observation<boolean>;
  readonly state: "open";
}

export interface BrowserSpace {
  readonly kind: "space";
  readonly id: BrowserSpaceId;
  readonly windowId: BrowserWindowId;
  readonly name: Observation<string>;
  readonly order: Observation<number>;
  readonly containerId: Observation<string | null>;
}

export type TabLoadState = "unloaded" | "loading" | "interactive" | "complete";

export type MediaState = "none" | "playing" | "paused" | "picture-in-picture";

export interface BrowserTab {
  readonly kind: "tab";
  readonly id: BrowserTabId;
  readonly windowId: BrowserWindowId;
  readonly spaceId: Observation<BrowserSpaceId | null>;
  readonly browsingContextId: Observation<BrowsingContextId | null>;
  readonly url: Observation<string>;
  readonly title: Observation<string>;
  readonly loadState: Observation<TabLoadState>;
  readonly selected: Observation<boolean>;
  readonly mediaState: Observation<MediaState>;
  readonly containerId: Observation<string | null>;
  readonly private: Observation<boolean>;
  readonly lifecycleState: "open" | "discarded" | "crashed";
}

export interface BrowserBrowsingContext {
  readonly kind: "browsing-context";
  readonly id: BrowsingContextId;
  readonly tabId: BrowserTabId;
  readonly parentId: Observation<BrowsingContextId | null>;
  readonly url: Observation<string>;
  readonly loadState: Observation<TabLoadState>;
}

export interface BrowserFrame {
  readonly kind: "frame";
  readonly id: BrowserFrameId;
  readonly browsingContextId: BrowsingContextId;
  readonly parentFrameId: Observation<BrowserFrameId | null>;
  readonly url: Observation<string>;
  readonly loadState: Observation<TabLoadState>;
}

export interface BrowserElement {
  readonly kind: "element";
  readonly id: BrowserElementId;
  readonly tabId: BrowserTabId;
  readonly frameId: BrowserFrameId;
  readonly snapshotSequence: number;
  readonly role: Observation<string>;
  readonly name: Observation<string>;
}

export type BrowserEntity =
  | BrowserProfile
  | BrowserSession
  | BrowserWindow
  | BrowserSpace
  | BrowserTab
  | BrowserBrowsingContext
  | BrowserFrame
  | BrowserElement;

export interface BrowserSnapshot {
  readonly schemaVersion: BrowserModelVersion;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly privateWindowPolicy: PrivateWindowPolicy;
  readonly profiles: readonly BrowserProfile[];
  readonly sessions: readonly BrowserSession[];
  readonly windows: readonly BrowserWindow[];
  readonly spaces: readonly BrowserSpace[];
  readonly tabs: readonly BrowserTab[];
  readonly browsingContexts: readonly BrowserBrowsingContext[];
  readonly frames: readonly BrowserFrame[];
  readonly elements: readonly BrowserElement[];
}

export type StaleReason =
  "closed" | "crashed" | "missing-after-reconnect" | "session-replaced";

export type RegistryChange =
  | Readonly<{ type: "entity.upserted"; entity: BrowserEntity }>
  | Readonly<{
      type: "entity.removed";
      id: BrowserEntityId;
      reason: Extract<StaleReason, "closed">;
    }>
  | Readonly<{ type: "tab.crashed"; id: BrowserTabId }>
  | Readonly<{
      type: "session.replaced";
      previousSessionId: BrowserSessionId;
      session: BrowserSession;
    }>;

export interface BrowserDelta {
  readonly schemaVersion: BrowserModelVersion;
  readonly sequence: number;
  readonly observedAt: string;
  readonly changes: readonly RegistryChange[];
}

export function snapshotEntities(
  snapshot: BrowserSnapshot,
): readonly BrowserEntity[] {
  return [
    ...snapshot.profiles,
    ...snapshot.sessions,
    ...snapshot.windows,
    ...snapshot.spaces,
    ...snapshot.tabs,
    ...snapshot.browsingContexts,
    ...snapshot.frames,
    ...snapshot.elements,
  ];
}
