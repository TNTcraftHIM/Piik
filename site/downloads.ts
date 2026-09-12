// Build-time download links. GitHub owns release identity; Gitee mirrors it.
import { parseMirrorReleaseMetadata, parseReleaseMetadata } from "../src/client/lib/release-update";

const targets = ["windows-amd64", "darwin-arm64", "linux-amd64"] as const;

function assets(value: unknown): Record<string, unknown>[] {
  const list = value && typeof value === "object" ? (value as Record<string, unknown>).assets : null;
  return Array.isArray(list)
    ? list.filter((asset): asset is Record<string, unknown> => asset !== null && typeof asset === "object" && !Array.isArray(asset))
    : [];
}

export function websiteDownloads(data: { github: unknown; mirror?: unknown }) {
  const release = parseReleaseMetadata(data.github);
  if (!release?.revision) throw new Error("Website downloads require a published GitHub release with a full source SHA");
  const primaryAssets = assets(data.github);
  const mirror = parseMirrorReleaseMetadata(data.mirror);
  const mirrorAssets = mirror?.version === release.version && mirror.revision === release.revision
    ? assets(data.mirror) : [];
  return {
    version: release.version,
    notes: release.url,
    packages: targets.map(target => {
      const name = `piik-app-${target}-${release.revision!.slice(0, 7)}.tar.gz`;
      const url = `https://github.com/TNTcraftHIM/Piik/releases/download/${release.version}/${name}`;
      const matches = primaryAssets.filter(asset => asset.name === name);
      const asset = matches[0];
      if (matches.length !== 1 || asset?.state !== "uploaded" || asset.browser_download_url !== url ||
          !Number.isSafeInteger(asset.size) || Number(asset.size) <= 0) {
        throw new Error(`Website download is missing or invalid: ${target}`);
      }
      const mirrorURL = `https://gitee.com/TNTcraftHIM/Piik/releases/download/${release.version}/${name}`;
      const mirrored = mirrorAssets.filter(candidate => candidate.name === name);
      return { target, url, mirrorURL: mirrored.length === 1 && mirrored[0]!.size === asset.size &&
        mirrored[0]!.browser_download_url === mirrorURL ? mirrorURL : null };
    }),
  };
}
