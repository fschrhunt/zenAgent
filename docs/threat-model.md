# Zen Agent threat model

- Status: Initial baseline
- Date: 2026-07-29
- Scope: local daemon, setup CLI, MCP adapter, native messaging host, privileged
  Zen extension, and browser-facing operations

Zen Agent controls a browser session the user is actively using. Its primary
security property is not merely confidentiality: an unsafe operation can take
focus, switch the visible Space, select or navigate the wrong tab, interrupt
media, or act with the user's authenticated browser state.

This document defines the trust boundaries and minimum controls every component
must preserve. A feature that cannot meet them fails closed.

## Assets

- Browser profile data, including cookies, credentials, tokens, history, and
  container identities.
- Page content, form values, uploaded files, and downloaded filenames.
- The user's current visible Space, selected tab, focused application, and media
  playback.
- Stable browser, window, Space, tab, frame, snapshot, and element identities.
- The privileged extension and native messaging channel.
- Local configuration, daemon state, diagnostic logs, and idempotency records.

## Trust boundaries

```text
calling agent or user
        │ untrusted requests
        ▼
setup CLI / MCP adapter
        │ authenticated or owner-only local protocol
        ▼
shared daemon and policy
        │ framed native messaging
        ▼
native host
        │ allowed_extensions = Zen Agent only
        ▼
privileged Zen extension
        │ explicit stable identities
        ▼
browser chrome and untrusted web pages
```

The daemon is the policy boundary. Setup CLI and MCP inputs are untrusted even
when they originate from the same user account. Browser page content is always
untrusted and may contain prompt injection or deliberately malformed data.

## Threats and required controls

### Wrong-tab or foreground browser mutation

An ambiguous lookup, stale identity, race, or unsafe fallback could navigate or
close the user's selected tab, switch Spaces, or focus Zen.

Controls:

- Discover before opening.
- Resolve only within an explicitly selected or deterministically routed Space.
- Address every existing tab mutation by stable ID.
- Return ambiguity, stale-ID, or unsupported-capability errors instead of
  choosing a fallback.
- Make new tabs background-only; expose no foreground option.
- Reject selected or playing-media tabs in the daemon and recheck live browser
  state synchronously at the privileged mutation boundary.
- Keep browser policy in the daemon rather than the MCP adapter.
- Serialize conflicting mutations and use optimistic versions or leases.
- Assert focus, selected tab, visible Space, and playback before and after every
  headed mutation scenario.

### Unauthorized local clients

Another local process could connect to the daemon and operate the user's
authenticated browser.

Controls:

- Bind only a Unix domain socket; never expose the daemon or browser protocol on
  a network interface.
- Create socket, lock, state, and credential files owner-only.
- Refuse symlinked or unexpectedly owned runtime paths.
- Treat filesystem permissions as necessary but not automatically sufficient.
  Before release, decide whether a per-install random credential or peer
  credential check is also required.
- Include client and operation IDs in sanitized diagnostics and lease state.

Same-user malware is not fully containable by Unix permissions because it can
often read the user's files or instrument their processes. Zen Agent still
minimizes ambient access and does not make the attack easier with a network
listener or broadly readable files.

### Malicious pages and prompt injection

A page can attempt to trick an agent into disclosing secrets or performing
destructive website actions.

Controls:

- Treat page snapshots, text, attributes, dialogs, and downloaded names as
  untrusted data, never as instructions.
- Keep returned content structurally separate from tool metadata and diagnostic
  messages.
- Never place page content in logs by default.
- Scope page snapshots and element references to daemon client, tab, document,
  frame, and snapshot generation; reject cross-client and stale references.
- Require an exclusive client-owned tab lease for every page mutation. Release
  leases and page ownership when the client disconnects; use bounded expiry only
  as a crash fallback.
- Bound page result sizes, operation times, frame traversal, and retries.
- Require an explicit stable tab ID for every page read. The first proven
  surface remains bounded read-only inspection: the dedicated actor accepts
  HTTP(S) documents only, visits at most 10,000 text nodes, and returns at most
  10,000 text characters.
- Keep semantic interaction capability-gated until its complete headed proof
  passes. Use DOM-only operations and never fall back to activation or native OS
  input when a site requires trusted events.

Website-level destructive actions remain governed by the calling agent's policy.
Zen Agent does not add a redundant general approval prompt, but it also does not
weaken or bypass approval requirements imposed by that caller.

### Privileged URL and file access

The extension operates with a system principal. Navigating a caller-provided
privileged scheme could turn ordinary browser automation into local code or file
access.

