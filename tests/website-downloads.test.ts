import { describe, expect, it } from "vitest";
import { websiteDownloads } from "../site/downloads";

const revision = "a".repeat(40);
const version = "v1.2.0";
const github = {
  tag_name: version, target_commitish: revision, draft: false, prerelease: false,
  html_url: `https://github.com/TNTcraftHIM/Piik/releases/tag/${version}`,
  assets: ["windows-amd64", "darwin-arm64", "linux-amd64"].map(target => {
    const name = `piik-app-${target}-${revision.slice(0, 7)}.tar.gz`;
    return { name, state: "uploaded", size: 1024,
      browser_download_url: `https://github.com/TNTcraftHIM/Piik/releases/download/${version}/${name}` };
  }),
};
const mirror = {
  tag_name: version, prerelease: false, body: `<!-- piik-source: ${revision} -->`,
  assets: github.assets.map(asset => ({ ...asset,
    browser_download_url: asset.browser_download_url.replace("github.com", "gitee.com") })),
};

describe("website package downloads", () => {
  it("links each uploaded platform package and rejects an incomplete or mismatched GitHub release", () => {
    const result = websiteDownloads({ github, mirror });
    expect(result.version).toBe(version);
    expect(result.notes).toBe(github.html_url);
    expect(result.packages.map(item => item.url)).toEqual(github.assets.map(asset => asset.browser_download_url));
    expect(result.packages.map(item => item.mirrorURL)).toEqual(mirror.assets.map(asset => asset.browser_download_url));
    for (const changed of [
      { target_commitish: "main" }, { prerelease: true }, { draft: true },
      { assets: github.assets.slice(1) }, { assets: [...github.assets, github.assets[0]] },
      ...[
        { state: "new" }, { size: 0 },
        { name: github.assets[0]!.name.replace("aaaaaaa", "bbbbbbb") },
        { browser_download_url: github.assets[0]!.browser_download_url.replace("github.com", "evil.example") },
        { browser_download_url: github.assets[0]!.browser_download_url.replace(version, "v1.1.0") },
      ].map(change => ({ assets: [{ ...github.assets[0], ...change }, ...github.assets.slice(1)] })),
    ]) expect(() => websiteDownloads({ github: { ...github, ...changed } })).toThrow();
  });

  it("keeps mirror navigation as the fallback until the same release and attachment are confirmed", () => {
    for (const changed of [undefined, null, { ...mirror, prerelease: true },
      { ...mirror, body: `<!-- piik-source: ${"b".repeat(40)} -->` },
      { ...mirror, tag_name: "v1.1.0" }, { ...mirror, assets: [] }]) {
      expect(websiteDownloads({ github, mirror: changed }).packages.every(item => item.mirrorURL === null)).toBe(true);
    }
    for (const change of [{ size: 2048 }, { browser_download_url: "https://evil.example/package.tar.gz" }]) {
      const result = websiteDownloads({ github,
        mirror: { ...mirror, assets: [{ ...mirror.assets[0], ...change }, ...mirror.assets.slice(1)] } });
      expect(result.packages[0]!.mirrorURL).toBeNull();
      expect(result.packages[1]!.mirrorURL).toBe(mirror.assets[1]!.browser_download_url);
    }
  });
});
