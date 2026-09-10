import { compare, valid } from "semver";

export const DEFAULT_RELEASE_API_URL =
  "https://api.github.com/repos/TNTcraftHIM/Piik/releases/latest";
const RELEASE_PAGE = "https://github.com/TNTcraftHIM/Piik/releases/tag/";

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
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ReleaseUpdateNotice | null> {
  if (!normalizeVersion(current.version) && !normalizeReleaseRevision(current.revision)) return null;
  const endpoint = options.apiURL ?? DEFAULT_RELEASE_API_URL;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") return null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetchImpl(parsedEndpoint.toString(), {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const latest = parseReleaseMetadata(await response.json());
    return latest ? releaseUpdateNotice(current, latest) : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
