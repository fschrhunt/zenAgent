# ADR 0005: Background page interaction through MCP

- Status: **Accepted**
- Date: 2026-07-29
- Scope: semantic page snapshots, element identity, input, and MCP ownership

## Context

Zen Agent can already discover, route, navigate, inspect, reload, and close an
explicit background tab without focusing Zen, selecting a tab, switching the
visible Space, or interrupting selected-tab media. The dedicated `JSWindowActor`
also returns bounded metadata and visible text from a loaded HTTP(S) document in
a non-visible Space.

Agents still cannot understand a page semantically or interact with its
elements. Adding those operations creates three new identity boundaries:

- a tab can navigate while an agent is deciding what to do;
- a frame or element can be replaced without closing the tab; and
- several MCP clients can operate against the same daemon concurrently.

ADR 0004 made MCP the only agent-facing browser automation surface. The CLI is a
setup, configuration, and diagnostic utility and must not become a second
page-operation client.

## Decision

### Keep the dedicated actor transport

Continue using Zen Agent's privileged extension and dedicated `JSWindowActor`.
The extension parent resolves the caller's explicit stable tab ID, enumerates
its `CanonicalBrowsingContext` tree, and queries one actor for each current
`WindowGlobal`. It never activates a browsing context.

Do not introduce BiDi for page interaction. Its startup requirement, profile
preference rewriting, permanent remote-control indicator, and leaked-session
failure remain incompatible with a daily-use browser.

### Use a separate page snapshot contract

`PageSnapshot` is versioned independently from the complete browser-discovery
`BrowserSnapshot`. It contains:

- an explicit stable tab ID;
- opaque top-level document, snapshot, frame, and element references;
- bounded semantic roles, accessible names, visible text, state, and action
  hints;
- deterministic truncation metadata.

Page content does not enter the global `BrowserRegistry` or its event stream.
The daemon retains only bounded ownership and generation metadata. Returned page
content is delivered to the requesting MCP client and is not logged.

### Scope references to an MCP client and document generation

Every page snapshot and element reference belongs to the daemon `clientId` of
one `zen-agent-mcp` connection. Another MCP client cannot reuse copied opaque
references.

An element mutation requires:

- the full stable tab ID;
- a lease owned by the calling client;
- the current top-level document generation;
- the originating snapshot ID;
- the frame and element references;
- an idempotency key.

Top-level navigation returns `stale-document`; frame navigation or replacement
returns `stale-frame`; a disconnected or expired node returns `stale-element`.
Unrelated DOM mutations do not invalidate every element in a snapshot.

### Use exclusive, bounded tab leases

Reads remain lease-free. Page mutations require one exclusive lease per tab.
Existing navigate, reload, close, and move operations refuse a tab leased by
another client.

Leases have bounded TTLs and explicit acquire, renew, and release methods. An
MCP stdio or daemon socket close releases that client's leases, snapshots,
waits, and cancellation state immediately. TTL is the crash fallback. Browser
restart, session replacement, tab close, and tab crash invalidate affected
state.

There is no implicit takeover or force option.

### Use parent-side waits and end-to-end cancellation

Waits poll frame actors from the privileged parent or daemon with bounded
intervals. They do not depend on content `requestAnimationFrame` or content
timers, which can stop in a non-visible Zen Space.

Cancellation flows from the MCP request signal through the daemon operation ID
and transport request ID to the parent-side operation. Client disconnect,
navigation, tab close, frame detach, reconnect, timeout, and daemon shutdown
cancel affected waits.

### Capability-gate each interaction

Expose one MCP tool per proven operation so annotations and side-effect text are
exact. The planned named operations are semantic snapshot and query, wait,
click, fill, type, press, select, check, uncheck, submit, back, and forward.

Dialogs, downloads, uploads, and screenshots are separate capabilities. They
remain absent from MCP until their own path preserves every product invariant.
Arbitrary JavaScript evaluation remains unexposed.

## Input safety gate

Before accepting this ADR, headed tests must prove that the chosen click, fill,
type, and press primitives target a loaded document in a non-visible Space
without:

- selecting its tab;
- switching the visible Space;
- focusing Zen or changing the frontmost macOS application;
- redirecting input to the selected tab;
- interrupting selected-tab media; or
- foregrounding a popup or new window.

Native OS input synthesis is prohibited. If reliable input requires activation
or focus, omit that operation rather than add a foreground fallback.

Every accepted capability must pass three consecutive headed runs on each exact
supported Zen/Gecko/macOS build.

## Consequences

Good:

- MCP is the single browser automation contract.
- Page content is isolated from global discovery state and diagnostics.
- Stale documents, frames, and elements fail explicitly.
- Concurrent agents cannot mutate one another's leased tabs.
- The transport remains attached to an already-running daily-use Zen without a
  remote-control session.

Costs:

- Page state needs bounded per-client lifetime management in the daemon and
  actor.
- Cross-origin frames require parent aggregation across multiple actors.
- MCP disconnect must become a first-class daemon lifecycle event.
- Every interaction primitive needs portable contract tests and headed safety
  evidence before registration.

## Stop conditions

Do not expose an operation when:

- it requires selecting or focusing the target;
- its target cannot be tied to the caller's tab, document, frame, and snapshot;
- cancellation or timeout can redirect a retry to a replacement document;
- its result or error path cannot keep page content and secrets out of logs; or
- the exact Zen/Gecko build has not passed the headed proof.

## Validation required for acceptance

- Semantic snapshots across top-level, same-origin, cross-origin, and open
  shadow-root content.
- Stale document, frame, element, expiry, disconnect, crash, and reconnect
  cases.
- Multiple MCP clients contending for one tab and operating independently on
  different tabs.
- Bounded hostile-page, timeout, cancellation, and idempotent retry cases.
- The complete headed invariant proof around snapshot, query, input, wait,
  navigation, and cleanup.

## Acceptance evidence

On 2026-07-29 the current implementation passed three consecutive headed runs on
Zen 1.21.9b / Gecko 153.0 / macOS 27 arm64. Each run used a new throwaway
profile and temporary extension/native-host installation.

The proof exercised semantic snapshot and query, click, fill, type, press,
select, check, uncheck, form submission, back, and forward in a non-visible
Space. It covered top-level content, a same-origin frame, a cross-origin frame,
an open shadow root, replaced elements, and replaced documents. Throughout the
cycle:

- the selected tab and visible Space were unchanged;
- Zen never became the sampled frontmost macOS application;
- browser focused-window state was unchanged; and
- audio in the selected tab advanced without rewinding.

Portable tests separately cover lease contention, client-scoped snapshot
ownership, bounded waits, MCP-to-daemon cancellation, disconnect cleanup,
timeouts, strict schemas, idempotent retries, and hostile result ceilings.
Dialogs, downloads, uploads, screenshots, trusted native input, and arbitrary
JavaScript remain outside this accepted surface.
