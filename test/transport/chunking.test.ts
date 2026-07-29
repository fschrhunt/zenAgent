import { describe, expect, it } from "vitest";

import {
  ChunkAssembler,
  ChunkingError,
  encodeChunked,
  isChunkEnvelope,
} from "../../src/transport/chunking.js";
import { MessageDecoder } from "../../src/transport/framing.js";

function decodeAll(frames: readonly Uint8Array[]): readonly unknown[] {
  const decoder = new MessageDecoder();
  return frames.flatMap((frame) => decoder.push(frame));
}

function roundTrip(value: unknown, maxFrameBytes: number): unknown {
  const assembler = new ChunkAssembler();
  let result: unknown;

  for (const message of decodeAll(encodeChunked(value, maxFrameBytes))) {
    const assembled = assembler.accept(message);

    if (assembled !== undefined) {
      result = assembled;
    }
  }

  return result;
}

describe("chunking", () => {
  it("sends a small message as a single unchunked frame", () => {
    const frames = encodeChunked({ small: true });
    const [message] = decodeAll(frames);

    expect(frames).toHaveLength(1);
    expect(isChunkEnvelope(message)).toBe(false);
    expect(message).toEqual({ small: true });
  });

  it("splits an oversized message and reassembles it exactly", () => {
    const value = { tabs: Array.from({ length: 500 }, (_, n) => ({ n })) };
    const frames = encodeChunked(value, 512);

    expect(frames.length).toBeGreaterThan(1);
    expect(roundTrip(value, 512)).toEqual(value);
  });

  it("keeps every frame within the limit", () => {
    const value = { padding: "x".repeat(20_000) };

    for (const frame of encodeChunked(value, 1024)) {
      expect(frame.byteLength).toBeLessThanOrEqual(1024);
    }
  });

  it("survives multi-byte characters split across a chunk boundary", () => {
    // Slicing the JSON *string* rather than its bytes would corrupt any
    // character that straddles the boundary. Sizes are chosen to make that
    // straddle happen rather than to hope for it.
    const value = { title: "日本語".repeat(400) };

    for (const limit of [200, 201, 202, 203]) {
      expect(roundTrip(value, limit)).toEqual(value);
    }
  });

  it("refuses a duplicated chunk index", () => {
    const assembler = new ChunkAssembler();
    const chunk = { type: "chunk", id: "a", index: 0, count: 2, body: "AA==" };

    expect(assembler.accept(chunk)).toBeUndefined();
    expect(() => assembler.accept(chunk)).toThrow(ChunkingError);
  });

  it("refuses a chunk index outside the declared count", () => {
    const assembler = new ChunkAssembler();

    expect(() =>
      assembler.accept({
        type: "chunk",
        id: "a",
        index: 5,
        count: 2,
        body: "AA==",
      }),
    ).toThrow(ChunkingError);
  });

  it("refuses a message whose chunk count changes mid-flight", () => {
    const assembler = new ChunkAssembler();

    expect(
      assembler.accept({
        type: "chunk",
        id: "a",
        index: 0,
        count: 3,
        body: "AA==",
      }),
    ).toBeUndefined();
    expect(() =>
      assembler.accept({
        type: "chunk",
        id: "a",
        index: 1,
        count: 2,
        body: "AA==",
      }),
    ).toThrow(ChunkingError);
  });

  it("bounds how much it will hold for partial messages", () => {
    const assembler = new ChunkAssembler({ maxPendingBytes: 8 });

    expect(() =>
      assembler.accept({
        type: "chunk",
        id: "a",
        index: 0,
        count: 2,
        body: Buffer.alloc(64).toString("base64"),
      }),
    ).toThrow(ChunkingError);
  });

  it("bounds how many messages may reassemble at once", () => {
    const assembler = new ChunkAssembler({ maxPendingMessages: 1 });

    expect(
      assembler.accept({
        type: "chunk",
        id: "a",
        index: 0,
        count: 2,
        body: "AA==",
      }),
    ).toBeUndefined();
    expect(() =>
      assembler.accept({
        type: "chunk",
        id: "b",
        index: 0,
        count: 2,
        body: "AA==",
      }),
    ).toThrow(ChunkingError);
  });

  it("drops partial messages when reset", () => {
    const assembler = new ChunkAssembler();

    assembler.accept({
      type: "chunk",
      id: "a",
      index: 0,
      count: 2,
      body: "AA==",
    });
    expect(assembler.pendingBytes).toBeGreaterThan(0);

    assembler.reset();
    expect(assembler.pendingBytes).toBe(0);
  });
});
