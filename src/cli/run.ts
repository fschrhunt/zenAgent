import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  BrowserSpace,
  BrowserSpaceId,
  Observation,
} from "../browser/model.js";
import { mapDiscoveredSpaces, SpaceMappingError } from "../config/discovery.js";
import { configPath } from "../config/path.js";
import {
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  parseConfig,
  type ZenAgentConfig,
} from "../config/schema.js";
import { DaemonClient } from "../daemon/client.js";
import { DaemonDiscoveryError, discoverDaemonSocket } from "../daemon/paths.js";
import {
  DaemonProtocolError,
  type DaemonErrorCode,
  type DaemonMethod,
} from "../daemon/protocol.js";
import { ZEN_AGENT_VERSION } from "../index.js";
import {
  inspectNativeHostInstallation,
  installNativeHost,
  uninstallNativeHost,
  type NativeHostInstallation,
  type NativeHostInstallOptions,
  type NativeHostInstallResult,
  type NativeHostUninstallResult,
} from "../native/install.js";
import { readOptionalConfig, writeConfig } from "./config-file.js";
import {
  EntityReferenceError,
  formatEntityReference,
  parseSpaceReference,
} from "./entity-reference.js";
import { runSetupWizard, type SetupWizardServices } from "./wizard.js";
import { createTerminalWizardUi } from "./wizard-ui.js";

const EXTENSION_MANIFEST_PATH = fileURLToPath(
  new URL("../../extension/manifest.json", import.meta.url),
);

export const CLI_EXIT_CODES = {
  success: 0,
  internal: 1,
  invalidInput: 2,
  ambiguity: 3,
  staleId: 4,
  browserUnavailable: 5,
  unsupportedCapability: 6,
  timeout: 7,
  policyRejection: 8,
} as const;

const HELP = `zen-agent ${ZEN_AGENT_VERSION}

Setup and maintenance for Zen Agent.

Usage:
  zen-agent
  zen-agent <command> [options]

Commands:
  setup                 Open the interactive setup wizard
  status                Report sanitized daemon and browser health
  spaces list           List discovered Spaces without selecting them
  config map            Map discovered Space IDs in the local configuration
  native-host install   Register the per-user native messaging host
  native-host uninstall Remove files created by the native-host installer
  help                  Show this help
  version               Print the version

Global options:
  --json             Emit one stable JSON result
  -h, --help         Show help
  -v, --version      Print the version

Running zen-agent in an interactive terminal opens the setup wizard.
Agents and scripts should use explicit commands and --json where supported.
Browser automation is exposed through the MCP server, not this setup utility.
No command focuses Zen, selects a tab, or switches the visible Space.
`;

const STATUS_HELP = `Usage:
  zen-agent status [--json]

Side effects:
  None. Reads sanitized daemon and browser connection state.
`;

const SPACES_HELP = `Usage:
  zen-agent spaces list [--json]

Side effects:
  None. Discovers Spaces without selecting one or changing visible browser state.
`;

const CONFIG_HELP = `Usage:
  zen-agent config map [--personal <opaque-space-id>]
                       [--work <opaque-space-id>]
                       [--alias <name>=<opaque-space-id>]...
                       [--profile <profile-id>] [--config <path>] [--json]

Side effects:
  Discovers Spaces without selecting them, then atomically creates or updates
  the local configuration file. Existing routing rules are preserved.
`;

const NATIVE_HOST_HELP = `Usage:
  zen-agent native-host install [--host-path <absolute-path>]
  zen-agent native-host uninstall

Side effects:
  install creates an owner-only launcher under ~/Library/Application Support/
  and a manifest under Mozilla/NativeMessagingHosts. It never overwrites files.
  uninstall removes only files recognisably created by Zen Agent.
`;

type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

