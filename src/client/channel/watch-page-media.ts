import type { AppPage } from "./app-link";
import type { NativePageMediaChoice, NativePageIndexedCandidate, NativePageMpdCandidate, NativePageMpdCatalog } from "../native/wire";
import { inspectIndexedTrack, type IndexedTrackInspection } from "./watch-indexed-source";
import { limitWatchReads } from "./watch-resource";
import { HTMLVideoMedia } from "./watch-media";
import { watchSourceSchema, type WatchByteSource, type WatchFormat, type WatchTimeline } from "./protocol";

export interface WatchIndexedChoice { candidate: NativePageIndexedCandidate; inspection?: IndexedTrackInspection; error?: string }
export interface WatchMpdChoice { candidate: NativePageMpdCandidate; catalog?: NativePageMpdCatalog; error?: string }
export interface WatchMediaSources { choices: readonly NativePageMediaChoice[]; indexed: readonly WatchIndexedChoice[]; mpd: readonly WatchMpdChoice[]; error?: string; retryIndexed?: () => Promise<void> }

export function directForwardMediaURL(choice: NativePageMediaChoice): string | undefined {
  if ((choice.format === "file" || choice.format === "hls") && watchSourceSchema.safeParse({ kind: "media", url: choice.displayURL }).success) return choice.displayURL;
}

/** One page observation owns its resource cache, reads and listener retirement. */
export function observeWatchSources(page: AppPage, lifetime: AbortSignal, publish: (sources: WatchMediaSources) => void, candidateId?: string): { ready: Promise<WatchMediaSources>; refresh(): Promise<WatchMediaSources>; unsubscribe(): void } {
  const controller = new AbortController(), signal = AbortSignal.any([lifetime, controller.signal]);
  let running: Promise<WatchMediaSources> | null = null, dirty = false;
  let inspecting: AbortController | null = null;
  let current: WatchMediaSources = { choices: [], indexed: [], mpd: [] };
  const read = limitWatchReads(async (id, offset, length, signal) => {
    const result = await page.readMediaMetadata(id, offset, length, signal, candidateId);
    return { ...result, eof: offset + result.bytes.length === result.totalSize };
  });
  const refresh = (): Promise<WatchMediaSources> => {
    if (running) return running;
    running = (async () => {
      do {
        dirty = false;
        try {
          signal.throwIfAborted();
          const { choices, indexedCandidates, mpdCandidates } = await page.mediaSources(candidateId, signal);
          signal.throwIfAborted();
          if (dirty) continue;
          inspecting = new AbortController();
          const checking = AbortSignal.any([signal, inspecting.signal]);
          const indexed = await Promise.all(indexedCandidates.map(async candidate => {
            const previous = current.indexed.find(choice => choice.candidate.id === candidate.id);
            if (previous && previous.candidate.totalSize === candidate.totalSize && previous.candidate.mimeType === candidate.mimeType)
              return { ...previous, candidate };
            try { return { candidate, inspection: await inspectIndexedTrack(candidate, read, checking) }; }
            catch (error) {
              checking.throwIfAborted();
              return { candidate, error: error instanceof Error ? error.message : "watch_indexed_unsupported" };
            }
          }));
          checking.throwIfAborted();
          const mpd = mpdCandidates.map(candidate => ({ ...current.mpd.find(value => value.candidate.id === candidate.id), candidate }));
          checking.throwIfAborted();
          current = { choices, indexed, mpd, retryIndexed: indexed.some(choice => choice.error) ? retryIndexed : undefined };
        } catch (error) {
          signal.throwIfAborted();
          if (dirty) continue;
          current = { ...current, error: error instanceof Error ? error.message : "watch_source_unavailable" };
        } finally { inspecting = null; }
        publish(current);
      } while (dirty && !signal.aborted);
      return current;
    })().finally(() => {
      running = null;
      if (dirty && !signal.aborted) void refresh().catch(() => {});
    });
    return running;
  };
  const retryIndexed = async () => {
    if (signal.aborted || !current.retryIndexed) return;
    current = { ...current, indexed: current.indexed.filter(choice => !choice.error), retryIndexed: undefined };
    dirty = true;
    inspecting?.abort();
    await refresh().catch(() => {});
  };
  const unlisten = page.listenMediaSources(() => {
    dirty = true;
    inspecting?.abort();
    void refresh().catch(() => {}); // Only retirement rejects; source failures publish above.
  });
  const unlistenPage = page.listen(event => { if (event === "closed") unsubscribe(); });
  const unsubscribe = () => {
    controller.abort();
    unlisten(); unlistenPage();
    lifetime.removeEventListener("abort", unsubscribe);
  };
  lifetime.addEventListener("abort", unsubscribe, { once: true });
  if (lifetime.aborted) unsubscribe();
  const reset = () => {
    current = { choices: [], indexed: [], mpd: [] };
    publish(current);
    dirty = true;
    inspecting?.abort();
    return refresh();
  };
  return { ready: refresh(), refresh: reset, unsubscribe };
}

/** Prepare the main player without transferring the selected page's lifetime. */
async function prepareMainPlayback(page: AppPage, media: HTMLVideoMedia, signal: AbortSignal, candidateId?: string): Promise<void> {
  await media.ready(signal);
  const main = await media.read();
  const state = main.live ? undefined : await page.read(candidateId);
  signal.throwIfAborted();
  await media.patch({ ...(state && { position: state.position, rate: state.rate }), paused: true });
  signal.throwIfAborted();
  // The main player starts after room confirmation; avoid overlapping original-page sound.
  if (!candidateId) await page.patch({ paused: true });
  signal.throwIfAborted();
}

export async function preparePortableWatchMedia(page: AppPage, url: string, signal: AbortSignal,
  format?: WatchFormat, candidateId?: string): Promise<HTMLVideoMedia> {
  const media = new HTMLVideoMedia(url, format);
  try {
    await prepareMainPlayback(page, media, signal, candidateId);
    return media;
  } catch (error) { media.close(); throw error; }
}

export async function preparePageSuppliedWatchMedia(page: AppPage, byteSource: WatchByteSource,
  signal: AbortSignal, candidateId?: string): Promise<PageSuppliedMedia> {
  signal.throwIfAborted();
  let media: PageSuppliedMedia | undefined;
  try {
    media = new PageSuppliedMedia(page, byteSource);
    await prepareMainPlayback(page, media, signal, candidateId);
    return media;
  } catch (error) {
    media?.close();
    await page.stopMedia(candidateId).catch(() => {});
    throw error;
  }
}

/** Each main player retains access to its page until its owner closes the player. */
export class PageSuppliedMedia extends HTMLVideoMedia {
  private readonly unlistenPage: () => void;
  private readonly releasePage: () => void;
  constructor(readonly page: AppPage, readonly retainedByteSource: WatchByteSource, timeline?: WatchTimeline) {
    const { resourceId, format } = retainedByteSource;
    super({ resourceId, hlsDeadlineOwner: "loader",
      read: (id, offset, length, signal) => page.readMediaResource(resourceId, id, offset, length, signal) }, format, timeline);
    try { this.releasePage = page.hold(); }
    catch (error) { super.close(); throw error; }
    // Original play/pause/seek events are deliberately not room playback events.
    this.unlistenPage = page.listen(event => { if (event === "closed") this.close(); });
  }
  override close(): void {
    this.unlistenPage();
    super.close();
    this.releasePage();
  }
}
