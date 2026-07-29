/**
 * Firefox native messaging framing.
 *
 * Every message on the wire is a little-endian `uint32` byte length followed by
 * exactly that many bytes of UTF-8 JSON. The browser writes frames to the
 * host's stdin and reads frames from its stdout, so the host must never write
 * anything else to stdout — diagnostics go to stderr.
 */

/** Bytes in the length prefix that precedes every message body. */
export const MESSAGE_HEADER_BYTES = 4;

/**
 * Firefox refuses to deliver a host-to-browser message larger than 1 MiB, and
 * drops the whole port rather than truncating. Payloads that can approach this
 * are split by `chunking.ts`.
 */
export const MAX_HOST_TO_BROWSER_BYTES = 1024 * 1024;

/**
 * Ceiling on a single browser-to-host message. Firefox itself is far more
 * permissive, but an unbounded declared length is a memory-exhaustion vector:
 * the length arrives before the body, so a hostile or corrupt frame could ask
 * the host to buffer arbitrarily much.
 */
export const MAX_BROWSER_TO_HOST_BYTES = 64 * 1024 * 1024;

export class FramingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/** Encode one value as a length-prefixed native messaging frame. */
export function encodeMessage(
  value: unknown,
  maxBytes: number = MAX_HOST_TO_BROWSER_BYTES,
): Uint8Array {
  const json = JSON.stringify(value);

  if (json === undefined) {
    throw new FramingError("A native messaging frame must encode to JSON.");
  }

  const body = Buffer.from(json, "utf8");

  if (body.byteLength > maxBytes) {
    throw new FramingError(
      `A native messaging frame of ${String(body.byteLength)} bytes exceeds the ${String(maxBytes)} byte limit.`,
    );
  }

  const frame = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, MESSAGE_HEADER_BYTES);
  return frame;
}

/**
 * Incremental decoder for a stream of native messaging frames.
 *
 * Stream chunks have no relationship to message boundaries: one read can carry
 * half a header, and another can carry six whole messages. `push` buffers until
 * a complete frame is available and returns every message that completed.
 */
export class MessageDecoder {
  #buffered: Buffer = Buffer.alloc(0);
  readonly #maxBytes: number;

  public constructor(maxBytes: number = MAX_BROWSER_TO_HOST_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError("A frame size limit must be a positive integer.");
    }

    this.#maxBytes = maxBytes;
  }

  /** Bytes held back because they do not yet form a complete frame. */
  public get bufferedBytes(): number {
    return this.#buffered.byteLength;
  }

  public push(chunk: Uint8Array): readonly unknown[] {
    this.#buffered = Buffer.concat([this.#buffered, Buffer.from(chunk)]);
    const messages: unknown[] = [];

    for (;;) {
      if (this.#buffered.byteLength < MESSAGE_HEADER_BYTES) {
        return messages;
      }

      const bodyBytes = this.#buffered.readUInt32LE(0);

      if (bodyBytes > this.#maxBytes) {
        throw new FramingError(
          `A native messaging frame declared ${String(bodyBytes)} bytes, above the ${String(this.#maxBytes)} byte limit.`,
        );
      }

      const frameBytes = MESSAGE_HEADER_BYTES + bodyBytes;

      if (this.#buffered.byteLength < frameBytes) {
        return messages;
      }

      const body = this.#buffered.subarray(MESSAGE_HEADER_BYTES, frameBytes);
      this.#buffered = this.#buffered.subarray(frameBytes);

      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        // JSON parser messages can include excerpts of the invalid body. The
        // native stream may contain page-derived data, so never copy them into
        // diagnostics or protocol errors.
        throw new FramingError(
          "A native messaging frame did not contain valid JSON.",
        );
      }
    }
  }
}
