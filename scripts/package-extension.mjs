import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const extensionDirectory = join(repositoryRoot, "extension");
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const extensionManifest = JSON.parse(
  readFileSync(join(extensionDirectory, "manifest.json"), "utf8"),
);

if (extensionManifest.version !== packageJson.version) {
  throw new Error(
    `Extension version ${String(extensionManifest.version)} does not match package version ${String(packageJson.version)}.`,
  );
}

function collectFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(relative(extensionDirectory, path));
    } else {
      throw new Error(`Extension contains an unsupported file type: ${path}`);
    }
  }

  return files.sort();
}

const outputDirectory = resolve(
  process.argv[2] ?? join(repositoryRoot, "artifacts"),
);
const outputPath = join(
  outputDirectory,
  `zen-agent-extension-${String(packageJson.version)}-unsigned.xpi`,
);

mkdirSync(outputDirectory, { recursive: true });
rmSync(outputPath, { force: true });
execFileSync(
  "zip",
  ["-X", "-q", outputPath, ...collectFiles(extensionDirectory)],
  {
    cwd: extensionDirectory,
    stdio: "inherit",
  },
);

process.stdout.write(`${outputPath}\n`);
