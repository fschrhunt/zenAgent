# Compatibility and current limits

Zen Agent depends on undocumented privileged Zen APIs. Compatibility is an
explicit allowlist backed by a complete headed safety proof, not a semantic
version range.

## Supported matrix

| Component | Supported or proven value                           |
| --------- | --------------------------------------------------- |
| Zen       | 1.21.9b                                             |
| Gecko     | 153.0                                               |
| macOS     | 27.0 arm64 headed proof environment                 |
| Node.js   | 24 or newer; headed proof recorded with Node 26.5.0 |
| npm       | 11 or newer                                         |

The exact Zen/Gecko pair above passed four consecutive headed runs. An unlisted
pair is refused before the first snapshot or mutation even when it reports
familiar capabilities. Add a build only after `npm run spike:transport` passes
on that exact pair.

Portable unit, contract, setup CLI, daemon, routing, resolution, and MCP tests
do not require Zen and can run on Linux CI. Those tests do not expand the headed
browser support matrix.

## Platform limits

The Native Messaging installer currently supports macOS per-user paths only. The
portable model and protocol code may work elsewhere, but Windows and Linux
browser installation, socket lifecycle, permissions, and headed safety are not
claimed.

The source extension is unsigned and privileged. A source evaluation requires
enabling experiment APIs and either disabling signature enforcement for that
profile or loading the add-on temporarily after every restart. There is no
release-quality extension package or first-run installer yet.

## Implemented browser operations

The proven transport can:

- enumerate windows, Spaces, and tabs, including non-visible Spaces;
- open a tab in an explicit Space in the background;
- move a stable tab between Spaces;
- navigate, reload, and close a stable tab;
- inspect bounded URL, title, load state, and visible text from an explicitly
  identified loaded HTTP(S) tab in a non-visible Space;
- preserve the selected tab, visible Space, application focus, and existing
  media playback across the headed proof.

Media in a newly opened background tab cannot autoplay until the user selects
it. That is Firefox behavior and Zen Agent does not bypass it.

## Read-only page inspection

The accepted `pages.inspect` transport and daemon operation requires an explicit
stable tab ID. It returns only bounded metadata and visible text to the
requesting client:

- visible text defaults to at most 2,000 characters and may be requested up to
  10,000 characters;
- traversal stops after 10,000 text nodes;
- URL and title have independent 16,384- and 1,024-character ceilings; and
- the parent rejects the request after an 8-second deadline.

Discarded, crashed, unavailable, non-HTTP(S), and unsupported-build cases fail
closed. Page content remains excluded from default logs.

The shipped Firefox `PageExtractor` actor succeeded for the selected tab but
timed out against a loaded tab in a non-visible Space because its child waits on
page animation frames. Zen Agent rejected that path instead of selecting the tab
as a workaround. The dedicated packaged JSWindowActor avoids page timers and
passed the expanded headed proof: its 80-character result included the visible
fixture, excluded a hidden sentinel, and left selection, application focus, and
media playback unchanged. See
[the page-interaction spike](spikes/page-interaction.md).

## Not implemented

Semantic snapshots, frame traversal, element identity, element lookup, click,
fill, typing, keyboard input, selection, uploads, downloads, screenshots, dialog
handling, and arbitrary JavaScript evaluation are not exposed. The MCP adapter
also does not yet provide a page-inspection tool even though the read-only
daemon method exists.

## MCP dependency pins

The MCP adapter pins `@modelcontextprotocol/sdk` 1.30.0 and Zod 4.4.3 exactly.
The package override also pins the SDK's transitive `@hono/node-server` to
2.0.12 so installation cannot resolve to its earlier vulnerable line.

On 2026-07-29, `npm audit --omit=dev` reported zero vulnerabilities with those
pins. The current MCP executable uses local stdio; it does not start an HTTP or
static-file server.
