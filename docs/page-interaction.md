# Background page interaction

Zen Agent's page-interaction surface lets an MCP client understand and operate
an explicitly identified HTTP(S) tab without selecting it, switching its Space,
or focusing Zen. The architecture is implemented behind capability checks,
portable contract tests, and the accepted headed safety proof in
[ADR 0005](adr/0005-background-page-interaction.md).

The CLI remains limited to setup, configuration, and diagnostics. Page
automation is available only through MCP, with the shared daemon enforcing
identity, ownership, leases, and browser policy.

## Interaction model

A client first captures a semantic snapshot for a full stable tab ID. The
snapshot is separate from the browser-discovery snapshot and includes:

- a top-level document generation and snapshot ID;
- opaque frame and element references;
- roles, accessible names, visible text, semantic state, and action hints; and
- explicit truncation flags for frames, nodes, strings, and total bytes.

Snapshots include the current frame tree, including frames the parent can reach
through separate window actors. An unavailable or unsupported frame is modeled
as such instead of being silently omitted or searched through a foreground
fallback. Open shadow-root content participates in semantic traversal; closed
shadow roots remain outside the observable surface and are reported as closed.
Semantic nodes also include bounded viewport geometry for explicit visual
targeting.

A client can then query one explicit frame using a role and optional accessible
name, label, visible text, placeholder, CSS selector, or existing element
reference. Queries return zero, one, or several explicit references. A caller
must resolve ambiguity rather than asking Zen Agent to guess.

Page content is returned only to the requesting client. It does not enter the
global browser registry, browser delta stream, or default logs.

## Stable targeting and stale references

An element operation carries the complete target tuple:

```text
tab ID + document ID + snapshot ID + frame reference + element reference
```

The daemon scopes snapshots and their references to the MCP connection that
created them. Copying an opaque reference to another client does not transfer
ownership.

The transport validates the target again immediately before an operation:

- `stale-document` means the top-level tab navigated or was replaced;
- `stale-frame` means the target frame detached or changed document; and
- `stale-element` means the snapshot expired or the referenced node was
  disconnected or replaced.

Unrelated DOM changes do not automatically invalidate every reference. A caller
should take a new snapshot and resolve a new target after any stale-reference
error; Zen Agent does not retry against a replacement document.

## Leases and concurrent clients

Semantic snapshots and queries are read-only and do not require a lease. Every
page mutation requires an exclusive, bounded lease on the stable tab ID. This
includes click, fill, type, press, select, check, uncheck, submit, back, and
forward.

Leases are owned by one daemon client, have an explicit expiry, and can be
acquired, renewed, or released. Acquisition is bounded FIFO; reacquiring from
the same client is idempotent and does not silently extend the deadline. There
is no force or implicit-takeover path. Existing tab move, navigation, reload,
and close operations also refuse a tab leased by another client.

Mutations are FIFO per tab, so agents operating on unrelated tabs do not block
one another. Queue and ownership ceilings bound pending work. Selecting a
mutation target is user takeover: its lease and page references are revoked,
pending work stops, and the operation returns a structured blocker. Zen Agent
never selects away from the tab or clones it.

Closing an MCP stdio connection or daemon socket releases that client's leases
and page-reference ownership. Lease expiry is the crash fallback, not a normal
handoff mechanism.

Read-only operations remain available for a relevant tab that is playing media.
Mutations of that playing target are refused. Selected or playing tabs unrelated
to the explicit target do not block another agent.

## Input semantics

Page operations run inside the dedicated packaged page actor. They use DOM
methods and DOM events against the explicitly resolved node:

- click;
- replace or append an input value;
- dispatch a key press with explicit modifier state;
- select one or more options when the control permits it;
- check or uncheck a compatible control; and
- submit the target form or its owning form.

No operation uses native OS input, focuses a page element, activates a browsing
context, selects a tab, focuses a Zen window, or switches the visible Space.
This preserves the background-only design, but it also means the events are not
trusted native user input. Websites that require trusted events or activation
are unsupported; Zen Agent does not work around them by foregrounding the tab.

Back and forward are also explicit document-scoped mutations. A successful
operation reports the generation on which it was attempted; navigation may
replace that generation immediately afterward.

## Waits and cancellation

`zen_page_wait` polls semantic snapshots with daemon timers. It does not use
content timers or `requestAnimationFrame`, which can be throttled in a
non-visible Space. Conditions cover load state, exact or containing URL, visible
text presence or absence, locator attachment, visibility and enabled state, and
top-level document-generation changes.

