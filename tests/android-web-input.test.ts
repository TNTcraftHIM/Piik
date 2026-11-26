import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { CLOUDFLARED_VERSION } from "../scripts/app-package-targets.mjs";
import { recordChannelWeb, verifyChannelWeb } from "../scripts/channel-web-artifact.mjs";

const source = vi.hoisted(() => ({ root: "", web: "", revision: "a".repeat(40), frontend: "", replaceFrontend: false, webBuilds: 0, commands: [] as string[], cargoEnvs: [] as NodeJS.ProcessEnv[] }));
const commit = "b".repeat(40);
vi.mock("node:url", async original => {
  const url = await original<typeof import("node:url")>();
  return { ...url, fileURLToPath: (value: string | URL) => String(value).endsWith("/scripts/build-android.mjs")
    ? join(source.root, "scripts/build-android.mjs") : url.fileURLToPath(value) };
});
vi.mock("../scripts/package-licenses.mjs", () => ({ writeAndroidLicenseNotices: () => undefined, writeChannelWebLicenseNotices: () => undefined }));
vi.mock("../scripts/app-icons.mjs", () => ({ writeAndroidAppIcon: () => undefined }));
vi.mock("../scripts/release-version.mjs", () => ({ buildVersion: () => "development" }));
vi.mock("../scripts/app-package-targets.mjs", async original => ({
  ...await original<typeof import("../scripts/app-package-targets.mjs")>(),
  CLOUDFLARED_SOURCE_SHA256: createHash("sha256").update("fixture upstream").digest("hex"),
}));
vi.mock("../scripts/build-channel-web.mjs", () => ({
  buildChannelWeb: () => {
    source.webBuilds++;
    return source.web;
  },
}));
vi.mock("node:child_process", () => ({
  execFileSync: (command: string, args: string[]) => {
    if (command === "git" && args[0] === "rev-parse") return source.revision;
    if (command === "go") return "windows\namd64\n";
    if (command.includes("llvm-readelf")) return "Type: DYN\n INTERP /system/bin/linker64\n LOAD 0x4000\n " +
      (args.at(-1)!.includes("arm64-v8a") ? "AArch64" : "Advanced Micro Devices X86-64");
    throw new Error("Unexpected command: " + command);
  },
  spawnSync: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    source.commands.push(command);
    const output = (file: string, bytes = "fixture") => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); };
    if (command === "tar") output(join(source.root, "build/android-cloudflared/cloudflared-" + "b".repeat(40), "supervisor/tunnel.go"));
    else if (command === "go") output(args[args.indexOf("-o") + 1]!);
    else if (command === "cargo") {
      source.cargoEnvs.push(options.env);
      output(join(options.env.CARGO_TARGET_DIR!, args[args.indexOf("--target") + 1]!, "debug/libpiik_channel_android.so"));
      if (source.replaceFrontend && source.cargoEnvs.length === 1) {
        output(join(source.web, "assets/index-fixture.js"), source.revision + " replacement");
        recordChannelWeb(source.web, { version: "v3.0.0-beta.31", revision: source.revision });
      }
    } else if (command === "jar") {
      source.frontend = args[args.indexOf("-C") + 1]!;
      output(args[args.indexOf("--file") + 1]!, readFileSync(join(source.frontend, "assets/index-fixture.js"), "utf8"));
    } else if (command === "java") output(join(source.root, "mobile/android/app/build/outputs/apk/debug/app-debug.apk"));
    else if (command !== "git" && !command.includes("llvm-strip") && !command.includes("fallback.test")) throw new Error("Unexpected command: " + command);
    return { status: 0 };
  },
}));

