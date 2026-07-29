# Setup wizard and agent CLI reference

The installed `zen-agent` command is primarily a guided setup product. Run it in
an interactive terminal to open the coral-accented wizard:

```sh
zen-agent
```

Use the arrow keys to move, Enter to select, and Escape to close a prompt. The
wizard can install or refresh the Native Messaging host, show the remaining Zen
profile requirements, check the daemon connection, map Personal and Work Spaces,
and remove the host safely.

Agents and scripts retain explicit commands with stable exit codes and JSON
output. They do not have to automate the menu. The utility does not expose tab
listing, resolution, navigation, reload, close, page inspection, or any other
browser automation command; agents use the MCP server for browser operations.

The CLI never opens a Native Messaging connection or starts a second daemon. Zen
must already have launched the native-host daemon for `status`, Space discovery,
and configuration mapping.

When no configuration exists, the wizard and explicit commands discover exactly
one active profile daemon. More than one returns `ambiguous-profile`; neither
chooses by focus or recency. See
[configuration](configuration.md#first-run-bootstrap).

Run the built executable:

```sh
npm run build
node dist/cli.js
```

An installed package exposes the same command as `zen-agent`.

## Commands

| Command                 | Behavior                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `setup`                 | Open the interactive setup wizard explicitly                              |
| `status`                | Report sanitized daemon, profile, session, and registry-count state       |
| `spaces list`           | List discovered Spaces and opaque stable IDs for configuration            |
| `config map`            | Validate discovered IDs and atomically update Space mappings              |
| `native-host install`   | Install the per-user macOS launcher and Native Messaging manifest         |
| `native-host uninstall` | Remove only a launcher and manifest recognisably created by the installer |
| `help`                  | Show the setup utility's command surface                                  |
| `version`               | Print the installed Zen Agent version                                     |

There is no `tabs` command and no foreground, activate, select, or current-tab
shorthand. The complete browser automation surface is documented in
[the MCP reference](mcp.md).

With no arguments, `zen-agent` opens the wizard only when both stdin and stdout
are attached to a terminal. A pipe, CI job, or agent process receives help text
instead of a prompt. `zen-agent setup` fails clearly without a TTY.

## Guided first-run setup

Choose **Set up this Mac**. The wizard:

1. Installs or safely refreshes the per-user Native Messaging host.
2. Shows the preferences and extension-loading work that must be completed in
   the intended Zen profile.
3. Checks sanitized daemon health.
4. Offers to map discovered Personal and Work Spaces when Zen is connected.

It does not change Zen preferences, install an unsigned privileged extension,
focus Zen, select a tab, or switch the visible Space.

## Agent and script setup

The same flow remains available without prompts:

```sh
zen-agent native-host install
zen-agent spaces list
zen-agent config map \
  --personal '<opaque-personal-space-id>' \
  --work '<opaque-work-space-id>' \
  --alias 'research=<opaque-research-space-id>'
```

Use the sanitized status command for diagnostics:

```sh
zen-agent status
zen-agent status --json
```

Space IDs are scoped to one browser session. List them again after a browser or
native-host restart before changing configuration. `config map` verifies every
requested ID against current discovery and refuses stale or guessed values.

## Output

The wizard is for people in a terminal. Explicit commands provide human-readable
output by default; `--json` emits one stable envelope for commands that support
it:

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

Without `--json`, errors go to stderr. Space metadata may be returned by the
explicit discovery command, but URLs, titles, form values, and tokens are
excluded from default diagnostics.

## Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | Success                                            |
| 1    | Unexpected internal failure                        |
| 2    | Invalid command, option, configuration, or payload |
| 3    | Ambiguous profile or routing context               |
| 4    | Stale stable ID                                    |
| 5    | Browser or daemon unavailable                      |
| 6    | Unsupported browser capability or protocol         |
| 7    | Operation timed out                                |
| 8    | Policy rejected the operation                      |

Scripts should use `--json` plus the exit code. They should not parse
human-readable error text.

## Automation boundary

`zen-agent-mcp` connects independently to the same daemon socket. Closing a CLI
or MCP client does not stop the daemon or Zen. Browser policy, mutation
serialization, stable-ID checks, and background-only guarantees remain in the
daemon; removing browser commands from the CLI does not remove those
capabilities from MCP.
