import { describe, expect, it, vi } from "vitest";

const { command, artifacts } = vi.hoisted(() => ({ command: vi.fn(), artifacts: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: command }));
vi.mock("../scripts/release-artifacts.mjs", () => ({ readReleaseArtifacts: artifacts }));

const version = "v1.2.1", revision = "a".repeat(40), digest = "b".repeat(64);
const repository = "TNTcraftHIM/Piik", image = `piik-candidate:${revision}`;
const tag = `ghcr.io/tntcrafthim/piik:${version}`;
const servers = ["amd64", "arm64"].map(arch => ({
  name: `piik-aaaaaaa-${arch}-runtime.tar.gz`, sha256: arch === "amd64" ? digest : "d".repeat(64), arch,
}));
type Scenario = { existing?: boolean; draft?: boolean; badArchive?: boolean;
  wrongSource?: boolean; wrongImage?: boolean; remoteMismatch?: boolean;
  registryError?: boolean; newerRelease?: boolean; largeCommit?: boolean;
  partial?: boolean; wrongPlatform?: boolean };

async function publish(options: Scenario = {}) {
  vi.resetModules();
  artifacts.mockReturnValue({ servers });
  const platforms = ["amd64", "arm64"];
  const index = { manifests: platforms.map(architecture => ({ platform: { os: "linux", architecture } })) };
  const manifests = new Map<string, object>();
  if (options.existing) manifests.set(tag, index);
  if (options.partial) manifests.set(`${tag}-arm64`, {});
  const images = new Map(servers.map(server => [`${image}-${server.arch}`, server.arch]));
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
        target_commitish: revision, assets: servers.map(server => ({ name: server.name,
          digest: `sha256:${options.badArchive && server.arch === "arm64" ? "c".repeat(64) : server.sha256}` })) });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const arch = images.get(args[2]);
      expect(arch).toBeDefined();
      const remote = args[2].startsWith("ghcr.io/");
      return JSON.stringify([{ Os: "linux", Architecture: options.wrongPlatform && arch === "arm64" ? "amd64" : arch, Config: { Labels: {
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": (options.wrongImage && arch === "arm64") || (options.remoteMismatch && remote)
          ? "c".repeat(40) : revision,
        "tv.piik.server.sha256": servers.find(server => server.arch === arch)!.sha256,
      } } }]);
    }
    if (args[0] === "manifest") {
      if (options.registryError || !manifests.has(args[2])) {
        throw Object.assign(new Error("Registry failure"), {
          stderr: options.registryError ? "unauthorized: authentication required" : "manifest unknown",
        });
      }
      return JSON.stringify(manifests.get(args[2]));
    }
    if (args[0] === "pull") images.set(args[3], args[2].slice("linux/".length));
    if (args[0] === "tag") images.set(args[2], images.get(args[1])!);
    if (args[0] === "push") manifests.set(args[1], {});
    if (args[0] === "buildx") manifests.set(args[4], index);
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
const indexes = () => command.mock.calls.filter(([program, args]) => program === "docker" && args[0] === "buildx")
  .map(([, args]) => args.slice(4));

describe("container publication", () => {
  it("publishes both verified Server images under one version and latest index", async () => {
    await publish();
    expect(artifacts).toHaveBeenCalledWith("artifacts", version, revision);
    expect(pushes()).toEqual([`${tag}-amd64`, `${tag}-arm64`]);
    expect(indexes()).toEqual([[tag, `${tag}-amd64`, `${tag}-arm64`], ["ghcr.io/tntcrafthim/piik:latest", tag]]);
  });
  it.each([
    { draft: true }, { badArchive: true }, { wrongSource: true }, { wrongImage: true },
    { registryError: true }, { existing: true, remoteMismatch: true },
    { partial: true, remoteMismatch: true }, { wrongPlatform: true },
  ])("blocks invalid publication before pushing (%j)", async (options) => {
    await expect(publish(options)).rejects.toThrow();
    expect(pushes()).toEqual([]);
    expect(indexes()).toEqual([]);
  });
  it("retains an existing version and cannot move latest backwards", async () => {
    await publish({ existing: true, newerRelease: true });
    expect(pushes()).toEqual([]);
    expect(indexes()).toEqual([]);
  });
  it("resumes a partial upload without replacing the verified platform", async () => {
    await publish({ partial: true });
    expect(pushes()).toEqual([`${tag}-amd64`]);
    expect(indexes()[0]).toEqual([tag, `${tag}-amd64`, `${tag}-arm64`]);
  });
  it("checks tag identity without buffering a large commit's file patches", async () => {
    await publish({ largeCommit: true });
    expect(pushes()).toEqual([`${tag}-amd64`, `${tag}-arm64`]);
  });
});
