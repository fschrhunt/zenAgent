import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  expandDownloadDirectory,
  UploadStagingRegistry,
  writeAtomicResource,
} from "../../src/daemon/files.js";
import { browserFixture } from "../browser/fixtures.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zen-agent-files-test-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("UploadStagingRegistry", () => {
  it("stages bounded regular files into owner-only opaque paths", async () => {
    const directory = await root();
    const source = join(directory, "resume.pdf");
    await writeFile(source, "private bytes", { mode: 0o600 });
    const registry = new UploadStagingRegistry({
      temporaryDirectory: directory,
    });
    const staged = await registry.stage(
      "client-1",
      browserFixture().tab.id,
      "lease-1",
      [source],
    );

    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]).toMatchObject({
      name: "resume.pdf",
      bytes: 13,
    });
    expect(staged.files[0]?.path).not.toContain("resume.pdf");
    expect(await readFile(staged.files[0]?.path ?? "", "utf8")).toBe(
      "private bytes",
    );
    expect((await stat(staged.files[0]?.path ?? "")).mode & 0o777).toBe(0o600);
    const stagingDirectory = join(staged.files[0]?.path ?? "", "..");
    expect((await stat(stagingDirectory)).mode & 0o777).toBe(0o700);
    await registry.clear();
    await expect(lstat(staged.files[0]?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects relative paths, symlinks, directories, and oversized files without leaking paths", async () => {
    const directory = await root();
    const source = join(directory, "secret-name.txt");
    const linked = join(directory, "linked-secret.txt");
    await writeFile(source, "oversized");
    await symlink(source, linked);
    const registry = new UploadStagingRegistry({
      temporaryDirectory: directory,
      maxFileBytes: 4,
    });
    const tabId = browserFixture().tab.id;

    for (const candidate of ["relative.txt", linked, directory, source]) {
      let failure: unknown;
      try {
        await registry.stage("client", tabId, "lease", [candidate]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toHaveProperty("code");
      if (candidate === source) {
        expect(failure).toMatchObject({ code: "payload-too-large" });
      }
      expect(String(failure)).not.toContain(candidate);
      expect(String(failure)).not.toContain("secret-name");
    }
    await registry.clear();
  });

  it("releases only matching owner, client, tab, and lease lifetimes", async () => {
    const directory = await root();
    const source = join(directory, "file.txt");
    await writeFile(source, "data");
    const registry = new UploadStagingRegistry({
      temporaryDirectory: directory,
    });
    const first = browserFixture("first");
    const second = browserFixture("second");
    const byLease = await registry.stage("client", first.tab.id, "lease-a", [
      source,
    ]);

    await expect(
      registry.release("other", byLease.stagingId),
    ).rejects.toMatchObject({ code: "policy-rejection" });
    await registry.releaseLease("client", "lease-a");
    await expect(lstat(byLease.files[0]?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const byTab = await registry.stage("client", first.tab.id, "lease-b", [
      source,
    ]);
    const byClient = await registry.stage("client", second.tab.id, "lease-c", [
      source,
    ]);
    await registry.releaseTab(first.tab.id);
    await expect(lstat(byTab.files[0]?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await registry.releaseClient("client");
    await expect(lstat(byClient.files[0]?.path ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await registry.clear();
  });

  it("enforces file, client, and session count ceilings", async () => {
    const directory = await root();
    const source = join(directory, "file.txt");
    await writeFile(source, "data");
    const tabId = browserFixture().tab.id;
    const registry = new UploadStagingRegistry({
      temporaryDirectory: directory,
      maxFilesPerStage: 1,
      maxStagesPerClient: 1,
      maxStagesPerSession: 2,
    });

    await expect(
      registry.stage("a", tabId, "lease", [source, source]),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    await registry.stage("a", tabId, "lease-a", [source]);
    await expect(
      registry.stage("a", tabId, "lease-b", [source]),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    await registry.stage("b", tabId, "lease-b", [source]);
    await expect(
      registry.stage("c", tabId, "lease-c", [source]),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    await registry.clear();
  });
});

describe("atomic resource writer", () => {
  it("expands only a leading home token", () => {
    expect(expandDownloadDirectory("~/Downloads", "/Users/tester")).toBe(
      "/Users/tester/Downloads",
    );
    expect(() => expandDownloadDirectory("Downloads", "/Users/tester")).toThrow(
      /absolute/u,
    );
    expect(() =>
      expandDownloadDirectory("~other/Downloads", "/Users/tester"),
    ).toThrow(/absolute/u);
  });

  it("writes owner-only bytes atomically without overwriting collisions", async () => {
    const directory = await root();
    await writeFile(join(directory, "report.txt"), "existing");

    const written = await writeAtomicResource({
      directory,
      fileName: "report.txt",
      bytes: Buffer.from("new"),
    });

    expect(written.path).toBe(join(directory, "report (1).txt"));
    expect(written.bytesWritten).toBe(3);
    expect(await readFile(join(directory, "report.txt"), "utf8")).toBe(
      "existing",
    );
    expect(await readFile(written.path, "utf8")).toBe("new");
    expect((await stat(written.path)).mode & 0o777).toBe(0o600);
  });

  it("publishes concurrent same-name writes to distinct files", async () => {
    const directory = await root();
    const [first, second] = await Promise.all([
      writeAtomicResource({
        directory,
        fileName: "result.json",
        bytes: Buffer.from("first"),
      }),
      writeAtomicResource({
        directory,
        fileName: "result.json",
        bytes: Buffer.from("second"),
      }),
    ]);

    expect(new Set([first.path, second.path]).size).toBe(2);
    expect(
      new Set([
        await readFile(first.path, "utf8"),
        await readFile(second.path, "utf8"),
      ]),
    ).toEqual(new Set(["first", "second"]));
  });

  it("refuses unsafe names, symlink destinations, non-directories, and oversized bytes with redacted errors", async () => {
    const directory = await root();
    const downloads = join(directory, "Private Downloads");
    const linked = join(directory, "linked-downloads");
    const file = join(directory, "not-a-directory");
    await mkdir(downloads);
    await symlink(downloads, linked);
    await writeFile(file, "data");

    for (const destination of [linked, file]) {
      let failure: unknown;
      try {
        await writeAtomicResource({
          directory: destination,
          fileName: "report.txt",
          bytes: Buffer.from("data"),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "policy-rejection" });
      expect(String(failure)).not.toContain(destination);
      expect(String(failure)).not.toContain("Private Downloads");
    }

    await expect(
      writeAtomicResource({
        directory: downloads,
        fileName: "../escape.txt",
        bytes: Buffer.from("data"),
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(
      writeAtomicResource({
        directory: downloads,
        fileName: "large.bin",
        bytes: Buffer.from("large"),
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "payload-too-large" });
  });

  it("preserves restrictive permissions on an existing download directory", async () => {
    const directory = await root();
    const downloads = join(directory, "Downloads");
    await mkdir(downloads, { mode: 0o700 });
    await chmod(downloads, 0o700);

    await writeAtomicResource({
      directory: "~/Downloads",
      homeDirectory: directory,
      fileName: "resource.bin",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect((await stat(downloads)).mode & 0o777).toBe(0o700);
  });
});
