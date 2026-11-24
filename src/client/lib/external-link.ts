/** Authored content can open ordinary external links, never navigate the App. */
export function isExternalLink(href: string): boolean {
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return false;
  try {
    new URL(href);
    return true;
  } catch {
    return false;
  }
}
