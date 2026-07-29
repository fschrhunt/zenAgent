import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { parseConfigJson, type ZenAgentConfig } from "./schema.js";

export const ZEN_AGENT_CONFIG_ENV = "ZEN_AGENT_CONFIG";

export interface ConfigPathOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly currentDirectory?: string;
}

export function configPath(options: ConfigPathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const override = environment[ZEN_AGENT_CONFIG_ENV];
  if (override !== undefined && override.trim().length > 0) {
    return isAbsolute(override)
      ? override
      : resolve(currentDirectory, override);
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "zen-agent",
      "config.json",
    );
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome === undefined || xdgConfigHome.trim().length === 0
      ? join(homeDirectory, ".config")
      : xdgConfigHome;
  return join(configHome, "zen-agent", "config.json");
}

export async function loadConfig(path = configPath()): Promise<ZenAgentConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Could not read Zen Agent configuration at '${path}': ${detail}`,
      { cause: error },
    );
  }

  try {
    return parseConfigJson(contents);
  } catch (error) {
    if (error instanceof Error) {
      error.message = `Configuration '${path}' is invalid. ${error.message}`;
    }
    throw error;
  }
}

/** Load the validated config when present; absence is a supported bootstrap state. */
export async function loadOptionalConfig(
  path = configPath(),
): Promise<ZenAgentConfig | undefined> {
  try {
    return await loadConfig(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "cause" in error &&
      typeof error.cause === "object" &&
      error.cause !== null &&
      "code" in error.cause &&
      error.cause.code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}
