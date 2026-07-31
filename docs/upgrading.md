# Upgrade and rollback

Zen Agent's terminal package, Native Messaging host, and privileged extension
must be treated as one versioned installation. Do not retry a workflow while
those components report different daemon or transport protocol versions.

## Before upgrading

1. Finish or cancel active workflows. A disconnect deliberately leaves
   agent-created tabs open.
2. Record `zen-agent version` and run `zen-agent doctor --json`.
3. Back up the configuration file. On macOS its default location is
   `~/Library/Application Support/zen-agent/config.json`; an `ZEN_AGENT_CONFIG`
   override names the actual file instead.
4. Keep the previous release archive and unsigned XPI until the upgraded
   installation passes `doctor`.

The installer never edits a Zen profile or silently replaces the extension.
Extension installation remains an explicit per-profile step.

## Upgrade

Upgrade every component before resuming browser work:

1. Install the new Homebrew package or build the new source checkout.
2. Run `zen-agent native-host install`. This atomically refreshes the
   Zen-Agent-owned launcher so it points at the new host module. It refuses
   partial, foreign, or hand-edited installations.
3. Replace the privileged extension in the configured Zen profile with the XPI
   from the same release.
4. If the configuration validator requests it, run `zen-agent config migrate`.
   Schema 1 migrates to schema 2 with conservative defaults: exact profile
   matching, hidden private windows, disabled background launch, `~/Downloads`,
   and no installed speech locales.
5. Restart Zen. The daemon is launched by the extension, so an old daemon cannot
   be upgraded independently in place.
6. Run `zen-agent doctor --json` and require matching product, extension, native
   protocol, and daemon protocol versions before calling MCP tools.

Configuration migration validates the complete result before using the atomic
configuration writer. An unsupported future schema is rejected without rewriting
the file.

## Protocol mismatch recovery

Daemon mismatches return `protocol-version-mismatch` with these stable recovery
fields:

```json
{
  "reason": "protocol-version-mismatch",
  "retryable": false,
  "performed": false,
  "resource": "daemon-protocol",
  "recovery": "upgrade-client-host-and-extension-together",
  "expectedProtocolVersion": 1,
  "receivedProtocolVersion": 2
}
```

Do not parse the prose message and do not retry against the same processes.
Repeat the complete upgrade sequence above. A transport-protocol mismatch
requires the same repair because it indicates drift between the profile's
extension and the installed native host.

## Rollback

Rollback is also an all-component operation:

1. Stop MCP clients and close Zen normally.
2. Restore the previous package version.
3. Run that version's `zen-agent native-host install`.
4. Restore its matching extension XPI.
5. Restore the backed-up configuration if the older release does not support the
   current schema.
6. Start Zen and run that version's `zen-agent doctor --json`.

Never copy opaque tab, Space, element, document, or lease IDs across the
restart. They are session-scoped and must be rediscovered.

The repository verifies version consistency, schema migration, protocol refusal,
an offline package install, installed CLI execution, safe MCP startup failure
without a daemon, extension packaging, Homebrew formula generation, and SBOM
creation locally. Clean-machine Homebrew upgrade, rollback, and uninstall
testing, extension signing, native code signing/notarization, tag protection,
and the first external tagged release remain release blockers.
