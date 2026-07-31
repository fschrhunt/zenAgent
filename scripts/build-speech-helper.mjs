import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const source = resolve(repositoryRoot, "native/speech-helper/main.swift");
const output = resolve(repositoryRoot, "dist/native/zen-agent-speech");
const required = process.argv.includes("--required");

if (process.platform !== "darwin") {
  if (required) {
    throw new Error("The on-device speech helper can only be built on macOS.");
  }
  process.stdout.write("Skipped speech helper build outside macOS.\n");
  process.exit(0);
}

const [major] =
  process.release.name === "node"
    ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" })
        .trim()
        .split(".")
    : [];

if (Number(major) < 26) {
  if (required) {
    throw new Error("The on-device speech helper requires macOS 26 or newer.");
  }
  process.stdout.write("Skipped speech helper build before macOS 26.\n");
  process.exit(0);
}

mkdirSync(resolve(repositoryRoot, "dist/native"), { recursive: true });
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    "arm64-apple-macosx26.0",
    source,
    "-o",
    output,
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
execFileSync(output, ["contract"], { stdio: "inherit" });
process.stdout.write(`Built ${output}.\n`);
