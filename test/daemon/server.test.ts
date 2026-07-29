import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DaemonClient } from "../../src/daemon/client.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonResponse,
} from "../../src/daemon/protocol.js";
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  daemonFileMode,
  DaemonSocketServer,
} from "../../src/daemon/server.js";
import { DaemonService } from "../../src/daemon/service.js";
import { fakeDaemonTransport } from "./fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryPaths(): Promise<{
  directory: string;
  socket: string;
  lock: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "zen-agent-daemon-test-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    socket: join(directory, "daemon.sock"),
    lock: join(directory, "daemon.lock"),
  };
}

function service(): DaemonService {
  return new DaemonService({
    transportFactory: () => fakeDaemonTransport(),
    reconcileIntervalMs: 0,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DaemonSocketServer", () => {
  it("serves correlated requests and uses restrictive filesystem modes", async () => {
    const paths = await temporaryPaths();
    const server = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const client = new DaemonClient({
      socketPath: paths.socket,
      clientId: "socket-test",
    });
    await client.connect();

    await expect(client.request("version")).resolves.toEqual({
      daemonVersion: "0.1.0",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    expect(await daemonFileMode(paths.directory)).toBe(0o700);
    expect(await daemonFileMode(paths.socket)).toBe(0o600);
    expect(await daemonFileMode(paths.lock)).toBe(0o600);

    client.close();
    await server.stop();
  });

  it("broadcasts registry events to connected clients", async () => {
    const paths = await temporaryPaths();
    const daemonService = service();
    const server = new DaemonSocketServer({
      service: daemonService,
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const client = new DaemonClient({ socketPath: paths.socket });
    const events: string[] = [];
    client.onEvent((event) => events.push(event.event));
    await client.connect();
    await client.request("registry.refresh");

    await vi.waitFor(() => {
      expect(events).toContain("registry.updated");
    });
    client.close();
    await server.stop();
  });

  it("rejects a second singleton while the first socket is live", async () => {
    const paths = await temporaryPaths();
    const first = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await first.start();
    const second = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });

    await expect(second.start()).rejects.toThrow(DaemonAlreadyRunningError);
    await second.stop();
    expect(await daemonFileMode(paths.lock)).toBe(0o600);
    expect(await daemonFileMode(paths.socket)).toBe(0o600);
    const client = new DaemonClient({ socketPath: paths.socket });
    await client.connect();
    await expect(client.request("health")).resolves.toMatchObject({ ok: true });
    client.close();
    await first.stop();
  });

  it("recovers a stale lock and socket left by a crashed process", async () => {
    const paths = await temporaryPaths();
    await writeFile(
      paths.lock,
      JSON.stringify({
        pid: 2_147_483_647,
        protocolVersion: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    await writeFile(paths.socket, "stale", { mode: 0o600 });

    const handle = await acquireDaemonLock(paths.lock, paths.socket, 5);
    expect(await daemonFileMode(paths.lock)).toBe(0o600);
    await handle.close();
  });

  it("answers a shutdown request before closing client connections", async () => {
    const paths = await temporaryPaths();
    const server = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const client = new DaemonClient({ socketPath: paths.socket });
    await client.connect();

    await expect(client.request("daemon.shutdown")).resolves.toEqual({
      stopping: true,
    });
    await vi.waitFor(() => {
      expect(server.clientCount).toBe(0);
    });
    client.close();
  });

  it("keeps concurrent responses correlated", async () => {
    const paths = await temporaryPaths();
    const server = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const client = new DaemonClient({ socketPath: paths.socket });
    await client.connect();

    const [health, status, version] = (await Promise.all([
      client.request("health"),
      client.request("status"),
      client.request("version"),
    ])) as readonly [unknown, unknown, DaemonResponse["result"]];
    expect(health).toMatchObject({ ok: true });
    expect(status).toMatchObject({ state: "connected" });
    expect(version).toMatchObject({ protocolVersion: 1 });
    client.close();
    await server.stop();
  });
});
