/**
 * DEV-273 acceptance: the transport, against a real Zen.
 *
 * Skipped unless `ZEN_SPIKE=1`, like every other browser-dependent test here,
 * because CI has no Zen. Runs headed by default: focus and media playback are
 * not meaningfully observable in a headless instance, and those are two of the
 * invariants this exists to check.
 */

import { describe, expect, it } from "vitest";

import {
  runTransportProof,
  type MediaEvidence,
  type TransportProof,
} from "./transport-extension.js";
import { locateZen } from "./zen.js";

const enabled = process.env["ZEN_SPIKE"] === "1";
const zen = enabled ? locateZen() : undefined;

describe.skipIf(!enabled || zen === undefined)(
  "the Zen transport against a real browser",
  () => {
    let proof: TransportProof;
    let frontmost: {
      before: string;
      after: string;
      samples: readonly string[];
    };
    let cursor: {
      before: string;
      after: string;
      samples: readonly string[];
    };
    let foregroundUi: Awaited<
      ReturnType<typeof runTransportProof>
    >["foregroundUi"];
    let media: MediaEvidence;

    it("runs the scenario end to end", async () => {
      if (zen === undefined) return;

      const run = await runTransportProof(zen, {
        headless: process.env["ZEN_SPIKE_HEADLESS"] === "1",
      });
      proof = run.proof;
      frontmost = run.frontmost;
      cursor = run.cursor;
      foregroundUi = run.foregroundUi;
      media = run.media;

      // Surface the whole thing on failure; a bare boolean here would be
      // useless when a Zen release moves an internal.
      expect(proof.ok, JSON.stringify(proof, null, 2)).toBe(true);
      expect(proof.error).toBeUndefined();
    }, 300_000);

    it("loads an MV3 add-on that also declares experiment_apis", () => {
      // The one thing DEV-261 proved only in halves. If this fails, the add-on
      // has to drop to MV2 and lose the event-page keepalive guarantee.
      expect(proof.capabilities ?? []).toContain(
        "zen.tabs.enumerate-all-spaces",
      );
    });

    it("enumerates tabs in a Space that is not visible", () => {
      expect(proof.claims?.["enumeratesMoreThanOneSpace"]).toBe(true);
    });

    it("opens a background tab in the requested Space", () => {
      expect(proof.claims?.["routedTabExists"]).toBe(true);
      expect(proof.claims?.["routedIntoRequestedSpace"]).toBe(true);
      expect(proof.claims?.["routedTabNotSelected"]).toBe(true);
    });

    it("inspects bounded visible text in the non-visible Space", () => {
      expect(proof.claims?.["inspectionCapability"]).toBe(true);
      expect(proof.claims?.["inspectedBackgroundUrl"]).toBe(true);
      expect(proof.claims?.["inspectedBackgroundTitle"]).toBe(true);
      expect(proof.claims?.["inspectedBoundedVisibleText"]).toBe(true);
      expect(proof.claims?.["inspectionLeftTabUnselected"]).toBe(true);
    });

    it("snapshots and interacts with semantic page targets in the background", () => {
      expect(proof.claims?.["semanticCapabilities"]).toBe(true);
      expect(proof.claims?.["semanticSnapshotBounded"]).toBe(true);
      expect(proof.claims?.["semanticGeometryReported"]).toBe(true);
      expect(proof.claims?.["closedShadowBoundaryReported"]).toBe(true);
      expect(proof.claims?.["domInteractionChangedOnlyTargetPage"]).toBe(true);
      expect(proof.claims?.["selectUpdatedSemanticState"]).toBe(true);
      expect(proof.claims?.["checkUpdatedSemanticState"]).toBe(true);
      expect(proof.claims?.["uncheckUpdatedSemanticState"]).toBe(true);
      expect(proof.claims?.["openShadowRootInteraction"]).toBe(true);
      expect(proof.claims?.["sameOriginFrameInteraction"]).toBe(true);
      expect(proof.claims?.["crossOriginFrameInteraction"]).toBe(true);
      expect(proof.claims?.["pageInteractionLeftTabUnselected"]).toBe(true);
    });

    it("captures bounded background viewport and element screenshots", () => {
      expect(proof.claims?.["screenshotViewportAndElements"]).toBe(true);
      expect(proof.claims?.["screenshotBoundsEnforced"]).toBe(true);
      expect(proof.claims?.["screenshotInvalidScaleRefused"]).toBe(true);
    });

    it("reads captions and bounded media bytes without starting playback", () => {
      expect(proof.claims?.["mediaMetadataAndCaptions"]).toBe(true);
      expect(proof.claims?.["mediaFetchBounded"]).toBe(true);
      expect(proof.claims?.["mediaFetchDidNotStartPlayback"]).toBe(true);
    });

    it("fetches only bounded same-origin non-redirected resources", () => {
      expect(proof.claims?.["sameOriginResourceFetch"]).toBe(true);
      expect(proof.claims?.["crossOriginResourceRefused"]).toBe(true);
      expect(proof.claims?.["redirectResourceRefused"]).toBe(true);
      expect(proof.claims?.["oversizeResourceRefused"]).toBe(true);
    });

    it("uploads without a picker and refuses popup-capable targets", () => {
      expect(proof.claims?.["pickerFreeUpload"]).toBe(true);
      expect(proof.claims?.["targetBlankReportedForSafeRouting"]).toBe(true);
      expect(proof.claims?.["targetBlankRefused"]).toBe(true);
      expect(proof.claims?.["downloadRefused"]).toBe(true);
      expect(proof.claims?.["inlinePopupRefused"]).toBe(true);
      expect(proof.claims?.["uiRefusalsCreatedNoTabsOrWindows"]).toBe(true);
      expect(proof.claims?.["permissionAndForegroundUiAttemptsRefused"]).toBe(
        true,
      );
      expect(proof.claims?.["refusedUiHandlersNeverRan"]).toBe(true);
    });

    it("observes no permission panel, download UI, picker, or notification", () => {
      expect(foregroundUi.chrome.samples).toBeGreaterThan(0);
      expect(foregroundUi.chrome.sawOpenChromePopup).toBe(false);
      expect(foregroundUi.chrome.sawDownloadPanel).toBe(false);
      expect(foregroundUi.chrome.sawAdditionalBrowserWindow).toBe(false);
      expect(foregroundUi.newZenWindows).toEqual([]);
      expect(foregroundUi.newNotificationWindows).toEqual([]);
    });

    it("runs bounded download, transcription, and conservative cleanup through the daemon", () => {
      expect(proof.claims?.["daemonCaptionTranscription"]).toBe(true);
      expect(proof.claims?.["actualOnDeviceSpeechWhenAssetsInstalled"]).toBe(
        true,
      );
      expect(proof.claims?.["daemonDownloadIsBoundedAndCollisionSafe"]).toBe(
        true,
      );
      expect(proof.claims?.["daemonCleanupHonorsOwnership"]).toBe(true);
      expect(proof.claims?.["daemonCleanupKeepsChangedAndUntrackedTabs"]).toBe(
        true,
      );
      expect(proof.claims?.["daemonFlowsLeftSelectionUnchanged"]).toBe(true);
    });

    it("fails stale references and traverses history without activation", () => {
      expect(proof.claims?.["replacedElementFailsStale"]).toBe(true);
      expect(proof.claims?.["replacedDocumentFailsStale"]).toBe(true);
      expect(proof.claims?.["backgroundHistoryBack"]).toBe(true);
      expect(proof.claims?.["backgroundHistoryForward"]).toBe(true);
      expect(proof.claims?.["historyLeftTabUnselected"]).toBe(true);
    });

    it("keeps a tab's identity across a Space change", () => {
      expect(proof.claims?.["moveChangedSpace"]).toBe(true);
      expect(proof.claims?.["identitySurvivesSpaceMove"]).toBe(true);
      expect(proof.claims?.["allOriginalIdsStillValid"]).toBe(true);
    });

    it("never changes the selected tab", () => {
      expect(proof.claims?.["selectedTabUnchangedByOpen"]).toBe(true);
      expect(proof.claims?.["selectedTabUnchangedByMove"]).toBe(true);
      expect(proof.claims?.["selectedTabUnchangedByCycle"]).toBe(true);
      expect(proof.claims?.["selectedMediaMutationRejected"]).toBe(true);
    });

    it("never takes focus", () => {
      expect(proof.claims?.["focusedWindowUnchanged"]).toBe(true);
      expect(frontmost.before.toLowerCase()).not.toContain("zen");
      expect(frontmost.samples.map((name) => name.toLowerCase())).not.toContain(
        "zen",
      );
      expect(frontmost.after.toLowerCase()).not.toContain("zen");
    });

    it("never moves the macOS cursor", () => {
      expect(cursor.before).not.toBe("unknown");
      expect(cursor.samples).toEqual(
        Array.from({ length: cursor.samples.length }, () => cursor.before),
      );
      expect(cursor.after).toBe(cursor.before);
    });

    it("does not interrupt a tab that is playing media", () => {
      // Measured from the page's own reported playback position rather than the
      // tab's `soundPlaying` flag, which depends on window occlusion. Position
      // advancing across the cycle is the claim the invariant actually makes.
      expect(media.everPlayed, JSON.stringify(media)).toBe(true);
      expect(media.atCycleStart).not.toBeNull();
      expect(media.atCycleEnd).not.toBeNull();
      expect(media.atCycleEnd ?? 0).toBeGreaterThan(media.atCycleStart ?? 0);
      expect(media.neverRewound).toBe(true);
      expect(proof.claims?.["mediaTabSurvivedCycle"]).toBe(true);
    });

    it("refuses to open a privileged scheme with a system principal", () => {
      expect(proof.claims?.["refuses javascript"]).toBe(true);
      expect(proof.claims?.["refuses file"]).toBe(true);
      expect(proof.claims?.["refuses data"]).toBe(true);
    });
  },
);
