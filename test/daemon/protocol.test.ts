import { describe, expect, it } from "vitest";

import {
  DAEMON_PROTOCOL_RECOVERY,
  DAEMON_PROTOCOL_VERSION,
  daemonResponse,
  DaemonMessageDecoder,
  DaemonProtocolError,
  encodeDaemonMessage,
  parseDaemonRequest,
} from "../../src/daemon/protocol.js";

describe("daemon protocol", () => {
  it("decodes split and coalesced length-prefixed messages", () => {
    const first = encodeDaemonMessage(daemonResponse("one", { ok: true }));
    const second = encodeDaemonMessage(daemonResponse("two", 2));
    const bytes = Buffer.concat([first, second]);
    const decoder = new DaemonMessageDecoder();

    expect(decoder.push(bytes.subarray(0, 7))).toEqual([]);
    expect(decoder.push(bytes.subarray(7))).toEqual([
      daemonResponse("one", { ok: true }),
      daemonResponse("two", 2),
    ]);
  });

  it("refuses protocol mismatch and unknown methods clearly", () => {
    let mismatch: unknown;
    try {
      parseDaemonRequest({
        protocolVersion: 99,
        type: "request",
        id: "request-1",
        clientId: "client-1",
        method: "health",
      });
    } catch (error) {
      mismatch = error;
    }

    expect(mismatch).toBeInstanceOf(DaemonProtocolError);
    expect(mismatch).toMatchObject({
      code: "protocol-version-mismatch",
      data: {
        reason: "protocol-version-mismatch",
        retryable: false,
        performed: false,
        resource: "daemon-protocol",
        recovery: DAEMON_PROTOCOL_RECOVERY,
        expectedProtocolVersion: DAEMON_PROTOCOL_VERSION,
        receivedProtocolVersion: 99,
      },
    });

    expect(() =>
      parseDaemonRequest({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        type: "request",
        id: "request-1",
        clientId: "client-1",
        method: "tabs.activate",
      }),
    ).toThrow(/Unknown daemon method/);
  });

  it.each([
    "tabs.lease.acquire",
    "tabs.lease.renew",
    "tabs.lease.release",
    "tabs.cleanup",
  ] as const)("accepts the %s lease method", (method) => {
    expect(
      parseDaemonRequest({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        type: "request",
        id: "request-1",
        clientId: "client-1",
        method,
      }),
    ).toMatchObject({ method });
  });

  it("enforces the declared and encoded message size", () => {
    expect(() =>
      encodeDaemonMessage(daemonResponse("large", "x".repeat(100)), 20),
    ).toThrow(DaemonProtocolError);

    const decoder = new DaemonMessageDecoder(8);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9);
    expect(() => decoder.push(header)).toThrow(/declares 9 bytes/);
  });

  it("requires non-empty correlation and client identifiers", () => {
    expect(() =>
      parseDaemonRequest({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        type: "request",
        id: "",
        clientId: "client-1",
        method: "health",
      }),
    ).toThrow(/non-empty id/);
  });

  it("bounds identifiers and deeply nested request parameters", () => {
    expect(() =>
      parseDaemonRequest({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        type: "request",
        id: "x".repeat(257),
        clientId: "client-1",
        method: "health",
      }),
    ).toThrow(/256 byte limit/);

    let params: unknown = null;

    for (let depth = 0; depth < 66; depth += 1) {
      params = [params];
    }

    expect(() =>
      parseDaemonRequest({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        type: "request",
        id: "request-1",
        clientId: "client-1",
        method: "health",
        params,
      }),
    ).toThrow(/nesting limit/);
  });
});
