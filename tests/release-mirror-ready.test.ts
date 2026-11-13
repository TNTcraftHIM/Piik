import { expect, test, vi } from "vitest";
import { mirrorReadiness, readMirror } from "../scripts/release-mirror-ready.mjs";

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

test.each([null, { ...mirror, prerelease: true, assets: [] }])("a missing or pending mirror is ready without querying mirrored commits or tags", async pending => {
  const read = vi.fn(async (path: string) => {
    if (path !== `/releases/tags/${version}`) throw new Error("Mirrored source is irrelevant to release distribution");
    return pending;
  });
  expect(await mirrorReadiness(source, read)).toEqual({ status: "ready", version, revision });
  expect(read.mock.calls).toEqual([[`/releases/tags/${version}`]]);
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
