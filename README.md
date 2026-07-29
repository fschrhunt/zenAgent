<div align="center">

<img src="assets/zen-agent.svg" alt="Zen Agent" width="420" />

<br />
<br />

**A considerate, space-aware CLI and MCP server for background automation in
[Zen Browser](https://zen-browser.app/).**

Built for terminal-native agents that need to use the browser without taking
over the window you are actively working in.

</div>

<br />

## Why

Agents that drive a browser usually steal it. They raise a window, jump you to a
different Space, and pull focus mid-sentence. Zen Agent does the opposite: it
looks before it opens, reuses what is already there, and stays in the
background.

## Principles

|                 |                                                                                 |
| --------------- | ------------------------------------------------------------------------------- |
| **Look first**  | Discover open windows, Spaces, and tabs before opening anything.                |
| **Reuse**       | Match an existing tab by its stable identifier instead of piling up duplicates. |
| **Stay put**    | Never focus a window, switch a Space, or select a tab as a side effect.         |
| **Space-aware** | Open new tabs in the right Personal or Work Space, in the background.           |
| **One policy**  | Browser behaviour lives in a shared daemon, so the CLI and MCP server agree.    |
| **No nagging**  | No redundant approval prompt for ordinary browser actions.                      |

## Status

**Prototype, with the background transport proven on one exact browser build.**
The browser model, native-host daemon, configuration and routing policy, tab
resolver, CLI, and stdio MCP adapter are implemented and covered by portable
tests. The headed proof can enumerate tabs in non-visible Spaces and open, move,
navigate, reload, and close explicitly identified background tabs without
changing the selected tab, taking focus, or interrupting existing playback. A
dedicated packaged actor can also return bounded URL, title, load state, and
visible text from an explicitly identified loaded HTTP(S) tab in a non-visible
Space.

The headed result currently applies only to **Zen 1.21.9b / Gecko 153.0 on macOS
27 arm64**. Other browser builds fail closed. Read-only `pages.inspect` exists
through the daemon, but the CLI and MCP adapter do not expose it yet. Semantic
snapshots and element interaction are still unimplemented. There is not yet a
release-quality extension package, so this repository should still be treated as
a source prototype rather than an end-user release. See
[compatibility](docs/compatibility.md) and the
[transport evidence](docs/transport.md#proven).

## Development

Requires **Node.js 24** and **npm 11+**.

```sh
npm install
npm run check
npm run dev -- --help
```

Build the executable:

```sh
npm run build
node dist/cli.js --help
```

The command surface is documented in [docs/cli.md](docs/cli.md). All browser
commands are clients of a local per-profile daemon; they never connect to Zen
directly.

## Source installation

Register the native messaging host for the current macOS user after building:

```sh
node dist/cli.js native-host install
```

This creates an owner-only launcher under
`~/Library/Application Support/Zen Agent/` and the Firefox-compatible manifest
under `~/Library/Application Support/Mozilla/NativeMessagingHosts/`. It refuses
to overwrite either target. Remove only files created by this installer with:

```sh
node dist/cli.js native-host uninstall
```

The native-host installer does **not** install the privileged Zen extension or
change its required browser preferences. Those source-build steps and their
security implications are documented in
[the transport guide](docs/transport.md). With exactly one active profile,
`spaces list` can discover its daemon before configuration exists; use those
opaque IDs with `config map`. Multiple active profiles are refused as ambiguous.
See [configuration](docs/configuration.md#first-run-bootstrap).

## Architecture

```text
              agent
                │
     ┌──────────┴──────────┐
     │                     │
 zen-agent CLI        MCP server
     │                     │
     └──────────┬──────────┘
                ▼
   native host + shared daemon
    (one process per profile)
                ▼
    privileged Zen extension
                ▼
   Zen windows → Spaces → tabs
```

Zen launches the native host when the extension opens a Native Messaging port.
That process owns the browser transport, live registry, routing and
tab-resolution policy, mutation queue, and a local Unix socket. CLI and MCP
clients connect to the socket; there is intentionally no separate daemon
launcher. See [daemon lifecycle](docs/daemon.md),
[ADR 0001](docs/adr/0001-browser-transport.md), and
[ADR 0002](docs/adr/0002-shared-local-daemon.md).

For operational failures, start with
[the troubleshooting guide](docs/troubleshooting.md).

## Contributing

Issues and pull requests are welcome. Run `npm run check` before opening a pull
request — CI runs the same command.

## License

[MIT](LICENSE)
