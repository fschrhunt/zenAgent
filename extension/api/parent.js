/**
 * Zen Agent's privileged parent script.
 *
 * This runs inside Zen with system privileges, which is the only vantage point
 * from which every Space is visible: `gZenWorkspaces.allStoredTabs` walks every
 * `<zen-workspace>`, whereas `gBrowser.tabs` — the collection WebDriver BiDi
 * and a plain WebExtension both enumerate through — returns only the Space the
 * user is currently looking at. ADR 0001 records why that difference decided
 * the architecture.
 *
 * Two rules govern every function below:
 *
 *   1. Never select a tab, focus a window, or switch the visible Space. The
 *      dangerous call is Zen's patched `set selectedTab`, which switches Space
 *      when the target belongs to another one.
 *   2. Never assume a Zen internal exists. `capabilities()` probes for each,
 *      and the terminal side refuses to call anything it was not told about.
 *
 * `var` on the class is deliberate: `SchemaAPIManager` reads the class back off
 * the sandbox global, and a lexical binding would not be a property of it.
 */

"use strict";

const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);
const { setTimeout: setActorTimeout, clearTimeout: clearActorTimeout } =
  ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/** Schemes we will open with a system principal. Anything else is refused. */
const OPENABLE_SCHEMES = new Set(["http:", "https:"]);
const PAGE_ACTOR_NAME = "ZenAgentPage";
const PAGE_ACTOR_RESOURCE = "zen-agent-page";
const DEFAULT_INSPECTION_CHARS = 2_000;
const MAX_INSPECTION_CHARS = 10_000;
const INSPECTION_TIMEOUT_MS = 8_000;
const PAGE_OPERATION_TIMEOUT_MS = 8_000;
const RESOURCE_FETCH_TIMEOUT_MS = 60_000;
const MEDIA_FETCH_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PAGE_NODES = 1_000;
const MAX_PAGE_NODES = 5_000;
const MAX_PAGE_FRAMES = 128;
const MAX_PAGE_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_RESULTS = 100;
const PAGE_REFERENCE_TTL_MS = 60_000;
const MAX_SNAPSHOTS_PER_TAB = 16;
const MAX_UPLOAD_FILES = 32;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 4_096;
const MAX_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
const ACCEPTED_BACKGROUND_PAGE_BUILD_KEYS = new Set(["1.21.9b/153.0"]);
let pageActorRegistered = false;
let pageActorRegistrationError = null;
let pageActorResourceRegistered = false;
let extensionVersion = null;

/**
 * Tab attributes worth reporting a change for. `TabAttrModified` is extremely
 * chatty; forwarding all of it would flood the port for no benefit.
 */
const INTERESTING_ATTRIBUTES = new Set([
  "label",
  "busy",
  "soundplaying",
  "crashed",
  "pending",
  "usercontextid",
  "zen-workspace-id",
  "zen-essential",
]);

/**
 * Identity, minted here and held only in memory.
 *
 * Keyed on the tab element, so an identifier survives moving the tab between
 * Spaces and windows — both are DOM moves of the same element — but not a
 * browser restart. That is exactly the lifetime the browser model gives a
 * session-scoped entity, and it means Zen Agent writes nothing to the profile
 * to obtain identity.
 */
const identity = {
  byNode: new WeakMap(),
  byId: new Map(),
};

function identify(node) {
  let id = identity.byNode.get(node);

  if (id === undefined) {
    id = Services.uuid.generateUUID().toString().slice(1, -1);
    identity.byNode.set(node, id);
    identity.byId.set(id, new WeakRef(node));
  }

  return id;
}

function resolve(id) {
  const node = identity.byId.get(id)?.deref();

  if (node === undefined) {
    identity.byId.delete(id);
    throw new ZenAgentError("stale-id", `Nothing is known by id ${id}.`);
  }

  return node;
}

class ZenAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ZenAgentError";
    this.code = code;
  }
}

/**
 * Return failures as values rather than throwing them.
 *
 * WebExtension replaces any exception that is not an internal `ExtensionError`
 * with a bare "An unexpected error occurred", which turns every failure in a
 * privileged API into an unactionable one. Since ADR 0001 names drift in Zen's
 * internals as this transport's main risk, losing the message is the one thing
 * that must not happen. An outcome envelope crosses the boundary intact.
 */
function guarded(operation, run) {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error && typeof error.code === "string" ? error.code : "internal",
        message: `${operation}: ${String(
          error && error.message ? error.message : error,
        )}`,
        stack: error && error.stack ? String(error.stack) : null,
      },
    };
  }
}

async function guardedAsync(operation, run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error && typeof error.code === "string" ? error.code : "internal",
        message: `${operation}: ${String(
          error && error.message ? error.message : error,
        )}`,
        stack: error && error.stack ? String(error.stack) : null,
      },
    };
  }
}

function registerPageActor(context) {
  extensionVersion =
    typeof context.extension.manifest?.version === "string"
      ? context.extension.manifest.version
      : null;
  if (pageActorRegistered) {
    return;
  }

  try {
    const root = context.extension.rootURI;
    const resourceProtocol = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsISubstitutingProtocolHandler);

    if (resourceProtocol.hasSubstitution(PAGE_ACTOR_RESOURCE)) {
      throw new ZenAgentError(
        "unsupported-capability",
        "The page-inspection resource name is already registered.",
      );
    }

    resourceProtocol.setSubstitution(PAGE_ACTOR_RESOURCE, root);
    pageActorResourceRegistered = true;
    ChromeUtils.registerWindowActor(PAGE_ACTOR_NAME, {
      allFrames: true,
      matches: ["http://*/*", "https://*/*"],
      parent: {
        esModuleURI: `resource://${PAGE_ACTOR_RESOURCE}/actors/ZenAgentPageParent.sys.mjs`,
      },
      child: {
        esModuleURI: `resource://${PAGE_ACTOR_RESOURCE}/actors/ZenAgentPageChild.sys.mjs`,
      },
    });
    pageActorRegistered = true;
    pageActorRegistrationError = null;
  } catch (error) {
    if (pageActorResourceRegistered) {
      try {
        const resourceProtocol = Services.io
          .getProtocolHandler("resource")
          .QueryInterface(Ci.nsISubstitutingProtocolHandler);
        resourceProtocol.setSubstitution(PAGE_ACTOR_RESOURCE, null);
      } catch {
        // Preserve the registration error that made the capability unavailable.
      }
      pageActorResourceRegistered = false;
    }

    pageActorRegistrationError = String(
      error && error.message ? error.message : error,
    );
  }
}

