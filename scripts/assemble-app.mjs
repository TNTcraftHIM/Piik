#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appPackageTarget, appPackageDirectory, CLOUDFLARED_VERSION } from "./app-package-targets.mjs";
import { writeAppPlatformAssets } from "./app-icons.mjs";
import { writeAppLicenseNotices } from "./package-licenses.mjs";
import { buildChannelWeb } from "./build-channel-web.mjs";
import { assertCleanRevision, resetBuildWorkspace } from "./build-workspace.mjs";
import { buildVersion } from "./release-version.mjs";

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
    fail(`${command} failed: ${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`);
  }
  return result.stdout.trim();
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
    ) && header[4] === 2 && header[5] === 1 &&
      header.readUInt16LE(18) === (target.goarch === "arm64" ? 0xb7 : 0x3e);
  }
  return header.length >= 8 && header.subarray(0, 4).equals(
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  ) && header.readUInt32LE(4) === (target.goarch === "amd64" ? 0x01000007 : 0x0100000c);
}

function assertTargetExecutable(path, target, label) {
  if (!lstatSync(path).isFile() || !executableMatchesTarget(path, target)) {
    fail(`${label} does not match App package target ${target.id}`);
  }
}

function assertOutputDirectory(repositoryRoot, outputRoot, target) {
  const path = relative(repositoryRoot, outputRoot);
  const candidateOutput = join(repositoryRoot, "build", "app-package", target.id,
    "candidate", `piik-app-${target.id}`);
  if (outputRoot !== candidateOutput &&
      (path === "" || (path.split(/[\\/]/)[0] !== ".." && !isAbsolute(path)))) {
    fail("App output must be outside the repository or its exact candidate workspace");
  }
  if (outputRoot === candidateOutput) {
    for (let parent = dirname(outputRoot); parent !== repositoryRoot; parent = dirname(parent)) {
      const metadata = lstatSync(parent, { throwIfNoEntry: false });
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() ||
          realpathSync(parent) !== parent)) fail("App candidate output must not contain links");
    }
  }
  if (existsSync(outputRoot)) {
    fail("App output directory must not already exist");
  }
}

const outputArgument = process.argv[2];
const options = process.argv.slice(3);
if (!outputArgument || outputArgument.startsWith("--") || options.length % 2 !== 0) {
  fail(
    "Usage: node scripts/assemble-app.mjs <new-output-directory> --target <target> [--tunnel <executable>]",
  );
}

let targetArgument = null;
let tunnelArgument = null;
for (let index = 0; index < options.length; index += 2) {
  const name = options[index];
  const value = options[index + 1];
  if (
    !value ||
    (name !== "--target" && name !== "--tunnel")
  ) {
    fail("App package option is invalid");
  }
  if (name === "--target" && targetArgument === null) {
    targetArgument = value;
  } else if (name === "--tunnel" && tunnelArgument === null) {
    tunnelArgument = value;
  } else {
    fail("App package option is duplicated");
  }
}
const target = appPackageTarget(targetArgument);
if (!target) fail("App package target is invalid");
if (process.platform !== target.nodePlatform || process.arch !== target.nodeArch) {
  fail(`App target ${target.id} requires its native runner`);
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const outputRoot = resolve(process.cwd(), outputArgument);
const tunnelPath = tunnelArgument ? realpathSync(resolve(tunnelArgument)) : null;
assertOutputDirectory(repositoryRoot, outputRoot, target);
if (tunnelPath) assertTargetExecutable(tunnelPath, target, "Public tunnel runtime");

const revision = assertCleanRevision(repositoryRoot);
const version = buildVersion(repositoryRoot, revision);

const temporaryRoot = resetBuildWorkspace(repositoryRoot, "app-package", target.id, "assembly");
const packageRoot = join(temporaryRoot, "package");
const runtimeRoot = join(packageRoot, appPackageDirectory(target));
let outputOwned = false;
try {
  const web = buildChannelWeb(repositoryRoot, { version, revision });
  mkdirSync(runtimeRoot, { recursive: true });
  cpSync(web, join(runtimeRoot, "web"), {
    recursive: true,
  });

  let packagedTunnel = null;
  if (tunnelPath) {
    const tunnelRoot = join(runtimeRoot, "runtime", "tunnel");
    mkdirSync(tunnelRoot, { recursive: true });
    const tunnelName = target.tunnelName;
    packagedTunnel = join(tunnelRoot, tunnelName);
    copyFileSync(tunnelPath, packagedTunnel);
    chmodSync(packagedTunnel, 0o755);
  }

  const appName = target.appName;
  const appPath = join(runtimeRoot, appName);
  const cargoTarget = resolve(repositoryRoot, process.env.CARGO_TARGET_DIR || "prototype/channel-server/target");
  run("cargo", ["+1.91.0", "build", "--locked", "--release",
    "--manifest-path", "prototype/channel-server/Cargo.toml", "--target-dir", cargoTarget,
    "--target", target.rustTarget, "--features", "capture", "--bin", "piik-channel-app"],
  repositoryRoot, { ...process.env, PIIK_BUILD_VERSION: version, PIIK_BUILD_REVISION: revision, PIIK_BUILD_TARGET: target.id });
  copyFileSync(join(cargoTarget, target.rustTarget, "release",
    `piik-channel-app${target.goos === "windows" ? ".exe" : ""}`), appPath);
  chmodSync(appPath, 0o755);
  assertTargetExecutable(appPath, target, "App executable");
  writeAppLicenseNotices(repositoryRoot, runtimeRoot, target,
    packagedTunnel ? CLOUDFLARED_VERSION : null);
  const platformAssets = writeAppPlatformAssets({
    packageRoot,
    target,
    version,
    revision,
    iconPath: join(repositoryRoot, "cmd", "piik-app", "piik.ico"),
  });
  writeFileSync(join(runtimeRoot, "REVISION"), `${revision}\n`, "ascii");

  assertCleanRevision(repositoryRoot, revision);
  mkdirSync(dirname(outputRoot), { recursive: true });
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  outputOwned = true;
  for (const entry of readdirSync(packageRoot)) {
    cpSync(join(packageRoot, entry), join(outputRoot, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  process.stdout.write(`${JSON.stringify({
    root: outputRoot,
    version,
    revision,
    target: target.id,
    platform: target.goos,
    arch: target.goarch,
    app: relative(packageRoot, appPath).replaceAll("\\", "/"),
    publicTunnel: packagedTunnel ? relative(packageRoot, packagedTunnel).replaceAll("\\", "/") : null,
    platformAssets,
  })}\n`);
} catch (error) {
  if (outputOwned) rmSync(outputRoot, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
