import { describe, expect, it } from "vitest";

import {
  elementId,
  entityIdKey,
  known,
  profileId,
  sessionEntityId,
  sessionId,
  unknown,
  unsupported,
} from "../../src/browser/model.js";
import {
  BrowserModelError,
  BrowserRegistry,
} from "../../src/browser/registry.js";
import { browserFixture, combineSnapshots } from "./fixtures.js";

describe("browser model", () => {
  it("keeps unknown and unsupported values distinct from known values", () => {
    expect(known(false)).toEqual({ status: "known", value: false });
    expect(unknown("not-loaded")).toEqual({
      status: "unknown",
      reason: "not-loaded",
    });
    expect(unsupported("media-state")).toEqual({
      status: "unsupported",
      capability: "media-state",
    });
  });

  it("scopes transport identifiers to the browser session", () => {
    const profile = profileId("daily");
    const first = sessionEntityId(
      "tab",
      sessionId(profile, "session-a"),
      "tab-7",
    );
    const second = sessionEntityId(
      "tab",
      sessionId(profile, "session-b"),
      "tab-7",
    );

    expect(entityIdKey(first)).not.toBe(entityIdKey(second));
    expect(entityIdKey(first)).toContain("tab-7");
  });

  it("scopes equal session transport identifiers to their profiles", () => {
    const personal = sessionId(profileId("personal"), "startup");
    const work = sessionId(profileId("work"), "startup");

    expect(entityIdKey(personal)).not.toBe(entityIdKey(work));
  });

  it("rejects empty transport identifiers instead of inventing identity", () => {
    const profile = profileId("daily");

    expect(() => profileId(" ")).toThrow(TypeError);
    expect(() =>
      sessionEntityId("window", sessionId(profile, "session-a"), ""),
    ).toThrow(TypeError);
  });

  it("scopes element references to their originating snapshot", () => {
    const profile = profileId("daily");
    const session = sessionId(profile, "session-a");

    expect(entityIdKey(elementId(session, "button-1", 8))).not.toBe(
      entityIdKey(elementId(session, "button-1", 9)),
    );
    expect(() => elementId(session, "button-1", -1)).toThrow(TypeError);
  });

  it("represents multiple profiles and windows without conflating them", () => {
    const personal = browserFixture("personal", 1);
    const work = browserFixture("work", 1);
    const registry = new BrowserRegistry(combineSnapshots(1, personal, work));

    expect(registry.entities("profile")).toHaveLength(2);
    expect(registry.entities("session")).toHaveLength(2);
    expect(registry.entities("window")).toHaveLength(2);
    expect(entityIdKey(personal.window.id)).not.toBe(
      entityIdKey(work.window.id),
    );
  });

  it("represents multiple windows in one profile and session", () => {
    const fixture = browserFixture();
    const secondWindow = {
      ...fixture.window,
      id: sessionEntityId("window", fixture.session.id, "secondary-window"),
    };
    const registry = new BrowserRegistry({
      ...fixture.snapshot,
      windows: [fixture.window, secondWindow],
    });

    expect(registry.entities("profile")).toHaveLength(1);
    expect(registry.entities("session")).toHaveLength(1);
    expect(registry.entities("window")).toHaveLength(2);
  });

  it("enforces the default policy that private windows are hidden", () => {
    const fixture = browserFixture();
    const privateSnapshot = {
      ...fixture.snapshot,
      windows: [
        {
          ...fixture.window,
          private: known(true),
        },
      ],
    };

    expect(() => new BrowserRegistry(privateSnapshot)).toThrow(
      new BrowserModelError(
        "A snapshot using the hidden private-window policy included a private or unverified window.",
      ),
    );
  });

  it("also hides windows whose private state is unknown", () => {
    const fixture = browserFixture();

    expect(
      () =>
        new BrowserRegistry({
          ...fixture.snapshot,
          windows: [
            {
              ...fixture.window,
              private: unknown<boolean>("not-reported"),
            },
          ],
        }),
    ).toThrow(BrowserModelError);
  });

  it("rejects orphaned relationships in a snapshot", () => {
    const fixture = browserFixture();

    expect(
      () =>
        new BrowserRegistry({
          ...fixture.snapshot,
          windows: [],
        }),
    ).toThrow(/Missing window reference/);
  });
});
