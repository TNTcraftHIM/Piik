#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appPackageTarget, appPackageDirectory, MACOS_MIN_VERSION } from "./app-package-targets.mjs";
import { collectAppBundleLayout } from "./app-bundle-layout.mjs";
import { checkWebSourceIdentity } from "./container-web-identity.mjs";
import { spawnProcess, requestShutdown } from "./process-shutdown.mjs";

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

export function assertTargetExecutable(path, target, label) {
  if (!lstatSync(path).isFile() || !executableMatchesTarget(path, target)) {
    fail(`${label} does not match App package target ${target.id}`);
  }
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
          signal: AbortSignal.timeout(500),
        });
        const discovery = response.ok ? await response.json() : null;
        if (!response.ok) await response.body?.cancel();
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
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        fail(`Packaged App returned HTTP ${response.status} for ${path}`);
      }
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
        const response = await fetch(discoveryURL, {
          signal: AbortSignal.timeout(300),
        });
        await response.arrayBuffer();
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

function macLifecycle(probe, args, root) {
  const facts = JSON.parse(run(probe, args, root, 20_000));
  process.stderr.write(`macOS App lifecycle ${args[0]}: ${JSON.stringify(facts)}\n`);
  return facts;
}

async function verifyMacLifecycle(root, target, version, revision, temporaryRoot, probe) {
  const app = join(root, target.appName);
  const emptyWeb = join(temporaryRoot, "empty-web");
  mkdirSync(emptyWeb);
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const waitForStop = async (pid) => {
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline) await delay(100);
    if (alive(pid)) fail("LaunchServices App did not finish ordered shutdown");
  };
  for (const web of [join(root, "web"), emptyWeb]) {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const environment = join(temporaryRoot, "mac-lifecycle-env.json");
    writeFileSync(environment, JSON.stringify({
      PIIK_CHANNEL_APP_DATA_DIR: join(temporaryRoot, "smoke-app-data"),
      PIIK_CHANNEL_APP_WEB_DIR: web, PIIK_CHANNEL_APP_PORT: String(port),
      PIIK_CHANNEL_APP_NO_BROWSER: "1", PIIK_CHANNEL_ICE_SERVERS: "[]",
      PIIK_CHANNEL_CLOUDFLARED: join(root, "runtime", "tunnel", target.tunnelName),
    }));
    let launched;
    try {
      launched = macLifecycle(probe, ["launch", dirname(dirname(root)), environment, app], root);
      if (!Number.isFinite(launched.launchDate)) fail("App bundle was not started by LaunchServices");
      if (web !== emptyWeb) {
        const deadline = Date.now() + 15_000;
        let ready = false;
        while (alive(launched.pid) && Date.now() < deadline) {
          try {
            const response = await fetch(`${origin}/connect-discovery`, { signal: AbortSignal.timeout(500) });
            const discovery = response.ok ? await response.json() : null;
            if (!response.ok) await response.body?.cancel();
            ready = discovery?.port === port && discovery?.connectURL === `${origin}/client`;
          } catch {}
          if (ready) break;
          await delay(100);
        }
        if (!ready) fail("LaunchServices App discovery did not become ready");
        const identity = await (await fetch(`${origin}/api/client-launcher`, {
          signal: AbortSignal.timeout(2_000),
        })).json();
        if (identity.version !== version || identity.revision !== revision)
          fail("LaunchServices App build identity mismatch");
        const quit = macLifecycle(probe, ["quit", String(launched.pid), app], root);
        if (quit.preflight === -1744 && quit.quitSent === false) continue;
      }
      await waitForStop(launched.pid);
      const stillListening = await fetch(`${origin}/connect-discovery`, {
        signal: AbortSignal.timeout(500),
      }).then(async response => { await response.body?.cancel(); return true; }, () => false);
      if (stillListening) fail("LaunchServices App left its loopback listener running");
      process.stderr.write(`macOS App lifecycle ${web === emptyWeb ? "early-core-error" : "quit"}: exited, port closed\n`);
    } finally {
      // Retire our bundle after a failed or unexecuted case. SIGTERM cleanup
      // is never accepted as evidence that the Quit AppleEvent worked.
      if (launched && alive(launched.pid)) {
        process.kill(launched.pid, "SIGTERM");
        await waitForStop(launched.pid);
      }
    }
  }
}

