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

import { speechLocales } from "../../src/cli/speech.js";
import { launchScratchZen, type ZenBuild } from "./zen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, "../..");

const EXTENSION_ID = "zen-agent@zen-agent.local";
const HOST_NAME = "to.nodus.zen_agent";

/** The DEV-261 probe, reused here purely to create a second Space. */
const SEEDER_ID = "zen-agent-probe@zen-agent.local";
const SEEDER_FIXTURE = join(HERE, "fixtures/probe-extension");
const MACOS_WINDOW_INVENTORY_SOURCE = join(
  HERE,
  "macos-window-inventory.swift",
);

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
import { DaemonService } from ${JSON.stringify(join(REPO, "dist/daemon/service.js"))};
import { DAEMON_PROTOCOL_VERSION } from ${JSON.stringify(join(REPO, "dist/daemon/protocol.js"))};
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const resultPath = ${JSON.stringify(resultPath)};
const origin = process.env.ZEN_AGENT_TEST_ORIGIN;
const speechLocale = process.env.ZEN_AGENT_TEST_SPEECH_LOCALE || null;
const steps = [];
const claims = {};
const note = (name, value) => steps.push({ name, value });
let daemonRequestSequence = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daemonRequest(method, params, idempotencyKey, clientId = "headed-proof") {
  daemonRequestSequence += 1;
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "request",
    id: "headed-" + String(daemonRequestSequence),
    clientId,
    method,
    // Match the real MCP/socket boundary: entity IDs can share in-process
    // object references, while JSON transport carries independent plain data.
    ...(params === undefined
      ? {}
      : { params: JSON.parse(JSON.stringify(params)) }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

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

async function uniquePageNode(transport, target, locator) {
  const result = await transport.queryPage(target, {
    locator,
    maxResults: 2,
  });

  if (result.nodes.length !== 1) {
    throw new Error(
      "expected exactly one page node for " +
        JSON.stringify(locator) +
        ", received " +
        String(result.nodes.length),
    );
  }

  return result.nodes[0];
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

  // CLAIM: the semantic actor can snapshot and interact with the explicit
  // non-visible tab, including open shadow DOM and a cross-origin child frame,
  // without activation or native input.
  const page = await transport.snapshotPage(routedId, { maxNodes: 5000 });
  note("semanticPageCounts", {
    frames: page.frames.length,
    nodes: page.nodes.length,
    truncation: page.truncation,
  });
  const pageTarget = {
    tabId: routedId,
    documentId: page.documentId,
    snapshotId: page.snapshotId,
    frameRef: page.rootFrameRef,
  };
  const elementTarget = (node, target = pageTarget) => ({
    ...target,
    elementRef: node.elementRef,
  });
  const pageCapabilities = [
    "browser.pages.snapshot",
    "browser.pages.query",
    "browser.pages.click",
    "browser.pages.fill",
    "browser.pages.type",
    "browser.pages.press",
    "browser.pages.select",
    "browser.pages.check",
    "browser.pages.submit",
    "browser.pages.history",
    "browser.pages.upload",
    "browser.pages.media",
    "browser.pages.resource-fetch",
    "browser.pages.screenshot",
  ];
  claims.semanticCapabilities = pageCapabilities.every((capability) =>
    transport.capabilities.includes(capability),
  );
  claims.semanticSnapshotBounded =
    page.frames.length >= 3 &&
    page.frames.length <= 128 &&
    page.nodes.length <= 5000 &&
    !page.truncation.totalBytes;

  const closedHost = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "group",
    name: "Closed shadow boundary",
  });
  claims.semanticGeometryReported =
    closedHost.geometry.width > 0 &&
    closedHost.geometry.height > 0 &&
    closedHost.geometry.viewportWidth > 0 &&
    closedHost.geometry.viewportHeight > 0;
  claims.closedShadowBoundaryReported = closedHost.shadowRoot === "closed";

  const redCapture = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "img",
    name: "Red capture target",
  });
  const blueCapture = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "img",
    name: "Blue capture target",
  });
  const viewportShot = await transport.screenshotPage(pageTarget);
  const redShot = await transport.screenshotPage(elementTarget(redCapture));
  const blueShot = await transport.screenshotPage(elementTarget(blueCapture));
  claims.screenshotViewportAndElements =
    viewportShot.mimeType === "image/png" &&
    viewportShot.width > redShot.width &&
    viewportShot.height > redShot.height &&
    redShot.width === blueShot.width &&
    redShot.height === blueShot.height &&
    redShot.dataBase64 !== blueShot.dataBase64 &&
    viewportShot.dataBase64 !== redShot.dataBase64;
  claims.screenshotBoundsEnforced =
    [viewportShot, redShot, blueShot].every(
      (shot) =>
        shot.bytes > 0 &&
        shot.bytes <= 4 * 1024 * 1024 &&
        shot.width <= 4096 &&
        shot.height <= 4096,
    );
  try {
    await transport.screenshotPage(pageTarget, { scale: 2.01 });
    claims.screenshotInvalidScaleRefused = false;
  } catch (error) {
    claims.screenshotInvalidScaleRefused =
      error?.code === "invalid-request";
  }

  let fixtureMedia;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listed = await transport.listPageMedia(pageTarget);
    fixtureMedia = listed.media.find(
      (item) => item.sourceUrl === origin + "/clip.wav",
    );
    if (
      fixtureMedia?.captions.some(
        (track) => track.cuesAvailable && track.cues.length > 0,
      )
    ) {
      break;
    }
    await sleep(100);
  }
  if (fixtureMedia === undefined) {
    throw new Error("background media fixture was not listed");
  }
  const mediaBytes = await transport.fetchPageMedia(
    elementTarget(fixtureMedia),
    { maxBytes: 1024 * 1024 },
  );
  const mediaAfter = await transport.listPageMedia(pageTarget);
  const fixtureMediaAfter = mediaAfter.media.find(
    (item) => item.elementRef !== "" && item.sourceUrl === origin + "/clip.wav",
  );
  claims.mediaMetadataAndCaptions =
    fixtureMedia.kind === "audio" &&
    fixtureMedia.drm === false &&
    fixtureMedia.captions.some(
      (track) =>
        track.cuesAvailable &&
        track.cues.some((cue) => cue.text === "Proof caption"),
    );
  claims.mediaFetchBounded =
    mediaBytes.mimeType.startsWith("audio/wav") &&
    mediaBytes.bytes > 44 &&
    mediaBytes.bytes <= 1024 * 1024;
  claims.mediaFetchDidNotStartPlayback =
    fixtureMedia.paused &&
    fixtureMediaAfter !== undefined &&
    fixtureMediaAfter.paused &&
    fixtureMediaAfter.currentTime === fixtureMedia.currentTime;

  const resource = await transport.fetchPageResource(
    pageTarget,
    origin + "/resource.bin",
    { maxBytes: 64 },
  );
  claims.sameOriginResourceFetch =
    resource.mimeType === "application/octet-stream" &&
    Buffer.from(resource.dataBase64, "base64").toString("utf8") ===
      "resource-proof";
  for (const [name, url, maxBytes, code] of [
    [
      "crossOriginResourceRefused",
      origin.replace("127.0.0.1", "localhost") + "/resource.bin",
      64,
      "policy-rejection",
    ],
    ["redirectResourceRefused", origin + "/redirect", 64, "unsupported-capability"],
    ["oversizeResourceRefused", origin + "/oversize", 64, "payload-too-large"],
  ]) {
    try {
      await transport.fetchPageResource(pageTarget, url, { maxBytes });
      claims[name] = false;
    } catch (error) {
      claims[name] = error?.code === code;
    }
  }

  const inventoryBeforeUiRefusals = await transport.snapshot();
  const upload = await uniquePageNode(transport, pageTarget, {
    kind: "label",
    label: "Proof upload",
  });
  const stagedPath = resultPath + ".upload.txt";
  writeFileSync(stagedPath, "staged upload proof");
  const uploadResult = await transport.uploadPage(elementTarget(upload), [
    stagedPath,
  ]);
  const uploadInspection = await transport.inspectPage(routedId, {
    maxChars: 2000,
  });
  claims.pickerFreeUpload =
    uploadResult.fileCount === 1 &&
    uploadInspection.visibleText.includes("files:1");

  const staticBackgroundLink = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "link",
    name: "New tab link",
  });
  claims.targetBlankReportedForSafeRouting =
    staticBackgroundLink.backgroundUrl === origin + "/new-tab-target" &&
    staticBackgroundLink.actionHints.includes("open-background") &&
    !staticBackgroundLink.actionHints.includes("click");

  for (const [name, locator] of [
    ["targetBlankRefused", { kind: "role", role: "link", name: "New tab link" }],
    ["downloadRefused", { kind: "role", role: "link", name: "Download link" }],
    ["inlinePopupRefused", { kind: "role", role: "button", name: "Popup button" }],
  ]) {
    const node = await uniquePageNode(transport, pageTarget, locator);
    try {
      await transport.clickPage(elementTarget(node));
      claims[name] = false;
    } catch (error) {
      claims[name] = error?.code === "policy-rejection";
    }
  }
  const foregroundUiLocators = [
    ["dialogAttemptRefused", "Dialog button"],
    ["registeredDialogAttemptRefused", "Registered dialog button"],
    ["notificationPermissionRefused", "Notification permission button"],
    ["geolocationPermissionRefused", "Geolocation permission button"],
    ["microphonePermissionRefused", "Microphone permission button"],
    ["clipboardPermissionRefused", "Clipboard permission button"],
    ["webauthnPermissionRefused", "WebAuthn permission button"],
    ["paymentPermissionRefused", "Payment permission button"],
    ["fullscreenRefused", "Fullscreen button"],
    ["pointerLockRefused", "Pointer lock button"],
    ["nativePickerRefused", "Native picker button"],
  ];
  for (const [name, accessibleName] of foregroundUiLocators) {
    const node = await uniquePageNode(transport, pageTarget, {
      kind: "role",
      role: "button",
      name: accessibleName,
    });
    try {
      await transport.clickPage(elementTarget(node));
      claims[name] = false;
    } catch (error) {
      claims[name] = error?.code === "policy-rejection";
    }
  }
  const unsafeInput = await uniquePageNode(transport, pageTarget, {
    kind: "label",
    label: "Unsafe input",
  });
  try {
    await transport.fillPage(elementTarget(unsafeInput), "blocked");
    claims.inlineInputAttemptRefused = false;
  } catch (error) {
    claims.inlineInputAttemptRefused = error?.code === "policy-rejection";
  }
  const uiInspection = await transport.inspectPage(routedId, {
    maxChars: 4000,
  });
  claims.permissionAndForegroundUiAttemptsRefused =
    foregroundUiLocators.every(([name]) => claims[name] === true) &&
    claims.inlineInputAttemptRefused === true;
  claims.refusedUiHandlersNeverRan =
    uiInspection.visibleText.includes("ui-attempts:0");
  const inventoryAfterUiRefusals = await transport.snapshot();
  claims.uiRefusalsCreatedNoTabsOrWindows =
    inventoryAfterUiRefusals.tabs.length ===
      inventoryBeforeUiRefusals.tabs.length &&
    inventoryAfterUiRefusals.windows.length ===
      inventoryBeforeUiRefusals.windows.length;

  const increment = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "button",
    name: "Increment count",
  });
  await transport.clickPage(elementTarget(increment));

  const name = await uniquePageNode(transport, pageTarget, {
    kind: "label",
    label: "Name",
  });
  await transport.fillPage(elementTarget(name), "Ada");
  await transport.typePage(elementTarget(name), " Lovelace");

  const plan = await uniquePageNode(transport, pageTarget, {
    kind: "label",
    label: "Plan",
  });
  await transport.selectPage(elementTarget(plan), ["pro"]);
  const proOption = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "option",
    name: "Pro",
  });
  const selectedPro = await uniquePageNode(transport, pageTarget, {
    kind: "element",
    elementRef: proOption.elementRef,
  });
  claims.selectUpdatedSemanticState = selectedPro.state.selected === true;

  const agree = await uniquePageNode(transport, pageTarget, {
    kind: "label",
    label: "Accept terms",
  });
  await transport.checkPage(elementTarget(agree));
  const checkedAgree = await uniquePageNode(transport, pageTarget, {
    kind: "element",
    elementRef: agree.elementRef,
  });
  claims.checkUpdatedSemanticState = checkedAgree.state.checked === true;
  await transport.uncheckPage(elementTarget(agree));
  const uncheckedAgree = await uniquePageNode(transport, pageTarget, {
    kind: "element",
    elementRef: agree.elementRef,
  });
  claims.uncheckUpdatedSemanticState = uncheckedAgree.state.checked === false;

  const email = await uniquePageNode(transport, pageTarget, {
    kind: "label",
    label: "Email",
  });
  await transport.fillPage(elementTarget(email), "agent@example.test");
  await transport.pressPage(elementTarget(email), { key: "Enter" });
  const formInspection = await transport.inspectPage(routedId, {
    maxChars: 1000,
  });
  claims.domInteractionChangedOnlyTargetPage =
    formInspection.visibleText.includes("1") &&
    formInspection.visibleText.includes("submitted");

  const replaceable = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "button",
    name: "Replace me",
  });
  const replace = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "button",
    name: "Replace target",
  });
  await transport.clickPage(elementTarget(replace));
  let staleElement = false;
  try {
    await transport.clickPage(elementTarget(replaceable));
  } catch (error) {
    staleElement = error?.code === "stale-element";
  }
  claims.replacedElementFailsStale = staleElement;

  const shadowButton = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "button",
    name: "Shadow action",
  });
  await transport.clickPage(elementTarget(shadowButton));
  const shadowResult = await uniquePageNode(transport, pageTarget, {
    kind: "role",
    role: "status",
    name: "Shadow clicked",
  });
  claims.openShadowRootInteraction = shadowResult.visible;

  const sameOriginFrame = page.frames.find(
    (frame) =>
      frame.url === origin + "/same-frame" &&
      frame.availability === "available",
  );
  if (sameOriginFrame === undefined || sameOriginFrame.documentId === null) {
    throw new Error("same-origin child frame was not available");
  }
  const sameOriginTarget = {
    tabId: routedId,
    documentId: page.documentId,
    snapshotId: page.snapshotId,
    frameRef: sameOriginFrame.frameRef,
  };
  const sameOriginButton = await uniquePageNode(transport, sameOriginTarget, {
    kind: "role",
    role: "button",
    name: "Same-origin action",
  });
  await transport.clickPage(elementTarget(sameOriginButton, sameOriginTarget));
  const sameOriginResult = await uniquePageNode(transport, sameOriginTarget, {
    kind: "role",
    role: "status",
    name: "Same-origin clicked",
  });
  claims.sameOriginFrameInteraction = sameOriginResult.visible;

  const childFrame = page.frames.find(
    (frame) =>
      frame.url.startsWith("http://localhost:") &&
      frame.availability === "available",
  );
  if (childFrame === undefined || childFrame.documentId === null) {
    throw new Error("cross-origin child frame was not available");
  }
  const childTarget = {
    tabId: routedId,
    documentId: page.documentId,
    snapshotId: page.snapshotId,
    frameRef: childFrame.frameRef,
  };
  const frameButton = await uniquePageNode(transport, childTarget, {
    kind: "role",
    role: "button",
    name: "Frame action",
  });
  await transport.clickPage(elementTarget(frameButton, childTarget));
  const frameResult = await uniquePageNode(transport, childTarget, {
    kind: "role",
    role: "status",
    name: "Frame clicked",
  });
  claims.crossOriginFrameInteraction = frameResult.visible;
  const selectedAfterPageInteraction = selectedIds(await transport.snapshot());
  note("selectedAfterPageInteraction", selectedAfterPageInteraction);
  claims.pageInteractionLeftTabUnselected =
    JSON.stringify(selectedAfterPageInteraction) ===
    JSON.stringify(before.selected);

  // CLAIM: the accepted file/media capabilities also work through the shared
  // daemon policy layer, not merely through the lower transport. The configured
  // destination is inside this run's throwaway directory.
  const downloadDirectory = resultPath + ".downloads";
  mkdirSync(downloadDirectory, { recursive: true });
  writeFileSync(downloadDirectory + "/report.txt", "existing");
  const daemon = new DaemonService({
    transportFactory: () => transport,
    reconcileIntervalMs: 0,
    config: {
      version: 2,
      profile: snapshot.profiles[0].id.transportId,
      profileMatch: "exact",
      privateWindows: "hidden",
      spaces: { aliases: {} },
      routing: { rules: [] },
      downloads: { directory: downloadDirectory },
      backgroundLaunch: { policy: "disabled" },
      speech: {
        installedLocales: speechLocale === null ? [] : [speechLocale],
      },
    },
  });
  await daemon.start();
  const daemonPage = await daemon.handle(
    daemonRequest("pages.snapshot", { tabId: routed.id }),
  );
  const daemonPageTarget = {
    tabId: daemonPage.tabId,
    documentId: daemonPage.documentId,
    snapshotId: daemonPage.snapshotId,
    frameRef: daemonPage.rootFrameRef,
  };
  const daemonMedia = await daemon.handle(
    daemonRequest("pages.media.list", { target: daemonPageTarget }),
  );
  const captionedMedia = daemonMedia.media.find(
    (item) => item.sourceUrl === origin + "/clip.wav",
  );
  if (captionedMedia === undefined) {
    throw new Error("daemon did not list the captioned media fixture");
  }
  const captionTranscript = await daemon.handle(
    daemonRequest(
      "pages.media.transcribe",
      {
        target: {
          ...daemonPageTarget,
          elementRef: captionedMedia.elementRef,
        },
        locale: "en-US",
      },
      "caption-transcript",
    ),
  );
  claims.daemonCaptionTranscription =
    captionTranscript.source === "captions" &&
    captionTranscript.text.includes("Proof caption");

  if (speechLocale === null) {
    note("onDeviceSpeechProof", {
      status: "not-run",
      reason: "en-US model is not installed",
    });
    claims.actualOnDeviceSpeechWhenAssetsInstalled = true;
  } else {
    const speechMedia = daemonMedia.media.find(
      (item) => item.sourceUrl === origin + "/speech.aiff",
    );
    if (speechMedia === undefined) {
      throw new Error("daemon did not list the speech media fixture");
    }
    const speechTranscript = await daemon.handle(
      daemonRequest(
        "pages.media.transcribe",
        {
          target: {
            ...daemonPageTarget,
            elementRef: speechMedia.elementRef,
          },
          locale: speechLocale,
          maxBytes: 8 * 1024 * 1024,
        },
        "speech-transcript",
      ),
    );
    note("onDeviceSpeechProof", {
      status: "completed",
      source: speechTranscript.source,
      locale: speechTranscript.locale,
      textPresent: speechTranscript.text.trim().length > 0,
    });
    claims.actualOnDeviceSpeechWhenAssetsInstalled =
      speechTranscript.source === "on-device-speech" &&
      speechTranscript.locale === speechLocale &&
      speechTranscript.text.trim().length > 0;
  }

  const downloaded = await daemon.handle(
    daemonRequest(
      "pages.resource.download",
      {
        target: daemonPageTarget,
        url: origin + "/resource.bin",
        fileName: "report.txt",
        maxBytes: 64,
      },
      "download-resource",
    ),
  );
  claims.daemonDownloadIsBoundedAndCollisionSafe =
    downloaded.path === downloadDirectory + "/report (1).txt" &&
    downloaded.bytes === Buffer.byteLength("resource-proof") &&
    readFileSync(downloadDirectory + "/report.txt", "utf8") === "existing" &&
    readFileSync(downloaded.path, "utf8") === "resource-proof";

  const daemonWindow = snapshot.windows[0];
  const daemonSpace = snapshot.spaces.find(
    (space) =>
      space.id.transportId.slice(space.id.transportId.indexOf("/") + 1) ===
      homeSpace.id,
  );
  if (daemonWindow === undefined || daemonSpace === undefined) {
    throw new Error("daemon cleanup proof could not resolve its window and Space");
  }
  const temporary = await daemon.handle(
    daemonRequest(
      "tabs.open",
      {
        url: origin + "/temporary",
        windowId: daemonWindow.id,
        spaceId: daemonSpace.id,
        temporary: true,
      },
      "open-temporary",
      "cleanup-owner",
    ),
  );
  if (temporary.tabId === null) {
    throw new Error("daemon did not return the temporary tab ID");
  }
  let otherClientCleanupRefused = false;
  try {
    await daemon.handle(
      daemonRequest(
        "tabs.cleanup",
        { tabId: temporary.tabId, action: "close" },
        "other-client-cleanup",
        "cleanup-other",
      ),
    );
  } catch (error) {
    otherClientCleanupRefused =
      error?.code === "policy-rejection" &&
      error?.data?.reason === "cleanup-owner";
  }
  const ownerCleanup = await daemon.handle(
    daemonRequest(
      "tabs.cleanup",
      { tabId: temporary.tabId, action: "close" },
      "owner-cleanup",
      "cleanup-owner",
    ),
  );
  let afterTemporaryCleanup = await transport.snapshot();
  for (
    let attempt = 0;
    attempt < 20 &&
    tabById(afterTemporaryCleanup, temporary.tabId.transportId) !== undefined;
    attempt += 1
  ) {
    await sleep(100);
    afterTemporaryCleanup = await transport.snapshot();
  }
  note("daemonCleanupOwnership", {
    otherClientCleanupRefused,
    ownerOutcome: ownerCleanup.outcome,
    ownerReason: ownerCleanup.reason ?? null,
    tabStillPresent:
      tabById(afterTemporaryCleanup, temporary.tabId.transportId) !==
      undefined,
  });
  const temporaryStillPresent =
    tabById(afterTemporaryCleanup, temporary.tabId.transportId) !== undefined;
  claims.daemonCleanupHonorsOwnership =
    otherClientCleanupRefused &&
    ((ownerCleanup.outcome === "closed" && !temporaryStillPresent) ||
      (ownerCleanup.outcome === "kept" &&
        temporaryStillPresent &&
        ["reused", "selected", "played-media", "changed"].includes(
          ownerCleanup.reason,
        )));

  const changedTemporary = await daemon.handle(
    daemonRequest(
      "tabs.open",
      {
        url: origin + "/temporary-changed",
        windowId: daemonWindow.id,
        spaceId: daemonSpace.id,
        temporary: true,
      },
      "open-changed-temporary",
      "cleanup-owner",
    ),
  );
  if (changedTemporary.tabId === null) {
    throw new Error("daemon did not return the changed temporary tab ID");
  }
  await daemon.handle(
    daemonRequest(
      "tabs.navigate",
      {
        tabId: changedTemporary.tabId,
        url: origin + "/temporary-adopted",
      },
      "change-temporary",
      "cleanup-owner",
    ),
  );
  const changedCleanup = await daemon.handle(
    daemonRequest(
      "tabs.cleanup",
      { tabId: changedTemporary.tabId, action: "close" },
      "cleanup-changed",
      "cleanup-owner",
    ),
  );
  let untrackedCleanupRefused = false;
  try {
    await daemon.handle(
      daemonRequest(
        "tabs.cleanup",
        { tabId: routed.id, action: "close" },
        "cleanup-untracked",
        "cleanup-owner",
      ),
    );
  } catch (error) {
    untrackedCleanupRefused =
      error?.code === "policy-rejection" &&
      error?.data?.reason === "cleanup-not-temporary";
  }
  claims.daemonCleanupKeepsChangedAndUntrackedTabs =
    changedCleanup.outcome === "kept" && untrackedCleanupRefused;
  await daemon.handle(
    daemonRequest(
      "tabs.close",
      { tabId: changedTemporary.tabId },
      "close-changed-fixture",
      "cleanup-owner",
    ),
  );
  claims.daemonFlowsLeftSelectionUnchanged =
    JSON.stringify(selectedIds(await transport.snapshot())) ===
    JSON.stringify(before.selected);

  await transport.navigateTab(routedId, origin + "/history-1");
  await sleep(1500);
  let staleDocument = false;
  try {
    await transport.queryPage(pageTarget, {
      locator: { kind: "text", text: "Background actor visible text" },
    });
  } catch (error) {
    staleDocument = error?.code === "stale-document";
  }
  claims.replacedDocumentFailsStale = staleDocument;

  await transport.navigateTab(routedId, origin + "/history-2");
  await sleep(1500);
  const historyTwo = await transport.snapshotPage(routedId);
  await transport.backPage({
    tabId: routedId,
    documentId: historyTwo.documentId,
  });
  await sleep(1500);
  const afterBack = await transport.snapshotPage(routedId);
  claims.backgroundHistoryBack =
    afterBack.url === origin + "/history-1";
  await transport.forwardPage({
    tabId: routedId,
    documentId: afterBack.documentId,
  });
  await sleep(1500);
  const afterForward = await transport.snapshotPage(routedId);
  claims.backgroundHistoryForward =
    afterForward.url === origin + "/history-2";
  const selectedAfterHistory = selectedIds(await transport.snapshot());
  note("selectedAfterHistory", selectedAfterHistory);
  claims.historyLeftTabUnselected =
    JSON.stringify(selectedAfterHistory) === JSON.stringify(before.selected);

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
  note("selectedAfterMove", selectedIds(snapshot));
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

  await daemon.stop();
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

