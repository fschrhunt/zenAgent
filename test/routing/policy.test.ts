import { describe, expect, it } from "vitest";

import { parseConfig, type ZenAgentConfig } from "../../src/config/schema.js";
import { routeSpace } from "../../src/routing/policy.js";

function configFixture(): ZenAgentConfig {
  return parseConfig({
    version: 1,
    profile: "profile-daily",
    spaces: {
      personal: "space-personal",
      work: "space-work",
      aliases: {
        research: "space-research",
      },
    },
    routing: {
      rules: [
        {
          id: "work-example",
          kind: "domain",
          domain: "work.example",
          includeSubdomains: true,
          space: "work",
        },
        {
          id: "personal-calendar",
          kind: "url",
          url: "https://work.example/personal/",
          match: "prefix",
          space: "personal",
        },
      ],
      safeDefault: "research",
    },
  });
}

describe("Personal/Work routing policy", () => {
  it("gives an explicit stable Space ID highest precedence", () => {
    const decision = routeSpace(configFixture(), {
      url: "https://work.example/project",
      override: { kind: "space-id", spaceId: "space-direct" },
      taskContext: "work",
    });

    expect(decision).toMatchObject({
      status: "resolved",
      profileId: "profile-daily",
      spaceId: "space-direct",
      source: "explicit-space-id",
      matchedRuleIds: [],
    });
  });

  it("resolves explicit Personal, Work, and named aliases", () => {
    expect(
      routeSpace(configFixture(), {
        override: { kind: "name", name: "personal" },
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-personal",
      source: "explicit-space-name",
    });
    expect(
      routeSpace(configFixture(), {
        override: { kind: "name", name: "work" },
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-work",
    });
    expect(
      routeSpace(configFixture(), {
        override: { kind: "name", name: "research" },
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-research",
    });
  });

  it("prefers exact and longest URL rules over domain rules", () => {
    const config = parseConfig({
      version: 1,
      profile: "daily",
      spaces: {
        personal: "space-personal",
        work: "space-work",
        aliases: { research: "space-research" },
      },
      routing: {
        rules: [
          {
            id: "domain",
            kind: "domain",
            domain: "example.com",
            includeSubdomains: true,
            space: "work",
          },
          {
            id: "short-prefix",
            kind: "url",
            url: "https://docs.example.com/",
            match: "prefix",
            space: "personal",
          },
          {
            id: "long-prefix",
            kind: "url",
            url: "https://docs.example.com/research/",
            match: "prefix",
            space: "research",
          },
          {
            id: "exact",
            kind: "url",
            url: "https://docs.example.com/research/index.html",
            match: "exact",
            space: "work",
          },
        ],
      },
    });

    expect(
      routeSpace(config, {
        url: "https://docs.example.com/research/other.html",
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-research",
      matchedRuleIds: ["long-prefix"],
    });
    expect(
      routeSpace(config, {
        url: "https://docs.example.com/research/index.html",
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-work",
      matchedRuleIds: ["exact"],
    });
  });

  it("never lets a URL prefix cross an origin boundary", () => {
    const config = parseConfig({
      version: 1,
      profile: "daily",
      spaces: { work: "w" },
      routing: {
        rules: [
          {
            id: "trusted-prefix",
            kind: "url",
            url: "https://example.com/",
            match: "prefix",
            space: "work",
          },
        ],
      },
    });

    expect(
      routeSpace(config, { url: "https://example.com.evil.invalid/" }),
    ).toMatchObject({
      status: "unresolved",
      code: "no-route",
    });
    expect(
      routeSpace(config, { url: "https://example.com/project" }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "w",
    });
  });

  it("uses the most-specific matching configured domain", () => {
    const config = parseConfig({
      version: 1,
      profile: "daily",
      spaces: { personal: "p", work: "w" },
      routing: {
        rules: [
          {
            id: "parent",
            kind: "domain",
            domain: "example.com",
            includeSubdomains: true,
            space: "personal",
          },
          {
            id: "child",
            kind: "domain",
            domain: "work.example.com",
            includeSubdomains: true,
            space: "work",
          },
        ],
      },
    });

    expect(
      routeSpace(config, { url: "https://deep.work.example.com/page" }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "w",
      matchedRuleIds: ["child"],
    });
  });

  it("fails loudly when equally specific rules conflict", () => {
    const config = parseConfig({
      version: 1,
      profile: "daily",
      spaces: { personal: "p", work: "w" },
      routing: {
        rules: [
          {
            id: "first",
            kind: "domain",
            domain: "github.com",
            space: "personal",
          },
          {
            id: "second",
            kind: "domain",
            domain: "github.com",
            space: "work",
          },
        ],
        safeDefault: "personal",
      },
    });

    const decision = routeSpace(config, { url: "https://github.com/openai" });
    expect(decision).toMatchObject({
      status: "ambiguous",
      code: "conflicting-rules",
      candidates: [
        { spaceId: "p", ruleIds: ["first"] },
        { spaceId: "w", ruleIds: ["second"] },
      ],
    });
  });

  it("does not treat duplicate matches to the same stable ID as ambiguous", () => {
    const config = parseConfig({
      version: 1,
      profile: "daily",
      spaces: {
        personal: "same",
        aliases: { home: "same" },
      },
      routing: {
        rules: [
          {
            id: "one",
            kind: "domain",
            domain: "example.com",
            space: "personal",
          },
          {
            id: "two",
            kind: "domain",
            domain: "example.com",
            space: "home",
          },
        ],
      },
    });

    expect(routeSpace(config, { url: "https://example.com/" })).toMatchObject({
      status: "resolved",
      spaceId: "same",
      matchedRuleIds: ["one", "two"],
    });
  });

  it("uses task context after rules and before the safe default", () => {
    expect(
      routeSpace(configFixture(), {
        url: "https://unconfigured.example/",
        taskContext: "work",
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-work",
      source: "task-context",
    });
    expect(
      routeSpace(configFixture(), {
        url: "https://unconfigured.example/",
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-research",
      source: "safe-default",
    });
  });

  it("fails on unknown explicit and task-context mappings", () => {
    expect(
      routeSpace(configFixture(), {
        override: { kind: "name", name: "missing" },
      }),
    ).toMatchObject({
      status: "unresolved",
      code: "unknown-space-name",
    });
    expect(
      routeSpace(configFixture(), { taskContext: "missing" }),
    ).toMatchObject({
      status: "unresolved",
      code: "unknown-space-name",
    });
    expect(
      routeSpace(configFixture(), { taskContext: "constructor" }),
    ).toMatchObject({
      status: "unresolved",
      code: "unknown-space-name",
    });
  });

  it("never invents a GitHub Personal/Work policy", () => {
    const noRules: ZenAgentConfig = {
      version: 1,
      profile: "daily",
      spaces: {
        personal: "p",
        work: "w",
        aliases: {},
      },
      routing: { rules: [] },
    };

    expect(
      routeSpace(noRules, { url: "https://github.com/openai" }),
    ).toMatchObject({
      status: "unresolved",
      code: "no-route",
    });
  });

  it("returns a complete machine-readable dry-run explanation", () => {
    const decision = routeSpace(configFixture(), {
      url: "https://work.example/project",
      taskContext: "personal",
    });

    expect(decision).toMatchObject({
      status: "resolved",
      source: "url-rule",
      matchedRuleIds: ["work-example"],
      explanation: [
        { stage: "explicit-override", outcome: "not-provided" },
        {
          stage: "url-rules",
          outcome: "selected",
          ruleIds: ["work-example"],
        },
        { stage: "task-context", outcome: "superseded" },
        { stage: "safe-default", outcome: "superseded" },
      ],
    });
  });

  it("reports malformed URLs unless an explicit override already resolved", () => {
    expect(routeSpace(configFixture(), { url: "not a url" })).toMatchObject({
      status: "unresolved",
      code: "invalid-url",
    });
    expect(
      routeSpace(configFixture(), {
        url: "not a url",
        override: { kind: "name", name: "work" },
      }),
    ).toMatchObject({
      status: "resolved",
      spaceId: "space-work",
    });
  });
});