interface CliDaemonClient {
  connect(): Promise<void>;
  request(
    method: DaemonMethod,
    params?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown>;
  close(): void;
}

export interface CliDependencies {
  readonly inspectNativeHost: () => NativeHostInstallation;
  readonly installNativeHost: (
    options?: NativeHostInstallOptions,
  ) => NativeHostInstallResult;
  readonly uninstallNativeHost: () => NativeHostUninstallResult;
  readonly createDaemonClient: (
    profileId: string | undefined,
  ) => CliDaemonClient | Promise<CliDaemonClient>;
  readonly readConfig: (path: string) => Promise<ZenAgentConfig | undefined>;
  readonly writeConfig: (path: string, config: ZenAgentConfig) => Promise<void>;
  readonly configPath: () => string;
  readonly isInteractive: () => boolean;
  readonly startSetupWizard: (services: SetupWizardServices) => Promise<void>;
}

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

class CliInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

function defaultDependencies(
  overrides: Partial<CliDependencies>,
): CliDependencies {
  return {
    inspectNativeHost:
      overrides.inspectNativeHost ?? inspectNativeHostInstallation,
    installNativeHost: overrides.installNativeHost ?? installNativeHost,
    uninstallNativeHost: overrides.uninstallNativeHost ?? uninstallNativeHost,
    createDaemonClient:
      overrides.createDaemonClient ??
      (async (profileId) =>
        new DaemonClient({
          socketPath: await discoverDaemonSocket(profileId),
        })),
    readConfig: overrides.readConfig ?? readOptionalConfig,
    writeConfig: overrides.writeConfig ?? writeConfig,
    configPath: overrides.configPath ?? configPath,
    isInteractive:
      overrides.isInteractive ??
      (() => process.stdin.isTTY === true && process.stdout.isTTY === true),
    startSetupWizard:
      overrides.startSetupWizard ??
      ((services) =>
        runSetupWizard({
          version: ZEN_AGENT_VERSION,
          extensionManifestPath: EXTENSION_MANIFEST_PATH,
          services,
          ui: createTerminalWizardUi(),
        })),
  };
}

function parseArguments(
  args: readonly string[],
  booleanOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
  repeatableOptions: ReadonlySet<string> = new Set(),
): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === undefined) {
      continue;
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    if (booleanOptions.has(argument)) {
      if (flags.has(argument)) {
        throw new CliInputError(
          `Option ${argument} may be supplied only once.`,
        );
      }

      flags.add(argument);
      continue;
    }

    if (!valueOptions.has(argument)) {
      throw new CliInputError(`Unknown option ${argument}.`);
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new CliInputError(`Option ${argument} requires a value.`);
    }

    const existing = values.get(argument) ?? [];

    if (existing.length > 0 && !repeatableOptions.has(argument)) {
      throw new CliInputError(`Option ${argument} may be supplied only once.`);
    }

    existing.push(value);
    values.set(argument, existing);
    index += 1;
  }

  return { positionals, flags, values };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.values.get(name)?.[0];
}

function requirePositionals(
  parsed: ParsedArguments,
  count: number,
  usage: string,
): void {
  if (parsed.positionals.length !== count) {
    throw new CliInputError(usage);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entitiesResult(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value["entities"])) {
    throw new Error("The daemon returned a malformed registry result.");
  }

  return value["entities"];
}

function isObservation<T>(
  value: unknown,
  knownValue: (candidate: unknown) => candidate is T,
): value is Observation<T> {
  if (!isRecord(value) || typeof value["status"] !== "string") {
    return false;
  }

  return (
    (value["status"] === "known" && knownValue(value["value"])) ||
    (value["status"] === "unknown" && typeof value["reason"] === "string") ||
    (value["status"] === "unsupported" &&
      typeof value["capability"] === "string")
  );
}

function isSessionScopedId(value: unknown, kind: string): boolean {
  if (
    !isRecord(value) ||
    value["kind"] !== kind ||
    typeof value["transportId"] !== "string" ||
    !isRecord(value["sessionId"])
  ) {
    return false;
  }

  const session = value["sessionId"];
  return (
    session["kind"] === "session" &&
    typeof session["transportId"] === "string" &&
    isRecord(session["profileId"]) &&
    session["profileId"]["kind"] === "profile" &&
    typeof session["profileId"]["transportId"] === "string"
  );
}

function isSpaceId(value: unknown): value is BrowserSpaceId {
  return isSessionScopedId(value, "space");
}

function isSpace(value: unknown): value is BrowserSpace {
  return (
    isRecord(value) &&
    value["kind"] === "space" &&
    isSpaceId(value["id"]) &&
    isSessionScopedId(value["windowId"], "window") &&
    isObservation(
      value["name"],
      (candidate): candidate is string => typeof candidate === "string",
    ) &&
    isObservation(
      value["order"],
      (candidate): candidate is number => typeof candidate === "number",
    ) &&
    isObservation(
      value["containerId"],
      (candidate): candidate is string | null =>
        candidate === null || typeof candidate === "string",
    )
  );
}

function knownValue<T>(observation: Observation<T>): T | undefined {
  return observation.status === "known" ? observation.value : undefined;
}

