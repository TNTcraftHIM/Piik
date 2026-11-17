/** Only a single, explicitly selected video is a portable website source. */
export function youtubeVideoId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let id: string | null = null;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v");
      else if (url.pathname.startsWith("/embed/")) id = url.pathname.slice(7);
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

/** Official iframe start is a local initial position, not the selected video's identity. */
export function youtubeStartSeconds(raw: string): number | undefined {
  if (!youtubeVideoId(raw)) return;
  const url = new URL(raw);
  if (!url.pathname.startsWith("/embed/")) return;
  const values = url.searchParams.getAll("start");
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return;
  const seconds = Number(values[0]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

export function youtubeEmbedURL(id: string): string { return `https://www.youtube.com/embed/${id}`; }
export function originalWatchURL(source: { kind: string; url: string }): string {
  const id = youtubeSourceId(source);
  return id ? `https://www.youtube.com/watch?v=${id}` : source.url;
}

/** Prepared players must retain their browsing context when moving into the stage. */
export function canUseYouTubePlayer(): boolean {
  return typeof document !== "undefined" && "moveBefore" in document.documentElement;
}

/** A Native-selected /watch page does not establish its selected video's identity. */
export function youtubeSourceId(source: { kind: string; url: string }): string | null {
  const id = source.kind === "website" ? youtubeVideoId(source.url) : null;
  return id && source.url === youtubeEmbedURL(id) ? id : null;
}

export function canWatchInBrowser(source: { kind: string; url: string; mediaUrl?: string }): boolean {
  return source.kind === "media" || !!source.mediaUrl || youtubeSourceId(source) !== null;
}
