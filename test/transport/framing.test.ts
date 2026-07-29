import { describe, expect, it } from "vitest";

import {
  encodeMessage,
  FramingError,
  MessageDecoder,
  MESSAGE_HEADER_BYTES,
} from "../../src/transport/framing.js";

describe("native messaging framing", () => {
  it("prefixes a message with its little-endian byte length", () => {
    const frame = Buffer.from(encodeMessage({ hello: "world" }));

    expect(frame.readUInt32LE(0)).toBe(frame.byteLength - MESSAGE_HEADER_BYTES);
    expect(
      JSON.parse(frame.subarray(MESSAGE_HEADER_BYTES).toString("utf8")),
    ).toEqual({ hello: "world" });
  });

  it("measures the length in bytes, not characters", () => {
    // A frame length counted in UTF-16 code units would truncate the body and
    // desynchronise every message after it.
    const frame = Buffer.from(encodeMessage({ title: "日本語" }));
    const declared = frame.readUInt32LE(0);

    expect(declared).toBe(frame.byteLength - MESSAGE_HEADER_BYTES);
    expect(declared).toBeGreaterThan(
      JSON.stringify({ title: "日本語" }).length,
    );
  });

  it("refuses a message above the size limit", () => {
    expect(() => encodeMessage({ padding: "x".repeat(64) }, 32)).toThrow(
      FramingError,
    );
  });

  it("refuses a value that does not encode to JSON", () => {
    expect(() => encodeMessage(undefined)).toThrow(FramingError);
  });

  it("decodes several messages from one chunk", () => {
    const decoder = new MessageDecoder();
    const chunk = Buffer.concat([
      Buffer.from(encodeMessage({ n: 1 })),
      Buffer.from(encodeMessage({ n: 2 })),
    ]);

    expect(decoder.push(chunk)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reassembles a message split across chunk boundaries", () => {
    const decoder = new MessageDecoder();
    const frame = Buffer.from(encodeMessage({ value: "split" }));

    // Stream reads have no relationship to message boundaries: feed the frame
    // one byte at a time and nothing may emerge until the last one.
    for (const byte of frame.subarray(0, frame.byteLength - 1)) {
      expect(decoder.push(Buffer.from([byte]))).toEqual([]);
    }

    const last = frame.subarray(frame.byteLength - 1);
    expect(decoder.push(last)).toEqual([{ value: "split" }]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("refuses a frame that declares more than the limit", () => {
    const decoder = new MessageDecoder(16);
    const header = Buffer.alloc(MESSAGE_HEADER_BYTES);
    header.writeUInt32LE(1024 * 1024, 0);

    // The declared length arrives before the body, so an unbounded value would
    // let a corrupt frame make the host buffer arbitrarily much.
    expect(() => decoder.push(header)).toThrow(FramingError);
  });

  it("refuses a frame whose body is not JSON", () => {
    const decoder = new MessageDecoder();
    const body = Buffer.from("not json", "utf8");
    const frame = Buffer.alloc(MESSAGE_HEADER_BYTES + body.byteLength);
    frame.writeUInt32LE(body.byteLength, 0);
    body.copy(frame, MESSAGE_HEADER_BYTES);

    expect(() => decoder.push(frame)).toThrow(FramingError);
  });

  it("does not copy malformed frame contents into its error", () => {
    const secret = '{"token":"top-secret",broken}';
    const body = Buffer.from(secret);
    const frame = Buffer.alloc(MESSAGE_HEADER_BYTES + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, MESSAGE_HEADER_BYTES);

    try {
      new MessageDecoder().push(frame);
      throw new Error("expected framing rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(FramingError);
      expect(String(error)).not.toContain("top-secret");
      expect(String(error)).not.toContain(secret);
    }
  });
});
