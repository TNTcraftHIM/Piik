import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  revision: "a".repeat(40), workspace: "", scenario: "", containerRead: false,
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
  spawnSync: (command: string, args: string[]) => {
    let stdout = "";
    if (command === "docker") {
      source.containerRead = true;
      if (source.scenario === "docker-failure") return { status: 1, stderr: "container failed" };
    } else if (args[0] === "build") {
      writeFileSync(args[args.indexOf("-o") + 1]!, "fixture Server");
    } else if (args[0] === "-czf") {
      writeFileSync(args[1]!, "fixture archive");
      if (source.scenario === "archive-failure") return { status: 1, stderr: "archive interrupted" };
    } else if (args[0] === "-tzf") {
      stdout = "LICENSE\nREVISION\nTHIRD-PARTY-NOTICES.txt\npiik-server\n";
    } else if (args[0] === "-xzf") {
      cpSync(join(source.workspace, "runtime"), args[args.indexOf("-C") + 1]!, { recursive: true });
    } else if (!args.join(" ").includes("build:web")) {
      throw new Error(`Unexpected build operation: ${command} ${args.join(" ")}`);
    }
    return { status: 0, stdout, stderr: "" };
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => String(args[0]).replaceAll("\\", "/").endsWith("/webassets/dist/index.html")
      ? '<script src="/assets/index-fixture.js"></script>' : fs.readFileSync(...args),
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) => String(path).endsWith("index-fixture.js") || fs.existsSync(path),
  };
});
vi.mock("../scripts/build-workspace.mjs", async (original) => ({
  ...await original<typeof import("../scripts/build-workspace.mjs")>(),
  resetBuildWorkspace: () => { mkdirSync(source.workspace); return source.workspace; },
}));
vi.mock("../scripts/package-licenses.mjs", () => ({
  writeServerLicenseNotices: (_root: string, path: string) => writeFileSync(path, "fixture notices"),
}));
vi.mock("../scripts/release-version.mjs", () => ({ buildVersion: () => "development" }));
vi.mock("../scripts/archive-tool.mjs", () => ({ tarExecutable: () => "fixture-tar" }));

it.each(["clean", "dirty", "revision", "docker-failure", "archive-failure", "existing"] as const)(
  "exports a Server release only after all tracked inputs are settled (%s)", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "piik-server-package-"));
    const output = join(root, "release");
    const previousArguments = process.argv;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("VITE_PIIK_VERSION", "development");
    vi.stubEnv("VITE_PIIK_REVISION", "");
    source.workspace = join(root, "workspace");
    source.scenario = scenario;
    source.containerRead = false;
    try {
      if (scenario === "existing") {
        mkdirSync(output);
        writeFileSync(join(output, "user.txt"), "keep");
      }
      process.argv = [process.execPath, "package-server-release.mjs", output, "--container-image", "piik-fixture:test"];
      vi.resetModules();
      const packaging = import("../scripts/package-server-release.mjs");
      if (scenario === "clean") {
        await packaging;
        const descriptor = JSON.parse(readFileSync(join(output, "piik-aaaaaaa.release.json"), "utf8"));
        expect(descriptor.revision).toBe(source.revision);
        expect(existsSync(join(output, descriptor.artifact))).toBe(true);
      } else if (scenario === "existing") {
        await expect(packaging).rejects.toThrow("must not already exist");
        expect(readFileSync(join(output, "user.txt"), "utf8")).toBe("keep");
      } else {
        const expected = { dirty: "clean Git checkout", revision: "package source",
          "docker-failure": "container failed", "archive-failure": "archive interrupted" }[scenario];
        await expect(packaging).rejects.toThrow(expected);
        expect(existsSync(output)).toBe(false);
      }
      expect(existsSync(source.workspace)).toBe(false);
      expect(source.containerRead).toBe(scenario !== "existing" && scenario !== "archive-failure");
    } finally {
      process.argv = previousArguments;
      stdout.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
