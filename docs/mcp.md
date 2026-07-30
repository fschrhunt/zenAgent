# MCP server

Zen Agent includes a local stdio MCP server that is a thin adapter over the
shared daemon. It is the sole public browser automation interface; the
`zen-agent` CLI is reserved for setup, configuration, and diagnostics. The MCP
server never connects to Zen or the native host directly.

## Configure a client

Build the package, ensure Zen has launched the native-host daemon, and configure
the MCP client to spawn:

```json
{
  "mcpServers": {
    "zen-agent": {
      "command": "zen-agent-mcp"
    }
  }
}
```

The packaged executable is `dist/mcp.js`. It uses the profile in the validated
Zen Agent configuration. When no configuration exists, it may discover exactly
one active profile daemon; multiple active profiles are an explicit ambiguity.
It writes MCP protocol messages only to stdout; startup failures go to stderr.
The protocol advertises `Zen Agent` as its human-facing title and `zen-agent` as
its stable implementation identifier. Clients that support MCP titles should
display the former; the executable and configuration key remain machine-safe.

## Tools

| Tool                        | Behavior                                                       |
| --------------------------- | -------------------------------------------------------------- |
| `zen_status`                | Reads sanitized daemon and browser status                      |
| `zen_capabilities`          | Reads detected background-safe transport capabilities          |
| `zen_spaces_list`           | Lists known Spaces and their stable IDs                        |
| `zen_tabs_list`             | Lists known tabs, optionally restricted to one stable Space ID |
| `zen_page_inspect`          | Reads bounded page content from one explicit stable tab        |
| `zen_page_snapshot`         | Captures a bounded semantic snapshot and element references    |
| `zen_page_screenshot`       | Returns a bounded background viewport or element PNG           |
| `zen_page_query`            | Queries one frame of a still-live semantic snapshot            |
| `zen_page_media_list`       | Lists bounded media, playback, DRM, and caption metadata       |
| `zen_page_wait`             | Waits for a bounded page condition with parent-side timers     |
| `zen_tab_lease_acquire`     | Acquires exclusive, bounded page-mutation ownership            |
| `zen_tab_lease_renew`       | Extends a tab lease owned by this MCP session                  |
| `zen_tab_lease_release`     | Releases a tab lease owned by this MCP session                 |
| `zen_page_click`            | Clicks one explicit live element reference                     |
| `zen_page_fill`             | Replaces one explicit editable element's value                 |
| `zen_page_type`             | Appends text to one explicit editable element                  |
| `zen_page_press`            | Dispatches one targeted key operation without native input     |
| `zen_page_select`           | Sets explicit values on one referenced select element          |
| `zen_page_check`            | Sets one checkbox, radio, or switch to checked                 |
| `zen_page_uncheck`          | Sets one checkbox reference to unchecked                       |
| `zen_page_submit`           | Submits the form associated with an explicit element           |
| `zen_page_upload`           | Assigns explicit regular files without opening a native picker |
| `zen_page_media_transcribe` | Uses captions or bounded on-device speech transcription        |
| `zen_page_download`         | Streams a bounded same-origin resource to Downloads            |
| `zen_page_back`             | Navigates a leased tab back with a document precondition       |
| `zen_page_forward`          | Navigates a leased tab forward with a document precondition    |
| `zen_tabs_resolve`          | Reuses a safe match or opens one background tab                |
| `zen_tabs_open`             | Opens one background tab in an explicit window and Space       |
| `zen_tabs_navigate`         | Navigates one explicitly identified background tab             |
| `zen_tabs_reload`           | Reloads one explicitly identified background tab               |
| `zen_tabs_close`            | Closes one explicitly identified tab                           |
| `zen_tabs_cleanup`          | Keeps or conservatively closes one owned temporary tab         |

Tool input and output schemas are strict. Every result has one of these stable
envelopes:

```json
{ "ok": true, "result": {} }
```

```json
{
  "ok": false,
  "error": {
    "code": "stale-id",
    "message": "The stable tab ID is no longer active."
  }
}
```

Daemon errors retain their stable code, sanitized message, and optional
scalar-only data. Unexpected adapter failures become a generic `internal` error;
stack traces and page content are not returned.

