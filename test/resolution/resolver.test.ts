import {
  BROWSER_MODEL_VERSION,
  DEFAULT_PRIVATE_WINDOW_POLICY,
  entityIdKey,
  known,
  sessionEntityId,
  type BrowserSnapshot,
  type BrowserSpace,
  type BrowserTab,
  type BrowserTabId,
} from "../../src/browser/model.js";
import {
  TabResolutionError,
  TabResolver,
  type TabResolutionTransport,
} from "../../src/resolution/resolver.js";
import { describe, expect, it, vi } from "vitest";
import { browserFixture } from "../browser/fixtures.js";

function snapshotWith(
  spaces: readonly BrowserSpace[],
  tabs: readonly BrowserTab[],
): BrowserSnapshot {
  const fixture = browserFixture();
  return {
    ...fixture.snapshot,
    schemaVersion: BROWSER_MODEL_VERSION,
    privateWindowPolicy: DEFAULT_PRIVATE_WINDOW_POLICY,
    spaces,
    tabs,
    browsingContexts: [],
    frames: [],
    elements: [],
  };
}

function setup(
  snapshot: BrowserSnapshot,
  options: {
    readonly snapshotImplementation?: () => Promise<BrowserSnapshot>;
    readonly navigateImplementation?: (
      tabId: BrowserTabId,
      url: string,
    ) => Promise<void>;
    readonly openImplementation?: TabResolutionTransport["openTab"];
  } = {},
) {
  const fixture = browserFixture();
  const createdId = sessionEntityId("tab", fixture.session.id, "created-tab");
  const snapshotMock = vi.fn(
    options.snapshotImplementation ?? (() => Promise.resolve(snapshot)),
  );
  const openMock = vi.fn(
    options.openImplementation ?? (() => Promise.resolve(createdId)),
  );
  const navigateMock = vi.fn(
    options.navigateImplementation ?? (() => Promise.resolve()),
  );
  const resolver = new TabResolver({
    snapshot: snapshotMock,
    openTab: openMock,
    navigateTab: navigateMock,
  });

  return {
    fixture,
    createdId,
    resolver,
    snapshotMock,
    openMock,
    navigateMock,
  };
}

