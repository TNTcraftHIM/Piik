#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function runNpm(args, cwd) {
  if (process.platform === "win32") {
    run(process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", `npm ${args.join(" ")}`,
    ], cwd);
    return;
  }
  run("npm", args, cwd);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function plainName(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    fail(`Release ${label} is invalid`);
  }
  return value;
}

function readDescriptor(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Application release descriptor is invalid");
  }
  if (
    value?.schema !== 1 ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.revision) ||
    typeof value.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256)
  ) {
    fail("Application release descriptor is invalid");
  }
  return {
    revision: value.revision,
    artifact: plainName(value.artifact, "artifact"),
    artifactSha256: value.artifactSha256,
  };
}

function assertOutsideRepository(repositoryRoot, outputRoot) {
  const path = relative(repositoryRoot, outputRoot);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
    fail("Client output directory must be outside the repository");
  }
  if (existsSync(outputRoot)) {
    fail("Client output directory must not already exist");
  }
}

if (process.argv.length !== 5 && process.argv.length !== 6) {
  fail(
    "Usage: node scripts/assemble-client.mjs <app-release.json> <node-executable> <new-output-directory> [windows-capture-executable]",
  );
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const descriptorPath = realpathSync(resolve(process.argv[2]));
const nodePath = realpathSync(resolve(process.argv[3]));
const outputRoot = resolve(process.cwd(), process.argv[4]);
const capturePath = process.argv[5] ? realpathSync(resolve(process.argv[5])) : null;
assertOutsideRepository(repositoryRoot, outputRoot);
if (!lstatSync(nodePath).isFile()) fail("Node runtime must be a regular file");
if (capturePath && (process.platform !== "win32" || !lstatSync(capturePath).isFile())) {
  fail("Windows capture runtime must be a regular file on Windows");
}

const descriptor = readDescriptor(descriptorPath);
const revision = run("git", ["rev-parse", "HEAD"], repositoryRoot).toLowerCase();
if (revision !== descriptor.revision) {
  fail("Client source and application release revisions do not match");
}
if (run("git", ["status", "--porcelain"], repositoryRoot) !== "") {
  fail("Client assembly requires a clean Git checkout");
}
const artifactPath = join(dirname(descriptorPath), descriptor.artifact);
if (!existsSync(artifactPath) || sha256(artifactPath) !== descriptor.artifactSha256) {
  fail("Application release artifact does not match its descriptor");
}

const temporaryRoot = mkdtempSync(join(tmpdir(), `screener-client-${revision.slice(0, 7)}-`));
const packageRoot = join(temporaryRoot, "package");
const appRoot = join(packageRoot, "app");
try {
  mkdirSync(appRoot, { recursive: true });
  run("tar", ["-xzf", artifactPath, "-C", appRoot], repositoryRoot);
  if (readFileSync(join(appRoot, "REVISION"), "ascii") !== `${revision}\n`) {
    fail("Extracted application revision does not match the Client");
  }
  runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], appRoot);

  const runtimeRoot = join(packageRoot, "runtime", "node");
  mkdirSync(runtimeRoot, { recursive: true });
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const packagedNode = join(runtimeRoot, nodeName);
  copyFileSync(nodePath, packagedNode);
  chmodSync(packagedNode, 0o755);

  let packagedCapture = null;
  if (capturePath) {
    const nativeRoot = join(packageRoot, "runtime", "native");
    mkdirSync(nativeRoot, { recursive: true });
    packagedCapture = join(nativeRoot, "screener-client-capture.exe");
    copyFileSync(capturePath, packagedCapture);
    chmodSync(packagedCapture, 0o755);
  }

  const clientName = process.platform === "win32" ? "screener-client.exe" : "screener-client";
  const clientPath = join(packageRoot, clientName);
  const goCommand = process.env.SCREENER_GO?.trim() || "go";
  run(goCommand, [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X github.com/TNTcraftHIM/Screener/native/client/internal/clientapp.BuildRevision=${revision}`,
    "-o",
    clientPath,
    "./cmd/screener-client",
  ], join(repositoryRoot, "native", "client"));
  chmodSync(clientPath, 0o755);
  writeFileSync(join(packageRoot, "REVISION"), `${revision}\n`, "ascii");

  cpSync(packageRoot, outputRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  process.stdout.write(`${JSON.stringify({
    root: outputRoot,
    revision,
    platform: process.platform,
    arch: process.arch,
    client: clientName,
    node: `runtime/node/${nodeName}`,
    nativeCapture: packagedCapture ? "runtime/native/screener-client-capture.exe" : null,
    app: "app",
  })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
