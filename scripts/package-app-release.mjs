#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
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

function runtimePathAllowed(path) {
  return (
    path === "REVISION" ||
    path === "package.json" ||
    path === "package-lock.json" ||
    path.startsWith("dist/client/") ||
    path.startsWith("dist/server/")
  );
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

function copyRuntimeFile(sourceRoot, targetRoot, source) {
  const path = normalizedRelative(sourceRoot, source);
  if (!runtimePathAllowed(path)) fail(`Unexpected runtime file: ${path}`);
  const target = join(targetRoot, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function recordsFor(root) {
  return regularFiles(root).map((absolute) => {
    const path = normalizedRelative(root, absolute);
    if (!runtimePathAllowed(path)) fail(`Unexpected packaged file: ${path}`);
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
    if (
      entry !== "REVISION" &&
      entry !== "package.json" &&
      entry !== "package-lock.json" &&
      entry !== "dist" &&
      !entry.startsWith("dist/client") &&
      !entry.startsWith("dist/server")
    ) {
      fail(`Unexpected archive entry: ${rawEntry}`);
    }
  }
}

if (process.argv.length !== 3) {
  fail("Usage: node scripts/package-app-release.mjs <new-output-directory>");
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const outputRoot = resolve(process.cwd(), process.argv[2]);
const relativeOutput = relative(repositoryRoot, outputRoot);
if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput))) {
  fail("Output directory must be outside the repository");
}
if (existsSync(outputRoot)) fail("Output directory must not already exist");

const revision = run("git", ["rev-parse", "HEAD"], repositoryRoot).toLowerCase();
if (!/^[0-9a-f]{40}$/.test(revision)) fail("Git did not return a full revision");
if (run("git", ["status", "--porcelain"], repositoryRoot) !== "") {
  fail("Application releases require a clean Git checkout");
}

for (const required of ["package.json", "package-lock.json", "dist/client", "dist/server"]) {
  if (!existsSync(join(repositoryRoot, required))) fail(`Missing built runtime path: ${required}`);
}

const releaseId = revision.slice(0, 7);
const temporaryRoot = mkdtempSync(join(tmpdir(), `screener-app-${releaseId}-`));
const runtimeRoot = join(temporaryRoot, "runtime");
const verifyRoot = join(temporaryRoot, "verify");

try {
  mkdirSync(runtimeRoot, { recursive: true });
  for (const source of [
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "package-lock.json"),
    ...regularFiles(join(repositoryRoot, "dist")),
  ]) {
    copyRuntimeFile(repositoryRoot, runtimeRoot, source);
  }
  writeFileSync(join(runtimeRoot, "REVISION"), `${revision}\n`, "ascii");

  const records = recordsFor(runtimeRoot);
  const manifestName = `screener-${releaseId}.manifest.tsv`;
  const artifactName = `screener-${releaseId}-runtime.tar.gz`;
  const descriptorName = `screener-${releaseId}.release.json`;
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const manifestPath = join(outputRoot, manifestName);
  const artifactPath = join(outputRoot, artifactName);
  const descriptorPath = join(outputRoot, descriptorName);
  writeFileSync(
    manifestPath,
    records.map((record) => `${record.sha256}\t${record.size}\t${record.path}\n`).join(""),
    "ascii",
  );

  run("tar", ["-czf", artifactPath, "-C", runtimeRoot, "."], repositoryRoot);
  validateArchiveEntries(run("tar", ["-tzf", artifactPath], repositoryRoot));
  mkdirSync(verifyRoot);
  run("tar", ["-xzf", artifactPath, "-C", verifyRoot], repositoryRoot);
  compareRecords(records, recordsFor(verifyRoot));

  const html = readFileSync(join(runtimeRoot, "dist/client/index.html"), "utf8");
  const mainAssetMatch = html.match(/<script[^>]+src="\/(assets\/index-[A-Za-z0-9_-]+\.js)"/);
  if (!mainAssetMatch) fail("Built client HTML has no unique main asset");
  const mainAsset = mainAssetMatch[1];
  if (!existsSync(join(runtimeRoot, "dist/client", ...mainAsset.split("/")))) {
    fail("Built client main asset is missing");
  }

  const descriptor = {
    schema: 1,
    revision,
    releaseId,
    artifact: artifactName,
    artifactSha256: sha256(artifactPath),
    manifest: manifestName,
    manifestSha256: sha256(manifestPath),
    fileCount: records.length,
    mainAsset,
  };
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "ascii");
  process.stdout.write(`${JSON.stringify({ descriptor: descriptorPath, ...descriptor })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
