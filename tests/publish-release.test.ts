import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const { command, notes } = vi.hoisted(() => ({
  command: vi.fn<(program: string, args: string[]) => string>(), notes: vi.fn<() => string>(),
}));
vi.mock("node:child_process", () => ({ execFileSync: command }));
vi.mock("../scripts/release-notes.mjs", () => ({ releaseNotes: notes }));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

const directory = mkdtempSync(join(tmpdir(), "silip-publisher-"));
const version = "v1.0.1", revision = "a".repeat(40);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
for (const target of ["server", "server-linux-arm64", "server-windows-amd64", "windows-amd64", "linux-amd64", "linux-arm64", "darwin-arm64", "darwin-amd64", "android-universal"]) {
  const server = target.startsWith("server");
  // The Windows Server package ships a ZIP; the Linux Server packages keep tar.gz.
  const archive = target === "android-universal" ? "apk" : target === "server-windows-amd64" ? "zip" : server ? "tar.gz" : "zip";
  const artifact = `${target}.${archive}`;
  writeFileSync(join(directory, artifact), target);
  writeFileSync(join(directory, `${target}.release.json`), JSON.stringify({
    schema: 2, version, revision, artifact, artifactSha256: hash(target),
    target, ...(server ? { manifest: `${target}.manifest.tsv`, manifestSha256: hash("manifest") } : {}),
  }));
  if (server) writeFileSync(join(directory, `${target}.manifest.tsv`), "manifest");
  else writeFileSync(join(directory, `${artifact}.sha256`), `${hash(target)}  ${artifact}\n`);
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const packageNames = readdirSync(directory).filter((name) => /\.(apk|zip|tar\.gz)$/.test(name));
const completeAssets = packageNames.map((name) => ({ name, state: "uploaded" }));
type Release = { tag_name: string; target_commitish: string; draft: boolean;
  prerelease: boolean; body?: string; assets: typeof completeAssets };
const release = (draft: boolean): Release => ({
  tag_name: version, target_commitish: revision, draft, prerelease: false, assets: completeAssets,
});

async function publish(releases: Release[], tag: "absent" | "annotated" | "wrong" | "api-error",
  failureAt?: "notes" | "create" | "upload", inspectBody?: (body: string) => void) {
  const mutations: string[][] = [];
  const copy = "### 更新\n\n- Share `windows` and $literal text.\n";
  let notesPath: string | undefined;
  notes.mockReset().mockImplementation(() => {
    if (failureAt === "notes") throw new Error("Missing release notes");
    return copy;
  });
  let published = releases.some((item) => item.tag_name === version && !item.draft);
  command.mockImplementation((_program, args) => {
    if (args[0] === "release") {
      mutations.push(args);
      if (args.includes("--notes-file")) {
        notesPath = args[args.indexOf("--notes-file") + 1];
        const body = readFileSync(notesPath, "utf8");
        if (args[1] === "create") expect(body.startsWith(copy)).toBe(true);
        expect(body).toContain(`<summary>构建与校验 / Build and checksums</summary>`);
        expect(body).toContain(`/commit/${revision})`);
        for (const name of packageNames) {
          expect(body).toContain(`${hash(readFileSync(join(directory, name)))}  ${name}\n`);
        }
        expect(body).not.toMatch(/\.release\.json|\.zip\.sha256|\.manifest\.tsv/);
        expect(args).not.toContain("--generate-notes");
        inspectBody?.(body);
        if (failureAt === "create") throw new Error("GitHub create failed");
      }
      if (args[1] === "edit" && args.includes("--draft=false")) published = true;
      if (args[1] === "upload") {
        expect(args.slice(args.indexOf("--clobber") + 1).sort())
          .toEqual(packageNames.map((name) => join(directory, name)).sort());
        if (failureAt === "upload") throw new Error("GitHub upload failed");
      }
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
    if (notesPath) expect(existsSync(notesPath)).toBe(false);
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
    expect(result.mutations.find((args) => args.includes("--draft=false"))).toContain("--latest=false");
  });

  it("refreshes draft checksums after rebuilding the same SHA while retaining reviewed prose", async () => {
    let draftBody = "";
    const initial = await publish([], "absent", "upload", body => { draftBody = body; });
    expect(initial.failure).toBe("GitHub upload failed");
    const names = ["windows-amd64.zip", "windows-amd64.release.json", "windows-amd64.zip.sha256"];
    const original = names.map(name => readFileSync(join(directory, name)));
    const oldDigest = hash(original[0]!);
    const newBytes = Buffer.from("rebuilt Windows archive at the same source SHA");
    const newDigest = hash(newBytes);
    try {
      writeFileSync(join(directory, names[0]!), newBytes);
      writeFileSync(join(directory, names[1]!), JSON.stringify({
        ...JSON.parse(original[1]!.toString()), artifactSha256: newDigest,
      }));
      writeFileSync(join(directory, names[2]!), `${newDigest}  ${names[0]}\n`);
      const reviewed = `Owner-edited introduction\n\n${draftBody}\nOwner-edited final note`;
      let updated = "";
      const resumed = await publish([{ ...release(true), body: reviewed }], "annotated", undefined,
        body => { updated = body; });
      expect(resumed.failure).toBeUndefined();
      expect(notes).not.toHaveBeenCalled();
      expect(updated).toBe(reviewed.replace(oldDigest, newDigest));
      expect(updated.match(/silip-build-checksums:start/g)).toHaveLength(1);
      const published = await publish([{ ...release(false), body: reviewed }], "annotated");
      expect(published).toEqual({ failure: undefined, mutations: [] });
    } finally {
      names.forEach((name, index) => writeFileSync(join(directory, name), original[index]!));
    }
  });

  it("rejects ambiguous draft checksum sections before modifying a release", async () => {
    const result = await publish([{ ...release(true), body: "Reviewed text\n<!-- silip-build-checksums:start -->" }], "annotated");
    expect(result.failure).toContain("ambiguous");
    expect(result.mutations).toEqual([]);
  });

  it("creates a new release without a pre-existing tag and verifies the resulting tag", async () => {
    const result = await publish([], "absent");
    expect(result.failure).toBeUndefined();
    expect(result.mutations.find((args) => args[1] === "create")).toContain(revision);
    expect(result.mutations.find((args) => args[1] === "edit")).toContain("--latest=true");
  });

  it("rejects missing public copy before writes and removes temporary notes after a failed create", async () => {
    expect(await publish([], "absent", "notes")).toEqual({ failure: "Missing release notes", mutations: [] });
    const failed = await publish([], "absent", "create");
    expect(failed.failure).toBe("GitHub create failed");
    expect(failed.mutations).toHaveLength(1);
    expect(failed.mutations[0][1]).toBe("create");
  });

  it("leaves complete published releases unchanged and rejects incomplete published releases", async () => {
    const complete = await publish([release(false)], "annotated");
    expect(complete).toEqual({ failure: undefined, mutations: [] });
    const incomplete = await publish([{ ...release(false), assets: completeAssets.slice(1) }], "annotated");
    expect(incomplete.failure).toContain("publish a new version");
    expect(incomplete.mutations).toEqual([]);
  });
});
