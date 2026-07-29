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
 * Refuses to attach to a profile that has not opted out of "recommended" prefs.
 *
 * Starting the remote agent against a real profile makes
 * `RecommendedPreferences` write ~87 preferences onto the **user** branch,
 * including turning off Safe Browsing, the password manager, breach alerts and
 * extension updates. They are only reverted on `xpcom-shutdown`, and in
 * practice they survived a clean quit and had to be removed by hand.
 *
 * `remote.prefs.recommended = false` makes `applyPreferences()` return before
 * writing anything, so it has to be set *before* the first attach. This is a
 * hard precondition, not advice.
 */
export function assertSafeToAttach(profileDir: string): void {
  const prefs = join(profileDir, "prefs.js");
  const contents = existsSync(prefs) ? readFileSync(prefs, "utf8") : "";
  if (/user_pref\("remote\.prefs\.recommended",\s*false\)/.test(contents)) {
    return;
  }

  throw new Error(
    `Refusing to attach to ${profileDir}: "remote.prefs.recommended" is not ` +
      `set to false. Attaching would rewrite ~87 preferences on this profile, ` +
      `including disabling Safe Browsing and the password manager. Set it in ` +
      `about:config (or in prefs.js while Zen is closed) and try again.`,
  );
}

export interface LaunchDailyOptions {
  /**
   * Start the WebDriver BiDi remote agent on this port.
   *
   * Omit it. Under ADR 0001 the transport is an in-browser extension, which
   * needs no remote protocol, so a plain launch is the normal case. Passing a
   * port opts into the rejected BiDi path and everything that comes with it: a
   * robot icon in the URL bar for the whole browser run, and the preference
   * rewriting that `assertSafeToAttach` guards against.
   */
  readonly remoteDebuggingPort?: number;
  readonly profileDir?: string;
}

/**
 * Launches the user's own Zen -- the pinned application, on their default
 * profile.
 *
 * Uses `open -a`, which hands the launch to LaunchServices so it binds to the
 * Dock tile the user already has. Executing the binary directly would register
 * a separate application and add a second tile, which is what happened during
 * this spike.
 *
 * Refuses to run when Zen is already up: `open` would only activate the
 * existing window, and with the extension transport there is nothing to attach
 * anyway.
 */
export function launchDailyZen(options: LaunchDailyOptions = {}): void {
  const { remoteDebuggingPort } = options;

  if (remoteDebuggingPort !== undefined) {
    const profile = options.profileDir ?? resolveDefaultProfile();
    if (profile === undefined) {
      throw new Error("Could not resolve the default Zen profile.");
    }
    assertSafeToAttach(profile);
  }

  const running = findRunningZen();
  if (running !== undefined) {
    throw new Error(
      `Zen is already running (pid ${String(running)}); nothing to launch.`,
    );
  }

  const args =
    remoteDebuggingPort === undefined
      ? ["-a", ZEN_APP]
      : [
          "-a",
          ZEN_APP,
          "--args",
          "--remote-debugging-port",
          String(remoteDebuggingPort),
        ];

  // Detached, because `open` returns as soon as the app is handed off.
  const child = spawn("/usr/bin/open", args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}