function printableObservation<T>(
  observation: Observation<T>,
  render: (value: T) => string,
): string {
  switch (observation.status) {
    case "known":
      return render(observation.value);
    case "unknown":
      return `<unknown:${observation.reason}>`;
    case "unsupported":
      return `<unsupported:${observation.capability}>`;
  }
}

function jsonResult(command: string, result: unknown): void {
  process.stdout.write(
    `${JSON.stringify({ ok: true, command, result }, null, 2)}\n`,
  );
}

function writeResult(
  command: string,
  result: unknown,
  json: boolean,
  human: () => string,
): void {
  if (json) {
    jsonResult(command, result);
  } else {
    process.stdout.write(human());
  }
}

function scalarText(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function isInputError(error: unknown): boolean {
  return (
    error instanceof CliInputError ||
    error instanceof EntityReferenceError ||
    error instanceof ConfigValidationError ||
    error instanceof SpaceMappingError
  );
}

function errorExitCode(error: unknown): CliExitCode {
  if (error instanceof DaemonDiscoveryError) {
    return CLI_EXIT_CODES.ambiguity;
  }

  if (isInputError(error)) {
    return CLI_EXIT_CODES.invalidInput;
  }

  if (!(error instanceof DaemonProtocolError)) {
    return CLI_EXIT_CODES.internal;
  }

  if (
    error.code === "policy-rejection" &&
    error.data?.["reason"] === "conflicting-rules"
  ) {
    return CLI_EXIT_CODES.ambiguity;
  }

  const mapping: Readonly<Partial<Record<DaemonErrorCode, CliExitCode>>> = {
    "invalid-request": CLI_EXIT_CODES.invalidInput,
    "payload-too-large": CLI_EXIT_CODES.invalidInput,
    "stale-id": CLI_EXIT_CODES.staleId,
    "browser-unavailable": CLI_EXIT_CODES.browserUnavailable,
    "already-running": CLI_EXIT_CODES.browserUnavailable,
    "unsupported-capability": CLI_EXIT_CODES.unsupportedCapability,
    "method-not-found": CLI_EXIT_CODES.unsupportedCapability,
    "protocol-version-mismatch": CLI_EXIT_CODES.unsupportedCapability,
    timeout: CLI_EXIT_CODES.timeout,
    "policy-rejection": CLI_EXIT_CODES.policyRejection,
  };

  return mapping[error.code] ?? CLI_EXIT_CODES.internal;
}

function reportError(error: unknown, json: boolean): CliExitCode {
  const code = errorExitCode(error);
  const errorCode =
    error instanceof DaemonProtocolError
      ? error.code
      : error instanceof DaemonDiscoveryError
        ? error.code
        : isInputError(error)
          ? "invalid-input"
          : "internal";
  const message = error instanceof Error ? error.message : String(error);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code: errorCode,
            message,
            ...(error instanceof DaemonProtocolError && error.data !== undefined
              ? { data: error.data }
              : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`zen-agent: ${errorCode}: ${message}\n`);
  }

  return code;
}

async function configuredProfile(
  dependencies: CliDependencies,
): Promise<string | undefined> {
  const config = await dependencies.readConfig(dependencies.configPath());
  return config?.profile;
}

async function withDaemon<T>(
  profileId: string | undefined,
  dependencies: CliDependencies,
  operation: (client: CliDaemonClient) => Promise<T>,
): Promise<T> {
  const client = await dependencies.createDaemonClient(profileId);

  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    if (error instanceof DaemonProtocolError || isInputError(error)) {
      throw error;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ECONNREFUSED")
    ) {
      throw new DaemonProtocolError(
        "browser-unavailable",
        "The Zen Agent daemon is not available.",
      );
    }

    throw error;
  } finally {
    client.close();
  }
}

async function runStatus(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  if (args.includes("--help")) {
    process.stdout.write(STATUS_HELP);
    return CLI_EXIT_CODES.success;
  }

  const parsed = parseArguments(args, new Set(["--json"]), new Set());
  requirePositionals(parsed, 0, "Usage: zen-agent status [--json]");
  const json = parsed.flags.has("--json");
  const result = await readStatus(dependencies);

  writeResult("status", result, json, () => {
    if (!isRecord(result)) {
      throw new Error("The daemon returned a malformed status result.");
    }

    const state = scalarText(result["state"], "unknown");
    const profileId = scalarText(result["profileId"], "none");
    const sessionId = scalarText(result["sessionId"], "none");
    const counts = isRecord(result["counts"]) ? result["counts"] : {};
    return [
      `Daemon: ${state}`,
      `Profile: ${profileId}`,
      `Session: ${sessionId}`,
      `Spaces: ${scalarText(counts["spaces"], "0")}`,
      `Tabs: ${scalarText(counts["tabs"], "0")}`,
      "",
    ].join("\n");
  });
  return CLI_EXIT_CODES.success;
}

