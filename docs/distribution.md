# Distribution

Homebrew is Zen Agent's only package-manager release channel. npm remains the
repository's locked build and dependency tool, but Zen Agent is not published to
the npm registry.

Published versions and artifacts are listed on
[GitHub Releases](https://github.com/fschrhunt/zen-agent/releases). Before the
first tagged release, the repository remains the only installation source. A
standalone executable is deferred because the native host still depends on
Node.js.

## Release artifact

The release workflow runs the full project gate and creates one versioned
tarball containing:

- `zen-agent`, the interactive setup wizard and agent command backplane;
- `zen-agent-host`, the Native Messaging host;
- `zen-agent-mcp`, the stdio MCP server;
- the privileged extension source; and
- every locked production Node.js dependency.

The tarball uses npm's documented bundled-dependency format as an internal build
artifact. It is attached to GitHub Releases rather than uploaded to the npm
registry. The release check proves that it installs with npm's offline mode into
an empty isolated prefix, so a Homebrew installation does not resolve or
download code from the npm registry.

The workflow also attaches the unsigned XPI, SPDX SBOM, SHA-256 checksums,
artifact provenance, and the exact `zen-agent.rb` formula for the release.

## Homebrew

The upstream tap lives at `fschrhunt/homebrew-tap`. Once a tagged release and
formula exist, users install with:

```sh
brew install fschrhunt/tap/zen-agent
zen-agent
```

The formula depends on Homebrew's `node`, downloads the immutable bundled
tarball from GitHub Releases, verifies its SHA-256, installs it into `libexec`
with npm forced into offline mode, and links the three executables into `bin`.
This follows Homebrew's
[Node formula guidance](https://docs.brew.sh/Node-for-Formula-Authors) without
making npm a public distribution channel.

An upstream tap can ship immediately and remain under the project's release
control. Submission to `homebrew/core` can be considered later, after Zen Agent
has stable tagged releases and enough adoption to satisfy Homebrew's
[acceptance criteria](https://docs.brew.sh/Acceptable-Formulae).

After `brew upgrade`, run `zen-agent` and choose **Repair native host**, or use
`zen-agent native-host install` from automation. Either path refreshes the
pinned Node and host-module paths only when both existing installation files
validate as Zen Agent-owned.

## Release blockers

The Homebrew formula distributes the terminal-side software, but a complete Zen
Agent installation still requires browser setup:

1. The privileged `experiment_apis` extension must be installed into the
   intended Zen profile.
2. [Mozilla's documentation](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html#adding-experimental-apis-in-privileged-extensions)
   says its public add-on service cannot sign out-of-tree privileged extensions.
   The project must either obtain a Zen-compatible privileged signing path or
   explicitly support the unsigned XPI with the documented browser preference
   changes.
3. A clean-machine Homebrew install, upgrade, rollback, and uninstall test must
   prove that no unrelated profile or user-managed file is changed.
4. Protected version tags and changelog automation still need repository-level
   configuration.

These block a one-command end-user installation. Early Homebrew releases must
remain explicitly prototype-scoped and link to the required manual extension
setup.
