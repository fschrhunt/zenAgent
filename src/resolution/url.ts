const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

const SENSITIVE_PATH_SEGMENTS = new Set([
  "account",
  "admin",
  "auth",
  "authorize",
  "billing",
  "cart",
  "checkout",
  "compose",
  "edit",
  "login",
  "oauth",
  "payment",
  "settings",
  "signin",
  "signup",
]);

export class ResolutionUrlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResolutionUrlError";
  }
}

/**
 * Parse an address without losing any component that could distinguish
 * security principals or application state.
 *
 * URL's serializer canonicalizes host casing, IDNs, dot segments, and default
 * ports. It deliberately leaves credentials, path, query, and fragment in the
 * comparison value. In particular, this is not a "strip tracking parameters"
 * normalizer: deciding that two stateful URLs are interchangeable would make
 * tab reuse unsafe.
 */
export function normalizeUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new ResolutionUrlError(
      `The tab URL must be an absolute HTTP or HTTPS URL; received ${JSON.stringify(value)}.`,
    );
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new ResolutionUrlError(
      `The tab URL must use HTTP or HTTPS; received protocol ${JSON.stringify(parsed.protocol)}.`,
    );
  }

  return parsed.href;
}

export function normalizedOrigin(value: string): string {
  return new URL(normalizeUrl(value)).origin;
}

export function normalizedHostname(value: string): string {
  return new URL(normalizeUrl(value)).hostname;
}

export function normalizeDomain(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/u, "");

  if (candidate.length === 0) {
    throw new ResolutionUrlError("A domain match must not be empty.");
  }

  const isBracketedIpv6 = candidate.startsWith("[") && candidate.endsWith("]");

  if (
    /[/@?#]/u.test(candidate) ||
    (candidate.includes(":") && !isBracketedIpv6)
  ) {
    throw new ResolutionUrlError(
      `A domain match must contain only a hostname; received ${JSON.stringify(value)}.`,
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(`https://${candidate}/`);
  } catch {
    throw new ResolutionUrlError(
      `A domain match must be a valid hostname; received ${JSON.stringify(value)}.`,
    );
  }

  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ResolutionUrlError(
      `A domain match must contain only a hostname; received ${JSON.stringify(value)}.`,
    );
  }

  return parsed.hostname;
}

export function hostnameMatchesDomain(
  hostname: string,
  domain: string,
): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/u, "");
  const normalizedDomain = normalizeDomain(domain);

  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

/**
 * Weak reuse is unsafe when the URL carries likely page state or names a
 * commonly sensitive workflow. This is deliberately conservative: callers can
 * still reuse an exact URL, or explicitly opt into weak sensitive matching.
 */
export function isSensitiveOrStatefulUrl(value: string): boolean {
  const parsed = new URL(normalizeUrl(value));

  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return true;
  }

  return parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment.toLowerCase()));
}
