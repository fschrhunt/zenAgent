/**
 * Attaching to the user's real Zen -- the one in their Dock, on their default
 * profile -- rather than starting a throwaway alongside it.
 *
 * The rule that matters here: **never exec the binary directly.** Running
 * `/Applications/Zen.app/Contents/MacOS/zen` bypasses LaunchServices and
 * registers a second application, which gets its own Dock tile and, if it is
 * not shut down cleanly, leaves a stale one behind. Going through `open -a`
 * hands the launch to LaunchServices, which binds it to the existing Zen tile
 * and the user's default profile.
 *
 * `launchScratchZen` in ./zen.ts is the opposite case and stays as it is: it
 * deliberately wants an isolated instance, and it runs headless so it never
 * appears in the Dock at all.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ZEN_APP = "/Applications/Zen.app";
const ZEN_SUPPORT = join(homedir(), "Library/Application Support/zen");

/**
 * Resolves the profile Zen would use on a normal double-click.
 *
 * `profiles.ini` marks it with `Default=1`, except that an `[InstallXXXX]`
 * section, when present, overrides that per-installation -- which is the case
 * on this machine, where the two disagree.
 */
export function resolveDefaultProfile(): string | undefined {
  const iniPath = join(ZEN_SUPPORT, "profiles.ini");
  if (!existsSync(iniPath)) return undefined;

  const lines = readFileSync(iniPath, "utf8").split("\n");
  let section = "";
  let installDefault: string | undefined;
  let flaggedDefault: string | undefined;
  let current: { path?: string; isDefault?: boolean } = {};
  const sections: { name: string; path?: string; isDefault?: boolean }[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (section) sections.push({ name: section, ...current });
      section = line.slice(1, -1);
      current = {};
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();

    if (section.startsWith("Install") && key === "Default") {
      installDefault = value;
    } else if (key === "Path") {
      current.path = value;
    } else if (key === "Default" && value === "1") {
      current.isDefault = true;
    }
  }
  if (section) sections.push({ name: section, ...current });

  for (const entry of sections) {
    if (entry.isDefault === true && entry.path !== undefined) {
      flaggedDefault = entry.path;
    }
  }

  const relative = installDefault ?? flaggedDefault;
  return relative === undefined ? undefined : join(ZEN_SUPPORT, relative);
}

export type DailyZenState =
  /** Running, and already exposing a BiDi endpoint we can attach to. */
  | { readonly kind: "attachable"; readonly pid: number; readonly url: string }
  /** Running, but launched without the remote agent. Cannot be armed now. */
  | { readonly kind: "running-closed"; readonly pid: number }
  /** Not running. We are free to launch it with the flag. */
  | { readonly kind: "not-running" };

/** The pid of the main Zen process, excluding its child content processes. */
export function findRunningZen(): number | undefined {
  try {
    const out = execFileSync(
      "/usr/bin/pgrep",
      ["-f", `^${ZEN_APP}/Contents/MacOS/zen`],
      { encoding: "utf8" },
    );
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // pgrep exits non-zero when nothing matches.
  }
  return undefined;
}

/**
 * Reports what we can do with the user's Zen right now, without touching it.
 *
 * When the remote agent is on, Zen writes `WebDriverBiDiServer.json` into the
 * profile with the host and port, so the endpoint is discoverable rather than
 * something the user has to tell us.
 */
export function inspectDailyZen(profileDir?: string): DailyZenState {
  const pid = findRunningZen();
  if (pid === undefined) return { kind: "not-running" };

  const profile = profileDir ?? resolveDefaultProfile();
  if (profile !== undefined) {
    const marker = join(profile, "WebDriverBiDiServer.json");
    if (existsSync(marker)) {
      try {
        const parsed = JSON.parse(readFileSync(marker, "utf8")) as {
          ws_host?: string;
          ws_port?: number;
        };
        if (parsed.ws_host !== undefined && parsed.ws_port !== undefined) {
          return {
            kind: "attachable",
            pid,
            url: `ws://${parsed.ws_host}:${String(parsed.ws_port)}/session`,
          };
        }
      } catch {
        // Treat an unreadable marker as no marker.
      }
    }
  }

  return { kind: "running-closed", pid };
}

/**
 * Launches the user's own Zen with the remote agent enabled.
 *
 * Uses `open -a`, so this is the same application and Dock tile the user
 * already has, on their default profile. It deliberately refuses to run when
 * Zen is already up: a second `open` would only activate the existing window,
 * and the remote agent cannot be armed after startup anyway.
 */
export function launchDailyZen(port: number): void {
  const running = findRunningZen();
  if (running !== undefined) {
    throw new Error(
      `Zen is already running (pid ${String(running)}). The remote agent can ` +
        `only be enabled at startup, so it must be quit and relaunched.`,
    );
  }

  // Detached, because `open` returns as soon as the app is handed off.
  const child = spawn(
    "/usr/bin/open",
    ["-a", ZEN_APP, "--args", "--remote-debugging-port", String(port)],
    { stdio: "ignore", detached: true },
  );
  child.unref();
}
