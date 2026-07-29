import { describe, expect, it } from "vitest";

import {
  mapDiscoveredSpaces,
  SpaceMappingError,
} from "../../src/config/discovery.js";

describe("mapping discovered Spaces", () => {
  const discovered = [
    { id: "space-a", name: "Personal" },
    { id: "space-b", name: "Work" },
    { id: "space-c", name: "Client" },
  ] as const;

  it("maps exact discovered stable IDs without selecting Spaces", () => {
    expect(
      mapDiscoveredSpaces(discovered, {
        personal: "space-a",
        work: "space-b",
        aliases: { client: "space-c" },
      }),
    ).toEqual({
      personal: "space-a",
      work: "space-b",
      aliases: { client: "space-c" },
    });
  });

  it("refuses an ID that was not in the discovery snapshot", () => {
    expect(() =>
      mapDiscoveredSpaces(discovered, { work: "guessed-id" }),
    ).toThrow(
      new SpaceMappingError(
        "Cannot map 'work' to undiscovered Space ID 'guessed-id'. Refresh discovery and use an exact returned ID.",
      ),
    );
  });

  it("refuses ambiguous discovery data and empty selections", () => {
    expect(() =>
      mapDiscoveredSpaces([{ id: "duplicate" }, { id: "duplicate" }], {
        personal: "duplicate",
      }),
    ).toThrow(/duplicate stable IDs/);
    expect(() => mapDiscoveredSpaces(discovered, {})).toThrow(
      /At least one Space mapping/,
    );
  });

  it("applies the same strict role and alias validation as the config", () => {
    expect(() =>
      mapDiscoveredSpaces(discovered, {
        personal: "space-a",
        work: "space-a",
      }),
    ).toThrow(/personal and work must map to different stable Space IDs/);
    expect(() =>
      mapDiscoveredSpaces(discovered, {
        aliases: { "Client Name": "space-c" },
      }),
    ).toThrow(/must start with a lowercase letter/);
  });
});
