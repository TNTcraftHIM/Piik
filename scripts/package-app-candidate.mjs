#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { appPackageTarget, CLOUDFLARED_VERSION } from "./app-package-targets.mjs";
import { createZip, extractZip, tarExecutable } from "./archive-tool.mjs";
import { assertBuildInputRetained, assertCleanRevision, resetBuildWorkspace } from "./build-workspace.mjs";
import { buildVersion } from "./release-version.mjs";
import { checkAppPackageStatic, checkAppPackageRuntime } from "./check-app-package.mjs";
import { sha256 } from "./package-files.mjs";

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${basename(command)} failed: ${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

function assertOutsideRepository(repositoryRoot, outputRoot) {
  const path = relative(repositoryRoot, outputRoot);
  if (path === "" || (path.split(/[\\/]/)[0] !== ".." && !isAbsolute(path))) {
    fail("App candidate output must be outside the repository");
  }
  if (existsSync(outputRoot)) {
    fail("App candidate output directory must not already exist");
  }
}

async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    fail(`Public-link runtime download failed with HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: { "tunnel-asset": { type: "string" }, web: { type: "string" } },
});
if (positionals.length !== 2) {
  fail(
    "Usage: node scripts/package-app-candidate.mjs <target> <new-output-directory> [--tunnel-asset <raw-release-asset>] [--web <built-web-directory>]",
  );
}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const target = appPackageTarget(positionals[0]);
const outputRoot = resolve(process.cwd(), positionals[1]);
if (!target) fail("App package target is invalid");
if (process.platform !== target.nodePlatform || process.arch !== target.nodeArch) {
  fail(`App candidate ${target.id} requires its native runner`);
}
assertOutsideRepository(repositoryRoot, outputRoot);

const revision = assertCleanRevision(repositoryRoot);
const version = buildVersion(repositoryRoot, revision);
if (values.web !== undefined) assertBuildInputRetained(values.web, join(repositoryRoot, "build", "app-package", target.id, "candidate"));
const temporaryRoot = resetBuildWorkspace(repositoryRoot, "app-package", target.id, "candidate");
let outputOwned = false;
try {
  const tunnelDownload = join(temporaryRoot, target.tunnelAsset);
  if (values["tunnel-asset"] !== undefined) {
    copyFileSync(realpathSync(resolve(values["tunnel-asset"])), tunnelDownload);
  } else {
    await download(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${target.tunnelAsset}`,
      tunnelDownload,
    );
  }
  if (sha256(tunnelDownload) !== target.tunnelSha256) {
    fail("Public-link runtime digest does not match the pinned release");
  }

  let tunnel = tunnelDownload;
  if (target.tunnelArchive) {
    run(tarExecutable(), ["-xzf", tunnelDownload, "-C", temporaryRoot], repositoryRoot);
    tunnel = join(temporaryRoot, target.tunnelName);
  }
  if (!existsSync(tunnel)) fail("Public-link runtime is missing");
  if (process.platform !== "win32") chmodSync(tunnel, 0o755);

  const packageRoot = join(temporaryRoot, `piik-app-${target.id}`);
  const assembleArguments = [
    join(repositoryRoot, "scripts", "assemble-app.mjs"),
    packageRoot,
    "--target",
    target.id,
    "--tunnel",
    tunnel,
    ...(values.web !== undefined ? ["--web", resolve(values.web)] : []),
  ];
  run(process.execPath, assembleArguments, repositoryRoot);

  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  outputOwned = true;
  const archiveName = `piik-app-${target.id}.zip`;
  const archive = join(outputRoot, archiveName);
  createZip(packageRoot, archive);
  const extractedRoot = join(temporaryRoot, "extracted");
  mkdirSync(extractedRoot);
  extractZip(archive, extractedRoot);
  await checkAppPackageStatic(extractedRoot, target, revision);
  await checkAppPackageRuntime(extractedRoot, target, version, revision, temporaryRoot, repositoryRoot);
  assertCleanRevision(repositoryRoot, revision);
  const digest = sha256(archive);
  writeFileSync(join(outputRoot, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`, "ascii");
  writeFileSync(join(outputRoot, archiveName.replace(/\.zip$/, ".release.json")),
    `${JSON.stringify({ schema: 2, version, revision, target: target.id,
      artifact: archiveName, artifactSha256: digest }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    target: target.id,
    version,
    revision,
    archive,
    sha256: digest,
  })}\n`);
} catch (error) {
  if (outputOwned) rmSync(outputRoot, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
