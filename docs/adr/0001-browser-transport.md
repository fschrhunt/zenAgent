# ADR 0001: Browser transport for Zen Agent

- Status: **Accepted** — transport-critical validation complete; see below
- Date: 2026-07-28
- Tracking: [DEV-261](https://linear.app/intuitum/issue/DEV-261)
- Evidence: [docs/spikes/dev-261-transport.md](../spikes/dev-261-transport.md)

## Context

Zen Agent must discover and operate a user's existing Zen Browser session from
the terminal without focusing a window, selecting a tab, or switching the
visible Space. The spike measured every candidate transport against a real
install (Zen 1.21.9b / Gecko 153.0, macOS 27.0 arm64) and, at the end, against
the maintainer's own daily profile.

The product principles that constrain this decision are the first two: _discover
windows, Spaces, and tabs before opening anything_, and _reuse an existing
matching tab by its stable identifier_. A transport that cannot enumerate the
user's tabs cannot support either.

## Decision

**Use a privileged Zen extension (`experiment_apis`) plus a native messaging
host as the transport.** The extension's parent script runs with chrome
privileges and drives `gZenWorkspaces` and `gBrowser` directly. The native
messaging host is the bridge between that extension and the terminal-side
daemon.

**Do not use WebDriver BiDi as the discovery layer.** Reconsider it later, and
only for page-level interaction inside a tab whose identity was established by
the extension.

**Keep the DevTools remote protocol (RDP) as a validated fallback**, not the
primary path.

## Options considered

### 1. WebDriver BiDi — rejected

Everything page-level works, and works well. Proven, and re-runnable via
`npm run spike:transport`: `getTree`, `create` with `background: true`,
`navigate`, `script.evaluate`, `input.performActions`, and `captureScreenshot`
all operate on a non-selected tab without changing which context is visible,
with `browsingContext.activate` as a positive control that does change it.

It is rejected on discovery, not interaction. Four findings, each independently
serious:

- **It cannot see the user's tabs.** On the real profile — 22 tabs, Personal
  visible — `browsingContext.getTree` returned exactly one context,
  `about:blank`. Session-restored tabs are lazy, their `browsingContext` is
  null, and `isValidCanonicalBrowsingContext` drops them silently
  ([bug 1876240](https://bugzilla.mozilla.org/show_bug.cgi?id=1876240)). This
  alone is disqualifying.
- **It cannot see other Spaces.** Zen rewrote `tabs.js`'s `allTabs` to read the
  active `<zen-workspace>` only, and BiDi enumerates through `gBrowser.tabs`.
  Traced through the shipped `omni.ja`; not confirmed empirically, because the
  lazy-tab problem left nothing to compare.
- **Attaching rewrites the profile.** `RecommendedPreferences` wrote 87 prefs
  onto the user branch, disabling Safe Browsing, the password manager, breach
  alerts and extension updates. They survived a clean quit and had to be removed
  by hand. Mitigable with `remote.prefs.recommended = false`, now enforced by
  `assertSafeToAttach()`, but it must be set before the first attach.
- **One session, and it leaks.** A client that disconnects without `session.end`
  strands the single permitted session permanently; only a browser restart
  clears it, which is the one thing this product must never require.

Two further costs: it cannot be enabled on an already-running Zen, and the
remote-control robot icon is shown for the **entire browser run**, because
`RemoteAgent.running` tracks the listener, not a connection.

### 2. CDP — rejected, unavailable

Removed from Gecko entirely in Firefox 141
([bug 1882096](https://bugzilla.mozilla.org/show_bug.cgi?id=1882096)), along
with the `remote.active-protocols` pref. Zen 153 has no CDP and no pref brings
it back.

### 3. A plain WebExtension — rejected

`tabs.query()` does see lazy and discarded tabs, which fixes BiDi's worst
problem. But it enumerates through the same space-filtered `gBrowser.tabs`, so
it is still blind to non-visible Spaces, and `tabs.update({active: true})` on a
foreign-Space tab switches the visible Space via Zen's patched `set selectedTab`
— behaviour Zen covers with its own regression test.

### 4. DevTools RDP — viable, kept as fallback

`DevToolsStartup` handles forwarded command lines, so
`zen --profile <same> --start-debugger-server <port>` starts a chrome-privileged
server (`allowChromeProcess = true`) inside an already-running Zen, with no
restart and no launch flag. Gated on two prefs, both read live:
`devtools.debugger.remote-enabled` and `devtools.chrome.enabled`.

It does **not** apply `RecommendedPreferences` — only BiDi, Marionette and the
Remote Agent do — so it does not rewrite the profile. Its robot icon is
clearable, because `DevToolsSocketStatus` counts listeners and
`SocketListener.close()` decrements it.

Rejected as primary for three reasons: it requires leaving a privileged
debugging channel permanently enabled on a daily profile, which is a real local
attack surface; it appears to raise the Zen window once per attach on macOS
(hardcoded `aRaise`, unverified); and it is a legacy internal protocol with no
third-party stability guarantee.

### 5. Privileged extension plus native messaging — chosen

The `experiment_apis` parent script runs in a system-principal sandbox with
`wantXrays: false`, so it reaches window globals directly:

- `gZenWorkspaces.allStoredTabs` walks every `<zen-workspace>`, so it sees all
  tabs in all Spaces **regardless of load state** — solving both discovery
  failures at once.
- `gZenWorkspaces.moveTabToWorkspace(tab, uuid)` is an attribute-and-DOM move
  with no visible change.
- `gBrowser.addTab(url, { inBackground: true, userContextId })` opens without
  selecting.

Zen permits this where stock Firefox Release does not. Verified in the shipped
`AppConstants.sys.mjs`: `MOZ_REQUIRE_SIGNING: false`, which makes
`AddonSettings.EXPERIMENTS_ENABLED` a live preference instead of frozen `false`.

The native messaging host is required because a native port is the only
supported way to keep a Firefox MV3 event page alive; a WebSocket is not, and
the default MV3 CSP silently upgrades `ws://` to `wss://`. On macOS the host
manifest belongs in
`~/Library/Application Support/Mozilla/NativeMessagingHosts/` — Zen does not
patch that path, despite third-party installers guessing `.../Zen/`.

## Consequences

Good:

- Sees every tab in every Space, loaded or not. Nothing else does.
- No remote-control badge; `gRemoteControl` never consults the add-on manager.
- No preference rewriting, no window raise, no single-session leak.
- Works on an already-running browser once installed, with no launch flag.

Bad:

- Requires an unsigned privileged add-on. Either
  `xpinstall.signatures.required = false` for a permanent install, or reloading
  it from `about:debugging` on every restart. That is a security posture change
  on the user's daily profile and must be presented honestly.
- `experiment_apis` is explicitly unstable and undocumented for third parties.
- Depends on Zen internals (`gZenWorkspaces`, `zen-workspace-id`) that can
  change between Zen releases. Needs capability detection and a supported
  version matrix, not optimistic calls.
- Adds a native host binary to install, package, and keep on PATH-independent
  absolute paths.
- Host to browser messages are capped at 1 MiB; page snapshots must be chunked.

## Risks and stop conditions

Stop and re-open this decision if any of these hold:

- Zen restructures `ZenSpaceManager` such that `allStoredTabs` or
  `moveTabToWorkspace` no longer exist, and no equivalent is reachable.
- Zen starts shipping `MOZ_REQUIRE_SIGNING=1`, which would freeze
  `EXPERIMENTS_ENABLED` to `false` and close the privileged-extension route.
- The user declines to disable signature enforcement **and** reloading a
  temporary add-on on every restart proves unacceptable. Fall back to option 4.

If both 4 and 5 become untenable, the honest outcome is that Zen Agent cannot
safely operate a daily-use Zen, and the project should say so rather than ship
something that switches Spaces or steals focus.

## Validation

Validated by `npm run spike:transport` (spike section 13):

1. **Done.** A minimal `experiment_apis` add-on loads on a stock release Zen and
   `gZenWorkspaces.allStoredTabs` enumerates both Spaces — 4 tabs against
   `gBrowser.tabs`' 3 — including 3 lazy tabs after a restart.
2. **Done for the transport decision.** `moveTabToWorkspace` and background
   `addTab` left the visible Space and selected tab unchanged. Focus and media
   playback remain headed product regression tests, but do not affect whether
   the extension can discover and route tabs.
3. **Done.** No remote-control badge appeared at any point.
4. **Done.** An MV3 extension held a native messaging port open, received a
   second host message after 35 seconds, and replied with the same in-memory
   token and startup timestamp. The event page survived the idle timeout.
5. **Done.** The Space-blindness claim is confirmed from chrome JS, which the
   lazy-tab problem had prevented measuring over BiDi.

The remaining headed focus and media checks are acceptance tests for the first
usable product, not blockers on this transport choice.
