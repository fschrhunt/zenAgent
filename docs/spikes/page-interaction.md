# Background page interaction: implementation direction

- Status: Dedicated Zen Agent JSWindowActor accepted for the first bounded,
  read-only inspection slice
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

This proves the packaging and background IPC direction. It does **not** prove
semantic snapshots, frames, element identity, trusted input, screenshots, or
arbitrary evaluation; those remain unexposed.

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

## Planned safe surface

The first headed spike implemented only URL, title, load state, and bounded
visible text inspection. The next iterations may add:

- A semantic snapshot containing roles, accessible names, states, and opaque
  short-lived element references, not full HTML.
- Lookup by role/name, label, text, and explicit selector where needed.
- Click, fill, type, press, select, check, and uncheck.
- Wait for load state, URL, text, or element using daemon/parent-side timers.
- Back, forward, reload, and explicit HTTP(S) navigation.

Every operation is scoped to a stable tab ID, frame ID, snapshot generation, and
deadline.

## Deferred from the first surface

- Arbitrary JavaScript evaluation. Named operations cover the product use case
  with a smaller privileged surface.
- Screenshots over this transport. BiDi proved a non-selected capture, but the
  chosen extension transport must independently pass a headed compositor test.
- Uploads and downloads until path boundaries and status semantics are defined.
- Dialog handling until a non-blocking actor path is proven.

Deferral means “not exposed,” not an unsafe fallback.

## Risks to prove

- [x] An experiment add-on can register parent and child actor modules from its
      packaged resources on release Zen.
- [x] Actor queries work for a loaded tab in a non-visible Space without
      selecting it.
- DOM activation or synthesized input does not redirect events to the selected
  tab.
- Cross-origin frames can be enumerated and addressed explicitly.
- Shadow DOM traversal preserves encapsulation and produces stable-enough
  snapshot-local references.
- A navigation between resolution and operation returns stale-element or
  stale-frame, never an operation against the replacement document.
- Background timer throttling does not break waits. Polling must be scheduled by
  the daemon or parent process rather than relying on page timers.
- Result ceilings and cancellation work for large or hostile documents.

## Stop condition

If trusted click/type semantics require selecting the tab, or the actor cannot
be packaged without broad page permissions, do not expose the operation.
Reconsider a narrowly scoped page-level transport only if it can attach without
the profile rewriting, permanent badge, startup requirement, and leaked-session
failures that disqualified BiDi as the primary transport.