/** Every open browser window that has finished wiring up Zen's Space manager. */
function browserWindows() {
  const windows = [];

  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.closed || !win.gBrowser || !win.gZenWorkspaces) {
      continue;
    }

    windows.push(win);
  }

  return windows;
}

/**
 * The window a tab belongs to.
 *
 * `ownerGlobal` is not dependable from this sandbox — it came back empty for a
 * tab sitting in a non-visible Space — so fall back to the owning document and
 * finally to asking each window whether it holds the tab. The last check uses
 * `allStoredTabs` rather than `gBrowser.tabs`, because a tab in another Space
 * is absent from the latter, which is the blind spot this whole transport
 * exists to route around.
 */
function windowOf(tab) {
  const direct = tab.ownerGlobal ?? tab.ownerDocument?.defaultView;

  if (direct?.gBrowser) {
    return direct;
  }

  for (const win of browserWindows()) {
    const tabs = win.gZenWorkspaces.allStoredTabs ?? win.gBrowser.tabs;

    for (const candidate of tabs) {
      if (candidate === tab) {
        return win;
      }
    }
  }

  throw new ZenAgentError(
    "stale-id",
    "That tab no longer belongs to an open window.",
  );
}

function anyWindow() {
  const [win] = browserWindows();

  if (win === undefined) {
    throw new ZenAgentError(
      "browser-unavailable",
      "No Zen window is available yet.",
    );
  }

  return win;
}

function currentBuildKey() {
  return `${Services.appinfo.version}/${Services.appinfo.platformVersion}`;
}

function hiddenDomWindow() {
  try {
    return Services.appShell.hiddenDOMWindow;
  } catch {
    return null;
  }
}

function pageActorPrimitive() {
  return pageActorRegistered;
}

function historyPrimitive(win) {
  const browser = win.gBrowser.selectedBrowser;
  return (
    pageActorPrimitive() &&
    typeof browser?.goBack === "function" &&
    typeof browser?.goForward === "function"
  );
}

function uploadPrimitive() {
  const hidden = hiddenDomWindow();
  return (
    pageActorPrimitive() &&
    typeof hidden?.File?.createFromFileName === "function" &&
    typeof hidden?.HTMLInputElement?.prototype?.mozSetFileArray === "function"
  );
}

function streamingFetchPrimitive() {
  const hidden = hiddenDomWindow();
  return (
    pageActorPrimitive() &&
    typeof hidden?.fetch === "function" &&
    typeof hidden?.ReadableStream === "function" &&
    hidden?.Response?.prototype !== undefined &&
    "body" in hidden.Response.prototype
  );
}

function mediaPrimitive() {
  const hidden = hiddenDomWindow();
  return (
    streamingFetchPrimitive() &&
    typeof hidden?.HTMLMediaElement === "function" &&
    typeof hidden?.TextTrack === "function"
  );
}

function screenshotPrimitive(win) {
  const globals = [
    hiddenDomWindow()?.browsingContext?.currentWindowGlobal,
    win?.browsingContext?.currentWindowGlobal,
  ];

  // Capability discovery runs before the fixture's first content tab is
  // necessarily loaded. Inspect every already-live browsing context, but do
  // not make support depend on the selected tab or trigger a load to create
  // one.
  for (const tab of win?.gZenWorkspaces?.allStoredTabs ?? []) {
    globals.push(tab?.linkedBrowser?.browsingContext?.currentWindowGlobal);
  }

  return (
    pageActorPrimitive() &&
    globals.some(
      (windowGlobal) => typeof windowGlobal?.drawSnapshot === "function",
    )
  );
}

/**
 * Each accepted page capability has its own build gate and primitive probe.
 *
 * The gates currently contain the same exact headed-proof tuple, but remain
 * separate entries so proving one new surface never advertises its siblings.
 * A probe is deliberately read-only and must not load a tab or instantiate UI.
 */
const PAGE_CAPABILITY_SPECS = [
  { name: "browser.pages.inspect", probe: pageActorPrimitive },
  { name: "browser.pages.snapshot", probe: pageActorPrimitive },
  { name: "browser.pages.query", probe: pageActorPrimitive },
  { name: "browser.pages.click", probe: pageActorPrimitive },
  { name: "browser.pages.fill", probe: pageActorPrimitive },
  { name: "browser.pages.type", probe: pageActorPrimitive },
  { name: "browser.pages.press", probe: pageActorPrimitive },
  { name: "browser.pages.select", probe: pageActorPrimitive },
  { name: "browser.pages.check", probe: pageActorPrimitive },
  { name: "browser.pages.submit", probe: pageActorPrimitive },
  { name: "browser.pages.history", probe: historyPrimitive },
  { name: "browser.pages.upload", probe: uploadPrimitive },
  { name: "browser.pages.media", probe: mediaPrimitive },
  { name: "browser.pages.resource-fetch", probe: streamingFetchPrimitive },
  { name: "browser.pages.screenshot", probe: screenshotPrimitive },
].map((spec) => ({
  ...spec,
  acceptedBuilds: ACCEPTED_BACKGROUND_PAGE_BUILD_KEYS,
}));

function acceptedPageCapabilities(win, tab) {
  const build = currentBuildKey();
  const found = [];

  for (const spec of PAGE_CAPABILITY_SPECS) {
    if (!spec.acceptedBuilds.has(build)) {
      continue;
    }

    try {
      if (spec.probe(win, tab)) {
        found.push(spec.name);
      }
    } catch {
      // A missing or throwing primitive means the capability is unavailable.
    }
  }

  return found;
}

