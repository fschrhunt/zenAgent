import { describe, expect, it } from "vitest";
import { known, unknown, type BrowserTab } from "../../src/browser/model.js";
import { matchTab, validateMatchRequest } from "../../src/resolution/match.js";
import { browserFixture } from "../browser/fixtures.js";

function tabAt(url: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  const fixture = browserFixture();
  return {
    ...fixture.tab,
    url: known(url),
    ...overrides,
  };
}

describe("tab matching", () => {
  it("ranks raw exact matches above normalized URL matches", () => {
    const exact = matchTab(tabAt("https://EXAMPLE.com"), {
      url: "https://EXAMPLE.com",
    });
    const normalized = matchTab(tabAt("https://example.com/"), {
      url: "https://EXAMPLE.com",
    });

    expect(exact).toMatchObject({
      status: "matched",
      best: { rule: "exact-url", strength: 600 },
    });
    expect(normalized).toMatchObject({
      status: "matched",
      best: { rule: "normalized-url", strength: 500 },
    });
  });

  it("supports explicitly requested origin and domain matches", () => {
    expect(
      matchTab(tabAt("https://docs.example.com/guide"), {
        url: "https://www.example.com/home",
        domain: "example.com",
        rules: ["domain"],
      }),
    ).toMatchObject({
      status: "matched",
      best: { rule: "domain" },
    });

    expect(
      matchTab(tabAt("https://example.com/guide"), {
        url: "https://example.com/home",
        rules: ["origin"],
      }),
    ).toMatchObject({
      status: "matched",
      best: { rule: "origin" },
    });
  });

  it("supports exact title and caller-provided text query matches", () => {
    const tab = tabAt("https://example.com/docs", {
      title: known("Zen Agent Guide"),
    });

    expect(
      matchTab(tab, {
        url: "https://elsewhere.test/",
        title: "zen agent guide",
        rules: ["title"],
      }),
    ).toMatchObject({
      status: "matched",
      best: { rule: "title" },
    });
    expect(
      matchTab(tab, {
        url: "https://elsewhere.test/",
        query: "agent",
        rules: ["query"],
      }),
    ).toMatchObject({
      status: "matched",
      best: { rule: "query" },
    });
  });

  it("refuses weak reuse when either URL is sensitive or cannot be observed", () => {
    expect(
      matchTab(tabAt("https://example.com/checkout"), {
        url: "https://example.com/",
        rules: ["origin"],
      }),
    ).toMatchObject({
      status: "not-matched",
      reason: "sensitive-weak-match-refused",
    });

    expect(
      matchTab(
        tabAt("https://example.com/", {
          url: unknown("not-loaded"),
          title: known("Example"),
        }),
        {
          url: "https://example.com/",
          title: "Example",
          rules: ["title"],
        },
      ),
    ).toMatchObject({
      status: "not-matched",
      reason: "sensitive-weak-match-refused",
    });
  });

  it("allows exact sensitive URLs and requires an explicit override for weak matching", () => {
    const tab = tabAt("https://example.com/checkout?order=123");

    expect(
      matchTab(tab, {
        url: "https://example.com/checkout?order=123",
      }),
    ).toMatchObject({
      status: "matched",
      best: { rule: "exact-url" },
      sensitiveOrStateful: true,
    });
    expect(
      matchTab(tab, {
        url: "https://example.com/checkout?order=456",
        rules: ["origin"],
        allowSensitiveWeakMatch: true,
      }),
    ).toMatchObject({
      status: "matched",
      best: { rule: "origin" },
      sensitiveOrStateful: true,
    });
  });

  it("excludes crashed tabs but permits exact matching discarded tabs", () => {
    expect(
      matchTab(tabAt("https://example.com/", { lifecycleState: "crashed" }), {
        url: "https://example.com/",
      }),
    ).toMatchObject({ status: "not-matched", reason: "crashed" });
    expect(
      matchTab(tabAt("https://example.com/", { lifecycleState: "discarded" }), {
        url: "https://example.com/",
      }),
    ).toMatchObject({ status: "matched" });
  });

  it("validates optional matching inputs before discovery", () => {
    expect(() =>
      validateMatchRequest({
        url: "https://example.com/",
        rules: [],
      }),
    ).toThrow(/At least one/u);
    expect(() =>
      validateMatchRequest({
        url: "https://example.com/",
        rules: ["title"],
      }),
    ).toThrow(/requires a non-empty title/u);
    expect(() =>
      validateMatchRequest({
        url: "https://example.com/",
        rules: ["query"],
        query: " ",
      }),
    ).toThrow(/requires a non-empty query/u);
  });
});
