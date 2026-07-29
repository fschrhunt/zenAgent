# ADR 0003: Portable resource and URL boundaries

- Status: **Accepted**
- Date: 2026-07-29
- Scope: native transport and portable security primitives

## Context

Zen Agent receives data from two untrusted directions: local daemon clients and
the privileged browser extension. The extension also performs navigation with a
system principal. A byte-framed message can be structurally valid while still
exhausting memory through entity counts, deeply nested JSON, an enormous chunk
count, or retained page-controlled strings.

Errors are another data path. JavaScript JSON parser errors may include excerpts
of malformed input, while an exception message or stack may contain URLs, page
text, tokens, or profile paths.

## Decision

Apply independent ceilings at every portable boundary. No limit silently
truncates discovery data; exceeding one fails closed with a structured error.

### Native messages and chunking

- Browser-to-host native frames remain capped at 64 MiB.
- Each host-to-browser frame remains capped at Firefox's 1 MiB limit.
- One logical chunked value is capped at 32 MiB before any frames are emitted.
- Reassembly retains at most 32 MiB across at most eight incomplete messages.
- One message may declare at most 4,096 chunks. The count is checked before
  allocating its slice array.
- Chunk bodies must be canonical base64, and their decoded size is checked
  before allocation.

Malformed frame and reassembly errors never copy JSON parser messages or chunk
identifiers into their error text.

### Browser snapshots and page results

The native frame limit bounds bytes in flight. The transport separately bounds
what it parses and retains:

- 128 windows
- 4,096 Spaces
- 50,000 tabs
- 50,000 browsing contexts
- 100,000 frames
- 100,000 elements
- 32 MiB for the translated retained `BrowserSnapshot`
- 32 KiB per tab URL
- 64 KiB per page-controlled title or display name
- 4 KiB per transport identifier
- 256 reported capabilities

These are defensive ceilings, not expected operating sizes. An oversized
snapshot is rejected in full because accepting an incomplete tab list would
violate “look before you open.” Page inspection already has its smaller
operation-specific 10,000-character result ceiling.

### Navigation URLs

Every `ZenTransport` open or navigate call validates before sending a browser
mutation:

- absolute `http:` and `https:` only;
- no `file:`, `data:`, `javascript:`, `about:`, extension, or unknown schemes;
- no embedded username or password;
- at most 32 KiB;
- invalid-input errors do not repeat the submitted URL.

The privileged extension retains its own scheme allowlist as defense in depth.
The host-side check is still required so policy is consistent in portable tests
and invalid requests never reach the privileged boundary.

### Time and identifier bounds

Transport requests default to ten seconds. Configuration accepts only positive
integer deadlines up to five minutes. Existing tab, window, and Space transport
identifiers are non-empty and at most 4 KiB before being sent.

### Diagnostics

Portable crash diagnostics reduce arbitrary exceptions to a bounded safe `code`
or `name`; they never include messages or stacks. JSON framing errors are
generic for the same reason. Process entry points must use this helper instead
of interpolating an unexpected exception.

## Consequences

- A malicious page can make discovery fail by producing data above a ceiling,
  but cannot make Zen Agent accept a partial registry.
- Very large legitimate profiles require an explicit reviewed limit increase.
- URLs containing user information are refused even though HTTP permits them.
  Callers must use normal browser authentication state instead.
- Transport request timeout is not proof that a browser mutation was cancelled.
  Idempotency and fresh reconciliation remain necessary before retry.
- Daemon protocol frames retain their independent 8 MiB request/result ceiling
  from ADR 0002.

## Verification

Portable tests cover privileged schemes, embedded credentials, oversized URLs,
snapshot counts and strings, retained snapshot size, transport timeout
configuration, identifier size, malformed-frame redaction, chunk-count
preallocation, canonical base64, outgoing logical-message size, JSON depth,
cycles, node/string ceilings, and crash-diagnostic redaction.
