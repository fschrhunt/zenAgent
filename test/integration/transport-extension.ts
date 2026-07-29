/**
 * DEV-273: proves the real transport against a real Zen.
 *
 * Everything the contract tests cannot reach lives here — whether Zen loads an
 * MV3 add-on that also declares `experiment_apis`, whether identifiers survive
 * a Space change, and whether the product invariants actually hold when tabs
 * are opened and routed on a running browser.
 *
 * Safety, in the same shape the DEV-261 harness established: throwaway
 * `mkdtemp` profiles, `--no-remote`, `MOZ_NO_REMOTE=1`, and a native host
 * manifest that is refused rather than overwritten and removed in `finally`.
 * The user's daily profile is never opened.
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
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
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { launchScratchZen, type ZenBuild } from "./zen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, "../..");

const EXTENSION_ID = "zen-agent@zen-agent.local";
const HOST_NAME = "to.nodus.zen_agent";

/** The DEV-261 probe, reused here purely to create a second Space. */
const SEEDER_ID = "zen-agent-probe@zen-agent.local";
const SEEDER_FIXTURE = join(HERE, "fixtures/probe-extension");

export interface TransportProof {
  readonly ok: boolean;
  readonly error?: string;
  readonly stack?: string | null;
  readonly capabilities?: readonly string[];
  readonly browserVersion?: string;
  readonly geckoVersion?: string;
  readonly spaces?: readonly { id: string; name: string | null }[];
  readonly steps?: readonly { name: string; value: unknown }[];
  readonly claims?: Readonly<Record<string, boolean>>;
}

/**
 * The scenario Zen launches as its native messaging host.
 *
 * Written out rather than committed as a fixture because it needs absolute
 * paths into this checkout's `dist/`, which is what makes it exercise the real
 * `ZenTransport` rather than a copy of it.
 */
