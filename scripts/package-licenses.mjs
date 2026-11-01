import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUDFLARED_VERSION } from "./app-package-targets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(readFileSync(join(root, "licenses", "upstream.json"), "utf8"));
const licenseName = /^(licen[cs]e|copying|notice|copyright|authors)([._-]|$)/i;
const section = (label, body) => `\n===== ${label} =====\n\n${body.trim()}\n`;

// The packages the Vite bundle ships to the Browser. Nothing installs
// node_modules at runtime any more, so this list is the notice contract rather
// than package.json's dependencies field.
const WEB_BUNDLE_PACKAGES = ["@oddbird/popover-polyfill", "@zip.js/zip.js", "react", "react-dom", "sdp-transform", "semver", "zod"];

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

export function writeWebLicenseNotices(repositoryRoot, outputFile, packages = WEB_BUNDLE_PACKAGES) {
  const packagePath = join(repositoryRoot, "package.json");
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));
  const queue = packages.map((name) => [name, packagePath]);
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

export function writeServerLicenseNotices(repositoryRoot, outputFile, target) {
  const notices = rustNotices(repositoryRoot, "prototype/channel-server/Cargo.toml", [target.rustTarget]);
  writeFileSync(outputFile, "Piik Server third-party software notices\n" +
    WEB_NOTICE_LINE + notices);
}

function rustNotices(repositoryRoot, manifest, targets, features = []) {
  const command = process.env.CARGO_ABOUT ?? "cargo-about";
  const options = { cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RUSTUP_TOOLCHAIN: "1.91.0" } };
  if (execFileSync(command, ["--version"], options).trim() !== "cargo-about 0.9.3")
    throw new Error("Rust notices require cargo-about 0.9.3.");
  const output = join(repositoryRoot, "build", "licenses",
    [manifest.split("/").at(-2), ...features, ...targets].join("-") + ".txt");
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(command, ["generate", "--locked", "--fail", "--output-file", output,
    "--manifest-path", join(repositoryRoot, manifest),
    ...targets.flatMap(target => ["--target", target]),
    ...(features.length ? ["--features", features.join(" ")] : []),
    "--config", join(repositoryRoot, "licenses", "rust-about.toml"),
    join(repositoryRoot, "licenses", "rust-about.hbs")], options);
  return readFileSync(output, "utf8");
}

export function writeChannelWebLicenseNotices(repositoryRoot, outputFile) {
  writeWebLicenseNotices(repositoryRoot, outputFile);
  appendFileSync(outputFile, section("Browser Rust/WASM adapter",
    rustNotices(repositoryRoot, "prototype/channel-browser/Cargo.toml", ["wasm32-unknown-unknown"])));
}

function frameDropperNotice(repositoryRoot) {
  return section("WebRTC FrameDropper (BSD-3-Clause)",
    ["LICENSE", "PATENTS"].map(file => readFileSync(join(repositoryRoot,
      "native", "third_party", "webrtc-frame-dropper", file), "utf8")).join("\n"));
}

export function writeAndroidLicenseNotices(repositoryRoot, outputFile) {
  const runtime = rustNotices(repositoryRoot, "prototype/channel-android/Cargo.toml",
    ["aarch64-linux-android", "x86_64-linux-android"]);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, "Piik Android third-party software notices\n" +
    section("Piik (MIT)", readFileSync(join(repositoryRoot, "LICENSE"), "utf8")) +
    WEB_NOTICE_LINE + section("Rust runtime and paired Android platform verifier", runtime) +
    section("Kotlin standard library (Apache-2.0)", pinnedNotice("kotlin-stdlib@2.2.10")) +
    section("JetBrains annotations (Apache-2.0)", pinnedNotice("jetbrains-annotations@13.0")) +
    frameDropperNotice(repositoryRoot) +
    section(`cloudflared@${CLOUDFLARED_VERSION}`, pinnedNotice(`cloudflared@${CLOUDFLARED_VERSION}`)) +
    section("Piik Android cloudflared changes (MIT)",
      "Android system DNS adapter and exhausted-QUIC-dial fallback. Source and provenance: mobile/cloudflared/."));
}

export function writeAppLicenseNotices(repositoryRoot, packageRoot, target, tunnelVersion) {
  copyFileSync(join(repositoryRoot, "LICENSE"), join(packageRoot, "LICENSE"));
  if (tunnelVersion) {
    writeFileSync(join(packageRoot, "runtime", "tunnel", "THIRD-PARTY-NOTICES.txt"),
      pinnedNotice(`cloudflared@${tunnelVersion}`));
  }
  const notices = rustNotices(repositoryRoot, "prototype/channel-server/Cargo.toml", [target.rustTarget], ["capture"]);
  let text = "Piik App third-party software notices\n" +
    WEB_NOTICE_LINE +
    (tunnelVersion ? "Cloudflared: runtime/tunnel/THIRD-PARTY-NOTICES.txt\n" : "") +
    notices + frameDropperNotice(repositoryRoot);
  if (target.goos === "linux") {
    text += section("Linux system dependencies (not bundled)",
      readFileSync(join(repositoryRoot, "licenses", "linux-system-dependencies.txt"), "utf8"));
  }
  writeFileSync(join(packageRoot, "THIRD-PARTY-NOTICES.txt"), text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/package-licenses.mjs <web-notices-output>");
  writeChannelWebLicenseNotices(root, resolve(process.argv[2]));
}
