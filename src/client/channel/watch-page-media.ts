import type { AppPage } from "./app-link";
import { HTMLVideoMedia, createPeerWatchMedia, type WatchMedia, type WatchMediaEvent, type WatchMediaPatch, type WatchMediaState } from "./watch-media";
import type { WatchByteSource, WatchFormat } from "./protocol";

/** Prepare the main player without transferring the selected page's lifetime. */
async function prepareMainPlayback(page: AppPage, media: HTMLVideoMedia, signal: AbortSignal): Promise<void> {
  try {
    await media.ready(signal);
    const main = await media.read();
    const state = main.live ? undefined : await page.read();
    signal.throwIfAborted();
    await media.patch({ ...(state && { position: state.position, rate: state.rate }), paused: true });
    // The main player starts after room confirmation; avoid overlapping original-page sound.
    await page.patch({ paused: true });
  } catch (error) { media.close(); throw error; }
}

export async function preparePortableWatchMedia(page: AppPage, url: string, signal: AbortSignal,
  format?: WatchFormat): Promise<HTMLVideoMedia> {
  const media = new HTMLVideoMedia(url, format);
  await prepareMainPlayback(page, media, signal);
  return media;
}

export async function preparePageSuppliedWatchMedia(page: AppPage, byteSource: WatchByteSource,
  signal: AbortSignal): Promise<PageSuppliedMedia> {
  signal.throwIfAborted();
  const media = createPeerWatchMedia(byteSource, (resourceId, offset, length, signal) =>
    page.readMediaResource(byteSource.resourceId, resourceId, offset, length, signal));
  try { await prepareMainPlayback(page, media, signal); }
  catch (error) { await page.stopMedia().catch(() => {}); throw error; }
  return new PageSuppliedMedia(page, media, byteSource);
}

/** One main playback owner; the selected page retains only resource access and retirement. */
export class PageSuppliedMedia implements WatchMedia {
  readonly presentation;
  private closed = false;
  private readonly unlisten: () => void;
  constructor(readonly page: AppPage, private readonly media: HTMLVideoMedia, readonly retainedByteSource: WatchByteSource) {
    this.presentation = media.presentation;
    // Original play/pause/seek events are deliberately not room playback events.
    this.unlisten = page.listen(event => { if (event === "closed") this.close(); });
  }
  audioAvailable(): boolean | undefined { return this.media.audioAvailable(); }
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
    this.page.close();
  }
}
