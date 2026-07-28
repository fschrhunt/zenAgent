import { ZEN_AGENT_VERSION } from "../index.js";

const HELP = `zen-agent ${ZEN_AGENT_VERSION}

A considerate, space-aware browser CLI for agents.

Usage:
  zen-agent [command]

Commands:
  help         Show this help
  version      Print the version

Options:
  -h, --help       Show this help
  -v, --version    Print the version
`;

export function runCli(args: readonly string[]): number {
  const [command] = args;

  if (
    command === undefined ||
    command === "help" ||
    command === "-h" ||
    command === "--help"
  ) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "version" || command === "-v" || command === "--version") {
    process.stdout.write(`${ZEN_AGENT_VERSION}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
