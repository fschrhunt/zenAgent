import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonClient } from "../../src/daemon/client.js";
import type { DaemonPaths } from "../../src/daemon/paths.js";
import { startNativeDaemonHost } from "../../src/native/daemon-host.js";
import { browserFixture } from "../browser/fixtures.js";
import { fakeDaemonTransport } from "../daemon/fixtures.js";

const temporaryRoots: string[] = [];

function temporaryPaths(): DaemonPaths {
  const directory = mkdtempSync(join(tmpdir(), "zen-agent-native-daemon-"));
  temporaryRoots.push(directory);
  return {
    directory,
    socket: join(directory, "daemon.sock"),
    lock: join(directory, "daemon.lock"),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the production native daemon host", () => {
  it("fails closed when private-window access has not passed its headed gate", async () => {
    await expect(
      startNativeDaemonHost({
        transport: fakeDaemonTransport(),
        privateWindowPolicy: "explicit",
        paths: () => temporaryPaths(),
        log: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "unsupported-capability",
      data: {
        reason: "private-window-proof-required",
        resource: "private-window",
        retryable: false,
      },
    });
  });

  it("publishes the connected profile registry over its Unix socket", async () => {
    const paths = temporaryPaths();
    const transport = fakeDaemonTransport();
    const host = await startNativeDaemonHost({
      transport,
      paths: () => paths,
      log: () => undefined,
    });
    const client = new DaemonClient({
      socketPath: paths.socket,
      clientId: "native-host-test",
    });

    try {
      await client.connect();
      const status = await client.request("status");

      expect(status).toMatchObject({
        state: "connected",
        counts: { tabs: 1 },
      });
      expect(existsSync(paths.socket)).toBe(true);
      expect(existsSync(paths.lock)).toBe(true);
    } finally {
      client.close();
      await host.stop();
    }

    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("shuts down when Zen closes the native transport", async () => {
    const paths = temporaryPaths();
    const transport = fakeDaemonTransport();
    const host = await startNativeDaemonHost({
      transport,
      paths: () => paths,
      log: () => undefined,
    });

    transport.emit({ type: "closed" });
    await host.closed;

    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("loads routing configuration into the production daemon", async () => {
    const paths = temporaryPaths();
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const host = await startNativeDaemonHost({
      transport,
      paths: () => paths,
      log: () => undefined,
      config: {
        version: 1,
        profile: fixture.profile.id.transportId,
        spaces: {
          personal: fixture.space.id.transportId,
          aliases: {},
        },
        routing: { rules: [] },
      },
    });
    const client = new DaemonClient({
      socketPath: paths.socket,
      clientId: "native-routing-test",
    });

    try {
      await client.connect();
      await expect(
        client.request(
          "tabs.resolve",
          {
            url: "https://example.com/",
            taskContext: "personal",
          },
          "resolve-personal",
        ),
      ).resolves.toMatchObject({
        status: "reused",
        tabId: fixture.tab.id,
      });
    } finally {
      client.close();
      await host.stop();
    }
  });
});
