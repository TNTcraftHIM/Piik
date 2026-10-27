/** A saved site address excludes invitation paths, query strings and fragments. */
export function siteEntryOrigin(value: string): string | null {
  try {
    const address = value.trim();
    const url = new URL(address.includes("://") ? address : `https://${address}`);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      !/\s/.test(decodeURIComponent(url.hostname)) ? url.origin : null;
  } catch { return null; }
}
