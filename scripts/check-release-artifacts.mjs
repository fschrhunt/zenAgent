import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const version = String(packageJson.version);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "zen-agent-release-"));
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  execFileSync(
    npmExecutable,
    [
      "pack",
      "--dry-run=false",
      "--ignore-scripts",
      "--pack-destination",
      temporaryDirectory,
    ],
    {
      cwd: repositoryRoot,
      stdio: "ignore",
    },
  );

  const archivePath = join(temporaryDirectory, `zen-agent-${version}.tgz`);

  if (!existsSync(archivePath)) {
    throw new Error(`npm did not create ${archivePath}.`);
  }

  const installPrefix = join(temporaryDirectory, "offline-install");
  execFileSync(
    npmExecutable,
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--offline",
      "--prefix",
      installPrefix,
      archivePath,
    ],
    {
      cwd: repositoryRoot,
      stdio: "ignore",
    },
  );

  for (const executable of ["zen-agent", "zen-agent-host", "zen-agent-mcp"]) {
    if (!existsSync(join(installPrefix, "bin", executable))) {
      throw new Error(`Bundled release is missing ${executable}.`);
    }
  }

  execFileSync(
    process.execPath,
    [join(import.meta.dirname, "package-extension.mjs"), temporaryDirectory],
    {
      cwd: repositoryRoot,
      stdio: "ignore",
    },
  );

  const extensionPath = join(
    temporaryDirectory,
    `zen-agent-extension-${version}-unsigned.xpi`,
  );
  execFileSync("unzip", ["-tqq", extensionPath], { stdio: "ignore" });

  const extensionManifest = JSON.parse(
    execFileSync("unzip", ["-p", extensionPath, "manifest.json"], {
      encoding: "utf8",
    }),
  );

  if (extensionManifest.version !== version) {
    throw new Error("Packaged extension version does not match the release.");
  }

  const formula = execFileSync(
    process.execPath,
    [join(import.meta.dirname, "render-homebrew-formula.mjs"), archivePath],
    { encoding: "utf8" },
  );

  if (
    !formula.includes("class ZenAgent < Formula") ||
    !formula.includes(`zen-agent-${version}.tgz`) ||
    !formula.includes('depends_on "node"') ||
    !formula.includes('ENV["npm_config_offline"] = "true"')
  ) {
    throw new Error("Generated Homebrew formula is incomplete.");
  }

  const sbom = JSON.parse(
    execFileSync(npmExecutable, ["sbom", "--omit=dev", "--sbom-format=spdx"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  );

  if (sbom.spdxVersion !== "SPDX-2.3") {
    throw new Error("npm did not generate an SPDX 2.3 SBOM.");
  }

  process.stdout.write(
    `Verified release artifacts for zen-agent@${version}.\n`,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