function writeScenarioHost(hostPath: string, resultPath: string): void {
  const source = `#!/usr/bin/env node
import { ZenTransport } from ${JSON.stringify(join(REPO, "dist/transport/client.js"))};
import { streamConnection } from ${JSON.stringify(join(REPO, "dist/native/connection.js"))};
import { writeFileSync } from "node:fs";

const resultPath = ${JSON.stringify(resultPath)};
const origin = process.env.ZEN_AGENT_TEST_ORIGIN;
const steps = [];
const claims = {};
const note = (name, value) => steps.push({ name, value });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tabById(snapshot, id) {
  return snapshot.tabs.find((tab) => tab.id.transportId === id);
}

function spaceUuidOf(snapshot, tab) {
  if (tab === undefined || tab.spaceId.status !== "known" || tab.spaceId.value === null) {
    return null;
  }
  const transportId = tab.spaceId.value.transportId;
  const slash = transportId.indexOf("/");
  return slash === -1 ? transportId : transportId.slice(slash + 1);
}

function selectedIds(snapshot) {
  return snapshot.tabs
    .filter((tab) => tab.selected.status === "known" && tab.selected.value)
    .map((tab) => tab.id.transportId)
    .sort();
}

async function main() {
  const transport = new ZenTransport(
    streamConnection(process.stdin, process.stdout),
    { requestTimeoutMs: 20000 },
  );

  let snapshot = await transport.connect();
  note("connected", true);
  note("capabilities", transport.capabilities);

  // The seeder add-on creates the second Space shortly after startup.
  for (let attempt = 0; attempt < 60 && snapshot.spaces.length < 2; attempt += 1) {
    await sleep(1000);
    snapshot = await transport.snapshot();
  }

  const spaces = snapshot.spaces.map((space) => ({
    id: space.id.transportId.slice(space.id.transportId.indexOf("/") + 1),
    name: space.name.status === "known" ? space.name.value : null,
    windowId: space.windowId.transportId,
  }));
  note("spaces", spaces);

  if (spaces.length < 2) {
    throw new Error("never saw a second Space to route into");
  }

  // CLAIM: tabs in a Space the user is not looking at are enumerated at all.
  // This is the failure that disqualified BiDi and a plain WebExtension.
  const spacesWithTabs = new Set(
    snapshot.tabs.map((tab) => spaceUuidOf(snapshot, tab)).filter((id) => id !== null),
  );
  claims.enumeratesMoreThanOneSpace = spacesWithTabs.size >= 2;
  note("spacesWithTabs", [...spacesWithTabs]);

  const before = {
    selected: selectedIds(snapshot),
    tabIds: snapshot.tabs.map((tab) => tab.id.transportId).sort(),
    focusedWindows: snapshot.windows
      .filter((w) => w.focused.status === "known" && w.focused.value)
      .map((w) => w.id.transportId)
      .sort(),
  };
  note("before", before);

  const [homeSpace, otherSpace] = spaces;

  // ---- Open a background tab, routed into the non-visible Space.
  const routedId = await transport.openTab({
    url: origin + "/routed",
    zenSpaceUuid: otherSpace.id,
  });
  note("openedRouted", routedId);
  await sleep(2500);
  snapshot = await transport.snapshot();

  const routed = tabById(snapshot, routedId);
  claims.routedTabExists = routed !== undefined;
  claims.routedIntoRequestedSpace = spaceUuidOf(snapshot, routed) === otherSpace.id;
  claims.routedTabNotSelected =
    routed !== undefined &&
    routed.selected.status === "known" &&
    routed.selected.value === false;
  claims.selectedTabUnchangedByOpen =
    JSON.stringify(selectedIds(snapshot)) === JSON.stringify(before.selected);
  note("routedTabSpace", spaceUuidOf(snapshot, routed));

  // CLAIM: a packaged Zen Agent actor can inspect a loaded document in the
  // non-visible Space without selecting it or relying on page timers.
  const inspection = await transport.inspectPage(routedId, { maxChars: 80 });
  note("backgroundInspection", inspection);
  claims.inspectionCapability = transport.capabilities.includes(
    "browser.pages.inspect",
  );
  claims.inspectedBackgroundUrl = inspection.url === origin + "/routed";
  claims.inspectedBackgroundTitle = inspection.title === "actor target";
  claims.inspectedBoundedVisibleText =
    inspection.visibleText.includes("Background actor visible text") &&
    !inspection.visibleText.includes("SHOULD NOT APPEAR") &&
    inspection.visibleText.length <= 80;
  claims.inspectionLeftTabUnselected =
    JSON.stringify(selectedIds(await transport.snapshot())) ===
    JSON.stringify(before.selected);

  // CLAIM: identity survives a Space change. The tab element is moved, not
  // recreated, and identity is a WeakMap keyed on that element.
  const spaceBeforeMove = spaceUuidOf(snapshot, routed);
  await transport.moveTab(routedId, homeSpace.id);
  await sleep(2500);
  snapshot = await transport.snapshot();
  const moved = tabById(snapshot, routedId);
  claims.identitySurvivesSpaceMove = moved !== undefined;
  claims.moveChangedSpace =
    spaceUuidOf(snapshot, moved) === homeSpace.id &&
    spaceBeforeMove !== homeSpace.id;
  claims.selectedTabUnchangedByMove =
    JSON.stringify(selectedIds(snapshot)) === JSON.stringify(before.selected);
  note("spaceAfterMove", spaceUuidOf(snapshot, moved));

  // CLAIM: every identifier from the first snapshot is still valid. Nothing was
  // renumbered by opening, routing, or moving.
  const survivingIds = new Set(snapshot.tabs.map((tab) => tab.id.transportId));
  claims.allOriginalIdsStillValid = before.tabIds.every((id) => survivingIds.has(id));

  // ---- Media.
  //
  // The media tab is Zen's *startup* tab, so it is the one the user has
  // selected and foregrounded. That is deliberate, and it is the real scenario:
  // Firefox blocks autoplay in a background tab until it is foregrounded, so a
  // tab this agent opened would never start playing in the first place. The
  // invariant under test is that a tab the user is already playing keeps
  // playing while the agent works elsewhere.
  const mark = (name) =>
    fetch(origin + "/mark?name=" + name).catch(() => {});

  // Give the startup tab time to start playing before disturbing anything.
  await sleep(6000);
  snapshot = await transport.snapshot();
  const mediaTab = snapshot.tabs.find(
    (tab) => tab.url.status === "known" && tab.url.value.endsWith("/audio"),
  );
  const mediaId = mediaTab?.id.transportId;
  claims.mediaTabIsSelected =
    mediaTab !== undefined &&
    mediaTab.selected.status === "known" &&
    mediaTab.selected.value === true;
  claims.selectedMediaMutationRejected = false;
  if (mediaId !== undefined) {
    try {
      await transport.reloadTab(mediaId);
    } catch (error) {
      claims.selectedMediaMutationRejected =
        error?.code === "policy-rejection";
    }
  }
  // Recorded as evidence, not asserted on: whether Gecko flags a tab as
  // emitting sound depends on window occlusion. The playback position measured
  // by the fixture server is the claim that actually holds.
  note("soundPlayingFlag", mediaTab?.mediaState);

  await mark("cycle-start");
  const churnId = await transport.openTab({
    url: origin + "/churn",
    zenSpaceUuid: otherSpace.id,
  });
  await sleep(2000);
  await transport.navigateTab(churnId, origin + "/churn2");
  await sleep(2000);
  await transport.reloadTab(churnId);
  await sleep(2000);
  snapshot = await transport.snapshot();
  claims.selectedTabUnchangedByReload =
    JSON.stringify(selectedIds(snapshot)) === JSON.stringify(before.selected);
  await transport.closeTab(churnId);
  await sleep(2000);
  await mark("cycle-end");
  await sleep(1500);

  snapshot = await transport.snapshot();
  claims.mediaTabSurvivedCycle =
    mediaId !== undefined && tabById(snapshot, mediaId) !== undefined;
  claims.selectedTabUnchangedByCycle =
    JSON.stringify(selectedIds(snapshot)) === JSON.stringify(before.selected);
  claims.focusedWindowUnchanged =
    JSON.stringify(
      snapshot.windows
        .filter((w) => w.focused.status === "known" && w.focused.value)
        .map((w) => w.id.transportId)
        .sort(),
    ) === JSON.stringify(before.focusedWindows);

  // CLAIM: a closed tab's identifier becomes stale rather than being reused.
  claims.closedTabGone = tabById(snapshot, churnId) === undefined;

  // CLAIM: the scheme allowlist holds. These tabs are opened with a system
  // principal, so this is a security boundary rather than a convenience.
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
    let refused = false;
    try {
      await transport.openTab({ url });
    } catch {
      refused = true;
    }
    claims["refuses " + url.split(":")[0]] = refused;
  }

  return { spaces, capabilities: transport.capabilities };
}

const result = { ok: false, steps, claims };

try {
  const { spaces, capabilities } = await main();
  result.spaces = spaces;
  result.capabilities = capabilities;
  result.ok = Object.values(claims).every(Boolean);
} catch (error) {
  result.error = String(error && error.message ? error.message : error);
  result.stack = error && error.stack ? String(error.stack) : null;
}

result.steps = steps;
result.claims = claims;
writeFileSync(resultPath, JSON.stringify(result, null, 2));
process.exit(0);
`;

  writeFileSync(hostPath, source);
  chmodSync(hostPath, 0o755);
}

