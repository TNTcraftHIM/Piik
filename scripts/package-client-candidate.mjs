#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { clientPackageTarget } from "./client-package-targets.mjs";

const cloudflaredVersion = "2026.8.3";

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
    fail(`${basename(command)} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertOutsideRepository(repositoryRoot, outputRoot) {
  const path = relative(repositoryRoot, outputRoot);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
    fail("Client candidate output must be outside the repository");
  }
  if (existsSync(outputRoot)) {
    fail("Client candidate output directory must not already exist");
  }
}

function applicationDescriptor(directory) {
  const descriptors = readdirSync(directory)
    .filter((name) => name.endsWith(".release.json"));
  if (descriptors.length !== 1) {
    fail("Application release directory must contain one descriptor");
  }
  return join(directory, descriptors[0]);
}

async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    fail(`Public-link runtime download failed with HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

function verifyPackage(root, target, revision) {
  const packagedRevision = readFileSync(join(root, "REVISION"), "ascii").trim();
  if (packagedRevision !== revision) fail("Client package revision mismatch");

  const node = join(root, "runtime", "node", target.nodeName);
  const client = join(root, target.clientName);
  const tunnel = join(root, "runtime", "tunnel", target.tunnelName);
  run(node, ["--version"], root);
  run(client, ["--help"], root);
  run(tunnel, ["--version"], root);

  if (target.captureName) {
    const capture = join(root, "runtime", "native", target.captureName);
    const probe = JSON.parse(run(capture, ["--probe"], root));
    if (probe?.protocol !== 1) fail("Packaged native capture probe is invalid");
  }
}

if (process.argv.length !== 5) {
  fail(
    "Usage: node scripts/package-client-candidate.mjs <app-release-directory> <target> <new-output-directory>",
  );
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const applicationRoot = realpathSync(resolve(process.argv[2]));
const target = clientPackageTarget(process.argv[3]);
const outputRoot = resolve(process.cwd(), process.argv[4]);
if (!target) fail("Client package target is invalid");
if (process.platform !== target.nodePlatform || process.arch !== target.nodeArch) {
  fail(`Client candidate ${target.id} requires its native runner`);
}
assertOutsideRepository(repositoryRoot, outputRoot);

const revision = run("git", ["rev-parse", "HEAD"], repositoryRoot).toLowerCase();
const temporaryRoot = mkdtempSync(join(tmpdir(), `screener-client-release-${target.id}-`));
try {
  const tunnelDownload = join(temporaryRoot, target.tunnelAsset);
  await download(
    `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/${target.tunnelAsset}`,
    tunnelDownload,
  );
  if (sha256(tunnelDownload) !== target.tunnelSha256) {
    fail("Public-link runtime digest does not match the pinned release");
  }

  let tunnel = tunnelDownload;
  if (target.tunnelArchive) {
    run("tar", ["-xzf", tunnelDownload, "-C", temporaryRoot], repositoryRoot);
    tunnel = join(temporaryRoot, target.tunnelName);
  }
  if (!existsSync(tunnel)) fail("Public-link runtime is missing");
  if (process.platform !== "win32") chmodSync(tunnel, 0o755);

  let capture = null;
  if (target.captureName) {
    run(
      process.execPath,
      [join(repositoryRoot, "scripts", "check-client.mjs"), "--capture-only"],
      repositoryRoot,
    );
    capture = join(repositoryRoot, "build", "client-check", target.captureName);
  }

  const packageRoot = join(temporaryRoot, `Screener-Client-${target.id}`);
  const assembleArguments = [
    join(repositoryRoot, "scripts", "assemble-client.mjs"),
    applicationDescriptor(applicationRoot),
    process.execPath,
    packageRoot,
    "--target",
    target.id,
    "--tunnel",
    tunnel,
  ];
  if (capture) assembleArguments.push("--capture", capture);
  run(process.execPath, assembleArguments, repositoryRoot);
  verifyPackage(packageRoot, target, revision);

  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const shortRevision = revision.slice(0, 7);
  const archiveName = `Screener-Client-${target.id}-${shortRevision}.tar.gz`;
  const archive = join(outputRoot, archiveName);
  run("tar", ["-czf", archive, "-C", packageRoot, "."], repositoryRoot);
  const digest = sha256(archive);
  writeFileSync(join(outputRoot, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`, "ascii");
  process.stdout.write(`${JSON.stringify({
    target: target.id,
    revision,
    archive,
    sha256: digest,
  })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
