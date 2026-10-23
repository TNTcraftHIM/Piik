import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  revision: "a".repeat(40), workspace: "", output: "", scenario: "", assembled: false,
  sdkDownloads: 0, assembledGamepad: undefined as string | undefined,
}));

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return source.revision;
    if (args[0] === "status") return source.scenario === "dirty" ? " M native/capture/windows/main.cpp\n" : "";
    throw new Error(`Unexpected Git observation: ${args.join(" ")}`);
  },
  spawnSync: (_command: string, args: string[]) => {
    if (!args[0]?.endsWith("assemble-app.mjs")) throw new Error(`Unexpected command: ${args.join(" ")}`);
    mkdirSync(args[2]!);
    source.assembled = true;
    const gamepadArgument = args.indexOf("--gamepad-client");
    source.assembledGamepad = gamepadArgument >= 0 ? args[gamepadArgument + 1] : undefined;
    if (source.scenario === "output-created") {
      mkdirSync(source.output);
      writeFileSync(join(source.output, "user.txt"), "keep");
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));
vi.mock("../scripts/app-package-targets.mjs", () => ({
  CLOUDFLARED_VERSION: "fixture",
  appPackageTarget: () => ({
    id: source.scenario.startsWith("windows-") ? "windows-amd64" : "fixture",
    nodePlatform: process.platform, nodeArch: process.arch,
    captureName: null, tunnelName: "fixture-tunnel", tunnelAsset: "fixture-tunnel",
    tunnelSha256: createHash("sha256").update("fixture tunnel").digest("hex"),
  }),
}));
vi.mock("../scripts/gamepad-client.mjs", () => ({
  GAMEPAD_CLIENT_SHA256: "fixture",
  downloadGamepadClient: async (workspace: string) => {
    source.sdkDownloads++;
    return join(workspace, "downloaded-client.dll");
  },
}));
vi.mock("../scripts/build-workspace.mjs", async (original) => ({
  ...await original<typeof import("../scripts/build-workspace.mjs")>(),
  resetBuildWorkspace: () => { mkdirSync(source.workspace); return source.workspace; },
}));
vi.mock("../scripts/archive-tool.mjs", () => ({
  createZip: (_root: string, archive: string) => {
    writeFileSync(archive, "incomplete archive");
    throw new Error("archive interrupted");
  },
  extractZip: () => { throw new Error("incomplete archive must not be extracted"); },
  tarExecutable: () => "fixture-tar",
}));

it.each(["archive-failure", "existing", "output-created", "dirty", "windows-default", "windows-override"] as const)(
  "cleans only this App candidate's incomplete output (%s)", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "piik-app-candidate-"));
    const server = join(root, "server");
    const output = join(root, "output");
    const previousArguments = process.argv;
    source.workspace = join(root, "workspace");
    source.output = output;
    source.scenario = scenario;
    source.assembled = false;
    source.sdkDownloads = 0;
    source.assembledGamepad = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture tunnel")));
    try {
      mkdirSync(server);
      writeFileSync(join(server, "server.release.json"), JSON.stringify({ version: "development" }));
      if (scenario === "existing") {
        mkdirSync(output);
        writeFileSync(join(output, "user.txt"), "keep");
      }
      process.argv = [process.execPath, "package-app-candidate.mjs", server, "fixture", output];
      const override = join(root, "local-client.dll");
      if (scenario === "windows-override") {
        writeFileSync(override, "fixed local SDK fixture");
        process.argv.push("--gamepad-client", override);
      }
      vi.resetModules();
      const candidate = import("../scripts/package-app-candidate.mjs");
      const expected = { "archive-failure": "archive interrupted", existing: "must not already exist",
        "output-created": "EEXIST", dirty: "clean Git checkout",
        "windows-default": "archive interrupted", "windows-override": "archive interrupted" }[scenario];
      await expect(candidate).rejects.toThrow(expected);
      if (scenario === "existing" || scenario === "output-created") {
        expect(readFileSync(join(output, "user.txt"), "utf8")).toBe("keep");
      } else {
        expect(existsSync(output)).toBe(false);
      }
      expect(source.assembled).toBe(scenario === "archive-failure" || scenario === "output-created" || scenario.startsWith("windows-"));
      expect(source.sdkDownloads).toBe(scenario === "windows-default" ? 1 : 0);
      expect(source.assembledGamepad).toBe(scenario === "windows-default"
        ? join(source.workspace, "downloaded-client.dll")
        : scenario === "windows-override" ? override : undefined);
      expect(existsSync(source.workspace)).toBe(false);
    } finally {
      process.argv = previousArguments;
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
