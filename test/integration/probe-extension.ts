/**
 * Runs the DEV-261 privileged-extension probe on a throwaway profile.
 *
 * Deliberately uses no remote protocol. The extension is installed by dropping
 * an XPI into the profile, it runs itself at startup, and it reports by writing
 * a JSON file. That is the whole point of the ADR 0001 path: nothing listens on
 * a socket, so there is no remote-control badge and no preference rewriting.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launchScratchZen, type ZenBuild } from "./zen.js";

const EXTENSION_ID = "zen-agent-probe@zen-agent.local";
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/probe-extension",
);

export interface TabDescription {
  readonly space: string | null;
  readonly essential: boolean;
  readonly userContextId: string | null;
  readonly lazy: boolean;
  readonly label: string | null;
}

export interface ProbeSnapshot {
  readonly activeSpace: string;
  readonly spaces: readonly {
    uuid: string;
    name: string;
    containerTabId: number;
  }[];
  readonly selectedTabLabel: string | null;
  readonly allStoredTabs: number;
  readonly gBrowserTabs: number;
  readonly allStoredBySpace: readonly TabDescription[];
  readonly gBrowserBySpace: readonly TabDescription[];
  readonly remoteControlBadge: boolean;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly stack?: string | null;
  readonly steps?: readonly { name: string; value: unknown }[];
  readonly before?: ProbeSnapshot;
  readonly after?: ProbeSnapshot;
  readonly unchanged?: {
    activeSpace: boolean;
    selectedTab: boolean;
    noBadge: boolean;
  };
}

/** Packages the fixture directory into an installable XPI. */
function buildXpi(destination: string): void {
  execFileSync(
    "/usr/bin/zip",
    ["-r", "-X", "-q", destination, "manifest.json", "schema.json", "api.js"],
    { cwd: FIXTURE },
  );
}

/**
 * Preferences the probe needs.
 *
 * `xpinstall.signatures.required` is only effective because Zen ships
 * `MOZ_REQUIRE_SIGNING: false`; on stock Firefox Release this would be inert
 * and the unsigned XPI would be rejected. `extensions.experiments.enabled` is
 * what makes `experiment_apis` load at all.
 */
function writeUserJs(profileDir: string, outputPath: string): void {
  const prefs: Record<string, string | boolean | number> = {
    "extensions.experiments.enabled": true,
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,
    "extensions.startupScanScopes": 15,
    "zenagent.probe.output": outputPath,
    // Keep first-run UI out of the way so the probe sees a steady window.
    "browser.shell.checkDefaultBrowser": false,
    "browser.aboutwelcome.enabled": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "zen.welcome-screen.seen": true,
    // Restore the previous session, so the second pass sees lazy tabs.
    "browser.startup.page": 3,
    // Flush the session promptly, so the restart pass has one to restore.
    "browser.sessionstore.interval": 1000,
  };

  const lines = Object.entries(prefs).map(([key, value]) => {
    const literal = typeof value === "string" ? JSON.stringify(value) : value;
    return `user_pref(${JSON.stringify(key)}, ${String(literal)});`;
  });
  writeFileSync(join(profileDir, "user.js"), lines.join("\n") + "\n");
}

export interface ProbeRun {
  readonly result: ProbeResult;
  readonly stderr: string;
}

async function launchProbe(
  zen: ZenBuild,
  outputPath: string,
  xpi: string,
  headless: boolean,
  timeoutMs: number,
  profileDir?: string,
): Promise<{ result: ProbeResult; stderr: string; profileDir: string }> {
  const instance = await launchScratchZen(zen, {
    headless,
    remoteAgent: false,
    keepProfile: true,
    // A command-line URL would suppress session restore.
    startupUrl: null,
    ...(profileDir === undefined ? {} : { profileDir }),
    prepareProfile: (dir: string) => {
      writeUserJs(dir, outputPath);
      const extensions = join(dir, "extensions");
      mkdirSync(extensions, { recursive: true });
      execFileSync("/bin/cp", [xpi, join(extensions, `${EXTENSION_ID}.xpi`)]);
    },
  });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(outputPath)) {
        try {
          const parsed = JSON.parse(
            readFileSync(outputPath, "utf8"),
          ) as ProbeResult;
          // Give the session store time to persist before we shut down, or
          // the restart pass has nothing to restore.
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          return {
            result: parsed,
            stderr: instance.stderr(),
            profileDir: instance.profileDir,
          };
        } catch {
          // partially written; keep waiting
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `probe produced no result within ${String(timeoutMs)}ms\n` +
        instance.stderr().slice(-4000),
    );
  } finally {
    await instance.stop();
  }
}

/**
 * Runs the probe, restarts the same profile, and runs it again.
 *
 * The second pass is the one that matters for ADR 0001: after a restart Zen
 * restores its tabs lazily, which is exactly the state in which BiDi saw 1 tab
 * out of 22 on the real profile.
 */
export async function runExtensionProbeAcrossRestart(
  zen: ZenBuild,
  options: { headless?: boolean; timeoutMs?: number } = {},
): Promise<{ first: ProbeResult; second: ProbeResult }> {
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const workDir = mkdtempSync(join(tmpdir(), "zen-agent-probe-"));
  const outputPath = join(workDir, "result.json");
  const xpi = join(workDir, `${EXTENSION_ID}.xpi`);
  buildXpi(xpi);

  let profileDir: string | undefined;
  try {
    const first = await launchProbe(zen, outputPath, xpi, headless, timeoutMs);
    profileDir = first.profileDir;
    rmSync(outputPath, { force: true });
    const second = await launchProbe(
      zen,
      outputPath,
      xpi,
      headless,
      timeoutMs,
      profileDir,
    );
    return { first: first.result, second: second.result };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (profileDir !== undefined) {
      rmSync(profileDir, { recursive: true, force: true });
    }
  }
}

export async function runExtensionProbe(
  zen: ZenBuild,
  options: { headless?: boolean; timeoutMs?: number } = {},
): Promise<ProbeRun> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const workDir = mkdtempSync(join(tmpdir(), "zen-agent-probe-"));
  const outputPath = join(workDir, "result.json");
  const xpi = join(workDir, `${EXTENSION_ID}.xpi`);
  buildXpi(xpi);

  try {
    const run = await launchProbe(
      zen,
      outputPath,
      xpi,
      options.headless ?? true,
      timeoutMs,
    );
    rmSync(run.profileDir, { recursive: true, force: true });
    return { result: run.result, stderr: run.stderr };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
