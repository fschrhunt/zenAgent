/**
 * DEV-261: validates the transport ADR 0001 selects.
 *
 * These are the claims BiDi failed, checked against a real Zen:
 *
 *   - chrome JS enumerates tabs in Spaces that are not visible, which
 *     `gBrowser.tabs` (and therefore WebDriver BiDi) does not;
 *   - it also enumerates lazy, session-restored tabs, which is the state that
 *     reduced BiDi to one visible tab out of 22 on a real profile;
 *   - creating a Space and routing a background tab into it changes neither the
 *     visible Space nor the selected tab;
 *   - no remote-control badge ever appears.
 *
 * Opt-in, because it needs Zen installed:
 *
 *   npm run spike:transport
 */

import { describe, expect, it } from "vitest";

import {
  runExtensionProbe,
  runExtensionProbeAcrossRestart,
  type ProbeSnapshot,
} from "./probe-extension.js";
import { runNativeKeepaliveProbe } from "./native-keepalive.js";
import { locateZen } from "./zen.js";

const enabled = process.env["ZEN_SPIKE"] === "1";
const zen = enabled ? locateZen() : undefined;

/** Spaces represented among a set of tabs, excluding unassigned ones. */
const spacesIn = (tabs: readonly { space: string | null }[]): Set<string> =>
  new Set(tabs.map((t) => t.space).filter((s): s is string => s !== null));

describe.skipIf(!enabled || zen === undefined)(
  "privileged extension transport",
  () => {
    it("sees Spaces that gBrowser.tabs hides, without disturbing anything", async () => {
      if (zen === undefined) throw new Error("Zen not found");
      const { result } = await runExtensionProbe(zen, { timeoutMs: 120_000 });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);

      const after = result.after as ProbeSnapshot;

      // The core claim: chrome JS spans every Space, gBrowser.tabs does not.
      const allSpaces = spacesIn(after.allStoredBySpace);
      const stripSpaces = spacesIn(after.gBrowserBySpace);
      expect(allSpaces.size).toBeGreaterThan(1);
      expect(stripSpaces.size).toBe(1);
      expect([...stripSpaces]).toEqual([after.activeSpace]);
      expect(after.allStoredTabs).toBeGreaterThan(after.gBrowserTabs);

      // And it did so without moving anything the user can see.
      expect(result.unchanged?.activeSpace).toBe(true);
      expect(result.unchanged?.noBadge).toBe(true);
      expect(after.remoteControlBadge).toBe(false);
    }, 180_000);

    it("enumerates lazy tabs after a restart, where BiDi sees almost none", async () => {
      if (zen === undefined) throw new Error("Zen not found");
      const { second } = await runExtensionProbeAcrossRestart(zen, {
        timeoutMs: 120_000,
      });

      expect(second.error).toBeUndefined();
      expect(second.ok).toBe(true);

      const after = second.after as ProbeSnapshot;
      const lazy = after.allStoredBySpace.filter((t) => t.lazy);

      // Session restore left tabs unloaded, and they are still enumerable.
      expect(lazy.length).toBeGreaterThan(0);
      expect(spacesIn(after.allStoredBySpace).size).toBeGreaterThan(1);
      expect(after.remoteControlBadge).toBe(false);
    }, 300_000);

    it("keeps an MV3 event page alive through an open native port", async () => {
      if (zen === undefined) throw new Error("Zen not found");
      const { result } = await runNativeKeepaliveProbe(zen, {
        timeoutMs: 90_000,
      });

      expect(result.ok).toBe(true);
      expect(result.idleWaitMs).toBeGreaterThan(30_000);
      expect(result.elapsedMs).toBeGreaterThan(30_000);
      expect(result.sameEventPage).toBe(true);
      expect(result.first.token).toBe(result.second.token);
      expect(result.first.startedAt).toBe(result.second.startedAt);
    }, 120_000);
  },
);
