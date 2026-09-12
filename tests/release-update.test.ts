import { describe, expect, it, vi } from "vitest";
import {
  checkReleaseUpdate, DEFAULT_RELEASE_API_URL, MIRROR_RELEASE_API_URL,
  parseMirrorReleaseMetadata, parseReleaseMetadata, releaseUpdateNotice,
} from "../src/client/lib/release-update";
import mirrorReleases from "./fixtures/mirror-releases.json";

const currentRevision = "a".repeat(40);
const latestRevision = "b".repeat(40);
const release = {
  tag_name: "v1.2.0",
  target_commitish: latestRevision,
  html_url: "https://github.com/TNTcraftHIM/Piik/releases/tag/v1.2.0",
};
const packageAsset = (target: string, suffix = "") => {
  const name = `piik-app-${target}${suffix}.zip`;
  return { name, size: 1024, state: "uploaded",
    browser_download_url: `https://github.com/TNTcraftHIM/Piik/releases/download/${release.tag_name}/${name}` };
};

describe("App release update notice", () => {
  it.each(["windows-amd64", "darwin-arm64", "linux-amd64"])("links the published %s ZIP without downloading it during the check", async (packageTarget) => {
    const assets = ["windows-amd64", "darwin-arm64", "linux-amd64"].map(target => packageAsset(target));
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...release, assets }));
    await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision }, { fetchImpl, packageTarget }))
      .resolves.toMatchObject({ kind: "update-available", version: release.tag_name,
        url: assets.find(asset => asset.name === `piik-app-${packageTarget}.zip`)!.browser_download_url });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(DEFAULT_RELEASE_API_URL);
  });

  it("uses a listed older SHA-suffixed ZIP and prefers the fixed name when both exist", () => {
    const older = packageAsset("windows-amd64", `-${latestRevision.slice(0, 7)}`);
    expect(parseReleaseMetadata({ ...release, assets: [older] }, "windows-amd64")?.url)
      .toBe(older.browser_download_url);
    const current = packageAsset("windows-amd64");
    expect(parseReleaseMetadata({ ...release, assets: [older, current] }, "windows-amd64")?.url)
      .toBe(current.browser_download_url);
  });

  it("keeps the release page when a matching safe ZIP is missing, without trying another provider", async () => {
    const asset = packageAsset("windows-amd64");
    for (const assets of [[], [packageAsset("linux-amd64")], [packageAsset("windows-amd64", "-aaaaaaa")],
      [{ ...asset, state: "new" }], [{ ...asset, size: 0 }], [{ ...asset, size: undefined }], [asset, asset],
      [{ ...asset, browser_download_url: asset.browser_download_url.replace("github.com", "evil.example") }],
      [{ ...asset, browser_download_url: asset.browser_download_url.replace("v1.2.0", "v1.1.0") }],
    ]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ...release, assets }));
      await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision },
        { fetchImpl, packageTarget: "windows-amd64" })).resolves.toMatchObject({ url: release.html_url });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect(parseReleaseMetadata({ ...release, assets: [asset] }, "windows-386")?.url).toBe(release.html_url);
    expect(parseReleaseMetadata({ ...release, assets: [asset] })?.url).toBe(release.html_url);
  });

  it.each(["windows-amd64", "darwin-arm64", "linux-amd64"])("uses a listed mirror %s ZIP only after the existing primary check fails", async (packageTarget) => {
    const name = `piik-app-${packageTarget}.zip`;
    const mirrorAsset = { name,
      browser_download_url: `https://gitee.com/TNTcraftHIM/Piik/releases/download/${release.tag_name}/${name}` };
    const mirrored = { tag_name: release.tag_name, prerelease: false,
      body: `<!-- piik-source: ${latestRevision} -->`, assets: [mirrorAsset] };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => String(input) === DEFAULT_RELEASE_API_URL
      ? new Response(null, { status: 503 }) : Response.json([mirrored]));
    await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision },
      { fetchImpl, packageTarget })).resolves.toMatchObject({ url: mirrorAsset.browser_download_url });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const assets of [[], [mirrorAsset, mirrorAsset],
      [{ ...mirrorAsset, browser_download_url: mirrorAsset.browser_download_url.replace("gitee.com", "evil.example") }],
      [{ ...mirrorAsset, browser_download_url: mirrorAsset.browser_download_url.replace("v1.2.0", "v1.1.0") }],
    ]) expect(parseMirrorReleaseMetadata({ ...mirrored, assets }, packageTarget)?.url)
      .toBe(`https://gitee.com/TNTcraftHIM/Piik/releases/tag/${release.tag_name}`);
  });

  it("checks a release without sending installed identity or credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(DEFAULT_RELEASE_API_URL);
      expect(init?.credentials).toBe("omit");
      expect(JSON.stringify(init)).not.toContain(currentRevision);
      expect(JSON.stringify(init)).not.toContain("Authorization");
      return new Response(JSON.stringify(release), { status: 200 });
    });
    await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision }, { fetchImpl }))
      .resolves.toEqual({ version: "v1.2.0", revision: latestRevision,
        url: release.html_url, kind: "update-available" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["v1.1.0", currentRevision, latestRevision, "update-available"],
    ["v1.1.0", latestRevision, latestRevision, "update-available"],
    ["v1.2.0-rc.1", currentRevision, latestRevision, "update-available"],
    ["v1.2.0", currentRevision, latestRevision, "different-build"],
    ["v1.2.0", latestRevision, latestRevision, null],
    ["v1.2.0", currentRevision, null, null],
    ["v1.10.0", currentRevision, latestRevision, null],
    ["development", currentRevision, latestRevision, "official-release"],
    ["development", latestRevision, latestRevision, null],
    ["development", currentRevision, null, null],
  ])("compares %s by release precedence, using SHA only to identify builds", (version, revision, remoteRevision, expected) => {
    expect(releaseUpdateNotice({ version, revision }, {
      version: "v1.2.0", revision: remoteRevision, url: release.html_url,
    })?.kind ?? null).toBe(expected);
  });

  it("does not turn branch names, prereleases or malformed metadata into release identity", async () => {
    expect(parseReleaseMetadata({ ...release, target_commitish: "main" })?.revision).toBeNull();
    for (const changed of [
      { tag_name: "short" },
      { tag_name: "v1.2.0-rc.1" },
      { tag_name: "v1.2.0+other" },
      { html_url: "https://evil.example" },
      { html_url: "https://user@github.com/TNTcraftHIM/Piik/releases/tag/v1.2.0" },
      { draft: true },
      { prerelease: true },
    ]) expect(parseReleaseMetadata({ ...release, ...changed })).toBeNull();
    await expect(checkReleaseUpdate({ version: "development", revision: "development" })).resolves.toBeNull();
    await expect(checkReleaseUpdate({ version: "v1.1.0", revision: currentRevision }, {
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("offline", { status: 503 })),
    })).resolves.toBeNull();
  });

  it("uses source provenance and stable precedence when GitHub is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === DEFAULT_RELEASE_API_URL) return new Response("offline", { status: 503 });
      expect(String(input)).toBe(`${MIRROR_RELEASE_API_URL}?per_page=100&page=1&direction=desc`);
      expect(init?.headers).toEqual({ Accept: "application/json" });
      expect(init?.credentials).toBe("omit");
      return Response.json(mirrorReleases);
    });
    const current = { version: "v1.9.0", revision: currentRevision };
    await expect(checkReleaseUpdate(current, { fetchImpl })).resolves.toEqual({
      kind: "update-available", version: "v1.10.0", revision: latestRevision,
      url: "https://gitee.com/TNTcraftHIM/Piik/releases/tag/v1.10.0",
    });
    await expect(checkReleaseUpdate({ ...current, version: "v2.0.0" }, { fetchImpl })).resolves.toBeNull();
  });

  it("gives the mirror its own deadline after a primary timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === DEFAULT_RELEASE_API_URL) {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
      }
      expect(init?.signal?.aborted).toBe(false);
      return Response.json(mirrorReleases);
    });
    await expect(checkReleaseUpdate({ version: "v1.0.0", revision: currentRevision }, { fetchImpl, timeoutMs: 10 }))
      .resolves.toMatchObject({ version: "v1.10.0" });
  });

  it("finishes mirror pagination and rejects an incomplete list", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === DEFAULT_RELEASE_API_URL) throw new Error("offline");
      return Response.json(new URL(String(input)).searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, () => mirrorReleases[0]) : [mirrorReleases[1]]);
    });
    const current = { version: "v1.9.0", revision: currentRevision };
    await expect(checkReleaseUpdate(current, { fetchImpl })).resolves.toMatchObject({ version: "v1.10.0" });
    fetchImpl.mockImplementation(async (input) => String(input) === DEFAULT_RELEASE_API_URL
      ? new Response(null, { status: 503 }) : Response.json(Array.from({ length: 100 }, () => mirrorReleases[1])));
    await expect(checkReleaseUpdate(current, { fetchImpl })).resolves.toBeNull();
  });

  it("does not query a mirror after a usable primary result, or accept ambiguous provenance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(release));
    await expect(checkReleaseUpdate({ version: "v1.2.0", revision: latestRevision }, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parseMirrorReleaseMetadata({ ...mirrorReleases[0], body: mirrorReleases[0].body.repeat(2) })).toBeNull();
    expect(parseMirrorReleaseMetadata({ ...mirrorReleases[0], prerelease: undefined })).toBeNull();
    expect(parseMirrorReleaseMetadata({ ...mirrorReleases[0], tag_name: "v1.0.0-beta.1" })).toBeNull();
  });
});