async function readStatus(dependencies: CliDependencies): Promise<unknown> {
  const profile = await configuredProfile(dependencies);
  return withDaemon(profile, dependencies, (client) =>
    client.request("status"),
  );
}

async function readSpaces(
  client: CliDaemonClient,
): Promise<readonly BrowserSpace[]> {
  const result = await client.request("registry.entities", { kind: "space" });
  const spaces = entitiesResult(result);

  if (!spaces.every(isSpace)) {
    throw new Error("The daemon returned a malformed Space.");
  }

  return spaces;
}

function publicSpace(space: BrowserSpace): Readonly<Record<string, unknown>> {
  return {
    id: formatEntityReference(space.id),
    transportId: space.id.transportId,
    name: space.name,
    windowId: space.windowId,
  };
}

async function runSpaces(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  if (args[0] === "--help" || args[0] === "help") {
    process.stdout.write(SPACES_HELP);
    return CLI_EXIT_CODES.success;
  }

  if (args[0] !== "list") {
    throw new CliInputError(SPACES_HELP.trimEnd());
  }

  const parsed = parseArguments(args.slice(1), new Set(["--json"]), new Set());
  requirePositionals(parsed, 0, "Usage: zen-agent spaces list [--json]");
  const json = parsed.flags.has("--json");
  const profile = await configuredProfile(dependencies);
  const spaces = await withDaemon(profile, dependencies, readSpaces);
  const publicSpaces = spaces.map(publicSpace);

  writeResult("spaces.list", publicSpaces, json, () => {
    if (spaces.length === 0) {
      return "No Spaces discovered.\n";
    }

    return `${spaces
      .map(
        (space) =>
          `${formatEntityReference(space.id)}\t${printableObservation(space.name, String)}`,
      )
      .join("\n")}\n`;
  });
  return CLI_EXIT_CODES.success;
}

function sameId(left: BrowserSpaceId, right: BrowserSpaceId): boolean {
  return (
    left.transportId === right.transportId &&
    left.sessionId.transportId === right.sessionId.transportId &&
    left.sessionId.profileId.transportId ===
      right.sessionId.profileId.transportId
  );
}

function parseAlias(value: string): readonly [string, string] {
  const separator = value.indexOf("=");

  if (separator <= 0 || separator === value.length - 1) {
    throw new CliInputError(
      "An alias must use the form <name>=<opaque-space-id>.",
    );
  }

  return [value.slice(0, separator), value.slice(separator + 1)];
}

interface ConfigMappingUpdate {
  readonly destination: string;
  readonly existing: ZenAgentConfig | undefined;
  readonly requestedProfile: string | undefined;
  readonly personalReference: BrowserSpaceId | undefined;
  readonly workReference: BrowserSpaceId | undefined;
  readonly aliases: Readonly<Record<string, string>>;
  readonly requestedReferences: readonly BrowserSpaceId[];
}

interface ConfigMappingUpdateResult {
  readonly path: string;
  readonly profile: string;
  readonly spaces: ZenAgentConfig["spaces"];
}

