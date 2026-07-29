import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);
const archiveArgument = process.argv[2];

if (archiveArgument === undefined) {
  throw new Error(
    "Usage: node scripts/render-homebrew-formula.mjs <npm-package.tgz>",
  );
}

const archivePath = resolve(archiveArgument);
const expectedArchiveName = `${String(packageJson.name)}-${String(packageJson.version)}.tgz`;

if (basename(archivePath) !== expectedArchiveName) {
  throw new Error(
    `Expected archive ${expectedArchiveName}, received ${basename(archivePath)}.`,
  );
}

const sha256 = createHash("sha256")
  .update(readFileSync(archivePath))
  .digest("hex");
const version = String(packageJson.version);
const tarballUrl = `https://github.com/fschrhunt/zen-agent/releases/download/v${version}/${expectedArchiveName}`;

process.stdout.write(`# typed: strict
# frozen_string_literal: true

# ZenAgent installs the Zen Agent CLI, native host, and MCP server.
class ZenAgent < Formula
  desc "Considerate, space-aware CLI and MCP server for Zen Browser"
  homepage "https://github.com/fschrhunt/zen-agent"
  url "${tarballUrl}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    ENV["npm_config_offline"] = "true"
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "zen-agent ${version}", shell_output("#{bin}/zen-agent --help")
    assert_predicate bin/"zen-agent-host", :executable?
    assert_predicate bin/"zen-agent-mcp", :executable?
  end
end
`);
