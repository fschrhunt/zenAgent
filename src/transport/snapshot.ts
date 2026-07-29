/**
 * Translation from what Zen reports into the browser model.
 *
 * The rule this file exists to enforce: everything the extension could not
 * determine becomes an explicit `unknown` or `unsupported`, never a plausible
 * default. A fabricated `selected: false` or an assumed Space is precisely how
 * an agent ends up selecting the user's tab or opening in the wrong Space.
 */

import {
  BROWSER_MODEL_VERSION,
  DEFAULT_PRIVATE_WINDOW_POLICY,
  known,
  profileId,
  sessionEntityId,
  sessionId,
  unknown,
  unsupported,
  type BrowserProfile,
  type BrowserSession,
  type BrowserSessionId,
  type BrowserSnapshot,
  type BrowserSpace,
  type BrowserSpaceId,
  type BrowserTab,
  type BrowserWindow,
  type BrowserWindowId,
  type MediaState,
  type Observation,
  type PrivateWindowPolicy,
  type TabLoadState,
} from "../browser/model.js";
import { knownCapabilities, type TransportCapability } from "./capabilities.js";
import type {
  ZenSnapshotPayload,
  ZenTabPayload,
  ZenWindowPayload,
} from "./payload.js";

/** Capability name reported for browsing contexts, which this transport has none of. */
const BROWSING_CONTEXT_CAPABILITY = "browsing-context.enumerate";

const SPACE_ID_SEPARATOR = "/";

export interface SnapshotOptions {
  readonly sequence: number;
  /** When the transport connected, for the session record. */
  readonly connectedAt: string;
  readonly privateWindowPolicy?: PrivateWindowPolicy;
}

/**
 * Compose a Space's transport identity from its window and Zen uuid.
 *
 * Zen stores Spaces globally but materialises each one as a `<zen-workspace>`
 * element per window, while the model scopes a Space to exactly one window. Two
 * windows showing the same Space would therefore collide on a bare uuid. This
 * composes two identifiers the browser gave us; it does not invent identity
 * from position or title, which the model forbids.
 */
export function spaceTransportId(
  windowId: string,
  zenSpaceUuid: string,
): string {
  return `${windowId}${SPACE_ID_SEPARATOR}${zenSpaceUuid}`;
}

/** Recover the Zen Space uuid from a composed transport identity. */
export function zenSpaceUuid(transportId: string): string {
  const separator = transportId.indexOf(SPACE_ID_SEPARATOR);
  return separator === -1
    ? transportId
    : transportId.slice(separator + SPACE_ID_SEPARATOR.length);
}

function observe<T>(
  value: T | null,
  reason: Parameters<typeof unknown>[0] = "not-reported",
): Observation<T> {
  return value === null ? unknown<T>(reason) : known(value);
}

function observeUrl(tab: ZenTabPayload): Observation<string> {
  if (tab.url !== null) {
    return known(tab.url);
  }

  // A tab restored lazily has no content process yet, which is a different
  // situation from the browser declining to tell us.
  return unknown(tab.loadState === "unloaded" ? "not-loaded" : "not-reported");
}

function observeSelected(
  tab: ZenTabPayload,
  capabilities: readonly TransportCapability[],
): Observation<boolean> {
  if (tab.selected !== null) {
    return known(tab.selected);
  }

  return capabilities.includes("browser.tabs.selected")
    ? unknown("not-reported")
    : unsupported("browser.tabs.selected");
}

/**
 * Media state, reported conservatively.
 *
 * Zen exposes whether a tab is emitting sound, which cannot separate "no media"
 * from "media paused" from "playing silently". Only "playing" is therefore ever
 * asserted. That is enough for the invariant that matters — never interrupt a
 * tab that is playing — and claiming `none` on a paused video would not be.
 */
function observeMediaState(
  tab: ZenTabPayload,
  capabilities: readonly TransportCapability[],
): Observation<MediaState> {
  if (tab.soundPlaying === true) {
    return known("playing");
  }

  if (!capabilities.includes("browser.tabs.media-state")) {
    return unsupported("browser.tabs.media-state");
  }

  return unknown("not-reported");
}

function toSpace(
  space: ZenWindowPayload["spaces"][number],
  windowEntity: BrowserWindow,
  session: BrowserSessionId,
): BrowserSpace {
  return {
    kind: "space",
    id: sessionEntityId(
      "space",
      session,
      spaceTransportId(windowEntity.id.transportId, space.id),
    ),
    windowId: windowEntity.id,
    name: observe(space.name),
    order: observe(space.order),
    containerId: known(space.containerId),
  };
}

