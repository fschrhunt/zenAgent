import { describe, expect, it } from "vitest";

import {
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  parseConfig,
  parseConfigJson,
  type ZenAgentConfig,
} from "../../src/config/schema.js";

function configFixture(): ZenAgentConfig {
  return parseConfig({
    version: CONFIG_SCHEMA_VERSION,
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

describe("configuration schema", () => {
  it("parses a versioned config with explicit profile and stable Space IDs", () => {
    expect(configFixture()).toEqual({
      version: 1,
      profile: "profile-daily",
      spaces: {
        personal: "space-personal",
        work: "space-work",
        aliases: { research: "space-research" },
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
  });

  it("reports actionable paths for schema and reference errors", () => {
    expect(() =>
      parseConfig({
        version: 99,
        profile: "",
        extra: true,
        spaces: {
          personal: "same",
          work: "same",
          aliases: { Personal: "space-other" },
        },
        routing: {
          rules: [
            {
              id: "bad-domain",
              kind: "domain",
              domain: "HTTPS://GitHub.com/*",
              includeSubdomains: "yes",
              space: "missing",
            },
          ],
          safeDefault: "also-missing",
        },
      }),
    ).toThrowError(ConfigValidationError);

    try {
      parseConfig({
        version: 99,
        profile: "",
        extra: true,
        spaces: {
          personal: "same",
          work: "same",
          aliases: { Personal: "space-other" },
        },
        routing: {
          rules: [],
          safeDefault: "missing",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      if (error instanceof ConfigValidationError) {
        expect(error.issues.map((issue) => issue.path)).toEqual(
          expect.arrayContaining([
            "$.version",
            "$.profile",
            "$.extra",
            "$.spaces",
            "$.spaces.aliases.Personal",
            "$.routing.safeDefault",
          ]),
        );
      }
    }
  });

  it("rejects unknown fields rather than silently ignoring misspellings", () => {
    const raw = {
      version: 1,
      profile: "daily",
      spaces: { personal: "space-personal", aliases: {} },
      routing: {
        rules: [
          {
            id: "rule",
            kind: "domain",
            domain: "example.com",
            includeSubdomains: true,
            space: "personal",
            subdomains: true,
          },
        ],
      },
    };

    expect(() => parseConfig(raw)).toThrow("$.routing.rules[0].subdomains");
  });

  it("rejects duplicate rule IDs and unmapped rule targets", () => {
    expect(() =>
      parseConfig({
        version: 1,
        profile: "daily",
        spaces: { personal: "space-personal" },
        routing: {
          rules: [
            {
              id: "duplicate",
              kind: "domain",
              domain: "example.com",
              space: "personal",
            },
            {
              id: "duplicate",
              kind: "url",
              url: "https://example.com/",
              match: "exact",
              space: "missing",
            },
          ],
        },
      }),
    ).toThrow(/duplicates routing rule ID 'duplicate'/);

    expect(() =>
      parseConfig({
        version: 1,
        profile: "daily",
        spaces: { personal: "space-personal" },
        routing: {
          rules: [
            {
              id: "unmapped",
              kind: "domain",
              domain: "example.com",
              space: "missing",
            },
          ],
        },
      }),
    ).toThrow(/references unmapped Space name 'missing'/);
  });

  it("requires canonical domains and URLs", () => {
    expect(() =>
      parseConfig({
        version: 1,
        profile: "daily",
        spaces: { personal: "space-personal" },
        routing: {
          rules: [
            {
              id: "upper",
              kind: "domain",
              domain: "Example.com",
              space: "personal",
            },
            {
              id: "url",
              kind: "url",
              url: "https://example.com",
              match: "exact",
              space: "personal",
            },
          ],
        },
      }),
    ).toThrow(/must use its canonical form 'https:\/\/example.com\/'/);
  });

  it("wraps malformed JSON in a configuration validation error", () => {
    expect(() => parseConfigJson("{ nope")).toThrow(
      /Invalid Zen Agent configuration:[\s\S]*not valid JSON/,
    );
  });

  it("does not allow personal and work to silently identify one Space", () => {
    expect(() =>
      parseConfig({
        version: 1,
        profile: "daily",
        spaces: { personal: "one", work: "one" },
        routing: { rules: [] },
      }),
    ).toThrow(/personal and work must map to different stable Space IDs/);
  });
});
