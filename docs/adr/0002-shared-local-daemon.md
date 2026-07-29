# ADR 0002: Shared local daemon and client protocol

- Status: **Accepted**
- Date: 2026-07-29
- Tracking: [DEV-263](https://linear.app/intuitum/issue/DEV-263)

## Context

The CLI and MCP server must share browser policy and browser state. Connecting
each caller directly to Zen would duplicate registries, permit conflicting
mutations, and open a race in which two agents both decide a tab is missing and
create it. Native Messaging also gives Zen Agent one long-lived connection; it
is not a general multi-client transport.

The daemon is local infrastructure for a user's interactive browser. Its startup
and recovery behavior must not focus Zen, select a tab, switch a Space, or
silently reuse an identity from a previous browser session.

## Decision

Run one daemon per configured Zen profile. The native messaging host process is
the daemon: it owns exactly one active Zen transport, one live
`BrowserRegistry`, and one Unix-domain socket.

Zen starts the daemon when the installed extension opens its native port. CLI
and MCP clients connect to the profile's known socket but never start a second
standalone process, because such a process would have no Native Messaging
connection. When the browser closes the port, that daemon removes its socket and
exits; a reconnect or browser restart launches a replacement host. The exclusive
lock remains authoritative during replacement races.

### Local files and singleton recovery

Runtime files live in an owner-only (`0700`) temporary directory. Profile names
are SHA-256 hashed into short filenames so Darwin's Unix-socket path limit is
respected and profile paths are not disclosed:

- `<profile-hash>.sock`, mode `0600`
- `<profile-hash>.lock`, mode `0600`

Startup creates the lock atomically with `O_CREAT | O_EXCL`. If it exists,
startup probes the socket and checks the recorded PID. A responding socket or
live PID is another daemon and causes an explicit `already-running` error. Only
an unresponsive socket whose owner is gone or invalid is removed as stale. This
makes crash recovery automatic without deleting another process's files.

Filesystem permissions are the local authorization boundary. This is appropriate
for the initial single-user macOS process model; revisit peer authentication if
the socket moves outside the owner-only directory or is ever proxied beyond the
local machine.

### Protocol

The daemon protocol has its own version, independent of the extension/native
host protocol. Every request, response, event, and error carries version 1.
Requests also carry a correlation ID and client ID. Mutations require a
client-scoped idempotency key.

Messages use a four-byte, big-endian UTF-8 byte length followed by one JSON
value. The decoder refuses a declared or encoded payload above 8 MiB before
allocating the body. This avoids newline escaping conventions and gives the
daemon a bounded local-client input.

The initial methods are:

- `health`, `version`, `capabilities`, and `status`
- explicit `config.reload` after an atomic local configuration update
- `registry.entities`, `registry.lookup`, and `registry.refresh`
- read-only, explicit-tab `pages.inspect` with bounded page metadata and visible
  text
- policy-owned `tabs.resolve`, plus explicit-ID `tabs.open`, `tabs.navigate`,
  `tabs.reload`, `tabs.close`, and `tabs.move`
- `daemon.shutdown`

Events report registry sequence changes, connection-state changes, and daemon
shutdown. Errors use stable machine-readable codes.

### Registry and reconnect behavior

Transport sequence numbers are scoped to a transport connection and restart from
one after reconnect. The daemon therefore assigns its own monotonically
increasing sequence to every accepted snapshot or delta. A reconnect snapshot is
passed to `BrowserRegistry.reconcileAfterReconnect`, which marks identities from
a replaced browser session stale instead of reviving them.

Extension lifecycle events update the registry incrementally. Invalid or missed
events trigger a full snapshot, and a periodic snapshot repairs gaps in the
advisory event stream. A closed transport is discarded before reconnecting, so
there is never more than one active transport for the profile.

During initialization or reconciliation the daemon can answer local `health` and
`status` requests without a usable registry. When Zen closes the Native
Messaging port, the production native-host daemon removes its socket and exits;
clients then receive `browser-unavailable` until the extension launches a
replacement process.

### Concurrency and policy boundary

Registry reads do not enter the mutation queue. Browser mutations run through
one FIFO queue, which preserves request order and prevents conflicts while
allowing safe reads to continue. Client-scoped idempotency entries share the
same in-flight promise, preventing a retry from executing twice; reuse of a key
with different parameters is rejected.

Existing-tab mutations require a complete stable model ID. Raw transport IDs and
active-tab fallbacks are rejected. The selected tab and tabs known to be playing
media are rejected again at the browser boundary immediately before mutation.
Opening requires explicit stable window and Space IDs; moving requires an
explicit stable tab and Space ID in the same window. There is no activate or
foreground method.

`tabs.resolve` runs configured Space routing and `TabResolver` inside the
serialized daemon boundary. It always refreshes discovery before choosing,
returns structured `reused`, `opened`, or `ambiguous` results, and opens only in
the background. Routing and tab-resolution policy therefore remain out of the
CLI and MCP adapters.

The native host validates the configuration file at startup when one is present.
The CLI requests `config.reload` only after atomically replacing the default
file; the daemon rejects a reloaded configuration that targets another profile.
A missing file remains a supported first-run discovery state.

### Diagnostics and shutdown

Diagnostics are structured events with an allowlisted scalar context. Current
events record method names, counts, correlation IDs, states, and error codes;
they never record request parameters, returned browser entities, URLs, titles,
or error objects. Log levels are configurable.

Shutdown stops reconciliation and reconnect timers, unsubscribes from the
transport, closes it, drains queued work, closes client sockets, removes the
owned socket and lock, and is idempotent.

## Consequences

Good:

- CLI and MCP callers observe one policy and one registry.
- Zen has one transport owner per profile.
- Browser restarts cannot make old stable IDs valid again.
- Concurrent retries cannot duplicate a mutation.
- Browser absence does not make local diagnostics unavailable.
- Portable protocol and lifecycle tests need no Zen installation.

Costs and follow-up:

- Packaging must install both the extension and Native Messaging host correctly;
  Zen, rather than a standalone service manager, starts and stops the daemon.
- The idempotency cache is bounded and process-local; a daemon crash forgets
  completed keys. Tab resolution must still reconcile before opening so a
  post-crash retry cannot create a duplicate.
- A FIFO profile-wide mutation queue is intentionally conservative. Per-tab
  queues may improve throughput after leases and optimistic versions are
  defined, but must preserve cross-tab resolution atomicity.
- A future eager launcher cannot replace Zen's Native Messaging startup path;
  packaging may add diagnostics or prompting, but the browser-provided port
  remains the transport authority.
- Reload is an explicit stable-tab mutation through the daemon and native
  transport; there is no active-tab or foreground fallback.
- The first read-only `pages.inspect` slice has explicit traversal, output, and
  deadline ceilings. Semantic snapshots and element operations still require
  document-generation identity, cancellation, and operation-specific limits
  before they are added.

## Validation

Portable tests cover split/coalesced frames, version and size refusal, socket
and lock permissions, singleton startup, stale crash recovery, correlation,
events, graceful shutdown, concurrent reads, serialized mutations, idempotency,
connection retry, session replacement, stale-ID rejection, sequence
normalization, and diagnostic redaction.
