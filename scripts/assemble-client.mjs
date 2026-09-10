#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clientPackageTarget, clientGoEnvironment, CLOUDFLARED_VERSION } from "./client-package-targets.mjs";
import { writeClientPlatformAssets } from "./client-icons.mjs";
import { writeClientLicenseNotices } from "./package-licenses.mjs";
import { tarExecutable } from "./archive-tool.mjs";
import { resetBuildWorkspace } from "./build-workspace.mjs";
import { isReleaseVersion } from "./release-version.mjs";

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

function bytesAt(path, length, position = 0) {
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    return bytes.subarray(0, readSync(descriptor, bytes, 0, length, position));
  } finally {
    closeSync(descriptor);
  }
}

function executableMatchesTarget(path, target) {
  const header = bytesAt(path, 64);
  if (target.goos === "windows") {
    if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a) {
      return false;
    }
    const pe = bytesAt(path, 6, header.readUInt32LE(0x3c));
    return pe.length === 6 && pe.subarray(0, 4).equals(Buffer.from("PE\0\0")) &&
      pe.readUInt16LE(4) === 0x8664;
  }
  if (target.goos === "linux") {
    return header.length >= 20 && header.subarray(0, 4).equals(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    ) && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 0x3e;
  }
  return header.length >= 8 && header.subarray(0, 4).equals(
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  ) && header.readUInt32LE(4) === 0x0100000c;
}

function assertTargetExecutable(path, target, label) {
  if (!lstatSync(path).isFile() || !executableMatchesTarget(path, target)) {
    fail(`${label} does not match Client package target ${target.id}`);
  }
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
    value?.schema !== 2 ||
    (value.version !== "development" && !isReleaseVersion(value.version)) ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.revision) ||
    typeof value.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256)
  ) {
    fail("Application release descriptor is invalid");
  }
  return {
    version: value.version,
    revision: value.revision,
    artifact: plainName(value.artifact, "artifact"),
    artifactSha256: value.artifactSha256,
  };
}

function assertOutputDirectory(repositoryRoot, outputRoot, target) {
  const path = relative(repositoryRoot, outputRoot);
  const candidateOutput = join(repositoryRoot, "build", "client-package", target.id,
    "candidate", `piik-app-${target.id}`);
  if (outputRoot !== candidateOutput &&
      (path === "" || (path.split(/[\\/]/)[0] !== ".." && !isAbsolute(path)))) {
    fail("Client output must be outside the repository or its exact candidate workspace");
  }
  if (outputRoot === candidateOutput) {
    for (let parent = dirname(outputRoot); parent !== repositoryRoot; parent = dirname(parent)) {
      const metadata = lstatSync(parent, { throwIfNoEntry: false });
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() ||
          realpathSync(parent) !== parent)) fail("Client candidate output must not contain links");
    }
  }
  if (existsSync(outputRoot)) {
    fail("Client output directory must not already exist");
  }
}

const positional = process.argv.slice(2, 4);
const options = process.argv.slice(4);
if (positional.length !== 2 || options.length % 2 !== 0) {
  fail(
    "Usage: node scripts/assemble-client.mjs <app-release.json> <new-output-directory> --target <windows-amd64|linux-amd64|darwin-arm64> [--capture <executable>] [--tunnel <executable>]",
  );
}