async function applyConfigMapping(
  update: ConfigMappingUpdate,
  dependencies: CliDependencies,
): Promise<ConfigMappingUpdateResult> {
  const defaultConfigPath = dependencies.configPath();
  const personal =
    update.personalReference?.transportId ?? update.existing?.spaces.personal;
  const work =
    update.workReference?.transportId ?? update.existing?.spaces.work;
  const discoveredResult = await withDaemon(
    update.requestedProfile,
    dependencies,
    async (client) => {
      const [spaces, status] = await Promise.all([
        readSpaces(client),
        client.request("status"),
      ]);
      return { spaces, status };
    },
  );
  const statusProfile =
    isRecord(discoveredResult.status) &&
    typeof discoveredResult.status["profileId"] === "string"
      ? discoveredResult.status["profileId"]
      : undefined;
  const profile = update.requestedProfile ?? statusProfile;

  if (profile === undefined) {
    throw new CliInputError(
      "The connected daemon did not report a profile; pass --profile explicitly.",
    );
  }

  for (const reference of update.requestedReferences) {
    if (!discoveredResult.spaces.some((space) => sameId(space.id, reference))) {
      throw new SpaceMappingError(
        "A requested Space ID is stale or was not returned by current discovery.",
      );
    }
  }

  const mappings = mapDiscoveredSpaces(
    discoveredResult.spaces.map((space) => {
      const name = knownValue(space.name);
      return {
        id: space.id.transportId,
        ...(name === undefined ? {} : { name }),
      };
    }),
    {
      ...(personal === undefined ? {} : { personal }),
      ...(work === undefined ? {} : { work }),
      aliases: update.aliases,
    },
  );
  const config = parseConfig({
    version: CONFIG_SCHEMA_VERSION,
    profile,
    spaces: mappings,
    routing: update.existing?.routing ?? { rules: [] },
  });
  await dependencies.writeConfig(update.destination, config);

  if (update.destination === defaultConfigPath) {
    await withDaemon(profile, dependencies, (client) =>
      client.request("config.reload", {}, `cli:config-reload:${randomUUID()}`),
    );
  }

  return { path: update.destination, profile, spaces: mappings };
}

async function runConfigMap(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const parsed = parseArguments(
    args,
    new Set(["--json"]),
    new Set(["--personal", "--work", "--alias", "--profile", "--config"]),
    new Set(["--alias"]),
  );
  requirePositionals(parsed, 0, CONFIG_HELP.trimEnd());
  const defaultConfigPath = dependencies.configPath();
  const destination = option(parsed, "--config") ?? defaultConfigPath;
  const existing = await dependencies.readConfig(destination);
  const requestedProfile = option(parsed, "--profile") ?? existing?.profile;
  const socketProfile = requestedProfile;
  const aliases = { ...(existing?.spaces.aliases ?? {}) };
  const requestedReferences: BrowserSpaceId[] = [];

  for (const rawAlias of parsed.values.get("--alias") ?? []) {
    const [name, reference] = parseAlias(rawAlias);
    const spaceId = parseSpaceReference(reference);
    requestedReferences.push(spaceId);
    aliases[name] = spaceId.transportId;
  }

  const personalReference =
    option(parsed, "--personal") === undefined
      ? undefined
      : parseSpaceReference(option(parsed, "--personal") ?? "");
  const workReference =
    option(parsed, "--work") === undefined
      ? undefined
      : parseSpaceReference(option(parsed, "--work") ?? "");
  if (personalReference !== undefined) {
    requestedReferences.push(personalReference);
  }
  if (workReference !== undefined) {
    requestedReferences.push(workReference);
  }

  const result = await applyConfigMapping(
    {
      destination,
      existing,
      requestedProfile: socketProfile,
      personalReference,
      workReference,
      aliases,
      requestedReferences,
    },
    dependencies,
  );
  const json = parsed.flags.has("--json");

  writeResult("config.map", result, json, () => {
    return [
      `Updated ${destination}`,
      `Profile: ${result.profile}`,
      `Personal: ${result.spaces.personal ?? "unmapped"}`,
      `Work: ${result.spaces.work ?? "unmapped"}`,
      `Aliases: ${String(Object.keys(result.spaces.aliases).length)}`,
      "",
    ].join("\n");
  });
  return CLI_EXIT_CODES.success;
}

function runNativeHostCommand(
  args: readonly string[],
  dependencies: CliDependencies,
): CliExitCode {
  const [action, ...options] = args;

  if (action === undefined || action === "help" || action === "--help") {
    process.stdout.write(NATIVE_HOST_HELP);
    return CLI_EXIT_CODES.success;
  }

  if (action === "install") {
    let result: NativeHostInstallResult;

    if (options.length === 0) {
      result = dependencies.installNativeHost();
    } else if (
      options.length === 2 &&
      options[0] === "--host-path" &&
      options[1] !== undefined
    ) {
      result = dependencies.installNativeHost({
        hostModulePath: options[1],
      });
    } else {
      throw new CliInputError(
        `Invalid native-host install options.\n\n${NATIVE_HOST_HELP}`,
      );
    }

    process.stdout.write(
      `Installed Zen Agent native messaging host.\nManifest: ${result.manifestPath}\nLauncher: ${result.launcherPath}\n`,
    );
    return CLI_EXIT_CODES.success;
  }

  if (action === "uninstall" && options.length === 0) {
    const result = dependencies.uninstallNativeHost();
    process.stdout.write(
      result.removed
        ? `Removed Zen Agent native messaging host.\nManifest: ${result.manifestPath}\nLauncher: ${result.launcherPath}\n`
        : "Zen Agent native messaging host is not installed.\n",
    );
    return CLI_EXIT_CODES.success;
  }

  throw new CliInputError(
    `Unknown native-host command: ${String(action)}\n\n${NATIVE_HOST_HELP}`,
  );
}