function verifyPlatformAssets(root, target) {
  if (target.goos === "windows") {
    const vswhere = join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const dumpbin = run(vswhere, ["-latest", "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-find", "VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe"], root)
      .split(/\r?\n/).find(Boolean);
    if (!dumpbin) fail("Visual Studio dumpbin was not found");
    const dependencies = run(dumpbin, ["/nologo", "/dependents", join(root, target.appName)], root);
    if (/\b(?:VCRUNTIME|MSVCP|MSVCR|CONCRT)\d[\w-]*\.dll\b/i.test(dependencies)) {
      fail("Windows App requires an external Visual C++ runtime");
    }
  }
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
    const minimumVersion = run("otool", ["-l", executable], root)
      .match(/^\s*minos\s+(\S+)\s*$/m)?.[1];
    if (minimumVersion !== MACOS_MIN_VERSION) {
      fail("macOS App deployment target does not match its minimum system version");
    }
    const plistText = readFileSync(plist, "utf8");
    if (
      !plistText.includes(`<key>CFBundleExecutable</key><string>${target.appName}</string>`) ||
      !plistText.includes(`<key>LSMinimumSystemVersion</key><string>${MACOS_MIN_VERSION}</string>`) ||
      !plistText.includes("<key>NSLocalNetworkUsageDescription</key>") ||
      !plistText.includes("<key>NSScreenCaptureUsageDescription</key>") ||
      !plistText.includes("<key>NSMicrophoneUsageDescription</key>") ||
      !plistText.includes("<key>NSAudioCaptureUsageDescription</key>")
    ) {
      fail("macOS App entry or permission usage descriptions are missing");
    }
  }
}


/** Inspect an existing package without executing its App or bundled helper. */
export async function checkAppPackageStatic(root, target, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) fail("App package check requires a full source revision");
  const runtimeRoot = join(root, appPackageDirectory(target));
  collectAppBundleLayout(root, [appPackageDirectory(target), target.appName].filter(Boolean).join("/"));
  if (readFileSync(join(runtimeRoot, "REVISION"), "ascii").trim() !== revision) fail("App package revision mismatch");
  for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.txt", "runtime/tunnel/THIRD-PARTY-NOTICES.txt", "web/third-party-licenses.txt"]) {
    if (!existsSync(join(runtimeRoot, file)) || readFileSync(join(runtimeRoot, file)).length === 0)
      fail("App package license text is missing: " + file);
  }
  assertTargetExecutable(join(runtimeRoot, target.appName), target, "App executable");
  assertTargetExecutable(join(runtimeRoot, "runtime", "tunnel", target.tunnelName), target, "Public tunnel runtime");
  const web = join(runtimeRoot, "web");
  await checkWebSourceIdentity(readFileSync(join(web, "index.html"), "utf8"), revision,
    async asset => readFileSync(join(web, asset.slice(1)), "utf8"));
  const wasm = readdirSync(join(web, "assets")).find(name => name.endsWith(".wasm"));
  if (!wasm || !bytesAt(join(web, "assets", wasm), 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])))
    fail("Packaged App frontend has no Rust/WASM adapter");
  verifyPlatformAssets(root, target);
}

/** Native acceptance remains mandatory before a candidate gains release metadata. */
export async function checkAppPackageRuntime(root, target, version, revision, temporaryRoot, repositoryRoot) {
  if (process.platform !== target.nodePlatform || process.arch !== target.nodeArch)
    fail("App candidate " + target.id + " requires its native runner");
  const runtimeRoot = join(root, appPackageDirectory(target));
  run(join(runtimeRoot, "runtime", "tunnel", target.tunnelName), ["--version"], root);
  if (target.goos === "darwin") {
    const probe = join(temporaryRoot, "mac-app-lifecycle");
    run("xcrun", ["swiftc", "-parse-as-library", join(repositoryRoot, "scripts", "mac-app-lifecycle.swift"), "-o", probe], root);
    await verifyMacLifecycle(runtimeRoot, target, version, revision, temporaryRoot, probe);
  }
  await verifyLocalPackage(runtimeRoot, target, version, revision, temporaryRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, targetId, directory, version, revision, ...extra] = process.argv.slice(2);
  const target = appPackageTarget(targetId);
  if (!["static", "runtime"].includes(phase) || !target || !directory || !version || !revision || extra.length)
    fail("Usage: node scripts/check-app-package.mjs static|runtime <target> <package-directory> <version> <full-revision>");
  const root = resolve(directory);
  await checkAppPackageStatic(root, target, revision);
  if (phase === "runtime") {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "piik-package-check-"));
    try { await checkAppPackageRuntime(root, target, version, revision, temporaryRoot, resolve(dirname(fileURLToPath(import.meta.url)), "..")); }
    finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
  }
  process.stdout.write(JSON.stringify({ target: target.id, version, revision, static: "passed", runtime: phase === "runtime" ? "passed" : "not-run" }) + "\n");
}
