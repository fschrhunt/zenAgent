import { execFileSync } from "node:child_process";

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(
  npmExecutable,
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);

const parsed = JSON.parse(output);
const result = parsed[0];

if (result === undefined) {
  throw new Error("npm pack did not describe a package.");
}

const packagedPaths = new Set(result.files.map((file) => file.path));
const requiredPaths = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/mcp.js",
  "dist/native-host.js",
  "extension/manifest.json",
  "native/speech-helper/main.swift",
  "package.json",
  "scripts/build-speech-helper.mjs",
];
const missingPaths = requiredPaths.filter((path) => !packagedPaths.has(path));

if (missingPaths.length > 0) {
  throw new Error(
    `npm package is missing required files: ${missingPaths.join(", ")}`,
  );
}

process.stdout.write(
  `Verified ${result.name}@${result.version}: ${String(result.entryCount)} packaged files.\n`,
);
