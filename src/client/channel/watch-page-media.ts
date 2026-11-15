import type { AppPage } from "./app-link";
import type { HTMLVideoMedia, WatchMedia, WatchMediaEvent, WatchMediaPatch, WatchMediaState } from "./watch-media";
import type { WatchByteSource } from "./protocol";

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
  read(): Promise<WatchMediaState> { return this.media.read(); }
  patch(value: WatchMediaPatch): Promise<void> { return this.media.patch(value); }
  ready(signal: AbortSignal): Promise<void> { return this.media.ready(signal); }
  listen(changed: (event: WatchMediaEvent) => void): () => void { return this.media.listen(changed); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    this.media.close();
    this.page.close();
  }
}
