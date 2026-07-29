# Zen Agent

A considerate, space-aware CLI and MCP server for background automation in
[Zen Browser](https://zen-browser.app/).

Zen Agent is designed for terminal-native agents that need to use the browser
without taking over the browser window you are actively using.

## Product principles

- Discover open windows, Spaces, and tabs before opening anything.
- Reuse an existing matching tab by its stable identifier.
- Never focus a window, switch a Space, or select a tab as a side effect.
- Open new tabs in the appropriate Personal or Work Space in the background.
- Keep browser policy in one shared daemon so the CLI and MCP server behave the
  same way.
- Do not add a redundant approval prompt for ordinary browser actions.

## Status

The repository currently contains the project foundation and automation. The
browser transport and tab-routing implementation come next.

## Requirements

- Node.js 24
- npm 11 or newer

## Development

```sh
npm install
npm run check
npm run dev -- --help
```

Build the executable with:

```sh
npm run build
node dist/cli.js --help
```

## Planned architecture

```text
agent
  ├─ zen-agent CLI ─┐
  └─ MCP server ────┤
                    ▼
             shared local daemon
                    │
                    ▼
          native messaging host
                    │
                    ▼
       privileged Zen extension
                    │
                    ▼
       Zen windows → Spaces → tabs
```

The daemon will own discovery, stable tab identities, Personal/Work routing, and
background-only navigation. See [ADR 0001](docs/adr/0001-browser-transport.md)
for why the extension transport was selected over WebDriver BiDi.

## Contributing

Issues and pull requests are welcome. Run `npm run check` before opening a pull
request; CI runs the same command.

## License

[MIT](LICENSE).
