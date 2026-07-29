import { describe, expect, it } from "vitest";

import {
  BrowserUrlPolicyError,
  MAX_BROWSER_URL_BYTES,
  validateBrowserUrl,
} from "../../src/security/url-policy.js";

describe("browser URL policy", () => {
  it("accepts and canonicalizes absolute HTTP and HTTPS URLs", () => {
    expect(validateBrowserUrl("HTTPS://EXAMPLE.COM:443/a/../b")).toBe(
      "https://example.com/b",
    );
  });

  it.each([
    "file:///Users/example/.ssh/id_ed25519",
    "data:text/html,hello",
    "javascript:alert(1)",
    "about:config",
    "moz-extension://identifier/page.html",
  ])("rejects privileged URL %s", (url) => {
    expect(() => validateBrowserUrl(url)).toThrow(BrowserUrlPolicyError);
  });

  it("rejects embedded credentials without echoing the URL", () => {
    const secret = "https://user:top-secret@example.com/";

    try {
      validateBrowserUrl(secret);
      throw new Error("expected URL rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserUrlPolicyError);
      expect(String(error)).not.toContain("top-secret");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("rejects URLs above the byte ceiling", () => {
    expect(() =>
      validateBrowserUrl(
        `https://example.com/${"x".repeat(MAX_BROWSER_URL_BYTES)}`,
      ),
    ).toThrow(/may not exceed/);
  });
});
