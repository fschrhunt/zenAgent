import { describe, expect, it } from "vitest";

import { PageReferenceRegistry } from "../../src/daemon/page-references.js";
import {
  PAGE_SCHEMA_VERSION,
  type PageSnapshot,
} from "../../src/page/model.js";
import { browserFixture } from "../browser/fixtures.js";

function pageSnapshot(
  snapshotId: string,
  documentId = "document-1",
): PageSnapshot {
  return {
    schemaVersion: PAGE_SCHEMA_VERSION,
    snapshotId,
    documentId,
    tabId: "transport-tab",
    capturedAt: "2026-07-29T00:00:00.000Z",
    url: "https://example.com/",
    title: "Example",
    loadState: "complete",
    rootFrameRef: "frame-1",
    frames: [
      {
        frameRef: "frame-1",
        parentFrameRef: null,
        documentId,
        url: "https://example.com/",
        loadState: "complete",
        availability: "available",
      },
    ],
    nodes: [],
    truncation: {
      frames: false,
      nodes: false,
      strings: false,
      totalBytes: false,
    },
  };
}

describe("PageReferenceRegistry optimistic generations", () => {
  it("keeps old snapshots readable but refuses them as mutation targets", () => {
    const fixture = browserFixture();
    const references = new PageReferenceRegistry();
    const older = pageSnapshot("snapshot-older");
    const latest = pageSnapshot("snapshot-latest");
    references.remember("client", fixture.tab.id, older, 1_000);
    references.remember("client", fixture.tab.id, latest, 1_001);
    const oldTarget = {
      tabId: fixture.tab.id,
      documentId: older.documentId,
      snapshotId: older.snapshotId,
      frameRef: older.rootFrameRef,
    };

    expect(() =>
      references.assertOwned("client", oldTarget, 1_002),
    ).not.toThrow();
    expect(() =>
      references.assertLatestOwned("client", oldTarget, 1_002),
    ).toThrowError(/newer page snapshot superseded/);
    expect(() =>
      references.assertLatestOwned(
        "client",
        {
          ...oldTarget,
          snapshotId: latest.snapshotId,
        },
        1_002,
      ),
    ).not.toThrow();
  });

  it("does not let one client supersede another client's snapshot generation", () => {
    const fixture = browserFixture();
    const references = new PageReferenceRegistry();
    const first = pageSnapshot("snapshot-first");
    const second = pageSnapshot("snapshot-second");
    references.remember("first", fixture.tab.id, first, 1_000);
    references.remember("second", fixture.tab.id, second, 1_001);

    expect(() =>
      references.assertLatestOwned(
        "first",
        {
          tabId: fixture.tab.id,
          documentId: first.documentId,
          snapshotId: first.snapshotId,
          frameRef: first.rootFrameRef,
        },
        1_002,
      ),
    ).not.toThrow();
  });
});