Controls:

- Opening and navigation allow only `http:` and `https:` by default.
- Reject `file:`, `data:`, `javascript:`, extension, browser-internal, and
  unknown schemes.
- Parse URLs before mutation and do not recover from parse failure by treating
  input as search text.
- File uploads require explicit caller-provided absolute paths on every call.
  The daemon accepts only bounded regular files opened without following
  symlinks, stages opaque owner-only copies, and releases them with their
  client, tab, or lease. It never opens a picker or logs a path.
- Downloads use only the configured destination, defaulting to the user's
  Downloads folder. They are bounded same-origin HTTP(S) fetches, publish with
  collision-safe no-overwrite semantics, and never use Firefox download UI.

### Zen internal API drift

Zen's privileged Space APIs are undocumented. A method may disappear or keep its
name while changing behavior.

Controls:

- Probe every required capability.
- Accept only exact Zen/Gecko pairs that passed the complete headed proof.
- Refuse unknown versions before the first snapshot or mutation.
- Never substitute `tabs.update({active: true})`, `browsingContext.activate`, or
  another foreground fallback.
- Re-open ADR 0001 when a stop condition is reached.

### Native messaging and extension compromise

A malicious extension or executable could attempt to use the privileged bridge,
replace its manifest, or inject protocol messages.

Controls:

- Restrict `allowed_extensions` to Zen Agent's exact add-on ID.
- Install the manifest and launcher per-user with owner-only permissions.
- Never overwrite an existing manifest or launcher.
- Uninstall only files whose contents verify Zen Agent ownership.
- Use versioned, validated protocol messages and correlate every request.
- Enforce direction-specific message ceilings and reject oversized payloads.
- Write only framed messages to native-host stdout.
- Do not expose a DevTools, BiDi, or other remote-protocol listener in normal
  operation.
- Refuse to replace an existing `resource:` substitution when registering the
  packaged page actor, and remove Zen Agent's substitution on extension
  shutdown.

### Sensitive diagnostics and crash data

Errors, tracing, or crash reports could retain browsing data longer than the
browser itself.

Controls:

- Default logs contain operation names, stable opaque IDs, counts, durations,
  versions, capabilities, and error codes only.
- Diagnostics and protocol errors must not copy raw payloads.
- Crash reporting, if added, uses the same redaction rules and excludes browser
  profiles and daemon state.
- Debug logging remains structurally redacted; a higher level is not permission
  to log page content.

## Redaction rules

| Data                                       | Default diagnostic form         |
| ------------------------------------------ | ------------------------------- |
| URL, origin, domain, path, query, fragment | Omitted                         |
| Page title or text                         | Omitted                         |
| Form value or selected option              | Omitted                         |
| Cookie, token, credential, or header       | Omitted                         |
| Upload path or downloaded filename         | Omitted                         |
| Browser profile path or name               | Omitted; opaque profile ID only |
| Tab, Space, frame, element, client ID      | Opaque ID permitted             |
| Operation, result, error code, duration    | Permitted                       |
| Window, Space, tab, or result count        | Permitted                       |
| Zen, Gecko, protocol, and product versions | Permitted                       |
| Capability names                           | Permitted                       |

Hashing sensitive values is not default redaction. Stable hashes can still
identify domains, URLs, filenames, or users across operations.

## Dependency and release controls

- Production dependencies require explicit justification and lockfile review.
- Portable CI runs formatting, lint, typecheck, unit tests, build, workflow
  linting, and dependency audit.
- Environment-dependent Zen tests remain separate and use throwaway profiles.
- Release artifacts must eventually include provenance, checksums, and an SBOM.
- No package or deployment is published without explicit approval.

## Residual risks and open decisions

- Same-user malicious software is outside a complete protection boundary.
- The privileged extension requires a Zen preference change and an unsigned
  add-on until a signing/distribution path exists.
- macOS window occlusion may affect more browser state than the observed media
  flag.
- Daemon client authentication beyond filesystem permissions is not yet chosen.
- Same-user callers retain the filesystem authority they already have. Explicit
  upload paths do not create a sandbox boundary around Documents or another
  caller-readable directory.
- Credentialed resource fetches can disclose content to the requesting local
  client. Same-origin and byte bounds reduce but do not eliminate that risk.
- Dialogs, private-window access, trusted input, browser permission UI,
  arbitrary popups, and arbitrary evaluation remain unsupported. Closed shadow
  roots are reported as boundaries but their contents remain unobservable.
