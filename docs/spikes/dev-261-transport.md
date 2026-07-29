# DEV-261: browser transport spike findings

Status: complete for the transport decision. Everything below marked **Proven**
was observed directly on the machine and environment recorded here, and most of
it is re-runnable with `npm run spike:transport`. Headed focus and media
regression tests remain as product follow-ups.

## Environment

| Component | Value                                              |
| --------- | -------------------------------------------------- |
| Zen       | 1.21.9b (BuildID 20260725024203)                   |
| Gecko     | 153.0 (`Firefox/153.0` user agent)                 |
| macOS     | 27.0 (26A5388g), arm64                             |
| Node      | v26.5.0, npm 11.17.0                               |
| Profiles  | `Default (release)` (daily use), `Default Profile` |

The daily profile lives at
`~/Library/Application Support/zen/Profiles/tddguwg7.Default (release)` and is
the one used for the read-only profile inspection below. One consented BiDi
attach test did write 87 recommended automation preferences and failed to
restore five Personal tabs; section 10 records the preference impact. The
preferences were removed with Zen closed and verified clean afterward. Every
subsequent transport validation used throwaway profiles.

## 1. A running Zen cannot be attached to over BiDi — but can over DevTools RDP

**Proven.** The daily-use Zen process was launched with no arguments at all
(`/Applications/Zen.app/Contents/MacOS/zen`) and holds no listening TCP socket —
`lsof -nP -iTCP -sTCP:LISTEN` against its pid returns nothing.

For **BiDi specifically this is terminal.** `RemoteAgent.sys.mjs` sets its
`#enabled` flag only from the `command-line-startup` observer, which is
unregistered on first fire and is notified only for a `STATE_INITIAL_LAUNCH`
command line. `nsIRemoteAgent` exposes a single read-only `running` boolean, so
there is no supported call that starts a listener later.

**But the legacy DevTools remote protocol can be started in a running
instance**, and that changes the product's shape. Verified in the shipped
`browser/modules/DevToolsStartup.sys.mjs`:

- `DevToolsStartup` is registered as a `command-line-handler`, so it runs for
  **forwarded** command lines, not just the initial launch.
- In `handle()` (line 359), the `if (flags.devToolsServer)` branch sits
  **outside** the `if (isInitialLaunch)` block (line 414 vs 365).
- `handleDevToolsServerFlag` sets `cmdLine.preventDefault = true` when
  `cmdLine.state == STATE_REMOTE_AUTO` — it is explicitly written for the
  forwarded case.
- It sets `devToolsServer.allowChromeProcess = true` and
  `devToolsServer.keepAlive = true`, so one invocation yields a
  **parent-process, chrome-privileged** server that outlives client disconnects.

So `zen --profile <same-profile> --start-debugger-server <port>` against an
already-running Zen starts a privileged debugging server in that live session,
with no restart and no launch flag.

The gate is two preferences, read live at call time via
`Services.prefs.getBoolPref` (no startup snapshot):

```
devtools.debugger.remote-enabled = true
devtools.chrome.enabled          = true
```

**The catch is a one-time bootstrap.** Those prefs live in `prefs.js` and are
read from the profile, so setting them requires either an `about:config` edit or
writing `user.js` and restarting once. After that, every subsequent Zen session
is attachable with no further disruption. That is a materially better onboarding
story than "always launch Zen with `--remote-debugging-port`", which is what
this document previously concluded.

**Two caveats, neither yet measured here:**

- On macOS, `nsRemoteService::StartClient` reportedly passes a hardcoded
  `aRaise = true`, and `nsMacRemoteServer.mm` calls `SetFrontProcess` _after_
  `cmdLine->Run()`, so `preventDefault` does not suppress it. If so, the
  forwarded invocation **activates the Zen window once per browser run**. That
  is a real focus violation, though a one-time one, since `keepAlive` keeps the
  listener up. This is C++ and not verifiable from `omni.ja`; it needs a headed
  measurement.