/**
 * Probe for the internals this transport depends on.
 *
 * Reported honestly rather than optimistically: the terminal side turns a
 * missing capability into a refusal naming the Zen version, which is far more
 * useful than a stack trace from calling something that moved.
 */
function capabilities() {
  const found = [];
  const [win] = browserWindows();

  if (win === undefined) {
    return found;
  }

  const zen = win.gZenWorkspaces;

  if (typeof zen.getWorkspaces === "function") {
    found.push("zen.spaces.enumerate");
  }

  if (typeof zen.moveTabToWorkspace === "function") {
    found.push("zen.spaces.route");
  }

  // Reading the getter is the only honest probe: Zen has changed where this
  // lives, and `in` would be satisfied by a property that throws.
  try {
    if (Array.isArray(zen.allStoredTabs)) {
      found.push("zen.tabs.enumerate-all-spaces");
    }
  } catch {
    // Left unreported, which is the point.
  }

  if (typeof win.gBrowser.addTab === "function") {
    found.push("zen.tabs.open-background");
  }

  if (win.gBrowser.selectedTab) {
    found.push("browser.tabs.selected");
  }

  if (Services.focus) {
    found.push("browser.windows.focused");
  }

  if (typeof PrivateBrowsingUtils.isWindowPrivate === "function") {
    found.push("browser.windows.private");
  }

  const [tab] = win.gBrowser.tabs;

  if (tab && "soundPlaying" in tab) {
    found.push("browser.tabs.media-state");
  }

  found.push(...acceptedPageCapabilities(win, tab));

  return found;
}

/** Minted once per browser run, so a restart is visible as a new session. */
const sessionToken = Services.uuid.generateUUID().toString().slice(1, -1);

function describe() {
  return {
    profileId: Services.dirsvc.get("ProfD", Ci.nsIFile).leafName,
    sessionId: sessionToken,
    browserVersion: Services.appinfo.version,
    geckoVersion: Services.appinfo.platformVersion,
    extensionVersion,
    capabilities: capabilities(),
    profileName: null,
    isDefaultProfile: null,
  };
}

function loadStateOf(tab) {
  if (!tab.linkedPanel) {
    return "unloaded";
  }

  return tab.hasAttribute("busy") ? "loading" : "complete";
}

function lifecycleOf(tab) {
  if (tab.hasAttribute("crashed")) {
    return "crashed";
  }

  // Matches the WebExtension `tabs.Tab.discarded` definition: a tab with no
  // linked panel exists in the strip but holds no content process.
  return tab.linkedPanel ? "open" : "discarded";
}

function urlOf(tab) {
  try {
    return tab.linkedBrowser?.currentURI?.spec ?? null;
  } catch {
    return null;
  }
}

function describeTab(win, tab) {
  const spaceId = tab.getAttribute("zen-workspace-id");

  return {
    id: identify(tab),
    // An essential tab carries no Space attribute and belongs to none.
    spaceId: spaceId === "" ? null : spaceId,
    url: urlOf(tab),
    title: tab.label || null,
    loadState: loadStateOf(tab),
    selected: win.gBrowser.selectedTab === tab,
    soundPlaying: "soundPlaying" in tab ? Boolean(tab.soundPlaying) : null,
    containerId: tab.getAttribute("usercontextid"),
    private: PrivateBrowsingUtils.isWindowPrivate(win),
    lifecycleState: lifecycleOf(tab),
    essential: tab.getAttribute("zen-essential") === "true",
  };
}

function describeSpaces(zen) {
  if (typeof zen.getWorkspaces !== "function") {
    return [];
  }

  return zen.getWorkspaces().map((space, order) => ({
    id: space.uuid,
    name: space.name ?? null,
    order,
    containerId:
      space.containerTabId === undefined || space.containerTabId === null
        ? null
        : String(space.containerTabId),
  }));
}

/**
 * Every tab in every Space of one window.
 *
 * The cached `_allStoredTabs` is cleared first because Zen moves a tab's DOM
 * position and its `zen-workspace-id` separately, and a stale cache is how a
 * tab ends up reported in the Space it just left.
 */
function storedTabs(win) {
  const zen = win.gZenWorkspaces;

  try {
    zen._allStoredTabs = null;
  } catch {
    // The cache is an implementation detail; not being able to clear it is not
    // fatal, only less fresh.
  }

  const tabs = zen.allStoredTabs;
  return Array.isArray(tabs) ? tabs : Array.from(win.gBrowser.tabs);
}

function snapshot() {
  const windows = browserWindows().map((win) => ({
    id: identify(win),
    private: PrivateBrowsingUtils.isWindowPrivate(win),
    focused: Services.focus.activeWindow === win,
    spaces: describeSpaces(win.gZenWorkspaces),
    tabs: storedTabs(win).map((tab) => describeTab(win, tab)),
  }));

  return {
    session: describe(),
    capturedAt: new Date().toISOString(),
    windows,
  };
}

function assertOpenableUrl(url) {
  let parsed;

  try {
    // `Services.io` rather than the `URL` constructor: this sandbox is created
    // by SchemaAPIManager and does not reliably carry WebIDL globals.
    parsed = Services.io.newURI(String(url));
  } catch {
    throw new ZenAgentError("invalid-request", "That is not a valid URL.");
  }

  if (!OPENABLE_SCHEMES.has(`${parsed.scheme}:`)) {
    // These tabs are opened with a system principal, so the scheme allowlist is
    // a security boundary, not a convenience. `javascript:`, `file:`, `data:`
    // and privileged `about:` pages are all refused here deliberately.
    throw new ZenAgentError(
      "invalid-request",
      `Zen Agent will not open a ${parsed.scheme}: URL.`,
    );
  }

  return parsed.spec;
}

function windowFor(windowId) {
  if (windowId === undefined || windowId === null) {
    return anyWindow();
  }

  const win = resolve(windowId);

  if (win.closed) {
    throw new ZenAgentError("stale-id", "That window has closed.");
  }

  return win;
}

