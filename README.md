<div align="center">

<img src="assets/zen-agent.svg" alt="Zen Agent" width="420" />

<br />
<br />

**Make Agent Browsing Chill.**

Zen Agent lets your agents use [Zen Browser](https://zen-browser.app/) quietly
in the background, so the window you are working in stays exactly where you left
it. A guided wizard walks you through setup.

</div>

<br />

## Install

The supported release channels and download paths are:

| Channel                | Download path                                                             | Command                                        |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Homebrew               | [`fschrhunt/tap`](https://github.com/fschrhunt/homebrew-tap)              | `brew install fschrhunt/tap/zen-agent`         |
| Release assets         | [GitHub Releases](https://github.com/fschrhunt/zen-agent/releases/latest) | bundled tarball, unsigned XPI, SBOM, checksums |
| Source available today | [GitHub](https://github.com/fschrhunt/zen-agent)                          | See below                                      |

Until a version appears in GitHub Releases and the Homebrew tap, install from
source:

```sh
git clone https://github.com/fschrhunt/zen-agent.git
cd zen-agent
npm ci
npm run build
node dist/cli.js
```

Zen Agent also needs its privileged extension in the intended Zen profile. Until
the first release provides the unsigned XPI, follow the explicit preference and
source-extension steps in the [transport guide](docs/transport.md#requirements).
The extension never changes profiles or browser preferences automatically.

Homebrew is the only package-manager release channel. npm is used internally to
build and test the Node.js project, but Zen Agent is not published to the npm
registry and Homebrew installation runs offline from the bundled GitHub release
artifact.

## Why

Agents that drive a browser usually steal it. They raise a window, jump you to a
different Space, and pull focus mid-sentence. Zen Agent does the opposite: it
looks before it opens, reuses what is already there, and stays out of your way.

## How it behaves

|                 |                                                                                 |
| --------------- | ------------------------------------------------------------------------------- |
| **Look first**  | Discover open windows, Spaces, and tabs before opening anything.                |
| **Reuse**       | Match an existing tab by its stable identifier instead of piling up duplicates. |
| **Stay put**    | Never focus a window, switch a Space, or select a tab as a side effect.         |
| **Space-aware** | Open new tabs in the right Personal or Work Space, in the background.           |
| **One policy**  | Browser behaviour lives in a shared daemon and reaches agents through MCP.      |
| **No nagging**  | No redundant approval prompt for ordinary browser actions.                      |

## Status

**Early days: a working prototype, with the background transport proven on one
exact browser build.**

The browser model, native-host daemon, configuration and routing policy, tab
resolver, setup CLI, and stdio MCP adapter are implemented and covered by
portable tests. The headed proof can enumerate tabs in non-visible Spaces and
open, move, navigate, reload, and close explicitly identified background tabs
without changing the selected tab, taking focus, or interrupting existing
playback. A dedicated packaged actor can also return bounded URL, title, load
state, and visible text from an explicitly identified loaded HTTP(S) tab in a
non-visible Space, capture semantic multi-frame snapshots, and perform named DOM
interactions through short-lived element references.

The headed result currently applies only to **Zen 1.21.9b / Gecko 153.0 on macOS
27 arm64**. Other browser builds fail closed. MCP exposes bounded inspection,
semantic snapshot/query/wait, tab leases, named DOM input, form, and history
operations. Three consecutive headed runs passed the full top-level,
same-origin, cross-origin, and open-shadow-root interaction cycle without
selecting a tab, focusing Zen, switching the visible Space, or interrupting
playback. There is not yet a release-quality extension package, so this
repository should still be treated as a source prototype rather than an end-user
release. See [compatibility](docs/compatibility.md) and the
[transport evidence](docs/transport.md#proven). The candidate page contract and
its proof boundary are documented in
[background page interaction](docs/page-interaction.md).

## Development

Requires **Node.js 24** and **npm 11+**.

```sh
npm install
npm run check
npm run dev
```

Build the executable:

```sh
npm run build
node dist/cli.js --help
```

Running `zen-agent` with no arguments in a terminal opens the arrow-key setup
wizard. Explicit commands and `--json` remain available for agents and scripts.
The complete setup and maintenance surface is documented in
[docs/cli.md](docs/cli.md). Browser automation is exposed through the
[MCP server](docs/mcp.md); the CLI intentionally has no tab commands.

## Source installation

Start the guided setup after building:

```sh
node dist/cli.js
```

Choose **Set up this Mac** to create or safely refresh an owner-only launcher
under `~/Library/Application Support/Zen Agent/` and the Firefox-compatible
manifest under `~/Library/Application Support/Mozilla/NativeMessagingHosts/`.
Existing files are changed only when both validate as Zen Agent-owned. Remove
only files created by this installer with:

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
setup wizard          MCP server
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
tab-resolution policy, mutation queue, and a local Unix socket. The setup CLI
and MCP server connect to the socket; there is intentionally no separate daemon
launcher. See [daemon lifecycle](docs/daemon.md),
[ADR 0001](docs/adr/0001-browser-transport.md), and
[ADR 0002](docs/adr/0002-shared-local-daemon.md). The setup-only CLI boundary is
recorded in [ADR 0004](docs/adr/0004-setup-only-cli.md).

For operational failures, start with
[the troubleshooting guide](docs/troubleshooting.md).

## Contributing

Issues and pull requests are welcome. Run `npm run check` before opening a pull
request — CI runs the same command.

## License

[MIT](LICENSE)
