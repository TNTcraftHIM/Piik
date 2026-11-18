import { expect, test, vi } from "vitest";
import { mirrorReadiness, readMirror } from "../scripts/release-mirror-ready.mjs";
import { prepareMirror, prepareMirrorRelease } from "../scripts/release-mirror-prepare.mjs";

const revision = "a".repeat(40), version = "v2.6.1";
const asset = { name: "piik-app-fixture.zip", state: "uploaded", size: 1024, digest: `sha256:${"b".repeat(64)}` };
const source = { tag_name: version, target_commitish: revision, draft: false, prerelease: false, assets: [asset] };
const mirror = { tag_name: version, prerelease: false, body: `<!-- piik-source: ${revision} -->`, assets: [{
  type: "attach", name: asset.name, size: asset.size, browser_download_url: `https://atomgit.com/TNTcraftHIM/Piik/releases/download/${version}/${asset.name}`,
}, ...["zip", "tar.gz", "tar.bz2", "tar"].map(extension => ({ type: "source", name: `${version}.${extension}` }))] };

test("a completed stable mirror needs only its metadata and no source search or package download", async () => {
  const read = vi.fn(async () => mirror);
  expect(await mirrorReadiness(source, read)).toEqual({ status: "complete", version, revision });
  expect(read.mock.calls).toEqual([[`/releases/tags/${version}`]]);
});

test("signed releases require both original update attachments in the completed mirror", async () => {
  const updates = ["update.json", "update.json.sig"].map(name => ({ ...asset, name }));
  const signedSource = { ...source, assets: [...source.assets, ...updates] };
  await expect(mirrorReadiness(signedSource, async () => mirror)).rejects.toThrow("incomplete");
  await expect(mirrorReadiness({ ...source, assets: [...source.assets, updates[0]!] }, async () => mirror)).rejects.toThrow("metadata is incomplete");
  expect(await mirrorReadiness(signedSource, async () => ({ ...mirror, assets: [...mirror.assets,
    ...updates.map(update => ({ type: "attach", name: update.name, size: update.size,
      browser_download_url: `https://atomgit.com/TNTcraftHIM/Piik/releases/download/${version}/${update.name}` })),
  ] }))).toEqual({ status: "complete", version, revision });
});

test.each([
  { digest: asset.digest, complete: true },
  { digest: asset.digest.slice("sha256:".length), complete: true },
  { digest: "", complete: false },
  { digest: `sha256:${"c".repeat(64)}`, complete: false },
])("checks declared AtomGit digests even for matching names and sizes ($digest)", async ({ digest, complete }) => {
  const [attachment, ...archives] = mirror.assets;
  const result = mirrorReadiness(source, async () => ({ ...mirror, assets: [{ ...attachment, digest }, ...archives] }));
  if (complete) await expect(result).resolves.toEqual({ status: "complete", version, revision });
  else await expect(result).rejects.toThrow("Published mirror is incomplete");
});

test("a pending mirror resumes without querying mirrored commits or tags", async () => {
  const read = vi.fn(async () => ({ ...mirror, prerelease: true, assets: [] }));
  expect(await mirrorReadiness(source, read)).toEqual({ status: "ready", version, revision });
  expect(read.mock.calls).toEqual([[`/releases/tags/${version}`]]);
});

test("read-only readiness never creates a missing release", async () => {
  const read = vi.fn(async () => null);
  expect(await mirrorReadiness(source, read)).toEqual({ status: "ready", version, revision });
  expect(read.mock.calls).toEqual([[`/releases/tags/${version}`]]);
});

test("publication preparation uses the mirror branch and preserves the independent GitHub source marker", async () => {
  const read = vi.fn(async (path: string, method?: string, body?: Record<string, unknown>) => {
    if (path === `/releases/tags/${version}`) return null;
    if (path === "") return { private: false, default_branch: "main" };
    expect(path).toBe("/releases");
    expect(method).toBe("POST");
    expect(body).toMatchObject({ tag_name: version, target_commitish: "main", release_status: "pre" });
    expect(body!.body).toContain(`<!-- piik-source: ${revision} -->`);
    expect(body!.body).toContain(`https://github.com/TNTcraftHIM/Piik/commit/${revision}`);
    return { ...mirror, prerelease: true, body: body!.body, assets: [] };
  });
  expect(await prepareMirror(source, read)).toEqual({ status: "ready", version, revision });
  expect(read).toHaveBeenCalledTimes(4);
});

