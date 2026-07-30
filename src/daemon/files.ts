import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { entityIdKey, type BrowserTabId } from "../browser/model.js";
import {
  MAX_PAGE_MEDIA_BYTES,
  MAX_PAGE_RESOURCE_BYTES,
  MAX_PAGE_UPLOAD_FILES,
} from "../page/model.js";
import { DaemonProtocolError } from "./protocol.js";

export const MAX_UPLOAD_FILES_PER_STAGE = MAX_PAGE_UPLOAD_FILES;
export const MAX_UPLOAD_STAGES_PER_CLIENT = 16;
export const MAX_UPLOAD_STAGES_PER_SESSION = 64;
export const MAX_UPLOAD_FILE_BYTES = MAX_PAGE_MEDIA_BYTES;
export const MAX_UPLOAD_TOTAL_BYTES = 4 * MAX_PAGE_MEDIA_BYTES;
export const MAX_RESOURCE_WRITE_BYTES = MAX_PAGE_RESOURCE_BYTES;
export const MAX_RESOURCE_FILENAME_BYTES = 255;
export const MAX_RESOURCE_COLLISIONS = 10_000;

export interface StagedUploadFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

export interface StagedUpload {
  readonly stagingId: string;
  readonly files: readonly StagedUploadFile[];
}

interface UploadStageOwner {
  readonly stagingId: string;
  readonly clientId: string;
  readonly tabKey: string;
  readonly leaseId: string;
  readonly directory: string;
  readonly files: readonly StagedUploadFile[];
}

