import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectSpeechHelper,
  installSpeechLocale,
  speechLocales,
  SpeechHelperError,
  transcribeAudio,
} from "../../src/cli/speech.js";

const roots: string[] = [];

function helper(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "zen-agent-speech-helper-"));
  roots.push(root);
  const path = join(root, "helper");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

function options(executablePath: string) {
  return {
    executablePath,
    platform: "darwin" as const,
    macOSVersion: "26.0",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("on-device speech helper client", () => {
  it("reports platform, version, and binary availability without execution", () => {
    const executablePath = helper("exit 99");
    expect(inspectSpeechHelper(options(executablePath))).toEqual({
      status: "available",
      contractVersion: 1,
    });
    expect(
      inspectSpeechHelper({
        executablePath,
        platform: "linux",
        macOSVersion: "26.0",
      }).status,
    ).toBe("unsupported-platform");
    expect(
      inspectSpeechHelper({
        executablePath,
        platform: "darwin",
        macOSVersion: "25.6",
      }).status,
    ).toBe("unsupported-version");
  });

  it("validates the bounded locale inventory contract", () => {
    const executablePath = helper(
      `printf '%s\\n' '{"ok":true,"contractVersion":1,"result":{"supportedLocales":["en-US","fr-FR"],"installedLocales":["en-US"]}}'`,
    );

    expect(speechLocales(options(executablePath))).toEqual({
      supportedLocales: ["en-US", "fr-FR"],
      installedLocales: ["en-US"],
    });
  });

  it("accepts only a matching explicit installation result", () => {
    const executablePath = helper(
      `printf '%s\\n' '{"ok":true,"contractVersion":1,"result":{"locale":"en-US","installed":true}}'`,
    );

    expect(installSpeechLocale("en-US", options(executablePath))).toEqual({
      locale: "en-US",
      installed: true,
    });
    expect(() => installSpeechLocale("en-us", options(executablePath))).toThrow(
      SpeechHelperError,
    );
  });

  it("requires an absolute prerecorded input path before invoking the helper", () => {
    const executablePath = helper("exit 99");

    expect(() =>
      transcribeAudio("en-US", "recording.wav", options(executablePath)),
    ).toThrow(/absolute path/u);
  });

  it("preserves the helper's model-not-installed refusal", () => {
    const executablePath = helper(
      `printf '%s\\n' '{"ok":false,"contractVersion":1,"error":{"code":"model-not-installed","message":"Install during setup first."}}'; exit 1`,
    );

    expect(() =>
      transcribeAudio("en-US", "/tmp/recording.wav", options(executablePath)),
    ).toThrowError(expect.objectContaining({ code: "model-not-installed" }));
  });

  it("returns only the validated transcript result", () => {
    const executablePath = helper(
      `printf '%s\\n' '{"ok":true,"contractVersion":1,"result":{"locale":"en-US","text":"Local words"}}'`,
    );

    expect(
      transcribeAudio("en-US", "/tmp/recording.wav", options(executablePath)),
    ).toEqual({ locale: "en-US", text: "Local words" });
  });
});
