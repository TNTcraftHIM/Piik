import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({
  revision: "a".repeat(40), workspace: "", output: "", scenario: "", assembled: false,
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
    mkdirSync(args[1]!);
    source.assembled = true;
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
    id: "fixture", nodePlatform: process.platform, nodeArch: process.arch,
    tunnelName: "fixture-tunnel", tunnelAsset: "fixture-tunnel",
    tunnelSha256: createHash("sha256").update("fixture tunnel").digest("hex"),
  }),
}));
vi.mock("../scripts/release-version.mjs", () => ({ buildVersion: () => "development" }));
vi.mock("../scripts/process-shutdown.mjs", () => ({
  spawnProcess: () => { throw new Error("Incomplete archive must not launch the App"); },
  requestShutdown: () => undefined,
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

it.each(["archive-failure", "existing", "output-created", "dirty", "local-asset", "local-asset-digest"] as const)(
  "cleans only this App candidate's incomplete output (%s)", async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "piik-app-candidate-"));
    const output = join(root, "output");
    const previousArguments = process.argv;
    source.workspace = join(root, "workspace");
    source.output = output;
    source.scenario = scenario;
    source.assembled = false;
    const fetch = vi.fn(async () => new Response("fixture tunnel"));
    vi.stubGlobal("fetch", fetch);
    try {
      if (scenario === "existing") {
        mkdirSync(output);
        writeFileSync(join(output, "user.txt"), "keep");
      }
      process.argv = [process.execPath, "package-app-candidate.mjs", "fixture", output];
      const localAsset = join(root, "downloaded-tunnel");
      if (scenario.startsWith("local-asset")) {
        writeFileSync(localAsset, scenario === "local-asset-digest" ? "wrong release" : "fixture tunnel");
        process.argv.push("--tunnel-asset", localAsset);
      }
      vi.resetModules();
      const candidate = import("../scripts/package-app-candidate.mjs");
      const expected = { "archive-failure": "archive interrupted", existing: "must not already exist",
        "output-created": "EEXIST", dirty: "clean Git checkout",
        "local-asset": "archive interrupted", "local-asset-digest": "does not match the pinned release" }[scenario];
      await expect(candidate).rejects.toThrow(expected);
      if (scenario === "existing" || scenario === "output-created") {
        expect(readFileSync(join(output, "user.txt"), "utf8")).toBe("keep");
      } else {
        expect(existsSync(output)).toBe(false);
      }
      expect(source.assembled).toBe(["archive-failure", "output-created", "local-asset"].includes(scenario));
      expect(fetch).toHaveBeenCalledTimes(["archive-failure", "output-created"].includes(scenario) ? 1 : 0);
      if (scenario.startsWith("local-asset")) {
        expect(readFileSync(localAsset, "utf8")).toBe(scenario === "local-asset-digest" ? "wrong release" : "fixture tunnel");
      }
      expect(existsSync(source.workspace)).toBe(false);
    } finally {
      process.argv = previousArguments;
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