function writeUserJs(profileDir: string, seederOutput: string): void {
  const prefs: Record<string, string | boolean | number> = {
    "extensions.experiments.enabled": true,
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,
    "extensions.startupScanScopes": 15,
    "zenagent.probe.output": seederOutput,
    // Let the media tab actually start, so "still playing" means something.
    "media.autoplay.default": 0,
    "media.autoplay.blocking_policy": 0,
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

/** Packages `extension/` into an installable XPI, preserving privileged code. */
function buildExtensionXpi(destination: string): void {
  execFileSync(
    "/usr/bin/zip",
    [
      "-r",
      "-X",
      "-q",
      destination,
      "manifest.json",
      "background.js",
      "api",
      "actors",
    ],
    { cwd: join(REPO, "extension") },
  );
}

function buildSeederXpi(destination: string): void {
  execFileSync(
    "/usr/bin/zip",
    ["-r", "-X", "-q", destination, "manifest.json", "schema.json", "api.js"],
    { cwd: SEEDER_FIXTURE },
  );
}

export interface MediaTick {
  readonly at: number;
  readonly currentTime: number;
  readonly paused: boolean;
  readonly readyState: number;
  /** Diagnostic from the page: why playback did or did not start. */
  readonly note: string;
}

export interface FixtureServer {
  readonly origin: string;
  readonly server: Server;
  readonly ticks: MediaTick[];
  readonly marks: Map<string, number>;
}

/**
 * Pages the scenario navigates to, so the run needs no network.
 *
 * The audio page reports its playback position back here. That is a far
 * stronger claim than the tab's `soundPlaying` flag, which turned out to depend
 * on whether the Zen window happened to be occluded: a position that keeps
 * advancing across the cycle proves playback was not interrupted *or restarted*,
 * which is what the invariant actually says.
 */
function startFixtureServer(): Promise<FixtureServer> {
  const audio = `<!doctype html><title>audio</title>
<audio id="a" autoplay src="/tone.wav"></audio>
<script>
  const a = document.getElementById("a");
  a.volume = 0.01;
  const report = (note) => {
    fetch(
      "/tick?t=" + a.currentTime +
      "&paused=" + a.paused +
      "&ready=" + a.readyState +
      "&note=" + encodeURIComponent(note || ""),
    ).catch(() => {});
  };
  setInterval(() => report(""), 500);
  a.addEventListener("playing", () => report("playing"));
  a.addEventListener("error", () => report("element-error:" + (a.error && a.error.code)));
  a.play().then(() => report("play-resolved")).catch((e) => report("play-rejected:" + e.name));
</script>`;

  // A minute of quiet 8-bit PCM, deliberately not looped: a loop would wrap
  // `currentTime` back to zero and make "never went backwards" meaningless.
  const sampleRate = 8000;
  const samples = sampleRate * 60;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);

  for (let n = 0; n < samples; n += 1) {
    wav[44 + n] =
      128 + Math.round(40 * Math.sin((n / sampleRate) * 440 * 2 * Math.PI));
  }

  const ticks: MediaTick[] = [];
  const marks = new Map<string, number>();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/tick") {
      ticks.push({
        at: Date.now(),
        currentTime: Number(url.searchParams.get("t") ?? "0"),
        paused: url.searchParams.get("paused") === "true",
        readyState: Number(url.searchParams.get("ready") ?? "0"),
        note: url.searchParams.get("note") ?? "",
      });
      response.writeHead(204).end();
      return;
    }

    if (url.pathname === "/mark") {
      marks.set(url.searchParams.get("name") ?? "unnamed", Date.now());
      response.writeHead(204).end();
      return;
    }

    if (request.url === "/tone.wav") {
      response.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(wav.byteLength),
      });
      response.end(wav);
      return;
    }

    if (request.url === "/audio") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(audio);
      return;
    }

    if (request.url === "/routed") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
