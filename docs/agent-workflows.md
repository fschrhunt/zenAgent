# Agent workflow behavior

Zen Agent performs browser operations without live progress notifications,
badges, overlays, or foreground browser changes. A calling agent should remain
quiet while work is proceeding and report once when the workflow completes,
partially completes, or cannot continue safely.

## Terminal report

The final agent response should communicate:

- `outcome`: `completed`, `partial`, or `blocked`;
- what result was actually verified, rather than only which call was dispatched;
- the retained stable result-tab ID when useful;
- whether temporary-tab cleanup completed, was skipped, or was blocked; and
- the one user action required to continue, or no action.

This is a calling-agent convention, not an MCP tool. Zen Agent has no reliable
knowledge of the larger task's definition of success.

## Mutation lifecycle

For a page mutation, the calling agent:

1. inspects and resolves the exact semantic target;
2. obtains any approval required by its own host policy;
3. acquires the tab lease;
4. refreshes the target if needed;
5. performs the mutation once;
6. verifies the intended result with a wait, snapshot, or query; and
7. releases the lease before reporting.

`performed: true` confirms dispatch, not semantic success. A stale target is
never automatically replayed. Resolve it again and re-evaluate the intended
effect.

For existing-tab mutations, pass the registry sequence observed while planning
as `expectedRegistrySequence`. If another queued operation advances the registry
first, refresh and replan. For element mutations, act only from the newest
snapshot captured by this client for the tab; taking a newer snapshot
intentionally supersedes older mutation targets.

If the target tab becomes selected, the user has taken it over. Zen Agent
revokes mutation ownership and the calling agent reports a partial or blocked
outcome. Selection and media in unrelated tabs do not affect the workflow.

## Unsupported foreground requirements

Stop and report a blocker when a site requires native or trusted input, browser
permission UI, a native picker, a window-modal dialog, arbitrary popup behavior,
system audio capture, or another foreground-only operation. Never ask Zen Agent
to select a tab, focus a window, switch Spaces, synthesize input, or move the
cursor as a workaround.
