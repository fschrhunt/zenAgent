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
let pageActorRegistered = false;
let pageActorRegistrationError = null;
let pageActorResourceRegistered = false;

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
      allFrames: false,
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

  if (pageActorRegistered) {
    found.push("browser.pages.inspect");
  }

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

function closeTab(tabId) {
  const tab = resolve(tabId);
  safeMutationWindow(tab).gBrowser.removeTab(tab);
  identity.byId.delete(tabId);
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
              for (const type of ["TabOpen", "TabClose", "TabAttrModified"]) {
                win.addEventListener(type, onTabEvent, true);
              }
            };

            const unlisten = (win) => {
              for (const type of ["TabOpen", "TabClose", "TabAttrModified"]) {
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
