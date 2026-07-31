import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname } from "node:path";
import {
  daemonErrorResponse,
  daemonEvent,
  daemonResponse,
  DaemonMessageDecoder,
  DaemonProtocolError,
  encodeDaemonMessage,
  parseDaemonRequest,
  type DaemonRequest,
} from "./protocol.js";
import {
  daemonErrorBody,
  type DaemonService,
  type DaemonServiceEvent,
} from "./service.js";
import { silentDaemonLogger, type DaemonLogger } from "./logger.js";

export interface DaemonSocketServerOptions {
  readonly service: DaemonService;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly logger?: DaemonLogger;
  readonly maxClients?: number;
  readonly probeTimeoutMs?: number;
}

interface LockRecord {
  readonly pid: number;
  readonly protocolVersion: number;
  readonly startedAt: string;
}

export class DaemonAlreadyRunningError extends DaemonProtocolError {
  public constructor(message = "A Zen Agent daemon is already running.") {
    super("already-running", message);
    this.name = "DaemonAlreadyRunningError";
  }
}

export class DaemonSocketServer {
  readonly #options: DaemonSocketServerOptions;
  readonly #logger: DaemonLogger;
  readonly #clients = new Set<Socket>();
  readonly #clientIds = new Map<Socket, string>();

  #server: Server | undefined;
  #lockHandle: FileHandle | undefined;
  #unsubscribeService: (() => void) | undefined;
  #started = false;
  #ownsSocket = false;
  #stopping: Promise<void> | undefined;

  public constructor(options: DaemonSocketServerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentDaemonLogger;
  }

  public get clientCount(): number {
    return this.#clients.size;
  }

  public async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    await mkdir(dirname(this.#options.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(dirname(this.#options.socketPath), 0o700);
    this.#lockHandle = await acquireDaemonLock(
      this.#options.lockPath,
      this.#options.socketPath,
      this.#options.probeTimeoutMs,
    );

    try {
      this.#server = createServer((socket) => {
        this.#accept(socket);
      });
      this.#server.on("error", (error) => {
        this.#logger.log("error", "socket", "listener.error", {
          data: { code: nodeErrorCode(error) },
        });
      });

      // A stale filesystem socket is safe to remove only after this process
      // owns the exclusive lock for the same profile.
      await unlinkIfExists(this.#options.socketPath);
      await listen(this.#server, this.#options.socketPath);
      this.#ownsSocket = true;
      await chmod(this.#options.socketPath, 0o600);
      this.#unsubscribeService = this.#options.service.on((event) => {
        this.#broadcast(event);
      });
      this.#started = true;
      await this.#options.service.start();
      this.#logger.log("info", "socket", "listener.started");
    } catch (error) {
      await this.#cleanupFiles();
      throw error;
    }
  }

  public stop(): Promise<void> {
    if (this.#stopping !== undefined) {
      return this.#stopping;
    }

    this.#stopping = this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#unsubscribeService?.();
    this.#unsubscribeService = undefined;

    for (const socket of this.#clients) {
      socket.end();
      socket.destroy();
    }

    this.#clients.clear();
    this.#clientIds.clear();
    const server = this.#server;
    this.#server = undefined;

    if (server !== undefined) {
      await closeServer(server);
    }

    await this.#options.service.stop();
    await this.#cleanupFiles();
    this.#started = false;
    this.#logger.log("info", "socket", "listener.stopped");
  }

  #accept(socket: Socket): void {
    const maximum = this.#options.maxClients ?? 64;

    if (this.#clients.size >= maximum) {
      socket.destroy();
      return;
    }

    const decoder = new DaemonMessageDecoder();
    this.#clients.add(socket);
    socket.on("data", (chunk) => {
      try {
        const bytes =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;

        for (const raw of decoder.push(bytes)) {
          void this.#dispatch(socket, raw);
        }
      } catch (error) {
        this.#writeError(socket, requestIdOf(undefined), error);
        socket.end();
      }
    });
    const remove = (): void => {
      if (!this.#clients.delete(socket)) {
        return;
      }

      const clientId = this.#clientIds.get(socket);
      this.#clientIds.delete(socket);

      if (clientId !== undefined) {
        void this.#options.service.disconnectClient(clientId).catch(() => {
          this.#logger.log("warn", "socket", "client.cleanup-failed", {
            clientId,
          });
        });
      }
    };
    socket.on("close", remove);
    socket.on("error", remove);
  }

  async #dispatch(socket: Socket, raw: unknown): Promise<void> {
    let request: DaemonRequest;

    try {
      request = parseDaemonRequest(raw);
    } catch (error) {
      this.#writeError(socket, requestIdOf(raw), error);
      return;
    }

    const boundClientId = this.#clientIds.get(socket);

    if (boundClientId === undefined) {
      this.#clientIds.set(socket, request.clientId);
    } else if (boundClientId !== request.clientId) {
      this.#writeError(
        socket,
        request.id,
        new DaemonProtocolError(
          "invalid-request",
          "A daemon socket may carry requests for only one client identity.",
        ),
      );
      socket.end();
      return;
    }

    try {
      const result = await this.#options.service.handle(request);
      socket.write(encodeDaemonMessage(daemonResponse(request.id, result)));

      if (request.method === "daemon.shutdown") {
        setImmediate(() => {
          void this.stop();
        });
      }
    } catch (error) {
      this.#writeError(socket, request.id, error);
    }
  }

  #writeError(socket: Socket, id: string, error: unknown): void {
    const body = daemonErrorBody(error);
    socket.write(encodeDaemonMessage(daemonErrorResponse(id, body)));
    this.#logger.log("warn", "socket", "request.failed", {
      operationId: id,
      data: { code: body.code },
    });
  }

  #broadcast(event: DaemonServiceEvent): void {
    const frame = encodeDaemonMessage(daemonEvent(event.event, event.payload));

    for (const socket of this.#clients) {
      socket.write(frame);
    }
  }

  async #cleanupFiles(): Promise<void> {
    if (this.#ownsSocket) {
      await unlinkIfExists(this.#options.socketPath);
      this.#ownsSocket = false;
    }

    const lockHandle = this.#lockHandle;
    this.#lockHandle = undefined;

    if (lockHandle !== undefined) {
      await lockHandle.close();
      await removeOwnedLock(this.#options.lockPath, process.pid);
    }
  }
}