Timeouts are bounded to 60 seconds and polling intervals to 100 through 2,000
milliseconds. Cancelling the MCP request sends a client-scoped cancellation to
the daemon operation; disconnecting the client, losing the browser transport, or
stopping the daemon also cancels its waits. A matched wait returns and owns a
fresh semantic snapshot so the caller can act on its references.

## Bounds and lifetime

The transport validates bounds on both sides of the native boundary:

| Resource                     | Current ceiling                      |
| ---------------------------- | ------------------------------------ |
| Semantic nodes               | 5,000 per snapshot; 1,000 by default |
| Frames                       | 128 per snapshot                     |
| Query results                | 100 per query; 20 by default         |
| Strings                      | 64 KiB characters each               |
| Serialized snapshot result   | 4 MiB                                |
| Live snapshots               | 16 per tab in the extension          |
| Daemon-owned snapshots       | 64 per client; 256 per session       |
| Extension reference lifetime | 60 seconds                           |
| Page actor operation         | 8 seconds                            |
| Page wait                    | 60 seconds                           |

Truncation is data, not success-by-omission. A snapshot reports which limit it
hit. Requests outside the accepted range and results outside the validated
contract fail closed.

## Visual, file, and media operations

`zen_page_screenshot` returns a bounded PNG for the current viewport or one
explicit element rectangle. Capture happens through the parent-process document
snapshot API. The bytes are returned only to the requesting MCP client and are
not persisted or logged.

`zen_page_upload` accepts explicit absolute paths and a live
`<input type="file">` reference. The daemon safely stages bounded regular files
using no-follow opens and opaque owner-only paths, then releases them with the
lease, tab, client, or daemon. Symlinks, directories, devices, stale elements,
and oversized requests are rejected. No native picker is opened and paths stay
out of logs and mutation results.

`zen_page_download` performs a bounded, credentialed, same-origin HTTP(S)
resource fetch through the target page and writes it atomically to the
configured Downloads directory. Filenames are collision-safe and never overwrite
an existing file. Redirects, cross-origin resources, browser-managed downloads,
POST bodies, blobs, click-generated downloads, save-as, and PDF UI are
unsupported.

`zen_page_media_list` reads bounded audio/video state and exposed caption tracks
without changing playback. `zen_page_media_transcribe` uses available caption
cues first. Otherwise it retrieves a bounded accessible, non-DRM media resource
and invokes the bundled macOS on-device speech helper. The workflow does not
capture system audio, pause, seek, mute, restart, or select the media tab.
Missing assets, unsupported locales, DRM, and inaccessible media are terminal
blockers; model assets are downloaded only by explicit CLI setup.

Agent-created tabs can be marked `temporary`. The daemon records client
provenance and closes one only through `zen_tabs_cleanup` when ownership is
still unambiguous and the tab was not reused, selected, playing, or changed.
Final result tabs are retained by default. Disconnects and crashes leave tabs
open.

## Capability and proof status

Every operation has a separate advertised transport capability. An unavailable
capability produces an explicit error; no operation falls back to selecting the
tab or using a remote-control session.

Portable tests cover message validation, bounded results, capability refusal,
stale targets, lease ownership, cancellation, and client cleanup. Three
consecutive headed runs on the exact allowlisted Zen/Gecko/macOS build prove
that semantic snapshots and DOM interaction do not change:

- the selected tab;
- the visible Space;
- the frontmost application or Zen window focus; or
- playback in the user's selected tab.

The proof covers top-level, same-origin, cross-origin, and open shadow-root
content plus element replacement and navigation. Portable tests cover hostile
result bounds, waits, cancellation, and multiple-client contention. ADR 0005 is
**Accepted** for the named operations on Zen 1.21.9b / Gecko 153.0 / macOS 27
arm64.

## Deliberately unsupported

Tab dialogs are not exposed on the current transport because a safe,
non-blocking observation path has not passed the headed gate. Window-modal
dialogs, authentication windows, client certificates, native pickers,
camera/microphone, geolocation, clipboard, WebAuthn, payments, fullscreen,
pointer lock, notification permission, arbitrary popups, trusted native input,
privileged schemes, and arbitrary JavaScript evaluation are unsupported.

Static HTTP(S) links with `target=_blank` are reported with an `open-background`
hint and bounded destination so the calling agent can route them through the
existing safe tab resolver; DOM click remains refused. Arbitrary `window.open`
remains unsupported. Rich editors, canvas hit testing, drag-and-drop, IME,
clipboard, hover-only interactions, trusted-event checks, and
user-activation-gated sites are terminal unsupported cases.
