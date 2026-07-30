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
  /** The endpoint Zen announces; absent when launched without a remote agent. */
  readonly webSocketUrl: string | undefined;
  /** The endpoint a client actually connects to, to run `session.new`. */
  readonly sessionUrl: string | undefined;
  readonly profileDir: string;
  readonly stderr: () => string;
  readonly stop: () => Promise<void>;
}

export interface LaunchOptions {
  readonly port?: number;
  /**
   * Headless keeps the spike from stealing focus from the user's real session.
   * Headless instances also register as `BackgroundOnly` with LaunchServices,
   * so they never appear in the Dock.
   */
  readonly headless?: boolean;
  readonly timeoutMs?: number;
  /**
   * Start the WebDriver BiDi remote agent. Defaults to true.
   *
   * The extension probe sets this false: it needs no remote protocol, which is
   * precisely why it shows no remote-control badge and rewrites no preferences.
   */
  readonly remoteAgent?: boolean;
  /** Seeds the freshly created profile before Zen is started. */
  readonly prepareProfile?: (profileDir: string) => void;
  /** Reuse an existing profile instead of creating one. */
  readonly profileDir?: string;
  /** Leave the profile on disk at stop(), so it can be relaunched. */
  readonly keepProfile?: boolean;
  /**
   * URL to open at startup, or null for none.
   *
   * Passing a URL on the command line suppresses session restore, so the
   * restart pass of the extension probe must omit it.
   */
  readonly startupUrl?: string | null;
  /**
   * Extra environment for the Zen process.
   *
   * Native messaging hosts are launched by Zen and inherit its environment, so
   * this is how a scenario host learns where its fixture server is listening.
   */
  readonly env?: Readonly<Record<string, string>>;
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
  const remoteAgent = options.remoteAgent ?? true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const startupUrl =
    options.startupUrl === undefined ? "about:blank" : options.startupUrl;
  const profileDir =
    options.profileDir ?? mkdtempSync(join(tmpdir(), "zen-agent-spike-"));
  options.prepareProfile?.(profileDir);

  const args = [
    "--profile",
    profileDir,
    "--no-remote",
    ...(remoteAgent ? ["--remote-debugging-port", String(port)] : []),
    ...(headless ? ["--headless"] : []),
    ...(startupUrl === null ? [] : [startupUrl]),
  ];

  const child = spawn(zen.binary, args, {
    env: { ...process.env, MOZ_NO_REMOTE: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stdout?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  child.stdout?.on("data", (chunk: string) => (stderr += chunk));

  /**
   * Shuts the instance down and then removes its profile.
   *
   * Order matters. Deleting the profile out from under a live Zen makes it exit
   * uncleanly at best and hang at worst, and on macOS a Zen that does not
   * quit cleanly can leave a stale tile in the Dock. Signal first, give it a
   * moment to go, and only then delete.
   */
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", resolve),
      );
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    }
    if (options.keepProfile !== true) {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  };

  if (!remoteAgent) {
    return {
      process: child,
      webSocketUrl: undefined,
      sessionUrl: undefined,
      profileDir,
      stderr: () => stderr,
      stop,
    };
  }

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
  }).catch(async (error: unknown) => {
    await stop();
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
