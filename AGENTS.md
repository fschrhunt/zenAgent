# AGENTS.md

Working rules for coding agents in this repository. Read
[.context/todo.md](.context/todo.md) for what to build next and
[docs/adr/0001-browser-transport.md](docs/adr/0001-browser-transport.md) for why
the architecture is what it is.

## The product invariants come first

Zen Agent drives a browser the user is actively working in. These are not
preferences; a change that breaks one of them is a bug even if every test
passes:

- **Never focus a Zen window, select a tab, or switch the visible Space** as a
  side effect. `browsingContext.activate` and `tabs.update({active: true})` are
  the two calls that violate this most easily. The spike keeps `activate` around
  only as a positive control.
- **Look before you open.** Discover windows, Spaces, and tabs before deciding
  to create one.
- **Address tabs by stable ID**, never by whichever tab happens to be active.
- **Keep browser policy in one shared daemon.** MCP is the browser automation
  surface; the CLI is limited to setup, configuration, and diagnostics.
- **Fail loudly on ambiguity.** Return an explicit ambiguity or
  unsupported-capability error rather than falling back to something that might
  disturb the browser.
- **Model what you do not know.** Use the `Observation<T>` three-way
  `known`/`unknown`/`unsupported` from `src/browser/model.ts` instead of
  inventing a value. Selected and focused state is observable only when the
  privileged transport reports the corresponding named capability; otherwise it
  must remain an `Observation` of `unknown` or `unsupported`.
- **Keep page content out of logs by default** — URLs, titles, form values,
  cookies, and tokens included.

## Commands

```sh
npm run check          # format:check, lint, typecheck, test, build — the CI gate
npm test               # vitest, no browser required
npm run dev -- --help  # run the CLI from source via tsx
npm run build          # tsc to dist/
```

`npm run check` is exactly what CI runs. Run it before opening a pull request.

## Layout

| Path                      | Contents                                                 |
| ------------------------- | -------------------------------------------------------- |
| `src/browser/model.ts`    | Identities, observations, snapshot and delta schemas     |
| `src/browser/registry.ts` | The live registry, stale-ID rules, lifecycle transitions |
| `src/cli/`                | Setup wizard and agent command backplane                 |
| `docs/adr/`               | Decision records — add one for any architectural choice  |
| `docs/spikes/`            | Spike findings, with evidence                            |
| `test/integration/`       | Requires a real Zen; skipped unless `ZEN_SPIKE=1`        |

## TypeScript conventions

- ESM only, `"type": "module"`. Relative imports carry a `.js` extension even in
  TypeScript source, because `moduleResolution` is `NodeNext`.
- `strict`, plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and
  `verbatimModuleSyntax`. Indexing an array yields `T | undefined`; handle it
  rather than asserting it away.
- No `any`, and no `as` to silence a real type error. `typescript-eslint`'s
  type-checked rules are on.
- Prefer `readonly` types and plain data. The model layer is immutable by
  design.
- Prettier owns formatting, including 80-column prose wrapping in Markdown. Run
  `npm run format`; do not hand-align.

## Testing

- Unit and contract tests must run with no Zen installed, on Linux CI. Anything
  that needs a real browser belongs in `test/integration/` behind `ZEN_SPIKE=1`.
- **Integration tests never touch the user's profile.** Launch with
  `--no-remote`, `MOZ_NO_REMOTE=1`, and a fresh `mkdtemp` profile. Clean up
  profiles, XPIs, and native-host manifests in `finally`, and refuse to
  overwrite a manifest that already exists.
- Assert the invariants, not just the happy path: capture selected tab, visible
  Space, and focus before and after any operation that touches the browser.

## Chrome-privileged JavaScript

Code under an extension's `experiment_apis` parent script runs inside Zen with
system privileges, not in Node:

- It is plain JavaScript with Firefox sandbox globals (`Services`,
  `ChromeUtils`, `ExtensionAPI`, `IOUtils`). ESLint has a dedicated block for
  these files.
- Declare the API class with `var`. `SchemaAPIManager` reads it back off the
  sandbox global, and a lexical binding is not a property of it.
- `gZenWorkspaces` is attached per window and can land after the extension
  starts. Poll for it; do not assume it is there.
- Zen internals (`allStoredTabs`, `moveTabToWorkspace`, `zen-workspace-id`) are
  undocumented and can change between Zen releases. Probe for capabilities and
  fail closed with a clear message instead of calling optimistically.

## Pull requests

- One logical change per pull request, with the Linear issue in the title:
  `feat(DEV-273): …`.
- Update `.context/todo.md` in the same pull request that completes an item, and
  say what was actually verified rather than checking the box optimistically.
- Record architectural decisions in `docs/adr/`, and spike evidence in
  `docs/spikes/`.
- Never commit secrets, profile data, or captured page content. Reference
  environment variable names only.
- Do not merge; open the pull request and stop.

## Reuse

Do not copy code from `zen-mcp` or any other project until its license and reuse
terms have been confirmed in writing. Conceptual reference only.
