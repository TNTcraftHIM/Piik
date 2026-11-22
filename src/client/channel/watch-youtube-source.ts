import type { WatchSource } from "./protocol";
import type { WatchPlayer } from "./watch-playback";

/** Only a single, explicitly selected video is a portable website source. */
export function youtubeVideoId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let id: string | null = null;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v");
      else id = /^\/(?:embed|shorts)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

/** Start the preview at the selected position, keeping the shared video identity stable. */
export function youtubeStartSeconds(raw: string): number | undefined {
  if (!youtubeVideoId(raw)) return;
  const url = new URL(raw);
  const embed = url.pathname.startsWith("/embed/");
  const values = url.searchParams.getAll(embed ? "start" : "t");
  if (values.length !== 1 || !values[0]) return;
  const value = values[0];
  let seconds: number;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else {
    const units = !embed && /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
    if (!units) return;
    seconds = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

export function youtubeEmbedURL(id: string): string { return `https://www.youtube.com/embed/${id}`; }
export function originalWatchURL(source: { kind: string; url: string }): string {
  const id = youtubeSourceId(source);
  return id ? `https://www.youtube.com/watch?v=${id}` : source.url;
}

/** Prepared players must retain their browsing context when moving into the stage. */
export function canMoveYouTubePlayer(): boolean {
  return typeof document !== "undefined" && "moveBefore" in document.documentElement;
}

/** A Native-selected /watch page does not establish its selected video's identity. */
export function youtubeSourceId(source: { kind: string; url: string }): string | null {
  const id = source.kind === "website" ? youtubeVideoId(source.url) : null;
  return id && source.url === youtubeEmbedURL(id) ? id : null;
}

export function canWatchInBrowser(source: WatchSource, current?: Pick<WatchPlayer, "presentation" | "mode">): boolean {
  if (source.kind === "media" || source.mediaUrl) return true;
  if (!youtubeSourceId(source)) return false;
  const replacingPage = current?.presentation.kind === "external" && current.mode === "direct";
  return !replacingPage || canMoveYouTubePlayer();
}
