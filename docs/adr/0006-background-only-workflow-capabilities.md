# ADR 0006: Gate every workflow capability on background-only behavior

- Status: Accepted
- Date: 2026-07-29

## Context

Zen Agent operates beside a person who is actively using the same Mac and Zen
profile. Page automation is useful only while it remains independent of the
person's foreground keyboard, pointer, window, selected tab, visible Space, and
media.

The semantic page actor proved that DOM operations can run without native input
or activation. Dialogs, screenshots, file transfer, media transcription,
cleanup, and browser launch introduce additional paths that could expose browser
chrome or foreground UI. Treating the existing page proof as approval for those
paths would be unsafe.

Continuous activity indicators are also deliberately out of scope. The calling
agent reports only a completed, partial, or terminally blocked workflow.

## Decision

Each new browser-facing operation is a separate transport capability. It is
absent from MCP until portable contract tests and three consecutive headed runs
on the exact Zen, Gecko, macOS, and architecture tuple prove that it does not:

- synthesize native or trusted keyboard or pointer input;
- move the cursor;
- focus Zen or change the frontmost application;
- select a tab or switch the visible Space;
- foreground a tab, popup, dialog, picker, permission panel, or new window;
- interrupt media in a tab the person is using; or
- emit a browser, operating-system, daemon, or MCP progress notification.

DOM-only operations remain allowed. A capability that requires activation,
native input, or foreground UI fails closed instead of adding a fallback.

Production clients attach only to the explicitly configured account-bearing Zen
profile. Throwaway profiles are test fixtures only. An optional browser launch
must name that configured profile and pass its own no-activation proof before it
can be enabled.

If a tab-scoped content-dialog path is ever proven, it must use opaque identity
and a separate capability. No dialog capability is currently advertised.
Window-modal dialogs, native pickers, permissions, authentication chrome,
arbitrary popups, notifications, and trusted input remain unsupported. Known
links that request a new context are routed through Zen Agent's existing
background tab creation instead of executing foreground popup semantics.

Screenshots are bounded document snapshots returned only to their caller. File
uploads target an explicit live file input and use explicitly named regular
files without a picker. Downloads use bounded background HTTP(S) transfer and
never Firefox's download UI. Media transcription first uses captions, then a
bounded accessible media resource and Apple's on-device Speech framework; it
does not capture system audio or change playback.

Agent-created tabs carry provenance. The final result tab is retained. Only a
tab explicitly marked temporary and still proven to belong exclusively to the
same client may be cleaned up automatically.

Private windows remain hidden unless configuration explicitly opts in and that
path has its own headed proof.

## Workflow outcome convention

Zen Agent does not add a task-completion MCP tool because the browser adapter
cannot determine whether a larger agent task succeeded. Calling agents report
one terminal outcome:

```json
{
  "outcome": "completed | partial | blocked",
  "verified": "short result description",
  "resultTabId": "stable tab ID or null",
  "cleanup": "completed | skipped | blocked",
  "userAction": "required action or null"
}
```

Agents release leases before reporting and never hold them while waiting for the
user.

## Stop conditions

Do not advertise or retain a capability when its implementation or any failure
path can cause foreground UI, native input, cursor movement, notification,
unbounded content retention, silent mutation replay, or operation against a
different profile.

An unknown browser build is unsupported until the complete headed suite passes
outside the user's daily profile.
