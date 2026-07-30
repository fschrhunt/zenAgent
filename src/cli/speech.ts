import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const SPEECH_HELPER_CONTRACT_VERSION = 1;
export const ZEN_AGENT_SPEECH_HELPER_ENV = "ZEN_AGENT_SPEECH_HELPER";

const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_HELPER_TIMEOUT_MS = 2 * 60 * 60_000;
const execFileAsync = promisify(execFile);

export interface SpeechHelperInspection {
  readonly status:
    "available" | "missing" | "unsupported-platform" | "unsupported-version";
  readonly contractVersion: typeof SPEECH_HELPER_CONTRACT_VERSION;
}

export interface SpeechLocaleInventory {
  readonly supportedLocales: readonly string[];
  readonly installedLocales: readonly string[];
}

export interface SpeechInstallResult {
  readonly locale: string;
  readonly installed: true;
}

export interface SpeechTranscriptResult {
  readonly locale: string;
  readonly text: string;
}

export class SpeechHelperError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SpeechHelperError";
    this.code = code;
  }
}

export interface SpeechHelperOptions {
  readonly executablePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly macOSVersion?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface HelperEnvelope {
  readonly ok: boolean;
  readonly contractVersion: number;
  readonly result?: unknown;
  readonly error?: Readonly<{ code: string; message: string }>;
}

function defaultSpeechHelperPath(): string {
  return fileURLToPath(
    new URL("../../dist/native/zen-agent-speech", import.meta.url),
  );
}

export function speechHelperPath(options: SpeechHelperOptions = {}): string {
  const override =
    options.environment?.[ZEN_AGENT_SPEECH_HELPER_ENV] ??
    process.env[ZEN_AGENT_SPEECH_HELPER_ENV];
  return options.executablePath ?? override ?? defaultSpeechHelperPath();
}

function macOSMajor(options: SpeechHelperOptions): number | undefined {
  const explicit = options.macOSVersion;
  if (explicit !== undefined) {
    return Number(explicit.split(".")[0]);
  }
  try {
    return Number(
      execFileSync("sw_vers", ["-productVersion"], {
        encoding: "utf8",
      })
        .trim()
        .split(".")[0],
    );
  } catch {
    return undefined;
  }
}

export function inspectSpeechHelper(
  options: SpeechHelperOptions = {},
): SpeechHelperInspection {
  if ((options.platform ?? process.platform) !== "darwin") {
    return {
      status: "unsupported-platform",
      contractVersion: SPEECH_HELPER_CONTRACT_VERSION,
    };
  }
  const major = macOSMajor(options);
  if (major === undefined || major < 26) {
    return {
      status: "unsupported-version",
      contractVersion: SPEECH_HELPER_CONTRACT_VERSION,
    };
  }
  return {
    status: existsSync(speechHelperPath(options)) ? "available" : "missing",
    contractVersion: SPEECH_HELPER_CONTRACT_VERSION,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(stdout: string): HelperEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SpeechHelperError(
      "invalid-helper-response",
      "The speech helper returned malformed JSON.",
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed["ok"] !== "boolean" ||
    typeof parsed["contractVersion"] !== "number"
  ) {
    throw new SpeechHelperError(
      "invalid-helper-response",
      "The speech helper returned an invalid contract envelope.",
    );
  }
  if (parsed["contractVersion"] !== SPEECH_HELPER_CONTRACT_VERSION) {
    throw new SpeechHelperError(
      "protocol-version-mismatch",
      "The speech helper contract version does not match Zen Agent.",
    );
  }
  const error = parsed["error"];
  return {
    ok: parsed["ok"],
    contractVersion: parsed["contractVersion"],
    ...(parsed["result"] === undefined ? {} : { result: parsed["result"] }),
    ...(isRecord(error) &&
    typeof error["code"] === "string" &&
    typeof error["message"] === "string"
      ? { error: { code: error["code"], message: error["message"] } }
      : {}),
  };
}

function invoke(
  arguments_: readonly string[],
  options: SpeechHelperOptions = {},
): unknown {
  const inspection = inspectSpeechHelper(options);
  if (inspection.status !== "available") {
    throw new SpeechHelperError(
      "speech-helper-unavailable",
      `The on-device speech helper is ${inspection.status.replaceAll("-", " ")}.`,
    );
  }
  const run = spawnSync(speechHelperPath(options), arguments_, {
    encoding: "utf8",
    maxBuffer: MAX_HELPER_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.error !== undefined) {
    throw new SpeechHelperError(
      "speech-helper-failed",
      "The on-device speech helper could not be started.",
    );
  }
  const envelope = parseEnvelope(run.stdout);
  if (!envelope.ok) {
    throw new SpeechHelperError(
      envelope.error?.code ?? "speech-helper-failed",
      envelope.error?.message ??
        "The on-device speech helper could not complete the request.",
    );
  }
  return envelope.result;
}

function stringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    return undefined;
  }
  const values = value[field];
  return values.every((item) => typeof item === "string") ? values : undefined;
}

export function canonicalSpeechLocale(locale: string): string {
  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(locale);
  } catch {
    canonical = undefined;
  }
  if (canonical === undefined || canonical !== locale) {
    throw new SpeechHelperError(
      "invalid-locale",
      "Speech locale must be a canonical BCP-47 identifier such as en-US.",
    );
  }
  return canonical;
}

