# DEV-261: browser transport spike findings

Status: in progress. Everything below marked **Proven** was observed directly on
the machine and environment recorded here, and most of it is re-runnable with
`npm run spike:transport`. Items marked **Open** still need a headed run against
a profile that has real Zen Spaces.

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
the one used for all read-only profile inspection below. No spike step has
written to it.

## 1. A running Zen cannot be attached to

**Proven.** The daily-use Zen process was launched with no arguments at all
(`/Applications/Zen.app/Contents/MacOS/zen`) and holds no listening TCP socket —
`lsof -nP -iTCP -sTCP:LISTEN` against its pid returns nothing. The remote agent
is off, and there is no pref or runtime call that turns it on in an
already-running process.

The consequence sets the shape of the whole product: **the user must start Zen
with `--remote-debugging-port` for Zen Agent to work at all.** Attaching to a
session that is already open is not possible. This is a startup/onboarding
problem, not a transport problem, and it needs an explicit answer in the product
(a launch helper, a login item, or documented instructions).

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
Zen Agent drives, so any wait/poll logic in section 7 of the todo must not
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

Section 3 of the todo should read and respect this file rather than invent a
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

**Not yet confirmed empirically.** The code chain is unambiguous, but it has not
been observed against a live profile with two Spaces, because the scratch
profiles used here only ever have one. This is the single most important thing
to verify in the headed run below; if it somehow does not reproduce, the
architecture opens back up.

## 9. What that leaves

A plain WebExtension does not rescue this — it enumerates through the same
`gBrowser.tabs`, so `tabs.query({})` has exactly the same blind spot, and
`tabs.update({active: true})` switches the Space.

The path that does work is a **privileged `experiment_apis` extension**, whose
parent script runs in a system-principal sandbox and can call
`gZenWorkspaces.allStoredTabs` (which walks every `<zen-workspace>`) and
`gZenWorkspaces.moveTabToWorkspace(tab, uuid)` (an attribute-and-DOM move with
no visible change).

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
excellent, and a small privileged extension for Space enumeration, Space
membership, and Space-targeted tab creation. The cost is real: an unsigned
privileged add-on, re-loaded on every restart unless signature enforcement is
disabled, using an API Mozilla documents as unstable.

## Open questions still to test

These need a **headed** run against a profile that has real Zen Spaces, which
means restarting the user's daily Zen with `--remote-debugging-port`:

- **Confirm §8 empirically**: with Personal visible, does
  `browsingContext.getTree` really omit every Work tab?
- Does a BiDi-created tab land in the Zen Space bound to its container, or in
  whichever Space is currently visible?
- Does opening a background tab ever cause Zen to switch the visible Space?
- Does a selected tab playing media keep playing, at the same position, across a
  full open/navigate/interact cycle in another tab?

## Reproducing

```sh
npm run spike:transport              # headless, ~3s, launches a throwaway profile
ZEN_SPIKE_HEADED=1 npm run spike:transport
```

The harness never touches the user's profile: it launches Zen with
`--no-remote`, `MOZ_NO_REMOTE=1`, and a fresh `mkdtemp` profile, and always ends
the BiDi session. It is skipped by `npm test` and CI unless `ZEN_SPIKE=1`.
