import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const { command } = vi.hoisted(() => ({ command: vi.fn<(program: string, args: string[]) => string>() }));
vi.mock("node:child_process", () => ({ execFileSync: command }));

const directory = mkdtempSync(join(tmpdir(), "piik-publisher-"));
const version = "v1.0.1", revision = "a".repeat(40);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
for (const target of ["server", "windows-amd64", "linux-amd64", "darwin-arm64"]) {
  const artifact = `${target}.tar.gz`;
  writeFileSync(join(directory, artifact), target);
  writeFileSync(join(directory, `${target}.release.json`), JSON.stringify({
    schema: 2, version, revision, artifact, artifactSha256: hash(target),
    ...(target === "server" ? { manifest: "server.manifest.tsv", manifestSha256: hash("manifest") } : { target }),
  }));
  if (target === "server") writeFileSync(join(directory, "server.manifest.tsv"), "manifest");
  else writeFileSync(join(directory, `${artifact}.sha256`), `${hash(target)}  ${artifact}\n`);
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const completeAssets = readdirSync(directory).map((name) => ({ name, state: "uploaded" }));
type Release = { tag_name: string; target_commitish: string; draft: boolean;
  prerelease: boolean; assets: typeof completeAssets };
const release = (draft: boolean): Release => ({
  tag_name: version, target_commitish: revision, draft, prerelease: false, assets: completeAssets,
});

async function publish(releases: Release[], tag: "absent" | "annotated" | "wrong" | "api-error") {
  const mutations: string[][] = [];
  let published = releases.some((item) => item.tag_name === version && !item.draft);
  command.mockImplementation((_program, args) => {
    if (args[0] === "release") {
      mutations.push(args);
      if (args[1] === "edit") published = true;
      return "";
    }
    if (args[1].includes("/matching-refs/")) {
      if (tag === "api-error") throw new Error("GitHub lookup failed");
      return JSON.stringify(tag === "absent" && !published ? [] : [{
        ref: `refs/tags/${version}`, object: tag === "annotated"
          ? { type: "tag", sha: "c".repeat(40) }
          : { type: "commit", sha: tag === "wrong" ? "b".repeat(40) : revision },
      }]);
    }
    if (args[1].includes("/git/tags/")) return JSON.stringify({ object: { type: "commit", sha: revision } });
    if (args[1].includes("/releases?")) return releases.map((item) => JSON.stringify(item)).join("\n");
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });
  const argv = process.argv;
  const exited = Symbol("successful exit");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw exited; });
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  process.argv = [process.execPath, "publish-release.mjs", directory, version, revision];
  vi.resetModules();
  let failure: string | undefined;
  try {
    const script = "../scripts/publish-release.mjs";
    await import(script);
  } catch (error) {
    if (error !== exited) failure = error instanceof Error ? error.message : String(error);
  } finally {
    process.argv = argv;
    exit.mockRestore();
    output.mockRestore();
  }
  return { failure, mutations };
}

describe("publisher recovery", () => {
  it.each(["wrong", "api-error"] as const)("stops before mutations for %s tag lookup", async (tag) => {
    const result = await publish([release(true)], tag);
    expect(result.failure).toMatch(/different source revision|lookup failed/);
    expect(result.mutations).toEqual([]);
  });

  it("accepts annotated tags and preserves a newer stable release when resuming an older draft", async () => {
    const result = await publish([release(true), { ...release(false), tag_name: "v1.1.0" }], "annotated");
    expect(result.failure).toBeUndefined();
    expect(result.mutations.find((args) => args[1] === "edit")).toContain("--latest=false");
  });

  it("creates a new release without a pre-existing tag and verifies the resulting tag", async () => {
    const result = await publish([], "absent");
    expect(result.failure).toBeUndefined();
    expect(result.mutations.find((args) => args[1] === "create")).toContain(revision);
    expect(result.mutations.find((args) => args[1] === "edit")).toContain("--latest=true");
  });

  it("leaves complete published releases unchanged and rejects incomplete published releases", async () => {
    const complete = await publish([release(false)], "annotated");
    expect(complete).toEqual({ failure: undefined, mutations: [] });
    const incomplete = await publish([{ ...release(false), assets: completeAssets.slice(1) }], "annotated");
    expect(incomplete.failure).toContain("publish a new version");
    expect(incomplete.mutations).toEqual([]);
  });
});
