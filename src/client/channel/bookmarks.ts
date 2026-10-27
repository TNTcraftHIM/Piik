import { z } from "zod";
import { siteEntryOrigin } from "../lib/site-address";

export const DOMAIN_BOOKMARKS_KEY = "piik.channel.bookmarks";
const bookmarksSchema = z.array(z.object({
  origin: z.string().refine(value => siteEntryOrigin(value) === value),
  name: z.string(),
}));
export type DomainBookmark = z.infer<typeof bookmarksSchema>[number];

export function readDomainBookmarks(): DomainBookmark[] {
  try {
    const result = bookmarksSchema.safeParse(JSON.parse(localStorage.getItem(DOMAIN_BOOKMARKS_KEY) ?? "[]"));
    if (result.success) return result.data;
  } catch { /* A fresh browser can start with an empty collection. */ }
  return [];
}

export function saveDomainBookmarks(bookmarks: DomainBookmark[]): boolean {
  try {
    localStorage.setItem(DOMAIN_BOOKMARKS_KEY, JSON.stringify(bookmarks));
    return true;
  } catch { return false; }
}

/** Both prototype surfaces open the functional client, without carrying access secrets. */
export function domainBookmarkURL(origin: string): string {
  return `${origin}/__channel-preview`;
}