describe("TabResolver", () => {
  it("reuses the strongest safe match in the chosen Space by stable ID", async () => {
    const fixture = browserFixture();
    const normalizedOnly = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "normalized"),
      url: known("https://example.com/"),
    } satisfies BrowserTab;
    const exact = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "exact"),
      url: known("HTTPS://EXAMPLE.com"),
    } satisfies BrowserTab;
    const { resolver, openMock } = setup(
      snapshotWith([fixture.space], [normalizedOnly, exact]),
    );

    const result = await resolver.resolve({
      spaceId: fixture.space.id,
      url: "HTTPS://EXAMPLE.com",
    });

    expect(result).toMatchObject({
      status: "reused",
      tabId: exact.id,
      explanation: {
        outcome: "reused",
        match: { rule: "exact-url" },
        navigated: false,
      },
    });
    expect(openMock).not.toHaveBeenCalled();
  });

  it("never reuses a matching tab from another Space by default", async () => {
    const fixture = browserFixture();
    const otherSpace = {
      ...fixture.space,
      id: sessionEntityId("space", fixture.session.id, "work"),
      name: known("Work"),
    } satisfies BrowserSpace;
    const foreignTab = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "foreign"),
      spaceId: known(otherSpace.id),
    } satisfies BrowserTab;
    const { resolver, openMock } = setup(
      snapshotWith([fixture.space, otherSpace], [foreignTab]),
    );

    const result = await resolver.resolve({
      spaceId: fixture.space.id,
      url: "https://example.com/",
    });

    expect(result.status).toBe("opened");
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: fixture.window.id,
        spaceId: fixture.space.id,
        background: true,
      }),
    );
  });

  it("allows cross-Space reuse only when explicit and still prefers the chosen Space", async () => {
    const fixture = browserFixture();
    const otherSpace = {
      ...fixture.space,
      id: sessionEntityId("space", fixture.session.id, "work"),
    } satisfies BrowserSpace;
    const foreignTab = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "foreign"),
      spaceId: known(otherSpace.id),
    } satisfies BrowserTab;
    const foreignOnly = setup(
      snapshotWith([fixture.space, otherSpace], [foreignTab]),
    );

    await expect(
      foreignOnly.resolver.resolve({
        spaceId: fixture.space.id,
        url: "https://example.com/",
        allowCrossSpaceReuse: true,
      }),
    ).resolves.toMatchObject({
      status: "reused",
      tabId: foreignTab.id,
      explanation: { crossSpaceReuse: "explicitly-allowed" },
    });

    const localTab = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "local-normalized"),
      url: known("https://EXAMPLE.com"),
    } satisfies BrowserTab;
    const localPreferred = setup(
      snapshotWith([fixture.space, otherSpace], [foreignTab, localTab]),
    );

    await expect(
      localPreferred.resolver.resolve({
        spaceId: fixture.space.id,
        url: "https://example.com/",
        allowCrossSpaceReuse: true,
      }),
    ).resolves.toMatchObject({
      status: "reused",
      tabId: localTab.id,
    });
  });

  it("returns every equally safe candidate as an explicit ambiguity", async () => {
    const fixture = browserFixture();
    const first = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "first"),
    } satisfies BrowserTab;
    const second = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "second"),
    } satisfies BrowserTab;
    const { resolver, openMock } = setup(
      snapshotWith([fixture.space], [first, second]),
    );

    const result = await resolver.resolve({
      spaceId: fixture.space.id,
      url: "https://example.com/",
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      candidates: [{ tabId: first.id }, { tabId: second.id }],
      explanation: {
        outcome: "ambiguous",
        reason: "equally-safe-matches",
        match: { rule: "exact-url" },
      },
    });
    expect(openMock).not.toHaveBeenCalled();
  });

  it("opens only in the chosen Space and reports a machine-readable explanation", async () => {
    const fixture = browserFixture();
    const { resolver, createdId, openMock } = setup(
      snapshotWith([fixture.space], []),
    );

    const result = await resolver.resolve({
      spaceId: fixture.space.id,
      url: "https://new.example/",
    });

    expect(result).toMatchObject({
      status: "opened",
      tabId: createdId,
      explanation: {
        outcome: "opened",
        reason: "no-safe-match",
        background: true,
        staleRetryCount: 0,
      },
    });
    const call = openMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      url: "https://new.example/",
      windowId: fixture.window.id,
      spaceId: fixture.space.id,
      background: true,
    });
    expect(typeof call?.idempotencyKey).toBe("string");
    expect(call?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(call?.idempotencyKey).not.toContain("new.example");
  });

  it("coalesces simultaneous canonical-equivalent resolve/open requests", async () => {
    const fixture = browserFixture();
    let finishOpen: ((id: BrowserTabId) => void) | undefined;
    const opened = new Promise<BrowserTabId>((resolve) => {
      finishOpen = resolve;
    });
    const setupResult = setup(snapshotWith([fixture.space], []), {
      openImplementation: async () => opened,
    });

    const first = setupResult.resolver.resolve({
      spaceId: fixture.space.id,
      url: "https://EXAMPLE.com:443",
    });
    const second = setupResult.resolver.resolve({
      spaceId: fixture.space.id,
      url: "https://example.com/",
    });
    await vi.waitFor(() => {
      expect(setupResult.openMock).toHaveBeenCalledTimes(1);
    });
    finishOpen?.(setupResult.createdId);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    if (
      firstResult.status === "ambiguous" ||
      secondResult.status === "ambiguous"
    ) {
      throw new Error("Concurrent creation unexpectedly became ambiguous.");
    }
    expect(firstResult.tabId).toEqual(setupResult.createdId);
    expect(secondResult.tabId).toEqual(setupResult.createdId);
    expect(setupResult.snapshotMock).toHaveBeenCalledTimes(1);
    expect(setupResult.openMock).toHaveBeenCalledTimes(1);
  });

  it("navigates only the resolved stable ID and retries once if it closed", async () => {
    const fixture = browserFixture();
    const staleTab = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "closed-during-action"),
    } satisfies BrowserTab;
    const replacement = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "replacement"),
    } satisfies BrowserTab;
    let snapshots = 0;
    const navigateMock = vi
      .fn<(tabId: BrowserTabId, url: string) => Promise<void>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("closed"), { code: "stale-id" }),
      )
      .mockResolvedValue(undefined);
    const setupResult = setup(snapshotWith([fixture.space], [staleTab]), {
      snapshotImplementation: () => {
        snapshots += 1;
        return Promise.resolve(
          snapshots === 1
            ? snapshotWith([fixture.space], [staleTab])
            : snapshotWith([fixture.space], [replacement]),
        );
      },
      navigateImplementation: navigateMock,
    });

    const result = await setupResult.resolver.resolve({
      spaceId: fixture.space.id,
      url: "https://example.com/",
      navigateReusedTab: true,
    });

    expect(navigateMock).toHaveBeenNthCalledWith(
      1,
      staleTab.id,
      "https://example.com/",
    );
    expect(navigateMock).toHaveBeenNthCalledWith(
      2,
      replacement.id,
      "https://example.com/",
    );
    expect(result).toMatchObject({
      status: "reused",
      tabId: replacement.id,
      explanation: { navigated: true, staleRetryCount: 1 },
    });
  });

  it("does not reuse crashed or weakly matching sensitive tabs", async () => {
    const fixture = browserFixture();
    const crashed = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "crashed"),
      lifecycleState: "crashed",
    } satisfies BrowserTab;
    const checkout = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "checkout"),
      url: known("https://example.com/checkout?order=1"),
    } satisfies BrowserTab;
    const { resolver, openMock } = setup(
      snapshotWith([fixture.space], [crashed, checkout]),
    );

    await expect(
      resolver.resolve({
        spaceId: fixture.space.id,
        url: "https://example.com/home",
        rules: ["origin"],
      }),
    ).resolves.toMatchObject({ status: "opened" });
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it("never turns cross-Space permission into cross-session reuse", async () => {
    const fixture = browserFixture();
    const another = browserFixture("another");
    const { resolver, openMock } = setup({
      ...snapshotWith([fixture.space], []),
      profiles: [fixture.profile, another.profile],
      sessions: [fixture.session, another.session],
      windows: [fixture.window, another.window],
      spaces: [fixture.space, another.space],
      tabs: [another.tab],
    });

    await expect(
      resolver.resolve({
        spaceId: fixture.space.id,
        url: "https://example.com/",
        allowCrossSpaceReuse: true,
      }),
    ).resolves.toMatchObject({ status: "opened" });
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it("fails loudly for a missing Space or invalid created tab identity", async () => {
    const fixture = browserFixture();
    const noSpace = setup(snapshotWith([], []));

    await expect(
      noSpace.resolver.resolve({
        spaceId: fixture.space.id,
        url: "https://example.com/",
      }),
    ).rejects.toMatchObject({
      name: "TabResolutionError",
      code: "chosen-space-missing",
    } satisfies Partial<TabResolutionError>);

    const another = browserFixture("another");
    const badCreatedId = another.tab.id;
    const badIdentity = setup(snapshotWith([fixture.space], []), {
      openImplementation: () => Promise.resolve(badCreatedId),
    });

    await expect(
      badIdentity.resolver.resolve({
        spaceId: fixture.space.id,
        url: "https://example.com/",
      }),
    ).rejects.toMatchObject({
      name: "TabResolutionError",
      code: "invalid-created-tab-id",
    } satisfies Partial<TabResolutionError>);
    expect(entityIdKey(badCreatedId.sessionId)).not.toBe(
      entityIdKey(fixture.session.id),
    );
  });
});
