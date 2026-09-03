export const DEFAULT_RELEASE_API_URL =
  "https://api.github.com/repos/TNTcraftHIM/Screener/releases/latest";

const FULL_REVISION = /^[0-9a-f]{40}$/i;
const RELEASE_PATH_PREFIX = "/TNTcraftHIM/Screener/releases/tag/";

export interface ReleaseUpdateNotice {
  revision: string;
  url: string;
}

export function normalizeReleaseRevision(value: unknown): string | null {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FULL_REVISION.test(revision) ? revision : null;
}

export function parseReleaseMetadata(value: unknown): ReleaseUpdateNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const release = value as {
    draft?: unknown;
    prerelease?: unknown;
    tag_name?: unknown;
    html_url?: unknown;
  };
  if (release.draft === true || release.prerelease === true) {
    return null;
  }
  const revision = normalizeReleaseRevision(release.tag_name);
  if (!revision || typeof release.html_url !== "string") {
    return null;
  }

  let releaseURL: URL;
  try {
    releaseURL = new URL(release.html_url);
  } catch {
    return null;
  }
  if (
    releaseURL.protocol !== "https:" ||
    releaseURL.hostname !== "github.com" ||
    releaseURL.username ||
    releaseURL.password ||
    releaseURL.port ||
    releaseURL.search ||
    releaseURL.hash ||
    !releaseURL.pathname.startsWith(RELEASE_PATH_PREFIX)
  ) {
    return null;
  }
  let tag = "";
  try {
    tag = decodeURIComponent(releaseURL.pathname.slice(RELEASE_PATH_PREFIX.length));
  } catch {
    return null;
  }
  return normalizeReleaseRevision(tag) === revision
    ? { revision, url: releaseURL.toString() }
    : null;
}

export async function checkReleaseUpdate(
  currentRevision: unknown,
  options: {
    apiURL?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ReleaseUpdateNotice | null> {
  const current = normalizeReleaseRevision(currentRevision);
  if (!current) return null;
  const endpoint = options.apiURL ?? DEFAULT_RELEASE_API_URL;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 3_000,
  );
  try {
    const response = await fetchImpl(parsedEndpoint.toString(), {
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const latest = parseReleaseMetadata(await response.json());
    return latest && latest.revision !== current ? latest : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
