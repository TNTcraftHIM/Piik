import type shaka from "shaka-player";
import { attachWatchDashReader } from "./watch-dash-loader";
import type { WatchByteReader } from "./watch-resource";

export function canReadWatchDash(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function"
  );
}

function dashFailure(error: unknown): Error {
  // Never expose Shaka's data array, which can contain resource URLs or platform diagnostics.
  if (
    error instanceof Error &&
    /^watch_(?:source_(?:unavailable|changed|retired)|path_unavailable|read_(?:timeout|busy)|media_(?:unsupported|encryption_unsupported|failed)|invalid_manifest|live_timeline_unsupported)$/.test(
      error.message,
    )
  )
    return error;
  const category = (error as { category?: number })?.category;
  return new Error(
    category === 4
      ? "watch_invalid_manifest"
      : category === 6
        ? "watch_media_encryption_unsupported"
        : category === 3
          ? "watch_media_decode_failed"
          : category === 1
            ? "watch_media_unavailable"
            : "watch_media_failed",
  );
}

/** Shaka owns DASH/MSE. HTMLVideoMedia retains the element, controls and retirement. */
export class WatchDashMedia {
  private player?: shaka.Player;
  private bridge?: ReturnType<typeof attachWatchDashReader>;
  private closed = false;
  constructor(
    private video: HTMLVideoElement,
    private resourceId: string,
    private read: WatchByteReader,
    private signal: AbortSignal,
    private failed: (error: Error) => void,
  ) {}
  async open(): Promise<void> {
    try {
      const library = (await import("shaka-player")).default;
      this.signal.throwIfAborted();
      if (this.closed) throw new DOMException("Cancelled", "AbortError");
      if (!library.Player.isBrowserSupported())
        throw new Error("watch_media_unsupported");
      const player = (this.player = new library.Player());
      this.bridge = attachWatchDashReader(
        library,
        player,
        this.read,
        this.signal,
      );
      player.addEventListener("error", (event) => {
        if (!this.signal.aborted && !this.closed)
          this.failed(
            dashFailure((event as unknown as { detail: unknown }).detail),
          );
      });
      await player.attach(this.video);
      this.signal.throwIfAborted();
      await player.load(
        this.bridge.url(this.resourceId),
        undefined,
        "application/dash+xml",
      );
    } catch (error) {
      if (this.signal.aborted || this.closed)
        throw new DOMException("Cancelled", "AbortError");
      throw dashFailure(error);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge?.close();
    void this.player?.destroy().catch(() => {});
  }
}
