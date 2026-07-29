# Browser and Space model

The Zen Agent browser model is a normalized, versioned description of every
profile, browser session, window, Space, tab, browsing context, frame, and
short-lived element that the transport reports. It is the contract shared by the
transport, daemon, CLI, and MCP server.

## Identity

Every identity contains the stable identifier supplied by the browser transport.
Zen Agent never derives identity from a title, URL, visual position, or array
index.

Window, Space, tab, context, frame, and element identities are scoped to a
browser-session identity. A browser restart creates a new session identity even
if the transport reuses the same raw tab identifier. Profile identities are
stable across sessions so a replacement session can be associated with the same
configured profile. Only one browser session may be active for a profile at a
time, matching Zen's profile locking behavior.

Element identities are also tied to the snapshot sequence that produced them.
They are not valid after their page context disappears or crashes.

## Observable state

Transport-dependent fields use an explicit three-way observation:

- `known` contains a value, including meaningful values such as `false` or
  `null`.
- `unknown` records that the value is not currently available.
- `unsupported` records that the active transport cannot supply the capability.

This applies to selected and focused state as well as URLs, titles, loading,
media, container, Space, and private-window state. Selected and focused state is
read-only in this model.

## Snapshots and deltas

`BrowserSnapshot` is a complete normalized registry at a monotonically
increasing sequence number. `BrowserDelta` carries ordered incremental changes
at the same schema version. The registry rejects old sequence numbers,
unsupported schema versions, duplicate snapshot identities, and reuse of an
identity that has already become stale.

The current schema version is `1`.

## Lifecycle and stale identifiers

- Closing an entity makes it and its dependent descendants stale.
- A tab crash preserves the stable tab identity with
  `lifecycleState: "crashed"`, but makes its browsing contexts, frames, and
  elements stale.
- After a reconnect, an identity missing from the new snapshot becomes stale
  with `missing-after-reconnect`.
- After a browser restart, the old session and every session-scoped identity
  become stale with `session-replaced`. The stale record names the replacement
  session when one exists for the same profile.
- An identifier that has never been reported is `missing`, which is distinct
  from a known stale identifier.

These rules let later mutation APIs reject unsafe calls deterministically.

## Multiple profiles and windows

Snapshots use normalized arrays rather than a single nested browser tree.
Sessions refer to profiles, windows refer to both their session-scoped identity
and profile, and all remaining entities refer to their stable parents. This
allows multiple profiles and multiple windows per profile without relying on
ordering.

## Private windows

Private windows are hidden by default. A snapshot that declares the `hidden`
policy may contain only windows known to be non-private; unknown, unsupported,
and known-private windows are rejected. A future explicit opt-in may use the
`explicit` policy, but no current command enables it.
