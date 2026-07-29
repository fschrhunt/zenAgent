# MCP server

Zen Agent includes a local stdio MCP server that is a thin adapter over the
shared daemon. It never connects to Zen or the native host directly.

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

## Tools

| Tool                | Behavior                                                       |
| ------------------- | -------------------------------------------------------------- |
| `zen_status`        | Reads sanitized daemon and browser status                      |
| `zen_capabilities`  | Reads detected background-safe transport capabilities          |
| `zen_spaces_list`   | Lists known Spaces and their stable IDs                        |
| `zen_tabs_list`     | Lists known tabs, optionally restricted to one stable Space ID |
| `zen_tabs_resolve`  | Reuses a safe match or opens one background tab                |
| `zen_tabs_open`     | Opens one background tab in an explicit window and Space       |
| `zen_tabs_navigate` | Navigates one explicitly identified background tab             |
| `zen_tabs_reload`   | Reloads one explicitly identified background tab               |
| `zen_tabs_close`    | Closes one explicitly identified tab                           |

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

All mutation tools accept an optional `idempotencyKey`. Supply the same
non-empty key when retrying the same operation. When omitted, the adapter
generates a unique key for the call.

## Safety

The MCP server has no approval wrapper. MCP clients decide how to present or
approve tool calls using the protocol annotations and descriptions.

Zen Agent itself still enforces its product invariants:

- it discovers before resolving or opening;
- it addresses tabs by stable ID;
- it returns ambiguity and stale-ID errors instead of guessing;
- it never focuses Zen, selects a tab, or switches the visible Space.

Opening, resolving, navigating, and reloading can make network requests. Closing
is destructive and can discard unsaved page state. The tool annotations describe
these effects.

The shared daemon has a bounded, read-only `pages.inspect` method, but this MCP
adapter does not yet register a page-inspection tool. Semantic snapshots and
element interaction remain unimplemented. The adapter does not bypass the daemon
to add either surface.

Closing the MCP stdio connection closes the adapter's daemon client socket. It
does not shut down the shared daemon or Zen.

The current source extension and browser support remain prototype-scoped. See
[compatibility and current limits](compatibility.md), including the production
dependency pins and audit status.
