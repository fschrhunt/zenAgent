/**
 * Locating, launching, and inspecting Zen Browser for the DEV-261 spike.
 *
 * Two modes matter:
 *
 * - `launchScratchZen` starts a throwaway instance on a temporary profile. Safe
 *   to run at any time; never touches the user's data.
 * - `isBidiListening` reports whether an already-running Zen exposes a remote
 *   agent. It does not, and cannot, turn one on.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_ZEN_BINARY = "/Applications/Zen.app/Contents/MacOS/zen";
const DEFAULT_ZEN_RESOURCES = "/Applications/Zen.app/Contents/Resources";

export interface ZenBuild {
  readonly binary: string;
  /** Zen's own version, e.g. "1.21.9b". */
  readonly version: string;
  /** The Gecko milestone Zen is built on, e.g. "153.0". */
  readonly geckoVersion: string;
  readonly buildId: string;
}

function readIniValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [name, ...rest] = line.split("=");
    if (name?.trim() === key) return rest.join("=").trim();
  }
  return undefined;
}

export function locateZen(): ZenBuild | undefined {
  const binary = process.env["ZEN_BINARY"] ?? DEFAULT_ZEN_BINARY;
  if (!existsSync(binary)) return undefined;

  const resources = process.env["ZEN_RESOURCES"] ?? DEFAULT_ZEN_RESOURCES;
  const application = join(resources, "application.ini");
  const platform = join(resources, "platform.ini");

  return {
    binary,
    version: readIniValue(application, "Version") ?? "unknown",
    geckoVersion: readIniValue(platform, "Milestone") ?? "unknown",
    buildId: readIniValue(application, "BuildID") ?? "unknown",
  };
}

export interface ScratchZen {
  readonly process: ChildProcess;
  /** The endpoint Zen announces, e.g. "ws://127.0.0.1:56884". */
  readonly webSocketUrl: string;
  /** The endpoint a client actually connects to, to run `session.new`. */
  readonly sessionUrl: string;
  readonly profileDir: string;
  readonly stderr: () => string;
  readonly stop: () => void;
}

export interface LaunchOptions {
  readonly port?: number;
  /**
   * Headless keeps the spike from stealing focus from the user's real session.
   * Headed runs are required to observe Zen Spaces, which are chrome UI.
   */
  readonly headless?: boolean;
  readonly timeoutMs?: number;
}

const BIDI_BANNER = /WebDriver BiDi listening on (ws:\/\/\S+)/;

/**
 * Launches a throwaway Zen on a fresh temporary profile with the remote agent
 * enabled, and resolves once BiDi announces its WebSocket URL.
 *
 * `--no-remote` plus a dedicated profile is what lets this coexist with the
 * user's already-running daily Zen instead of being handed off to it.
 */
export async function launchScratchZen(
  zen: ZenBuild,
  options: LaunchOptions = {},
): Promise<ScratchZen> {
  const port = options.port ?? 0;
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const profileDir = mkdtempSync(join(tmpdir(), "zen-agent-spike-"));

  const args = [
    "--profile",
    profileDir,
    "--no-remote",
    "--remote-debugging-port",
    String(port),
    ...(headless ? ["--headless"] : []),
    "about:blank",
  ];

  const child = spawn(zen.binary, args, {
    env: { ...process.env, MOZ_NO_REMOTE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stdout?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  child.stdout?.on("data", (chunk: string) => (stderr += chunk));

  const stop = () => {
    rmSync(profileDir, { recursive: true, force: true });
    if (child.exitCode === null) child.kill("SIGTERM");
  };

  const webSocketUrl = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const match = BIDI_BANNER.exec(stderr);
      if (match?.[1] !== undefined) {
        clearInterval(poll);
        resolve(match[1]);
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(poll);
        reject(new Error(`Zen exited early (code ${String(child.exitCode)})`));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error("timed out waiting for the BiDi banner"));
      }
    }, 100);
  }).catch((error: unknown) => {
    stop();
    throw error;
  });

  return {
    process: child,
    webSocketUrl,
    sessionUrl: `${webSocketUrl}/session`,
    profileDir,
    stderr: () => stderr,
    stop,
  };
}

/**
 * Probes a port for a live BiDi endpoint.
 *
 * Used to answer the spike's first question: can we attach to the Zen the user
 * already has open? A running Zen launched without `--remote-debugging-port`
 * has no listener at all, and there is no way to add one after the fact.
 */
export async function isBidiListening(port: number): Promise<boolean> {
  try {
    const socket = await Promise.race([
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/session`);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("no listener"));
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2_000),
      ),
    ]);
    socket.close();
    return true;
  } catch {
    return false;
  }
}
