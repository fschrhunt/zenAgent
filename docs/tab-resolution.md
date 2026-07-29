# Tab resolution

The shared policy in `src/resolution/` discovers tabs before opening one and
never relies on the browser's selected tab. It is independent of the native
transport so the daemon can inject a registry-backed adapter and the CLI and MCP
server can use the same result contract.

## Matching

The default rules are deliberately narrow:

1. An exact URL string.
2. A normalized URL.

Normalization uses the platform URL parser to canonicalize syntax such as host
casing, IDNs, dot segments, and default ports. It retains the scheme,
credentials, non-default port, path, query, and fragment. Zen Agent does not
strip query parameters or otherwise decide that two stateful URLs are
interchangeable.

Origin, domain, exact-title, and caller-provided text-query matching are
available only when a caller names those rules. They are weaker than URL
matches. Weak matching fails closed when either URL:

- has credentials, a query, or a fragment;
- contains a commonly sensitive path such as `login`, `checkout`, `billing`,
  `compose`, or `edit`; or
- cannot be observed.

A caller can explicitly allow sensitive weak matching, but exact or normalized
matching needs no override because it preserves the complete URL.

## Selection and ambiguity

Only tabs with a known membership in the chosen Space are eligible by default.
An explicit cross-Space option expands the search within the same browser
session, but a match in the chosen Space still wins. It never expands the search
to another profile or session.

Crashed, selected, and known media-playing tabs are excluded. Discarded tabs
remain eligible for exact URL reuse and can be navigated by stable ID to load
them. Popups need no special selection rule: if the transport reports one as a
tab with known Space membership, it competes under the same rules. A redirected
tab matches its currently observed URL rather than its navigation history.

Matches are scored in this order:

1. Exact URL.
2. Normalized URL.
3. Origin.
4. Domain.
5. Exact title.
6. Caller query.

If multiple candidates share the strongest score, the resolver returns
`ambiguous` with every tied candidate. It never chooses based on tab order,
selection, focus, or a title tie.

Every result is a discriminated, machine-readable `reused`, `opened`, or
`ambiguous` value. Explanations contain stable model IDs and match metadata but
do not copy tab URLs or titles.

## Mutation and races

The injected transport receives:

- the chosen stable window and Space IDs;
- literal `background: true`;
- the destination URL; and
- an opaque SHA-256 idempotency key.

There is no foreground option. Navigation receives the resolved `BrowserTabId`,
never an active-tab shorthand. If a reused tab closes before navigation, the
resolver takes one fresh snapshot and resolves again.

Equivalent simultaneous requests on one resolver share one promise. The
transport adapter must additionally enforce the opaque idempotency key
atomically so separate clients or daemon retries cannot create duplicates.