export async function acquireDaemonLock(
  lockPath: string,
  socketPath: string,
  probeTimeoutMs = 200,
): Promise<FileHandle> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const record: LockRecord = {
        pid: process.pid,
        protocolVersion: 1,
        startedAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, {
        encoding: "utf8",
      });
      await handle.sync();
      await chmod(lockPath, 0o600);
      return handle;
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    if (await socketIsLive(socketPath, probeTimeoutMs)) {
      throw new DaemonAlreadyRunningError();
    }

    const owner = await readLockPid(lockPath);

    if (owner !== undefined && processIsLive(owner)) {
      throw new DaemonAlreadyRunningError(
        `Zen Agent daemon process ${String(owner)} is still starting or running.`,
      );
    }

    // The socket did not answer and the recorded owner is gone or invalid.
    // Both names are exact per-profile targets, never globs.
    await unlinkIfExists(socketPath);
    await unlinkIfExists(lockPath);
  }

  throw new DaemonAlreadyRunningError(
    "Another process won the Zen Agent daemon startup race.",
  );
}

async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as unknown;

    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const pid = (value as Readonly<Record<string, unknown>>)["pid"];
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
      ? pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) === "EPERM";
  }
}

function socketIsLive(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function removeOwnedLock(path: string, pid: number): Promise<void> {
  if ((await readLockPid(path)) === pid) {
    await unlinkIfExists(path);
  }
}

function requestIdOf(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "invalid";
  }

  const id = (value as Readonly<Record<string, unknown>>)["id"];
  return typeof id === "string" && id.length > 0 ? id : "invalid";
}

function nodeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "UNKNOWN";
  }

  const code = (error as Readonly<Record<string, unknown>>)["code"];
  return typeof code === "string" ? code : "UNKNOWN";
}

/** Used by tests and diagnostics to verify filesystem permission posture. */
export async function daemonFileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}
