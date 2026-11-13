/** Authored content can open ordinary external links, never navigate the App. */
export function isExternalLink(href: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(href);
}
