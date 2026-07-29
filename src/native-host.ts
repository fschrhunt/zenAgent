#!/usr/bin/env node

/**
 * Entry point Firefox launches for native messaging.
 *
 * Never write to stdout from here: it is the wire.
 */

import { startNativeDaemonHost } from "./native/daemon-host.js";
import { crashDiagnostic } from "./security/diagnostics.js";

try {
  const host = await startNativeDaemonHost();
  await host.closed;
} catch (error) {
  process.stderr.write(`${crashDiagnostic("zen-agent", error)}\n`);
  process.exitCode = 1;
}
