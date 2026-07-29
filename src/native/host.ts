/**
 * The native messaging host process.
 *
 * Firefox launches this when the extension opens its port, so its lifetime is
 * the browser's. It performs the handshake, holds the port open — which is what
 * keeps the extension's event page alive — and maintains a registry of what the
 * browser currently contains.
 *
 * It does not yet serve terminal clients. DEV-263 adds the Unix socket that the
 * CLI and MCP server share; until then this is the end-to-end proof that the
 * extension, the protocol, and the model fit together against a real Zen.
 */

import type { Readable, Writable } from "node:stream";

import type { BrowserSnapshot } from "../browser/model.js";
import { BrowserRegistry } from "../browser/registry.js";
import { ZenTransport, type ZenTransportOptions } from "../transport/client.js";
import { streamConnection } from "./connection.js";

export interface NativeHostOptions extends ZenTransportOptions {
  /** Where sanitized diagnostics go. Never stdout, which carries the wire. */
  readonly log?: (line: string) => void;
  /** Overridable so tests can drive the host without spawning a process. */
  readonly input?: Readable;
  readonly output?: Writable;
}

export interface NativeHost {
  readonly registry: BrowserRegistry;
  readonly transport: ZenTransport;
  /** Resolves when the browser disconnects. */
  readonly closed: Promise<void>;
}

/**
 * Connect, take a first snapshot, and keep the registry current.
 *
 * Deltas are applied when they arrive and a full snapshot is taken whenever the
 * extension says its incremental view cannot be trusted. The registry rejects
 * anything inconsistent, so a rejected delta is treated as a reason to
 * re-snapshot rather than a reason to stop.
 */
export async function startNativeHost(
  options: NativeHostOptions = {},
): Promise<NativeHost> {
  const log =
    options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const connection = streamConnection(
    options.input ?? process.stdin,
    options.output ?? process.stdout,
  );
  const transport = new ZenTransport(connection, options);
  const registry = new BrowserRegistry();

  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let loaded = false;

  const apply = (snapshot: BrowserSnapshot): void => {
    if (loaded) {
      registry.reconcileAfterReconnect(snapshot);
    } else {
      registry.loadInitialSnapshot(snapshot);
      loaded = true;
    }

    // Counts only. URLs and titles never reach the log by default.
    log(
      `zen-agent: ${String(snapshot.windows.length)} window(s), ${String(snapshot.spaces.length)} Space(s), ${String(snapshot.tabs.length)} tab(s)`,
    );
  };

  /**
   * The connect and refresh chain.
   *
   * Everything that touches the registry runs through this one promise, in
   * order. The extension emits `session.ready` as soon as it has a listener,
   * which can arrive while the first snapshot is still in flight — without a
   * single chain that event would load the initial snapshot a second time, and
   * the registry rejects that outright.
   */
  let work: Promise<void> = transport.connect().then((snapshot) => {
    apply(snapshot);
    log(
      `zen-agent: connected; capabilities: ${transport.capabilities.join(", ")}`,
    );
  });

  const scheduleRefresh = (): void => {
    work = work
      .then(async () => {
        apply(await transport.snapshot());
      })
      .catch((error: unknown) => {
        log(`zen-agent: snapshot failed: ${String(error)}`);
      });
  };

  transport.on((event) => {
    switch (event.type) {
      case "delta":
        try {
          registry.applyDelta(event.delta);
        } catch (error) {
          log(`zen-agent: delta rejected, re-snapshotting: ${String(error)}`);
          scheduleRefresh();
        }
        break;
      case "invalidated":
        scheduleRefresh();
        break;
      case "session-replaced":
        log(
          "zen-agent: the browser session was replaced; identifiers are stale",
        );
        scheduleRefresh();
        break;
      case "closed":
        resolveClosed();
        break;
    }
  });

  await work;
  return { registry, transport, closed };
}