/**
 * Build one tab entity.
 *
 * Exported because `delta.ts` builds the same entity from a `tab.updated`
 * event, and a tab that changed shape depending on whether it arrived in a
 * snapshot or an event would be a bug that only shows up under load.
 */
export function toTabEntity(
  tab: ZenTabPayload,
  windowId: BrowserWindowId,
  spacesById: ReadonlyMap<string, BrowserSpaceId>,
  session: BrowserSessionId,
  capabilities: readonly TransportCapability[],
): BrowserTab {
  return {
    kind: "tab",
    id: sessionEntityId("tab", session, tab.id),
    windowId,
    spaceId: observeSpace(tab, spacesById),
    // Browsing contexts belong to a page-level transport. ADR 0001 leaves that
    // door open for BiDi later; this transport genuinely cannot supply them.
    browsingContextId: unsupported(BROWSING_CONTEXT_CAPABILITY),
    url: observeUrl(tab),
    title: observe(tab.title),
    loadState: observe<TabLoadState>(tab.loadState),
    selected: observeSelected(tab, capabilities),
    mediaState: observeMediaState(tab, capabilities),
    containerId: known(tab.containerId),
    private: observe(tab.private),
    lifecycleState: tab.lifecycleState,
  };
}

function observeSpace(
  tab: ZenTabPayload,
  spacesById: ReadonlyMap<string, BrowserSpaceId>,
): Observation<BrowserSpaceId | null> {
  // An essential tab belongs to no Space and is shown across all of them. That
  // is a known null, not an absence of information.
  if (tab.spaceId === null) {
    return known(null);
  }

  const spaceId = spacesById.get(tab.spaceId);

  if (spaceId === undefined) {
    // Zen moves a tab's `zen-workspace-id` and its DOM position separately, so
    // a snapshot taken mid-move can name a Space the window has not listed.
    // Reporting unknown keeps the tab visible without asserting a wrong Space.
    return unknown("temporarily-unavailable");
  }

  return known(spaceId);
}

function toWindow(
  window: ZenWindowPayload,
  profile: BrowserProfile,
  session: BrowserSessionId,
): BrowserWindow {
  return {
    kind: "window",
    id: sessionEntityId("window", session, window.id),
    profileId: profile.id,
    focused: observe(window.focused),
    private: observe(window.private),
    state: "open",
  };
}

/**
 * Build a model snapshot from one `browser.snapshot` result.
 *
 * Under the default `hidden` private-window policy, windows that are not known
 * to be non-private are dropped along with their Spaces and tabs. Unknown
 * private state is excluded too: the model treats "might be private" as private
 * for this purpose, which is the only safe direction.
 */
export function toBrowserSnapshot(
  payload: ZenSnapshotPayload,
  options: SnapshotOptions,
): BrowserSnapshot {
  const privateWindowPolicy =
    options.privateWindowPolicy ?? DEFAULT_PRIVATE_WINDOW_POLICY;
  const capabilities = knownCapabilities(payload.session.capabilities);

  const profile: BrowserProfile = {
    kind: "profile",
    id: profileId(payload.session.profileId),
    name: observe(payload.session.profileName),
    isDefault: observe(payload.session.isDefaultProfile),
  };

  const session = sessionId(profile.id, payload.session.sessionId);
  const sessionEntity: BrowserSession = {
    kind: "session",
    id: session,
    profileId: profile.id,
    transport: "native-messaging",
    browserVersion: known(payload.session.browserVersion),
    geckoVersion: known(payload.session.geckoVersion),
    connectedAt: options.connectedAt,
    state: "connected",
    capabilities,
  };

  const windows: BrowserWindow[] = [];
  const spaces: BrowserSpace[] = [];
  const tabs: BrowserTab[] = [];

  for (const window of payload.windows) {
    if (privateWindowPolicy === "hidden" && window.private !== false) {
      continue;
    }

    const windowEntity = toWindow(window, profile, session);
    windows.push(windowEntity);

    const spacesById = new Map<string, BrowserSpaceId>();

    for (const space of window.spaces) {
      const spaceEntity = toSpace(space, windowEntity, session);
      spaces.push(spaceEntity);
      spacesById.set(space.id, spaceEntity.id);
    }

    for (const tab of window.tabs) {
      tabs.push(
        toTabEntity(tab, windowEntity.id, spacesById, session, capabilities),
      );
    }
  }

  return {
    schemaVersion: BROWSER_MODEL_VERSION,
    sequence: options.sequence,
    capturedAt: payload.capturedAt,
    privateWindowPolicy,
    profiles: [profile],
    sessions: [sessionEntity],
    windows,
    spaces,
    tabs,
    browsingContexts: [],
    frames: [],
    elements: [],
  };
}
