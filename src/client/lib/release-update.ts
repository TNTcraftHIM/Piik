import { compare, valid } from "semver";

export const DEFAULT_RELEASE_API_URL =
  "https://api.github.com/repos/TNTcraftHIM/Piik/releases/latest";
export const MIRROR_RELEASE_API_URL = "https://gitee.com/api/v5/repos/TNTcraftHIM/Piik/releases";
const RELEASE_PAGE = "https://github.com/TNTcraftHIM/Piik/releases/tag/";
const MIRROR_RELEASE_PAGE = "https://gitee.com/TNTcraftHIM/Piik/releases/tag/";

export interface ReleaseIdentity {
  version: string;
  revision: string;
}
interface PublishedRelease {
  version: string;
  revision: string | null;
  url: string;
}
export interface ReleaseUpdateNotice extends PublishedRelease {
  kind: "update-available" | "different-build" | "official-release";
}

export function normalizeReleaseRevision(value: unknown): string | null {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

function normalizeVersion(value: unknown): string | null {
  const version = typeof value === "string" ? valid(value) : null;
  return version ? `v${version}` : null;
}

export function parseReleaseMetadata(value: unknown): PublishedRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const release = value as Record<string, unknown>;
  if ((release.draft !== undefined && release.draft !== false) ||
      (release.prerelease !== undefined && release.prerelease !== false)) return null;
  const version = normalizeVersion(release.tag_name);
  if (!version || version !== release.tag_name || !/^v\d+\.\d+\.\d+$/.test(version) ||
      release.html_url !== RELEASE_PAGE + version) return null;
  return {
    version,
    // GitHub permits a branch here; only our publisher's full SHA is provenance.
    revision: normalizeReleaseRevision(release.target_commitish),
    url: RELEASE_PAGE + version,
  };
}

export function parseMirrorReleaseMetadata(value: unknown): PublishedRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const release = value as Record<string, unknown>;
  if (release.prerelease !== false || typeof release.body !== "string") return null;
  const sources = [...release.body.matchAll(/^<!-- piik-source: ([0-9a-f]{40}) -->\r?$/gm)];
  if (sources.length !== 1) return null;
  // The mirror tag identifies its README commit, never the original Piik source.
  const normalized = parseReleaseMetadata({
    tag_name: release.tag_name, html_url: RELEASE_PAGE + String(release.tag_name),
    target_commitish: sources[0][1],
  });
  return normalized ? { ...normalized, url: MIRROR_RELEASE_PAGE + normalized.version } : null;
}

export function releaseUpdateNotice(
  current: ReleaseIdentity,
  latest: PublishedRelease,
): ReleaseUpdateNotice | null {
  const version = normalizeVersion(current.version);
  const revision = normalizeReleaseRevision(current.revision);
  if (version) {
    const order = compare(latest.version, version);
    if (order > 0) return { ...latest, kind: "update-available" };
    if (order === 0 && revision && latest.revision && revision !== latest.revision) {
      return { ...latest, kind: "different-build" };
    }
    return null;
  }
  return revision && latest.revision && revision !== latest.revision
    ? { ...latest, kind: "official-release" }
    : null;
}

export async function checkReleaseUpdate(
  current: ReleaseIdentity,
  options: {
    apiURL?: string;
    mirrorAPIURL?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ReleaseUpdateNotice | null> {
  if (!normalizeVersion(current.version) && !normalizeReleaseRevision(current.revision)) return null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const sources = [
    { url: options.apiURL ?? DEFAULT_RELEASE_API_URL, mirror: false },
    { url: options.mirrorAPIURL ?? (options.apiURL ? undefined : MIRROR_RELEASE_API_URL), mirror: true },
  ];
  for (const source of sources) {
    if (!source.url) continue;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
    try {
      const endpoint = new URL(source.url);
      if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") continue;
      let latest: PublishedRelease | null = null;
      // Bound both time and pages. Never treat a truncated mirror list as latest.
      for (let page = 1; page <= 10; page++) {
        if (source.mirror) {
          endpoint.searchParams.set("per_page", "100");
          endpoint.searchParams.set("page", String(page));
          endpoint.searchParams.set("direction", "desc");
        }
        const response = await fetchImpl(endpoint.toString(), {
          cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
          headers: source.mirror ? { Accept: "application/json" } :
            { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        });
        if (!response.ok) break;
        const data: unknown = await response.json();
        if (!source.mirror) {
          latest = parseReleaseMetadata(data);
          if (latest) return releaseUpdateNotice(current, latest);
          break;
        }
        if (!Array.isArray(data) || data.length > 100) break;
        for (const value of data) {
          const candidate = parseMirrorReleaseMetadata(value);
          if (candidate && (!latest || compare(candidate.version, latest.version) > 0)) latest = candidate;
        }
        if (data.length < 100) {
          if (latest) return releaseUpdateNotice(current, latest);
          break;
        }
      }
    } catch {
      // A blocked, timed-out or malformed provider leaves the next source usable.
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  return null;
}
