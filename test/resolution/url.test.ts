import { describe, expect, it } from "vitest";
import {
  hostnameMatchesDomain,
  isSensitiveOrStatefulUrl,
  normalizeDomain,
  normalizeUrl,
  ResolutionUrlError,
} from "../../src/resolution/url.js";

describe("URL normalization", () => {
  it("canonicalizes syntax while retaining security and state components", () => {
    expect(
      normalizeUrl(
        "HTTPS://user:secret@EXAMPLE.com:443/one/../two?q=hello#panel",
      ),
    ).toBe("https://user:secret@example.com/two?q=hello#panel");
  });

  it("does not equate different schemes, ports, paths, queries, or fragments", () => {
    const values = [
      "http://example.com/",
      "https://example.com/",
      "https://example.com:444/",
      "https://example.com/path",
      "https://example.com/?state=1",
      "https://example.com/#state",
    ];

    expect(
      new Set(values.map((value) => normalizeUrl(value)).values()).size,
    ).toBe(values.length);
  });

  it("rejects relative and privileged URLs", () => {
    expect(() => normalizeUrl("/relative")).toThrow(ResolutionUrlError);
    expect(() => normalizeUrl("file:///tmp/private")).toThrow(/HTTP or HTTPS/u);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/HTTP or HTTPS/u);
  });
});

describe("domain matching", () => {
  it("matches the host and subdomains only at label boundaries", () => {
    expect(hostnameMatchesDomain("example.com", "EXAMPLE.COM.")).toBe(true);
    expect(hostnameMatchesDomain("docs.example.com", "example.com")).toBe(true);
    expect(hostnameMatchesDomain("notexample.com", "example.com")).toBe(false);
    expect(
      hostnameMatchesDomain("example.com.attacker.test", "example.com"),
    ).toBe(false);
  });

  it("rejects strings that contain more than a hostname", () => {
    expect(() => normalizeDomain("https://example.com")).toThrow(
      /only a hostname/u,
    );
    expect(() => normalizeDomain("example.com/path")).toThrow(
      /only a hostname/u,
    );
    expect(() => normalizeDomain("example.com:443")).toThrow(
      /only a hostname/u,
    );
  });

  it("canonicalizes internationalized hostnames", () => {
    expect(normalizeDomain("BÜCHER.de")).toBe("xn--bcher-kva.de");
  });
});

describe("sensitive and stateful URL detection", () => {
  it("treats credentials, query state, fragments, and sensitive paths as unsafe for weak reuse", () => {
    expect(isSensitiveOrStatefulUrl("https://u:p@example.com/")).toBe(true);
    expect(isSensitiveOrStatefulUrl("https://example.com/?draft=1")).toBe(true);
    expect(isSensitiveOrStatefulUrl("https://example.com/#compose")).toBe(true);
    expect(
      isSensitiveOrStatefulUrl("https://example.com/checkout/review"),
    ).toBe(true);
    expect(isSensitiveOrStatefulUrl("https://example.com/docs")).toBe(false);
  });
});
