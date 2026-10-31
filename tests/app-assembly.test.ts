import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  revision: "a".repeat(40), built: false, finalState: "clean", output: "", machine: 0x3e,
  cargoTarget: "", web: "",
}));

// Exercise the actual assembler and final export. Only external build tools,
// Git observations and license generation are replaced by the fixture.
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") {
      return source.built && source.finalState === "revision" ? "b".repeat(40) : source.revision;
    }
    if (args[0] === "status") {
      return source.built && source.finalState === "dirty" ? " M README.md\n" : "";
    }
    throw new Error(`Unexpected Git observation: ${args.join(" ")}`);
  },
  spawnSync: (_command: string, args: string[]) => {
    if (args[0] === "+1.91.0" && args[1] === "build") {
      const executable = Buffer.alloc(64);
      if (source.machine > 0xffff) {
        executable.set([0xcf, 0xfa, 0xed, 0xfe]);
        executable.writeUInt32LE(source.machine, 4);
      } else {
        executable.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
        executable.writeUInt16LE(source.finalState === "wrong-architecture"
          ? (source.machine === 0x3e ? 0xb7 : 0x3e) : source.machine, 18);
      }
      const directory = join(source.cargoTarget, args[args.indexOf("--target") + 1]!, "release");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "piik-channel-app"), executable);
      source.built = true;
      if (source.finalState === "output-created") {
        mkdirSync(source.output);
        writeFileSync(join(source.output, "user.txt"), "keep");
      }
    } else {
      throw new Error(`Unexpected build operation: ${args.join(" ")}`);
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, cpSync: (...args: Parameters<typeof fs.cpSync>) => {
    if (String(args[0]).endsWith("channel-web")) {
      return fs.cpSync(source.web, args[1], args[2]);
    }
    if (source.finalState === "copy") {
      fs.writeFileSync(join(source.output, "partial"), "incomplete");
      throw new Error("copy interrupted");
    }
    return fs.cpSync(...args);
  } };
});
vi.mock("../scripts/package-licenses.mjs", () => ({ writeAppLicenseNotices: () => undefined }));
vi.mock("../scripts/build-channel-web.mjs", () => ({
  buildChannelWeb: (root: string) => join(root, "build", "channel-web"),
}));
vi.mock("../scripts/release-version.mjs", () => ({ buildVersion: () => "development" }));
vi.mock("../scripts/app-package-targets.mjs", async (original) => {
  const targets = await original<typeof import("../scripts/app-package-targets.mjs")>();
  return { ...targets, appPackageTarget: (id: string) => {
    const target = targets.appPackageTarget(id);
    return target && { ...target, nodePlatform: process.platform, nodeArch: process.arch };
  } };
});

describe.each(["linux-amd64", "linux-arm64"])("App package source identity (%s)", (target) => {
  it.each(["clean", "nested", "dirty", "revision", "copy", "existing", "output-created", "wrong-architecture"])("exports only complete owned output from unchanged source (%s)", async (finalState) => {
    const root = mkdtempSync(join(tmpdir(), "piik-app-assembly-"));
    const output = join(root, ...(finalState === "nested" ? ["new-parent"] : []), "app");
    const previousArguments = process.argv;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    source.cargoTarget = join(root, "target");
    source.web = join(root, "web");
    mkdirSync(source.web);
    writeFileSync(join(source.web, "index.html"), "fixture web");
    vi.stubEnv("CARGO_TARGET_DIR", source.cargoTarget);
    source.built = false;
    source.finalState = finalState;
    source.output = output;
    source.machine = target === "linux-arm64" ? 0xb7 : 0x3e;
    try {
      if (finalState === "existing") {
        mkdirSync(output);
        writeFileSync(join(output, "user.txt"), "keep");
      }
      process.argv = [process.execPath, "assemble-app.mjs", output, "--target", target];
      vi.resetModules();
      const assembly = import("../scripts/assemble-app.mjs");
      if (finalState === "clean" || finalState === "nested") {
        await assembly;
        expect(readFileSync(join(output, "REVISION"), "ascii")).toBe(`${source.revision}\n`);
        expect(existsSync(join(output, "piik-app"))).toBe(true);
        expect(readFileSync(join(output, "web", "index.html"), "utf8")).toBe("fixture web");
        expect(existsSync(join(output, "runtime", "native"))).toBe(false);
      } else if (finalState === "existing" || finalState === "output-created") {
        await expect(assembly).rejects.toThrow(finalState === "existing" ? "must not already exist" : "EEXIST");
        expect(readFileSync(join(output, "user.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(output, "piik-app"))).toBe(false);
      } else if (finalState === "copy") {
        await expect(assembly).rejects.toThrow("copy interrupted");
        expect(existsSync(output)).toBe(false);
      } else if (finalState === "wrong-architecture") {
        await expect(assembly).rejects.toThrow(`App executable does not match App package target ${target}`);
        expect(existsSync(output)).toBe(false);
      } else {
        await expect(assembly).rejects.toThrow(finalState === "dirty" ? "clean Git checkout" : "package source");
        expect(existsSync(output)).toBe(false);
      }
      expect(source.built).toBe(finalState !== "existing");
    } finally {
      process.argv = previousArguments;
      stdout.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("assembles a macOS bundle that retains its executable, frontend and tunnel when moved alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "piik-mac-bundle-"));
  const output = join(root, "archive");
  const previousArguments = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  source.built = false;
  source.finalState = "clean";
  source.output = output;
  source.machine = 0x0100000c;
  source.cargoTarget = join(root, "target");
  source.web = join(root, "web");
  mkdirSync(source.web);
  writeFileSync(join(source.web, "index.html"), "fixture web");
  vi.stubEnv("CARGO_TARGET_DIR", source.cargoTarget);
  try {
    const helper = Buffer.alloc(64);
    helper.set([0xcf, 0xfa, 0xed, 0xfe]);
    helper.writeUInt32LE(source.machine, 4);
    writeFileSync(join(root, "helper"), helper);
    process.argv = [process.execPath, "assemble-app.mjs", output, "--target", "darwin-arm64",
      "--tunnel", join(root, "helper")];
    vi.resetModules();
    await import("../scripts/assemble-app.mjs");
    const relocated = join(root, "Moved Piik.app");
    renameSync(join(output, "Piik App.app"), relocated);
    const contents = join(relocated, "Contents");
    const plist = readFileSync(join(contents, "Info.plist"), "utf8");
    const entry = plist.match(/<key>CFBundleExecutable<\/key><string>([^<]+)<\/string>/)![1]!;
    const executable = join(contents, "MacOS", entry);
    expect(readFileSync(executable).subarray(0, 4)).toEqual(helper.subarray(0, 4));
    expect(readFileSync(join(contents, "MacOS", "runtime/tunnel/cloudflared"))).toEqual(helper);
    expect(readFileSync(join(contents, "MacOS", "web/index.html"), "utf8")).toBe("fixture web");
    expect(existsSync(join(contents, "MacOS", "runtime/native"))).toBe(false);
    expect(readFileSync(join(contents, "MacOS", "REVISION"), "ascii").trim()).toBe(source.revision);
    expect(existsSync(join(output, "piik-app"))).toBe(false);
  } finally {
    process.argv = previousArguments;
    stdout.mockRestore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