`zen_page_inspect` requires a stable `tabId` and accepts an optional `maxChars`
from 1 through 10,000. It returns the page URL, title, load state, bounded
visible text, whether that text was truncated, and the number of visited text
nodes. Page content appears only in the tool response; the adapter does not log
or retain it. Page tools place content in structured output and use only a short
fixed text summary, avoiding a second serialized copy of page content.

`zen_page_snapshot` returns bounded frames and semantic nodes with short-lived
opaque document, snapshot, frame, and element references. Snapshots contain at
most 5,000 nodes and 128 frames; references expire after 60 seconds.
`zen_page_query` searches one referenced frame by role and accessible name,
label, visible text, placeholder, CSS selector, or explicit element reference,
returning at most 100 nodes. An agent must handle multiple matches explicitly
rather than assuming the first match.

`zen_page_wait` polls with daemon timers rather than page timers, so a
non-visible Space cannot throttle the wait itself. It supports load state, exact
or containing URL, visible text presence or absence, locator attachment,
visibility and enabled state, and document-generation changes. The timeout is
bounded to 60 seconds and cancellation from the MCP request is forwarded to the
daemon operation.

Page mutations require an exclusive tab lease owned by the current MCP session.
Acquire accepts a stable `tabId`; acquire and renew accept an optional `ttlMs`
from 1,000 through 300,000 milliseconds. Acquire also accepts bounded `waitMs`
for cancellable FIFO waiting. Leases default to 30 seconds and are also released
when the MCP connection closes. There is no implicit takeover. Every element
mutation carries the stable tab ID, document ID, snapshot ID, frame reference,
element reference, and lease ID. Back and forward carry the stable tab ID,
document ID, and lease ID. Replaced documents, frames, and elements return
explicit stale-reference errors rather than retargeting an operation. After a
client captures a newer snapshot for a tab, older snapshots remain readable but
cannot be used for a mutation.

Existing-tab mutation tools accept an optional `expectedRegistrySequence` from
`zen_tabs_list` or `zen_status`. When supplied, the daemon compares it inside
the tab's FIFO queue immediately before acting. A mismatch returns
`registry-version-conflict` with `performed: false`; refresh and replan rather
than replaying the request.

Mutation tools accept or internally receive an idempotency key. Supply the same
non-empty key when retrying the exact same operation. When omitted, the adapter
generates a unique key for the call. A stale mutation is never replayed or
redirected: take a fresh snapshot, resolve the semantic target again, and
re-evaluate intent.

Screenshot image bytes are emitted once as MCP image content and once in the
strict structured result required by the tool contract; they are not logged or
persisted. Upload paths are explicit on every call but are not echoed. Downloads
use the configured directory, defaulting to `~/Downloads`, and never overwrite
an existing file. Media transcription does not change playback and does not use
cloud or system-audio capture.

Tabs opened or resolved with `temporary: true` carry same-client provenance.
`zen_tabs_cleanup` closes only a still-unmodified, unselected, non-playing
temporary tab. An untracked, reused, changed, selected, playing, or ambiguous
tab is retained. The useful result tab should be kept.

## Safety

The MCP server has no approval wrapper. MCP clients decide how to present or
approve tool calls using the protocol annotations and descriptions.

Zen Agent itself still enforces its product invariants:

- it discovers before resolving or opening;
- it addresses tabs by stable ID;
- it returns ambiguity and stale-ID errors instead of guessing;
- it never focuses Zen, selects a tab, or switches the visible Space.

Opening, resolving, navigating, reloading, and page interaction can make network
requests. Click, submit, history navigation, and close can be destructive. Form
values supplied to fill, type, and select are not echoed in mutation results.
The tool annotations describe these effects.

The adapter exposes only capability-gated operations implemented by the shared
daemon. It does not bypass the daemon, expose arbitrary JavaScript evaluation,
or add foreground fallbacks. Dialogs, native pickers, browser permission UI,
authentication windows, arbitrary popups, notification APIs, and trusted input
remain outside this MCP surface.

The server emits no progress notifications. Calling agents release leases and
report exactly one terminal workflow outcome: `completed`, `partial`, or
`blocked`, with the verified result, retained result-tab ID, cleanup result, and
required user action. This is an agent convention rather than a task-completion
tool.

Closing the MCP stdio connection closes the adapter's daemon client socket. It
does not shut down the shared daemon or Zen.

The current source extension and browser support remain prototype-scoped. See
[compatibility and current limits](compatibility.md), including the production
dependency pins and audit status.
