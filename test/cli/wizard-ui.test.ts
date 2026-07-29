import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createTerminalWizardUi } from "../../src/cli/wizard-ui.js";

function outputCapture(): {
  readonly output: Writable;
  readonly value: () => string;
} {
  let captured = "";
  return {
    output: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        captured += chunk.toString("utf8");
        callback();
      },
    }),
    value: () => captured,
  };
}

describe("terminal wizard UI", () => {
  it("renders a stable no-color product header", () => {
    const capture = outputCapture();
    const ui = createTerminalWizardUi({
      output: capture.output,
      color: false,
    });

    ui.header("0.1.0");

    expect(capture.value()).toContain("ZEN AGENT  v0.1.0");
    expect(capture.value()).toContain(
      "Background browser automation, by design.",
    );
    expect(capture.value()).not.toContain("\u001B[38;2;");
    expect(
      capture
        .value()
        .split("\n")
        .filter((line) => line.includes("│"))
        .map((line) => [...line].length),
    ).toEqual([50, 50]);
  });

  it("uses the Zen Agent coral accent when color is enabled", () => {
    const capture = outputCapture();
    const ui = createTerminalWizardUi({
      output: capture.output,
      color: true,
    });

    ui.info("Ready.");

    expect(capture.value()).toContain("\u001B[38;2;247;111;83m");
    expect(capture.value()).toContain("Ready.");
  });
});
