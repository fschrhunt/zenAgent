export const MAX_BROWSER_URL_BYTES = 32 * 1024;
const ALLOWED_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);

export class BrowserUrlPolicyError extends Error {
  public readonly reason:
    "too-large" | "invalid" | "unsupported-scheme" | "embedded-credentials";

  public constructor(reason: BrowserUrlPolicyError["reason"], message: string) {
    super(message);
    this.name = "BrowserUrlPolicyError";
    this.reason = reason;
  }
}

/**
 * Validate a caller-provided navigation target before it reaches a privileged
 * transport. Error messages never copy the submitted URL.
 */
export function validateBrowserUrl(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_BROWSER_URL_BYTES) {
    throw new BrowserUrlPolicyError(
      "too-large",
      `Browser URLs may not exceed ${String(MAX_BROWSER_URL_BYTES)} bytes.`,
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserUrlPolicyError(
      "invalid",
      "A browser URL must be a valid absolute HTTP or HTTPS URL.",
    );
  }

  if (!ALLOWED_BROWSER_PROTOCOLS.has(parsed.protocol)) {
    throw new BrowserUrlPolicyError(
      "unsupported-scheme",
      "Only HTTP and HTTPS browser URLs are allowed.",
    );
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new BrowserUrlPolicyError(
      "embedded-credentials",
      "Browser URLs may not contain embedded credentials.",
    );
  }

  return parsed.href;
}