<title>actor target</title>
<p>Background actor visible text</p>
<p hidden>SHOULD NOT APPEAR</p>
<p>${"bounded ".repeat(40)}</p>`);
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>${request.url ?? ""}</title>ok`);
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolveServer({
        origin: `http://127.0.0.1:${String(port)}`,
        server,
        ticks,
        marks,
      });
    });
  });
}

export interface MediaEvidence {
  readonly tickCount: number;
  /** Distinct diagnostics the page reported, e.g. why `play()` was rejected. */
  readonly notes: readonly string[];
  readonly maxReadyState: number;
  /** Whether the element ever reported itself as playing. */
  readonly everPlayed: boolean;
  /** Playback position at the first tick after the cycle began. */
  readonly atCycleStart: number | null;
  /** Playback position at the last tick before the cycle ended. */
  readonly atCycleEnd: number | null;
  /** True if `currentTime` never went backwards, i.e. never restarted. */
  readonly neverRewound: boolean;
}

export interface TransportProofRun {
  readonly proof: TransportProof;
  readonly stderr: string;
  /** The frontmost macOS application before and after the scenario. */
  readonly frontmost: { before: string; after: string };
  readonly media: MediaEvidence;
}

function summariseMedia(fixtures: FixtureServer): MediaEvidence {
  const ticks = [...fixtures.ticks].sort((a, b) => a.at - b.at);
  const start = fixtures.marks.get("cycle-start");
  const end = fixtures.marks.get("cycle-end");

  const during =
    start === undefined || end === undefined
      ? []
      : ticks.filter((tick) => tick.at >= start && tick.at <= end);

  let neverRewound = true;
  let previous = -1;

  for (const tick of ticks) {
    if (tick.currentTime < previous - 0.05) {
      neverRewound = false;
    }

    previous = Math.max(previous, tick.currentTime);
  }

  return {
    tickCount: ticks.length,
    notes: [...new Set(ticks.map((tick) => tick.note).filter(Boolean))],
    maxReadyState: ticks.reduce(
      (best, tick) => Math.max(best, tick.readyState),
      0,
    ),
    everPlayed: ticks.some((tick) => !tick.paused && tick.currentTime > 0),
    atCycleStart: during[0]?.currentTime ?? null,
    atCycleEnd: during.at(-1)?.currentTime ?? null,
    neverRewound,
  };
}

