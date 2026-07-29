/**
 * The production native host and shared daemon are one process.
 *
 * Zen starts this process by opening the Native Messaging port. The process
 * owns that one browser transport and publishes the daemon's per-profile Unix
 * socket for setup CLI and MCP clients. A second standalone daemon would have no
 * Native Messaging connection and would violate the one-transport invariant.
 */

import type { Readable, Writable } from "node:stream";

import { configPath, loadOptionalConfig } from "../config/path.js";
import type { ZenAgentConfig } from "../config/schema.js";
import { createDaemonLogger, type DaemonLogLevel } from "../daemon/logger.js";
import { daemonPaths, type DaemonPaths } from "../daemon/paths.js";
import { DaemonSocketServer } from "../daemon/server.js";
import { DaemonService, type DaemonTransport } from "../daemon/service.js";
import {
  ZenTransport,
  type TransportConnection,
  type ZenTransportOptions,
} from "../transport/client.js";
import { streamConnection } from "./connection.js";

export interface NativeDaemonHostOptions extends ZenTransportOptions {
  /** Where sanitized diagnostics go. Never stdout, which carries the wire. */
  readonly log?: (line: string) => void;
  readonly logLevel?: DaemonLogLevel;
  readonly input?: Readable;
  readonly output?: Writable;
  /** Test seams; production callers leave these unset. */
  readonly connection?: TransportConnection;
  readonly transport?: DaemonTransport;
  readonly paths?: (profileId: string) => DaemonPaths;
  readonly config?: ZenAgentConfig;
  readonly configFile?: string;
}

export interface NativeDaemonHost {
  readonly service: DaemonService;
  readonly server: DaemonSocketServer;
  readonly paths: DaemonPaths;
  /** Resolves after the native port or an explicit stop shuts everything down. */
  readonly closed: Promise<void>;
  readonly stop: () => Promise<void>;
}

export async function startNativeDaemonHost(
  options: NativeDaemonHostOptions = {},
): Promise<NativeDaemonHost> {
  const log =
    options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logger = createDaemonLogger({
    ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
    sink: (entry) => {
      log(
        `zen-agent: ${entry.level} ${entry.component}.${entry.event}${entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`}`,
      );
    },
  });
  const transport =
    options.transport ??
    (() => {
      const connection =
        options.connection ??
        streamConnection(
          options.input ?? process.stdin,
          options.output ?? process.stdout,
        );
      return new ZenTransport(connection, {
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.privateWindowPolicy === undefined
          ? {}
          : { privateWindowPolicy: options.privateWindowPolicy }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    })();
  const loadConfig =
    options.config === undefined
      ? () => loadOptionalConfig(options.configFile ?? configPath())
      : () => Promise.resolve(options.config);
  const initialConfig = await loadConfig();

  let transportClaimed = false;
  let server: DaemonSocketServer | undefined;
  let stopping: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const service = new DaemonService({
    transportFactory: () => {
      if (transportClaimed) {
        throw new Error(
          "The browser closed its native port; Zen must launch a replacement host.",
        );
      }

      transportClaimed = true;
      return transport;
    },
    logger,
    ...(initialConfig === undefined ? {} : { config: initialConfig }),
    configLoader: loadConfig,
  });

  const stop = (): Promise<void> => {
    if (stopping !== undefined) {
      return stopping;
    }

    stopping = (async () => {
      if (server !== undefined) {
        await server.stop();
      } else {
        await service.stop();
      }
      resolveClosed();
    })();
    return stopping;
  };

  const unsubscribe = transport.on((event) => {
    if (event.type === "closed") {
      void stop();
    }
  });

  try {
    await service.start();
    const status = service.status();

    if (status.state !== "connected" || status.profileId === null) {
      throw new Error(
        "Zen Agent could not identify the connected Zen profile, so it will not publish an ambiguous daemon socket.",
      );
    }

    const paths = (options.paths ?? daemonPaths)(status.profileId);
    server = new DaemonSocketServer({
      service,
      socketPath: paths.socket,
      lockPath: paths.lock,
      logger,
    });
    await server.start();

    return {
      service,
      server,
      paths,
      closed,
      stop: async () => {
        unsubscribe();
        await stop();
      },
    };
  } catch (error) {
    unsubscribe();
    await stop();
    throw error;
  }
}