function statusForWizard(value: unknown): {
  readonly state: string;
  readonly profileId: string | null;
  readonly spaces: number;
  readonly tabs: number;
} {
  if (!isRecord(value)) {
    throw new Error("The daemon returned a malformed status result.");
  }

  const counts = isRecord(value["counts"]) ? value["counts"] : {};
  return {
    state: scalarText(value["state"], "unknown"),
    profileId:
      typeof value["profileId"] === "string" ? value["profileId"] : null,
    spaces: typeof counts["spaces"] === "number" ? counts["spaces"] : 0,
    tabs: typeof counts["tabs"] === "number" ? counts["tabs"] : 0,
  };
}

function wizardServices(dependencies: CliDependencies): SetupWizardServices {
  return {
    inspectNativeHost: dependencies.inspectNativeHost,
    installNativeHost: () => dependencies.installNativeHost(),
    uninstallNativeHost: dependencies.uninstallNativeHost,
    status: async () => statusForWizard(await readStatus(dependencies)),
    spaces: async () => {
      const profile = await configuredProfile(dependencies);
      const spaces = await withDaemon(profile, dependencies, readSpaces);
      return spaces.map((space, index) => ({
        id: space.id,
        name: knownValue(space.name) ?? `Unnamed Space ${String(index + 1)}`,
      }));
    },
    readConfig: () => dependencies.readConfig(dependencies.configPath()),
    mapSpaces: async (selection) => {
      const destination = dependencies.configPath();
      const existing = await dependencies.readConfig(destination);
      const requestedReferences = [selection.personal, selection.work].filter(
        (reference) => reference !== undefined,
      );
      const result = await applyConfigMapping(
        {
          destination,
          existing,
          requestedProfile: existing?.profile,
          personalReference: selection.personal,
          workReference: selection.work,
          aliases: { ...(existing?.spaces.aliases ?? {}) },
          requestedReferences,
        },
        dependencies,
      );
      return { path: result.path, profile: result.profile };
    },
  };
}

async function dispatch(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<CliExitCode> {
  const [command, ...rest] = args;

  if (command === undefined) {
    if (dependencies.isInteractive()) {
      await dependencies.startSetupWizard(wizardServices(dependencies));
    } else {
      process.stdout.write(HELP);
    }
    return CLI_EXIT_CODES.success;
  }

  if (command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return CLI_EXIT_CODES.success;
  }

  if (command === "version" || command === "-v" || command === "--version") {
    process.stdout.write(`${ZEN_AGENT_VERSION}\n`);
    return CLI_EXIT_CODES.success;
  }

  switch (command) {
    case "setup":
      if (rest.length > 0) {
        throw new CliInputError("Usage: zen-agent setup");
      }
      if (!dependencies.isInteractive()) {
        throw new CliInputError(
          "zen-agent setup requires an interactive terminal. Agents and scripts should use explicit commands and --json where supported.",
        );
      }
      await dependencies.startSetupWizard(wizardServices(dependencies));
      return CLI_EXIT_CODES.success;
    case "status":
      return runStatus(rest, dependencies);
    case "spaces":
      return runSpaces(rest, dependencies);
    case "config": {
      const [action, ...options] = rest;

      if (action === undefined || action === "help" || action === "--help") {
        process.stdout.write(CONFIG_HELP);
        return CLI_EXIT_CODES.success;
      }

      if (action !== "map") {
        throw new CliInputError(
          `Unknown config command: ${action}\n\n${CONFIG_HELP}`,
        );
      }

      return runConfigMap(options, dependencies);
    }
    case "native-host":
      return runNativeHostCommand(rest, dependencies);
    default:
      throw new CliInputError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

export async function runCli(
  args: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<CliExitCode> {
  const json = args.includes("--json");

  try {
    return await dispatch(args, defaultDependencies(overrides));
  } catch (error) {
    return reportError(error, json);
  }
}
