#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { appPackageTarget, appPackageDirectory, CLOUDFLARED_VERSION } from "./app-package-targets.mjs";
import { createZip, extractZip, tarExecutable } from "./archive-tool.mjs";
import { assertCleanRevision, resetBuildWorkspace } from "./build-workspace.mjs";
import { buildVersion } from "./release-version.mjs";
import { spawnProcess, requestShutdown } from "./process-shutdown.mjs";
import { checkWebSourceIdentity } from "./container-web-identity.mjs";

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${basename(command)} failed: ${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function reservePort() {
  const server = createServer();
  return await new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("App smoke port reservation failed"));
        return;
      }
      server.close((error) =>
        error ? rejectPort(error) : resolvePort(address.port),
      );
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      rejectExit(new Error("Packaged App did not stop"));
    }, timeoutMs);
    const onExit = (code) => {
      clearTimeout(timer);
      resolveExit(code);
    };
    child.once("exit", onExit);
  });
}

async function stopSmokeChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await requestShutdown(child);
    await waitForExit(child, 5_000);
    return;
  } catch {}
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
  try {
    await waitForExit(child, 3_000);
    return;
  } catch {}
  child.kill("SIGKILL");
  await waitForExit(child, 5_000).catch(() => undefined);
}

async function verifyLocalPackage(root, target, version, revision, temporaryRoot) {
  const app = join(root, target.appName);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const discoveryURL = `${origin}/connect-discovery`;
  const child = await spawnProcess(app, [], {
    cwd: temporaryRoot,
    env: { ...process.env,
      PIIK_CHANNEL_APP_DATA_DIR: join(temporaryRoot, "smoke-app-data"),
      PIIK_CHANNEL_APP_PORT: String(port),
      PIIK_CHANNEL_APP_NO_BROWSER: "1",
      PIIK_CHANNEL_APP_WEB_DIR: undefined,
      PIIK_CHANNEL_CLOUDFLARED: undefined,
      PIIK_CHANNEL_ICE_SERVERS: "[]",
    },
    logDirectory: temporaryRoot,
  });
  let spawnFailure = null;
  let stderr = "";
  child.once("error", (error) => {
    spawnFailure = error;
  });
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
  });
  try {
    const deadline = Date.now() + 15_000;
    let appReady = false;
    while (Date.now() < deadline) {
      if (spawnFailure) break;
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(discoveryURL, {
          headers: { Connection: "close" },
          signal: AbortSignal.timeout(500),
        });
        const discovery = response.ok ? await response.json() : null;
        appReady = discovery?.port === port && discovery?.connectURL === `${origin}/client`;
      } catch {}
      if (appReady) break;
      await delay(100);
    }
    if (!appReady) {
      fail(`Packaged App discovery did not become ready${spawnFailure ? `: ${spawnFailure.message}` : ""}`);
    }
    const request = async (path) => {
      const response = await fetch(new URL(path, `${origin}/`), {
        headers: { Connection: "close" }, signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) fail(`Packaged App returned HTTP ${response.status} for ${path}`);
      return response;
    };
    const identity = await (await request("/api/client-launcher")).json();
    if (identity.version !== version || identity.revision !== revision)
      fail("Packaged App build identity mismatch");
    const html = await (await request("/client")).text();
    await checkWebSourceIdentity(html, revision, async asset => (await request(asset)).text());
    const wasm = readdirSync(join(root, "web", "assets")).find(name => name.endsWith(".wasm"));
    if (!wasm) fail("Packaged App frontend has no Rust/WASM adapter");
    const wasmBytes = new Uint8Array(await (await request(`/assets/${wasm}`)).arrayBuffer());
    if (!Buffer.from(wasmBytes.subarray(0, 4)).equals(Buffer.from([0, 0x61, 0x73, 0x6d])))
      fail("Packaged App frontend did not serve WebAssembly");
    if (!(await (await request("/third-party-licenses.txt")).text()).trim()) {
      fail("Packaged App did not serve its Web third-party notices");
    }
    await requestShutdown(child);
    const exitCode = await waitForExit(child, 10_000);
    if (exitCode !== 0) {
      const detail = stderr
        .trim()
        .replace(/https?:\/\/\S+/g, "<url>")
        .replace(/\s+/g, " ")
        .slice(-1_000);
      fail(
        `Packaged App did not stop cleanly (${exitCode ?? child.signalCode ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      );
    }
    const closeDeadline = Date.now() + 5_000;
    while (Date.now() < closeDeadline) {
      try {
        await fetch(discoveryURL, {
          headers: { Connection: "close" },
          signal: AbortSignal.timeout(300),
        });
      } catch {
        return;
      }
      await delay(100);
    }
    fail("Packaged App left its loopback server listening");
  } finally {
    await stopSmokeChild(child);
  }
}

async function verifyPackage(root, target, version, revision, temporaryRoot) {
  const runtimeRoot = join(root, appPackageDirectory(target));
  const packagedRevision = readFileSync(join(runtimeRoot, "REVISION"), "ascii").trim();
  if (packagedRevision !== revision) fail("App package revision mismatch");
  for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.txt",
    "runtime/tunnel/THIRD-PARTY-NOTICES.txt"]) {
    if (!existsSync(join(runtimeRoot, file)) || readFileSync(join(runtimeRoot, file)).length === 0) {
      fail(`App package license text is missing: ${file}`);
    }
  }

  const tunnel = join(runtimeRoot, "runtime", "tunnel", target.tunnelName);
  run(tunnel, ["--version"], root);
  verifyPlatformAssets(root, target);

  await verifyLocalPackage(runtimeRoot, target, version, revision, temporaryRoot);
}

function verifyPlatformAssets(root, target) {
  if (target.goos === "linux") {
    const desktop = join(root, "share", "applications", "piik-app.desktop");
    const icon = join(
      root,
      "share",
      "icons",
      "hicolor",
      "256x256",
      "apps",
      "piik-app.png",
    );
    if (!existsSync(desktop) || !existsSync(icon)) {
      fail("Linux App icon assets are missing");
    }
    const entry = readFileSync(desktop, "utf8");
    if (!entry.includes("Icon=piik-app\n") || !entry.includes("Terminal=true\n")) {
      fail("Linux desktop entry must retain its icon and interactive terminal");
    }
    if (!readFileSync(icon).subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))) {
      fail("Linux App icon is not PNG");
    }
  }
  if (target.goos === "darwin") {
    const bundle = join(root, "Piik App.app");
    const executable = join(bundle, "Contents", "MacOS", target.appName);
    const plist = join(bundle, "Contents", "Info.plist");
    const icon = join(bundle, "Contents", "Resources", "piik.icns");
    if (!existsSync(executable) || !existsSync(plist) || !existsSync(icon)) {
      fail("macOS App bundle is incomplete");
    }
    if (!readFileSync(icon).subarray(0, 4).equals(Buffer.from("icns"))) {
      fail("macOS App icon is not ICNS");
    }
    const plistText = readFileSync(plist, "utf8");
    if (
      !plistText.includes(`<key>CFBundleExecutable</key><string>${target.appName}</string>`) ||
      !plistText.includes("<key>NSScreenCaptureUsageDescription</key>") ||
      !plistText.includes("<key>NSAudioCaptureUsageDescription</key>")
    ) {
      fail("macOS App entry or capture usage descriptions are missing");
    }
  }
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true,
  options: { "tunnel-asset": { type: "string" } },
});
if (positionals.length !== 2) {
  fail(
    "Usage: node scripts/package-app-candidate.mjs <target> <new-output-directory> [--tunnel-asset <raw-release-asset>]",
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
  await verifyPackage(extractedRoot, target, version, revision, temporaryRoot);
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