/**
 * Recheck live foreground and media state immediately before an existing-tab
 * mutation. The daemon's snapshot check gives callers an early refusal, while
 * this synchronous browser-chrome check closes the race in which the user
 * selects the tab or starts playback after discovery.
 */
function safeMutationWindow(tab) {
  const win = windowOf(tab);

  if (win.gBrowser.selectedTab === tab) {
    throw new ZenAgentError(
      "policy-rejection",
      "Zen Agent will not mutate the currently selected tab.",
    );
  }

  if ("soundPlaying" in tab && Boolean(tab.soundPlaying)) {
    throw new ZenAgentError(
      "policy-rejection",
      "Zen Agent will not mutate a tab that is playing media.",
    );
  }

  return win;
}

/**
 * Open a background tab, optionally routed into an explicit Space.
 *
 * `inBackground: true` keeps the selected tab put, and `moveTabToWorkspace` is
 * an attribute-and-DOM move that leaves the visible Space alone. The one thing
 * this must never do is set `selectedTab`, which switches Space.
 */
function openTab(options) {
  const url = assertOpenableUrl(options.url);
  const win = windowFor(options.windowId);
  const zen = win.gZenWorkspaces;

  const createOptions = {
    inBackground: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  };

  if (options.zenSpaceUuid !== undefined && options.zenSpaceUuid !== null) {
    const space = describeSpaces(zen).find(
      (candidate) => candidate.id === options.zenSpaceUuid,
    );

    if (space === undefined) {
      throw new ZenAgentError(
        "stale-id",
        "That Space does not exist in this window.",
      );
    }

    if (space.containerId !== null) {
      createOptions.userContextId = Number(space.containerId);
    }
  }

  const tab = win.gBrowser.addTab(url, createOptions);

  if (options.zenSpaceUuid !== undefined && options.zenSpaceUuid !== null) {
    if (typeof zen.moveTabToWorkspace !== "function") {
      // Close what we opened rather than leave it in whichever Space happens to
      // be visible, which is the wrong-Space outcome the product forbids.
      win.gBrowser.removeTab(tab);
      throw new ZenAgentError(
        "unsupported-capability",
        "This Zen build cannot route a tab into a Space.",
      );
    }

    zen.moveTabToWorkspace(tab, options.zenSpaceUuid);
  }

  return { tabId: identify(tab) };
}

/**
 * Route an existing tab into a Space.
 *
 * The tab element is moved, not recreated, so its identifier is preserved —
 * which is the whole basis of reusing a tab rather than opening a duplicate.
 */
function moveTab(tabId, zenSpaceUuid) {
  const tab = resolve(tabId);
  const win = safeMutationWindow(tab);
  const zen = win.gZenWorkspaces;

  if (typeof zen?.moveTabToWorkspace !== "function") {
    throw new ZenAgentError(
      "unsupported-capability",
      "This Zen build cannot route a tab into a Space.",
    );
  }

  if (!describeSpaces(zen).some((space) => space.id === zenSpaceUuid)) {
    throw new ZenAgentError("stale-id", "That Space does not exist.");
  }

  zen.moveTabToWorkspace(tab, zenSpaceUuid);
  return { tabId };
}

function navigateTab(tabId, url) {
  const tab = resolve(tabId);
  safeMutationWindow(tab);
  const target = assertOpenableUrl(url);

  if (!tab.linkedBrowser) {
    throw new ZenAgentError("stale-id", "That tab is no longer navigable.");
  }

  tab.linkedBrowser.loadURI(Services.io.newURI(target), {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });

  return {};
}

function reloadTab(tabId) {
  const tab = resolve(tabId);
  safeMutationWindow(tab);

  if (!tab.linkedBrowser || typeof tab.linkedBrowser.reload !== "function") {
    throw new ZenAgentError("stale-id", "That tab is no longer reloadable.");
  }

  tab.linkedBrowser.reload();
  return {};
}

function inspectionCharacterLimit(options) {
  const requested = options?.maxChars ?? DEFAULT_INSPECTION_CHARS;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_INSPECTION_CHARS
  ) {
    throw new ZenAgentError(
      "invalid-request",
      `maxChars must be an integer from 1 through ${MAX_INSPECTION_CHARS}.`,
    );
  }

  return requested;
}

async function inspectPage(tabId, options) {
  if (!pageActorRegistered) {
    throw new ZenAgentError(
      "unsupported-capability",
      pageActorRegistrationError === null
        ? "The page-inspection actor is unavailable."
        : `The page-inspection actor could not be registered: ${pageActorRegistrationError}`,
    );
  }

  const tab = resolve(tabId);
  windowOf(tab);

  if (lifecycleOf(tab) !== "open" || !tab.linkedBrowser) {
    throw new ZenAgentError(
      "unsupported-capability",
      "That tab has no loaded document to inspect.",
    );
  }

  const current = tab.linkedBrowser.currentURI;

  if (!current || !OPENABLE_SCHEMES.has(`${current.scheme}:`)) {
    throw new ZenAgentError(
      "unsupported-capability",
      "Page inspection supports loaded HTTP(S) tabs only.",
    );
  }

  const windowGlobal = tab.linkedBrowser.browsingContext?.currentWindowGlobal;

  if (!windowGlobal) {
    throw new ZenAgentError(
      "stale-id",
      "That tab's current document is no longer available.",
    );
  }

  const actor = windowGlobal.getActor(PAGE_ACTOR_NAME);
  const query = actor.inspect({
    maxChars: inspectionCharacterLimit(options),
  });
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setActorTimeout(() => {
      reject(
        new ZenAgentError(
          "timeout",
          `Page inspection did not answer within ${INSPECTION_TIMEOUT_MS}ms.`,
        ),
      );
    }, INSPECTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([query, deadline]);
  } finally {
    clearActorTimeout(timeout);
  }
}

/**
 * Page content is never retained here. A live snapshot stores only opaque
 * routing and generation metadata needed to address the right WindowGlobal.
 */
const pageSnapshots = new Map();

function pageUuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function utf8ByteLength(value) {
  let bytes = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}

