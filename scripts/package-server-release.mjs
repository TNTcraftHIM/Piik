#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { writeServerLicenseNotices } from "./package-licenses.mjs";
import { createZip, extractZip, tarExecutable } from "./archive-tool.mjs";
import { assertBuildInputRetained, assertCleanRevision, resetBuildWorkspace } from "./build-workspace.mjs";
import { buildVersion } from "./release-version.mjs";
import { SERVER_PACKAGE_TARGETS } from "./server-package-targets.mjs";
import { sha256, fileRecords, compareFileRecords } from "./package-files.mjs";
import { buildChannelWeb } from "./build-channel-web.mjs";
import { webSourceAssets } from "./container-web-identity.mjs";

// A Windows build ships the same archive shape with an `.exe` binary, so the
// binary name, the manifest allowlist and the archive allowlist all follow the
// selected target instead of a single constant.
function serverBinaryName(target) {
  return target.goos === "windows" ? "piik-server.exe" : "piik-server";
}

// deploy/release-server.sh enforces the same executable, notices and web tree.
function runtimePaths(target) {
  return ["REVISION", "LICENSE", "THIRD-PARTY-NOTICES.txt", serverBinaryName(target)];
}
function runtimePathAllowed(path, paths) {
  return paths.includes(path) || path.startsWith("web/");
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function recordsFor(root, paths) {
  const records = fileRecords(root);
  for (const { path } of records) if (!runtimePathAllowed(path, paths)) fail('Unexpected packaged file: ' + path);
  return records;
}

function validateArchiveEntries(entries, paths) {
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
    if (entry !== "web" && !runtimePathAllowed(entry, paths)) fail(`Unexpected archive entry: ${rawEntry}`);
  }
}

// The deployment postflight proves the packaged frontend's entry over HTTP.
function mainAssetOf(distributionRoot) {
  const html = readFileSync(join(distributionRoot, "index.html"), "utf8");
  const main = webSourceAssets(html)[0].slice(1);
  if (!existsSync(join(distributionRoot, ...main.split("/")))) {
    fail("Built Web main asset is missing");
  }
  return main;
}

