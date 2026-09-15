#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { writeServerLicenseNotices } from "./package-licenses.mjs";
import { tarExecutable } from "./archive-tool.mjs";
import { assertCleanRevision, resetBuildWorkspace } from "./build-workspace.mjs";
import { buildVersion } from "./release-version.mjs";

// The Server deployment target. deploy/release-server.sh runs the archived binary
// as the service user, so the release is always built for linux/amd64, and
// CGO_ENABLED=0 keeps it self-contained.
const SERVER_TARGET = { goos: "linux", goarch: "amd64" };
const SERVER_NAME = "piik-server";

// Everything the archive may contain. deploy/release-server.sh enforces the same
// four names in its entry allowlist and manifest pattern; both change together.
const RUNTIME_PATHS = ["REVISION", "LICENSE", "THIRD-PARTY-NOTICES.txt", SERVER_NAME];

// The Vite output the server embeds. Its index.html names the main asset the
// deployment postflight proves over HTTP.
const WEB_DIST = "internal/server/webassets/dist";

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function buildWebAssets(cwd) {
  if (process.platform === "win32") {
    run(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "npm run build:web"],
      cwd,
    );
    return;
  }
  run("npm", ["run", "build:web"], cwd);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (
    value.length === 0 ||
    value.startsWith("../") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Invalid runtime path: ${value}`);
  }
  return value;
}

function regularFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail(`Runtime contains a link: ${absolute}`);
      if (metadata.isDirectory()) {
        pending.push(absolute);
      } else if (metadata.isFile()) {
        files.push(absolute);
      } else {
        fail(`Runtime contains an unsupported file type: ${absolute}`);
      }
    }
  }
  return files.sort((left, right) =>
    normalizedRelative(root, left).localeCompare(normalizedRelative(root, right)),
  );
}

function recordsFor(root) {
  return regularFiles(root).map((absolute) => {
    const path = normalizedRelative(root, absolute);
    if (!RUNTIME_PATHS.includes(path)) fail(`Unexpected packaged file: ${path}`);
    return { path, size: statSync(absolute).size, sha256: sha256(absolute) };
  });
}

function compareRecords(expected, actual) {
  if (expected.length !== actual.length) fail("Extracted runtime file count differs");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (
      left.path !== right.path ||
      left.size !== right.size ||
      left.sha256 !== right.sha256
    ) {
      fail(`Extracted runtime differs at ${left.path}`);
    }
  }
}

function validateArchiveEntries(entries) {
  for (const rawEntry of entries.split(/\r?\n/)) {
    let entry = rawEntry;
    while (entry.startsWith("./")) entry = entry.slice(2);
    entry = entry.replace(/\/$/, "");
    if (entry.length === 0) continue;
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      fail(`Invalid archive entry: ${rawEntry}`);
    }
    if (!RUNTIME_PATHS.includes(entry)) fail(`Unexpected archive entry: ${rawEntry}`);
  }
}

// mainAsset is the hashed entry script Vite named in the embedded index.html.
// The deployment postflight proves it over HTTP, so it is read from the same
// build the binary embeds rather than from the archive.
function mainAssetOf(distributionRoot) {
  const html = readFileSync(join(distributionRoot, "index.html"), "utf8");
  const match = html.match(/<script[^>]+src="\/(assets\/index-[A-Za-z0-9_-]+\.js)"/);
  if (!match) fail("Built Web HTML has no unique main asset");
  if (!existsSync(join(distributionRoot, ...match[1].split("/")))) {
    fail("Built Web main asset is missing");
  }
  return match[1];
}

if (process.argv.length !== 3 &&
    !(process.argv.length === 5 && process.argv[3] === "--container-image")) {
  fail("Usage: node scripts/package-server-release.mjs <new-output-directory> [--container-image <tag>]");
}
const containerImage = process.argv[4];
if (containerImage && !/^[a-z0-9][a-z0-9._/:+-]*$/.test(containerImage)) {
  fail("Container image tag is invalid");
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const outputRoot = resolve(process.cwd(), process.argv[2]);
const relativeOutput = relative(repositoryRoot, outputRoot);
if (relativeOutput === "" || (relativeOutput.split(/[\\/]/)[0] !== ".." && !isAbsolute(relativeOutput))) {
  fail("Output directory must be outside the repository");
}
if (existsSync(outputRoot)) fail("Output directory must not already exist");

const revision = assertCleanRevision(repositoryRoot);
const version = buildVersion(repositoryRoot, revision);
process.env.VITE_PIIK_VERSION = version;
process.env.VITE_PIIK_REVISION = revision;

if (!existsSync(join(repositoryRoot, "LICENSE"))) fail("Missing release input: LICENSE");
buildWebAssets(repositoryRoot);
assertCleanRevision(repositoryRoot, revision);
const mainAsset = mainAssetOf(join(repositoryRoot, WEB_DIST));

const releaseId = revision.slice(0, 7);
const temporaryRoot = resetBuildWorkspace(repositoryRoot, "server-package", "assembly");
const runtimeRoot = join(temporaryRoot, "runtime");
const verifyRoot = join(temporaryRoot, "verify");
let outputOwned = false;

try {
  mkdirSync(runtimeRoot, { recursive: true });
  copyFileSync(join(repositoryRoot, "LICENSE"), join(runtimeRoot, "LICENSE"));
  const goCommand = process.env.PIIK_GO?.trim() || "go";
  const serverPath = join(runtimeRoot, SERVER_NAME);
  run(goCommand, [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X main.BuildRevision=${revision} -X main.BuildVersion=${version}`,
    "-o",
    serverPath,
    "./cmd/piik-server",
  ], repositoryRoot, {
    ...process.env,
    GOOS: SERVER_TARGET.goos,
    GOARCH: SERVER_TARGET.goarch,
    CGO_ENABLED: "0",
  });
  chmodSync(serverPath, 0o755);
  writeServerLicenseNotices(
    repositoryRoot,
    join(runtimeRoot, "THIRD-PARTY-NOTICES.txt"),
    goCommand,
    SERVER_TARGET,
  );
  assertCleanRevision(repositoryRoot, revision);
  writeFileSync(join(runtimeRoot, "REVISION"), `${revision}\n`, "ascii");

  const records = recordsFor(runtimeRoot);
  const manifestName = `piik-${releaseId}.manifest.tsv`;
  const artifactName = `piik-${releaseId}-runtime.tar.gz`;
  const descriptorName = `piik-${releaseId}.release.json`;
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  outputOwned = true;
  const manifestPath = join(outputRoot, manifestName);
  const artifactPath = join(outputRoot, artifactName);
  const descriptorPath = join(outputRoot, descriptorName);
  writeFileSync(
    manifestPath,
    records.map((record) => `${record.sha256}\t${record.size}\t${record.path}\n`).join(""),
    "ascii",
  );

  const tar = tarExecutable();
  run(tar, ["-czf", artifactPath, "-C", runtimeRoot, "."], repositoryRoot);
  validateArchiveEntries(run(tar, ["-tzf", artifactPath], repositoryRoot));
  mkdirSync(verifyRoot);
  run(tar, ["-xzf", artifactPath, "-C", verifyRoot], repositoryRoot);
  compareRecords(records, recordsFor(verifyRoot));

  const descriptor = {
    schema: 2,
    version,
    revision,
    releaseId,
    artifact: artifactName,
    artifactSha256: sha256(artifactPath),
    manifest: manifestName,
    manifestSha256: sha256(manifestPath),
    fileCount: records.length,
    mainAsset,
  };
  if (containerImage) {
    // Reuse the verified, extracted release: no second Server or Web build.
    run("docker", [
      "build", "--platform", "linux/amd64",
      "--file", join(repositoryRoot, "deploy", "container", "Dockerfile"),
      "--build-arg", `PIIK_VERSION=${version}`,
      "--build-arg", `PIIK_REVISION=${revision}`,
      "--build-arg", `PIIK_SERVER_SHA256=${descriptor.artifactSha256}`,
      "--tag", containerImage, verifyRoot,
    ], repositoryRoot);
  }
  assertCleanRevision(repositoryRoot, revision);
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "ascii");
  process.stdout.write(`${JSON.stringify({ descriptor: descriptorPath, ...descriptor })}\n`);
} catch (error) {
  if (outputOwned) rmSync(outputRoot, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
