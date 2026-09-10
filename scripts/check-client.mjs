#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_PACKAGE_TARGETS, clientPackageTarget, clientGoEnvironment } from "./client-package-targets.mjs";

// Every Go command embeds the Vite output, so the build, vet and test steps all
// fail without it. The Hosted binary is cross-built for its deployment target.
const CLIENT_INDEX = join("internal", "server", "webassets", "dist", "index.html");
const SERVER_TARGET = clientPackageTarget("linux-amd64");

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const captureRoot = join(root, "native", "capture");
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

function buildWebAssets() {
  if (existsSync(join(root, CLIENT_INDEX))) return;
  if (process.platform === "win32") {
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build:client"]);
    return;
  }
  run("npm", ["run", "build:client"]);
}

function checkCore() {
  buildWebAssets();
  const go = process.env.PIIK_GO?.trim() || "go";
  const goRoot = run(go, ["env", "GOROOT"], { capture: true });
  const gofmt = process.env.PIIK_GOFMT?.trim() ||
    join(goRoot, "bin", process.platform === "win32" ? "gofmt.exe" : "gofmt");
  const unformatted = run(gofmt, ["-l", "."], { capture: true });
  if (unformatted) {
    throw new Error(`Go source is not formatted:\n${unformatted}`);
  }
  runClientTests(go);
  run(go, ["vet", "./..."]);

  const buildRoot = join(root, "build", "client-check");
  mkdirSync(buildRoot, { recursive: true });
  const buildTargets = CLIENT_PACKAGE_TARGETS.filter((target) => {
    if (target.cgo && process.platform !== target.nodePlatform) {
      process.stderr.write(`Skipped ${target.id}: its cgo dependencies require a native macOS runner and SDK; Darwin acceptance remains pending.\n`);
      return false;
    }
    return true;
  });
  const builds = buildTargets.flatMap((target) =>
    ["piik-client", "piik-peer-gate"].map((command) => ({ target, command })),
  );
  builds.push({ target: SERVER_TARGET, command: "piik-server" });
  for (const { target, command } of builds) {
    const outputName = target.goos === "windows"
      ? `${command}.exe`
      : `${command}-${target.id}`;
    run(go, ["build", "-trimpath", "-o", join(buildRoot, outputName), `./cmd/${command}`], {
      env: clientGoEnvironment(target),
    });
  }
}

function runClientTests(go) {
  if (process.platform !== "win32") {
    run(go, ["test", "./..."]);
    return;
  }

  // Windows firewall permissions follow executable paths, including tests that
  // open sockets indirectly. Never execute a test from Go's temporary directory.
  const packages = run(go, ["list", "-f", '{{if or .TestGoFiles .XTestGoFiles}}[{{printf "%q" .ImportPath}},{{printf "%q" .Dir}}]{{end}}', "./..."], { capture: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => JSON.parse(value));
  const stableRoot = join(root, "build", "client-check");
  mkdirSync(stableRoot, { recursive: true });
  for (const [entry, directory] of packages) {
    const binary = join(stableRoot, `${basename(entry)}.test.exe`);
    run(go, ["test", "-c", "-o", binary, entry]);
    run(binary, [], { cwd: directory });
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
    const powershell = process.env.PIIK_POWERSHELL?.trim() ||
      (existsSync(modernPowerShell)
        ? modernPowerShell
        : (existsSync(systemPowerShell) ? systemPowerShell : "pwsh"));
    run(powershell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(captureRoot, "windows", "build.ps1"),
      "-OutputDirectory",
      buildRoot,
      "-Check",
    ]);
    executable = join(buildRoot, "piik-client-capture.exe");
  } else if (process.platform === "darwin") {
    run("sh", [join(captureRoot, "darwin", "build.sh"), buildRoot]);
    executable = join(buildRoot, "piik-client-capture");
  } else {
    run("sh", [join(captureRoot, "linux", "build.sh"), buildRoot]);
    executable = join(buildRoot, "piik-client-capture");
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
    probe?.protocol !== 7 ||
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
process.stdout.write("Piik Client checks passed.\n");
