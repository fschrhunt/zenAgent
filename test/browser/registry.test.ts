import { describe, expect, it } from "vitest";

import {
  BROWSER_MODEL_VERSION,
  known,
  sessionEntityId,
  sessionId,
  type BrowserDelta,
  type BrowserSnapshot,
} from "../../src/browser/model.js";
import {
  BrowserModelError,
  BrowserRegistry,
} from "../../src/browser/registry.js";
import { browserFixture } from "./fixtures.js";

const EVENT_TIME = "2026-07-28T20:00:03.000Z";

function delta(
  sequence: number,
  changes: BrowserDelta["changes"],
): BrowserDelta {
  return {
    schemaVersion: BROWSER_MODEL_VERSION,
    sequence,
    observedAt: EVENT_TIME,
    changes,
  };
}

describe("BrowserRegistry", () => {
  it("updates metadata without changing stable identity", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);

    registry.applyDelta(
      delta(2, [
        {
          type: "entity.upserted",
          entity: {
            ...fixture.tab,
            title: known("A new title"),
            url: known("https://example.com/next"),
          },
        },
      ]),
    );

    const result = registry.lookup(fixture.tab.id);
    expect(result.status).toBe("active");
    if (result.status === "active" && result.entity.kind === "tab") {
      expect(result.entity.title).toEqual(known("A new title"));
    }
  });

  it("makes a closed tab and its page-scoped descendants stale", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);

    registry.applyDelta(
      delta(2, [
        {
          type: "entity.removed",
          id: fixture.tab.id,
          reason: "closed",
        },
      ]),
    );

    expect(registry.lookup(fixture.tab.id)).toMatchObject({
      status: "stale",
      stale: { reason: "closed" },
    });
    expect(registry.lookup(fixture.context.id)).toMatchObject({
      status: "stale",
      stale: { reason: "closed" },
    });
    expect(registry.lookup(fixture.frame.id)).toMatchObject({
      status: "stale",
      stale: { reason: "closed" },
    });
    expect(registry.lookup(fixture.element.id)).toMatchObject({
      status: "stale",
      stale: { reason: "closed" },
    });
    expect(registry.lookup(fixture.space.id).status).toBe("active");
  });

  it("keeps a crashed tab addressable but invalidates page identities", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);

    registry.applyDelta(
      delta(2, [{ type: "tab.crashed", id: fixture.tab.id }]),
    );

    const tabResult = registry.lookup(fixture.tab.id);
    expect(tabResult.status).toBe("active");
    if (tabResult.status === "active" && tabResult.entity.kind === "tab") {
      expect(tabResult.entity.lifecycleState).toBe("crashed");
    }
    expect(registry.lookup(fixture.context.id)).toMatchObject({
      status: "stale",
      stale: { reason: "crashed" },
    });
    expect(registry.lookup(fixture.frame.id)).toMatchObject({
      status: "stale",
      stale: { reason: "crashed" },
    });
    expect(registry.lookup(fixture.element.id)).toMatchObject({
      status: "stale",
      stale: { reason: "crashed" },
    });
  });

  it("invalidates same-session entities that disappear across reconnect", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);
    const afterReconnect = {
      ...fixture.snapshot,
      sequence: 2,
      capturedAt: EVENT_TIME,
      browsingContexts: [],
      frames: [],
      elements: [],
      tabs: [
        {
          ...fixture.tab,
          browsingContextId: known(null),
          lifecycleState: "discarded",
        },
      ],
    } satisfies BrowserSnapshot;

    registry.reconcileAfterReconnect(afterReconnect);

    expect(registry.lookup(fixture.tab.id).status).toBe("active");
    expect(registry.lookup(fixture.context.id)).toMatchObject({
      status: "stale",
      stale: { reason: "missing-after-reconnect" },
    });
  });

  it("invalidates old session identities after a browser restart", () => {
    const before = browserFixture("before", 1, "daily-profile");
    const after = browserFixture("after", 2, "daily-profile");
    const registry = new BrowserRegistry(before.snapshot);

    registry.reconcileAfterReconnect(after.snapshot);

    expect(registry.lookup(before.session.id)).toMatchObject({
      status: "stale",
      stale: {
        reason: "session-replaced",
        replacementSessionId: after.session.id,
      },
    });
    expect(registry.lookup(before.tab.id)).toMatchObject({
      status: "stale",
      stale: {
        reason: "session-replaced",
        replacementSessionId: after.session.id,
      },
    });
    expect(registry.lookup(after.tab.id).status).toBe("active");
    expect(registry.entities("profile")).toHaveLength(1);
  });

  it("applies an incremental session replacement atomically", () => {
    const before = browserFixture("before", 1, "daily-profile");
    const after = browserFixture("after", 2, "daily-profile");
    const registry = new BrowserRegistry(before.snapshot);

    registry.applyDelta(
      delta(2, [
        {
          type: "session.replaced",
          previousSessionId: before.session.id,
          session: after.session,
        },
      ]),
    );

    expect(registry.lookup(before.session.id)).toMatchObject({
      status: "stale",
      stale: {
        reason: "session-replaced",
        replacementSessionId: after.session.id,
      },
    });
    expect(registry.lookup(after.session.id).status).toBe("active");
    expect(registry.entities("tab")).toHaveLength(0);
  });

  it("rejects stale identity reuse and applies a delta atomically", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);

    registry.applyDelta(
      delta(2, [
        {
          type: "entity.removed",
          id: fixture.tab.id,
          reason: "closed",
        },
      ]),
    );

    expect(() =>
      registry.applyDelta(
        delta(3, [
          {
            type: "entity.upserted",
            entity: {
              ...fixture.space,
              name: known("Renamed"),
            },
          },
          { type: "entity.upserted", entity: fixture.tab },
        ]),
      ),
    ).toThrow(BrowserModelError);

    const space = registry.lookup(fixture.space.id);
    expect(space.status).toBe("active");
    if (space.status === "active" && space.entity.kind === "space") {
      expect(space.entity.name).toEqual(known("Personal"));
    }
    expect(registry.sequence).toBe(2);
  });

  it("rejects a private window added while the hidden policy is active", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);
    const privateWindow = {
      ...fixture.window,
      id: sessionEntityId("window", fixture.session.id, "private-window"),
      private: known(true),
    };

    expect(() =>
      registry.applyDelta(
        delta(2, [{ type: "entity.upserted", entity: privateWindow }]),
      ),
    ).toThrow(BrowserModelError);
    expect(registry.lookup(privateWindow.id).status).toBe("missing");
    expect(registry.sequence).toBe(1);
  });

  it("rejects out-of-order updates and reused session IDs", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);

    expect(() => registry.applyDelta(delta(1, []))).toThrow(BrowserModelError);
    expect(() =>
      registry.applyDelta(
        delta(2, [
          {
            type: "session.replaced",
            previousSessionId: fixture.session.id,
            session: {
              ...fixture.session,
              id: sessionId(fixture.profile.id, fixture.session.id.transportId),
            },
          },
        ]),
      ),
    ).toThrow(BrowserModelError);
  });

  it("does not find an identifier that the transport never reported", () => {
    const fixture = browserFixture();
    const registry = new BrowserRegistry(fixture.snapshot);
    const missingId = sessionEntityId(
      "tab",
      fixture.session.id,
      "never-reported",
    );

    expect(registry.lookup(missingId)).toEqual({
      status: "missing",
      id: missingId,
    });
  });
});
