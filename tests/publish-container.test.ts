import { describe, expect, it, vi } from "vitest";

const { command, artifacts } = vi.hoisted(() => ({ command: vi.fn(), artifacts: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: command }));
vi.mock("../scripts/release-artifacts.mjs", () => ({ readReleaseArtifacts: artifacts }));

const version = "v1.2.1", revision = "a".repeat(40), digest = "b".repeat(64);
const repository = "TNTcraftHIM/Piik", image = `piik-candidate:${revision}`;
const tag = `ghcr.io/tntcrafthim/piik:${version}`;
type Scenario = { existing?: boolean; draft?: boolean; badArchive?: boolean;
  wrongSource?: boolean; wrongImage?: boolean; remoteMismatch?: boolean;
  registryError?: boolean; newerRelease?: boolean; largeCommit?: boolean };

async function publish(options: Scenario = {}) {
  vi.resetModules();
  artifacts.mockReturnValue({ files: [{ name: "piik-aaaaaaa-runtime.tar.gz", sha256: digest }] });
  command.mockReset().mockImplementation((program: string, args: string[]) => {
    if (program === "gh") {
      if (args[1].endsWith("/commits/" + version)) {
        const sha = options.wrongSource ? "c".repeat(40) : revision;
        if (args.includes("Accept: application/vnd.github.sha")) return sha;
        if (options.largeCommit) throw Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS" });
        return JSON.stringify({ sha });
      }
      if (args[1].endsWith("/releases/latest")) {
        return JSON.stringify({ tag_name: options.newerRelease ? "v1.3.0" : version });
      }
      return JSON.stringify({ draft: options.draft ?? false, prerelease: false,
        target_commitish: revision, assets: [{ name: "piik-aaaaaaa-runtime.tar.gz",
          digest: `sha256:${options.badArchive ? "c".repeat(64) : digest}` }] });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([{ Os: "linux", Architecture: "amd64", Config: { Labels: {
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": options.wrongImage || (options.remoteMismatch && args[2] === tag)
          ? "c".repeat(40) : revision,
        "tv.piik.server.sha256": digest,
      } } }]);
    }
    if (args[0] === "manifest" && (options.registryError || !options.existing)) {
      throw Object.assign(new Error("Registry failure"), {
        stderr: options.registryError ? "unauthorized: authentication required" : "manifest unknown",
      });
    }
    return "{}";
  });
  const argv = process.argv;
  vi.stubEnv("GITHUB_REPOSITORY", repository);
  process.argv = ["node", "publish-container.mjs", image, "artifacts", version, revision];
  try { await import("../scripts/publish-container.mjs"); }
  finally { process.argv = argv; vi.unstubAllEnvs(); }
}
const pushes = () => command.mock.calls.filter(([program, args]) => program === "docker" && args[0] === "push")
  .map(([, args]) => args[1]);

describe("container publication", () => {
  it("publishes the verified Server image with the GitHub version and latest", async () => {
    await publish();
    expect(artifacts).toHaveBeenCalledWith("artifacts", version, revision);
    expect(pushes()).toEqual([tag, "ghcr.io/tntcrafthim/piik:latest"]);
  });
  it.each([
    { draft: true }, { badArchive: true }, { wrongSource: true }, { wrongImage: true },
    { registryError: true }, { existing: true, remoteMismatch: true },
  ])("blocks invalid publication before pushing (%j)", async (options) => {
    await expect(publish(options)).rejects.toThrow();
    expect(pushes()).toEqual([]);
  });
  it("retains an existing version and cannot move latest backwards", async () => {
    await publish({ existing: true, newerRelease: true });
    expect(pushes()).toEqual([]);
  });
  it("checks tag identity without buffering a large commit's file patches", async () => {
    await publish({ largeCommit: true });
    expect(pushes()).toEqual([tag, "ghcr.io/tntcrafthim/piik:latest"]);
  });
});
