import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { recordChannelWeb, verifyChannelWeb } from "../scripts/channel-web-artifact.mjs";

const source = vi.hoisted(() => ({
  revision: "a".repeat(40), workspace: "", web: "", scenario: "", containerRead: false, webBuilds: 0, nativeBuilt: false,
}));

// Keep the packager's archive/descriptor/export flow real while replacing
// external build tools and their Git observations.
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return source.containerRead && source.scenario === "revision"
      ? "b".repeat(40) : source.revision;
    if (args[0] === "status") return source.containerRead && source.scenario === "dirty"
      ? " M deploy/container/Dockerfile\n" : "";
    throw new Error(`Unexpected Git observation: ${args.join(" ")}`);
  },
  spawnSync: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    let stdout = "";
    if (command === "docker") {
      source.containerRead = true;
      if (source.scenario === "docker-failure") return { status: 1, stderr: "container failed" };
    } else if (command === "cargo") {
      source.nativeBuilt = true;
      expect(args).toContain("--no-default-features");
      expect(args).not.toContain("--features");
      expect(args[args.indexOf("--bin") + 1]).toBe("piik-channel-prototype");
      expect(args[args.indexOf("--target") + 1]).toBe("x86_64-unknown-linux-musl");
      const binary = join(options.env.CARGO_TARGET_DIR!, args[args.indexOf("--target") + 1]!, "release");
      mkdirSync(binary, { recursive: true });
      writeFileSync(join(binary, "piik-channel-prototype"), "fixture Server");
    } else if (command === "readelf") {
      stdout = source.scenario === "dynamic-loader" ? " INTERP 0x00000000" :
        source.scenario === "dynamic-library" ? " (NEEDED) Shared library: [libc.so]" :
          " DYNAMIC 0x00000000\n (FLAGS_1) Flags: PIE";
    } else if (args[0] === "-czf") {
      writeFileSync(args[1]!, "fixture archive");
      if (source.scenario === "archive-failure") return { status: 1, stderr: "archive interrupted" };
    } else if (args[0] === "-tzf") {
      stdout = "LICENSE\nREVISION\nTHIRD-PARTY-NOTICES.txt\npiik-server\nweb/\nweb/index.html\nweb/assets/\nweb/assets/index-fixture.js\nweb/adapter.wasm\n";
    } else if (args[0] === "-xzf") {
      cpSync(join(source.workspace, "runtime"), args[args.indexOf("-C") + 1]!, { recursive: true });
    } else {
      throw new Error(`Unexpected build operation: ${command} ${args.join(" ")}`);
    }
    return { status: 0, stdout, stderr: "" };
  },
}));
vi.mock("../scripts/build-channel-web.mjs", () => ({ buildChannelWeb: (_root: string, options: { web?: string; version: string; revision: string }) => {
  if (options.web) return verifyChannelWeb(options.web, options);
  source.webBuilds++;
  return source.web;
} }));
vi.mock("../scripts/build-workspace.mjs", async (original) => ({
  ...await original<typeof import("../scripts/build-workspace.mjs")>(),
  resetBuildWorkspace: () => { mkdirSync(source.workspace); return source.workspace; },
}));
vi.mock("../scripts/package-licenses.mjs", () => ({
  writeServerLicenseNotices: (_root: string, path: string) => writeFileSync(path, "fixture notices"),
}));
vi.mock("../scripts/release-version.mjs", () => ({ buildVersion: () => "development" }));
vi.mock("../scripts/archive-tool.mjs", () => ({ tarExecutable: () => "fixture-tar" }));

it.each(["clean", "dirty", "revision", "docker-failure", "archive-failure", "existing", "dynamic-loader", "dynamic-library", "shared-web", "wrong-web"] as const)(
  "exports a Server release only after all tracked inputs are settled (%s)", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "piik-server-package-"));
    const output = join(root, "release");
    const previousArguments = process.argv;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("VITE_PIIK_VERSION", "development");
    vi.stubEnv("VITE_PIIK_REVISION", "");
    vi.stubEnv("CARGO_TARGET_DIR", join(root, "cargo"));
    vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
    source.workspace = join(root, "workspace");
    source.scenario = scenario;
    source.containerRead = false;
    source.webBuilds = 0; source.nativeBuilt = false;
    source.web = join(root, "web");
    mkdirSync(join(source.web, "assets"), { recursive: true });
    writeFileSync(join(source.web, "index.html"), '<script src="./assets/index-fixture.js"></script>');
    writeFileSync(join(source.web, "assets", "index-fixture.js"), source.revision);
    writeFileSync(join(source.web, "adapter.wasm"), "fixture WASM");
    if (scenario === "shared-web" || scenario === "wrong-web") {
      writeFileSync(join(source.web, "adapter.wasm"), Buffer.from([0, 97, 115, 109]));
      writeFileSync(join(source.web, "third-party-licenses.txt"), "fixture notices");
      recordChannelWeb(source.web, { version: scenario === "wrong-web" ? "v3.0.0-beta.31" : "development", revision: source.revision });
    }
    try {
      if (scenario === "existing") {
        mkdirSync(output);
        writeFileSync(join(output, "user.txt"), "keep");
      }
      process.argv = [process.execPath, "package-server-release.mjs", output, "--container-image", "piik-fixture:test"];
      if (scenario === "shared-web" || scenario === "wrong-web") process.argv.push("--web", source.web);
      vi.resetModules();
      const packaging = import("../scripts/package-server-release.mjs");
      if (scenario === "clean" || scenario === "shared-web") {
        await packaging;
        const descriptor = JSON.parse(readFileSync(join(output, "piik-aaaaaaa.release.json"), "utf8"));
        expect(descriptor.revision).toBe(source.revision);
        expect(descriptor.fileCount).toBe(scenario === "shared-web" ? 8 : 7);
        expect(descriptor.mainAsset).toBe("assets/index-fixture.js");
        expect(readFileSync(join(output, descriptor.manifest), "utf8")).toContain("web/adapter.wasm");
        expect(existsSync(join(output, descriptor.artifact))).toBe(true);
      } else if (scenario === "existing") {
        await expect(packaging).rejects.toThrow("must not already exist");
        expect(readFileSync(join(output, "user.txt"), "utf8")).toBe("keep");
      } else {
        const expected = { dirty: "clean Git checkout", revision: "package source",
          "docker-failure": "container failed", "archive-failure": "archive interrupted",
          "dynamic-loader": "statically linked", "dynamic-library": "statically linked", "wrong-web": "Shared Web build identity mismatch" }[scenario];
        await expect(packaging).rejects.toThrow(expected);
        expect(existsSync(output)).toBe(false);
      }
      expect(existsSync(source.workspace)).toBe(false);
      expect(source.containerRead).toBe(["clean", "dirty", "revision", "docker-failure", "shared-web"].includes(scenario));
      expect(source.webBuilds).toBe(["existing", "shared-web", "wrong-web"].includes(scenario) ? 0 : 1);
      if (scenario === "wrong-web") expect(source.nativeBuilt).toBe(false);
    } finally {
      process.argv = previousArguments;
      stdout.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
