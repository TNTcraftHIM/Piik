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
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clientPackageTarget, CLOUDFLARED_VERSION } from "./client-package-targets.mjs";
import { writeClientPlatformAssets } from "./client-icons.mjs";
import { writeClientLicenseNotices } from "./package-licenses.mjs";

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

const positional = process.argv.slice(2, 5);
const options = process.argv.slice(5);
if (positional.length !== 3 || options.length % 2 !== 0) {
  fail(
    "Usage: node scripts/assemble-client.mjs <app-release.json> <node-executable> <new-output-directory> --target <windows-amd64|linux-amd64|darwin-arm64> [--capture <executable>] [--tunnel <executable>]",
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

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const descriptorPath = realpathSync(resolve(positional[0]));
const nodePath = realpathSync(resolve(positional[1]));
const outputRoot = resolve(process.cwd(), positional[2]);
const capturePath = captureArgument ? realpathSync(resolve(captureArgument)) : null;
const tunnelPath = tunnelArgument ? realpathSync(resolve(tunnelArgument)) : null;
assertOutsideRepository(repositoryRoot, outputRoot);
assertTargetExecutable(nodePath, target, "Node runtime");
const expectedNodeVersion = `v${readFileSync(
  join(repositoryRoot, ".node-version"),
  "ascii",
).trim()}`;
if (run(nodePath, ["--version"], repositoryRoot) !== expectedNodeVersion) {
  fail(`Node runtime must be ${expectedNodeVersion}`);
}
if (capturePath && !target.captureName) {
  fail("Capture runtime is invalid for the Client package target");
}
if (capturePath) assertTargetExecutable(capturePath, target, "Capture runtime");
if (tunnelPath) assertTargetExecutable(tunnelPath, target, "Public tunnel runtime");

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
  const nodeName = target.nodeName;
  const packagedNode = join(runtimeRoot, nodeName);
  copyFileSync(nodePath, packagedNode);
  chmodSync(packagedNode, 0o755);

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
  const goCommand = process.env.SCREENER_GO?.trim() || "go";
  run(goCommand, [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X github.com/TNTcraftHIM/Screener/native/client/internal/clientapp.BuildRevision=${revision}`,
    "-o",
    clientPath,
    "./cmd/screener-client",
  ], join(repositoryRoot, "native", "client"), {
    ...process.env,
    GOOS: target.goos,
    GOARCH: target.goarch,
    CGO_ENABLED: "0",
  });
  chmodSync(clientPath, 0o755);
  writeClientLicenseNotices(repositoryRoot, packageRoot, goCommand, target,
    packagedTunnel ? CLOUDFLARED_VERSION : null);
  const platformAssets = writeClientPlatformAssets({
    packageRoot,
    target,
    revision,
    iconPath: join(
      repositoryRoot,
      "native",
      "client",
      "cmd",
      "screener-client",
      "screener.ico",
    ),
  });
  writeFileSync(join(packageRoot, "REVISION"), `${revision}\n`, "ascii");

  cpSync(packageRoot, outputRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  process.stdout.write(`${JSON.stringify({
    root: outputRoot,
    revision,
    target: target.id,
    platform: target.goos,
    arch: target.goarch,
    client: clientName,
    node: `runtime/node/${nodeName}`,
    nativeCapture: packagedCapture ? `runtime/native/${target.captureName}` : null,
    publicTunnel: packagedTunnel
      ? `runtime/tunnel/${target.tunnelName}`
      : null,
    platformAssets,
    app: "app",
  })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
