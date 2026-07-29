#!/usr/bin/env node

import { startMcpStdio } from "./mcp/stdio.js";
import { crashDiagnostic } from "./security/diagnostics.js";

try {
  await startMcpStdio();
} catch (error) {
  process.stderr.write(`${crashDiagnostic("zen-agent-mcp", error)}\n`);
  process.exitCode = 1;
}