function pageNodeLimit(options) {
  const requested = options?.maxNodes ?? DEFAULT_PAGE_NODES;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_PAGE_NODES
  ) {
    throw new ZenAgentError(
      "invalid-request",
      `maxNodes must be an integer from 1 through ${MAX_PAGE_NODES}.`,
    );
  }

  return requested;
}

function pageQueryLimit(options) {
  const requested = options?.maxResults ?? 20;

  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_QUERY_RESULTS
  ) {
    throw new ZenAgentError(
      "invalid-request",
      `maxResults must be an integer from 1 through ${MAX_QUERY_RESULTS}.`,
    );
  }

  return requested;
}

function actorForWindowGlobal(windowGlobal) {
  if (!windowGlobal) {
    throw new ZenAgentError(
      "stale-frame",
      "That frame's current document is unavailable.",
    );
  }

  return windowGlobal.getActor(PAGE_ACTOR_NAME);
}

function topPageContext(tab) {
  if (lifecycleOf(tab) !== "open" || !tab.linkedBrowser) {
    throw new ZenAgentError(
      "unsupported-capability",
      "That tab has no loaded document to interact with.",
    );
  }

  const current = tab.linkedBrowser.currentURI;

  if (!current || !OPENABLE_SCHEMES.has(`${current.scheme}:`)) {
    throw new ZenAgentError(
      "unsupported-capability",
      "Page interaction supports loaded HTTP(S) tabs only.",
    );
  }

  const browsingContext = tab.linkedBrowser.browsingContext;

  if (!browsingContext?.currentWindowGlobal) {
    throw new ZenAgentError(
      "stale-document",
      "That tab's current document is unavailable.",
    );
  }

  return browsingContext;
}