export function speechLocales(
  options: SpeechHelperOptions = {},
): SpeechLocaleInventory {
  const result = invoke(["locales"], options);
  const supportedLocales = stringArray(result, "supportedLocales");
  const installedLocales = stringArray(result, "installedLocales");
  if (supportedLocales === undefined || installedLocales === undefined) {
    throw new SpeechHelperError(
      "invalid-helper-response",
      "The speech helper returned an invalid locale inventory.",
    );
  }
  return { supportedLocales, installedLocales };
}

export function installSpeechLocale(
  locale: string,
  options: SpeechHelperOptions = {},
): SpeechInstallResult {
  const canonical = canonicalSpeechLocale(locale);
  const result = invoke(["install", "--locale", canonical], options);
  if (
    !isRecord(result) ||
    result["locale"] !== canonical ||
    result["installed"] !== true
  ) {
    throw new SpeechHelperError(
      "invalid-helper-response",
      "The speech helper returned an invalid installation result.",
    );
  }
  return { locale: canonical, installed: true };
}

export function transcribeAudio(
  locale: string,
  inputPath: string,
  options: SpeechHelperOptions = {},
): SpeechTranscriptResult {
  const canonical = canonicalSpeechLocale(locale);
  if (!isAbsolute(inputPath)) {
    throw new SpeechHelperError(
      "invalid-input",
      "Speech input must be an absolute path to prerecorded local audio.",
    );
  }
  const result = invoke(
    ["transcribe", "--locale", canonical, "--input", inputPath],
    options,
  );
  return parseTranscriptResult(result, canonical);
}

export async function transcribeAudioAsync(
  locale: string,
  inputPath: string,
  options: SpeechHelperOptions = {},
): Promise<SpeechTranscriptResult> {
  const canonical = canonicalSpeechLocale(locale);
  if (!isAbsolute(inputPath)) {
    throw new SpeechHelperError(
      "invalid-input",
      "Speech input must be an absolute path to prerecorded local audio.",
    );
  }
  const inspection = inspectSpeechHelper(options);
  if (inspection.status !== "available") {
    throw new SpeechHelperError(
      "speech-helper-unavailable",
      `The on-device speech helper is ${inspection.status.replaceAll("-", " ")}.`,
    );
  }
  if (isAborted(options.signal)) {
    throw new SpeechHelperError(
      "cancelled",
      "Speech transcription was cancelled.",
    );
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      speechHelperPath(options),
      ["transcribe", "--locale", canonical, "--input", inputPath],
      {
        encoding: "utf8",
        maxBuffer: MAX_HELPER_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    stdout = result.stdout;
  } catch (error) {
    if (isAborted(options.signal)) {
      throw new SpeechHelperError(
        "cancelled",
        "Speech transcription was cancelled.",
      );
    }
    const failureOutput =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout
        : undefined;
    if (failureOutput === undefined) {
      throw new SpeechHelperError(
        "speech-helper-failed",
        "The on-device speech helper could not complete the request.",
      );
    }
    const envelope = parseEnvelope(failureOutput);
    throw new SpeechHelperError(
      envelope.error?.code ?? "speech-helper-failed",
      envelope.error?.message ??
        "The on-device speech helper could not complete the request.",
    );
  }

  const envelope = parseEnvelope(stdout);
  if (!envelope.ok) {
    throw new SpeechHelperError(
      envelope.error?.code ?? "speech-helper-failed",
      envelope.error?.message ??
        "The on-device speech helper could not complete the request.",
    );
  }
  return parseTranscriptResult(envelope.result, canonical);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function parseTranscriptResult(
  result: unknown,
  canonical: string,
): SpeechTranscriptResult {
  if (
    !isRecord(result) ||
    result["locale"] !== canonical ||
    typeof result["text"] !== "string"
  ) {
    throw new SpeechHelperError(
      "invalid-helper-response",
      "The speech helper returned an invalid transcription result.",
    );
  }
  return { locale: canonical, text: result["text"] };
}
