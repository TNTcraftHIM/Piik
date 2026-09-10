#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { clientPackageTarget, CLOUDFLARED_VERSION } from "./client-package-targets.mjs";
import { tarExecutable } from "./archive-tool.mjs";
import { resetBuildWorkspace } from "./build-workspace.mjs";

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
  if (path === "" || (path.split(/[\\/]/)[0] !== ".." && !isAbsolute(path))) {
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
        rejectPort(new Error("Client smoke port reservation failed"));
        return;
      }
      server.close((error) =>
        error ? rejectPort(error) : resolvePort(address.port),
      );
    });
  });
}

function smokeLANAddress() {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .sort();
  if (addresses.length === 0) fail("Client smoke has no active LAN IPv4 address");
  return addresses[0];
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      rejectExit(new Error("Packaged Client did not stop"));
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
    child.stdin.write("\n");
  } catch {}
  try {
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

async function verifyLocalPackage(root, target, temporaryRoot) {
  const client = join(root, target.clientName);
  const port = await reservePort();
  const healthURL = `http://127.0.0.1:${port}/healthz`;
  const noticeURL = `http://127.0.0.1:${port}/third-party-licenses.txt`;
  const child = spawn(client, [
    "--local",
    "--config", join(temporaryRoot, "smoke-client.json"),
    "--lan-address", smokeLANAddress(),
    "--port", String(port),
  ], {
    cwd: root,
    env: { ...process.env, PIIK_CLIENT_GATE_NO_BROWSER: "true" },
    stdio: "pipe",
    windowsHide: true,
  });
  let spawnFailure = null;
  let stderr = "";
  let stdout = "";
  let clientReady = false;
  child.once("error", (error) => {
    spawnFailure = error;
  });
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-2_048);
    if (stdout.includes("Local access password: ") || stdout.includes("Local access: open")) {
      clientReady = true;
      stdout = "";
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
  });
  try {
    const deadline = Date.now() + 15_000;
    let healthReady = false;
    while (Date.now() < deadline) {
      if (spawnFailure) break;
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (!healthReady) {
        try {
          const response = await fetch(healthURL, {
            headers: { Connection: "close" },
            signal: AbortSignal.timeout(500),
          });
          healthReady = response.ok && (await response.json())?.status === "ok";
        } catch {}
      }
      if (healthReady && clientReady) break;
      await delay(100);
    }
    if (!healthReady || !clientReady) {
      fail("Packaged Client Local health did not become ready");
    }
    // The Web notices ship inside the binary; the embedded assets serve them.
    const notices = await fetch(noticeURL, {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!notices.ok || (await notices.text()).length === 0) {
      fail("Packaged Client did not serve its Web third-party notices");
    }
    child.stdin.write("\n");
    const exitCode = await waitForExit(child, 10_000);
    if (exitCode !== 0) {
      const detail = stderr
        .trim()
        .replace(/https?:\/\/\S+/g, "<url>")
        .replace(/\s+/g, " ")
        .slice(-1_000);
      fail(
        `Packaged Client did not stop cleanly (${exitCode ?? child.signalCode ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      );
    }
    const closeDeadline = Date.now() + 5_000;
    while (Date.now() < closeDeadline) {
      try {
        await fetch(healthURL, {
          headers: { Connection: "close" },
          signal: AbortSignal.timeout(300),
        });
      } catch {
        return;
      }
      await delay(100);
    }
    fail("Packaged Client left its Local server listening");
  } finally {
    await stopSmokeChild(child);
  }
}

async function verifyPackage(root, target, revision, temporaryRoot) {
  const packagedRevision = readFileSync(join(root, "REVISION"), "ascii").trim();
  if (packagedRevision !== revision) fail("Client package revision mismatch");
  for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.txt",
    "runtime/tunnel/THIRD-PARTY-NOTICES.txt"]) {
    if (!existsSync(join(root, file)) || readFileSync(join(root, file)).length === 0) {
      fail(`Client package license text is missing: ${file}`);
    }
  }

  const client = join(root, target.clientName);
  const tunnel = join(root, "runtime", "tunnel", target.tunnelName);
  run(client, ["--help"], root);
  run(tunnel, ["--version"], root);
  verifyPlatformAssets(root, target);

  if (target.captureName) {
    const capture = join(root, "runtime", "native", target.captureName);
    const probe = JSON.parse(run(capture, ["--probe"], root));
    if (probe?.protocol !== 7) fail("Packaged native capture probe is invalid");
  }
  await verifyLocalPackage(root, target, temporaryRoot);
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
      fail("Linux Client icon assets are missing");
    }
    if (!readFileSync(desktop, "utf8").includes("Icon=piik-app\n")) {
      fail("Linux desktop entry does not name its icon");
    }
    if (!readFileSync(icon).subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))) {
      fail("Linux Client icon is not PNG");
    }
  }
  if (target.goos === "darwin") {
    const bundle = join(root, "Piik App.app");
    const launcher = join(bundle, "Contents", "MacOS", "launcher");
    const plist = join(bundle, "Contents", "Info.plist");
    const icon = join(bundle, "Contents", "Resources", "piik.icns");
    if (!existsSync(launcher) || !existsSync(plist) || !existsSync(icon)) {
      fail("macOS Client app icon assets are missing");
    }
    if (!readFileSync(icon).subarray(0, 4).equals(Buffer.from("icns"))) {
      fail("macOS Client icon is not ICNS");
    }
    const plistText = readFileSync(plist, "utf8");
    if (
      !plistText.includes("<key>NSScreenCaptureUsageDescription</key>") ||
      !plistText.includes("<key>NSAudioCaptureUsageDescription</key>")
    ) {
      fail("macOS Client capture usage descriptions are missing");
    }
    if (process.platform === "darwin") run(launcher, ["--help"], root);
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
const temporaryRoot = resetBuildWorkspace(repositoryRoot, "client-package", target.id, "candidate");
try {
  const tunnelDownload = join(temporaryRoot, target.tunnelAsset);
  await download(
    `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${target.tunnelAsset}`,
    tunnelDownload,
  );
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

  let capture = null;
  if (target.captureName) {
    run(
      process.execPath,
      [join(repositoryRoot, "scripts", "check-client.mjs"), "--capture-only"],
      repositoryRoot,
    );
    capture = join(repositoryRoot, "build", "client-check", target.captureName);
  }

  const packageRoot = join(temporaryRoot, `piik-app-${target.id}`);
  const assembleArguments = [
    join(repositoryRoot, "scripts", "assemble-client.mjs"),
    applicationDescriptor(applicationRoot),
    packageRoot,
    "--target",
    target.id,
    "--tunnel",
    tunnel,
  ];
  if (capture) assembleArguments.push("--capture", capture);
  run(process.execPath, assembleArguments, repositoryRoot);
  await verifyPackage(packageRoot, target, revision, temporaryRoot);

  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const shortRevision = revision.slice(0, 7);
  const archiveName = `piik-app-${target.id}-${shortRevision}.tar.gz`;
  const archive = join(outputRoot, archiveName);
  run(tarExecutable(), ["-czf", archive, "-C", packageRoot, "."], repositoryRoot);
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
