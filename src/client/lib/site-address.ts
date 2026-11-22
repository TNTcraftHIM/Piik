export type SiteBookmark = { id: string; name: string; origin: string };

/** Explicit HTTP(S) entries may include an invitation path, query and fragment. */
export function siteEntryURL(value: string): URL | null {
  try {
    const address = value.trim();
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      !/\s/.test(decodeURIComponent(url.hostname)) ? url : null;
  } catch { return null; }
}

/** A configured public entry is a complete HTTPS site, not an invitation or subpath. */
export function publicSiteOrigin(value: string): string | null {
  const url = siteEntryURL(value);
  return url?.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
}

export function siteEntryError(reason: unknown) {
  if (reason === "not_piik_site") return "client.bookmarks.notPiik" as const;
  if (reason === "site_unavailable") return "client.bookmarks.unavailable" as const;
  return undefined;
}

export async function openLauncherSite(url: string): Promise<void> {
  const response = await fetch("/api/client-launcher/open", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
  });
  const result = await response.json();
  if (!response.ok || typeof result.opened !== "boolean") throw new Error(result.detail);
  if (!result.opened) location.assign(url);
}
