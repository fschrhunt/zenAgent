#!/usr/bin/env node

/**
 * Entry point Firefox launches for native messaging.
 *
 * Never write to stdout from here: it is the wire.
 */

import { startNativeHost } from "./native/host.js";

try {
  const host = await startNativeHost();
  await host.closed;
} catch (error) {
  process.stderr.write(`zen-agent: ${String(error)}\n`);
  process.exitCode = 1;
}