function frontmostApp(): string {
  try {
    return execFileSync("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ])
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export async function runTransportProof(
  zen: ZenBuild,
  options: { headless?: boolean; timeoutMs?: number } = {},
): Promise<TransportProofRun> {
  const headless = options.headless ?? false;
  const timeoutMs = options.timeoutMs ?? 240_000;
  const workDir = mkdtempSync(join(tmpdir(), "zen-agent-transport-"));
  const resultPath = join(workDir, "proof.json");
  const seederOutput = join(workDir, "seeder.json");
  const hostPath = join(workDir, "host.mjs");
  const xpi = join(workDir, `${EXTENSION_ID}.xpi`);
  const seederXpi = join(workDir, `${SEEDER_ID}.xpi`);
  const manifestDir = join(
    homedir(),
    "Library/Application Support/Mozilla/NativeMessagingHosts",
  );
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

  if (existsSync(manifestPath)) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `refusing to overwrite an existing native host manifest: ${manifestPath}`,
    );
  }

  let instance: Awaited<ReturnType<typeof launchScratchZen>> | undefined;
  let fixtures: FixtureServer | undefined;

  try {
    buildExtensionXpi(xpi);
    buildSeederXpi(seederXpi);
    writeScenarioHost(hostPath, resultPath);
    fixtures = await startFixtureServer();

    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: HOST_NAME,
        description: "Zen Agent transport proof (temporary)",
        path: hostPath,
        type: "stdio",
        allowed_extensions: [EXTENSION_ID],
      }),
    );

    instance = await launchScratchZen(zen, {
      headless,
      remoteAgent: false,
      // The startup tab is the media tab, so it is selected and foregrounded.
      startupUrl: fixtures.origin + "/audio",
      prepareProfile: (profileDir: string) => {
        writeUserJs(profileDir, seederOutput);
        const extensions = join(profileDir, "extensions");
        mkdirSync(extensions, { recursive: true });
        execFileSync("/bin/cp", [xpi, join(extensions, `${EXTENSION_ID}.xpi`)]);
        execFileSync("/bin/cp", [
          seederXpi,
          join(extensions, `${SEEDER_ID}.xpi`),
        ]);
      },
      env: { ZEN_AGENT_TEST_ORIGIN: fixtures.origin },
    });

    // Let the window settle, then take focus back before the scenario runs, so
    // "focus unchanged" measures the operations rather than the launch.
    await new Promise((r) => setTimeout(r, 4_000));
    const before = frontmostApp();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        const proof = JSON.parse(
          readFileSync(resultPath, "utf8"),
        ) as TransportProof;
        return {
          proof,
          stderr: instance.stderr(),
          frontmost: { before, after: frontmostApp() },
          media: summariseMedia(fixtures),
        };
      }

      if (instance.process.exitCode !== null) {
        throw new Error(
          `Zen exited before the proof was written\n${instance.stderr().slice(-6000)}`,
        );
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(
      `the transport proof produced no result within ${String(timeoutMs)}ms\n${instance
        .stderr()
        .slice(-6000)}`,
    );
  } finally {
    if (instance !== undefined) await instance.stop();
    fixtures?.server.close();
    rmSync(manifestPath, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}
