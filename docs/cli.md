# CLI reference

The `zen-agent` CLI is a thin client of the shared per-profile daemon. It does
not open a Native Messaging connection, inspect the focused tab, or start a
second daemon. Zen must already have launched the native-host daemon for the
configured profile.

When no configuration exists, the CLI discovers exactly one active profile
daemon. More than one returns `ambiguous-profile`; it never chooses by focus or
recency. Use `spaces list`, then `config map` with the returned opaque IDs to
complete first-run setup. See
[configuration](configuration.md#first-run-bootstrap).

Run the built executable:

```sh
npm run build
node dist/cli.js --help
```

An installed package exposes the same command as `zen-agent`.

## Commands

| Command                 | Behavior                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `status`                | Report sanitized daemon, profile, session, and registry-count state       |
| `spaces list`           | List discovered Spaces and opaque stable IDs                              |
| `tabs list`             | List discovered tabs, optionally filtered by an opaque Space ID           |
| `tabs resolve`          | Reuse a safe URL/query match or open one background tab                   |
| `tabs open`             | Resolve an absolute URL, reusing a safe exact match when one exists       |
| `tabs navigate`         | Navigate one explicitly identified tab to an HTTP(S) URL                  |
| `tabs reload`           | Reload one explicitly identified tab                                      |
| `tabs close`            | Close one explicitly identified tab                                       |
| `config map`            | Validate discovered IDs and atomically update Space mappings              |
| `native-host install`   | Install the per-user macOS launcher and Native Messaging manifest         |
| `native-host uninstall` | Remove only a launcher and manifest recognisably created by the installer |

There is no foreground, activate, select, or “current tab” command.

`tabs open` and `tabs resolve` share the safe resolver. Despite the shorter
name, CLI `tabs open` does not force a duplicate when the exact URL is already
open in the chosen Space. The MCP tool `zen_tabs_open` is the lower-level
always-create operation and requires explicit stable window and Space IDs.

## Common examples

```sh
zen-agent status
zen-agent spaces list
zen-agent tabs list --json
zen-agent tabs resolve https://example.com/ --space work --explain
zen-agent tabs navigate '<opaque-tab-id>' https://example.com/next
zen-agent tabs reload '<opaque-tab-id>'
zen-agent tabs close '<opaque-tab-id>'
```

URLs supplied for creation or navigation must be absolute HTTP(S) URLs.
Privileged schemes such as `file:`, `data:`, and `javascript:` are refused. A
free-text `tabs resolve` query searches currently known tab titles and URLs; it
returns `not-found` rather than turning the query into a URL or opening a search
page.

`--space` accepts a configured role or alias for resolution, or the opaque ID
printed by `spaces list`. `tabs list --space` intentionally accepts only an
opaque ID, which prevents a stale or misspelled alias from silently changing the
filter.

## Opaque IDs and stale sessions

Human output represents tab and Space IDs as strings beginning with `zen:`. They
encode the entity kind, profile, browser session, and transport identity. Treat
the complete value as opaque: do not decode it, splice it, or persist it as a
long-lived bookmark.

IDs survive a tab moving between Spaces, but a browser restart creates a new
session and makes every old tab, window, and Space reference stale. List
entities again after reconnecting. A stale reference returns an explicit error;
Zen Agent never substitutes the selected tab.

## Output

Human-readable output is intended for terminals. `--json` emits one stable
envelope to stdout:

```json
{
  "ok": true,
  "command": "status",
  "result": {}
}
```

Errors in JSON mode use:

```json
{
  "ok": false,
  "error": {
    "code": "browser-unavailable",
    "message": "The Zen Agent daemon is not available."
  }
}
```

Without `--json`, errors go to stderr. Browser metadata may be returned by
explicit list commands, but URLs, titles, form values, and tokens are excluded
from default diagnostics.

## Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | Success                                            |
| 1    | Unexpected internal failure                        |
| 2    | Invalid command, option, configuration, or payload |
| 3    | Ambiguous routing or tab resolution                |
| 4    | Stale stable ID                                    |
| 5    | Browser or daemon unavailable                      |
| 6    | Unsupported browser capability or protocol         |
| 7    | Operation timed out                                |
| 8    | Policy rejected the operation                      |

Scripts should use `--json` plus the exit code. They should not parse
human-readable error text.

## Mutation semantics

All mutations carry a fresh client idempotency key. The daemon serializes
mutations per profile and deduplicates a retry only when the same client,
method, key, and parameters are repeated. A daemon restart forgets its bounded
in-memory idempotency cache, so the resolver still refreshes discovery before
creating a tab.

Navigation and reload may repeat network requests. Closing a tab can discard
unsaved page state. None of these operations focuses Zen, selects a tab, or
switches the visible Space.

## Page inspection

The shared daemon now supports bounded, read-only `pages.inspect` by explicit
stable tab ID, and that operation is headed-proven in a non-visible Space. The
CLI does not yet expose a corresponding command. There is still no element
lookup, click, fill, typing, screenshot, upload, download, or arbitrary
JavaScript command.
