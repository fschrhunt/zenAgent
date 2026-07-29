# Zen Agent TODO

Last updated: 2026-07-28

This is the dependency-ordered implementation checklist for Zen Agent. Check an
item only after its acceptance criteria are verified. Product work is tracked in
the
[Zen-Agent Linear project](https://linear.app/intuitum/project/zen-agent-977b6899630f).

## Non-negotiable behavior

Every implementation phase must preserve these invariants:

- [ ] Discover windows, Spaces, and tabs before deciding to open a tab.
- [ ] Reuse an appropriate existing tab when one is already open.
- [ ] Address existing tabs by stable ID, never by whichever tab is active.
- [ ] Never focus a Zen window, select a tab, or switch the visible Space.
- [ ] Never interrupt the selected tab or media playing in another tab.
- [ ] Open new tabs in the background in the appropriate Personal or Work Space.
- [ ] Keep the CLI and MCP server behavior identical by putting policy in one
      shared daemon.
- [ ] Do not add a general-purpose manual approval layer for ordinary browser
      operations.
- [ ] Return an explicit ambiguity or capability error instead of silently
      choosing an unsafe fallback.
- [ ] Keep page content, cookies, credentials, tokens, and form values out of
      logs by default.

## 0. Finish the repository foundation

- [x] Review and merge [PR #1](https://github.com/fschrhunt/zen-agent/pull/1).
      Merged 2026-07-28, along with Dependabot PRs #2-#4 and the todo in #5.
- [x] Confirm the CI and Dependency audit checks remain required and green on
      `main`. Both went red on 2026-07-28: PR #4 took TypeScript 7, which falls
      outside `typescript-eslint`'s `typescript >=4.8.4 <6.1.0` peer range, so
      `npm ci` fails with `ERESOLVE` before any check runs. The pin is back at
      `^6.0.3` and TypeScript majors are ignored in Dependabot until
      `typescript-eslint` ships a stable release that widens the range. PR #6
      merged and `main` has been green on every push since, through PR #9.
      Revisit the TypeScript pin when `typescript-eslint` widens its range.
- [x] Configure branch protection or a ruleset for `main` after the first PR is
      merged. The active `main` ruleset (2026-07-28) requires a pull request and
      the `Quality / Node 24`, `Lint workflows`, and `Audit dependencies`
      checks, and blocks deletion and force pushes. It requires zero approvals,
      because GitHub does not let a sole maintainer approve their own pull
      request; repository admins keep an `always` bypass as the escape hatch.
      Revisit both once there is a second maintainer. `Audit dependencies` had
      to lose its `pull_request` path filter first, because a required check
      that is skipped leaves unrelated pull requests pending forever.
- [x] Decide whether the repository will remain private or become public. It is
      public.
- [x] Select and add a license before copying or accepting outside code. MIT,
      chosen 2026-07-28 so the project can be forked, used, and contributed to
      freely. This unblocks reuse from `zen-mcp` in section 1 on our side; that
      repository's own license still has to be confirmed separately.
- [x] Add an `AGENTS.md` with repository-specific build, safety, and testing
      rules once the architecture is proven. Added 2026-07-28, after ADR 0001
      was accepted.
- [x] Add workflow linting so invalid GitHub Actions expressions are caught
      before push. `actionlint` runs as the CI `Lint workflows` job.

## 1. Prove the browser transport

Tracking: [DEV-261](https://linear.app/intuitum/issue/DEV-261)

Findings are written up in
[docs/spikes/dev-261-transport.md](../docs/spikes/dev-261-transport.md), and the
proven items are re-runnable with `npm run spike:transport`.

The spike is closed and [ADR 0001](../docs/adr/0001-browser-transport.md) is
accepted. Items that needed a live transport rather than another spike were
finished under [DEV-273](https://linear.app/intuitum/issue/DEV-273) in section 3
and are marked accordingly; the evidence is in
[docs/transport.md](../docs/transport.md).

- [x] Record the exact Zen Browser version, Firefox version, macOS version, and
      active profile layout used for the spike. Zen 1.21.9b / Gecko 153.0 /
      macOS 27.0 arm64 / Node 26.5.0; daily profile
      `tddguwg7.Default (release)`.
- [x] Determine whether Zen can expose a remote protocol from an already running
      daily-use browser session. **Not BiDi, but yes via DevTools RDP.** The
      BiDi remote agent can only be armed from a `STATE_INITIAL_LAUNCH` command
      line. However `DevToolsStartup` handles **forwarded** command lines, so
      `zen --profile <same> --start-debugger-server <port>` starts a
      chrome-privileged server (`allowChromeProcess = true`, `keepAlive = true`)
      inside a live session, gated only on `devtools.debugger.remote-enabled`
      and `devtools.chrome.enabled` read live. Costs a one-time pref bootstrap,
      and possibly one macOS window raise per browser run.
- [x] Test Firefox Remote Agent/WebDriver BiDi with Zen. Works unmodified; Zen
      inherits the Firefox remote agent. Connect to `ws://host:port/session`,
      not the bare URL Zen prints.
- [x] Determine whether BiDi can discover tabs that existed before the client
      connected. Yes.
- [x] Determine whether BiDi can create, navigate, inspect, and interact with a
      background browsing context without activating it. Yes, including
      `input.performActions` and `captureScreenshot`.
- [x] Determine whether stable browsing-context IDs survive navigation, process
      changes, tab movement, and Space changes. For BiDi: navigation and
      cross-origin process switches proven. For the transport actually chosen,
      **all four are proven** — identity is a `WeakMap` keyed on the tab
      element, and a Space move is a DOM move of that element. Confirmed headed
      under DEV-273.
- [x] Determine which lifecycle events exist for window, tab, navigation, crash,
      and close events. `contextCreated`, `contextDestroyed`,
      `navigationStarted`, `domContentLoaded`, `load`. **No selection event and
      no selected-tab field exists**, so selected state must be modelled as
      unknown rather than guessed.
- [x] Test whether Zen exposes its Space IDs, names, order, and tab membership
      through the remote protocol. **No, and worse.** `browser.getUserContexts`
      returns only opaque per-session UUIDs, and `browsingContext.getTree`
      enumerates through `gBrowser.tabs`, which Zen rewrote to return the
      **active Space's tabs only**. BiDi cannot see, address, or reuse a tab in
      a non-visible Space. Traced through the shipped `omni.ja` and confirmed
      empirically on a two-Space throwaway profile.
- [x] Test whether Firefox container identity is sufficient to infer Zen Space
      membership. Sufficient **on disk** — each Space carries a `containerTabId`
      matching a `containers.json` `userContextId`, and tabs agree. Not
      sufficient over BiDi, whose container UUIDs are regenerated every restart
      and carry no name or integer id. Essential tabs belong to no Space.
- [x] Compare the viable transports:
  - [x] WebDriver BiDi/Firefox Remote Agent. Proven for every page-level
        operation; cannot see Zen Spaces or stable container identity.
  - [x] CDP. **Ruled out.** Removed from Gecko entirely in Firefox 141; Zen 153
        has no CDP and no pref brings it back.
  - [x] A plain Zen/Firefox extension. **Ruled out.** It enumerates through the
        same `gBrowser.tabs`, so `tabs.query({})` has the identical
        active-Space-only blind spot, and `tabs.update({active:true})` on a
        foreign-Space tab switches the visible Space.
  - [x] A privileged `experiment_apis` extension. **Chosen** in ADR 0001 and
        validated end to end: it loads on a stock release Zen, enumerates both
        Spaces including lazy restored tabs, routes a background tab without
        switching the visible Space, and shows no remote-control badge. Zen
        ships `MOZ_REQUIRE_SIGNING: false`, so `extensions.experiments.enabled`
        is a live pref and the parent script gets a system-principal sandbox
        with `gZenWorkspaces.allStoredTabs` and `moveTabToWorkspace`.
  - [x] An extension plus Native Messaging host. **Chosen.** A 35-second probe
        proved an open native port keeps the MV3 event page alive past its idle
        timeout with the same in-memory identity. A WebSocket is not a
        substitute, and the default MV3 CSP silently upgrades `ws://` to
        `wss://`.
  - [x] A hybrid in which BiDi handles pages and a privileged extension supplies
        Zen-specific Space metadata. Evaluated and deferred: BiDi remains worth
        reconsidering for page interaction, but its permanent badge, launch
        requirement, recommended-pref rewrite, and leaked-session failure make
        it unsuitable for the primary transport.
- [x] Prove that the transport can list tabs without changing selected tab,
      focused window, or visible Space. **All three proven headed** under
      DEV-273, with focus checked against the frontmost macOS application as
      well as the model's own field.
- [x] Prove that it can open a background tab in a requested Space. Done from
      chrome JS: `gBrowser.addTab(url, { inBackground: true })` followed by
      `gZenWorkspaces.moveTabToWorkspace(tab, uuid)`, with the visible Space and
      selected tab unchanged. Not reachable over BiDi.
- [x] Prove that it can navigate an existing non-selected tab without selecting
      it.
- [x] Prove that it can interact with a non-selected page while another tab
      continues playing media. Proven headed: opening, navigating, and closing
      background tabs while the selected tab played audio left playback
      advancing and never rewound.
- [x] Capture repeatable before/after evidence for selected tab, focused window,
      visible Space, and media playback. `npm run spike:transport` now asserts
      all four, green on three consecutive runs. Media is measured from the
      page's reported playback position rather than the tab's `soundPlaying`
      flag, which proved to depend on window occlusion.
- [x] Document required Zen settings, command-line flags, profile changes,
      extension permissions, and startup behavior.
      [docs/transport.md](../docs/transport.md) covers the two required
      preferences, the host manifest location, and the `nativeMessaging`
      permission.
- [x] Build a small repeatable transport harness in the repository.
      `npm run spike:transport`, skipped in CI unless `ZEN_SPIKE=1`.
- [x] Decide how the daemon survives a leaked BiDi session. **Moot.** ADR 0001
      rejected BiDi as the transport, so no BiDi session is ever opened and
      there is nothing to leak. Reinstate this item only if BiDi returns for
      page-level interaction.
- [x] Write an architecture decision record selecting the transport.
      [ADR 0001](../docs/adr/0001-browser-transport.md) selects a privileged
      `experiment_apis` extension plus a native messaging host, with DevTools
      RDP as the fallback. Status Accepted after the extension, cross-Space,
      lazy-tab, no-badge, and native-port keepalive validations passed.
- [x] Define a fallback or stop condition if daily-use Zen cannot be attached
      safely. Recorded in ADR 0001: fall back to DevTools RDP, and if both that
      and the extension become untenable, say plainly that Zen Agent cannot
      safely drive a daily-use Zen rather than ship something that switches
      Spaces or steals focus.
- [ ] Do not copy code from `zen-mcp` unless its repository license and reuse
      terms are confirmed; use it only as conceptual reference until then.

## 2. Define the browser and Space model

Tracking: [DEV-262](https://linear.app/intuitum/issue/DEV-262) — **Done**, in
[PR #9](https://github.com/fschrhunt/zen-agent/pull/9). The model is specified
in [docs/browser-model.md](../docs/browser-model.md) at schema version 1.

- [x] Define types for browser sessions, profiles, windows, Spaces, tabs,
      browsing contexts, frames, and elements.
- [x] Store the transport's stable IDs without inventing identity from tab
      position or title.
- [x] Track URL, title, load state, selected state, focused state, media state,
      container identity, Space identity, and private-window status when the
      transport exposes them.
- [x] Keep selected/focused state read-only unless an explicitly named future
      operation requires changing it.
- [x] Model unknown and unsupported properties explicitly instead of fabricating
      values.
- [x] Define snapshot and incremental event schemas for the live registry.
- [x] Define stale-ID behavior after close, crash, reconnect, and browser
      restart.
- [x] Define how multiple Zen windows and multiple profiles are represented.
- [x] Decide whether private windows are unsupported, hidden by default, or
      require explicit configuration. Private windows are hidden by default;
      unknown private state is also excluded.
- [x] Add unit tests for identity, lifecycle transitions, stale IDs, multiple
      windows, and incomplete transport data.

## 3. Implement the Zen transport

Tracking: [DEV-273](https://linear.app/intuitum/issue/DEV-273)

Section 2 shipped a registry with no producer. This section builds the transport
[ADR 0001](../docs/adr/0001-browser-transport.md) selected, so the model is fed
by a real browser instead of fixtures.

### The extension

- [x] Promote the spike probe into a real `extension/` package rather than
      leaving it in `test/integration/fixtures/`. `extension/manifest.json`,
      `background.js`, and `api/parent.js`.
- [x] Detect `gZenWorkspaces.allStoredTabs`, `moveTabToWorkspace`, and the
      `zen-workspace-id` attribute at startup, and report an explicit
      unsupported-capability error instead of calling optimistically. The probe
      is in `capabilities()`; the refusal is unit-tested on the host side and
      names the Zen version. The probe itself still needs a headed run.
- [ ] Record the Zen versions the capability probe has actually passed on, and
      fail closed on versions it has not. Zen 1.21.9b / Gecko 153.0 now passes
      all eight capabilities; the version gate itself is not written yet.
- [x] Keep an MV3 background event page holding one native messaging port open,
      since that is the only supported way to keep it alive. **Proven.** Zen
      loads a single MV3 add-on that also declares `experiment_apis` — the
      combination DEV-261 had only tested in halves — and the port drove the
      full scenario.
- [x] Request the narrowest permission set that works. `nativeMessaging` only,
      plus the `experiment_apis` key the privileged API requires.

### The native messaging host

- [x] Implement the host with Firefox's framing: a little-endian `uint32` length
      prefix followed by that many bytes of UTF-8 JSON, on stdin and stdout.
      `src/transport/framing.ts`, with byte-length and split-frame tests.
- [x] Never write anything but framed messages to stdout; diagnostics go to
      stderr or a log file. Verified by driving the built binary end to end.
- [ ] Install the host manifest to
      `~/Library/Application Support/Mozilla/NativeMessagingHosts/`, not the
      `.../Zen/` path some third-party installers guess. The path and contents
      are implemented and tested in `src/native/manifest.ts`, and the headed
      proof confirms Zen launches a host registered there. No installer writes
      it for a real user yet.
- [x] Restrict `allowed_extensions` to the add-on's own ID.
- [x] Chunk any payload approaching the 1 MiB host-to-browser cap, and reject
      anything above a configured ceiling rather than truncating it. Note the
      cap applies host to browser only, so it constrains requests rather than
      snapshots; ADR 0001 implied the opposite and has been corrected.

### The wire protocol

- [x] Define a versioned request, response, event, and error schema, and refuse
      a mismatched protocol version with a clear message.
- [x] Correlate every request with an ID so concurrent calls cannot be confused.
- [x] Keep page content, URLs, and titles out of logs by default. The host logs
      counts; the client does not surface raw event payloads on the error path.

### Feeding the model

- [x] Emit `BrowserSnapshot` and `BrowserDelta` values `BrowserRegistry`
      accepts, at schema version 1.
- [x] Map Space UUIDs, container identity, essential tabs, and lazy tabs into
      the model, marking anything unavailable as `unknown` or `unsupported`.
- [x] Issue a new session identity on reconnect and stale the previous one with
      `session-replaced`.
- [x] **Determine whether stable tab IDs survive tab movement and Space
      changes.** **Proven.** Identity is a `WeakMap` keyed on the tab element,
      and moving a tab between Spaces is a DOM move of that same element, so the
      identifier is unchanged — confirmed headed, along with every identifier
      from the first snapshot still resolving afterwards. Nothing is written to
      the profile to obtain identity. The identity contract in
      `docs/browser-model.md` stands.

### Evidence

- [x] Add contract tests that run without Zen installed, covering framing,
      chunking, protocol versioning, capability refusal, snapshot translation,
      the client, the host manifest, and the host's own connect-and-reconcile
      loop driven by a scripted browser over real frames.
- [x] Add a headed integration test behind `ZEN_SPIKE=1` that asserts selected
      tab, focused window, visible Space, and media playback are unchanged.
      `test/integration/transport.proof.test.ts`, green on three consecutive
      runs. Focus is checked against the frontmost macOS application as well as
      the model's own field, and playback is measured from the page's reported
      position rather than the tab's `soundPlaying` flag, which proved to depend
      on window occlusion.
- [x] Document the required Zen settings, profile changes, and extension
      permissions, including that an unsigned privileged add-on means either
      `xpinstall.signatures.required = false` or reloading from
      `about:debugging` on every restart. Say so plainly; do not bury it.
      [docs/transport.md](../docs/transport.md).

## 4. Implement configuration and Personal/Work routing

Tracking: [DEV-274](https://linear.app/intuitum/issue/DEV-274), split out of
DEV-262. This section needs no browser, so it can proceed in parallel with
section 3.

- [ ] Choose a versioned local configuration format and path.
- [ ] Add schema validation with actionable error messages.
- [ ] Support explicit Zen profile selection.
- [ ] Support explicit mappings from Zen Space IDs to `personal` and `work`.
- [ ] Support named Space aliases without relying on their visual position.
- [ ] Support domain and URL rules for Personal/Work routing.
- [ ] Support an explicit per-command or per-tool Space override.
- [ ] Support a task-context hint such as `personal`, `work`, or a named Space.
- [ ] Define deterministic precedence:
  1. [ ] Explicit stable Space ID or alias.
  2. [ ] Configured URL/domain rule.
  3. [ ] Explicit task-context hint.
  4. [ ] Configured safe default.
  5. [ ] Ambiguity error.
- [ ] Decide how conflicting domain rules are reported.
- [ ] Never infer that a domain such as GitHub is always Personal or always Work
      without user configuration.
- [ ] Add a dry-run/explain result that reports why a Space and tab were chosen.
- [ ] Add a configuration command that can map the currently discovered Zen
      Space IDs without selecting those Spaces.
- [ ] Add unit tests for Personal, Work, named Space, explicit override,
      conflicts, missing mappings, and safe-default behavior.

## 5. Implement tab discovery and resolution

- [ ] Normalize URLs for comparison without discarding security-relevant
      components.
- [ ] Define matching rules for exact URL, normalized URL, origin, domain,
      title, and caller-provided query.
- [ ] Prefer an exact matching tab in the chosen Space.
- [ ] Never reuse a matching tab from the wrong Space unless explicitly
      requested.
- [ ] Avoid reusing sensitive or stateful pages merely because their domains
      match.
- [ ] Return all candidates and an ambiguity error when more than one tab is an
      equally safe match.
- [ ] Include a machine-readable explanation of `reused`, `opened`, or
      `ambiguous` in every resolution result.
- [ ] Make tab creation idempotent so concurrent agents do not open duplicates.
- [ ] Ensure a newly opened tab stays in the background.
- [ ] Ensure navigation targets the resolved stable tab ID.
- [ ] Handle popups, redirects, discarded tabs, crashed tabs, and tabs closed
      between resolution and action.
- [ ] Add race tests for simultaneous resolve/open requests.

## 6. Build the shared local daemon

Tracking: [DEV-263](https://linear.app/intuitum/issue/DEV-263)

- [ ] Choose and document the daemon protocol, initially over a Unix domain
      socket.
- [ ] Define a versioned request, response, event, and error schema.
- [ ] Implement singleton startup and stale lock/PID recovery.
- [ ] Use restrictive local socket and state-file permissions.
- [ ] Own exactly one transport connection per Zen session/profile.
- [ ] Maintain the live browser/window/Space/tab registry.
- [ ] Subscribe to lifecycle events and reconcile missed events with periodic
      snapshots.
- [ ] Reconnect safely after Zen restarts or the protocol disconnects.
- [ ] Invalidate old stable IDs after session replacement.
- [ ] Serialize conflicting mutations while allowing safe concurrent reads.
- [ ] Enforce all background-only and explicit-ID invariants in the daemon.
- [ ] Add idempotency keys for retryable mutations.
- [ ] Add health, version, capabilities, and status methods.
- [ ] Add structured, sanitized diagnostic logging.
- [ ] Add configurable log levels without logging page content by default.
- [ ] Implement graceful shutdown and clean client disconnection.
- [ ] Decide whether the daemon starts on demand, through `launchd`, or both.
- [ ] Add unit, protocol-contract, reconnect, concurrency, and crash-recovery
      tests.

## 7. Implement the terminal CLI

Tracking: [DEV-265](https://linear.app/intuitum/issue/DEV-265)

- [ ] Choose a command/parser library or intentionally retain a small custom
      parser.
- [ ] Define stable human-readable and JSON output contracts.
- [ ] Define stable exit codes for invalid input, ambiguity, stale ID, browser
      unavailable, unsupported capability, timeout, and policy rejection.
- [ ] Implement `zen-agent status`.
- [ ] Implement `zen-agent spaces list`.
- [ ] Implement `zen-agent tabs list [--space ...] [--json]`.
- [ ] Implement `zen-agent tabs resolve <url-or-query> [--space ...]`.
- [ ] Implement `zen-agent tabs open <url> [--space ...]`.
- [ ] Implement `zen-agent tabs navigate <tab-id> <url>`.
- [ ] Implement `zen-agent tabs reload <tab-id>`.
- [ ] Implement `zen-agent tabs close <tab-id>`.
- [ ] Require an explicit stable tab ID for mutations of an existing tab.
- [ ] Make background behavior the default and omit any foreground flag until
      there is a justified use case.
- [ ] Add `--explain` or equivalent routing diagnostics.
- [ ] State side effects in help text for every mutating command.
- [ ] Ensure all CLI operations go through the daemon.
- [ ] Add CLI unit, snapshot, daemon-boundary, and exit-code tests.

## 8. Implement background-safe page interaction

Tab management alone is not enough for agents to complete browser tasks.

- [ ] Define a page snapshot format suitable for agents.
- [ ] Prefer an accessibility/semantic snapshot over raw full-page HTML.
- [ ] Scope every page operation to an explicit stable tab ID.
- [ ] Assign short-lived element references that are also scoped to tab and
      snapshot generation.
- [ ] Return a stale-element error after navigation or DOM replacement.
- [ ] Implement page URL, title, text, and load-state inspection.
- [ ] Implement semantic element lookup and query.
- [ ] Implement click without activating the tab.
- [ ] Implement fill and type without activating the tab.
- [ ] Implement keyboard press without sending input to the user's active tab.
- [ ] Implement select, check, uncheck, and form submission.
- [ ] Implement wait for load state, URL, text, element, and bounded timeout.
- [ ] Implement back, forward, reload, and explicit navigation.
- [ ] Handle same-origin and cross-origin frames with explicit frame identity.
- [ ] Handle dialogs without blocking the entire daemon.
- [ ] Handle downloads with explicit destination policy and status reporting.
- [ ] Handle file uploads only from explicit caller-provided paths.
- [ ] Decide whether screenshots can be captured without tab selection; expose
      them only if the invariant is proven.
- [ ] Decide whether arbitrary JavaScript evaluation is necessary.
- [ ] If evaluation is exposed, clearly mark it as privileged and prevent its
      result or arguments from entering logs.
- [ ] Add per-operation timeouts, cancellation, and useful error diagnostics.
- [ ] Test dynamic applications, shadow DOM, iframes, redirects, dialogs,
      downloads, stale elements, and background execution.

## 9. Expose the daemon through MCP

Tracking: [DEV-264](https://linear.app/intuitum/issue/DEV-264)

- [ ] Add an MCP stdio entry point.
- [ ] Use the official current MCP SDK and pin a compatible version.
- [ ] Expose capability/status discovery.
- [ ] Expose Space and tab listing.
- [ ] Expose tab resolution and background opening.
- [ ] Expose explicit-ID navigation, reload, and close operations.
- [ ] Expose the proven page snapshot and interaction operations.
- [ ] Generate strict input and output schemas.
- [ ] Include side-effect and safety information in every tool description.
- [ ] Return structured ambiguity, stale-ID, unsupported-capability,
      unavailable-browser, timeout, and policy errors.
- [ ] Keep routing and mutation policy in the daemon, not the MCP wrapper.
- [ ] Do not add a wrapper-specific approval prompt.
- [ ] Support clean shutdown when the host closes stdio.
- [ ] Add MCP protocol tests for initialization, tool listing, every tool,
      malformed input, daemon errors, and shutdown.
- [ ] Document configuration for Codex and other MCP-compatible terminal agents.

## 10. Multi-agent correctness

- [ ] Define ownership and lease behavior for concurrent work on the same tab.
- [ ] Decide whether reads can occur while another client mutates a tab.
- [ ] Prevent duplicate tab creation across simultaneous agents.
- [ ] Prevent one agent from navigating or closing a tab another agent has
      leased unless explicitly forced.
- [ ] Include client and operation IDs in sanitized diagnostics.
- [ ] Add optimistic version checks to tab and snapshot mutations.
- [ ] Make safe retries idempotent.
- [ ] Add load and race tests with multiple CLI and MCP clients.

## 11. Security and privacy hardening

- [ ] Write a threat model covering local clients, malicious pages, compromised
      dependencies, remote-protocol exposure, extensions, and Native Messaging.
- [ ] Ensure the browser protocol is never exposed on a non-loopback interface.
- [ ] Authenticate or permission-gate the local daemon socket if filesystem
      permissions are insufficient.
- [ ] Minimize Zen extension permissions if an extension is required.
- [ ] Define redaction rules for URLs, query strings, page text, form values,
      headers, cookies, and downloaded filenames.
- [ ] Keep secrets and browser-profile data out of crash reports.
- [ ] Add maximum message, snapshot, and result sizes.
- [ ] Add bounded timeouts and resource limits.
- [ ] Validate every URL and reject unsupported or dangerous schemes.
- [ ] Define behavior for `file:`, `data:`, `javascript:`, extension, and
      browser internal URLs.
- [ ] Define download and upload path boundaries.
- [ ] Audit production and development dependencies continuously.
- [ ] Add secret scanning and an appropriate static-analysis path if the
      repository's GitHub plan supports it.
- [ ] Document that website-level destructive actions follow the calling agent's
      policy; Zen Agent itself does not add a redundant allow prompt.

## 12. Testing and safety verification

- [ ] Set a coverage target for policy, resolver, daemon, CLI, and MCP code.
- [ ] Add fixture sites for forms, navigation, frames, dialogs, downloads, and
      dynamic DOM replacement.
- [ ] Add transport contract tests that can run without Zen.
- [ ] Add macOS integration tests against an installed Zen Browser.
- [ ] Add a repeatable daily-profile smoke test that does not modify user data.
- [ ] Add a regression scenario with a selected YouTube/media tab.
- [ ] Assert selected tab, focused window, visible Space, playback state, and
      playback time before and after every background-operation scenario.
- [ ] Test Personal and Work Space routing in separate windows and in the same
      window.
- [ ] Test Zen restart, daemon restart, sleep/wake, network loss, crashed tabs,
      and stale IDs.
- [ ] Test two agents operating concurrently.
- [ ] Test large tab counts and long-running daemon behavior.
- [ ] Test on every supported Zen and macOS version.
- [ ] Keep environment-dependent Zen tests separate from portable unit/contract
      CI.

## 13. Documentation and diagnostics

- [ ] Document Zen configuration and startup requirements.
- [ ] Document how to identify and map Personal and Work Spaces.
- [ ] Document installation, upgrade, and uninstall procedures.
- [ ] Document CLI commands with JSON examples and exit codes.
- [ ] Document every MCP tool with side effects and examples.
- [ ] Document the daemon lifecycle and local files it creates.
- [ ] Document privacy defaults, redaction, and log locations.
- [ ] Add a troubleshooting guide for connection failures, unsupported Zen
      versions, stale tabs, ambiguous routing, and extension/native-host setup.
- [ ] Add a diagnostic command that reports versions, capabilities, connection
      state, and sanitized configuration without exposing secrets.
- [ ] Maintain a supported Zen/Firefox/macOS compatibility matrix.
- [ ] Add architecture diagrams and decision records.

## 14. Packaging and release readiness

- [ ] Decide whether to publish to npm, distribute a standalone binary, provide
      a Homebrew formula, or use a combination.
- [ ] Decide whether the CLI, daemon, and MCP entry point ship in one package.
- [ ] Bundle production code and verify the executable works outside the
      repository.
- [ ] Package and register the Native Messaging host if the chosen transport
      requires one.
- [ ] Package and sign the Zen/Firefox extension if one is required.
- [ ] Add semantic versioning and changelog automation.
- [ ] Add release CI, provenance, checksums, and an SBOM.
- [ ] Add macOS code signing/notarization if distributing native executables.
- [ ] Add an upgrade path for configuration and daemon protocol versions.
- [ ] Run a clean-machine install, upgrade, rollback, and uninstall test.
- [ ] Publish nothing and deploy nothing until explicitly approved.

## MVP completion criteria

The first usable release is complete only when all of the following are true:

- [ ] With the user's normal Zen session open, `zen-agent` can list all
      supported windows, Spaces, and tabs without changing visible browser
      state.
- [ ] It reuses an appropriate existing background tab when available.
- [ ] It opens a missing tab in the configured Personal or Work Space without
      switching to it.
- [ ] It can inspect and interact with that explicit background tab.
- [ ] A selected media tab continues playing without focus, selection, Space, or
      playback interruption.
- [ ] The CLI and MCP interfaces produce equivalent results and structured
      errors.
- [ ] Concurrent agents do not race, duplicate tabs, or mutate one another's
      leased tabs.
- [ ] Installation, configuration, diagnostics, and recovery are documented.
- [ ] Unit, contract, integration, safety, and remote CI checks pass.

## Open questions to resolve early

- [x] Can Zen's daily-use process be attached through BiDi after it has already
      started? **No.** Zen must be launched with `--remote-debugging-port`.
- [x] Does Zen expose Space metadata to remote clients? **No.** Spaces are
      chrome-level state; BiDi sees only containers, as opaque per-session
      UUIDs.
- [x] Are Zen Spaces represented by Firefox containers, Zen-only browser state,
      or both? **Both.** A Space is Zen-only state (`uuid`, `name`, in
      `zen-sessions.jsonlz4`) that optionally binds a container via
      `containerTabId`. Essential tabs sit outside every Space.
- [ ] Can all required page operations run against a non-selected tab? Navigate,
      evaluate, type, and screenshot: yes. Background timer throttling applies,
      so in-page polling is unreliable.
- [x] Can screenshots be captured without selection or compositor side effects?
      **Yes**, proven headless against a non-selected tab. Re-confirm headed.
- [x] Is a privileged extension or Native Messaging host unavoidable? **Yes,
      both.** Nothing else can see a non-visible Space, and a native port is the
      only supported way to keep an MV3 event page alive. Both are now proven
      working together in a single add-on.
- [ ] How should Space ambiguity be surfaced to terminal agents?
- [ ] What is the smallest safe page-interaction surface for the first release?
- [ ] Which Zen, Firefox, macOS, and Node versions will be supported initially?
