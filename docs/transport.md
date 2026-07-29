# The Zen transport

How Zen Agent talks to Zen, what it requires of the browser, and what has
actually been measured rather than assumed.

Tracking: [DEV-273](https://linear.app/intuitum/issue/DEV-273). The decision
behind it is [ADR 0001](adr/0001-browser-transport.md); the evidence is
[the DEV-261 spike](spikes/dev-261-transport.md).

## Shape

```text
Zen Browser
  extension/api/parent.js     privileged chrome JS: gZenWorkspaces, gBrowser
  extension/background.js     event page, holds the native port open
        │  native messaging (uint32 LE length + UTF-8 JSON, over stdio)
        ▼
  src/native/host.ts          the host process Zen launches
  src/transport/client.ts     request correlation, snapshots, deltas
  src/browser/registry.ts     the live model
```

The extension is where the whole architecture earns its keep.
`gZenWorkspaces.allStoredTabs` walks every `<zen-workspace>` element, so it sees
tabs in Spaces the user is not looking at and tabs that were never loaded.
`gBrowser.tabs` — which WebDriver BiDi and a plain WebExtension both enumerate
through — returns only the active Space. On a real profile that difference was 1
visible tab out of 22.

## Requirements

Zen Agent needs two preference changes on a Zen profile. They are a real
security posture change and are listed here rather than buried:

| Setting                          | Value   | Why                                             |
| -------------------------------- | ------- | ----------------------------------------------- |
| `extensions.experiments.enabled` | `true`  | Enables the privileged `experiment_apis` add-on |
| `xpinstall.signatures.required`  | `false` | The add-on is unsigned                          |

The alternative to disabling signature enforcement is loading the add-on from
`about:debugging` on every browser restart. Both are honest options; neither is
free. Zen permits this at all only because it ships
`MOZ_REQUIRE_SIGNING: false`, which makes `AddonSettings.EXPERIMENTS_ENABLED` a
live preference rather than frozen `false` as on stock Firefox Release.

The native host manifest belongs at

```text
~/Library/Application Support/Mozilla/NativeMessagingHosts/to.nodus.zen_agent.json
```

Not a `.../Zen/` path. Zen does not patch Firefox's manifest directory, despite
third-party installers guessing otherwise. `allowed_extensions` is restricted to
Zen Agent's own add-on id, because this host bridges to a privileged API.

## Identity

Tab and window identifiers are minted by the extension and held in a `WeakMap`
keyed on the DOM element. Nothing is written to the profile to obtain identity.

This gives an identifier that survives moving a tab between Spaces and between
windows — both are DOM moves of the same element — but not a browser restart.
That is exactly the lifetime the model gives a session-scoped entity: a restart
produces a new session and stales every identifier from the previous one, with
reason `session-replaced`.

A Space's transport identity is `<windowId>/<zen space uuid>`. Zen stores Spaces
globally but materialises one `<zen-workspace>` per window, while the model
scopes a Space to exactly one window, so two windows showing the same Space
would otherwise collide. This composes two identifiers the browser supplied; it
does not derive identity from position or title.

## What is deliberately not known

The transport reports `unknown` or `unsupported` rather than guessing:

| Field                  | Status                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mediaState`           | Only ever `playing`. Sound state cannot separate "no media" from "paused", and the invariant that matters is not interrupting a tab that is playing. |
| `browsingContextId`    | `unsupported`. Browsing contexts belong to a page-level transport; ADR 0001 leaves that door open for BiDi later.                                    |
| `url` on a lazy tab    | `unknown: not-loaded`, which is a different situation from the browser declining to report it.                                                       |
| A tab's Space mid-move | `unknown: temporarily-unavailable`. Zen moves the attribute and the DOM position separately.                                                         |

Private windows are dropped under the default `hidden` policy, and so are
windows whose private state is merely unknown. "Might be private" is treated as
private, which is the only safe direction.

## Message sizes

Host to browser is capped at 1 MiB by Firefox; browser to host is 4 GB. So it is
requests that are constrained, not snapshots — the opposite of what ADR 0001
originally implied. `src/transport/chunking.ts` splits oversized outbound
messages and reassembles them, slicing on byte boundaries rather than string
indices so that a multi-byte character straddling a chunk survives.

## Capability detection

The extension probes for each Zen internal it depends on and reports what it
actually found. The host refuses to call anything it was not told is present,
and refuses to connect at all without `zen.spaces.enumerate`,
`zen.tabs.enumerate-all-spaces`, and `browser.windows.private`.

Failing closed matters here more than usual. ADR 0001 names Zen-internal drift
as the main risk of this transport, and the dangerous failure is not a crash —
it is calling an internal that quietly changed shape and switching the user's
visible Space as a result.

## Proven

`npm test` covers the wire and the model without a browser: framing, chunking,
protocol versioning, capability refusal, snapshot translation, delta
application, session replacement, and the host's connect-and-reconcile loop.

Everything else is covered by `npm run spike:transport`, which runs
`test/integration/transport.proof.test.ts` headed against a real Zen on a
throwaway profile. Measured on Zen 1.21.9b / Gecko 153.0 / macOS 27.0 arm64, and
green on three consecutive runs:

| Claim                                                        | Evidence                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Zen loads an MV3 add-on that also declares `experiment_apis` | All eight capabilities detected. DEV-261 had only proved the two halves separately.                                                 |
| Tabs in a non-visible Space are enumerated                   | Tabs seen in both Spaces at once — the failure that disqualified BiDi                                                               |
| A background tab opens in a requested Space                  | Routed tab present, in the requested Space, not selected                                                                            |
| **Identity survives a Space change**                         | The same identifier before and after `moveTab` moved it between Spaces, and every identifier from the first snapshot still resolved |
| The selected tab never changes                               | Unchanged across open, route, move, navigate, and close                                                                             |
| Focus is never taken                                         | Frontmost macOS application unchanged across the whole run                                                                          |
| A playing tab is not interrupted                             | Playback position advanced 11.19s → 16.71s across the agent's open/navigate/close cycle, and never rewound                          |
| Privileged schemes are refused                               | `javascript:`, `file:` and `data:` all refused                                                                                      |

Focus is checked two ways, because the model's own `focused` field only compares
Zen windows to each other: the run also asks macOS which application is
frontmost before and after.

Playback is measured from the page's own reported `currentTime`, not the tab's
`soundPlaying` flag. That flag turned out to depend on whether the Zen window
was occluded, so it is recorded as evidence but never asserted on. A position
that keeps advancing proves playback was neither paused nor restarted, which is
the stronger claim and the one the invariant actually makes.

## Media in agent-opened tabs

Firefox blocks autoplay in a tab that has never been foregrounded, so **media in
a background tab Zen Agent opens will not start playing until the user selects
that tab.** The promise from `play()` neither resolves nor rejects; it simply
stays pending.

This is not a bug to route around. It is worth stating plainly because it bounds
what an agent can do: Zen Agent can protect media the user is already playing —
which is the invariant that matters — but it cannot start playback in a tab the
user has never looked at.

## Still open

- Recording the Zen versions the capability probe has passed on, so unknown
  builds fail closed rather than optimistically.
- An installer that writes the native host manifest.
- Whether macOS window occlusion breaks background operation more broadly. The
  `soundPlaying` flakiness above is the first evidence that it affects
  something.
