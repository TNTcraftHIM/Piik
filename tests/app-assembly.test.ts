import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  revision: "a".repeat(40), built: false, finalState: "clean", output: "", machine: 0x3e,
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
    if (args[0] === "-xzf") {
      writeFileSync(join(args[args.indexOf("-C") + 1]!, "REVISION"), `${source.revision}\n`);
    } else if (args[0] === "build") {
      const executable = Buffer.alloc(64);
      if (source.machine > 0xffff) {
        executable.set([0xcf, 0xfa, 0xed, 0xfe]);
        executable.writeUInt32LE(source.machine, 4);
      } else {
        executable.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
        executable.writeUInt16LE(source.finalState === "wrong-architecture"
          ? (source.machine === 0x3e ? 0xb7 : 0x3e) : source.machine, 18);
      }
      writeFileSync(args[args.indexOf("-o") + 1]!, executable);
      source.built = true;
      if (source.finalState === "output-created") {
        mkdirSync(source.output);
        writeFileSync(join(source.output, "user.txt"), "keep");
      }
    } else if (!args.join(" ").includes("build:web")) {
      throw new Error(`Unexpected build operation: ${args.join(" ")}`);
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, cpSync: (...args: Parameters<typeof fs.cpSync>) => {
    if (source.finalState === "copy") {
      fs.writeFileSync(join(source.output, "partial"), "incomplete");
      throw new Error("copy interrupted");
    }
    return fs.cpSync(...args);
  } };
});
vi.mock("../scripts/package-licenses.mjs", () => ({ writeAppLicenseNotices: () => undefined }));

describe.each(["linux-amd64", "linux-arm64"])("App package source identity (%s)", (target) => {
  it.each(["clean", "nested", "dirty", "revision", "copy", "existing", "output-created", "wrong-architecture"])("exports only complete owned output from unchanged source (%s)", async (finalState) => {
    const root = mkdtempSync(join(tmpdir(), "piik-app-assembly-"));
    const output = join(root, ...(finalState === "nested" ? ["new-parent"] : []), "app");
    const descriptor = join(root, "server.release.json");
    const artifact = Buffer.from("fixture server archive");
    const previousArguments = process.argv;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("PIIK_GO", "piik-fixture-go");
    vi.stubEnv("VITE_PIIK_VERSION", "development");
    vi.stubEnv("VITE_PIIK_REVISION", "");
    source.built = false;
    source.finalState = finalState;
    source.output = output;
    source.machine = target === "linux-arm64" ? 0xb7 : 0x3e;
    try {
      if (finalState === "existing") {
        mkdirSync(output);
        writeFileSync(join(output, "user.txt"), "keep");
      }
      writeFileSync(join(root, "server.tar.gz"), artifact);
      writeFileSync(descriptor, JSON.stringify({
        schema: 2, version: "development", revision: source.revision,
        artifact: "server.tar.gz", artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      }));
      process.argv = [process.execPath, "assemble-app.mjs", descriptor, output, "--target", target];
      vi.resetModules();
      const assembly = import("../scripts/assemble-app.mjs");
      if (finalState === "clean" || finalState === "nested") {
        await assembly;
        expect(readFileSync(join(output, "REVISION"), "ascii")).toBe(`${source.revision}\n`);
        expect(existsSync(join(output, "piik-app"))).toBe(true);
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

it("assembles a macOS bundle that retains its executable and helpers when moved alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "piik-mac-bundle-"));
  const output = join(root, "archive");
  const descriptor = join(root, "server.release.json");
  const artifact = Buffer.from("fixture server archive");
  const previousArguments = process.argv;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  source.built = false;
  source.finalState = "clean";
  source.output = output;
  source.machine = 0x0100000c;
  try {
    // The external Go build is a Mach-O fixture; test package assembly on any runner.
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const helper = Buffer.alloc(64);
    helper.set([0xcf, 0xfa, 0xed, 0xfe]);
    helper.writeUInt32LE(source.machine, 4);
    writeFileSync(join(root, "helper"), helper);
    writeFileSync(join(root, "server.tar.gz"), artifact);
    writeFileSync(descriptor, JSON.stringify({
      schema: 2, version: "development", revision: source.revision,
      artifact: "server.tar.gz", artifactSha256: createHash("sha256").update(artifact).digest("hex"),
    }));
    process.argv = [process.execPath, "assemble-app.mjs", descriptor, output, "--target", "darwin-arm64",
      "--capture", join(root, "helper"), "--tunnel", join(root, "helper")];
    vi.resetModules();
    await import("../scripts/assemble-app.mjs");
    const relocated = join(root, "Moved Piik.app");
    renameSync(join(output, "Piik App.app"), relocated);
    const contents = join(relocated, "Contents");
    const plist = readFileSync(join(contents, "Info.plist"), "utf8");
    const entry = plist.match(/<key>CFBundleExecutable<\/key><string>([^<]+)<\/string>/)![1]!;
    const executable = join(contents, "MacOS", entry);
    expect(readFileSync(executable).subarray(0, 4)).toEqual(helper.subarray(0, 4));
    for (const path of ["runtime/native/piik-capture", "runtime/tunnel/cloudflared"]) {
      expect(readFileSync(join(contents, "MacOS", path))).toEqual(helper);
    }
    expect(readFileSync(join(contents, "MacOS", "REVISION"), "ascii").trim()).toBe(source.revision);
    expect(existsSync(join(output, "piik-app"))).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.argv = previousArguments;
    stdout.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
