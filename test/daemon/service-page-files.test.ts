import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { known } from "../../src/browser/model.js";
import type { ZenAgentConfig } from "../../src/config/schema.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonMethod,
  type DaemonRequest,
} from "../../src/daemon/protocol.js";
import { DaemonService } from "../../src/daemon/service.js";
import { SpeechHelperError } from "../../src/cli/speech.js";
import type { PageMedia } from "../../src/page/model.js";
import { browserFixture } from "../browser/fixtures.js";
import { fakeDaemonTransport } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function request(
  method: DaemonMethod,
  params: unknown,
  idempotencyKey: string,
  clientId = "owner",
): DaemonRequest {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "request",
    id: `${method}-${idempotencyKey}`,
    clientId,
    method,
    params,
    idempotencyKey,
  };
}

function config(
  profile: string,
  space: string,
  downloads: string,
): ZenAgentConfig {
  return {
    version: 2,
    profile,
    profileMatch: "exact",
    privateWindows: "hidden",
    spaces: { personal: space, aliases: {} },
    routing: { rules: [], safeDefault: space },
    downloads: { directory: downloads },
    backgroundLaunch: { policy: "disabled" },
    speech: { installedLocales: ["en-US"] },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function pageTarget(
  service: DaemonService,
  tabId: ReturnType<typeof browserFixture>["tab"]["id"],
  elementRef = "element-1",
): Promise<{
  readonly tabId: typeof tabId;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly frameRef: string;
  readonly elementRef: string;
}> {
  const snapshot = (await service.handle(
    request("pages.snapshot", { tabId }, "snapshot"),
  )) as {
    documentId: string;
    snapshotId: string;
    rootFrameRef: string;
  };
  return {
    tabId,
    documentId: snapshot.documentId,
    snapshotId: snapshot.snapshotId,
    frameRef: snapshot.rootFrameRef,
    elementRef,
  };
}

function media(
  elementRef: string,
  captions: PageMedia["captions"],
  drm = false,
): PageMedia {
  return {
    elementRef,
    frameRef: "frame-1",
    kind: "video",
    sourceUrl: "https://media.example/private",
    duration: 60,
    currentTime: 2,
    paused: false,
    muted: false,
    volume: 1,
    readyState: 4,
    drm,
    captions,
  };
}

describe("DaemonService page file and media workflows", () => {
  it("stages uploads until lease release and releases them on selected takeover", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const sourceRoot = await temporaryDirectory("zen-agent-source-");
    const firstSource = join(sourceRoot, "first secret.txt");
    const secondSource = join(sourceRoot, "second secret.txt");
    await writeFile(firstSource, "first upload");
    await writeFile(secondSource, "second upload");
    const stagedPaths: string[] = [];

    transport.uploadPage = async (target, paths) => {
      expect(target.tabId).toBe(fixture.tab.id.transportId);
      expect(paths).toHaveLength(1);
      const path = paths[0];
      expect(path).toBeDefined();
      if (path !== undefined) {
        stagedPaths.push(path);
        expect(path).not.toContain("secret");
        expect(await readFile(path, "utf8")).toMatch(/upload/u);
      }
      return {
        performed: true,
        documentId: target.documentId,
        fileCount: paths.length,
      };
    };
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const target = await pageTarget(service, fixture.tab.id);
    const acquired = (await service.handle(
      request("tabs.lease.acquire", { tabId: fixture.tab.id }, "lease-one"),
    )) as { lease: { leaseId: string } };

    await expect(
      service.handle(
        request(
          "pages.upload",
          {
            target,
            leaseId: acquired.lease.leaseId,
            paths: [firstSource],
          },
          "upload-one",
        ),
      ),
    ).resolves.toMatchObject({ performed: true, fileCount: 1 });
    expect(await exists(stagedPaths[0] ?? "")).toBe(true);

    await service.handle(
      request(
        "tabs.lease.release",
        { leaseId: acquired.lease.leaseId },
        "release-one",
      ),
    );
    expect(await exists(stagedPaths[0] ?? "")).toBe(false);

    const nextLease = (await service.handle(
      request("tabs.lease.acquire", { tabId: fixture.tab.id }, "lease-two"),
    )) as { lease: { leaseId: string } };
    await service.handle(
      request(
        "pages.upload",
        {
          target,
          leaseId: nextLease.lease.leaseId,
          paths: [secondSource],
        },
        "upload-two",
      ),
    );
    expect(await exists(stagedPaths[1] ?? "")).toBe(true);

    transport.replaceSnapshot({
      ...fixture.snapshot,
      tabs: [{ ...fixture.tab, selected: known(true) }],
    });
    await service.refresh();
    await vi.waitFor(async () => {
      expect(await exists(stagedPaths[1] ?? "")).toBe(false);
    });
    await service.stop();
  });

  it("uses caption cues without fetching media, including on playing tabs", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport({
      ...fixture.snapshot,
      tabs: [{ ...fixture.tab, mediaState: known("playing") }],
    });
    transport.listPageMedia = () =>
      Promise.resolve({
        media: [
          media("media-1", [
            {
              kind: "subtitles",
              label: "English",
              language: "en-US",
              mode: "showing",
              cuesAvailable: true,
              truncated: false,
              cues: [
                { startTime: 2, endTime: 3, text: "second" },
                { startTime: 0, endTime: 1, text: "first" },
              ],
            },
          ]),
        ],
        truncated: false,
      });
    const fetch = vi.fn();
    transport.fetchPageMedia = fetch;
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
    });
    await service.start();
    const target = await pageTarget(service, fixture.tab.id, "media-1");

    await expect(
      service.handle(
        request(
          "pages.media.transcribe",
          { target, locale: "en-US" },
          "captions",
        ),
      ),
    ).resolves.toEqual({
      source: "captions",
      locale: "en-US",
      text: "first\nsecond",
      truncated: false,
      mediaElementRef: "media-1",
    });
    expect(fetch).not.toHaveBeenCalled();
    await service.stop();
  });

  it("fetches bounded media to a private temporary file and removes it", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const downloads = await temporaryDirectory("zen-agent-downloads-");
    transport.listPageMedia = () =>
      Promise.resolve({
        media: [media("media-1", [])],
        truncated: false,
      });
    const audio = Buffer.from("bounded audio");
    transport.fetchPageMedia = (_target, options) => {
      expect(options?.maxBytes).toBe(1024);
      return Promise.resolve({
        mimeType: "audio/mpeg",
        bytes: audio.byteLength,
        dataBase64: audio.toString("base64"),
      });
    };
    let helperPath = "";
    const transcribeAudio = vi.fn(async (locale: string, inputPath: string) => {
      helperPath = inputPath;
      expect(locale).toBe("en-US");
      expect((await stat(inputPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(inputPath)).toEqual(audio);
      return { locale, text: "local transcript" };
    });
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      config: config(
        fixture.profile.id.transportId,
        fixture.space.id.transportId,
        downloads,
      ),
      transcribeAudio,
    });
    await service.start();
    const target = await pageTarget(service, fixture.tab.id, "media-1");

    await expect(
      service.handle(
        request(
          "pages.media.transcribe",
          { target, locale: "en-US", maxBytes: 1024 },
          "speech",
        ),
      ),
    ).resolves.toEqual({
      source: "on-device-speech",
      locale: "en-US",
      text: "local transcript",
      truncated: false,
      mediaElementRef: "media-1",
    });
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(helperPath).not.toBe("");
    expect(await exists(helperPath)).toBe(false);
    await service.stop();
  });

  it("maps speech blockers without exposing helper paths", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const downloads = await temporaryDirectory("zen-agent-downloads-");
    transport.listPageMedia = () =>
      Promise.resolve({
        media: [media("media-1", [])],
        truncated: false,
      });
    transport.fetchPageMedia = () =>
      Promise.resolve({
        mimeType: "audio/mpeg",
        bytes: 1,
        dataBase64: "YQ==",
      });
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      config: config(
        fixture.profile.id.transportId,
        fixture.space.id.transportId,
        downloads,
      ),
      transcribeAudio: () =>
        Promise.reject(
          new SpeechHelperError(
            "model-not-installed",
            "failed at /Users/private/recording.mp3",
          ),
        ),
    });
    await service.start();
    const target = await pageTarget(service, fixture.tab.id, "media-1");

    const failure = await service
      .handle(
        request(
          "pages.media.transcribe",
          { target, locale: "en-US" },
          "blocked-speech",
        ),
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "unsupported-capability",
      data: {
        reason: "speech-model-not-installed",
        resource: "speech-model",
        userActionRequired: true,
      },
    });
    expect(String(failure)).not.toContain("/Users/private");
    await service.stop();
  });

  it("downloads bounded resources atomically without replacing collisions", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport({
      ...fixture.snapshot,
      tabs: [{ ...fixture.tab, mediaState: known("playing") }],
    });
    const root = await temporaryDirectory("zen-agent-resource-");
    const downloads = join(root, "Downloads");
    await mkdir(downloads, { mode: 0o700 });
    await writeFile(join(downloads, "report.txt"), "existing");
    const body = Buffer.from("new resource");
    transport.fetchPageResource = (_target, url, options) => {
      expect(url).toBe("https://example.com/private-report");
      expect(options?.maxBytes).toBe(1024);
      return Promise.resolve({
        mimeType: "text/plain",
        bytes: body.byteLength,
        dataBase64: body.toString("base64"),
      });
    };
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      config: config(
        fixture.profile.id.transportId,
        fixture.space.id.transportId,
        downloads,
      ),
    });
    await service.start();
    const elementTarget = await pageTarget(service, fixture.tab.id);
    const target = {
      tabId: elementTarget.tabId,
      documentId: elementTarget.documentId,
      snapshotId: elementTarget.snapshotId,
      frameRef: elementTarget.frameRef,
    };

    await expect(
      service.handle(
        request(
          "pages.resource.download",
          {
            target,
            url: "https://example.com/private-report",
            fileName: "report.txt",
            maxBytes: 1024,
          },
          "download",
        ),
      ),
    ).resolves.toEqual({
      path: join(downloads, "report (1).txt"),
      bytes: body.byteLength,
      mimeType: "text/plain",
    });
    expect(await readFile(join(downloads, "report.txt"), "utf8")).toBe(
      "existing",
    );
    expect(await readFile(join(downloads, "report (1).txt"))).toEqual(body);
    await service.stop();
  });

  it("cancels a bounded download before writing any resource", async () => {
    const fixture = browserFixture();
    const transport = fakeDaemonTransport(fixture.snapshot);
    const downloads = await temporaryDirectory("zen-agent-cancel-download-");
    let resolveFetch:
      | ((result: {
          mimeType: string;
          bytes: number;
          dataBase64: string;
        }) => void)
      | undefined;
    transport.fetchPageResource = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    const service = new DaemonService({
      transportFactory: () => transport,
      reconcileIntervalMs: 0,
      config: config(
        fixture.profile.id.transportId,
        fixture.space.id.transportId,
        downloads,
      ),
    });
    await service.start();
    const elementTarget = await pageTarget(service, fixture.tab.id);
    const target = {
      tabId: elementTarget.tabId,
      documentId: elementTarget.documentId,
      snapshotId: elementTarget.snapshotId,
      frameRef: elementTarget.frameRef,
    };
    const operation = request(
      "pages.resource.download",
      {
        target,
        url: "https://example.com/cancelled.txt",
        fileName: "cancelled.txt",
      },
      "cancelled",
    );
    const pending = service.handle(operation);

    await vi.waitFor(() => {
      expect(resolveFetch).toBeTypeOf("function");
    });
    await expect(
      service.handle(
        request(
          "operations.cancel",
          { operationId: operation.id },
          "cancel-operation",
        ),
      ),
    ).resolves.toEqual({ cancelled: true, operationId: operation.id });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await exists(join(downloads, "cancelled.txt"))).toBe(false);

    resolveFetch?.({
      mimeType: "text/plain",
      bytes: 1,
      dataBase64: "YQ==",
    });
    await service.stop();
  });
});
