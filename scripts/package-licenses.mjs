import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientGoEnvironment } from "./client-package-targets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(readFileSync(join(root, "licenses", "upstream.json"), "utf8"));
const licenseName = /^(licen[cs]e|copying|notice|copyright|authors)([._-]|$)/i;
const section = (label, body) => `\n===== ${label} =====\n\n${body.trim()}\n`;

// The packages the Vite bundle ships to the Browser. Nothing installs
// node_modules at runtime any more, so this list is the notice contract rather
// than package.json's dependencies field.
const WEB_BUNDLE_PACKAGES = ["react", "react-dom", "sdp-transform", "zod"];

// Both binaries embed the Web bundle, which serves its own notice file.
const WEB_NOTICE_LINE = "Web dependencies: served at /third-party-licenses.txt\n";

function pinnedNotice(key) {
  const entry = pinned[key];
  if (!entry) throw new Error(`Missing pinned license text for ${key}`);
  const bytes = readFileSync(join(root, "licenses", entry.file));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`Pinned license text changed for ${key}`);
  }
  return `Source: ${entry.source}\n\n${bytes.toString("utf8")}`;
}

function noticesIn(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && licenseName.test(file.name))
    .map((file) => file.name).sort();
}

export function writeWebLicenseNotices(repositoryRoot, outputFile) {
  const packagePath = join(repositoryRoot, "package.json");
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));
  const queue = WEB_BUNDLE_PACKAGES.map((name) => [name, packagePath]);
  const visited = new Set();
  const entries = new Map();
  for (const [name, parent] of queue) {
    const paths = createRequire(parent).resolve.paths("piik-license-lookup");
    const directory = paths.map((path) => join(path, name))
      .find((path) => existsSync(join(path, "package.json")));
    if (!directory) throw new Error(`Missing installed runtime dependency ${name}`);
    if (visited.has(directory)) continue;
    visited.add(directory);
    const path = join(directory, "package.json");
    const dependency = JSON.parse(readFileSync(path, "utf8"));
    const installed = relative(repositoryRoot, directory).replaceAll("\\", "/");
    if (lock.packages[installed]?.version !== dependency.version) {
      throw new Error(`Runtime dependency differs from lockfile: ${name}`);
    }
    const key = `${dependency.name}@${dependency.version}`;
    const files = noticesIn(directory);
    const body = files.length
      ? files.map((file) => section(file, readFileSync(join(directory, file), "utf8"))).join("")
      : pinnedNotice(key);
    entries.set(key, section(`${key} (${dependency.license ?? "see license text"})`, body));
    for (const child of Object.keys(dependency.dependencies ?? {})) queue.push([child, path]);
  }
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, "Third-party software notices\n" +
    "Piik's MIT license does not replace the following component licenses.\n" +
    [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, body]) => body).join(""));
}

// goNotices enumerates the Go toolchain notice and every license file that
// belongs to a module actually compiled into `command` for `target`. A module
// without a recognised license filename fails closed.
function goNotices(repositoryRoot, goCommand, target, command) {
  const options = { cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    env: clientGoEnvironment(target) };
  const runGo = (args) => execFileSync(goCommand, args, options).trim();
  const goroot = runGo(["env", "GOROOT"]);
  const template = '{{if .Module}}{{if not .Module.Main}}[{{printf "%q" .Module.Path}},{{printf "%q" .Module.Version}},{{printf "%q" .Module.Dir}},{{printf "%q" .Dir}}]{{end}}{{end}}';
  const packages = runGo(["list", "-deps", "-f", template, command])
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const entries = new Map();
  for (const [name, version, directory, packageDirectory] of packages) {
    const key = `${name}@${version}`;
    const files = entries.get(key) ?? new Map();
    if (!noticesIn(directory).length) throw new Error(`Missing Go module license: ${key}`);
    for (let current = packageDirectory; ; current = dirname(current)) {
      for (const file of noticesIn(current)) {
        const fullPath = join(current, file);
        files.set(relative(directory, fullPath).replaceAll("\\", "/"), readFileSync(fullPath, "utf8"));
      }
      if (current === directory) break;
      if (current === dirname(current)) throw new Error(`Go package leaves module: ${key}`);
    }
    entries.set(key, files);
  }
  const toolchain = section(runGo(["version"]), readFileSync(join(goroot, "LICENSE"), "utf8"));
  return { toolchain, modules: entries };
}

function moduleSections(modules) {
  let text = "";
  for (const [name, files] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [file, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      text += section(`${name}/${file}`, body);
    }
  }
  return text;
}

// writeServerLicenseNotices produces the Hosted application release notice file,
// which ships beside the single piik-server binary.
export function writeServerLicenseNotices(repositoryRoot, outputFile, goCommand, target) {
  const notices = goNotices(repositoryRoot, goCommand, target, "./cmd/piik-server");
  writeFileSync(outputFile, "Piik server third-party software notices\n" +
    WEB_NOTICE_LINE + notices.toolchain + moduleSections(notices.modules));
}

export function writeClientLicenseNotices(repositoryRoot, packageRoot, goCommand, target, tunnelVersion) {
  copyFileSync(join(repositoryRoot, "LICENSE"), join(packageRoot, "LICENSE"));
  if (tunnelVersion) {
    writeFileSync(join(packageRoot, "runtime", "tunnel", "THIRD-PARTY-NOTICES.txt"),
      pinnedNotice(`cloudflared@${tunnelVersion}`));
  }
  const notices = goNotices(repositoryRoot, goCommand, target, "./cmd/piik-client");
  let text = "Native Client third-party software notices\n" +
    WEB_NOTICE_LINE +
    (tunnelVersion ? "Cloudflared: runtime/tunnel/THIRD-PARTY-NOTICES.txt\n" : "") +
    notices.toolchain;
  const linuxCapture = target.goos === "linux" && target.captureName &&
    existsSync(join(packageRoot, "runtime", "native", target.captureName));
  if (linuxCapture) {
    text += section("Linux system dependencies (not bundled)",
      readFileSync(join(repositoryRoot, "licenses", "linux-system-dependencies.txt"), "utf8"));
    text += section("LGPL-3.0-only (libportal)",
      readFileSync(join(repositoryRoot, "licenses", "LGPL-3.0.txt"), "utf8"));
    text += section("GPL-3.0 (libportal terms)",
      readFileSync(join(repositoryRoot, "licenses", "GPL-3.0.txt"), "utf8"));
  }
  if (target.goos === "windows" &&
      existsSync(join(packageRoot, "runtime", "native", target.captureName))) {
    const dependencies = JSON.parse(readFileSync(join(repositoryRoot, "native", "capture",
      "windows", "webrtc-dependencies.json"), "utf8"));
    const name = `webrtc@${dependencies.webrtc.version}`;
    text += section(name, pinnedNotice(name));
  }
  writeFileSync(join(packageRoot, "THIRD-PARTY-NOTICES.txt"), text + moduleSections(notices.modules));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/package-licenses.mjs <web-notices-output>");
  writeWebLicenseNotices(root, resolve(process.argv[2]));
}
