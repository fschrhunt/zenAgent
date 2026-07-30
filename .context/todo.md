# Zen Agent TODO

Last updated: 2026-07-29

This is the dependency-ordered implementation checklist for Zen Agent. Check an
item only after its acceptance criteria are verified. Product work is tracked in
the
[Zen-Agent Linear project](https://linear.app/intuitum/project/zen-agent-977b6899630f).

## Non-negotiable behavior

Every implementation phase must preserve these invariants:

- [x] Discover windows, Spaces, and tabs before deciding to open a tab.
- [x] Reuse an appropriate existing tab when one is already open.
- [x] Address existing tabs by stable ID, never by whichever tab is active.
- [x] Never focus a Zen window, select a tab, or switch the visible Space.
- [x] Never interrupt the selected tab or media playing in another tab.
- [x] Open new tabs in the background in the appropriate Personal or Work Space.
- [x] Keep browser policy in one shared daemon; expose automation through MCP
      and keep the CLI limited to setup, configuration, and diagnostics.
- [x] Do not add a general-purpose manual approval layer for ordinary browser
      operations.
- [x] Return an explicit ambiguity or capability error instead of silently
      choosing an unsafe fallback.
- [x] Keep page content, cookies, credentials, tokens, and form values out of
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
- [x] Record the Zen versions the capability probe has actually passed on, and
      fail closed on versions it has not. The host now accepts exactly Zen
      1.21.9b / Gecko 153.0, the pair that passed all eight capabilities and the
      complete headed proof four times. Unknown pairs are refused before the
      first snapshot or mutation.
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
- [x] Install the host manifest to
      `~/Library/Application Support/Mozilla/NativeMessagingHosts/`, not the
      `.../Zen/` path some third-party installers guess. The path and contents
      are implemented and tested in `src/native/manifest.ts`, and the headed
      proof confirms Zen launches a host registered there.
      `zen-agent native-host install` now creates an owner-only executable
      launcher and manifest without overwriting either target; the matching
      uninstall command removes only files it can verify Zen Agent owns.
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

- [x] Choose a versioned local configuration format and path. Schema v1 JSON
      lives under the user's platform configuration directory, with an
      explicit-path override for callers and tests.
- [x] Add schema validation with actionable error messages.
- [x] Support explicit Zen profile selection.
- [x] Support explicit mappings from Zen Space IDs to `personal` and `work`.
- [x] Support named Space aliases without relying on their visual position.
- [x] Support domain and URL rules for Personal/Work routing.
- [x] Support an explicit per-command or per-tool Space override.
- [x] Support a task-context hint such as `personal`, `work`, or a named Space.
- [x] Define deterministic precedence:
  1. [x] Explicit stable Space ID or alias.
  2. [x] Configured URL/domain rule.
  3. [x] Explicit task-context hint.
  4. [x] Configured safe default.
  5. [x] Ambiguity error.
- [x] Decide how conflicting domain rules are reported. Equally specific rules
      targeting different Spaces return every candidate and contributing rule ID
      without choosing.
- [x] Never infer that a domain such as GitHub is always Personal or always Work
      without user configuration.
- [x] Add a dry-run/explain result that reports why a Space and tab were chosen.
- [x] Add a configuration command that can map the currently discovered Zen
      Space IDs without selecting those Spaces. `zen-agent config map` reads
      current discovery through the daemon and writes the validated config
      atomically.
- [x] Add unit tests for Personal, Work, named Space, explicit override,
      conflicts, missing mappings, and safe-default behavior.

## 5. Implement tab discovery and resolution

- [x] Normalize URLs for comparison without discarding security-relevant
      components. Credentials, scheme, port, path, query, and fragment remain
      part of comparison; only the URL standard's canonical serialization is
      applied.
- [x] Define matching rules for exact URL, normalized URL, origin, domain,
      title, and caller-provided query.
- [x] Prefer an exact matching tab in the chosen Space.
- [x] Never reuse a matching tab from the wrong Space unless explicitly
      requested.
- [x] Avoid reusing sensitive or stateful pages merely because their domains
      match. Weak matching is refused by default for credentials, query,
      fragment, and sensitive workflow paths.
- [x] Return all candidates and an ambiguity error when more than one tab is an
      equally safe match.
- [x] Include a machine-readable explanation of `reused`, `opened`, or
      `ambiguous` in every resolution result.
- [x] Make tab creation idempotent so concurrent agents do not open duplicates.
      Equivalent resolver work coalesces, daemon mutations serialize across
      clients, and a two-client race test proves one open followed by one reuse.
- [x] Ensure a newly opened tab stays in the background. The transport exposes
      no foreground option and the headed proof verifies selection is unchanged.
- [x] Ensure navigation targets the resolved stable tab ID.
- [ ] Handle popups, redirects, discarded tabs, crashed tabs, and tabs closed
      between resolution and action.
- [x] Add race tests for simultaneous resolve/open requests. Equivalent
      in-flight resolutions coalesce and creation receives an opaque
      deterministic idempotency key; daemon/transport enforcement remains.

## 6. Build the shared local daemon

Tracking: [DEV-263](https://linear.app/intuitum/issue/DEV-263)

- [x] Choose and document the daemon protocol, initially over a Unix domain
      socket. [ADR 0002](../docs/adr/0002-shared-local-daemon.md).
- [x] Define a versioned request, response, event, and error schema.
- [x] Implement singleton startup and stale lock/PID recovery.
- [x] Use restrictive local socket and state-file permissions.
- [x] Own exactly one transport connection per Zen session/profile.
- [x] Maintain the live browser/window/Space/tab registry.
- [x] Subscribe to lifecycle events and reconcile missed events with periodic
      snapshots.
- [x] Reconnect safely after Zen restarts or the protocol disconnects.
- [x] Invalidate old stable IDs after session replacement.
- [x] Serialize conflicting mutations while allowing safe concurrent reads.
- [x] Enforce all background-only and explicit-ID invariants in the daemon.
- [x] Add idempotency keys for retryable mutations.
- [x] Add health, version, capabilities, and status methods.
- [x] Add structured, sanitized diagnostic logging.
- [x] Add configurable log levels without logging page content by default.
- [x] Implement graceful shutdown and clean client disconnection.
- [x] Decide whether the daemon starts on demand, through `launchd`, or both.
      The native messaging host is the daemon, so Zen starts it on browser
      demand when the extension opens its port. Setup CLI and MCP clients never
      start a competing process that lacks that browser-provided connection.
- [x] Add unit, protocol-contract, reconnect, concurrency, and crash-recovery
      tests.

## 7. Implement the setup and maintenance CLI

Tracking: [DEV-265](https://linear.app/intuitum/issue/DEV-265)

- [x] Choose a command/parser library or intentionally retain a small custom
      parser. The dependency-free parser is retained deliberately and covered
      through the complete command surface.
- [x] Define stable human-readable and JSON output contracts.
- [x] Define stable exit codes for invalid input, ambiguity, stale ID, browser
      unavailable, unsupported capability, timeout, and policy rejection.
- [x] Implement `zen-agent status`.
- [x] Implement `zen-agent spaces list`.
- [x] Implement `zen-agent config map` with current Space-ID validation and
      explicit daemon reload.
- [x] Implement safe native-host install, upgrade, and uninstall commands.
- [x] Make no-argument TTY invocation a branded arrow-key setup wizard for
      native-host setup, Zen requirements, connection health, and Personal/Work
      mapping while keeping explicit commands deterministic for agents.
- [x] Remove tab listing, resolution, and mutation commands from the CLI; MCP is
      the only agent-facing browser automation surface. Recorded in ADR 0004.
- [x] Ensure status, discovery, and configuration operations go through the
      daemon without starting a competing process.
- [x] Add setup wizard and CLI unit, snapshot, daemon-boundary, TTY-boundary,
      native-host inspection, and exit-code tests.

## 8. Implement background-safe page interaction

Tab management alone is not enough for agents to complete browser tasks.

- [x] Define a page snapshot format suitable for agents.
- [x] Prefer an accessibility/semantic snapshot over raw full-page HTML.
- [x] Scope every page operation to an explicit stable tab ID. The first exposed
      operation, `pages.inspect`, resolves only the caller's stable tab ID; no
      active-tab fallback exists.
- [x] Assign short-lived element references that are also scoped to tab and
      snapshot generation.
- [x] Return a stale-element error after navigation or DOM replacement.
- [x] Implement page URL, title, text, and load-state inspection. A dedicated
      packaged JSWindowActor passed the headed non-visible-Space proof with
      bounded output and traversal; see
      [the page interaction spike](../docs/spikes/page-interaction.md).
- [x] Implement semantic element lookup and query.
- [x] Implement click without activating the tab.
- [x] Implement fill and type without activating the tab.
- [x] Implement keyboard press without sending input to the user's active tab.
- [x] Implement select, check, uncheck, and form submission.
- [x] Implement wait for load state, URL, text, element, and bounded timeout.
- [x] Implement back, forward, reload, and explicit navigation.
- [x] Handle same-origin and cross-origin frames with explicit frame identity.
- [ ] Handle dialogs without blocking the entire daemon. The capability remains
      absent: no tab-scoped path has yet passed the headed non-interference
      gate, and foreground or window-modal handling is permanently unsupported.
- [x] Handle downloads with explicit destination policy and status reporting.
      Bounded same-origin HTTP(S) resources stream to collision-safe files in
      the configured Downloads directory; Firefox download UI is never used.
- [x] Handle file uploads only from explicit caller-provided paths. The daemon
      rejects symlinks and non-regular files, stages bounded files without
      logging paths, and assigns them without opening a picker.
- [x] Decide whether screenshots can be captured without tab selection; expose
      them only if the invariant is proven. Bounded viewport and explicit
      element PNGs passed three consecutive headed non-interference runs.
- [x] Decide whether arbitrary JavaScript evaluation is necessary. It is not
      exposed; named operations cover the accepted use cases with a smaller
      privileged surface.
- [x] Keep evaluation unexposed. There is no privileged evaluation result or
      argument surface to log.
- [x] Add per-operation timeouts, cancellation, and useful error diagnostics.
- [ ] Test dynamic applications, shadow DOM, iframes, redirects, dialogs,
      downloads, stale elements, and background execution. All listed cases
      except dialogs now have portable or headed coverage; dialog capability
      remains absent pending a safe actor design.

## 9. Expose the daemon through MCP

Tracking: [DEV-264](https://linear.app/intuitum/issue/DEV-264)

- [x] Add an MCP stdio entry point.
- [x] Use the official MCP SDK with exact compatible pins:
      `@modelcontextprotocol/sdk` 1.30.0 and Zod 4.4.3. The transitive Hono
      server is overridden to patched 2.0.12; the production audit is clean.
- [x] Expose capability/status discovery.
- [x] Expose Space and tab listing.
- [x] Expose tab resolution and background opening.
- [x] Expose explicit-ID navigation, reload, and close operations.
- [x] Expose the proven page snapshot and interaction operations.
- [x] Generate strict input and output schemas.
- [x] Include side-effect and safety information in every tool description.
- [x] Return structured ambiguity, stale-ID, unsupported-capability,
      unavailable-browser, timeout, and policy errors.
- [x] Keep routing and mutation policy in the daemon, not the MCP wrapper.
- [x] Do not add a wrapper-specific approval prompt.
- [x] Support clean shutdown when the host closes stdio.
- [x] Add MCP protocol tests for initialization, tool listing, every tool,
      malformed input, daemon errors, and shutdown.
- [x] Document configuration for Codex and other MCP-compatible terminal agents.

## 10. Multi-agent correctness

- [x] Define ownership and lease behavior for concurrent work on the same tab.
- [x] Decide whether reads can occur while another client mutates a tab. Safe
      registry/status reads bypass the FIFO mutation queue and are covered by a
      gated-mutation concurrency test.
- [x] Prevent duplicate tab creation across simultaneous agents. Resolve/open
      operations serialize around fresh discovery, with a two-client race test.
- [x] Prevent one agent from navigating or closing a tab another agent has
      leased unless explicitly forced.
- [x] Include client and operation IDs in sanitized diagnostics.
- [x] Add optimistic version checks to tab and snapshot mutations. Existing-tab
      mutations accept an optional registry-sequence precondition that is
      checked inside the per-tab queue immediately before dispatch. Element
      mutations require the client's newest retained snapshot for the tab; older
      snapshots remain read-only.
- [x] Make safe retries idempotent. Retryable mutations require client-scoped
      idempotency keys with bounded retention.
- [x] Add load and race tests with multiple MCP clients. Portable tests cover a
      two-client resolve race, bounded multi-client socket load across per-tab
      queues, same-tab FIFO ordering, and cross-tab concurrency.

## 11. Security and privacy hardening

- [x] Write a threat model covering local clients, malicious pages, compromised
      dependencies, remote-protocol exposure, extensions, and Native Messaging.
      See [docs/threat-model.md](../docs/threat-model.md).
- [x] Ensure the browser protocol is never exposed on a non-loopback interface.
      The chosen transport is Native Messaging plus a local Unix socket; no TCP
      listener exists.
- [x] Authenticate or permission-gate the local daemon socket if filesystem
      permissions are insufficient. The daemon directory is owner-only `0700`
      and its socket and lock are `0600`; moving it outside that boundary is
      explicitly unsupported.
- [x] Minimize Zen extension permissions if an extension is required. The
      production add-on requests `nativeMessaging` only, plus the
      `experiment_apis` declaration required for the privileged API.
- [x] Define redaction rules for URLs, query strings, page text, form values,
      headers, cookies, and downloaded filenames. The threat model permits
      opaque IDs, counts, versions, capabilities, operation names, and error
      codes while omitting browser and page content.
- [x] Keep secrets and browser-profile data out of crash reports. Process entry
      points now emit only bounded sanitized error classifications.
- [x] Add maximum message, snapshot, and result sizes. Native chunks, daemon
      frames, retained snapshots, JSON shapes, page inspection, and identifiers
      all have enforced ceilings; see ADR 0003.
- [x] Add bounded timeouts and resource limits.
- [x] Validate every URL and reject unsupported or dangerous schemes.
- [x] Define behavior for `file:`, `data:`, `javascript:`, extension, and
      browser internal URLs.
- [x] Define download and upload path boundaries. Uploads accept explicit
      caller-authorized absolute regular-file paths and reject symlinks,
      directories, devices, excessive counts, and excessive sizes. Downloads use
      the configured standard Downloads directory, collision-safe names, bounded
      bytes, cancellation, and no overwrite.
- [x] Audit production and development dependencies continuously. The security
      workflow and Dependabot remain enabled; the final production audit
      reported zero vulnerabilities.
- [x] Add secret scanning and an appropriate static-analysis path if the
      repository's GitHub plan supports it. The security workflow now runs
      gitleaks and CodeQL for JavaScript/TypeScript; `actionlint` passed
      locally. The first remote workflow run remains release evidence rather
      than a local claim.
- [x] Document that website-level destructive actions follow the calling agent's
      policy; Zen Agent itself does not add a redundant allow prompt. Recorded
      in the malicious-page boundary of the threat model.

## 12. Testing and safety verification

- [x] Set a coverage target for policy, resolver, daemon, setup CLI, and MCP
      code. Per-area statement, branch, function, and line thresholds are
      enforced by `npm run test:coverage`; the complete portable run passed with
      358 tests on 2026-07-29.
- [ ] Add fixture sites for forms, navigation, frames, dialogs, downloads, and
      dynamic DOM replacement. Forms, navigation, frames, resource downloads,
      uploads, media, popup refusals, and replacement are covered; dialogs stay
      pending with the capability unadvertised.
- [x] Add transport contract tests that can run without Zen.
- [x] Add macOS integration tests against an installed Zen Browser, gated by
      `ZEN_SPIKE=1` and isolated in a fresh throwaway profile.
- [ ] Add a repeatable daily-profile smoke test that does not modify user data.
- [x] Add a regression scenario with selected media playing continuously while
      background operations run. The local audio fixture is deterministic and
      avoids relying on YouTube availability.
- [x] Assert selected tab, focused window, visible Space, playback state, and
      playback time around the combined background open, move, navigate, reload,
      inspect, semantic interaction, history, and close scenario. The complete
      interaction proof passed three consecutive headed runs.
- [ ] Test Personal and Work Space routing in separate windows and in the same
      window.
- [ ] Test Zen restart, daemon restart, sleep/wake, network loss, crashed tabs,
      and stale IDs.
- [x] Test two agents operating concurrently. A two-client simultaneous resolve
      race proves one open followed by one reuse.
- [ ] Test large tab counts and long-running daemon behavior.
- [ ] Test on every supported Zen and macOS version.
- [x] Keep environment-dependent Zen tests separate from portable unit/contract
      CI.

## 13. Documentation and diagnostics

- [x] Document Zen configuration and startup requirements.
- [x] Document how to identify and map Personal and Work Spaces.
- [x] Document installation, upgrade, and uninstall procedures.
- [x] Document setup CLI commands with JSON examples and exit codes.
- [x] Document every current MCP tool with side effects and result examples.
- [x] Document the daemon lifecycle and local files it creates.
- [x] Document privacy defaults, redaction, and log locations.
- [x] Add a troubleshooting guide for connection failures, unsupported Zen
      versions, stale tabs, ambiguous routing, and extension/native-host setup.
- [x] Add a diagnostic command that reports versions, capabilities, connection
      state, and sanitized configuration without exposing secrets. `doctor`
      reports the configured/running profile match, Zen, Gecko, extension,
      daemon and protocol versions, Downloads writability, private-window
      policy, and speech asset state without page content or paths.
- [x] Maintain a supported Zen/Firefox/macOS compatibility matrix.
- [x] Add architecture diagrams and decision records.

## 14. Packaging and release readiness

- [x] Decide whether to publish to npm, distribute a standalone binary, provide
      a Homebrew formula, or use a combination. Homebrew is the only
      package-manager release channel. It installs an offline-capable bundled
      artifact from GitHub Releases; npm remains an internal build tool only.
      Standalone binaries are deferred while the native host depends on Node.js.
      See [distribution](../docs/distribution.md).
- [x] Decide whether the setup CLI, daemon, and MCP entry point ship in one
      package. The bundled Homebrew release artifact contains all three
      executable entry points.
- [x] Bundle production code and verify the executable works outside the
      repository. A clean temporary install from the packed tarball passed CLI
      and sanitized MCP startup smoke tests.
- [x] Package and register the Native Messaging host if the chosen transport
      requires one.
- [ ] Package and sign the Zen/Firefox extension if one is required.
- [x] Add semantic versioning and changelog automation. `version:check`
      validates SemVer and keeps the package, lockfile, extension manifest, and
      dated changelog heading synchronized as part of `npm run check`.
- [ ] Add release CI, provenance, checksums, and an SBOM. A release-triggered
      workflow now builds an offline-capable bundled Node tarball, unsigned XPI,
      SPDX SBOM, checksums, provenance attestation, and Homebrew formula, then
      uploads the assets. Keep this open until the first tagged release proves
      the workflow with tag protection configured.
- [ ] Add macOS code signing/notarization if distributing native executables.
- [x] Add an upgrade path for configuration and daemon protocol versions. Schema
      1 has an explicit atomic migration to conservative schema 2 defaults.
      Daemon mismatch errors now report machine-readable expected/received
      versions and a non-retryable all-component recovery action;
      [Upgrade and rollback](../docs/upgrading.md) documents package,
      native-host, extension, configuration, restart, verification, and rollback
      order. Clean-machine execution remains separately open below.
- [ ] Run a clean-machine install, upgrade, rollback, and uninstall test.
- [x] Publish nothing and deploy nothing until explicitly approved. Only local
      dry-run and temporary package-install verification were performed.

## MVP completion criteria

The first usable release is complete only when all of the following are true:

- [ ] With the user's normal Zen session open, Zen Agent MCP can list all
      supported windows, Spaces, and tabs without changing visible browser
      state.
- [ ] It reuses an appropriate existing background tab when available.
- [ ] It opens a missing tab in the configured Personal or Work Space without
      switching to it.
- [ ] It can inspect and interact with that explicit background tab.
- [ ] A selected media tab continues playing without focus, selection, Space, or
      playback interruption.
- [ ] The MCP interface returns stable results and structured errors for every
      supported browser operation.
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
- [x] Can all required accepted page operations run against a non-selected tab?
      Yes for named DOM operations, screenshots, explicit uploads, bounded
      resources, media inspection, captions, and transcription inputs. Arbitrary
      evaluation and dialogs are not required or exposed. Background timer
      throttling still means in-page polling is unreliable.
- [x] Can screenshots be captured without selection or compositor side effects?
      **Yes**, current-viewport and explicit-element capture passed three
      consecutive headed runs without selection, focus, Space, cursor, or media
      interference.
- [x] Is a privileged extension or Native Messaging host unavoidable? **Yes,
      both.** Nothing else can see a non-visible Space, and a native port is the
      only supported way to keep an MV3 event page alive. Both are now proven
      working together in a single add-on.
- [x] How should Space ambiguity be surfaced to terminal agents? As a structured
      ambiguity error containing every equally safe candidate and a
      machine-readable explanation; neither the daemon nor its MCP adapter
      chooses one.
- [x] What is the smallest safe page-interaction surface for the first release?
      [The page-interaction direction](../docs/spikes/page-interaction.md)
      selects semantic snapshots and narrowly named operations scoped to
      explicit tab/frame/generation IDs. Screenshots, explicit uploads, bounded
      downloads, media inspection, and on-device transcription are now accepted
      after their individual gates. Arbitrary evaluation and dialogs remain
      unexposed.
- [x] Which Zen, Firefox, macOS, and Node versions will be supported initially?
      Zen 1.21.9b / Gecko 153.0 on macOS 27.0 arm64 is the initial
      headed-supported browser environment. Node 24+ is supported by the
      portable CI gate; the headed proof ran on Node 26.5.0.