const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  arch: { type: "string", default: "amd64" },
  os: { type: "string", default: "linux" },
  "container-image": { type: "string" },
  web: { type: "string" },
} });
const target = SERVER_PACKAGE_TARGETS.find(
  candidate => candidate.goarch === values.arch && candidate.goos === values.os,
);
if (positionals.length !== 1 || !target) {
  fail("Usage: node scripts/package-server-release.mjs <new-output-directory> [--os linux|windows] [--arch amd64|arm64] [--container-image <tag>] [--web <built-web-directory>]");
}
const containerImage = values["container-image"];
if (containerImage && target.goos !== "linux") {
  fail("--container-image requires a linux target");
}
if (containerImage && !/^[a-z0-9][a-z0-9._/:+-]*$/.test(containerImage)) {
  fail("Container image tag is invalid");
}
const nativeOS = process.platform === "win32" ? "windows" : process.platform;
const nativeArch = process.arch === "x64" ? "amd64" : process.arch;
if (target.goos !== nativeOS || target.goarch !== nativeArch) {
  fail(`Build ${target.rustTarget} on its native platform and architecture.`);
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const outputRoot = resolve(process.cwd(), positionals[0]);
const relativeOutput = relative(repositoryRoot, outputRoot);
if (relativeOutput === "" || (relativeOutput.split(/[\\/]/)[0] !== ".." && !isAbsolute(relativeOutput))) {
  fail("Output directory must be outside the repository");
}
if (existsSync(outputRoot)) fail("Output directory must not already exist");

const revision = assertCleanRevision(repositoryRoot);
const version = buildVersion(repositoryRoot, revision);
const cargoTarget = resolve(process.env.CARGO_TARGET_DIR ?? join(repositoryRoot, "build", "rust-target"));

if (!existsSync(join(repositoryRoot, "LICENSE"))) fail("Missing release input: LICENSE");
if (values.web !== undefined) assertBuildInputRetained(values.web, join(repositoryRoot, "build", "server-package", "assembly"));
const web = buildChannelWeb(repositoryRoot, { version, revision, cargoTarget, web: values.web });
assertCleanRevision(repositoryRoot, revision);
const mainAsset = mainAssetOf(web);

const releaseId = revision.slice(0, 7);
const temporaryRoot = resetBuildWorkspace(repositoryRoot, "server-package", "assembly");
const runtimeRoot = join(temporaryRoot, "runtime");
const verifyRoot = join(temporaryRoot, "verify");
let outputOwned = false;

try {
  mkdirSync(runtimeRoot, { recursive: true });
  copyFileSync(join(repositoryRoot, "LICENSE"), join(runtimeRoot, "LICENSE"));
  const binaryName = serverBinaryName(target);
  const serverPath = join(runtimeRoot, binaryName);
  const buildEnv = { ...process.env, CARGO_TARGET_DIR: cargoTarget,
    PIIK_BUILD_VERSION: version, PIIK_BUILD_REVISION: revision };
  if (target.goos === "linux") {
    const key = target.rustTarget.replaceAll("-", "_");
    buildEnv[`CARGO_TARGET_${key.toUpperCase()}_LINKER`] ??= "musl-gcc";
    buildEnv[`CC_${key}`] ??= "musl-gcc";
  }
  run("cargo", ["+1.91.0", "build", "--locked", "--release", "--no-default-features",
    "--manifest-path", join(repositoryRoot, "prototype", "channel-server", "Cargo.toml"),
    "--target", target.rustTarget, "--bin", "piik-channel-prototype"], repositoryRoot,
  buildEnv);
  copyFileSync(join(cargoTarget, target.rustTarget, "release",
    target.goos === "windows" ? "piik-channel-prototype.exe" : "piik-channel-prototype"), serverPath);
  if (target.goos === "linux") {
    const elf = run("readelf", ["--program-headers", "--dynamic", serverPath], repositoryRoot);
    if (/^\s*INTERP\s/m.test(elf) || /\(NEEDED\)/.test(elf)) {
      fail("Linux Server must be statically linked with no PT_INTERP or DT_NEEDED; check flags that disable musl crt-static.");
    }
  }
  cpSync(web, join(runtimeRoot, "web"), { recursive: true });
  if (target.goos !== "windows") chmodSync(serverPath, 0o755);
  writeServerLicenseNotices(
    repositoryRoot,
    join(runtimeRoot, "THIRD-PARTY-NOTICES.txt"),
    target,
  );
  assertCleanRevision(repositoryRoot, revision);
  writeFileSync(join(runtimeRoot, "REVISION"), `${revision}\n`, "ascii");

  const paths = runtimePaths(target);
  const records = recordsFor(runtimeRoot, paths);
  const stem = `piik-${releaseId}${target.suffix}`;
  const manifestName = `${stem}.manifest.tsv`;
  const archiveKind = target.goos === "windows" ? "zip" : "tar.gz";
  const artifactName = `${stem}-runtime.${archiveKind}`;
  const descriptorName = `${stem}.release.json`;
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

  if (archiveKind === "zip") {
    createZip(runtimeRoot, artifactPath);
    mkdirSync(verifyRoot);
    extractZip(artifactPath, verifyRoot);
  } else {
    const tar = tarExecutable();
    run(tar, ["-czf", artifactPath, "-C", runtimeRoot, "."], repositoryRoot);
    validateArchiveEntries(run(tar, ["-tzf", artifactPath], repositoryRoot), paths);
    mkdirSync(verifyRoot);
    run(tar, ["-xzf", artifactPath, "-C", verifyRoot], repositoryRoot);
  }
  compareFileRecords(records, recordsFor(verifyRoot, paths));

  const descriptor = {
    schema: 2,
    version,
    revision,
    releaseId,
    target: target.id,
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
      "build", "--platform", `${target.goos}/${target.goarch}`,
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
