#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Use the caller's source tree, including when this script is invoked externally.
const root = realpathSync(process.cwd());
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "build/rust-check");
const executable = name => join(target, "debug", `${name}${process.platform === "win32" ? ".exe" : ""}`);
const env = {
  ...process.env,
  RUSTUP_TOOLCHAIN: "1.91.0",
  CARGO_TARGET_DIR: target,
  CHANNEL_NATIVE_EXECUTABLE: executable("piik-channel-native"),
  CHANNEL_EXECUTABLE: executable("piik-channel-prototype"),
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root, env, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function cargo(command, crate, ...args) {
  run("cargo", ["+1.91.0", command, "--locked", "--manifest-path",
    `prototype/channel-${crate}/Cargo.toml`, ...args]);
}

cargo("test", "core");
cargo("test", "core", "--features", "sqlite");
// Native's default capture feature needs platform SDKs; forwarding does not.
cargo("build", "native", "--no-default-features", "--bin", "piik-channel-native");
cargo("test", "native", "--no-default-features");
// native_session launches the exact Native executable built above.
cargo("test", "server");
cargo("build", "server", "--bin", "piik-channel-prototype");
const { buildChannelWeb } = await import(pathToFileURL(join(root, "scripts/build-channel-web.mjs")).href);
env.PIIK_CHANNEL_WEB_DIR = buildChannelWeb(root, {
  version: "development", revision: "development", cargoTarget: target,
});
run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "prototype/channel-browser/tsconfig.json"]);
run(process.execPath, ["prototype/channel-server/run-browser-check.mjs", "--protocol"]);
process.stdout.write("Rust, Web/WASM and protocol checks passed (capture disabled).\n");