function writeUserJs(
  profileDir: string,
  seederOutput: string,
  uiOutput: string,
): void {
  const prefs: Record<string, string | boolean | number> = {
    "extensions.experiments.enabled": true,
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,
    "extensions.startupScanScopes": 15,
    "zenagent.probe.output": seederOutput,
    "zenagent.probe.ui-output": uiOutput,
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

function buildInstalledSpeechFixture(
  workDir: string,
): { readonly locale: string; readonly audio: Buffer } | undefined {
  let installedLocales: readonly string[];

  try {
    installedLocales = speechLocales().installedLocales;
  } catch {
    return undefined;
  }

  if (!installedLocales.includes("en-US")) {
    return undefined;
  }

  const audioPath = join(workDir, "speech-proof.aiff");

  try {
    // `say -o` renders into a file and never plays audio or opens UI. This is
    // only a deterministic prerecorded fixture for a model already installed
    // by explicit setup; the headed run never downloads a speech asset.
    execFileSync("/usr/bin/say", [
      "-o",
      audioPath,
      "Zen agent background speech proof",
    ]);
    return {
      locale: "en-US",
      audio: readFileSync(audioPath),
    };
  } catch {
    return undefined;
  }
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
function startFixtureServer(
  options: {
    readonly speechAudio?: Buffer;
  } = {},
): Promise<FixtureServer> {
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
<h1>Background actor visible text</h1>
<p hidden>SHOULD NOT APPEAR</p>
<button id="increment" aria-label="Increment count">Increment</button>
<output id="count">0</output>
<label>Name <input id="name" autocomplete="off"></label>
<label>Plan
  <select id="plan">
    <option value="starter">Starter</option>
    <option value="pro">Pro</option>
  </select>
</label>
<label><input id="agree" type="checkbox"> Accept terms</label>
<form id="signup">
  <label>Email <input id="email" type="email" autocomplete="off"></label>
  <button type="submit">Submit form</button>
</form>
<output id="submitted">not submitted</output>
<button id="replace">Replace target</button>
<button id="replaceable">Replace me</button>
<div id="shadow-host"></div>
<div
  id="closed-shadow-host"
  role="group"
  aria-label="Closed shadow boundary"
  style="width: 40px; height: 20px"
></div>
<div
  id="red-capture"
  role="img"
  aria-label="Red capture target"
  style="width: 80px; height: 60px; background: rgb(255, 0, 0)"
></div>
<div
  id="blue-capture"
  role="img"
  aria-label="Blue capture target"
  style="width: 80px; height: 60px; background: rgb(0, 0, 255)"
></div>
<audio id="proof-media" preload="auto" src="/clip.wav">
  <track
    default
    kind="captions"
    label="Proof captions"
    srclang="en"
    src="/proof.vtt"
  >
</audio>
<audio id="proof-speech-media" preload="metadata" src="/speech.aiff"></audio>
<label>Proof upload <input id="proof-upload" type="file"></label>
<output id="upload-result">files:0</output>
<a href="/new-tab-target" target="_blank">New tab link</a>
<a href="/resource.bin" download="proof.bin">Download link</a>
<button type="button" onclick="window.open('/popup')">Popup button</button>
<button type="button" onclick="recordUiAttempt(); alert('blocked')">
  Dialog button
</button>
<button id="registered-dialog" type="button">Registered dialog button</button>
<label>
  Unsafe input
  <input
    id="unsafe-input"
    autocomplete="off"
    oninput="recordUiAttempt(); alert('blocked')"
  >
</label>
<button
  type="button"
  onclick="recordUiAttempt(); Notification.requestPermission()"
>
  Notification permission button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); navigator.geolocation.getCurrentPosition(() => {})"
>
  Geolocation permission button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); navigator.mediaDevices.getUserMedia({ audio: true })"
>
  Microphone permission button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); navigator.clipboard.readText()"
>
  Clipboard permission button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); navigator.credentials.get({ publicKey: {} })"
