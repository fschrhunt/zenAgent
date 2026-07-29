# Configuration and Space routing

Zen Agent configuration schema version 1 is JSON. On macOS, the default path is:

```text
~/Library/Application Support/zen-agent/config.json
```

`ZEN_AGENT_CONFIG` may name a different absolute path, or a path relative to the
current directory. Non-macOS development uses
`$XDG_CONFIG_HOME/zen-agent/config.json`, falling back to
`~/.config/zen-agent/config.json`.

Configuration is strict. Unknown fields, unsupported schema versions,
non-canonical URLs, duplicate rule IDs, invalid aliases, and references to
unmapped Spaces are errors. Every error includes the JSON path that needs
attention.

## First-run bootstrap

Zen launches one native-host daemon per active profile. Before a configuration
exists, the CLI may discover the socket only when exactly one profile daemon is
active. It refuses `ambiguous-profile` when several are present instead of
choosing the focused, newest, or visually active browser.

With one active profile, list its Spaces first:

```sh
zen-agent spaces list
```

Then pass complete opaque IDs from that output to `config map`:

```sh
zen-agent config map \
  --personal '<opaque-personal-space-id>' \
  --work '<opaque-work-space-id>' \
  --alias 'research=<opaque-research-space-id>'
```

The command verifies every requested ID against current discovery, obtains the
profile ID from the daemon, and atomically writes the default configuration. It
then asks that daemon to reload the new file, so routing changes do not require
a browser restart. Existing routing rules and mappings not named by the command
are preserved.

If multiple profile daemons are active on first run, close the profiles you do
not intend to configure and retry. After configuration exists, its explicit
`profile` chooses the socket deterministically.

## Format

```json
{
  "version": 1,
  "profile": "tddguwg7.Default (release)",
  "spaces": {
    "personal": "9f77971d-6f59-4470-9d73-fec34a917c5c",
    "work": "ac541418-c462-4366-af1b-980577f61ff5",
    "aliases": {
      "client-a": "13a7db52-9865-4456-a8f0-457e9069230a",
      "research": "23c37813-a4c0-49ac-8016-b07aee6cd6a3"
    }
  },
  "routing": {
    "rules": [
      {
        "id": "work-domain",
        "kind": "domain",
        "domain": "work.example",
        "includeSubdomains": true,
        "space": "work"
      },
      {
        "id": "personal-calendar",
        "kind": "url",
        "url": "https://calendar.example/personal/",
        "match": "prefix",
        "space": "personal"
      }
    ],
    "safeDefault": "research"
  }
}
```

`profile` is the leaf name of Zen's profile directory as reported by the
privileged extension. It is never inferred from the focused or most recently
used browser window.

`personal` and `work` map to stable Zen Space IDs. Named aliases do the same for
any other Space. Aliases start with a lowercase letter and contain only
lowercase letters, digits, `-`, or `_`. They do not depend on the Space's
visible name or position.

Rules refer to a configured role or alias:

- A domain rule matches its exact hostname. It also matches child hostnames only
  when `includeSubdomains` is `true`.
- A URL rule uses an absolute canonical HTTP(S) URL and either `exact` or
  `prefix` matching. Prefix matching is confined to the configured origin, so a
  rule for `https://example.com/` cannot match
  `https://example.com.evil.invalid/`.

Zen Agent has no built-in assumptions about sites. GitHub, Google, or any other
domain is Personal or Work only when the user configures it.

## Routing precedence

Routing is deterministic:

1. An explicit stable Space ID or configured name from the caller.
2. The highest-specificity matching URL/domain rule.
3. A task-context hint (`personal`, `work`, or a named alias).
4. The configured safe default.
5. An unresolved result.

Exact URL rules are more specific than URL prefixes. The longest matching URL
prefix wins, followed by the most-specific domain. If equally specific rules
target different stable Space IDs, the result is `ambiguous` and includes every
conflicting rule and candidate. Zen Agent never breaks a tie using configuration
order, visual Space order, or browser focus.

An explicit Space name or task hint that is not mapped is an error. It does not
fall through to the safe default, because doing so could route work into the
wrong context.

## Dry-run and discovery integration

`routeSpace` in `src/routing/policy.ts` is pure and side-effect free. Its
structured result is also the dry-run/explain contract: it reports the selected
profile and Space ID, source, matched rule IDs, and the outcome of every
precedence stage. It returns `ambiguous` or `unresolved` instead of choosing an
unsafe fallback.

`mapDiscoveredSpaces` in `src/config/discovery.ts` is the adapter for a
configuration command. The command supplies the latest discovered stable Space
IDs and the user's requested mappings. The helper rejects guessed or stale IDs
and constructs the mapping without activating a Space, selecting a tab, or
changing browser focus. `zen-agent config map` atomically persists its result
and explicitly reloads the production daemon when it updates the default
configuration path. An alternate `--config` destination is written but not
loaded into a daemon.
