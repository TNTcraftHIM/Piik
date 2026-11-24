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
    /^watch_(?:source_(?:unavailable|changed|retired)|path_unavailable|read_busy|media_(?:timeout|unsupported|encryption_unsupported|failed)|invalid_manifest|live_timeline_unsupported)$/.test(
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

/** Inspect the parsed presentation before Shaka resolves linked periods or initializes DRM. */
export function requireClearStaticManifest(mpd: shaka.extern.xml.Node): void {
  if (mpd.tagName !== "MPD") throw new Error("watch_invalid_manifest");
  if ((mpd.attributes.type ?? "static") !== "static")
    throw new Error("watch_live_timeline_unsupported");
  const visit = (node: shaka.extern.xml.Node) => {
    const localName = node.tagName.slice(node.tagName.indexOf(":") + 1);
    if (localName === "ContentProtection")
      throw new Error("watch_media_encryption_unsupported");
    for (const child of node.children) if (typeof child !== "string") visit(child);
  };
  visit(mpd);
}

/** Shaka owns DASH/MSE. HTMLVideoMedia retains the element, controls and retirement. */
export class WatchDashMedia {
  private player?: shaka.Player;
  private bridge?: ReturnType<typeof attachWatchDashReader>;
  private closed = false;
  constructor(
    private video: HTMLVideoElement,
    private source: string | { resourceId: string; read: WatchByteReader },
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
      let url: string;
      if (typeof this.source === "string") {
        player.configure({ manifest: {
          dash: { manifestPreprocessorTXml: requireClearStaticManifest },
          raiseFatalErrorOnManifestUpdateRequestFailure: true,
        } });
        // Shaka imports these XML fragments after preprocessing the MPD.
        const { LINKED_MPD, XLINK } = library.net.NetworkingEngine.AdvancedRequestType;
        player.getNetworkingEngine()!.registerRequestFilter((_type, _request, context) => {
          if (context?.type === LINKED_MPD || context?.type === XLINK)
            throw new Error("watch_invalid_manifest");
        });
        url = this.source;
      } else {
        this.bridge = attachWatchDashReader(library, player, this.source.read, this.signal);
        url = this.bridge.url(this.source.resourceId);
      }
      player.addEventListener("error", (event) => {
        if (!this.signal.aborted && !this.closed)
          this.failed(
            dashFailure((event as unknown as { detail: unknown }).detail),
          );
      });
      await player.attach(this.video);
      this.signal.throwIfAborted();
      await player.load(
        url,
        undefined,
        "application/dash+xml",
      );
    } catch (error) {
      if (this.signal.aborted || this.closed)
        throw new DOMException("Cancelled", "AbortError");
      throw dashFailure(error);
    }
  }
  audioAvailable(): boolean | undefined {
    const track = this.player?.getVariantTracks().find(track => track.active);
    return track ? track.audioId !== null || !!track.audioCodec : undefined;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge?.close();
    void this.player?.destroy().catch(() => {});
  }
}