test("a platform tag rejection fails readiness before artifact downloads", async () => {
  const read = vi.fn(async (_path: string, method?: string) => {
    if (method === "POST") throw new Error("image repository");
    if (_path === "") return { private: false, default_branch: "main" };
    return null;
  });
  await expect(prepareMirror(source, read)).rejects.toThrow("image repository");
  expect(read).toHaveBeenCalledTimes(4);
});

test.each([mirror, { ...mirror, prerelease: true, assets: [] }])("preparation reuses existing releases without writes", async existing => {
  const request = vi.fn(async (_path: string, _method?: string) => existing);
  await prepareMirror(source, request);
  expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
});

test("preparation rejects an unknown source and an unexpected create result", async () => {
  const request = vi.fn(async (path: string) => path === "" ? { private: false, default_branch: "main" } : null);
  await expect(prepareMirrorRelease({ ...source, target_commitish: "main" }, request)).rejects.toThrow("full source SHA");
  expect(request).not.toHaveBeenCalled();
  await expect(prepareMirrorRelease(source, request)).rejects.toThrow("did not confirm the prepared prerelease");
});

test("preparation reports the platform rejection without logging its token or retrying the write", async () => {
  vi.stubEnv("ATOMGIT_TOKEN", "fixture-private-token");
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return Response.json({ message: "image repository fixture-private-token" }, { status: 400 });
    if (url.endsWith(`/releases/tags/${version}`)) return new Response(null, { status: 404 });
    return Response.json({ private: false, default_branch: "main" });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(prepareMirror(source)).rejects.toThrow("image repository [redacted]");
    const writes = fetch.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(1);
    const body = JSON.parse(writes[0][1]!.body as string);
    expect(body).toMatchObject({ target_commitish: "main", release_status: "pre" });
    expect(body.body).toContain(`<!-- piik-source: ${revision} -->`);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

test("preparation authenticates the repository GET while public readiness stays anonymous", async () => {
  vi.stubEnv("ATOMGIT_TOKEN", "fixture-private-token");
  const origin = "https://api.atomgit.com/api/v5/repos/TNTcraftHIM/Piik";
  const requests: { url: string; token: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const token = new Headers(options?.headers).get("PRIVATE-TOKEN");
    requests.push({ url, token });
    if (url === origin) {
      return token === "fixture-private-token" ? Response.json({ private: false, default_branch: "main" })
        : Response.json({ message: "Authentication required" }, { status: 401 });
    }
    if (options?.method === "POST") return Response.json({ ...mirror, prerelease: true, assets: [] });
    return new Response(null, { status: 404 });
  }));
  try {
    expect(await mirrorReadiness(source)).toEqual({ status: "ready", version, revision });
    expect(requests).toEqual([{ url: `${origin}/releases/tags/${version}`, token: null }]);
    expect(await prepareMirror(source)).toEqual({ status: "ready", version, revision });
    expect(requests.find(request => request.url === origin)?.token).toBe("fixture-private-token");
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

test("a missing attachment or conflicting source marker fails rather than claiming a completed mirror", async () => {
  await expect(mirrorReadiness(source, async () => ({ ...mirror, assets: [] }))).rejects.toThrow("incomplete");
  await expect(mirrorReadiness(source, async () => ({ ...mirror, body: `<!-- piik-source: ${"c".repeat(40)} -->` }))).rejects.toThrow("different or unknown source revision");
});

test("a provider source archive cannot stand in for a published package", async () => {
  await expect(mirrorReadiness(source, async () => ({ ...mirror,
    assets: mirror.assets.map(asset => ({ ...asset, type: "source" })),
  }))).rejects.toThrow("incomplete");
});

test.each([{ ...source, draft: true }, { ...source, prerelease: true }, { ...source, target_commitish: "main" }])("GitHub published source identity remains required before any mirror lookup", async invalid => {
  const read = vi.fn();
  await expect(mirrorReadiness(invalid, read)).rejects.toThrow("published GitHub release");
  expect(read).not.toHaveBeenCalled();
});

test("readiness treats an unavailable API as failure, not an absent or completed mirror", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  try { await expect(mirrorReadiness(source, readMirror)).rejects.toThrow("HTTP 503"); }
  finally { vi.unstubAllGlobals(); }
});