>
  WebAuthn permission button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); new PaymentRequest([], {}).show()"
>
  Payment permission button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); this.requestFullscreen()"
>
  Fullscreen button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); this.requestPointerLock()"
>
  Pointer lock button
</button>
<button
  type="button"
  onclick="recordUiAttempt(); window.showOpenFilePicker()"
>
  Native picker button
</button>
<output id="ui-attempts">ui-attempts:0</output>
<iframe
  id="same-origin-frame"
  title="Same-origin fixture"
  src="/same-frame"
></iframe>
<iframe
  id="cross-origin-frame"
  title="Cross-origin fixture"
  src="http://localhost:${String(
    (server.address() as { port?: number } | null)?.port ?? 0,
  )}/frame"
></iframe>
<p>${"bounded ".repeat(40)}</p>
<script>
  let uiAttempts = 0;
  const recordUiAttempt = () => {
    uiAttempts += 1;
    document.getElementById("ui-attempts").value =
      "ui-attempts:" + String(uiAttempts);
  };
  const count = document.getElementById("count");
  document.getElementById("increment").addEventListener("click", () => {
    count.value = String(Number(count.value) + 1);
  });
  document.getElementById("registered-dialog").addEventListener("click", () => {
    recordUiAttempt();
    alert("blocked");
  });
  document.getElementById("signup").addEventListener("submit", (event) => {
    event.preventDefault();
    document.getElementById("submitted").value = "submitted";
  });
  document.getElementById("replace").addEventListener("click", () => {
    const previous = document.getElementById("replaceable");
    const replacement = previous.cloneNode(true);
    replacement.textContent = "Replacement";
    previous.replaceWith(replacement);
  });
  const shadow = document
    .getElementById("shadow-host")
    .attachShadow({ mode: "open" });
  shadow.innerHTML =
    '<button id="shadow-button" aria-label="Shadow action">Shadow</button>' +
    '<output id="shadow-result" role="status" aria-label="Shadow idle">idle</output>';
  shadow
    .getElementById("shadow-button")
    .addEventListener("click", () => {
      const result = shadow.getElementById("shadow-result");
      result.value = "clicked";
      result.setAttribute("aria-label", "Shadow clicked");
    });
  const closedShadow = document
    .getElementById("closed-shadow-host")
    .attachShadow({ mode: "closed" });
  closedShadow.innerHTML = "<button>Must stay opaque</button>";
  const proofMedia = document.getElementById("proof-media");
  if (proofMedia.textTracks[0]) {
    proofMedia.textTracks[0].mode = "hidden";
  }
  const proofCaptionTrack = proofMedia.addTextTrack(
    "captions",
    "Deterministic proof captions",
    "en",
  );
  proofCaptionTrack.mode = "hidden";
  proofCaptionTrack.addCue(new VTTCue(0, 1, "Proof caption"));
  proofMedia.addEventListener("loadedmetadata", () => {
    if (proofMedia.textTracks[0]) {
      proofMedia.textTracks[0].mode = "hidden";
    }
  });
  document.getElementById("proof-upload").addEventListener("change", (event) => {
    document.getElementById("upload-result").value =
      "files:" + event.currentTarget.files.length;
  });
