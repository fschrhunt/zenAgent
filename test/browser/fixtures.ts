import {
  BROWSER_MODEL_VERSION,
  DEFAULT_PRIVATE_WINDOW_POLICY,
  elementId,
  known,
  profileId,
  sessionEntityId,
  sessionId,
  unknown,
  type BrowserBrowsingContext,
  type BrowserElement,
  type BrowserFrame,
  type BrowserProfile,
  type BrowserSession,
  type BrowserSnapshot,
  type BrowserSpace,
  type BrowserTab,
  type BrowserWindow,
} from "../../src/browser/model.js";

export interface BrowserFixture {
  readonly profile: BrowserProfile;
  readonly session: BrowserSession;
  readonly window: BrowserWindow;
  readonly space: BrowserSpace;
  readonly tab: BrowserTab;
  readonly context: BrowserBrowsingContext;
  readonly frame: BrowserFrame;
  readonly element: BrowserElement;
  readonly snapshot: BrowserSnapshot;
}

export function browserFixture(
  prefix = "primary",
  sequence = 1,
  profileTransportId = `${prefix}-profile`,
): BrowserFixture {
  const profile = {
    kind: "profile",
    id: profileId(profileTransportId),
    name: known(`${prefix} profile`),
    isDefault: known(prefix === "primary"),
  } satisfies BrowserProfile;
  const session = {
    kind: "session",
    id: sessionId(profile.id, `${prefix}-session`),
    profileId: profile.id,
    transport: "native-messaging",
    browserVersion: known("1.21.9b"),
    geckoVersion: known("153.0"),
    connectedAt: "2026-07-28T20:00:00.000Z",
    state: "connected",
    capabilities: ["tabs", "spaces"],
  } satisfies BrowserSession;
  const window = {
    kind: "window",
    id: sessionEntityId("window", session.id, `${prefix}-window`),
    profileId: profile.id,
    focused: unknown<boolean>("not-reported"),
    private: known(false),
    state: "open",
  } satisfies BrowserWindow;
  const space = {
    kind: "space",
    id: sessionEntityId("space", session.id, `${prefix}-space`),
    windowId: window.id,
    name: known("Personal"),
    order: known(0),
    containerId: known("1"),
  } satisfies BrowserSpace;
  const contextId = sessionEntityId(
    "browsing-context",
    session.id,
    `${prefix}-context`,
  );
  const tab = {
    kind: "tab",
    id: sessionEntityId("tab", session.id, `${prefix}-tab`),
    windowId: window.id,
    spaceId: known(space.id),
    browsingContextId: known(contextId),
    url: known("https://example.com/"),
    title: known("Example"),
    loadState: known("complete"),
    selected: unknown<boolean>("not-reported"),
    mediaState: unknown("not-reported"),
    containerId: known("1"),
    private: known(false),
    lifecycleState: "open",
  } satisfies BrowserTab;
  const context = {
    kind: "browsing-context",
    id: contextId,
    tabId: tab.id,
    parentId: known(null),
    url: known("https://example.com/"),
    loadState: known("complete"),
  } satisfies BrowserBrowsingContext;
  const frame = {
    kind: "frame",
    id: sessionEntityId("frame", session.id, `${prefix}-frame`),
    browsingContextId: context.id,
    parentFrameId: known(null),
    url: known("https://example.com/"),
    loadState: known("complete"),
  } satisfies BrowserFrame;
  const element = {
    kind: "element",
    id: elementId(session.id, `${prefix}-element`, sequence),
    tabId: tab.id,
    frameId: frame.id,
    snapshotSequence: sequence,
    role: known("link"),
    name: known("Example"),
  } satisfies BrowserElement;
  const snapshot = {
    schemaVersion: BROWSER_MODEL_VERSION,
    sequence,
    capturedAt: "2026-07-28T20:00:01.000Z",
    privateWindowPolicy: DEFAULT_PRIVATE_WINDOW_POLICY,
    profiles: [profile],
    sessions: [session],
    windows: [window],
    spaces: [space],
    tabs: [tab],
    browsingContexts: [context],
    frames: [frame],
    elements: [element],
  } satisfies BrowserSnapshot;

  return {
    profile,
    session,
    window,
    space,
    tab,
    context,
    frame,
    element,
    snapshot,
  };
}

export function combineSnapshots(
  sequence: number,
  ...fixtures: readonly BrowserFixture[]
): BrowserSnapshot {
  return {
    schemaVersion: BROWSER_MODEL_VERSION,
    sequence,
    capturedAt: "2026-07-28T20:00:02.000Z",
    privateWindowPolicy: DEFAULT_PRIVATE_WINDOW_POLICY,
    profiles: fixtures.map(({ profile }) => profile),
    sessions: fixtures.map(({ session }) => session),
    windows: fixtures.map(({ window }) => window),
    spaces: fixtures.map(({ space }) => space),
    tabs: fixtures.map(({ tab }) => tab),
    browsingContexts: fixtures.map(({ context }) => context),
    frames: fixtures.map(({ frame }) => frame),
    elements: fixtures.map(({ element }) => element),
  };
}
