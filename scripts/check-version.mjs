import { readFile } from "node:fs/promises";
const [packageSource, lockSource, extensionSource, changelog] =
  await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
  ]);

const packageJson = JSON.parse(packageSource);
const packageLock = JSON.parse(lockSource);
const extensionManifest = JSON.parse(extensionSource);
const version = packageJson.version;
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (typeof version !== "string" || !semver.test(version)) {
  throw new Error("package.json must contain a valid semantic version.");
}

if (extensionManifest.version !== version) {
  throw new Error(
    `Extension version ${JSON.stringify(extensionManifest.version)} does not match package version ${JSON.stringify(version)}.`,
  );
}

if (
  packageLock.version !== version ||
  packageLock.packages?.[""]?.version !== version
) {
  throw new Error(
    "package-lock.json root versions must match the package version.",
  );
}

const escapedVersion = version.replaceAll(".", String.raw`\.`);
const releaseHeading = new RegExp(
  String.raw`^## \[${escapedVersion}\] - \d{4}-\d{2}-\d{2}$`,
  "mu",
);

if (!releaseHeading.test(changelog)) {
  throw new Error(
    `CHANGELOG.md must contain a dated heading for version ${version}.`,
  );
}

if (!changelog.includes(`## [Unreleased]`)) {
  throw new Error("CHANGELOG.md must retain an Unreleased section.");
}

process.stdout.write(
  `Verified semantic version ${version} across package, lockfile, extension, and changelog.\n`,
);
