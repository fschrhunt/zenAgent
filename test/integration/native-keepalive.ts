/**
 * Runs the DEV-261 native-messaging keepalive probe on a throwaway profile.
 *
 * The one unavoidable machine-level integration point is Firefox's macOS
 * native-host manifest directory. The probe installs a uniquely named
 * manifest there only for the duration of the run, refuses to overwrite an
 * existing file, and removes it in `finally`.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launchScratchZen, type ZenBuild } from "./zen.js";

const EXTENSION_ID = "zen-agent-native-keepalive-probe@zen-agent.local";
const HOST_NAME = "com.zen_agent.dev261_keepalive_probe";
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/native-keepalive-extension",
);
const IDLE_WAIT_MS = 35_000;

export interface NativeKeepaliveResult {
  readonly ok: boolean;
  readonly idleWaitMs: number;
  readonly first: {
    readonly phase: string;
    readonly startedAt: number;
    readonly token: string;
    readonly receivedAt: number;
  };
  readonly second: {
    readonly phase: string;
    readonly startedAt: number;
    readonly token: string;
    readonly receivedAt: number;
  };
  readonly sameEventPage: boolean;
  readonly elapsedMs: number;
}

function buildXpi(destination: string): void {
  execFileSync(
    "/usr/bin/zip",
    ["-r", "-X", "-q", destination, "manifest.json", "background.js"],
    { cwd: FIXTURE },
  );
}

function writeUserJs(profileDir: string): void {
  const prefs: Record<string, string | boolean | number> = {
    "extensions.experiments.enabled": true,
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,
    "extensions.startupScanScopes": 15,
    "browser.shell.checkDefaultBrowser": false,
    "browser.aboutwelcome.enabled": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "zen.welcome-screen.seen": true,
  };

  const lines = Object.entries(prefs).map(([key, value]) => {
    const literal = typeof value === "string" ? JSON.stringify(value) : value;
    return `user_pref(${JSON.stringify(key)}, ${String(literal)});`;
  });
  writeFileSync(join(profileDir, "user.js"), lines.join("\n") + "\n");
}

function writeNativeHost(hostPath: string, resultPath: string): void {
  const source = `#!/usr/bin/env node
"use strict";

const { writeFileSync } = require("node:fs");

const idleWaitMs = ${String(IDLE_WAIT_MS)};
const resultPath = ${JSON.stringify(resultPath)};
let input = Buffer.alloc(0);
let first;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function finish(second) {
  const sameEventPage =
    first.token === second.token && first.startedAt === second.startedAt;
  writeFileSync(
    resultPath,
    JSON.stringify({
      ok: sameEventPage,
      idleWaitMs,
      first,
      second,
      sameEventPage,
      elapsedMs: second.receivedAt - first.receivedAt,
    }),
  );
  process.exit(sameEventPage ? 0 : 1);
}

function receive(message) {
  if (message.phase === "ready-ack") {
    first = message;
    setTimeout(() => send({ phase: "after-idle" }), idleWaitMs);
  } else if (message.phase === "after-idle-ack" && first) {
    finish(message);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < length + 4) break;
    const body = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    receive(JSON.parse(body.toString("utf8")));
  }
});

send({ phase: "ready" });
`;

  writeFileSync(hostPath, source);
  chmodSync(hostPath, 0o755);
}

export async function runNativeKeepaliveProbe(
  zen: ZenBuild,
  options: { timeoutMs?: number } = {},
): Promise<{ result: NativeKeepaliveResult; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const workDir = mkdtempSync(join(tmpdir(), "zen-agent-native-keepalive-"));
  const resultPath = join(workDir, "result.json");
  const hostPath = join(workDir, "host.cjs");
  const xpi = join(workDir, `${EXTENSION_ID}.xpi`);
  const manifestDir = join(
    homedir(),
    "Library/Application Support/Mozilla/NativeMessagingHosts",
  );
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

  if (existsSync(manifestPath)) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `refusing to overwrite existing native host manifest: ${manifestPath}`,
    );
  }

  let instance: Awaited<ReturnType<typeof launchScratchZen>> | undefined;
  try {
    buildXpi(xpi);
    writeNativeHost(hostPath, resultPath);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: HOST_NAME,
        description: "Temporary DEV-261 native keepalive probe",
        path: hostPath,
        type: "stdio",
        allowed_extensions: [EXTENSION_ID],
      }),
    );

    instance = await launchScratchZen(zen, {
      headless: true,
      remoteAgent: false,
      prepareProfile: (profileDir: string) => {
        writeUserJs(profileDir);
        const extensions = join(profileDir, "extensions");
        mkdirSync(extensions, { recursive: true });
        execFileSync("/bin/cp", [xpi, join(extensions, `${EXTENSION_ID}.xpi`)]);
      },
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        return {
          result: JSON.parse(
            readFileSync(resultPath, "utf8"),
          ) as NativeKeepaliveResult,
          stderr: instance.stderr(),
        };
      }
      if (instance.process.exitCode !== null) {
        throw new Error(
          `Zen exited before the native keepalive result was written\n${instance
            .stderr()
            .slice(-4000)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `native keepalive probe produced no result within ${String(timeoutMs)}ms\n${instance
        .stderr()
        .slice(-4000)}`,
    );
  } finally {
    if (instance !== undefined) await instance.stop();
    rmSync(manifestPath, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}
