#!/usr/bin/env node

import { runCli } from "./cli/run.js";

process.exitCode = runCli(process.argv.slice(2));
