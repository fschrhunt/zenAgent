import { describe, expect, it } from "vitest";

import {
  assertRequiredCapabilities,
  knownCapabilities,
  requireCapability,
} from "../../src/transport/capabilities.js";
import { parseSnapshotPayload } from "../../src/transport/payload.js";
import {
  parseMessage,
  TransportProtocolError,
  TRANSPORT_PROTOCOL_VERSION,
} from "../../src/transport/protocol.js";
import { snapshotPayload, tabPayload, windowPayload } from "./fixtures.js";

describe("snapshot payload validation", () => {
  it("accepts a well-formed payload", () => {
    expect(parseSnapshotPayload(snapshotPayload()).windows).toHaveLength(1);
  });

  it("rejects a duplicated tab identity", () => {
    // Two tabs sharing an id means identity is broken at the source, and a
    // registry built on it would address the wrong tab.
    const payload = {
      ...snapshotPayload(),
      windows: [windowPayload({ tabs: [tabPayload(), tabPayload()] })],
    };

    expect(() => parseSnapshotPayload(payload)).toThrow(/appeared twice/);
  });

  it("rejects a tab with an empty identity", () => {
    const payload = {
      ...snapshotPayload(),
      windows: [windowPayload({ tabs: [tabPayload({ id: "" })] })],
    };

    expect(() => parseSnapshotPayload(payload)).toThrow(TransportProtocolError);
  });

  it("rejects an unrecognised lifecycle state", () => {
    // Built as a plain literal rather than through the typed helper, because
    // the point is to hand the validator something the types forbid.
    const payload = {
      ...snapshotPayload(),
      windows: [
        {
          ...windowPayload(),
          tabs: [{ ...tabPayload(), lifecycleState: "hibernating" }],
        },
      ],
    };

    expect(() => parseSnapshotPayload(payload)).toThrow(/lifecycleState/);
  });

  it("accepts absent optional fields as null rather than inventing them", () => {
    const payload = parseSnapshotPayload({
      ...snapshotPayload(),
      windows: [
        windowPayload({
          tabs: [{ ...tabPayload(), url: null, title: null, selected: null }],
        }),
      ],
    });

    expect(payload.windows[0]?.tabs[0]?.url).toBeNull();
    expect(payload.windows[0]?.tabs[0]?.selected).toBeNull();
  });
});

describe("protocol messages", () => {
  it("refuses a peer speaking another protocol version", () => {
    expect(() =>
      parseMessage({
        protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1,
        type: "request",
        id: "1",
        method: "browser.snapshot",
      }),
    ).toThrow(/Reinstall the Zen Agent extension and host together/);
  });

  it("refuses an unknown message type", () => {
    expect(() =>
      parseMessage({
        protocolVersion: TRANSPORT_PROTOCOL_VERSION,
        type: "greeting",
      }),
    ).toThrow(/Unknown protocol message type/);
  });
});

describe("capabilities", () => {
  it("drops capabilities this build does not recognise", () => {
    expect(
      knownCapabilities(["zen.spaces.route", "zen.invented.capability"]),
    ).toEqual(["zen.spaces.route"]);
  });

  it("names the Zen version when a required capability is missing", () => {
    expect(() =>
      assertRequiredCapabilities(["zen.spaces.enumerate"], "1.99.0"),
    ).toThrow(/Zen 1\.99\.0/);
  });

  it("refuses an operation whose capability is absent", () => {
    expect(() =>
      requireCapability([], "zen.spaces.route", "Routing a tab into a Space"),
    ).toThrow(/Routing a tab into a Space needs zen\.spaces\.route/);
  });
});
