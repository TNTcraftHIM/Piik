import type { AppPage } from "./app-link";
import type { NativePageMediaChoice, NativePageIndexedCandidate, NativePageMpdCandidate, NativePageMpdCatalog } from "../native/wire";
import { inspectIndexedTrack, type IndexedTrackInspection } from "./watch-indexed-source";
import { limitWatchReads } from "./watch-resource";
import { HTMLVideoMedia, createResourceWatchMedia, type WatchMedia, type WatchMediaEvent, type WatchMediaPatch, type WatchMediaState } from "./watch-media";
import type { WatchByteSource, WatchFormat, WatchTimeline } from "./protocol";

export interface WatchIndexedChoice { candidate: NativePageIndexedCandidate; inspection?: IndexedTrackInspection; error?: string }
export interface WatchMpdChoice { candidate: NativePageMpdCandidate; catalog?: NativePageMpdCatalog; error?: string }
export interface WatchMediaSources { choices: readonly NativePageMediaChoice[]; indexed: readonly WatchIndexedChoice[]; mpd: readonly WatchMpdChoice[]; error?: string }

/** One page observation owns its resource cache, reads and listener retirement. */
export function observeWatchSources(page: AppPage, lifetime: AbortSignal, publish: (sources: WatchMediaSources) => void): { ready: Promise<WatchMediaSources>; unsubscribe(): void } {
  const controller = new AbortController(), signal = AbortSignal.any([lifetime, controller.signal]);
  let running: Promise<WatchMediaSources> | null = null, dirty = false;
  let inspecting: AbortController | null = null;
  let current: WatchMediaSources = { choices: [], indexed: [], mpd: [] };
  const read = limitWatchReads(async (id, offset, length, signal) => {
    const result = await page.readMediaMetadata(id, offset, length, signal);
    return { ...result, eof: offset + result.bytes.length === result.totalSize };
  });
  const refresh = (): Promise<WatchMediaSources> => {
    if (running) return running;
    running = (async () => {
      do {
        dirty = false;
        try {
          signal.throwIfAborted();
          const { choices, indexedCandidates, mpdCandidates } = await page.mediaSources();
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
          current = { choices, indexed, mpd };
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
  return { ready: refresh(), unsubscribe };
}

/** Prepare the main player without transferring the selected page's lifetime. */
async function prepareMainPlayback(page: AppPage, media: HTMLVideoMedia, signal: AbortSignal): Promise<void> {
  try {
    await media.ready(signal);
    const main = await media.read();
    const state = main.live ? undefined : await page.read();
    signal.throwIfAborted();
    await media.patch({ ...(state && { position: state.position, rate: state.rate }), paused: true });
    signal.throwIfAborted();
    // The main player starts after room confirmation; avoid overlapping original-page sound.
    await page.patch({ paused: true });
    signal.throwIfAborted();
  } catch (error) { media.close(); throw error; }
}

export async function preparePortableWatchMedia(page: AppPage, url: string, signal: AbortSignal,
  format?: WatchFormat): Promise<HTMLVideoMedia> {
  const media = new HTMLVideoMedia(url, format);
  await prepareMainPlayback(page, media, signal);
  return media;
}

function pagePlayback(page: AppPage, byteSource: WatchByteSource, timeline?: WatchTimeline): HTMLVideoMedia {
  return createResourceWatchMedia(byteSource, (resourceId, offset, length, signal) =>
    page.readMediaResource(byteSource.resourceId, resourceId, offset, length, signal), { hlsDeadlineOwner: "loader", timeline });
}

export async function preparePageSuppliedWatchMedia(page: AppPage, byteSource: WatchByteSource,
  signal: AbortSignal): Promise<PageSuppliedMedia> {
  signal.throwIfAborted();
  const media = pagePlayback(page, byteSource);
  try { await prepareMainPlayback(page, media, signal); }
  catch (error) { await page.stopMedia().catch(() => {}); throw error; }
  return new PageSuppliedMedia(page, media, byteSource);
}

/** One main playback owner; the selected page retains only resource access and retirement. */
export class PageSuppliedMedia implements WatchMedia {
  readonly presentation;
  private closed = false;
  private readonly unlisten: () => void;
  constructor(readonly page: AppPage, private readonly media: HTMLVideoMedia, readonly retainedByteSource: WatchByteSource, private ownsPage = true) {
    this.presentation = media.presentation;
    // Original play/pause/seek events are deliberately not room playback events.
    this.unlisten = page.listen(event => { if (event === "closed") this.close(); });
  }
  audioAvailable(): boolean | undefined { return this.media.audioAvailable(); }
  retryCandidate(timeline: WatchTimeline): PageSuppliedMedia {
    return new PageSuppliedMedia(this.page, pagePlayback(this.page, this.retainedByteSource, timeline), this.retainedByteSource, false);
  }
  transferPageTo(next: PageSuppliedMedia): void {
    this.ownsPage = false;
    next.ownsPage = true;
  }
  read(): Promise<WatchMediaState> { return this.media.read(); }
  patch(value: WatchMediaPatch): Promise<void> { return this.media.patch(value); }
  ready(signal: AbortSignal): Promise<void> { return this.media.ready(signal); }
  audioTracks() { return this.media.audioTracks(); }
  selectAudioTrack(id: number): void { this.media.selectAudioTrack(id); }
  listen(changed: (event: WatchMediaEvent) => void): () => void { return this.media.listen(changed); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    this.media.close();
    if (this.ownsPage) this.page.close();
  }
}