- The DevTools RDP is a legacy, internal protocol with no stability guarantee
  for third parties. Building on it is a maintenance bet.

This path was **not** exercised against a live instance here, deliberately: a
forwarded command line is matched by profile, and getting it wrong would raise
or attach to the user's daily browser. It should be tested on a scratch profile
first, then on the daily one with consent.

## 2. WebDriver BiDi works; CDP no longer exists

**Proven.** Launching with `--remote-debugging-port <port>` prints:

```
WebDriver BiDi listening on ws://127.0.0.1:9333
```

`session.new` reports `browserName: "zen"`, `browserVersion: "1.21.9b"`,
`userAgent: ...rv:153.0) Gecko/20100101 Firefox/153.0`. So Zen inherits the
Firefox remote agent unmodified.

**CDP is not a candidate, and the comparison the ticket asks for is closed.**
The CDP HTTP endpoint (`/json/version`) does not respond on the port, because
CDP no longer exists in this Gecko. Upstream history:

- Firefox 129 (2024-08) disabled CDP by default
  ([bug 1882089](https://bugzilla.mozilla.org/show_bug.cgi?id=1882089)).
- Firefox 141 (2025-07) **removed** the implementation entirely, deleting
  `remote/cdp/` and the `remote.active-protocols` pref along with it
  ([bug 1882096](https://bugzilla.mozilla.org/show_bug.cgi?id=1882096),
  changeset `f587a8c46fc3`,
  [CDP Retirement in Firefox](https://fxdx.dev/cdp-retirement-in-firefox/)).

Zen 1.21.9b is Gecko 153, twelve releases past removal. There is no pref that
brings CDP back, so anything built on Puppeteer's CDP path or on
`webSocketDebuggerUrl` is a dead end. WebDriver BiDi is the only remote protocol
Zen has.

Note that the announced URL is the bare `ws://host:port`. Clients must connect
to `ws://host:port/session` and then call `session.new`.

A second Zen instance runs happily alongside the user's daily one given
`--no-remote`, `MOZ_NO_REMOTE=1`, and a separate `--profile`. That is what makes
the harness safe to run at any time.

## 3. Non-focusing operations all work

**Proven**, and asserted by the harness. The test for every case is that the map
of `document.visibilityState` across all browsing contexts is byte-identical
before and after the operation.

| Operation                                                 | Selects the tab?  |
| --------------------------------------------------------- | ----------------- |
| `browsingContext.getTree`                                 | no                |
| `browsingContext.create` with `background: true`          | no                |
| `browsingContext.navigate` on a non-selected tab          | no                |
| `script.evaluate` on a non-selected tab                   | no                |
| `input.performActions` (typing) on a non-selected tab     | no                |
| `browsingContext.captureScreenshot` on a non-selected tab | no                |
| `browsingContext.activate`                                | **yes** (control) |

Two of these are better than expected and worth calling out, because they remove
the main reasons a design would have needed an extension:

- **Input works on a background tab.** `input.performActions` typed into a
  non-selected tab and the value landed, with no change in visibility. Keyboard
  input does not go to the user's real active tab.
- **Screenshots work on a background tab.** `captureScreenshot` returned image
  data for a non-selected tab without selecting it. This answers the open
  question in the todo; screenshots do not have to be withheld.

`browsingContext.activate` is included in the harness deliberately as a control.
It flips the target to `visible` and takes focus, which both proves the detector
is real and identifies the one command Zen Agent must never call implicitly.

## 4. Identifiers and lifecycle

**Proven.** `browsingContext.getTree` returns, per context:

```json
{
  "context": "dc386e99-a569-474b-b668-c78aaf616a8b",
  "url": "...",
  "userContext": "default",
  "clientWindow": "a29ba768-8b12-4363-b7bd-4b912436ae7a",
  "parent": null,
  "originalOpener": null,
  "children": []
}
```

- `context` is the stable tab identity and **survives navigation**, including a
  cross-origin navigation that changes content process.
- `clientWindow` gives window identity; `browser.getClientWindows` reports
  `active`, geometry, and window state.
- `originalOpener` is available for popup provenance.
- Tabs that existed before the client connected **are** enumerated.

Lifecycle events observed: `browsingContext.contextCreated`, `contextDestroyed`,
`navigationStarted`, `domContentLoaded`, `load`.

**There is no tab-selection event, and no field anywhere in BiDi that reports
which tab is selected.** Zen Agent can avoid changing selection, but it cannot
directly observe it over BiDi. `document.visibilityState` is the only proxy, it
requires script injection into every tab, and it conflates "not selected" with
"window not focused". This matters for DEV-262's tab model: selected state has
to be modelled as _unknown_, not guessed.

## 5. Background tabs are throttled

**Proven.** A `setInterval(..., 100)` in a background tab advanced roughly once
per second, not ten times. Standard background timer throttling applies to tabs
Zen Agent drives, so any wait/poll logic in section 8 of the todo must not
assume sub-second timer resolution in a non-selected tab. Prefer BiDi-level
waits (`wait: "complete"`, lifecycle events) over in-page polling.

## 6. Session leaking is the biggest operational risk

**Proven, and severe.** Firefox allows exactly one active BiDi session.

- Clean path: `session.new` → `session.end` → close → `session.new` succeeds.
- Dirty path: `session.new` → socket closes **without** `session.end` → every
  later `session.new` fails with
  `session not created: Maximum number of active sessions`.

The leaked session is not reclaimed after 30 seconds, and reconnecting to
`ws://host:port/session/<sessionId>` is refused at the WebSocket layer. **The
only recovery is restarting the browser** — which is precisely the thing this
product promises never to make the user do.

This is a hard constraint on DEV-263:

- The daemon must own the single session and always `session.end` on any
  shutdown path (`SIGTERM`, `SIGINT`, uncaught exception, `beforeExit`).
- A `SIGKILL`, panic, or power loss still strands the browser.
- `zen-agent status`/`doctor` must detect this state and say plainly that Zen
  has to be restarted, rather than reporting a generic connection failure.
- It is a genuine argument in favour of an extension-based transport, which has
  no single-session constraint.

## 7. Zen Spaces are container-backed — but BiDi cannot address them

This is the most consequential finding for DEV-262.

**Proven, by read-only inspection of the daily profile.** Zen stores its Space
model in `zen-sessions.jsonlz4` (mozlz4: `mozLz40\0`, 4-byte LE size, then a raw
LZ4 block). Its `spaces` array is:

```json
{
  "uuid": "{e73bbd81-fbfc-4469-9846-ccb872917287}",
  "name": "Personal",
  "containerTabId": 1,
  "icon": "chrome://browser/skin/zen-icons/selectable/circle.svg"
}
```

with a second Space `Work` → `containerTabId: 4`. Those integers are exactly the
`userContextId`s in `containers.json`, whose identities are named `Personal` (1)
and `Work` (4). Every tab in the session store carries `zenWorkspace` (the Space
uuid) and a `userContextId` that agrees with its Space's `containerTabId`.

So on this profile **Zen Spaces are one-to-one with Firefox containers**, and
container identity is sufficient to infer Space membership. Two caveats:

- `containerTabId` is optional in Zen. A Space with no bound container cannot be
  distinguished this way.
- "Essential" tabs have `zenWorkspace: null` and `userContextId: 0`. They belong
  to no Space and are shown across all of them, so the model needs a state for
  "global", not just Personal/Work.

Zen also already ships its own routing, in `zen-space-routing.jsonlz4`:

```json
{
  "routes": [
    {
      "reference": "youtube.com",
      "openIn": "{e73bbd81-...}",
      "matchType": "contains"
    }
  ],
  "defaultRouteExternal": "most-recent-space"
}
```

Section 4 of the todo should read and respect this file rather than invent a
competing rule system.

**The blocker.** BiDi's view of containers is unusable as a stable identity:

- `browser.getUserContexts` returns entries with **one field**, an opaque
  `userContext` UUID. No name, no `userContextId` integer.
- Those UUIDs are **regenerated on every browser restart** — a profile
  relaunched with the same containers reports a completely different set.
- A user context created via `browser.createUserContext` does not survive a
  restart at all.
- Seeding a profile with non-contiguous, out-of-order container ids
  (`7 Gamma, 2 Alpha, 5 Beta`) showed BiDi returns exactly the public
  containers, in `containers.json` array order.

`browsingContext.create` does accept a `userContext` and the created tab reports
the requested one, so targeting works _within_ a session. The gap is purely
identity: nothing in BiDi says which container a UUID is.

The workable BiDi-only approach is therefore: read `containers.json` and
`zen-sessions.jsonlz4` from the profile directory, and zip them positionally
against `browser.getUserContexts` on every connect, validating that the counts
match and failing with an explicit capability error if they do not. That works,
but it depends on an undocumented ordering guarantee and on parsing two private
on-disk formats. An extension reads `cookieStoreId` (`firefox-container-4`)
directly and needs none of it.

## 8. BiDi is blind to every Space except the visible one

**This is the finding that decides the architecture.** It was traced through the
code Zen actually ships, by extracting `omni.ja` and `browser/omni.ja` from
`/Applications/Zen.app` — not from the GitHub tree, which may not match the
installed build.

The enumeration chain is unbroken:

| Step | File (shipped)                                            | Code                                                                                       |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | `webdriver-bidi/modules/root/browsingContext.sys.mjs:950` | `contexts = TabManager.getBrowsers().map(...)`                                             |
| 2    | `remote/shared/TabManager.sys.mjs:25`                     | `allTabs` → `windows.flatMap(win => this.getTabsForWindow(win))`                           |
| 3    | `remote/shared/TabManager.sys.mjs:194`                    | `getTabsForWindow` → `getTabBrowser(win).tabs` → `win.gBrowser`                            |
| 4    | `browser/tabbrowser/tabbrowser.js:529`                    | `get tabs() { return this.tabContainer.allTabs; }`                                         |
| 5    | `browser/tabbrowser/tabs.js` (Zen-patched)                | `get allTabs()` → `let unpinnedChildren = gZenWorkspaces.tabboxChildren;`                  |
| 6    | `modules/zen/ZenSpaceManager.mjs:316`                     | `get tabboxChildren() { return Array.from(this.activeWorkspaceStrip?.children \|\| []); }` |
| 7    | `modules/zen/ZenSpaceManager.mjs:291`                     | `activeWorkspaceStrip` → `this.activeWorkspaceElement?.tabsContainer`                      |

Zen replaced `allTabs` so that it reads the children of the **active**
`<zen-workspace>` element only, plus `getCurrentEssentialsContainer()`. Every
Space lives as a separate `<zen-workspace>` in the same window, and the inactive
ones are hidden purely by CSS (`-moz-subtree-hidden-only-visually`).

Therefore `browsingContext.getTree` returns **only the tabs in the Space the
user is currently looking at**, plus current-container essentials. Tabs in other
Spaces are not returned as hidden or discarded — they are absent. Zen
deliberately stopped using `tab.hidden` for this, so there is no flag to filter
on.

This directly contradicts DEV-261's premise. Zen Agent cannot "discover and
operate the user's existing session" over BiDi alone, because with Personal
visible it cannot see, address, or reuse a single Work tab. The stable-ID reuse
promise in the product principles is unimplementable on this transport by
itself.

Two further consequences, from the same shipped sources:

- Zen patches `set selectedTab` to call `gZenWorkspaces.onBeforeTabSelect`,
  which calls `changeWorkspaceWithID` when the target tab belongs to another
  Space. Anything that selects a foreign-Space tab **switches the visible
  Space**. Zen has a regression test asserting this
  (`browser_select_tab_switches_space.js`), so it is intended behaviour, not a
  bug to route around.
- `onTabBrowserInserted` stamps a new tab with the **currently active** Space's
  uuid. The only path that targets another Space also sets the
  `change-workspace` attribute, which forces the switch. So a background tab
  opened in a chosen Space is not reachable this way either.

**Now confirmed empirically** (see section 13). Measured from chrome JS on a
profile with two Spaces and a background tab routed into the non-visible one:

```
allStoredTabs : 4  { activeSpace: 3, otherSpace: 1 }
gBrowser.tabs : 3  { activeSpace: 3 }
```

The tab in the non-visible Space is present in `allStoredTabs` and absent from
`gBrowser.tabs` — the collection BiDi enumerates through. The code trace was
right.

## 9. What that leaves

A plain WebExtension does not rescue this — it enumerates through the same
`gBrowser.tabs`, so `tabs.query({})` has exactly the same blind spot, and
`tabs.update({active: true})` switches the Space.

What does work is reaching `gZenWorkspaces` from chrome-privileged JS, where
`allStoredTabs` walks every `<zen-workspace>` and
`moveTabToWorkspace(tab, uuid)` is an attribute-and-DOM move with no visible
change. Two ways in: the DevTools RDP server from §1, or a privileged
`experiment_apis` extension.

Zen is unusually hospitable to this, which was verified against the shipped
`AppConstants.sys.mjs`:

```
MOZ_REQUIRE_SIGNING: false
MOZ_UNSIGNED_APP_SCOPE: true
```

Because `MOZ_REQUIRE_SIGNING` is false, `AddonSettings.EXPERIMENTS_ENABLED` is
bound as a **live preference** rather than frozen to `false` as it is on stock
Firefox Release. Zen ships `extensions.experiments.enabled = false` and
`xpinstall.signatures.required = true` as defaults, so both have to be flipped —
but on Zen, flipping them actually works.

That points at a **hybrid**: BiDi for page-level work, where it is proven and
excellent, and a privileged chrome-JS channel for Space enumeration, Space
membership, and Space-targeted tab creation. There are two candidates for that
second channel, and they are not equivalent:

|                                 | Privileged extension         | DevTools RDP (§1)                |
| ------------------------------- | ---------------------------- | -------------------------------- |
| Reaches `gZenWorkspaces`        | yes                          | yes                              |
| Sees lazy/unloaded tabs (§11)   | yes, reads the tab strip     | yes                              |
| Needs an add-on                 | yes, unsigned + privileged   | **no**                           |
| Needs signature enforcement off | yes, or reload every restart | no                               |
| Rewrites 87 prefs (§10)         | **no**                       | **no** (agent-only, not RDP)     |
| Robot icon in the URL bar (§12) | **no**                       | yes, but clearable on disconnect |
| Attach to a running session     | n/a                          | yes, no restart                  |
| Protocol stability              | `experiment_apis`, unstable  | legacy RDP, unstable             |
| Known focus cost                | none                         | one window raise per browser run |

Correction to an earlier draft: only BiDi, Marionette and the Remote Agent call
`RecommendedPreferences.applyPreferences()`. The DevTools RDP path does **not**
rewrite preferences, and its badge is clearable because `DevToolsSocketStatus`
counts listeners and `SocketListener.close()` decrements it. RDP is therefore a
genuine contender, and is recorded as the fallback in
[ADR 0001](../adr/0001-browser-transport.md).

The shape is now: **BiDi cannot be the discovery layer at all** (section 11),
and the remaining question is which chrome-privileged channel replaces it.

## 10. Attaching to a real profile rewrites 87 preferences

**Proven, on the daily profile, and this is a blocker for the whole approach.**

Launching the user's own profile with `--remote-debugging-port` caused the
remote agent to write **87 preferences into `prefs.js`**, on the _user_ branch,
not the default branch. Among them:

```
browser.safebrowsing.phishing.enabled   false
browser.safebrowsing.malware.enabled    false
browser.safebrowsing.downloads.enabled  false
browser.safebrowsing.blockedURIs.enabled false
signon.rememberSignons                  false
signon.management.page.breach-alerts.enabled false
extensions.update.enabled               false
services.settings.server                "data:,#remote-settings-dummy/v1"
browser.sessionstore.resume_from_crash  false
app.update.disabledForTesting           true
security.fileuri.strict_origin_policy   false
```

That is phishing and malware protection off, the password manager off, breach
alerts off, extension updates off, and remote settings pointed at a dummy URL —
on a browser holding the user's live logged-in sessions.

`RecommendedPreferences.applyPreferences()` guards each write with
`prefHasUserValue`, so preferences the user had set themselves were left alone
(three, here). Everything else was overwritten, and `restorePreferences()` only
runs on `xpcom-shutdown`. **A clean quit did not reliably clear them**: after
`tell application "Zen" to quit` they were still present in `prefs.js`, and had
to be removed by hand with the browser closed. A crash or force-kill would leave
them permanently.

**The mitigation is mandatory and must come first.** Set

```
remote.prefs.recommended = false
```

in the profile _before_ ever launching it with `--remote-debugging-port`. The
flag is checked at the top of `applyPreferences()`, and with it false the agent
writes nothing. Any launcher this project ships must refuse to attach to a real
profile that does not have it set.

## 11. On a real profile, BiDi saw 1 tab out of 22

**Proven, and worse than section 8 predicted.**

The daily profile had 22 tabs (15 essential, 6 Personal, 1 Work) with Personal
visible. After relaunching with the remote agent and connecting,
`browsingContext.getTree` returned **one** context: `about:blank`.

This is upstream
[bug 1876240](https://bugzilla.mozilla.org/show_bug.cgi?id=1876240). Session-
restored tabs are lazy: `linkedBrowser` is non-null but `browsingContext` is
null, so `isValidCanonicalBrowsingContext` rejects them and they are dropped
from the tree with no error and no id.

It also means section 8 could not be tested at all — nothing was visible to
compare. The Space question is still open, but it is now moot for BiDi-only
discovery: **a transport that cannot see 21 of 22 tabs after a browser restart
cannot support "discover before you open" or "reuse by stable id"**, which are
the first two product principles. Loading every tab to make it visible is not an
option; it would defeat the purpose.

## 12. The remote-control robot icon cannot be hidden

**Proven, from the shipped `browser/content/browser/browser.js`, and spotted by
the user in their own window.** While anything is attached, Zen shows a robot
icon in the URL bar:

```js
getRemoteControlComponent() {
  if (DevToolsSocketStatus.hasSocketOpened({ excludeBrowserToolboxSockets: true })) {
    return "DevTools";
  }
  if (Marionette.running) { return "Marionette"; }
  if (RemoteAgent.running) { return "RemoteAgent"; }
  return null;
}
```

Any of the three lights it up, so **BiDi, the DevTools RDP path from section 1,
and Marionette all trigger it equally.** There is a pref that suppresses it,
`browser.chrome.disableRemoteControlCueForTests`, but the guard is
`if (disableRemoteControlCue && Cu.isInAutomation)` — the pref does nothing
unless the build is in automation, which a normal Zen is not. It is an
anti-phishing signal, deliberately not user-disableable.

So every remote-protocol transport carries a permanent, visible UI change for as
long as Zen Agent is connected. For a tool whose entire premise is not
disturbing the browser you are already using, that is a real cost, and it cannot
be engineered away.

How long it stays up differs by transport, and that matters:

- **BiDi**: `RemoteAgent.running` is
  `!!this.#server && !this.#server.isStopped()` — the listener, not a
  connection. Armed at startup and unstoppable, so the badge is shown for the
  **entire browser run**, connected or not.
- **DevTools RDP**: `DevToolsSocketStatus` counts listeners via
  `notifySocketOpened`/`notifySocketClosed`, called from `SocketListener.open()`
  and `.close()`. Closing the listener clears the badge, so it can be scoped to
  "while the agent is actually attached".
- **WebExtension**: never appears. `gRemoteControl` does not consult the add-on
  manager.

## 13. The privileged extension clears every bar BiDi could not

**Proven**, and re-runnable with `npm run spike:transport`. A minimal
`experiment_apis` add-on was built, dropped into a scratch profile as an
unsigned XPI, and left to report by writing a JSON file — **no remote protocol
involved at any point**.

It loaded and ran with chrome privileges on a stock release Zen, confirming the
`MOZ_REQUIRE_SIGNING: false` reasoning in section 9. Results:

| Claim                                      | Result                                                    |
| ------------------------------------------ | --------------------------------------------------------- |
| Enumerates tabs in non-visible Spaces      | **yes** — `allStoredTabs` 4 vs `gBrowser.tabs` 3          |
| Enumerates lazy, session-restored tabs     | **yes** — 3 lazy tabs seen after a restart                |
| Creates a Space without switching to it    | yes, via `createAndSaveWorkspace(..., dontChange = true)` |
| Routes a background tab into another Space | yes, via `moveTabToWorkspace`                             |
| Visible Space unchanged                    | yes                                                       |
| Selected tab unchanged                     | yes                                                       |
| Remote-control badge                       | **never appeared**                                        |

The second row is the one that matters most. Section 11 measured BiDi seeing one
tab out of 22 because session-restored tabs are lazy. The extension enumerates
those same lazy tabs directly off the tab strip, because `linkedPanel` being
unset does not stop `allStoredTabs` from walking the DOM.

Two honest gaps in this run: it was headless, so "focused window unchanged" was
not meaningfully observable, and no media playback was exercised. Both belong in
a headed run.

## 14. A native port keeps the MV3 event page alive

**Proven**, and re-runnable with `npm run spike:transport`. A separate Manifest
V3 extension opened a port with `runtime.connectNative`. Its temporary native
host sent one message immediately, waited 35 seconds — beyond the event-page
idle timeout — and sent a second.

Both replies carried the same randomly generated in-memory token and the same
event-page startup timestamp. That proves the page stayed alive; a terminated
page would have disconnected the port and ended the native host instead.

The test installs its uniquely named host manifest at Firefox's macOS user
location, `~/Library/Application Support/Mozilla/NativeMessagingHosts/`, only
for the duration of the run. It refuses to overwrite an existing manifest and
removes the manifest, host, XPI, and throwaway profile in `finally`.

This closes the last transport-critical validation in ADR 0001.

## Product follow-ups

These are useful headed regression tests, but no longer block the transport
decision:

- **Validate the RDP fallback**, on a scratch profile first: does
  `--start-debugger-server` forwarded into a running Zen open a privileged
  server, and does it raise the window on macOS?
- Does macOS occlusion matter in practice? `RecomputeAppWindowVisibility`
  deactivates every tab in a fully occluded window, so a full-screen terminal
  covering Zen may itself break background operation.
- Does a BiDi-created tab land in the Zen Space bound to its container, or in
  whichever Space is currently visible?
- Does opening a background tab ever cause Zen to switch the visible Space?
- Does a selected tab playing media keep playing, at the same position, across a
  full open/navigate/interact cycle in another tab?

## Reproducing

```sh
npm run spike:transport              # headless, ~65s, uses throwaway profiles
ZEN_SPIKE_HEADED=1 npm run spike:transport
```

The repeatable harness never touches the user's profile: it launches Zen with
`--no-remote`, `MOZ_NO_REMOTE=1`, and fresh `mkdtemp` profiles, and always ends
the BiDi session. It is skipped by `npm test` and CI unless `ZEN_SPIKE=1`.
