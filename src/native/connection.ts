/**
 * Node stream adapter for the native messaging port.
 *
 * Firefox launches the host and speaks to it over stdio, so stdout is the wire.
 * Nothing else may be written there — a stray `console.log` corrupts the frame
 * stream and Firefox drops the port with no useful diagnostic. Everything the
 * operator should see goes to stderr.
 */

import type { Readable, Writable } from "node:stream";
import type { TransportConnection } from "../transport/client.js";

export function streamConnection(
  input: Readable,
  output: Writable,
): TransportConnection {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;

  const notifyClosed = (): void => {
    if (closed) {
      return;
    }

    closed = true;

    for (const listener of closeListeners) {
      listener();
    }
  };

  input.on("data", (chunk: Buffer) => {
    for (const listener of dataListeners) {
      listener(chunk);
    }
  });
  input.on("end", notifyClosed);
  input.on("close", notifyClosed);
  input.on("error", notifyClosed);
  output.on("error", notifyClosed);

  return {
    send(frame: Uint8Array): void {
      if (closed) {
        return;
      }

      output.write(frame);
    },
    onData(listener: (chunk: Uint8Array) => void): void {
      dataListeners.add(listener);
    },
    onClose(listener: () => void): void {
      closeListeners.add(listener);
    },
    close(): void {
      notifyClosed();
      input.pause();
    },
  };
}
