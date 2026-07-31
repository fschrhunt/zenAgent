import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  known,
  sessionEntityId,
  type BrowserTab,
} from "../../src/browser/model.js";
import { DaemonClient } from "../../src/daemon/client.js";
import {
  DAEMON_PROTOCOL_RECOVERY,
  DAEMON_PROTOCOL_VERSION,
  DaemonMessageDecoder,
  encodeDaemonMessage,
  type DaemonErrorResponse,
  type DaemonRequest,
  type DaemonResponse,
} from "../../src/daemon/protocol.js";
import {
  acquireDaemonLock,
  DaemonAlreadyRunningError,
  daemonFileMode,
  DaemonSocketServer,
} from "../../src/daemon/server.js";
import { DaemonService } from "../../src/daemon/service.js";
import { browserFixture } from "../browser/fixtures.js";
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

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextSocketMessage(
  socket: Socket,
  decoder: DaemonMessageDecoder,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      try {
        const messages = decoder.push(chunk);
        const message = messages[0];

        if (message !== undefined) {
          cleanup();
          resolve(message);
        }
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
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
  it("returns an actionable recovery contract to a mismatched client", async () => {
    const paths = await temporaryPaths();
    const server = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const socket = await connectSocket(paths.socket);
    const response = nextSocketMessage(socket, new DaemonMessageDecoder());

    socket.write(
      encodeDaemonMessage({
        protocolVersion: 99,
        type: "request",
        id: "old-client",
        clientId: "old-client",
        method: "health",
      }),
    );

    await expect(response).resolves.toMatchObject({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "error",
      id: "old-client",
      error: {
        code: "protocol-version-mismatch",
        data: {
          retryable: false,
          performed: false,
          recovery: DAEMON_PROTOCOL_RECOVERY,
          expectedProtocolVersion: DAEMON_PROTOCOL_VERSION,
          receivedProtocolVersion: 99,
        },
      },
    });
    socket.destroy();
    await server.stop();
  });

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

  it("serves bounded per-tab mutation load from multiple MCP daemon clients", async () => {
    const paths = await temporaryPaths();
    const fixture = browserFixture();
    const secondTab = {
      ...fixture.tab,
      id: sessionEntityId("tab", fixture.session.id, "socket-second-tab"),
      browsingContextId: known(null),
      selected: known(false),
    } satisfies BrowserTab;
    const transport = fakeDaemonTransport({
      ...fixture.snapshot,
      tabs: [fixture.tab, secondTab],
    });
    const daemonService = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    const server = new DaemonSocketServer({
      service: daemonService,
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const first = new DaemonClient({
      socketPath: paths.socket,
      clientId: "mcp-load-first",
    });
    const second = new DaemonClient({
      socketPath: paths.socket,
      clientId: "mcp-load-second",
    });
    await Promise.all([first.connect(), second.connect()]);
    transport.mutationGate.wait = true;

    const operations = Array.from({ length: 8 }, (_, index) => {
      const client = index % 2 === 0 ? first : second;
      const tabId = index % 2 === 0 ? fixture.tab.id : secondTab.id;
      return client.request(
        "tabs.navigate",
        {
          tabId,
          url: `https://socket-load-${String(index)}.example/`,
        },
        `socket-load-${String(index)}`,
      );
    });

    await vi.waitFor(() => {
      expect(
        transport.calls.filter((call) => call.startsWith("navigate:")),
      ).toHaveLength(2);
    });
    transport.mutationGate.release();
    await expect(Promise.all(operations)).resolves.toHaveLength(8);
    expect(
      transport.calls.filter((call) => call.startsWith("navigate:")),
    ).toHaveLength(8);

    first.close();
    second.close();
    await server.stop();
  });

  it("forwards an AbortSignal to cancel an in-flight daemon wait", async () => {
    const paths = await temporaryPaths();
    const daemonService = service();
    const server = new DaemonSocketServer({
      service: daemonService,
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const client = new DaemonClient({
      socketPath: paths.socket,
      clientId: "wait-client",
    });
    await client.connect();
    const listed = (await client.request("registry.entities", {
      kind: "tab",
    })) as { entities: readonly { id: unknown }[] };
    const tabId = listed.entities[0]?.id;
    expect(tabId).toBeDefined();

    const controller = new AbortController();
    const waiting = client.request(
      "pages.wait",
      {
        tabId,
        condition: { kind: "text-present", text: "never appears" },
        timeoutMs: 60_000,
        pollIntervalMs: 100,
      },
      undefined,
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });

    client.close();
    await server.stop();
  });

  it("releases a client's tab leases when its socket closes", async () => {
    const paths = await temporaryPaths();
    const daemonService = service();
    const server = new DaemonSocketServer({
      service: daemonService,
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const listed = (await daemonService.handle({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "request",
      id: "list-tabs",
      clientId: "test-reader",
      method: "registry.entities",
      params: { kind: "tab" },
    })) as { entities: readonly { id: unknown }[] };
    const tabId = listed.entities[0]?.id;
    expect(tabId).toBeDefined();

    const owner = new DaemonClient({
      socketPath: paths.socket,
      clientId: "lease-owner",
    });
    const successor = new DaemonClient({
      socketPath: paths.socket,
      clientId: "lease-successor",
    });
    await Promise.all([owner.connect(), successor.connect()]);
    await expect(
      owner.request(
        "tabs.lease.acquire",
        { tabId, ttlMs: 300_000 },
        "owner-acquire",
      ),
    ).resolves.toMatchObject({ lease: { tabId } });
    await expect(
      successor.request("tabs.lease.acquire", { tabId }, "successor-blocked"),
    ).rejects.toMatchObject({ code: "lease-conflict" });

    owner.close();
    let acquired: unknown;

    for (
      let attempt = 0;
      attempt < 20 && acquired === undefined;
      attempt += 1
    ) {
      try {
        acquired = await successor.request(
          "tabs.lease.acquire",
          { tabId },
          `successor-${String(attempt)}`,
        );
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          (error as { code?: unknown }).code !== "lease-conflict"
        ) {
          throw error;
        }

        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    expect(acquired).toMatchObject({ lease: { tabId } });
    successor.close();
    await server.stop();
  });

  it("rejects multiple client identities on one socket", async () => {
    const paths = await temporaryPaths();
    const server = new DaemonSocketServer({
      service: service(),
      socketPath: paths.socket,
      lockPath: paths.lock,
    });
    await server.start();
    const socket = await connectSocket(paths.socket);
    const decoder = new DaemonMessageDecoder();
    const first: DaemonRequest = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "request",
      id: "first",
      clientId: "client-a",
      method: "health",
    };
    socket.write(encodeDaemonMessage(first));
    await expect(nextSocketMessage(socket, decoder)).resolves.toMatchObject({
      type: "response",
      id: "first",
    });

    const impersonated: DaemonRequest = {
      ...first,
      id: "second",
      clientId: "client-b",
    };
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    socket.write(encodeDaemonMessage(impersonated));
    const rejected = (await nextSocketMessage(
      socket,
      decoder,
    )) as DaemonErrorResponse;
    expect(rejected).toMatchObject({
      type: "error",
      id: "second",
      error: { code: "invalid-request" },
    });
    await closed;
    await server.stop();
  });
});
