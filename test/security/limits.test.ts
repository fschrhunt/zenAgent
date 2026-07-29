import { describe, expect, it } from "vitest";

import {
  assertBrowserSnapshotLimits,
  assertJsonResourceLimits,
  ResourceLimitError,
} from "../../src/security/limits.js";
import { browserFixture } from "../browser/fixtures.js";

describe("portable resource limits", () => {
  it("rejects deeply nested JSON without recursive traversal", () => {
    let value: unknown = "leaf";

    for (let depth = 0; depth < 10; depth += 1) {
      value = { nested: value };
    }

    expect(() => assertJsonResourceLimits(value, { maxDepth: 4 })).toThrow(
      ResourceLimitError,
    );
  });

  it("rejects cycles and oversized scalar strings", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => assertJsonResourceLimits(cyclic)).toThrow(/reference cycle/);
    expect(() =>
      assertJsonResourceLimits("secret".repeat(100), {
        maxStringBytes: 16,
      }),
    ).toThrow(/string exceeds/);
  });

  it("bounds retained browser snapshots by serialized bytes", () => {
    const fixture = browserFixture();
    const snapshot = {
      ...fixture.snapshot,
      tabs: [
        {
          ...fixture.tab,
          title: { status: "known" as const, value: "x".repeat(2_000) },
        },
      ],
    };

    expect(() => assertBrowserSnapshotLimits(snapshot, 512)).toThrow(
      /retained-state limit/,
    );
  });
});
