import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  daemonPaths,
  DaemonDiscoveryError,
  discoverDaemonSocket,
} from "../../src/daemon/paths.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zen-agent-paths-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("daemon socket discovery", () => {
  it("maps an explicit profile without exposing it in the socket name", async () => {
    const directory = await temporaryDirectory();
    const socket = await discoverDaemonSocket("private-profile-name", {
      directory,
    });

    expect(socket).toBe(
      join(directory, basename(daemonPaths("private-profile-name").socket)),
    );
    expect(socket).not.toContain("private-profile-name");
  });

  it("bootstraps through the only active profile socket", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "012345abcdef.sock"), "");

    await expect(discoverDaemonSocket(undefined, { directory })).resolves.toBe(
      join(directory, "012345abcdef.sock"),
    );
  });

  it("fails loudly when profile selection is ambiguous", async () => {
    const directory = await temporaryDirectory();
    await Promise.all([
      writeFile(join(directory, "012345abcdef.sock"), ""),
      writeFile(join(directory, "fedcba987654.sock"), ""),
    ]);

    await expect(
      discoverDaemonSocket(undefined, { directory }),
    ).rejects.toThrow(DaemonDiscoveryError);
  });
});
