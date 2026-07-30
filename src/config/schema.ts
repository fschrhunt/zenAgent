import type { PrivateWindowPolicy } from "../browser/model.js";

export const CONFIG_SCHEMA_VERSION = 2 as const;
export const LEGACY_CONFIG_SCHEMA_VERSION = 1 as const;
export const DEFAULT_DOWNLOAD_DIRECTORY = "~/Downloads";

export type ConfigSchemaVersion =
  typeof LEGACY_CONFIG_SCHEMA_VERSION | typeof CONFIG_SCHEMA_VERSION;

export interface SpaceMappings {
  readonly personal?: string;
  readonly work?: string;
  readonly aliases: Readonly<Record<string, string>>;
}

export interface DomainRoutingRule {
  readonly id: string;
  readonly kind: "domain";
  readonly domain: string;
  readonly includeSubdomains: boolean;
  readonly space: string;
}

export interface UrlRoutingRule {
  readonly id: string;
  readonly kind: "url";
  readonly url: string;
  readonly match: "exact" | "prefix";
  readonly space: string;
}

export type RoutingRule = DomainRoutingRule | UrlRoutingRule;

export interface RoutingConfig {
  readonly rules: readonly RoutingRule[];
  readonly safeDefault?: string;
}

export interface DownloadConfig {
  readonly directory: string;
}

export interface BackgroundLaunchConfig {
  /**
   * Background launch is deliberately configuration-gated until a headed
   * safety proof accepts it.
   */
  readonly policy: "disabled";
}

export interface SpeechConfig {
  /** BCP-47 locales whose on-device model assets setup installed explicitly. */
  readonly installedLocales: readonly string[];
}

export interface ZenAgentConfig {
  readonly version: ConfigSchemaVersion;
  readonly profile: string;
  readonly spaces: SpaceMappings;
  readonly routing: RoutingConfig;
  /**
   * Version 1 values remain representable for source compatibility. Parsing or
   * writing configuration always migrates them to version 2.
   */
  readonly profileMatch?: "exact";
  readonly privateWindows?: PrivateWindowPolicy;
  readonly downloads?: DownloadConfig;
  readonly backgroundLaunch?: BackgroundLaunchConfig;
  readonly speech?: SpeechConfig;
}

