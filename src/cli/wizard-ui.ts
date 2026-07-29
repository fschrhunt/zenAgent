import { isCancel, SelectPrompt } from "@clack/core";
import type { Readable, Writable } from "node:stream";

const ANSI_RESET = "\u001B[0m";
const ANSI_BOLD = "\u001B[1m";
const ANSI_DIM = "\u001B[2m";
const ANSI_CORAL = "\u001B[38;2;247;111;83m";
const ANSI_GREEN = "\u001B[38;2;112;204;152m";
const ANSI_YELLOW = "\u001B[38;2;240;190;92m";
const ANSI_RED = "\u001B[38;2;239;112;112m";

export interface WizardOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface WizardUi {
  readonly header: (version: string) => void;
  readonly select: <T extends string>(
    message: string,
    options: readonly WizardOption<T>[],
    initialValue?: T,
  ) => Promise<T | undefined>;
  readonly info: (message: string) => void;
  readonly success: (message: string) => void;
  readonly warning: (message: string) => void;
  readonly error: (message: string) => void;
  readonly note: (title: string, lines: readonly string[]) => void;
  readonly finish: (message: string) => void;
}

export interface TerminalWizardUiOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly color?: boolean;
}

interface WizardTheme {
  readonly accent: (value: string) => string;
  readonly bold: (value: string) => string;
  readonly muted: (value: string) => string;
  readonly good: (value: string) => string;
  readonly caution: (value: string) => string;
  readonly bad: (value: string) => string;
}

function style(enabled: boolean, code: string, value: string): string {
  return enabled ? `${code}${value}${ANSI_RESET}` : value;
}

function theme(color: boolean): WizardTheme {
  return {
    accent: (value) => style(color, ANSI_CORAL, value),
    bold: (value) => style(color, ANSI_BOLD, value),
    muted: (value) => style(color, ANSI_DIM, value),
    good: (value) => style(color, ANSI_GREEN, value),
    caution: (value) => style(color, ANSI_YELLOW, value),
    bad: (value) => style(color, ANSI_RED, value),
  };
}

function supportsColor(output: Writable): boolean {
  return (
    "isTTY" in output &&
    output.isTTY === true &&
    process.env["NO_COLOR"] === undefined &&
    process.env["TERM"] !== "dumb"
  );
}

function optionLabel<T extends string>(
  option: WizardOption<T>,
  active: boolean,
  currentTheme: WizardTheme,
): string {
  const cursor = active ? currentTheme.accent("❯") : " ";
  const label = active ? currentTheme.bold(option.label) : option.label;
  const hint =
    option.hint === undefined ? "" : currentTheme.muted(`  ${option.hint}`);
  return `  ${cursor} ${label}${hint}`;
}

export function createTerminalWizardUi(
  options: TerminalWizardUiOptions = {},
): WizardUi {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const currentTheme = theme(options.color ?? supportsColor(output));
  const write = (value: string): void => {
    output.write(value);
  };

  return {
    header(version) {
      write(
        [
          "",
          currentTheme.accent(
            "  ╭──────────────────────────────────────────────╮",
          ),
          `  ${currentTheme.accent("│")}  ${currentTheme.bold("ZEN AGENT")}  ${currentTheme.muted(`v${version}`)}${" ".repeat(Math.max(0, 32 - version.length))}${currentTheme.accent("│")}`,
          `  ${currentTheme.accent("│")}  Background browser automation, by design.   ${currentTheme.accent("│")}`,
          currentTheme.accent(
            "  ╰──────────────────────────────────────────────╯",
          ),
          "",
        ].join("\n"),
      );
    },

    async select<T extends string>(
      message: string,
      selectOptions: readonly WizardOption<T>[],
      initialValue?: T,
    ): Promise<T | undefined> {
      const prompt = new SelectPrompt<WizardOption<T>>({
        options: [...selectOptions],
        input,
        output,
        ...(initialValue === undefined ? {} : { initialValue }),
        render() {
          const selected = this.options[this.cursor];
          const marker =
            this.state === "cancel"
              ? currentTheme.bad("■")
              : this.state === "submit"
                ? currentTheme.good("◇")
                : currentTheme.accent("◆");
          const lines = [`${marker}  ${message}`];

          if (this.state === "submit") {
            if (selected !== undefined) {
              lines.push(
                `   ${currentTheme.muted(selected.label)}${
                  selected.hint === undefined
                    ? ""
                    : currentTheme.muted(` · ${selected.hint}`)
                }`,
              );
            }
            return lines.join("\n");
          }

          if (this.state === "cancel") {
            lines.push(`   ${currentTheme.muted("Cancelled")}`);
            return lines.join("\n");
          }

          for (const [index, option] of this.options.entries()) {
            lines.push(
              optionLabel(option, index === this.cursor, currentTheme),
            );
          }
          lines.push(
            "",
            `  ${currentTheme.muted("↑/↓ move")}  ${currentTheme.muted("Enter select")}  ${currentTheme.muted("Esc cancel")}`,
          );
          return lines.join("\n");
        },
      });
      const result = await prompt.prompt();
      return isCancel(result) ? undefined : result;
    },

    info(message) {
      write(`  ${currentTheme.accent("●")} ${message}\n`);
    },

    success(message) {
      write(`  ${currentTheme.good("✓")} ${message}\n`);
    },

    warning(message) {
      write(`  ${currentTheme.caution("▲")} ${message}\n`);
    },

    error(message) {
      write(`  ${currentTheme.bad("■")} ${message}\n`);
    },

    note(title, lines) {
      write(`\n  ${currentTheme.bold(title)}\n`);
      for (const line of lines) {
        write(`  ${currentTheme.muted("│")} ${line}\n`);
      }
      write("\n");
    },

    finish(message) {
      write(
        `\n  ${currentTheme.accent("◆")} ${currentTheme.bold(message)}\n\n`,
      );
    },
  };
}
