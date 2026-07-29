# Shared daemon

Zen Agent runs one local daemon for each connected Zen profile. The daemon and
the Native Messaging host are the same process.

```text
Zen extension
    │ Native Messaging port
    ▼
native-host daemon
    ├── one Zen transport
    ├── live browser registry
    ├── routing and tab-resolution policy
    ├── serialized mutation queue
    └── owner-only Unix socket
             ▲
             ├── zen-agent setup CLI
             └── zen-agent-mcp
```

There is intentionally no `zen-agent daemon start` command. Zen starts the
process when the privileged extension calls `runtime.connectNative`. Starting
the JavaScript host from a terminal would not give it a Native Messaging port
and would create a second, unauthoritative transport owner.

## Lifecycle

1. The extension opens the installed Native Messaging host.
2. The host loads the optional validated configuration and verifies the exact
   Zen and Gecko build and required capabilities.
3. It takes an initial snapshot, obtains the profile directory leaf name, and
   refuses a configuration targeting another profile.
4. It acquires an exclusive per-profile lock and publishes the per-profile
   socket.
5. Setup CLI and MCP clients use the configured profile, or discover the socket
   when exactly one profile daemon is active.
6. When Zen closes the native port, the process closes clients, removes its
   socket and lock, and exits. The extension reconnect loop can launch a
   replacement host.

Browser session IDs are connection-scoped. After a replacement transport
connects, the registry marks previous session identities stale instead of
reviving them.

## Runtime files

The daemon creates a short owner-only directory under the operating system's
temporary directory. The current macOS shape is:

```text
${TMPDIR}/zen-agent-<uid>/<profile-hash>.sock
${TMPDIR}/zen-agent-<uid>/<profile-hash>.lock
```

The directory is mode `0700`; socket and lock are mode `0600`. The filename
contains a truncated SHA-256 hash rather than a profile name or path, both to
avoid disclosure and to stay under Darwin's Unix-socket path limit.

An existing responsive socket or live lock owner causes an `already-running`
refusal. Only an unresponsive socket whose recorded owner is gone or invalid is
treated as stale and removed.

With no configuration, a client may connect automatically only when exactly one
profile socket is published. More than one is `ambiguous-profile`, not an
invitation to choose the newest, focused, or visually active profile. Once
configuration names a profile, its socket path is deterministic.

## Client protocol

The local daemon protocol is versioned independently from Native Messaging.
Messages are an 8 MiB-bounded JSON value framed by a four-byte big-endian byte
length. Requests carry a correlation ID and client ID; mutations also carry an
idempotency key.

The public adapters use:

- health, version, capabilities, and sanitized status;
- explicit configuration reload after an atomic default-file update;
- registry entity listing and exact stable-ID lookup;
- read-only `pages.inspect` for bounded metadata and visible text from one
  explicitly identified loaded HTTP(S) tab;
- shared tab resolution;
- explicit open, navigate, reload, close, and move mutations.

There is no active-tab shorthand or activation method. Reads bypass the mutation
queue. Mutations enter one FIFO queue so two clients cannot race through
discovery and creation.

`pages.inspect` is capped at 10,000 visible-text characters and 10,000 visited
text nodes, has bounded metadata and an 8-second parent deadline, and fails
closed for discarded, crashed, unavailable, non-HTTP(S), or unsupported tabs.
Its returned page content goes only to the requesting client and never enters
default diagnostics. The setup CLI intentionally exposes no page operations, and
the current MCP adapter does not yet expose this daemon method.

See [ADR 0002](adr/0002-shared-local-daemon.md) for the complete protocol and
reconnect rationale.

## Diagnostics

Daemon diagnostics are allowlisted structured events written away from the
Native Messaging stdout wire. They may include method names, counts, correlation
IDs, connection states, and error codes. Request parameters, returned browser
entities, URLs, titles, cookies, form values, tokens, and arbitrary error
objects are excluded by default.

Use `zen-agent status --json` as the first diagnostic. It reports sanitized
connection and registry state without touching browser content or changing
visible browser state.
