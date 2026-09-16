#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_PACKAGE_TARGETS, appPackageTarget, goBuildEnvironment } from "./app-package-targets.mjs";

// Every Go command embeds the Vite output, so the build, vet and test steps all
// fail without it. The Server binary is cross-built for its deployment target.
const WEB_INDEX = join("internal", "server", "webassets", "dist", "index.html");
const SERVER_TARGET = appPackageTarget("linux-amd64");
// Local dependency repairs retain upstream tests, including PCPv6 composition.
// Nested modules need explicit test patterns; remove these with the replacements.
// Go source lives here; ./... would also scan downloaded SDKs and build probes.
const GO_TEST_PACKAGES = ["./cmd/...", "./internal/...", "github.com/netbirdio/go-nat/...", "github.com/jackpal/go-nat-pmp"];

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const captureRoot = join(root, "native", "capture");
const mode = process.argv[2] ?? "--all";

if (!["--all", "--core", "--capture-only", "--race"].includes(mode)) {
  throw new Error("Usage: node scripts/check-go.mjs [--all|--core|--capture-only|--race]");
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
  if (existsSync(join(root, WEB_INDEX))) return;
  if (process.platform === "win32") {
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build:web"]);
    return;
  }
  run("npm", ["run", "build:web"]);
}

function checkCore() {
  buildWebAssets();
  const go = process.env.PIIK_GO?.trim() || "go";
  const goRoot = run(go, ["env", "GOROOT"], { capture: true });
  const gofmt = process.env.PIIK_GOFMT?.trim() ||
    join(goRoot, "bin", process.platform === "win32" ? "gofmt.exe" : "gofmt");
  const unformatted = run(gofmt, ["-l", "cmd", "internal"], { capture: true });
  if (unformatted) {
    throw new Error(`Go source is not formatted:\n${unformatted}`);
  }
  runGoTests(go);
  run(go, ["vet", ...GO_TEST_PACKAGES]);

  const buildRoot = join(root, "build", "go-check");
  mkdirSync(buildRoot, { recursive: true });
  const buildTargets = APP_PACKAGE_TARGETS.filter((target) => {
    if (target.cgo && process.platform !== target.nodePlatform) {
      process.stderr.write(`Skipped ${target.id}: its cgo dependencies require a native macOS runner and SDK; Darwin acceptance remains pending.\n`);
      return false;
    }
    return true;
  });
  const builds = buildTargets.flatMap((target) =>
    ["piik-app", "piik-peer-gate"].map((command) => ({ target, command })),
  );
  builds.push({ target: SERVER_TARGET, command: "piik-server" });
  for (const { target, command } of builds) {
    const outputName = target.goos === "windows"
      ? `${command}.exe`
      : `${command}-${target.id}`;
    run(go, ["build", "-trimpath", "-o", join(buildRoot, outputName), `./cmd/${command}`], {
      env: goBuildEnvironment(target),
    });
  }
}

function runGoTests(go, packagesToTest = GO_TEST_PACKAGES, flags = []) {
  if (process.platform !== "win32") {
    run(go, ["test", ...flags, ...packagesToTest.filter((entry) => entry.startsWith("./"))]);
    // PCP and NAT-PMP both require port 5351. Serialize only their fixture
    // packages, keeping ordinary Piik tests parallel and using portable loopback.
    run(go, ["test", ...flags, "-p=1", ...packagesToTest.filter((entry) => !entry.startsWith("./"))]);
    return;
  }

  // Windows firewall permissions follow executable paths, including tests that
  // open sockets indirectly. Never execute a test from Go's temporary directory.
  const packages = run(go, ["list", "-f", '{{if or .TestGoFiles .XTestGoFiles}}[{{printf "%q" .ImportPath}},{{printf "%q" .Dir}}]{{end}}', ...packagesToTest], { capture: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => JSON.parse(value));
  const stableRoot = join(root, "build", "go-check");
  mkdirSync(stableRoot, { recursive: true });
  for (const [entry, directory] of packages) {
    const binary = join(stableRoot, `${basename(entry)}.test.exe`);
    run(go, ["test", ...flags, "-c", "-o", binary, entry]);
    run(binary, flags.includes("-race") ? ["-test.timeout=2m"] : [], { cwd: directory });
  }
}

function checkPlatformCapture() {
  if (!["win32", "darwin", "linux"].includes(process.platform)) {
    if (mode === "--capture-only") {
      throw new Error("No native capture check exists for this platform");
    }
    return;
  }
  const buildRoot = join(root, "build", "go-check");
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
    executable = join(buildRoot, "piik-capture.exe");
  } else if (process.platform === "darwin") {
    run("sh", [join(captureRoot, "darwin", "build.sh"), buildRoot]);
    executable = join(buildRoot, "piik-capture");
  } else {
    run("sh", [join(captureRoot, "linux", "build.sh"), buildRoot, "--check"]);
    executable = join(buildRoot, "piik-capture");
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
    throw new Error("Native capture process returned an invalid source list");
  }
}

if (mode === "--race") {
  buildWebAssets();
  runGoTests(process.env.PIIK_GO?.trim() || "go", [
    "./internal/app/portmapping", "./internal/app/mediaedge",
    "github.com/netbirdio/go-nat/...", "github.com/jackpal/go-nat-pmp",
  ], ["-race", "-count=1", "-timeout=2m"]);
} else {
  if (mode !== "--capture-only") checkCore();
  if (mode !== "--core") checkPlatformCapture();
}
process.stdout.write("Piik checks passed.\n");
