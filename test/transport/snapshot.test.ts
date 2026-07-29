import { describe, expect, it } from "vitest";

import { BrowserRegistry } from "../../src/browser/registry.js";
import type { BrowserTab } from "../../src/browser/model.js";
import {
  spaceTransportId,
  toBrowserSnapshot,
  zenSpaceUuid,
} from "../../src/transport/snapshot.js";
import { snapshotPayload, tabPayload, windowPayload } from "./fixtures.js";

const options = { sequence: 1, connectedAt: "2026-07-28T00:00:00.000Z" };

function tabsOf(payload = snapshotPayload()): readonly BrowserTab[] {
  return toBrowserSnapshot(payload, options).tabs;
}

function firstTab(payload = snapshotPayload()): BrowserTab {
  const tab = tabsOf(payload)[0];

  if (tab === undefined) {
    throw new Error("The fixture produced no tabs.");
  }

  return tab;
}

describe("snapshot translation", () => {
  it("produces a snapshot the registry accepts", () => {
    const registry = new BrowserRegistry();

    expect(() => {
      registry.loadInitialSnapshot(
        toBrowserSnapshot(snapshotPayload(), options),
      );
    }).not.toThrow();
    expect(registry.entities("tab")).toHaveLength(1);
    expect(registry.entities("space")).toHaveLength(2);
  });

  it("scopes a Space identity to its window", () => {
    // Zen stores Spaces globally but materialises one per window, and the model
    // scopes a Space to exactly one window. Two windows showing the same Space
    // must not collide on a bare uuid.
    const payload = snapshotPayload({
      windows: [
        windowPayload(),
        windowPayload({
          id: "window-2",
          tabs: [tabPayload({ id: "tab-2" })],
        }),
      ],
    });
    const snapshot = toBrowserSnapshot(payload, options);
    const ids = snapshot.spaces.map((space) => space.id.transportId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(spaceTransportId("window-1", "{personal}"));
    expect(zenSpaceUuid(spaceTransportId("window-1", "{personal}"))).toBe(
      "{personal}",
    );
    expect(() => {
      new BrowserRegistry().loadInitialSnapshot(snapshot);
    }).not.toThrow();
  });

  it("treats an essential tab as belonging to no Space", () => {
    // Zen essentials are shown across every Space and belong to none. That is a
    // known null, not an absence of information.
    const tab = firstTab(
      snapshotPayload({
        windows: [
          windowPayload({
            tabs: [tabPayload({ spaceId: null, essential: true })],
          }),
        ],
      }),
    );

    expect(tab.spaceId).toEqual({ status: "known", value: null });
  });

  it("does not assert a Space the window did not list", () => {
    // Zen moves a tab's attribute and its DOM position separately, so a
    // snapshot taken mid-move can name a Space that is not in the list.
    const tab = firstTab(
      snapshotPayload({
        windows: [windowPayload({ tabs: [tabPayload({ spaceId: "{gone}" })] })],
      }),
    );

    expect(tab.spaceId).toEqual({
      status: "unknown",
      reason: "temporarily-unavailable",
    });
  });

  it("reports a lazy tab's missing URL as not-loaded, not not-reported", () => {
    const tab = firstTab(
      snapshotPayload({
        windows: [
          windowPayload({
            tabs: [tabPayload({ url: null, loadState: "unloaded" })],
          }),
        ],
      }),
    );

    expect(tab.url).toEqual({ status: "unknown", reason: "not-loaded" });
    expect(tab.loadState).toEqual({ status: "known", value: "unloaded" });
  });

  it("only ever asserts that media is playing", () => {
    // Sound state cannot separate "no media" from "paused", so claiming `none`
    // would be a guess. Playing is the only claim the invariant needs.
    const playing = firstTab(
      snapshotPayload({
        windows: [
          windowPayload({ tabs: [tabPayload({ soundPlaying: true })] }),
        ],
      }),
    );
    const silent = firstTab();

    expect(playing.mediaState).toEqual({ status: "known", value: "playing" });
    expect(silent.mediaState).toEqual({
      status: "unknown",
      reason: "not-reported",
    });
  });

  it("marks selected state unsupported when the build cannot report it", () => {
    const payload = snapshotPayload({
      session: {
        ...snapshotPayload().session,
        capabilities: ["zen.spaces.enumerate", "browser.windows.private"],
      },
      windows: [windowPayload({ tabs: [tabPayload({ selected: null })] })],
    });

    expect(firstTab(payload).selected).toEqual({
      status: "unsupported",
      capability: "browser.tabs.selected",
    });
  });

  it("reports browsing contexts as unsupported rather than absent", () => {
    expect(firstTab().browsingContextId).toEqual({
      status: "unsupported",
      capability: "browsing-context.enumerate",
    });
  });

  it("drops private windows under the default hidden policy", () => {
    const snapshot = toBrowserSnapshot(
      snapshotPayload({
        windows: [
          windowPayload(),
          windowPayload({
            id: "window-private",
            private: true,
            tabs: [tabPayload({ id: "tab-private" })],
          }),
        ],
      }),
      options,
    );

    expect(snapshot.windows.map((window) => window.id.transportId)).toEqual([
      "window-1",
    ]);
    expect(snapshot.tabs.map((tab) => tab.id.transportId)).toEqual(["tab-1"]);
  });

  it("drops windows whose private state is unknown", () => {
    // "Might be private" has to be treated as private. The registry enforces
    // this too, so a snapshot that kept them would be rejected outright.
    const snapshot = toBrowserSnapshot(
      snapshotPayload({
        windows: [windowPayload({ id: "window-unsure", private: null })],
      }),
      options,
    );

    expect(snapshot.windows).toHaveLength(0);
    expect(() => {
      new BrowserRegistry().loadInitialSnapshot(snapshot);
    }).not.toThrow();
  });

  it("keeps the reported capabilities on the session", () => {
    const snapshot = toBrowserSnapshot(snapshotPayload(), options);

    expect(snapshot.sessions[0]?.transport).toBe("native-messaging");
    expect(snapshot.sessions[0]?.capabilities).toContain(
      "zen.tabs.enumerate-all-spaces",
    );
  });

  it("discards capabilities it does not recognise", () => {
    const snapshot = toBrowserSnapshot(
      snapshotPayload({
        session: {
          ...snapshotPayload().session,
          capabilities: ["zen.spaces.enumerate", "zen.does.not.exist"],
        },
      }),
      options,
    );

    expect(snapshot.sessions[0]?.capabilities).toEqual([
      "zen.spaces.enumerate",
    ]);
  });
});
