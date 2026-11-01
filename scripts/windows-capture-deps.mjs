import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This official port fixes both the libvpx source and its MSVC build patches.
const VCPKG_REVISION = "9a5dfef5d1a0438a7d24856a85bd60f309d355e9";
const TRIPLET = "x64-windows-static-md";
export const WINDOWS_LIBVPX_VERSION = "1.16.0";

/** Build the one standalone C dependency; never link the legacy WebRTC SDK. */
export function windowsCaptureEnvironment(repositoryRoot, outputDirectory = join(repositoryRoot, "build", "native-deps")) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows capture requires its native x64 MSVC runner.");
  const owner = resolve(outputDirectory);
  const source = join(owner, `vcpkg-${VCPKG_REVISION.slice(0, 12)}`);
  const installed = join(source, "installed", TRIPLET);
  const environment = { ...process.env, VCPKG_MAX_CONCURRENCY: "2", VCPKG_DISABLE_METRICS: "1" };
  const run = (command, args, cwd = source) => {
    const result = spawnSync(command, args, { cwd, env: environment, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: ${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return result.stdout.trim();
  };
  if (!existsSync(source)) {
    mkdirSync(source, { recursive: true });
    run("git", ["init", "--quiet"]);
    run("git", ["remote", "add", "origin", "https://github.com/microsoft/vcpkg"]);
  }
  if (!existsSync(join(source, "bootstrap-vcpkg.bat"))) {
    run("git", ["fetch", "--depth=1", "origin", VCPKG_REVISION]);
    run("git", ["checkout", "--detach", "--quiet", "FETCH_HEAD"]);
  }
  if (run("git", ["rev-parse", "HEAD"]) !== VCPKG_REVISION) throw new Error("Windows dependency checkout does not match its pinned revision.");
  const port = JSON.parse(readFileSync(join(source, "ports", "libvpx", "vcpkg.json"), "utf8"));
  if (port.version !== WINDOWS_LIBVPX_VERSION || port["port-version"] !== 3) throw new Error("Windows libvpx port identity changed.");
  const vcpkg = join(source, "vcpkg.exe");
  if (!existsSync(vcpkg)) run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "bootstrap-vcpkg.bat", "-disableMetrics"]);
  if (!existsSync(join(installed, "lib", "vpx.lib"))) {
    process.stderr.write("Building pinned standalone libvpx for Windows capture (two jobs).\n");
    run(vcpkg, ["install", `libvpx[realtime]:${TRIPLET}`, "--classic", "--disable-metrics"]);
  }
  return {
    VPX_LIB_DIR: join(installed, "lib"),
    VPX_INCLUDE_DIR: join(installed, "include"),
    VPX_VERSION: WINDOWS_LIBVPX_VERSION,
    VPX_STATIC: "1",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error("Usage: node scripts/windows-capture-deps.mjs [output-directory]");
  const output = process.argv[2];
  const env = windowsCaptureEnvironment(resolve(fileURLToPath(new URL("..", import.meta.url))), output);
  process.stdout.write(JSON.stringify(env) + "\n");
}
