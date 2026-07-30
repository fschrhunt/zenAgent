# Background page interaction: implementation direction

- Status: Dedicated Zen Agent JSWindowActor accepted for bounded semantic
  inspection and named DOM interaction
- Date: 2026-07-29
- Tested browser source: Zen 1.21.9b / Gecko 153.0

## Goal

Find the smallest page-interaction surface that can inspect and operate a tab by
stable ID without selecting it, focusing Zen, switching the visible Space, or
adding broad WebExtension host permissions.

## Local findings

Zen's shipped `omni.ja` contains Firefox's `PageExtractor` JSWindowActor. Its
registration matches HTTP and HTTPS documents, and its parent actor exposes text
and page-metadata queries. A chrome caller obtains it from:

```js
tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("PageExtractor");
```

This looked like a promising first read-only page operation without starting
BiDi, selecting the tab, or injecting a WebExtension content script. The headed
proof below rejected it for the product's background use case.

## Headed result: PageExtractor stops in a non-visible Space

Tested on 2026-07-29 against Zen 1.21.9b / Gecko 153.0 with the transport
proof's throwaway profile and local HTTP fixture:

1. The experiment API resolved an explicit selected-tab ID to
   `currentWindowGlobal.getActor("PageExtractor")`.
2. `getText({ sufficientLength: 80 })` completed for that selected tab.
3. The same call, through the same API, against a loaded tab in a non-visible
   Space did not resolve within an 8-second parent-process deadline.
4. The selected tab and visible Space were never changed.

The cause is consistent with the shipped child implementation:
`PageExtractorChild.getText()` always calls `waitForPageReady()`, and that
method always waits for a double `requestAnimationFrame`. Gecko suspends those
callbacks for the non-visible-Space document, even though the document had
finished loading before inspection began. Increasing the deadline would not make
this a bounded operation.

The experiment API can therefore call PageExtractor, but PageExtractor cannot
provide background-safe text inspection. Zen Agent does not expose it and does
not activate the tab as a workaround. A dedicated Zen Agent JSWindowActor was
the next candidate because its child could avoid page timers and enforce its own
traversal and result ceilings.

Firefox's supported parent/content IPC mechanism is a
[JSWindowActor](https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html).
Actor pairs are scoped to a particular frame and `WindowGlobal`; navigation
destroys the old child actor. That lifetime fits Zen Agent's requirement that
element references become stale after navigation or document replacement.

## Headed result: dedicated actor succeeds

The dedicated actor passed the transport proof on 2026-07-29 against Zen 1.21.9b
/ Gecko 153.0:

1. The extension registered packaged parent and child actor modules through a
   temporary `resource:` substitution. A direct `moz-extension:` module URI was
   rejected first with `System modules must be loaded from a trusted scheme`.
   The resource mapping is removed when the extension shuts down.
2. The privileged parent resolved the explicit stable ID of a loaded HTTP tab in
   the non-visible Space and obtained its actor from that tab's current
   `WindowGlobal`. It never activated the browsing context.
3. The child returned URL, title, document load state, and visible text without
   using page timers. Text traversal stopped at 10,000 text nodes and output
   stopped at the caller's limit, at most 10,000 characters.
4. The 80-character proof result contained the visible fixture text, excluded a
   hidden sentinel, and reported truncation.
5. Selected tab, frontmost application, and Space placement were unchanged.
   Media in the selected tab continued advancing without rewinding.

The accepted surface is `pages.inspect`: a read-only daemon and transport
operation requiring an explicit stable tab ID. Discarded, crashed, non-HTTP(S),
unavailable, and unproven-browser cases fail closed. Page content is returned
only to the requesting client and is still excluded from default logs.

This proved the packaging and background IPC direction. The later full proofs
below cover semantic snapshots, frames, element identity, DOM-only input,
screenshots, explicit file assignment, bounded resources, and media inspection.
Trusted native input and arbitrary evaluation remain unexposed.

## Headed result: semantic interaction succeeds

On 2026-07-29 the expanded proof passed 12/12 three consecutive times against
Zen 1.21.9b / Gecko 153.0 / macOS 27 arm64. Every run used a new throwaway
profile, local HTTP fixtures, and temporary extension and native-host files.

The scenario captured and queried a bounded semantic snapshot in a non-visible
Space, then exercised click, fill, type, press, select, check, uncheck, form
submission, back, and forward. It addressed top-level content, a same-origin
frame, a cross-origin frame, and an open shadow root. Replacing a referenced
element returned `stale-element`; navigating the tab made the prior document
return `stale-document`.

The selected tab and visible Space stayed unchanged. Browser focused-window
state stayed unchanged, Zen never appeared in 100ms frontmost-application
samples, and selected-tab audio continued advancing without rewinding.

## Headed result: background-only workflow capabilities succeed

On 2026-07-29 the expanded 30-test integration suite passed three consecutive
times against Zen 1.21.9b / Gecko 153.0 / macOS 27 arm64. Each run used a new
throwaway profile and asserted the frontmost application, Zen focused-window
state, selected tab, visible Space, cursor coordinates, tab inventory, and
selected-tab playback before and after the scenario.