export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigValidationIssue[];

  constructor(issues: readonly ConfigValidationIssue[]) {
    super(
      `Invalid Zen Agent configuration:\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const LEGACY_ROOT_KEYS = new Set(["version", "profile", "spaces", "routing"]);
const ROOT_KEYS = new Set([
  ...LEGACY_ROOT_KEYS,
  "profileMatch",
  "privateWindows",
  "downloads",
  "backgroundLaunch",
  "speech",
]);
const SPACE_KEYS = new Set(["personal", "work", "aliases"]);
const ROUTING_KEYS = new Set(["rules", "safeDefault"]);
const DOWNLOAD_KEYS = new Set(["directory"]);
const BACKGROUND_LAUNCH_KEYS = new Set(["policy"]);
const SPEECH_KEYS = new Set(["installedLocales"]);
const DOMAIN_RULE_KEYS = new Set([
  "id",
  "kind",
  "domain",
  "includeSubdomains",
  "space",
]);
const URL_RULE_KEYS = new Set(["id", "kind", "url", "match", "space"]);
const SPACE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: "is not a recognized field",
      });
    }
  }
}

function nonEmptyString(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return undefined;
  }

  if (value !== value.trim()) {
    issues.push({
      path,
      message: "must not have leading or trailing whitespace",
    });
    return undefined;
  }

  return value;
}

function spaceName(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): string | undefined {
  const name = nonEmptyString(value, path, issues);
  if (name === undefined) {
    return undefined;
  }

  if (!SPACE_NAME_PATTERN.test(name)) {
    issues.push({
      path,
      message:
        "must start with a lowercase letter and contain only lowercase letters, numbers, '-' or '_'",
    });
    return undefined;
  }

  return name;
}

function parseAliases(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object mapping aliases to IDs" });
    return {};
  }

  const aliases: Record<string, string> = {};
  for (const [rawAlias, rawId] of Object.entries(value)) {
    const alias = spaceName(rawAlias, `${path}.${rawAlias}`, issues);
    const id = nonEmptyString(rawId, `${path}.${rawAlias}`, issues);
    if (alias === "personal" || alias === "work") {
      issues.push({
        path: `${path}.${rawAlias}`,
        message: `'${alias}' is reserved for the corresponding role mapping`,
      });
      continue;
    }
    if (alias !== undefined && id !== undefined) {
      aliases[alias] = id;
    }
  }
  return aliases;
}

function parseSpaces(
  value: unknown,
  issues: ConfigValidationIssue[],
): SpaceMappings {
  if (!isRecord(value)) {
    issues.push({
      path: "$.spaces",
      message: "must be an object with stable Zen Space ID mappings",
    });
    return { aliases: {} };
  }

  reportUnknownKeys(value, SPACE_KEYS, "$.spaces", issues);
  const personal =
    value.personal === undefined
      ? undefined
      : nonEmptyString(value.personal, "$.spaces.personal", issues);
  const work =
    value.work === undefined
      ? undefined
      : nonEmptyString(value.work, "$.spaces.work", issues);
  const aliases = parseAliases(value.aliases, "$.spaces.aliases", issues);

  if (personal !== undefined && work !== undefined && personal === work) {
    issues.push({
      path: "$.spaces",
      message: "personal and work must map to different stable Space IDs",
    });
  }

  if (
    personal === undefined &&
    work === undefined &&
    Object.keys(aliases).length === 0
  ) {
    issues.push({
      path: "$.spaces",
      message:
        "must define at least one personal, work, or named Space mapping",
    });
  }

  return {
    ...(personal === undefined ? {} : { personal }),
    ...(work === undefined ? {} : { work }),
    aliases,
  };
}

function canonicalDomain(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): string | undefined {
  const domain = nonEmptyString(value, path, issues);
  if (domain === undefined) {
    return undefined;
  }

  if (
    domain !== domain.toLowerCase() ||
    domain.endsWith(".") ||
    domain.includes("*")
  ) {
    issues.push({
      path,
      message:
        "must be a lowercase hostname without a trailing dot or wildcard; use includeSubdomains instead",
    });
    return undefined;
  }

  try {
    const parsed = new URL(`http://${domain}`);
    if (
      parsed.hostname !== domain ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/"
    ) {
      throw new TypeError("not a bare hostname");
    }
  } catch {
    issues.push({
      path,
      message: "must be a valid bare hostname such as 'example.com'",
    });
    return undefined;
  }

  return domain;
}

function canonicalUrl(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): string | undefined {
  const url = nonEmptyString(value, path, issues);
  if (url === undefined) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push({
        path,
        message: "must use the http or https scheme",
      });
      return undefined;
    }
    if (parsed.href !== url) {
      issues.push({
        path,
        message: `must use its canonical form '${parsed.href}'`,
      });
      return undefined;
    }
  } catch {
    issues.push({ path, message: "must be a valid absolute URL" });
    return undefined;
  }

  return url;
}

function parseDomainRule(
  value: Readonly<Record<string, unknown>>,
  index: number,
  issues: ConfigValidationIssue[],
): DomainRoutingRule | undefined {
  const path = `$.routing.rules[${String(index)}]`;
  reportUnknownKeys(value, DOMAIN_RULE_KEYS, path, issues);
  const id = nonEmptyString(value.id, `${path}.id`, issues);
  const domain = canonicalDomain(value.domain, `${path}.domain`, issues);
  const space = spaceName(value.space, `${path}.space`, issues);
  let includeSubdomains = false;
  if (value.includeSubdomains !== undefined) {
    if (typeof value.includeSubdomains !== "boolean") {
      issues.push({
        path: `${path}.includeSubdomains`,
        message: "must be a boolean",
      });
    } else {
      includeSubdomains = value.includeSubdomains;
    }
  }

  if (id === undefined || domain === undefined || space === undefined) {
    return undefined;
  }
  return { id, kind: "domain", domain, includeSubdomains, space };
}

function parseUrlRule(
  value: Readonly<Record<string, unknown>>,
  index: number,
  issues: ConfigValidationIssue[],
): UrlRoutingRule | undefined {
  const path = `$.routing.rules[${String(index)}]`;
  reportUnknownKeys(value, URL_RULE_KEYS, path, issues);
  const id = nonEmptyString(value.id, `${path}.id`, issues);
  const url = canonicalUrl(value.url, `${path}.url`, issues);
  const space = spaceName(value.space, `${path}.space`, issues);
  const match =
    value.match === "exact" || value.match === "prefix"
      ? value.match
      : undefined;
  if (match === undefined) {
    issues.push({
      path: `${path}.match`,
      message: "must be either 'exact' or 'prefix'",
    });
  }

  if (
    id === undefined ||
    url === undefined ||
    space === undefined ||
    match === undefined
  ) {
    return undefined;
  }
  return { id, kind: "url", url, match, space };
}

