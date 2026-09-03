#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const clientRoot = join(root, "native", "client");
const mode = process.argv[2] ?? "--all";

if (!["--all", "--core", "--capture-only"].includes(mode)) {
  throw new Error("Usage: node scripts/check-client.mjs [--all|--core|--capture-only]");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? (result.stderr || result.stdout).trim()
      : "";
    throw new Error(`${basename(command)} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function checkCore() {
  const go = process.env.SCREENER_GO?.trim() || "go";
  const goRoot = run(go, ["env", "GOROOT"], { cwd: clientRoot, capture: true });
  const gofmt = process.env.SCREENER_GOFMT?.trim() ||
    join(goRoot, "bin", process.platform === "win32" ? "gofmt.exe" : "gofmt");
  const unformatted = run(gofmt, ["-l", "."], { cwd: clientRoot, capture: true });
  if (unformatted) {
    throw new Error(`Go source is not formatted:\n${unformatted}`);
  }
  runClientTests(go);
  run(go, ["vet", "./..."], { cwd: clientRoot });

  const buildRoot = join(root, "build", "client-check");
  mkdirSync(buildRoot, { recursive: true });
  for (const target of [
    { os: "windows", arch: "amd64", name: "screener-client.exe" },
    { os: "darwin", arch: "arm64", name: "screener-client-darwin-arm64" },
    { os: "linux", arch: "amd64", name: "screener-client-linux-amd64" },
  ]) {
    for (const command of ["screener-client", "screener-peer-gate"]) {
      const suffix = command === "screener-client" ? target.name :
        target.name.replace("screener-client", "screener-peer-gate");
      run(go, ["build", "-trimpath", "-o", join(buildRoot, suffix), `./cmd/${command}`], {
        cwd: clientRoot,
        env: { ...process.env, GOOS: target.os, GOARCH: target.arch, CGO_ENABLED: "0" },
      });
    }
  }
}

function runClientTests(go) {
  if (process.platform !== "win32") {
    run(go, ["test", "./..."], { cwd: clientRoot });
    return;
  }

  // Windows associates its listen prompt with the test executable path. Keep
  // the one UDP integration package at a stable path so repeated checks do not
  // create a new firewall rule for every Go build directory.
  const packages = run(go, ["list", "./..."], { cwd: clientRoot, capture: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const stableNetworkPackages = [
    {
      package: "github.com/TNTcraftHIM/Screener/native/client/internal/mediaedge",
      binary: "mediaedge.test.exe",
    },
  ];
  const stablePackageNames = new Set(
    stableNetworkPackages.map((entry) => entry.package),
  );
  const otherPackages = packages.filter((value) => !stablePackageNames.has(value));
  if (otherPackages.length > 0) {
    run(go, ["test", ...otherPackages], { cwd: clientRoot });
  }
  const stableRoot = join(root, "build", "client-check");
  mkdirSync(stableRoot, { recursive: true });
  for (const entry of stableNetworkPackages) {
    const binary = join(stableRoot, entry.binary);
    run(go, ["test", "-c", "-o", binary, entry.package], {
      cwd: clientRoot,
    });
    run(binary, ["-test.v"], { cwd: clientRoot });
  }
}

function checkWindowsCapture() {
  if (process.platform !== "win32") {
    if (mode === "--capture-only") {
      throw new Error("The Windows capture check requires Windows");
    }
    return;
  }
  const buildRoot = join(root, "build", "client-check");
  mkdirSync(buildRoot, { recursive: true });
  const systemPowerShell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powershell = process.env.SCREENER_POWERSHELL?.trim() ||
    (existsSync(systemPowerShell) ? systemPowerShell : "pwsh");
  run(powershell, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(clientRoot, "platform", "windows", "capture", "build.ps1"),
    "-OutputDirectory",
    buildRoot,
  ]);
  const executable = join(buildRoot, "screener-client-capture.exe");
  if (!existsSync(executable)) {
    throw new Error("Windows capture build did not produce its executable");
  }
  const raw = run(executable, ["--probe"], { capture: true });
  const probe = JSON.parse(raw);
  if (
    probe?.protocol !== 1 ||
    !Number.isInteger(probe.windowsBuild) ||
    typeof probe.windowCapture !== "boolean" ||
    typeof probe.processAudio !== "boolean" ||
    !Array.isArray(probe.adapters)
  ) {
    throw new Error("Windows capture probe returned an invalid contract");
  }
  const windows = JSON.parse(run(executable, ["--list"], { capture: true }));
  if (!Array.isArray(windows) || windows.some((target) =>
    !/^[1-9][0-9]{0,19}$/.test(target?.windowHandle) ||
    !Number.isInteger(target?.pid) ||
    !/^[1-9][0-9]{0,19}$/.test(target?.creationTime) ||
    typeof target?.title !== "string"
  )) {
    throw new Error("Windows capture process returned an invalid window list");
  }
}

if (mode !== "--capture-only") checkCore();
if (mode !== "--core") checkWindowsCapture();
process.stdout.write("Screener Client checks passed.\n");