The accepted additions are bounded current-viewport and explicit-element PNG
capture, geometry and closed-shadow reporting, explicit picker-free file-input
assignment, bounded same-origin resource retrieval, media metadata and caption
extraction, and bounded media-resource retrieval without changing playback.
Static `target=_blank` links report a safe background-routing hint; direct
clicks on those links, download links, and scripted popup controls remain
refused.

The fixture also contains static controls for JavaScript dialogs, notification,
geolocation, microphone, clipboard, WebAuthn, payment, fullscreen, pointer-lock,
and native-file-picker requests. The actor refuses each inline handler before
dispatch. A privileged read-only observer samples open browser-chrome panels,
the Firefox download panel, and browser-window count every 100 ms, while a
read-only WindowServer observer records any newly appearing Zen- or
notification-owned surface. The expanded daemon portion writes a bounded
resource into a throwaway Downloads directory with collision handling,
transcribes captions, and proves same-client temporary cleanup while retaining
changed, untracked, and other-client tabs. If the `en-US` speech asset is
already installed, it also transcribes a locally rendered prerecorded fixture
through the real bundled helper; it never installs an asset during the run.

The final frozen runtime passed those three consecutive headed runs. The
background-only workflow scenario completed all 19 of its assertions in each
run, including real on-device `en-US` transcription on the proven machine.

Gecko permits path-backed `File` creation only in the parent process. The proof
therefore creates opaque `File` objects in the privileged parent and transfers
those objects to the explicit content actor for `mozSetFileArray`. It never
opens a native picker, sends native input, focuses Zen, or discloses a path in
the result.

Tab-scoped dialogs remain unadvertised because no non-blocking background path
has passed this same gate.

## Candidate architecture

1. The privileged extension resolves an explicit stable tab ID.
2. It rejects non-HTTP(S), discarded, crashed, or unavailable tabs.
3. It addresses the tab's `CanonicalBrowsingContext` without activating it.
4. A Zen Agent JSWindowActor child performs bounded read-only inspection,
   creates semantic snapshots, and later performs narrowly named element
   operations inside the content process.
5. The parent keeps snapshot generations and opaque element references. Page
   DOM, URLs, form values, and arguments never enter default logs.
6. Frame identity comes from the browsing-context tree, not DOM position.

```text
daemon request: tab ID + operation
             │
             ▼
privileged extension parent
             │ stable tab → browsing context → frame actor
             ▼
JSWindowActor child in content process
             │
             ▼
HTTP(S) document
```

## Accepted safe surface

The accepted MCP surface includes:

- A semantic snapshot containing roles, accessible names, states, and opaque
  short-lived element references, not full HTML.
- Lookup by role/name, label, text, placeholder, element reference, and explicit
  CSS selector where needed.
- Click, fill, type, press, select, check, and uncheck.
- Wait for load state, URL, text, element, or document change using daemon-side
  timers and MCP-to-daemon cancellation.
- Back, forward, reload, and explicit HTTP(S) navigation.

Every operation is scoped to a stable tab ID, frame ID, snapshot generation, and
deadline.

## Selection-takeover gate

The automated non-interference suite cannot select the agent target as a
positive control: doing so would itself violate the suite's invariant and could
focus Zen or switch the visible Space. Transport observation and daemon lease
revocation therefore have portable contract coverage, but selection takeover
requires a separate, explicitly manual throwaway-profile gate:

1. Start the isolated fixture with one background target leased by a test client
   and record the selected tab, Space, focus, cursor, and mutation count.
2. A human deliberately selects that target once. No agent, extension, script,
   accessibility API, or native event generator performs the selection.
3. Verify the daemon revoked the lease and page references, returned a
   structured terminal `partial` or `blocked` result, and performed no further
   mutation.
4. Verify Zen Agent did not select away, clone the tab, move the cursor, change
   Space, or regain focus after the human action.

Run this three consecutive times on the exact Zen/Gecko/macOS tuple. Until that
manual gate is recorded, selection takeover must not be cited as a headed-proven
capability; the safe fallback remains immediate refusal of mutation whenever the
live target is already selected.

## Deferred from the first surface

- Arbitrary JavaScript evaluation. Named operations cover the product use case
  with a smaller privileged surface.
- Dialog handling until a non-blocking actor path is proven.

The previously deferred screenshot, upload, and bounded resource-download
surfaces are accepted by the expanded proof above. Remaining deferral means “not
exposed,” not an unsafe fallback.

## Risks to prove

- [x] An experiment add-on can register parent and child actor modules from its
      packaged resources on release Zen.
- [x] Actor queries work for a loaded tab in a non-visible Space without
      selecting it.
- [x] DOM interaction does not redirect events to the selected tab.
- [x] Same-origin and cross-origin frames can be enumerated and addressed
      explicitly.
- [x] Open shadow DOM traversal produces snapshot-local references.
- [x] Navigation and DOM replacement return explicit stale errors.
- [x] Waits use daemon timers rather than throttled page timers.
- [x] Result ceilings and cancellation are covered by portable tests.

## Stop condition

If trusted click/type semantics require selecting the tab, or the actor cannot
be packaged without broad page permissions, do not expose the operation.
Reconsider a narrowly scoped page-level transport only if it can attach without
the profile rewriting, permanent badge, startup requirement, and leaked-session
failures that disqualified BiDi as the primary transport.