it.each(["default", "shared", "shared-lib", "shared-replaced", "mismatched", "overlap"])("Android uses the shared Web input owner (%s)", async scenario => {
  source.root = mkdtempSync(join(tmpdir(), "piik-android-web-"));
  source.web = join(source.root, scenario === "overlap" ? "mobile/android/app/src/main/assets/web" : "web");
  source.frontend = ""; source.replaceFrontend = scenario === "shared-replaced"; source.webBuilds = 0; source.commands = []; source.cargoEnvs = [];
  const previousArguments = process.argv, stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const write = (path: string, bytes: string | Buffer) => {
    const target = join(source.root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  };
  write("licenses/upstream.json", JSON.stringify({ [`cloudflared@${CLOUDFLARED_VERSION}`]: { source: "https://example.invalid/upstream/" + commit } }));
  const archive = "build/android-cloudflared/" + commit + ".tar.gz";
  write(archive, scenario === "default" ? "corrupt cache" : "fixture upstream");
  write("gradle/lib/gradle-launcher-fixture.jar", "fixture");
  const webPath = scenario === "overlap" ? "mobile/android/app/src/main/assets/web" : "web";
  write(webPath + "/index.html", '<script src="/assets/index-fixture.js"></script>');
  write(webPath + "/assets/index-fixture.js", source.revision);
  write(webPath + "/assets/runtime.wasm", Buffer.from([0, 97, 115, 109]));
  write(webPath + "/third-party-licenses.txt", "Fixture notices");
  recordChannelWeb(source.web, { version: scenario === "mismatched" ? "v3.0.0-beta.31" : "development", revision: source.revision });
  for (const name of ["ANDROID_HOME", "ANDROID_NDK_HOME", "GRADLE_HOME", "CARGO_TARGET_DIR"])
    vi.stubEnv(name, join(source.root, name === "GRADLE_HOME" ? "gradle" : name));
  const platform = process.platform;
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") throw new Error("Unsupported Android build host");
  const host = { win32: "windows-x86_64", linux: "linux-x86_64", darwin: "darwin-x86_64" }[platform];
  const prebuilt = join(process.env.ANDROID_NDK_HOME!, "toolchains/llvm/prebuilt", host);
  const libclang = join(prebuilt, scenario === "shared-lib" ? "lib" : "bin");
  const libclangName = { win32: "libclang.dll", linux: "libclang.so", darwin: "libclang.dylib" }[platform];
  mkdirSync(libclang, { recursive: true }); writeFileSync(join(libclang, libclangName), "fixture libclang");
  const fetch = vi.fn(() => { throw new Error("The fixture must not download or access a network"); });
  vi.stubGlobal("fetch", fetch);
  try {
    process.argv = [process.execPath, "build-android.mjs", ...(scenario === "default" ? [] : ["--web", source.web])];
    if (scenario === "default") {
      vi.resetModules();
      await expect(import("../scripts/build-android.mjs")).rejects.toThrow("Cloudflared source archive differs from its pin");
      expect(existsSync(join(source.root, archive))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("fixture upstream")));
    }
    vi.resetModules();
    const android = import("../scripts/build-android.mjs");
    if (scenario === "mismatched" || scenario === "overlap") {
      await expect(android).rejects.toThrow(scenario === "overlap" ? "Shared Web input overlaps" : "Shared Web build identity mismatch");
      expect(source.commands).toEqual([]);
      expect(readFileSync(join(source.web, "assets/index-fixture.js"), "utf8")).toBe(source.revision);
    } else {
      await android;
      if (scenario === "default") expect(source.frontend).toBe(source.web);
      else {
        expect(source.frontend).not.toBe(source.web);
        expect(existsSync(source.frontend)).toBe(false);
        expect(source.commands[0]).toBe("jar");
      }
      expect(source.commands.filter(command => command === "cargo")).toHaveLength(2);
      for (const [index, target] of ["aarch64-linux-android", "x86_64-linux-android"].entries()) {
        const env = source.cargoEnvs[index]!, key = target.replaceAll("-", "_");
        expect(env.LIBCLANG_PATH).toBe(libclang);
        expect(env.PATH?.split(delimiter)[0]).toBe(join(prebuilt, "bin"));
        expect(env["BINDGEN_EXTRA_CLANG_ARGS_" + key]).toBe(`--target=${target}29 --sysroot="${join(prebuilt, "sysroot").replaceAll("\\", "/")}"`);
      }
      expect(readFileSync(join(source.root, "mobile/android/app/src/main/assets/web/frontend.zip"), "utf8")).toBe(source.revision);
      expect(verifyChannelWeb(source.web, { version: scenario === "shared-replaced" ? "v3.0.0-beta.31" : "development",
        revision: source.revision })).toBe(source.web);
    }
    expect(source.webBuilds).toBe(scenario === "default" ? 1 : 0);
    expect(fetch).not.toHaveBeenCalled();
  } finally { process.argv = previousArguments; stdout.mockRestore(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(source.root, { recursive: true, force: true }); }
});
