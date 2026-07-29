/**
 * Chunking for the 1 MiB host-to-browser message cap.
 *
 * A tab snapshot on a heavily used profile can exceed what Firefox will deliver
 * in one native messaging frame. Rather than truncate — which would silently
 * hide tabs, breaking "look before you open" — an oversized message is split
 * into chunk frames and reassembled on the far side.
 *
 * Chunk bodies carry base64 of a *byte* slice of the encoded message, not a
 * substring of the JSON text. Slicing UTF-8 by bytes can cut a multi-byte
 * character in half; concatenating the bytes before decoding makes that safe,
 * whereas slicing the string by code units would not survive reassembly.
 */

import { randomUUID } from "node:crypto";
import {
  encodeMessage,
  FramingError,
  MAX_HOST_TO_BROWSER_BYTES,
} from "./framing.js";

/** One slice of a message too large to send in a single frame. */
export interface ChunkEnvelope {
  readonly type: "chunk";
  readonly id: string;
  readonly index: number;
  readonly count: number;
  /** Base64 of this slice's bytes. */
  readonly body: string;
}

/** Default ceiling on bytes held for partially received messages. */
export const DEFAULT_MAX_PENDING_BYTES = 32 * 1024 * 1024;

/** Default ceiling on simultaneously reassembling messages. */
export const DEFAULT_MAX_PENDING_MESSAGES = 8;

export class ChunkingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChunkingError";
  }
}

export function isChunkEnvelope(value: unknown): value is ChunkEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ChunkEnvelope>;
  return (
    candidate.type === "chunk" &&
    typeof candidate.id === "string" &&
    typeof candidate.body === "string" &&
    Number.isSafeInteger(candidate.index) &&
    Number.isSafeInteger(candidate.count)
  );
}

/**
 * Encode a value as one or more frames that each fit within `maxFrameBytes`.
 *
 * Values that already fit are returned as a single unchunked frame, so the
 * common case pays nothing for this.
 */
export function encodeChunked(
  value: unknown,
  maxFrameBytes: number = MAX_HOST_TO_BROWSER_BYTES,
  id: string = randomUUID(),
): readonly Uint8Array[] {
  const json = JSON.stringify(value);

  if (json === undefined) {
    throw new ChunkingError("A chunked message must encode to JSON.");
  }

  const body = Buffer.from(json, "utf8");

  if (body.byteLength <= maxFrameBytes) {
    return [encodeMessage(value, maxFrameBytes)];
  }

  const sliceBytes = maxRawBytesPerChunk(maxFrameBytes, id);
  const count = Math.ceil(body.byteLength / sliceBytes);
  const frames: Uint8Array[] = [];

  for (let index = 0; index < count; index += 1) {
    const slice = body.subarray(index * sliceBytes, (index + 1) * sliceBytes);
    const envelope: ChunkEnvelope = {
      type: "chunk",
      id,
      index,
      count,
      body: slice.toString("base64"),
    };
    frames.push(encodeMessage(envelope, maxFrameBytes));
  }

  return frames;
}

/**
 * Largest raw slice whose base64 encoding still leaves room for the envelope.
 *
 * Measured rather than estimated: the envelope is encoded with a worst-case
 * `count` so the overhead cannot grow after the slice size is chosen.
 */
function maxRawBytesPerChunk(maxFrameBytes: number, id: string): number {
  const probe: ChunkEnvelope = {
    type: "chunk",
    id,
    index: Number.MAX_SAFE_INTEGER,
    count: Number.MAX_SAFE_INTEGER,
    body: "",
  };
  const overhead = encodeMessage(probe, maxFrameBytes).byteLength;
  const availableBase64 = maxFrameBytes - overhead;

  if (availableBase64 <= 4) {
    throw new ChunkingError(
      `A frame limit of ${String(maxFrameBytes)} bytes is too small to carry a chunk.`,
    );
  }

  // Every 3 raw bytes become 4 base64 characters, padded up to a multiple of 4.
  return Math.floor(availableBase64 / 4) * 3;
}

interface PendingMessage {
  readonly count: number;
  readonly slices: (Buffer | undefined)[];
  received: number;
  bytes: number;
}

/**
 * Reassembles chunked messages, passing unchunked ones straight through.
 *
 * Feed it every decoded frame. It returns the value when one is complete, and
 * `undefined` while a message is still arriving.
 */
export class ChunkAssembler {
  readonly #pending = new Map<string, PendingMessage>();
  readonly #maxPendingBytes: number;
  readonly #maxPendingMessages: number;

  public constructor(
    options: {
      readonly maxPendingBytes?: number;
      readonly maxPendingMessages?: number;
    } = {},
  ) {
    this.#maxPendingBytes =
      options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.#maxPendingMessages =
      options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES;
  }

  /** Bytes currently held for messages that are still arriving. */
  public get pendingBytes(): number {
    let total = 0;

    for (const pending of this.#pending.values()) {
      total += pending.bytes;
    }

    return total;
  }

  /** Returns the completed value, or `undefined` while chunks are still arriving. */
  public accept(message: unknown): unknown {
    if (!isChunkEnvelope(message)) {
      return message;
    }

    const pending = this.#pendingFor(message);

    if (message.index < 0 || message.index >= pending.count) {
      this.#pending.delete(message.id);
      throw new ChunkingError(
        `Chunk index ${String(message.index)} is outside the declared count ${String(pending.count)}.`,
      );
    }

    if (pending.slices[message.index] !== undefined) {
      this.#pending.delete(message.id);
      throw new ChunkingError(
        `Chunk index ${String(message.index)} arrived twice for message ${JSON.stringify(message.id)}.`,
      );
    }

    const slice = Buffer.from(message.body, "base64");
    pending.slices[message.index] = slice;
    pending.received += 1;
    pending.bytes += slice.byteLength;

    if (this.pendingBytes > this.#maxPendingBytes) {
      this.#pending.delete(message.id);
      throw new ChunkingError(
        `Reassembly buffers exceeded ${String(this.#maxPendingBytes)} bytes.`,
      );
    }

    if (pending.received < pending.count) {
      return undefined;
    }

    this.#pending.delete(message.id);
    const body = Buffer.concat(
      pending.slices.map((part) => part ?? Buffer.alloc(0)),
    );

    try {
      return JSON.parse(body.toString("utf8"));
    } catch (error) {
      throw new FramingError(
        `A reassembled message did not contain valid JSON: ${String(error)}`,
      );
    }
  }

  /** Discard partial messages, as after a disconnect. */
  public reset(): void {
    this.#pending.clear();
  }

  #pendingFor(envelope: ChunkEnvelope): PendingMessage {
    const existing = this.#pending.get(envelope.id);

    if (existing !== undefined) {
      if (existing.count !== envelope.count) {
        this.#pending.delete(envelope.id);
        throw new ChunkingError(
          `Message ${JSON.stringify(envelope.id)} changed its chunk count from ${String(existing.count)} to ${String(envelope.count)}.`,
        );
      }

      return existing;
    }

    if (envelope.count <= 0) {
      throw new ChunkingError(
        `A chunked message must declare at least one chunk, not ${String(envelope.count)}.`,
      );
    }

    if (this.#pending.size >= this.#maxPendingMessages) {
      throw new ChunkingError(
        `More than ${String(this.#maxPendingMessages)} messages are reassembling at once.`,
      );
    }

    const created: PendingMessage = {
      count: envelope.count,
      slices: new Array<Buffer | undefined>(envelope.count).fill(undefined),
      received: 0,
      bytes: 0,
    };
    this.#pending.set(envelope.id, created);
    return created;
  }
}
