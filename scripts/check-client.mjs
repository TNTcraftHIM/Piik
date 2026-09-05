#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_PACKAGE_TARGETS } from "./client-package-targets.mjs";

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
  for (const target of CLIENT_PACKAGE_TARGETS) {
    for (const command of ["screener-client", "screener-peer-gate"]) {
      const outputName = target.goos === "windows"
        ? `${command}.exe`
        : `${command}-${target.id}`;
      run(go, ["build", "-trimpath", "-o", join(buildRoot, outputName), `./cmd/${command}`], {
        cwd: clientRoot,
        env: {
          ...process.env,
          GOOS: target.goos,
          GOARCH: target.goarch,
          CGO_ENABLED: "0",
        },
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

function checkPlatformCapture() {
  if (!["win32", "darwin", "linux"].includes(process.platform)) {
    if (mode === "--capture-only") {
      throw new Error("No native capture check exists for this platform");
    }
    return;
  }
  const buildRoot = join(root, "build", "client-check");
  mkdirSync(buildRoot, { recursive: true });
  let executable;
  if (process.platform === "win32") {
    const systemPowerShell = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const modernPowerShell = join(
      process.env.ProgramFiles || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    const powershell = process.env.SCREENER_POWERSHELL?.trim() ||
      (existsSync(modernPowerShell)
        ? modernPowerShell
        : (existsSync(systemPowerShell) ? systemPowerShell : "pwsh"));
    run(powershell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(clientRoot, "platform", "windows", "capture", "build.ps1"),
      "-OutputDirectory",
      buildRoot,
      "-Check",
    ]);
    executable = join(buildRoot, "screener-client-capture.exe");
  } else if (process.platform === "darwin") {
    run("sh", [
      join(clientRoot, "platform", "darwin", "capture", "build.sh"),
      buildRoot,
    ]);
    executable = join(buildRoot, "screener-client-capture");
  } else {
    run("sh", [
      join(clientRoot, "platform", "linux", "capture", "build.sh"),
      buildRoot,
    ]);
    executable = join(buildRoot, "screener-client-capture");
  }
  if (!existsSync(executable)) {
    throw new Error("Native capture build did not produce its executable");
  }
  if (process.platform === "darwin") {
    run(executable, ["--self-test"]);
  }
  const raw = run(executable, ["--probe"], { capture: true });
  const probe = JSON.parse(raw);
  const expectedPlatform = process.platform === "win32" ? "windows" : process.platform;
  if (
    probe?.protocol !== 4 ||
    probe.platform !== expectedPlatform ||
    typeof probe.platformBuild !== "string" ||
    typeof probe.videoCapture !== "boolean" ||
    typeof probe.softwareVP8 !== "boolean" ||
    typeof probe.processAudio !== "boolean" ||
    typeof probe.systemAudio !== "boolean" ||
    !Array.isArray(probe.adapters) ||
    probe.adapters.some((adapter) =>
      !Number.isInteger(adapter?.index) ||
      typeof adapter?.name !== "string" ||
      typeof adapter?.identity !== "string" ||
      !Array.isArray(adapter?.hardwareH264) ||
      adapter.hardwareH264.some((encoder) =>
        !Number.isInteger(encoder?.index) ||
        typeof encoder?.name !== "string" ||
        typeof encoder?.identity !== "string"
      )
    )
  ) {
    throw new Error("Native capture probe returned an invalid contract");
  }
  const sources = JSON.parse(run(executable, ["--list"], { capture: true }));
  if (!Array.isArray(sources) || sources.some((target) =>
    !["window", "display", "picker"].includes(target?.kind) ||
    !/^[1-9][0-9]{0,19}$/.test(target?.sourceId) ||
    typeof target?.title !== "string" ||
    (target.kind === "window" &&
      (!Number.isInteger(target?.pid) ||
        !/^[1-9][0-9]{0,19}$/.test(target?.creationTime))) ||
    (target.kind === "display" &&
      (target?.pid !== undefined || target?.creationTime !== undefined)) ||
    (target.kind === "picker" &&
      (target?.pid !== undefined || target?.creationTime !== undefined))
  )) {
    throw new Error("Windows capture process returned an invalid source list");
  }
}

if (mode !== "--capture-only") checkCore();
if (mode !== "--core") checkPlatformCapture();
process.stdout.write("Screener Client checks passed.\n");