let targetArgument = null;
let captureArgument = null;
let tunnelArgument = null;
for (let index = 0; index < options.length; index += 2) {
  const name = options[index];
  const value = options[index + 1];
  if (
    !value ||
    (name !== "--target" && name !== "--capture" && name !== "--tunnel")
  ) {
    fail("Client package option is invalid");
  }
  if (name === "--target" && targetArgument === null) {
    targetArgument = value;
  } else if (name === "--capture" && captureArgument === null) {
    captureArgument = value;
  } else if (name === "--tunnel" && tunnelArgument === null) {
    tunnelArgument = value;
  } else {
    fail("Client package option is duplicated");
  }
}
const target = clientPackageTarget(targetArgument);
if (!target) fail("Client package target is invalid");
if (target.cgo && process.platform !== target.nodePlatform) {
  fail(`Client target ${target.id} requires a native macOS runner with its SDK and cgo`);
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const descriptorPath = realpathSync(resolve(positional[0]));
const outputRoot = resolve(process.cwd(), positional[1]);
const capturePath = captureArgument ? realpathSync(resolve(captureArgument)) : null;
const tunnelPath = tunnelArgument ? realpathSync(resolve(tunnelArgument)) : null;
assertOutputDirectory(repositoryRoot, outputRoot, target);
if (capturePath && !target.captureName) {
  fail("Capture runtime is invalid for the Client package target");
}
if (capturePath) assertTargetExecutable(capturePath, target, "Capture runtime");
if (tunnelPath) assertTargetExecutable(tunnelPath, target, "Public tunnel runtime");

const descriptor = readDescriptor(descriptorPath);
const version = descriptor.version;
process.env.VITE_PIIK_VERSION = version;
process.env.VITE_PIIK_REVISION = descriptor.revision;
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

const temporaryRoot = resetBuildWorkspace(repositoryRoot, "client-package", target.id, "assembly");
const packageRoot = join(temporaryRoot, "package");
const releaseRoot = join(temporaryRoot, "release");
try {
  // The application release is consumed for its provenance only: the Client
  // embeds the Web assets, so the revision, clean-tree and digest assertions
  // above plus this REVISION check tie the binary to that immutable release.
  mkdirSync(releaseRoot, { recursive: true });
  run(tarExecutable(), ["-xzf", artifactPath, "-C", releaseRoot], repositoryRoot);
  if (readFileSync(join(releaseRoot, "REVISION"), "ascii") !== `${revision}\n`) {
    fail("Extracted application revision does not match the Client");
  }
  // Build the Web assets the Go binary embeds. The checkout is clean and at the
  // release revision, so this reproduces that release's client.
  runNpm(["run", "build:client"], repositoryRoot);
  mkdirSync(packageRoot, { recursive: true });

  let packagedCapture = null;
  if (capturePath) {
    const nativeRoot = join(packageRoot, "runtime", "native");
    mkdirSync(nativeRoot, { recursive: true });
    packagedCapture = join(nativeRoot, target.captureName);
    copyFileSync(capturePath, packagedCapture);
    chmodSync(packagedCapture, 0o755);
  }

  let packagedTunnel = null;
  if (tunnelPath) {
    const tunnelRoot = join(packageRoot, "runtime", "tunnel");
    mkdirSync(tunnelRoot, { recursive: true });
    const tunnelName = target.tunnelName;
    packagedTunnel = join(tunnelRoot, tunnelName);
    copyFileSync(tunnelPath, packagedTunnel);
    chmodSync(packagedTunnel, 0o755);
  }

  const clientName = target.clientName;
  const clientPath = join(packageRoot, clientName);
  const goCommand = process.env.PIIK_GO?.trim() || "go";
  run(goCommand, [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X github.com/TNTcraftHIM/Piik/internal/app.BuildRevision=${revision} -X github.com/TNTcraftHIM/Piik/internal/app.BuildVersion=${version}`,
    "-o",
    clientPath,
    "./cmd/piik-app",
  ], repositoryRoot, clientGoEnvironment(target));
  chmodSync(clientPath, 0o755);
  assertTargetExecutable(clientPath, target, "Client executable");
  writeClientLicenseNotices(repositoryRoot, packageRoot, goCommand, target,
    packagedTunnel ? CLOUDFLARED_VERSION : null);
  const platformAssets = writeClientPlatformAssets({
    packageRoot,
    target,
    version,
    revision,
    iconPath: join(repositoryRoot, "cmd", "piik-app", "piik.ico"),
  });
  writeFileSync(join(packageRoot, "REVISION"), `${revision}\n`, "ascii");

  cpSync(packageRoot, outputRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  process.stdout.write(`${JSON.stringify({
    root: outputRoot,
    version,
    revision,
    target: target.id,
    platform: target.goos,
    arch: target.goarch,
    client: clientName,
    nativeCapture: packagedCapture ? `runtime/native/${target.captureName}` : null,
    publicTunnel: packagedTunnel
      ? `runtime/tunnel/${target.tunnelName}`
      : null,
    platformAssets,
  })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
