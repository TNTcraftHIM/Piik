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

const directory = mkdtempSync(join(tmpdir(), "piik-publisher-"));
const version = "v1.0.1", revision = "a".repeat(40);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
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

describe("Gitee mirror publication", () => {
  const marker = `<!-- piik-source: ${revision} -->`;
  const api = "https://gitee.com/api/v5/repos/TNTcraftHIM/Piik";
  const download = `https://gitee.com/TNTcraftHIM/Piik/releases/download/${version}/`;
  const sourceAssets = readdirSync(directory).map((name) => {
    const bytes = readFileSync(join(directory, name));
    return { name, size: bytes.length, digest: `sha256:${hash(bytes)}`, state: "uploaded" };
  });
  async function mirror(options: { existing?: "pending" | "published" | "unknown"; corrupt?: boolean;
    wrongSource?: boolean; wrongDigest?: boolean; missing?: boolean } = {}) {
    const mutations: string[] = [];
    const attachments = sourceAssets.map(({ name, size }) => ({ name, size, browser_download_url: download + name }));
    const present = options.existing === "pending" ? attachments.slice(0, 1) : options.missing ? [] : attachments;
    command.mockReturnValue(JSON.stringify({
      ...release(false), html_url: `https://github.com/TNTcraftHIM/Piik/releases/tag/${version}`,
      target_commitish: options.wrongSource ? "b".repeat(40) : revision,
      assets: options.wrongDigest ? sourceAssets.map((asset) => ({ ...asset, digest: "sha256:wrong" })) : sourceAssets,
    }));
    vi.stubEnv("GITEE_TOKEN", "fixture-mirror-token");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(download)) {
        expect(init?.headers).toBeUndefined();
        const file = url.slice(download.length);
        return new Response(options.corrupt ? "corrupt" : readFileSync(join(directory, file)));
      }
      expect(init?.headers).toHaveProperty("Authorization", "Bearer fixture-mirror-token");
      expect(init?.redirect).toBe("error");
      const path = url.slice(api.length);
      const method = init?.method ?? "GET";
      if (method !== "GET") mutations.push(`${method} ${path}`);
      if (path.startsWith("/releases/tags/")) return options.existing
        ? Response.json({ id: 42, tag_name: version, body: options.existing === "unknown" ? "unknown" : marker,
          prerelease: options.existing !== "published" }) : new Response(null, { status: 404 });
      if (path === "") return Response.json({ private: false, default_branch: "master" });
      if (path === "/releases" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.prerelease).toBe(true);
        expect(body.body).toContain(marker);
        return Response.json({ ...body, id: 42 });
      }
      if (path.includes("/attach_files?") && method === "GET") return Response.json(options.existing ? present : []);
      if (path.endsWith("/attach_files") && method === "POST") {
        const file = (init?.body as FormData).get("file") as File;
        expect(hash(Buffer.from(await file.arrayBuffer()))).toBe(hash(readFileSync(join(directory, file.name))));
        return Response.json(attachments.find((asset) => asset.name === file.name));
      }
      if (path === "/releases/42" && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        expect(body.prerelease).toBe(false);
        return Response.json({ ...body, id: 42 });
      }
      throw new Error(`Unexpected mirror request: ${method} ${path}`);
    }));
    const argv = process.argv;
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [process.execPath, "mirror-release.mjs", directory, version, revision];
    vi.resetModules();
    let failure: string | undefined;
    try {
      const script = "../scripts/mirror-release.mjs";
      await import(script);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      process.argv = argv;
      output.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
    return { mutations, failure };
  }

  it("copies the published bytes, verifies anonymous downloads and marks stable last", async () => {
    const result = await mirror();
    expect(result.failure).toBeUndefined();
    expect(result.mutations[0]).toBe("POST /releases");
    expect(result.mutations.at(-1)).toBe("PATCH /releases/42");
    expect(result.mutations.filter((value) => value.endsWith("/attach_files"))).toHaveLength(sourceAssets.length);
  });

  it("resumes pending uploads and leaves complete stable releases unchanged", async () => {
    const pending = await mirror({ existing: "pending" });
    expect(pending.failure).toBeUndefined();
    expect(pending.mutations.filter((value) => value.endsWith("/attach_files"))).toHaveLength(sourceAssets.length - 1);
    expect(await mirror({ existing: "published" })).toEqual({ mutations: [], failure: undefined });
  });

  it.each([{ wrongSource: true }, { wrongDigest: true }, { existing: "unknown" as const }])
    ("rejects mismatched provenance before mirror writes: %j", async (options) => {
      const result = await mirror(options);
      expect(result.failure).toBeDefined();
      expect(result.mutations).toEqual([]);
    });

  it("does not publish a corrupt upload or repair a published missing file", async () => {
    const corrupt = await mirror({ corrupt: true });
    expect(corrupt.failure).toMatch(/mismatch/);
    expect(corrupt.mutations).not.toContain("PATCH /releases/42");
    const incomplete = await mirror({ existing: "published", missing: true });
    expect(incomplete.failure).toContain("corrected new version");
    expect(incomplete.mutations).toEqual([]);
  });
});

async function publish(releases: Release[], tag: "absent" | "annotated" | "wrong" | "api-error",
  failureAt?: "notes" | "create") {
  const mutations: string[][] = [];
  const copy = "### 更新\n\n- Share `windows` and $literal text.\n";
  let notesPath: string | undefined;
  notes.mockImplementation(() => {
    if (failureAt === "notes") throw new Error("Missing release notes");
    return copy;
  });
  let published = releases.some((item) => item.tag_name === version && !item.draft);
  command.mockImplementation((_program, args) => {
    if (args[0] === "release") {
      mutations.push(args);
      if (args[1] === "create") {
        notesPath = args[args.indexOf("--notes-file") + 1];
        expect(readFileSync(notesPath, "utf8")).toBe(copy);
        expect(args).not.toContain("--generate-notes");
        if (failureAt === "create") throw new Error("GitHub create failed");
      }
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
    expect(result.mutations.find((args) => args[1] === "edit")).toContain("--latest=false");
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