async function actorDeadline(
  operation,
  promise,
  timeoutMs = PAGE_OPERATION_TIMEOUT_MS,
) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setActorTimeout(() => {
      reject(
        new ZenAgentError(
          "timeout",
          `${operation} did not answer within ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearActorTimeout(timeout);
  }
}

function browsingContextChildren(context) {
  try {
    return Array.from(context.children ?? []);
  } catch {
    return [];
  }
}

function browsingContextTree(root) {
  const result = [];
  const stack = [{ context: root, parentId: null }];

  while (stack.length > 0 && result.length < MAX_PAGE_FRAMES) {
    const entry = stack.pop();

    if (entry === undefined) {
      break;
    }

    result.push(entry);
    const children = browsingContextChildren(entry.context);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];

      if (child !== undefined) {
        stack.push({ context: child, parentId: entry.context.id });
      }
    }
  }

  return {
    entries: result,
    truncated: stack.length > 0,
  };
}

function prunePageSnapshots() {
  const expiresBefore = Date.now() - PAGE_REFERENCE_TTL_MS;

  for (const [snapshotId, snapshot] of pageSnapshots) {
    if (snapshot.createdAt < expiresBefore) {
      pageSnapshots.delete(snapshotId);
    }
  }
}

function rememberPageSnapshot(snapshot) {
  prunePageSnapshots();

  const sameTab = [...pageSnapshots.entries()].filter(
    ([, candidate]) => candidate.tabId === snapshot.tabId,
  );

  while (sameTab.length >= MAX_SNAPSHOTS_PER_TAB) {
    const oldest = sameTab.shift();

    if (oldest !== undefined) {
      pageSnapshots.delete(oldest[0]);
    }
  }

  pageSnapshots.set(snapshot.snapshotId, snapshot);
}

async function snapshotPage(tabId, options) {
  if (!pageActorRegistered) {
    throw new ZenAgentError(
      "unsupported-capability",
      "The page-interaction actor is unavailable.",
    );
  }

  const tab = resolve(tabId);
  windowOf(tab);
  const root = topPageContext(tab);
  const maxNodes = pageNodeLimit(options);
  const snapshotId = pageUuid();
  const tree = browsingContextTree(root);
  const frameRefByContextId = new Map(
    tree.entries.map(({ context }) => [context.id, pageUuid()]),
  );
  const frames = [];
  const nodes = [];
  const routing = new Map();
  let nodesTruncated = false;
  let stringsTruncated = false;
  let topDocumentId = null;
  let topTitle = "";

  for (const { context, parentId } of tree.entries) {
    const frameRef = frameRefByContextId.get(context.id);

    if (frameRef === undefined) {
      continue;
    }

    const parentFrameRef =
      parentId === null ? null : (frameRefByContextId.get(parentId) ?? null);
    const windowGlobal = context.currentWindowGlobal;

    if (!windowGlobal) {
      frames.push({
        frameRef,
        parentFrameRef,
        documentId: null,
        url: "",
        loadState: "unavailable",
        availability: "stale",
      });
      continue;
    }

    let frame;

    try {
      frame = await actorDeadline(
        "Page snapshot",
        actorForWindowGlobal(windowGlobal).snapshot({
          snapshotId,
          maxNodes: Math.max(1, maxNodes - nodes.length),
        }),
      );
    } catch (error) {
      if (context === root) {
        throw error;
      }

      frames.push({
        frameRef,
        parentFrameRef,
        documentId: null,
        url: "",
        loadState: "unavailable",
        availability: "unsupported",
      });
      continue;
    }

    if (context === root) {
      topDocumentId = frame.documentId;
      topTitle = frame.title;
    }

    frames.push({
      frameRef,
      parentFrameRef,
      documentId: frame.documentId,
      url: frame.url,
      loadState: frame.loadState,
      availability: "available",
    });
    routing.set(frameRef, {
      browsingContextId: context.id,
      documentId: frame.documentId,
    });

    for (const node of frame.nodes) {
      nodes.push({ ...node, frameRef });
    }

    nodesTruncated ||= Boolean(frame.truncated);
    stringsTruncated ||= Boolean(frame.stringsTruncated);

    if (nodes.length >= maxNodes) {
      nodesTruncated = true;
      break;
    }
  }

  if (topDocumentId === null) {
    throw new ZenAgentError(
      "stale-document",
      "The top-level document changed during the snapshot.",
    );
  }

  const currentTop = await actorDeadline(
    "Document validation",
    actorForWindowGlobal(root.currentWindowGlobal).documentInfo(),
  );

  if (currentTop.documentId !== topDocumentId) {
    throw new ZenAgentError(
      "stale-document",
      "The top-level document changed during the snapshot.",
    );
  }

  const capturedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    snapshotId,
    documentId: topDocumentId,
    tabId,
    capturedAt,
    url: frames[0]?.url ?? "",
    title: topTitle,
    loadState: frames[0]?.loadState ?? "loading",
    rootFrameRef: frameRefByContextId.get(root.id),
    frames,
    nodes,
    truncation: {
      frames: tree.truncated || frames.length < tree.entries.length,
      nodes: nodesTruncated,
      strings: stringsTruncated,
      totalBytes: false,
    },
  };

  if (utf8ByteLength(JSON.stringify(result)) > MAX_PAGE_RESULT_BYTES) {
    throw new ZenAgentError(
      "payload-too-large",
      "The page snapshot exceeded its serialized result ceiling.",
    );
  }

  rememberPageSnapshot({
    snapshotId,
    tabId,
    documentId: topDocumentId,
    createdAt: Date.now(),
    routing,
  });
  return result;
}

function pageSnapshotFor(target) {
  prunePageSnapshots();
  const snapshot = pageSnapshots.get(target.snapshotId);

  if (snapshot === undefined) {
    throw new ZenAgentError("stale-element", "That page snapshot has expired.");
  }

  if (snapshot.tabId !== target.tabId) {
    throw new ZenAgentError(
      "policy-rejection",
      "The page snapshot does not belong to that tab.",
    );
  }

  if (
    snapshot.documentId !== target.documentId ||
    typeof target.frameRef !== "string"
  ) {
    throw new ZenAgentError(
      "stale-document",
      "That document reference is stale.",
    );
  }

  return snapshot;
}

function contextById(root, id) {
  return browsingContextTree(root).entries.find(
    ({ context }) => context.id === id,
  )?.context;
}

async function resolvedPageActor(target, mutation) {
  const snapshot = pageSnapshotFor(target);
  const tab = resolve(target.tabId);

  if (mutation) {
    safeMutationWindow(tab);
  } else {
    windowOf(tab);
  }

  const root = topPageContext(tab);
  const top = await actorDeadline(
    "Document validation",
    actorForWindowGlobal(root.currentWindowGlobal).documentInfo(),
  );

  if (top.documentId !== snapshot.documentId) {
    throw new ZenAgentError(
      "stale-document",
      "The top-level document reference is stale.",
    );
  }

  const route = snapshot.routing.get(target.frameRef);

  if (route === undefined) {
    throw new ZenAgentError("stale-frame", "That frame reference is stale.");
  }

  const context = contextById(root, route.browsingContextId);

  if (!context?.currentWindowGlobal) {
    throw new ZenAgentError("stale-frame", "That frame is no longer attached.");
  }

  const windowGlobal = context.currentWindowGlobal;
  const actor = actorForWindowGlobal(windowGlobal);
  const current = await actorDeadline("Frame validation", actor.documentInfo());

  if (current.documentId !== route.documentId) {
    throw new ZenAgentError(
      "stale-frame",
      "That frame's document reference is stale.",
    );
  }

  return { actor, frameDocumentId: route.documentId, windowGlobal };
}

async function queryPage(target, options) {
  const { actor, frameDocumentId } = await resolvedPageActor(target, false);
  const result = await actorDeadline(
    "Page query",
    actor.query({
      snapshotId: target.snapshotId,
      documentId: frameDocumentId,
      locator: options.locator,
      maxResults: pageQueryLimit(options),
    }),
  );

  return {
    nodes: result.nodes.map((node) => ({
      ...node,
      frameRef: target.frameRef,
    })),
    truncated: result.truncated,
  };
}

async function mutatePage(operation, target, options = {}) {
  if (typeof target?.elementRef !== "string") {
    throw new ZenAgentError(
      "invalid-request",
      "A page mutation requires an explicit element reference.",
    );
  }

  const { actor, frameDocumentId } = await resolvedPageActor(target, true);
  const result = await actorDeadline(
    `Page ${operation}`,
    actor.mutate({
      ...options,
      operation,
      snapshotId: target.snapshotId,
      documentId: frameDocumentId,
      elementRef: target.elementRef,
    }),
  );
  return {
    performed: true,
    documentId: target.documentId,
    ...(result.fileCount === undefined ? {} : { fileCount: result.fileCount }),
  };
}

function resourceByteLimit(options, maximum = MAX_RESOURCE_BYTES) {
  const requested = options?.maxBytes ?? maximum;

  if (!Number.isInteger(requested) || requested < 1 || requested > maximum) {
    throw new ZenAgentError(
      "invalid-request",
      `maxBytes must be an integer from 1 through ${maximum}.`,
    );
  }

  return requested;
}

async function uploadPage(target, paths) {
  if (
    !Array.isArray(paths) ||
    paths.length < 1 ||
    paths.length > MAX_UPLOAD_FILES ||
    !paths.every(
      (path) =>
        typeof path === "string" && path.length > 0 && path.length <= 4_096,
    )
  ) {
    throw new ZenAgentError(
      "invalid-request",
      `Upload requires 1 through ${MAX_UPLOAD_FILES} staged file paths.`,
    );
  }

  const files = [];
  const parentFile = Services.appShell.hiddenDOMWindow.File;
  for (const path of paths) {
    try {
      files.push(await parentFile.createFromFileName(path));
    } catch {
      throw new ZenAgentError(
        "invalid-request",
        "An explicit staged upload file is unavailable.",
      );
    }
  }

  return mutatePage("upload", target, { files });
}

async function listPageMedia(target) {
  const { actor, frameDocumentId } = await resolvedPageActor(target, false);
  const result = await actorDeadline(
    "Media inspection",
    actor.media({
      snapshotId: target.snapshotId,
      documentId: frameDocumentId,
    }),
  );

  return {
    media: result.media.map((media) => ({
      ...media,
      frameRef: target.frameRef,
    })),
    truncated: result.truncated,
  };
}

async function fetchPageResource(target, url, options) {
  if (typeof url !== "string" || url.length < 1 || url.length > 64 * 1024) {
    throw new ZenAgentError(
      "invalid-request",
      "A bounded resource URL is required.",
    );
  }

  const { actor, frameDocumentId } = await resolvedPageActor(target, false);
  return actorDeadline(
    "Resource fetch",
    actor.resource({
      documentId: frameDocumentId,
      url,
      maxBytes: resourceByteLimit(options),
    }),
    RESOURCE_FETCH_TIMEOUT_MS,
  );
}

async function fetchPageMedia(target, options) {
  if (typeof target?.elementRef !== "string") {
    throw new ZenAgentError(
      "invalid-request",
      "Media fetch requires an explicit media element reference.",
    );
  }

  const { actor, frameDocumentId } = await resolvedPageActor(target, false);
  return actorDeadline(
    "Media resource fetch",
    actor.mediaResource({
      snapshotId: target.snapshotId,
      documentId: frameDocumentId,
      elementRef: target.elementRef,
      maxBytes: resourceByteLimit(options, MAX_MEDIA_RESOURCE_BYTES),
    }),
    MEDIA_FETCH_TIMEOUT_MS,
  );
}

function screenshotScale(options) {
  const scale = options?.scale ?? 1;

  if (
    typeof scale !== "number" ||
    !Number.isFinite(scale) ||
    scale < 0.25 ||
    scale > 2
  ) {
    throw new ZenAgentError(
      "invalid-request",
      "Screenshot scale must be between 0.25 and 2.",
    );
  }

  return scale;
}

function screenshotBackground(options) {
  const background = options?.background ?? "transparent";

  if (
    typeof background !== "string" ||
    !(
      background === "transparent" ||
      /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(background)
    )
  ) {
    throw new ZenAgentError(
      "invalid-request",
      "Screenshot background must be transparent or a six/eight digit hex color.",
    );
  }

  return background;
}

async function screenshotPage(target, options) {
  const { actor, frameDocumentId, windowGlobal } = await resolvedPageActor(
    target,
    false,
  );

  if (typeof windowGlobal.drawSnapshot !== "function") {
    throw new ZenAgentError(
      "unsupported-capability",
      "This Gecko build does not expose background WindowGlobal snapshots.",
    );
  }

  const rect = await actorDeadline(
    "Screenshot geometry",
    actor.screenshotRect({
      snapshotId: target.snapshotId,
      documentId: frameDocumentId,
      ...(typeof target.elementRef === "string"
        ? { elementRef: target.elementRef }
        : {}),
    }),
  );
  const scale = screenshotScale(options);
  const width = Math.ceil(rect.width * scale);
  const height = Math.ceil(rect.height * scale);

  if (
    width < 1 ||
    height < 1 ||
    width > MAX_SCREENSHOT_DIMENSION ||
    height > MAX_SCREENSHOT_DIMENSION ||
    width * height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new ZenAgentError(
      "payload-too-large",
      "The screenshot dimensions exceed the background capture ceiling.",
    );
  }

  const win = windowOf(resolve(target.tabId));
  const image = await actorDeadline(
    "Background screenshot",
    windowGlobal.drawSnapshot(
      new win.DOMRect(rect.x, rect.y, rect.width, rect.height),
      scale,
      screenshotBackground(options),
      false,
    ),
  );
  const canvas = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas",
  );
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    image.close?.();
    throw new ZenAgentError(
      "unsupported-capability",
      "The browser could not encode the background snapshot.",
    );
  }

  context.drawImage(image, 0, 0, width, height);
  image.close?.();
  const encoded = canvas.toDataURL("image/png");
  const dataBase64 = encoded.slice(encoded.indexOf(",") + 1);
  const bytes = win.atob(dataBase64).length;

  if (bytes > MAX_SCREENSHOT_BYTES) {
    throw new ZenAgentError(
      "payload-too-large",
      "The encoded screenshot exceeds the byte ceiling.",
    );
  }

  return { mimeType: "image/png", width, height, bytes, dataBase64 };
}

async function pageHistory(direction, target) {
  const tab = resolve(target.tabId);
  safeMutationWindow(tab);
  const root = topPageContext(tab);
  const top = await actorDeadline(
    "Document validation",
    actorForWindowGlobal(root.currentWindowGlobal).documentInfo(),
  );

  if (top.documentId !== target.documentId) {
    throw new ZenAgentError(
      "stale-document",
      "That top-level document reference is stale.",
    );
  }

  const browser = tab.linkedBrowser;
  const canTravel =
    direction === "back" ? browser.canGoBack : browser.canGoForward;
  const travel = direction === "back" ? browser.goBack : browser.goForward;

  if (!canTravel || typeof travel !== "function") {
    throw new ZenAgentError(
      "unsupported-capability",
      `That tab cannot navigate ${direction}.`,
    );
  }

  travel.call(browser);
  return { performed: true, documentId: target.documentId };
}

function closeTab(tabId) {
  const tab = resolve(tabId);
  safeMutationWindow(tab).gBrowser.removeTab(tab);
  identity.byId.delete(tabId);

  for (const [snapshotId, snapshot] of pageSnapshots) {
    if (snapshot.tabId === tabId) {
      pageSnapshots.delete(snapshotId);
    }
  }

  return {};
}

var zenAgent = class extends ExtensionAPI {
  getAPI(context) {
    registerPageActor(context);

    return {
      zenAgent: {
        describe: async () => guarded("describe", () => describe()),
        snapshot: async () => guarded("snapshot", () => snapshot()),
        openTab: async (options) => guarded("openTab", () => openTab(options)),
        moveTab: async (tabId, zenSpaceUuid) =>
          guarded("moveTab", () => moveTab(tabId, zenSpaceUuid)),
        navigateTab: async (tabId, url) =>
          guarded("navigateTab", () => navigateTab(tabId, url)),
        reloadTab: async (tabId) =>
          guarded("reloadTab", () => reloadTab(tabId)),
        inspectPage: async (tabId, options) =>
          guardedAsync("inspectPage", () => inspectPage(tabId, options)),
        snapshotPage: async (tabId, options) =>
          guardedAsync("snapshotPage", () => snapshotPage(tabId, options)),
        queryPage: async (target, options) =>
          guardedAsync("queryPage", () => queryPage(target, options)),
        clickPage: async (target) =>
          guardedAsync("clickPage", () => mutatePage("click", target)),
        fillPage: async (target, value) =>
          guardedAsync("fillPage", () => mutatePage("fill", target, { value })),
        typePage: async (target, value) =>
          guardedAsync("typePage", () => mutatePage("type", target, { value })),
        pressPage: async (target, options) =>
          guardedAsync("pressPage", () => mutatePage("press", target, options)),
        selectPage: async (target, values) =>
          guardedAsync("selectPage", () =>
            mutatePage("select", target, { values }),
          ),
        checkPage: async (target) =>
          guardedAsync("checkPage", () => mutatePage("check", target)),
        uncheckPage: async (target) =>
          guardedAsync("uncheckPage", () => mutatePage("uncheck", target)),
        submitPage: async (target) =>
          guardedAsync("submitPage", () => mutatePage("submit", target)),
        uploadPage: async (target, paths) =>
          guardedAsync("uploadPage", () => uploadPage(target, paths)),
        listPageMedia: async (target) =>
          guardedAsync("listPageMedia", () => listPageMedia(target)),
        fetchPageMedia: async (target, options) =>
          guardedAsync("fetchPageMedia", () => fetchPageMedia(target, options)),
        fetchPageResource: async (target, url, options) =>
          guardedAsync("fetchPageResource", () =>
            fetchPageResource(target, url, options),
          ),
        screenshotPage: async (target, options) =>
          guardedAsync("screenshotPage", () => screenshotPage(target, options)),
        backPage: async (target) =>
          guardedAsync("backPage", () => pageHistory("back", target)),
        forwardPage: async (target) =>
          guardedAsync("forwardPage", () => pageHistory("forward", target)),
        closeTab: async (tabId) => guarded("closeTab", () => closeTab(tabId)),

        onChanged: new ExtensionCommon.EventManager({
          context,
          name: "zenAgent.onChanged",
          register: (fire) => {
            const emit = (change) => {
              fire.async(change).catch(() => {
                // The event page went away. The client reconciles with a
                // snapshot, so a dropped advisory event is survivable.
              });
            };

            const onTabEvent = (event) => {
              const tab = event.target;
              const win = tab.ownerGlobal;

              if (!win || !win.gBrowser) {
                return;
              }

              switch (event.type) {
                case "TabSelect":
                  // Observation only: never set selectedTab here. Publishing the
                  // newly selected target lets the daemon revoke any lease and
                  // outstanding page references immediately as user takeover.
                  emit({
                    event: "tab.updated",
                    windowId: identify(win),
                    tab: describeTab(win, tab),
                  });
                  break;
                case "TabOpen":
                  emit({
                    event: "tab.created",
                    windowId: identify(win),
                    tab: describeTab(win, tab),
                  });
                  break;
                case "TabClose":
                  emit({
                    event: "tab.removed",
                    windowId: identify(win),
                    tabId: identify(tab),
                  });
                  break;
                case "TabAttrModified":
                  if (
                    !event.detail?.changed?.some((attribute) =>
                      INTERESTING_ATTRIBUTES.has(attribute),
                    )
                  ) {
                    return;
                  }

                  emit({
                    event: tab.hasAttribute("crashed")
                      ? "tab.crashed"
                      : "tab.updated",
                    windowId: identify(win),
                    ...(tab.hasAttribute("crashed")
                      ? { tabId: identify(tab) }
                      : { tab: describeTab(win, tab) }),
                  });
                  break;
              }
            };

            const listen = (win) => {
              for (const type of [
                "TabSelect",
                "TabOpen",
                "TabClose",
                "TabAttrModified",
              ]) {
                win.addEventListener(type, onTabEvent, true);
              }
            };

            const unlisten = (win) => {
              for (const type of [
                "TabSelect",
                "TabOpen",
                "TabClose",
                "TabAttrModified",
              ]) {
                win.removeEventListener(type, onTabEvent, true);
              }
            };

            for (const win of browserWindows()) {
              listen(win);
            }

            // A new or closed window changes which Spaces and tabs exist in
            // ways these tab events cannot express, so the client is told to
            // take a fresh snapshot rather than patch its registry.
            const windowObserver = {
              observe: (subject, topic) => {
                if (topic === "domwindowopened") {
                  subject.addEventListener(
                    "load",
                    () => {
                      if (subject.gBrowser && subject.gZenWorkspaces) {
                        listen(subject);
                      }

                      emit({
                        event: "registry.invalidated",
                        reason: "a window opened",
                      });
                    },
                    { once: true },
                  );
                  return;
                }

                emit({
                  event: "registry.invalidated",
                  reason: "a window closed",
                });
              },
            };

            Services.ww.registerNotification(windowObserver);
            emit({ event: "session.ready", reason: "the extension started" });

            return () => {
              Services.ww.unregisterNotification(windowObserver);

              for (const win of browserWindows()) {
                unlisten(win);
              }
            };
          },
        }).api(),
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (!isAppShutdown && pageActorRegistered) {
      try {
        ChromeUtils.unregisterWindowActor(PAGE_ACTOR_NAME);
      } catch {
        // Browser shutdown or another reload may have removed it first.
      }
    }

    if (!isAppShutdown && pageActorResourceRegistered) {
      try {
        const resourceProtocol = Services.io
          .getProtocolHandler("resource")
          .QueryInterface(Ci.nsISubstitutingProtocolHandler);
        resourceProtocol.setSubstitution(PAGE_ACTOR_RESOURCE, null);
      } catch {
        // Browser shutdown may already have torn the handler down.
      }
    }

    pageActorRegistered = false;
    pageActorResourceRegistered = false;
  }
};
