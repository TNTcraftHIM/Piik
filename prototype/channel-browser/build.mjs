import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const root = import.meta.dirname;
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, "target"));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("cargo", ["+1.91.0", "build", "--locked", "--manifest-path", resolve(root, "Cargo.toml"),
  "--target-dir", target, "--target", "wasm32-unknown-unknown", "--release"]);
run(process.env.WASM_BINDGEN ?? "wasm-bindgen", ["--target", "web", "--out-dir", resolve(root, "pkg"),
  resolve(target, "wasm32-unknown-unknown/release/piik_channel_browser.wasm")]);