function parseRules(
  value: unknown,
  issues: ConfigValidationIssue[],
): readonly RoutingRule[] {
  if (!Array.isArray(value)) {
    issues.push({ path: "$.routing.rules", message: "must be an array" });
    return [];
  }

  const rules: RoutingRule[] = [];
  const ids = new Set<string>();
  for (const [index, rawRule] of value.entries()) {
    const path = `$.routing.rules[${String(index)}]`;
    if (!isRecord(rawRule)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }

    let rule: RoutingRule | undefined;
    if (rawRule.kind === "domain") {
      rule = parseDomainRule(rawRule, index, issues);
    } else if (rawRule.kind === "url") {
      rule = parseUrlRule(rawRule, index, issues);
    } else {
      issues.push({
        path: `${path}.kind`,
        message: "must be either 'domain' or 'url'",
      });
    }

    if (rule !== undefined) {
      if (ids.has(rule.id)) {
        issues.push({
          path: `${path}.id`,
          message: `duplicates routing rule ID '${rule.id}'`,
        });
      } else {
        ids.add(rule.id);
        rules.push(rule);
      }
    }
  }
  return rules;
}

function hasSpaceReference(spaces: SpaceMappings, reference: string): boolean {
  return (
    (reference === "personal" && spaces.personal !== undefined) ||
    (reference === "work" && spaces.work !== undefined) ||
    Object.hasOwn(spaces.aliases, reference)
  );
}

function parseRouting(
  value: unknown,
  spaces: SpaceMappings,
  issues: ConfigValidationIssue[],
): RoutingConfig {
  if (!isRecord(value)) {
    issues.push({
      path: "$.routing",
      message: "must be an object containing rules and an optional safeDefault",
    });
    return { rules: [] };
  }

  reportUnknownKeys(value, ROUTING_KEYS, "$.routing", issues);
  const rules = parseRules(value.rules, issues);
  const safeDefault =
    value.safeDefault === undefined
      ? undefined
      : spaceName(value.safeDefault, "$.routing.safeDefault", issues);

  for (const [index, rule] of rules.entries()) {
    if (!hasSpaceReference(spaces, rule.space)) {
      issues.push({
        path: `$.routing.rules[${String(index)}].space`,
        message: `references unmapped Space name '${rule.space}'`,
      });
    }
  }
  if (safeDefault !== undefined && !hasSpaceReference(spaces, safeDefault)) {
    issues.push({
      path: "$.routing.safeDefault",
      message: `references unmapped Space name '${safeDefault}'`,
    });
  }

  return {
    rules,
    ...(safeDefault === undefined ? {} : { safeDefault }),
  };
}

function parseDownloads(
  value: unknown,
  issues: ConfigValidationIssue[],
): DownloadConfig {
  if (!isRecord(value)) {
    issues.push({
      path: "$.downloads",
      message: "must be an object containing a download directory",
    });
    return { directory: DEFAULT_DOWNLOAD_DIRECTORY };
  }

  reportUnknownKeys(value, DOWNLOAD_KEYS, "$.downloads", issues);
  return {
    directory:
      nonEmptyString(value.directory, "$.downloads.directory", issues) ??
      DEFAULT_DOWNLOAD_DIRECTORY,
  };
}

function parseBackgroundLaunch(
  value: unknown,
  issues: ConfigValidationIssue[],
): BackgroundLaunchConfig {
  if (!isRecord(value)) {
    issues.push({
      path: "$.backgroundLaunch",
      message: "must be an object containing the launch policy",
    });
    return { policy: "disabled" };
  }

  reportUnknownKeys(
    value,
    BACKGROUND_LAUNCH_KEYS,
    "$.backgroundLaunch",
    issues,
  );
  if (value.policy !== "disabled") {
    issues.push({
      path: "$.backgroundLaunch.policy",
      message:
        "must be 'disabled' until background launch passes its headed safety proof",
    });
  }
  return { policy: "disabled" };
}

