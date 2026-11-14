/** Explicit HTTP(S) entries may include an invitation path, query and fragment. */
export function siteEntryURL(value: string): URL | null {
  try {
    const address = value.trim();
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      !/\s/.test(decodeURIComponent(url.hostname)) ? url : null;
  } catch { return null; }
}

/** Saved addresses and App approval retain only the origin. */
export function siteEntryOrigin(value: string): string | null {
  return siteEntryURL(value)?.origin ?? null;
}

/** A configured public entry is a complete HTTPS site, not an invitation or subpath. */
export function publicSiteOrigin(value: string): string | null {
  const url = siteEntryURL(value);
  return url?.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
}