</script>`);
      return;
    }

    if (request.url === "/clip.wav") {
      response.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(wav.byteLength),
      });
      response.end(wav);
      return;
    }

    if (request.url === "/speech.aiff") {
      if (options.speechAudio === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "audio/aiff",
        "content-length": String(options.speechAudio.byteLength),
      });
      response.end(options.speechAudio);
      return;
    }

    if (request.url === "/proof.vtt") {
      response.writeHead(200, { "content-type": "text/vtt" });
      response.end(
        "WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nProof caption\\n",
      );
      return;
    }

    if (request.url === "/resource.bin") {
      const resource = Buffer.from("resource-proof");
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(resource.byteLength),
      });
      response.end(resource);
      return;
    }

    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/resource.bin" }).end();
      return;
    }

    if (request.url === "/oversize") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "1024",
      });
      response.end(Buffer.alloc(1024, 1));
      return;
    }

    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
<title>cross-origin frame</title>
<button id="frame-button" aria-label="Frame action">Frame action</button>
<output id="frame-result" role="status" aria-label="Frame idle">idle</output>
<script>
  document.getElementById("frame-button").addEventListener("click", () => {
    const result = document.getElementById("frame-result");
    result.value = "clicked";
    result.setAttribute("aria-label", "Frame clicked");
  });
</script>`);
      return;
    }

    if (request.url === "/same-frame") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