function canonicalLocale(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): string | undefined {
  const locale = nonEmptyString(value, path, issues);
  if (locale === undefined) {
    return undefined;
  }

  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    if (canonical === undefined || canonical !== locale) {
      issues.push({
        path,
        message: `must be a canonical BCP-47 locale${
          canonical === undefined ? "" : ` such as '${canonical}'`
        }`,
      });
      return undefined;
    }
  } catch {
    issues.push({ path, message: "must be a valid BCP-47 locale" });
    return undefined;
  }

  return locale;
}

function parseSpeech(
  value: unknown,
  issues: ConfigValidationIssue[],
): SpeechConfig {
  if (!isRecord(value)) {
    issues.push({
      path: "$.speech",
      message: "must be an object containing installedLocales",
    });
    return { installedLocales: [] };
  }

  reportUnknownKeys(value, SPEECH_KEYS, "$.speech", issues);
  if (!Array.isArray(value.installedLocales)) {
    issues.push({
      path: "$.speech.installedLocales",
      message: "must be an array of canonical BCP-47 locales",
    });
    return { installedLocales: [] };
  }

  const installedLocales: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawLocale] of value.installedLocales.entries()) {
    const path = `$.speech.installedLocales[${String(index)}]`;
    const locale = canonicalLocale(rawLocale, path, issues);
    if (locale === undefined) {
      continue;
    }
    if (seen.has(locale)) {
      issues.push({ path, message: `duplicates locale '${locale}'` });
      continue;
    }
    seen.add(locale);
    installedLocales.push(locale);
  }
  return { installedLocales };
}

function currentConfig(
  profile: string,
  spaces: SpaceMappings,
  routing: RoutingConfig,
  settings: {
    readonly privateWindows: PrivateWindowPolicy;
    readonly downloads: DownloadConfig;
    readonly backgroundLaunch: BackgroundLaunchConfig;
    readonly speech: SpeechConfig;
  },
): ZenAgentConfig {
  return {
    version: CONFIG_SCHEMA_VERSION,
    profile,
    profileMatch: "exact",
    privateWindows: settings.privateWindows,
    downloads: settings.downloads,
    backgroundLaunch: settings.backgroundLaunch,
    speech: settings.speech,
    spaces,
    routing,
  };
}

export function parseConfig(value: unknown): ZenAgentConfig {
  const issues: ConfigValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new ConfigValidationError([
      { path: "$", message: "must be a JSON object" },
    ]);
  }

  const legacy = value.version === LEGACY_CONFIG_SCHEMA_VERSION;
  reportUnknownKeys(value, legacy ? LEGACY_ROOT_KEYS : ROOT_KEYS, "$", issues);
  if (!legacy && value.version !== CONFIG_SCHEMA_VERSION) {
    issues.push({
      path: "$.version",
      message: `must equal schema version ${String(LEGACY_CONFIG_SCHEMA_VERSION)} or ${String(CONFIG_SCHEMA_VERSION)}`,
    });
  }
  const profile = nonEmptyString(value.profile, "$.profile", issues);
  const spaces = parseSpaces(value.spaces, issues);
  const routing = parseRouting(value.routing, spaces, issues);
  let privateWindows: PrivateWindowPolicy = "hidden";
  let downloads: DownloadConfig = {
    directory: DEFAULT_DOWNLOAD_DIRECTORY,
  };
  let backgroundLaunch: BackgroundLaunchConfig = { policy: "disabled" };
  let speech: SpeechConfig = { installedLocales: [] };

  if (!legacy) {
    if (value.profileMatch !== "exact") {
      issues.push({
        path: "$.profileMatch",
        message: "must be 'exact'",
      });
    }
    if (
      value.privateWindows !== "hidden" &&
      value.privateWindows !== "explicit"
    ) {
      issues.push({
        path: "$.privateWindows",
        message: "must be either 'hidden' or 'explicit'",
      });
    } else {
      privateWindows = value.privateWindows;
    }
    downloads = parseDownloads(value.downloads, issues);
    backgroundLaunch = parseBackgroundLaunch(value.backgroundLaunch, issues);
    speech = parseSpeech(value.speech, issues);
  }

  if (issues.length > 0 || profile === undefined) {
    throw new ConfigValidationError(issues);
  }

  return currentConfig(profile, spaces, routing, {
    privateWindows,
    downloads,
    backgroundLaunch,
    speech,
  });
}

export function parseConfigJson(json: string): ZenAgentConfig {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ConfigValidationError([
      { path: "$", message: `is not valid JSON: ${detail}` },
    ]);
  }
  return parseConfig(value);
}
