# Troubleshooting

Start with a sanitized status request:

```sh
zen-agent status --json
```

The CLI returns stable error codes and a process exit code. It does not include
page URLs, titles, form values, cookies, or tokens in diagnostics.

## `browser-unavailable`

This usually means no daemon socket exists for the selected profile.

Check, in order:

1. Zen is running with the intended profile.
2. The Zen Agent extension is installed or temporarily loaded in that profile.
3. `extensions.experiments.enabled` is `true`.
4. An unsigned persistent source add-on is permitted, or the add-on was loaded
   temporarily for this browser run.
5. The Native Messaging manifest exists at
   `~/Library/Application Support/Mozilla/NativeMessagingHosts/to.nodus.zen_agent.json`.
6. Its launcher path exists and still points to the Node executable and built
   `dist/native-host.js` used during installation.
7. The configuration selects the same profile directory leaf name reported by
   the extension.

There is no standalone daemon to start. Restarting a random Node process cannot
repair a missing browser-provided Native Messaging port. Once the extension can
connect, it launches the host and publishes the socket.

## `ambiguous-profile`

No configuration exists and more than one profile daemon is active. Zen Agent
will not choose one by focus, recency, or socket order.

Close the profiles you do not intend to configure, run `spaces list`, and use
the returned opaque IDs with `config map`. Afterward, the explicit profile in
configuration selects the correct socket even when several profiles are active.

## `unsupported-capability`

Zen Agent supports only browser builds in
[the compatibility matrix](compatibility.md). Exact version refusal is
intentional even if the browser appears close enough.

Do not bypass the gate or add a semantic-version wildcard. Run the complete
headed proof on the exact Zen/Gecko pair and add it to `SUPPORTED_ZEN_BUILDS`
only when every invariant passes.

This code can also mean a build lacks a required Zen internal. Capability
probing fails closed rather than attempting an operation that might switch a
Space or select a tab.

## `protocol-version-mismatch`

The setup CLI, MCP adapter, native host, and extension were installed from
different releases. The structured error sets `retryable` and `performed` to
`false` and reports the expected and received versions. Do not retry the
workflow against the same processes.

Follow [Upgrade and rollback](upgrading.md): upgrade the package, repair the
native host, replace the extension with the XPI from the same release, migrate
configuration when requested, restart Zen, and run `zen-agent doctor --json`.
The daemon is browser-launched and cannot safely upgrade itself in place.

## `stale-id`

Opaque entity IDs are scoped to one browser session. A browser or native-host
restart invalidates old tab, window, and Space IDs.

List current Spaces through the setup CLI and current tabs through MCP:

```sh
zen-agent spaces list
```

Call `zen_tabs_list` to obtain current tab IDs, then retry with the new complete
ID. Never extract and reuse only the transport-ID portion.

## Ambiguous or rejected resolution

Ambiguity is a result, not a prompt to guess. Inspect the structured
`zen_tabs_resolve` MCP result and either provide an explicit Space or narrow the
URL/query.

Equally specific routing rules that target different Spaces are rejected.
Unknown aliases and task-context hints do not fall through to a safe default.
Weak matches on stateful or sensitive URLs are conservative by design.

## Native-host installation refusal

The installer protects both targets:

```text
~/Library/Application Support/Zen Agent/zen-agent-host
~/Library/Application Support/Mozilla/NativeMessagingHosts/to.nodus.zen_agent.json
```

If both files validate as Zen Agent-owned, `native-host install` safely
refreshes the launcher's pinned Node and package paths during an upgrade:

```sh
zen-agent native-host install
```

A partial installation or hand-edited, invalid, or foreign file is refused and
left unchanged. Inspect it before taking any manual action. Uninstall applies
the same ownership validation and removes nothing partially. This is deliberate
protection against changing another application's Native Messaging setup.

## Configuration errors

Configuration validation reports the exact JSON path for unknown fields,
unsupported schema versions, non-canonical URLs, invalid aliases, duplicate rule
IDs, and rules referencing unmapped Spaces.

Use the canonical URL emitted by the validator. Do not replace stable Space IDs
with visible names or positions. `ZEN_AGENT_CONFIG` can point at an alternate
file for isolated testing.

## Page inspection and interaction

The MCP surface supports bounded semantic snapshots and queries, DOM-only form
interaction, screenshots, explicit picker-free uploads, bounded resource
downloads, and media inspection/transcription on an explicitly identified loaded
HTTP(S) tab. The setup CLI intentionally has no page operations. See
[Background page interaction](page-interaction.md) for the capability and
recovery contracts.

An `unsupported-capability` can mean the tab is discarded, crashed, not loaded,
non-HTTP(S), or running on an unproven browser build. A `timeout` means the
dedicated actor did not answer its bounded parent deadline; Zen Agent will not
activate the tab as a fallback.

Dialogs, native/trusted input, arbitrary JavaScript, arbitrary popups,
browser-managed downloads, permission UI, and native file pickers remain
unsupported. Their absence is not a daemon outage.

## Collecting a useful report

Include:

- the Zen and Gecko versions;
- macOS architecture and version;
- Node and npm versions;
- the setup CLI command or MCP tool name, plus any sanitized error code or exit
  code;
- whether Zen was restarted since the opaque IDs were listed;
- whether the extension was temporary or persistent.

Do not include profile data, captured pages, URLs, titles, cookies, tokens, form
values, or the contents of the browser session store.
