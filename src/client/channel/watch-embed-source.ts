import type { WatchSource } from "./protocol";
import type { WatchPlayer } from "./watch-playback";
import { peerTubeId, peerTubeOrigin, peerTubeSourceId } from "./watch-peertube-source";
import { youtubeSourceId, youtubeVideoId } from "./watch-youtube-source";

export function watchEmbed(raw: string) {
  const youtube = youtubeVideoId(raw);
  if (youtube) return { provider: "youtube" as const, id: youtube };
  const peertube = peerTubeId(raw);
  return peertube ? { provider: "peertube" as const, id: peertube } : null;
}

export function sharedWatchEmbed(source: Pick<WatchSource, "kind" | "url">) {
  const youtube = youtubeSourceId(source);
  if (youtube) return { provider: "youtube" as const, id: youtube };
  const peertube = peerTubeSourceId(source);
  return peertube ? { provider: "peertube" as const, id: peertube } : null;
}

export function originalWatchURL(source: Pick<WatchSource, "kind" | "url">): string | undefined {
  const embed = sharedWatchEmbed(source);
  if (!embed) return source.url;
  return embed.provider === "youtube" ? `https://www.youtube.com/watch?v=${embed.id}`
    : `${peerTubeOrigin}/videos/watch/${embed.id}`;
}

/** Moving a prepared iframe to the stage must preserve its browsing context. */
export function canMoveWatchEmbed(): boolean {
  return typeof document !== "undefined" && "moveBefore" in document.documentElement;
}

export function canWatchInBrowser(source: WatchSource, current?: Pick<WatchPlayer, "presentation" | "mode">): boolean {
  if (source.kind === "media" || source.mediaUrl) return true;
  if (!sharedWatchEmbed(source)) return false;
  const replacingPage = current?.presentation.kind === "external" && current.mode === "direct";
  return !replacingPage || canMoveWatchEmbed();
}
