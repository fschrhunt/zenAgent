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

**Early, but the hard part works.** The browser model and the transport that
feeds it are implemented, tested, and proven against a real Zen: Zen Agent can
enumerate tabs in Spaces you are not looking at, open a background tab in a
Space you name, and move a tab between Spaces — without changing your selected
tab, taking focus, or interrupting audio that is already playing. The
[transport notes](docs/transport.md#proven) hold the evidence.

Not usable yet: there is no daemon, no routing policy, no CLI, and no MCP
server. Those come next.

## Getting started

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
       shared local daemon
                ▼
      native messaging host
                ▼
    privileged Zen extension
                ▼
   Zen windows → Spaces → tabs
```

The daemon will own discovery, stable tab identities, Personal/Work routing, and
background-only navigation. See [ADR 0001](docs/adr/0001-browser-transport.md)
for why the extension transport was selected over WebDriver BiDi.

## Contributing

Issues and pull requests are welcome. Run `npm run check` before opening a pull
request — CI runs the same command.

## License

[MIT](LICENSE)