export interface UploadStagingOptions {
  readonly temporaryDirectory?: string;
  readonly maxFilesPerStage?: number;
  readonly maxStagesPerClient?: number;
  readonly maxStagesPerSession?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

function policyError(message: string, reason: string): DaemonProtocolError {
  return new DaemonProtocolError("policy-rejection", message, { reason });
}

function invalidFile(message: string, reason: string): DaemonProtocolError {
  return new DaemonProtocolError("invalid-request", message, { reason });
}

function payloadTooLarge(limit: string): DaemonProtocolError {
  return new DaemonProtocolError(
    "payload-too-large",
    "The file request exceeds a configured resource limit.",
    { limit },
  );
}

function systemCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Owns short-lived, opaque copies used for browser file-input operations.
 *
 * No source path is retained. Staged paths are returned only to the calling
 * service path and errors never echo either source or destination paths.
 */
export class UploadStagingRegistry {
  readonly #options: Required<UploadStagingOptions>;
  readonly #stages = new Map<string, UploadStageOwner>();
  #root: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: UploadStagingOptions = {}) {
    this.#options = {
      temporaryDirectory: options.temporaryDirectory ?? tmpdir(),
      maxFilesPerStage: options.maxFilesPerStage ?? MAX_UPLOAD_FILES_PER_STAGE,
      maxStagesPerClient:
        options.maxStagesPerClient ?? MAX_UPLOAD_STAGES_PER_CLIENT,
      maxStagesPerSession:
        options.maxStagesPerSession ?? MAX_UPLOAD_STAGES_PER_SESSION,
      maxFileBytes: options.maxFileBytes ?? MAX_UPLOAD_FILE_BYTES,
      maxTotalBytes: options.maxTotalBytes ?? MAX_UPLOAD_TOTAL_BYTES,
    };
  }

  public stage(
    clientId: string,
    tabId: BrowserTabId,
    leaseId: string,
    sourcePaths: readonly string[],
  ): Promise<StagedUpload> {
    return this.#exclusive(() =>
      this.#stage(clientId, tabId, leaseId, sourcePaths),
    );
  }

  public release(clientId: string, stagingId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const stage = this.#stages.get(stagingId);
      if (stage === undefined) {
        return false;
      }
      if (stage.clientId !== clientId) {
        throw policyError(
          "The upload staging record belongs to another daemon client.",
          "upload-owner",
        );
      }
      await this.#remove(stage);
      return true;
    });
  }

  public releaseClient(clientId: string): Promise<void> {
    return this.#exclusive(async () => {
      await this.#removeMatching((stage) => stage.clientId === clientId);
    });
  }

  public releaseTab(tabId: BrowserTabId): Promise<void> {
    const key = entityIdKey(tabId);
    return this.#exclusive(async () => {
      await this.#removeMatching((stage) => stage.tabKey === key);
    });
  }

  public releaseLease(clientId: string, leaseId: string): Promise<void> {
    return this.#exclusive(async () => {
      await this.#removeMatching(
        (stage) => stage.clientId === clientId && stage.leaseId === leaseId,
      );
    });
  }

  public clear(): Promise<void> {
    return this.#exclusive(async () => {
      this.#stages.clear();
      const root = this.#root;
      this.#root = undefined;
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async #stage(
    clientId: string,
    tabId: BrowserTabId,
    leaseId: string,
    sourcePaths: readonly string[],
  ): Promise<StagedUpload> {
    if (
      clientId.length === 0 ||
      leaseId.length === 0 ||
      sourcePaths.length === 0
    ) {
      throw invalidFile(
        "Upload staging requires a client, lease, and at least one file.",
        "upload-input",
      );
    }
    if (sourcePaths.length > this.#options.maxFilesPerStage) {
      throw payloadTooLarge("upload-file-count");
    }
    if (this.#stages.size >= this.#options.maxStagesPerSession) {
      throw payloadTooLarge("upload-session-stages");
    }
    const ownedCount = [...this.#stages.values()].filter(
      (stage) => stage.clientId === clientId,
    ).length;
    if (ownedCount >= this.#options.maxStagesPerClient) {
      throw payloadTooLarge("upload-client-stages");
    }
    if (!sourcePaths.every(isAbsolute)) {
      throw invalidFile(
        "Every upload source must be an explicit absolute path.",
        "upload-path",
      );
    }

    const root = await this.#ensureRoot();
    const stagingId = randomUUID();
    const directory = join(root, stagingId);
    const files: StagedUploadFile[] = [];
    let totalBytes = 0;

    try {
      await mkdir(directory, { mode: 0o700 });
      for (const [index, sourcePath] of sourcePaths.entries()) {
        const sourceInfo = await lstat(sourcePath).catch(() => undefined);
        if (sourceInfo === undefined || !sourceInfo.isFile()) {
          throw invalidFile(
            "An upload source is missing or is not a regular file.",
            "upload-not-regular",
          );
        }
        const source = await open(
          sourcePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        ).catch((error: unknown) => {
          throw policyError(
            systemCode(error) === "ELOOP"
              ? "Symbolic links are not accepted as upload sources."
              : "An upload source could not be opened safely.",
            "upload-open",
          );
        });

        try {
          const current = await source.stat();
          if (!current.isFile()) {
            throw invalidFile(
              "An upload source is not a regular file.",
              "upload-not-regular",
            );
          }
          if (current.size > this.#options.maxFileBytes) {
            throw payloadTooLarge("upload-file-bytes");
          }
          totalBytes += current.size;
          if (totalBytes > this.#options.maxTotalBytes) {
            throw payloadTooLarge("upload-total-bytes");
          }

          const destination = join(
            directory,
            `${String(index)}-${randomUUID()}`,
          );
          await pipeline(
            createReadStream("", {
              fd: source.fd,
              autoClose: false,
            }),
            createWriteStream(destination, {
              flags: "wx",
              mode: 0o600,
            }),
          );
          files.push({
            path: destination,
            name: basename(sourcePath),
            bytes: current.size,
          });
        } finally {
          await source.close();
        }
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (error instanceof DaemonProtocolError) {
        throw error;
      }
      throw policyError(
        "Upload staging could not copy a source file safely.",
        "upload-copy",
      );
    }

    const stage: UploadStageOwner = {
      stagingId,
      clientId,
      tabKey: entityIdKey(tabId),
      leaseId,
      directory,
      files,
    };
    this.#stages.set(stagingId, stage);
    return { stagingId, files };
  }

  async #ensureRoot(): Promise<string> {
    if (this.#root !== undefined) {
      return this.#root;
    }
    try {
      const root = await mkdtemp(
        join(resolve(this.#options.temporaryDirectory), "zen-agent-upload-"),
      );
      await chmod(root, 0o700);
      this.#root = root;
      return root;
    } catch {
      throw policyError(
        "Upload staging storage could not be created safely.",
        "upload-storage",
      );
    }
  }

  async #removeMatching(
    predicate: (stage: UploadStageOwner) => boolean,
  ): Promise<void> {
    for (const stage of [...this.#stages.values()]) {
      if (predicate(stage)) {
        await this.#remove(stage);
      }
    }
  }

  async #remove(stage: UploadStageOwner): Promise<void> {
    this.#stages.delete(stage.stagingId);
    await rm(stage.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface AtomicResourceWriteOptions {
  readonly directory: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly homeDirectory?: string;
  readonly maxBytes?: number;
}

export interface AtomicResourceWriteResult {
  readonly path: string;
  readonly bytesWritten: number;
}

export function expandDownloadDirectory(
  configured: string,
  homeDirectory = homedir(),
): string {
  const expanded = configured.startsWith("~/")
    ? join(homeDirectory, configured.slice(2))
    : configured;
  if (!isAbsolute(expanded)) {
    throw invalidFile(
      "The configured download directory must be absolute or begin with '~/'.",
      "download-directory",
    );
  }
  return resolve(expanded);
}

function validateResourceName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    basename(fileName) !== fileName ||
    fileName.includes("\0")
  ) {
    throw invalidFile(
      "The resource filename must be one safe path component.",
      "resource-filename",
    );
  }
  if (Buffer.byteLength(fileName, "utf8") > MAX_RESOURCE_FILENAME_BYTES) {
    throw payloadTooLarge("resource-filename-bytes");
  }
}

function collisionName(fileName: string, attempt: number): string {
  if (attempt === 0) {
    return fileName;
  }
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  return `${stem} (${String(attempt)})${extension}`;
}

/**
 * Publishes bytes with an atomic hard-link. `link` fails on an existing target,
 * so even a collision arriving after the initial check can never be replaced.
 */
export async function writeAtomicResource(
  options: AtomicResourceWriteOptions,
): Promise<AtomicResourceWriteResult> {
  validateResourceName(options.fileName);
  const maximum = options.maxBytes ?? MAX_RESOURCE_WRITE_BYTES;
  if (options.bytes.byteLength > maximum) {
    throw payloadTooLarge("resource-bytes");
  }
  const directory = expandDownloadDirectory(
    options.directory,
    options.homeDirectory,
  );
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    throw policyError(
      "The configured download destination is not a regular directory.",
      "download-directory",
    );
  }

  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw policyError(
      "The configured download destination could not be opened safely.",
      "download-directory",
    );
  });
  const temporaryPath = join(directory, `.zen-agent-${randomUUID()}.tmp`);

  try {
    const liveInfo = await directoryHandle.stat();
    if (
      !liveInfo.isDirectory() ||
      liveInfo.dev !== info.dev ||
      liveInfo.ino !== info.ino
    ) {
      throw policyError(
        "The configured download destination is not a regular directory.",
        "download-directory",
      );
    }
    const temporary = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await temporary.writeFile(options.bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    for (let attempt = 0; attempt < MAX_RESOURCE_COLLISIONS; attempt += 1) {
      const destination = join(
        directory,
        collisionName(options.fileName, attempt),
      );
      try {
        const currentDirectory = await lstat(directory);
        if (
          !currentDirectory.isDirectory() ||
          currentDirectory.isSymbolicLink() ||
          currentDirectory.dev !== liveInfo.dev ||
          currentDirectory.ino !== liveInfo.ino
        ) {
          throw policyError(
            "The configured download destination changed during the write.",
            "download-directory",
          );
        }
        await link(temporaryPath, destination);
        await unlink(temporaryPath);
        return { path: destination, bytesWritten: options.bytes.byteLength };
      } catch (error) {
        if (systemCode(error) !== "EEXIST") {
          throw error;
        }
      }
    }
    throw payloadTooLarge("resource-collisions");
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof DaemonProtocolError) {
      throw error;
    }
    throw policyError(
      "The resource could not be written to the configured download directory.",
      "resource-write",
    );
  } finally {
    await directoryHandle.close();
  }
}
