# ADR 0004: Use an interactive setup wizard with an agent CLI backplane

- Status: **Accepted**
- Date: 2026-07-29

## Context

Zen Agent originally exposed the daemon's browser operations twice: as terminal
commands and as MCP tools. The duplication added a second public automation
surface without adding a transport capability. Agents already use MCP, while the
CLI remains necessary before MCP can connect: it installs the Native Messaging
host and performs first-run Space mapping.

The CLI is also useful when the automation path is unavailable. A sanitized
status command can diagnose the daemon without asking an MCP client to start.
However, a command reference is not a good primary installation experience for a
product installed on a user's Mac.

## Decision

Keep the installed `zen-agent` command as a setup, configuration, and diagnostic
utility. Running it without arguments in an interactive terminal opens a branded
setup wizard. The wizard uses arrow keys and Enter to:

- install or safely refresh the Native Messaging host;
- explain the remaining Zen profile requirements;
- check sanitized daemon health;
- map discovered Personal and Work Spaces; and
- safely remove the Native Messaging host.

The wizard uses Zen Agent's coral accent and never depends on color alone for
meaning. It does not prompt when stdin or stdout is not a TTY.

Retain explicit commands as a non-interactive backplane for agents and scripts:

- `native-host install` and `native-host uninstall`;
- `spaces list` and `config map`;
- `status`, `help`, and `version`.

Those callers use explicit commands, stable exit codes, and `--json` where
supported. They never need to drive the interactive menu.

Remove all `tabs` commands from the CLI. Browser discovery beyond the Space
information needed for setup, tab resolution, and every browser mutation are
exposed through `zen-agent-mcp`.

The daemon protocol remains adapter-independent. It continues to own the
registry, routing policy, tab resolver, mutation queue, idempotency, and browser
safety checks. This decision narrows one client; it does not move policy into
the MCP adapter.

## Consequences

Good:

- There is one agent-facing browser automation surface.
- People get a guided installed-product experience while agents retain a
  deterministic command interface.
- The CLI has a clear reason to exist before and during MCP setup.
- Native-host recovery and sanitized diagnostics remain available without a
  working MCP client.
- Browser behavior and safety guarantees stay centralized in the daemon.

Costs:

- Existing scripts that call `zen-agent tabs ...` must migrate to MCP.
- The interactive renderer adds one bundled production dependency.
- CLI and MCP command equivalence is no longer a product or test requirement.
- Documentation and release checks must describe `zen-agent` as a setup utility,
  not a second browser client.

## Relationship to ADR 0002

ADR 0002 remains authoritative for the shared daemon, socket protocol,
lifecycle, and policy boundary. This decision supersedes only its assumption
that both CLI and MCP are general browser-operation clients.