<title>same-origin frame</title>
<button id="same-frame-button" aria-label="Same-origin action">Act</button>
<output
  id="same-frame-result"
  role="status"
  aria-label="Same-origin idle"
>idle</output>
<script>
  document.getElementById("same-frame-button").addEventListener("click", () => {
    const result = document.getElementById("same-frame-result");
    result.value = "clicked";
    result.setAttribute("aria-label", "Same-origin clicked");
  });
</script>`);
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
  readonly frontmost: {
    before: string;
    after: string;
    samples: readonly string[];
  };
  /** Cursor coordinates sampled throughout the scenario. */
  readonly cursor: {
    before: string;
    after: string;
    samples: readonly string[];
  };
  /**
   * Two independent read-only observers: browser chrome catches doorhangers and
   * download panels inside the existing window; WindowServer catches any new
   * Zen-owned panel/window or system-notification surface.
   */
  readonly foregroundUi: {
    readonly chrome: {
      readonly samples: number;
      readonly sawOpenChromePopup: boolean;
      readonly sawDownloadPanel: boolean;
      readonly sawAdditionalBrowserWindow: boolean;
    };
    readonly newZenWindows: readonly {
      readonly id: number;
      readonly owner: string;
      readonly layer: number;
    }[];
    readonly newNotificationWindows: readonly {
      readonly id: number;
      readonly owner: string;
      readonly layer: number;
    }[];
  };
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

function cursorPosition(): string {
  try {
    return execFileSync("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); var p = $.NSEvent.mouseLocation; p.x + "," + p.y',
    ])
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

interface MacOSWindowDescription {
  readonly id: number;
  readonly owner: string;
  readonly layer: number;
}

function isRecordValue(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildMacOSWindowInventory(destination: string): void {
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    MACOS_WINDOW_INVENTORY_SOURCE,
    "-o",
    destination,
  ]);
}

function macOSWindowInventory(
  executable: string,
): readonly MacOSWindowDescription[] {
  const value = JSON.parse(
    execFileSync(executable, { encoding: "utf8" }),
  ) as unknown;

  if (!Array.isArray(value)) {
    throw new Error(
      "the read-only macOS window observer returned invalid data",
    );
  }

  return value.flatMap((item) => {
    if (!isRecordValue(item)) {
      return [];
    }
    if (
      typeof item["id"] !== "number" ||
      typeof item["owner"] !== "string" ||
      typeof item["layer"] !== "number"
    ) {
      return [];
    }
    return [{ id: item["id"], owner: item["owner"], layer: item["layer"] }];
  });
}

function observeNewForegroundWindows(
  inventory: readonly MacOSWindowDescription[],
  baselineIds: ReadonlySet<number>,
  newZenWindows: Map<number, MacOSWindowDescription>,
  newNotificationWindows: Map<number, MacOSWindowDescription>,
): void {
  for (const window of inventory) {
    if (baselineIds.has(window.id)) {
      continue;
    }
    const owner = window.owner.toLowerCase();
    if (owner.includes("zen")) {
      newZenWindows.set(window.id, window);
    }
    if (owner.includes("notification")) {
      newNotificationWindows.set(window.id, window);
    }
  }
}

function restoreFrontmostApp(application: string): void {
  if (application === "unknown") {
    return;
  }

  try {
    execFileSync("/usr/bin/osascript", [
      "-e",
      `tell application ${JSON.stringify(application)} to activate`,
    ]);
  } catch {
    // The before/after assertion will report that the precondition could not
    // be restored. Do not hide it by substituting another application.
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
  const uiOutput = join(workDir, "ui-evidence.json");
  const hostPath = join(workDir, "host.mjs");
  const windowInventoryExecutable = join(workDir, "window-inventory");
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
    buildMacOSWindowInventory(windowInventoryExecutable);
    buildExtensionXpi(xpi);
    buildSeederXpi(seederXpi);
    writeScenarioHost(hostPath, resultPath);
    const speechFixture = buildInstalledSpeechFixture(workDir);
    fixtures = await startFixtureServer({
      ...(speechFixture === undefined
        ? {}
        : { speechAudio: speechFixture.audio }),
    });

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
        writeUserJs(profileDir, seederOutput, uiOutput);
        const extensions = join(profileDir, "extensions");
        mkdirSync(extensions, { recursive: true });
        execFileSync("/bin/cp", [xpi, join(extensions, `${EXTENSION_ID}.xpi`)]);
        execFileSync("/bin/cp", [
          seederXpi,
          join(extensions, `${SEEDER_ID}.xpi`),
        ]);
      },
      env: {
        ZEN_AGENT_TEST_ORIGIN: fixtures.origin,
        ...(speechFixture === undefined
          ? {}
          : { ZEN_AGENT_TEST_SPEECH_LOCALE: speechFixture.locale }),
      },
    });

    // Let the window settle, then take focus back before the scenario runs, so
    // "focus unchanged" measures the operations rather than the launch.
    await new Promise((r) => setTimeout(r, 4_000));
    restoreFrontmostApp("Finder");
    await new Promise((r) => setTimeout(r, 1_000));
    const before = frontmostApp();
    const frontmostSamples = [before];
    const cursorBefore = cursorPosition();
    const cursorSamples = [cursorBefore];
    const initialWindowInventory = macOSWindowInventory(
      windowInventoryExecutable,
    );
    const baselineWindowIds = new Set(
      initialWindowInventory.map((window) => window.id),
    );
    const newZenWindows = new Map<number, MacOSWindowDescription>();
    const newNotificationWindows = new Map<number, MacOSWindowDescription>();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        observeNewForegroundWindows(
          macOSWindowInventory(windowInventoryExecutable),
          baselineWindowIds,
          newZenWindows,
          newNotificationWindows,
        );
        if (!existsSync(uiOutput)) {
          throw new Error(
            "the browser-chrome foreground UI observer produced no evidence",
          );
        }
        const proof = JSON.parse(
          readFileSync(resultPath, "utf8"),
        ) as TransportProof;
        const chrome = JSON.parse(readFileSync(uiOutput, "utf8")) as {
          samples: number;
          sawOpenChromePopup: boolean;
          sawDownloadPanel: boolean;
          sawAdditionalBrowserWindow: boolean;
        };
        return {
          proof,
          stderr: instance.stderr(),
          frontmost: {
            before,
            after: frontmostApp(),
            samples: frontmostSamples,
          },
          cursor: {
            before: cursorBefore,
            after: cursorPosition(),
            samples: cursorSamples,
          },
          foregroundUi: {
            chrome,
            newZenWindows: [...newZenWindows.values()],
            newNotificationWindows: [...newNotificationWindows.values()],
          },
          media: summariseMedia(fixtures),
        };
      }

      if (instance.process.exitCode !== null) {
        throw new Error(
          `Zen exited before the proof was written\n${instance.stderr().slice(-6000)}`,
        );
      }

      await new Promise((r) => setTimeout(r, 100));
      frontmostSamples.push(frontmostApp());
      cursorSamples.push(cursorPosition());
      observeNewForegroundWindows(
        macOSWindowInventory(windowInventoryExecutable),
        baselineWindowIds,
        newZenWindows,
        newNotificationWindows,
      );
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
