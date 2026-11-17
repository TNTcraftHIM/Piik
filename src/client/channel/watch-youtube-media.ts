import type { WatchMedia, WatchMediaEvent, WatchMediaPatch, WatchMediaState } from "./watch-media";
import { youtubeEmbedURL, youtubeVideoId } from "./watch-youtube-source";

interface YouTubePlayer {
  getVideoUrl(): string;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  playVideo(): void;
  pauseVideo(): void;
  seekTo(position: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  destroy(): void;
}
type PlayerEvent = { target: YouTubePlayer; data: number };
type YouTubeWindow = Window & {
  YT?: { Player: new (frame: HTMLIFrameElement, options: { events: Record<string, (event: PlayerEvent) => void> }) => YouTubePlayer };
  onYouTubeIframeAPIReady?: () => void;
};
const scope = () => window as YouTubeWindow;
let sdk: Promise<void> | undefined;

/** One document loads the platform SDK; individual watches never own this script. */
function loadYouTube(): Promise<void> {
  if (scope().YT?.Player) return Promise.resolve();
  if (sdk) return sdk;
  const loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script"), previous = scope().onYouTubeIframeAPIReady;
    const finish = (error?: Error) => {
      if (scope().onYouTubeIframeAPIReady === ready) scope().onYouTubeIframeAPIReady = previous;
      script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const ready = () => { previous?.(); finish(); };
    scope().onYouTubeIframeAPIReady = ready;
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => finish(new Error("watch_media_unavailable"));
    document.head.append(script);
  });
  sdk = loading;
  void loading.catch(() => { if (sdk === loading) sdk = undefined; });
  return loading;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** The official iframe owns decoding, access checks, controls and personal volume. */
export class YouTubeMedia implements WatchMedia {
  private readonly element = document.createElement("div");
  private presented!: () => void;
  private readonly presentationReady = new Promise<void>(resolve => { this.presented = resolve; });
  readonly presentation = { kind: "embed" as const, element: this.element, setVisible: (visible: boolean, automaticPlayback = true) => {
    this.automaticPlayback = automaticPlayback;
    this.setVisible(visible);
  }, mounted: () => this.presented() };
  readonly seekTolerance = 2;
  readonly seekEvents = false;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(event: WatchMediaEvent) => void>();
  private readonly sdk: Promise<void>;
  private player?: YouTubePlayer;
  private mounted?: Promise<void>;
  private failure?: Error;
  private visible = false;
  private automaticPlayback = true;
  private apiReady = false;
  private paused = true;
  private played = false;
  private readonly visibility = new EventTarget();

  constructor(private readonly id: string, private readonly startSeconds?: number) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("invalid_watch_url");
    this.sdk = loadYouTube();
    this.element.className = "c3-watch-embed";
    void this.sdk.catch(() => {});
  }
  get sourceURL(): string { return youtubeEmbedURL(this.id); }
  waitForPresentation(signal: AbortSignal): Promise<void> {
    return abortable(this.presentationReady, AbortSignal.any([signal, this.lifetime.signal]));
  }

  async ready(signal: AbortSignal): Promise<void> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    await abortable(this.sdk, lifetime);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { unlisten(); lifetime.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
      const cancel = () => finish(lifetime.reason);
      const check = () => { if (this.failure) finish(this.failure); else if (this.played) finish(); };
      const unlisten = this.listen(check);
      lifetime.addEventListener("abort", cancel, { once: true });
      if (lifetime.aborted) cancel(); else check();
    });
  }
  playbackAvailable(): boolean { return this.visible && this.automaticPlayback; }
  playbackRates(): readonly number[] { return this.apiReady ? this.player!.getAvailablePlaybackRates() : [1]; }

  private setVisible(visible: boolean): void {
    if (this.lifetime.signal.aborted) return;
    this.visible = visible;
    this.visibility.dispatchEvent(new Event("change"));
    if (!visible) {
      if (this.apiReady && this.played) {
        this.player!.pauseVideo();
        this.emit("blocked");
      }
      return;
    }
    if (!this.mounted && this.element.isConnected) {
      this.mounted = this.mount();
      void this.mounted.catch(error => {
        if (this.lifetime.signal.aborted) return;
        this.failure = error instanceof Error ? error : new Error("watch_media_failed");
        this.emit("error");
      });
    }
  }

  private async mount(): Promise<void> {
    await abortable(this.sdk, this.lifetime.signal);
    const frame = document.createElement("iframe");
    const url = new URL(youtubeEmbedURL(this.id));
    url.search = new URLSearchParams({ enablejsapi: "1", origin: location.origin, playsinline: "1", autoplay: "0", controls: "1" }).toString();
    if (this.startSeconds !== undefined) url.searchParams.set("start", String(this.startSeconds));
    frame.src = url.href; frame.title = "YouTube";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    this.element.append(frame);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        this.lifetime.signal.removeEventListener("abort", cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(this.lifetime.signal.reason);
      this.lifetime.signal.addEventListener("abort", cancel, { once: true });
      this.player = new (scope().YT!.Player)(frame, { events: {
        onReady: () => {
          if (this.lifetime.signal.aborted) return;
          if (youtubeVideoId(this.player!.getVideoUrl()) !== this.id) { finish(new Error("watch_source_changed")); return; }
          this.apiReady = true; finish(); this.emit("loadedmetadata");
        },
        onStateChange: ({ data }) => {
          if (this.lifetime.signal.aborted) return;
          if (data === 1) { this.paused = false; this.played = true; this.emit("playing"); }
          else if (data === 2) { this.paused = true; this.emit("pause"); }
          else if (data === 3) this.emit("waiting");
          else if (data === 0) { this.paused = true; this.emit("ended"); }
        },
        onPlaybackRateChange: () => this.emit("ratechange"),
        onAutoplayBlocked: () => { this.emit("blocked"); },
        onError: ({ data }) => {
          const code = data === 101 || data === 150 || data === 100 ? "watch_media_unavailable"
            : data === 2 ? "invalid_watch_url" : data === 5 ? "watch_media_unsupported" : "watch_media_failed";
          this.failure = new Error(code); finish(this.failure); this.emit("error");
        },
      } });
    });
  }

  async read(): Promise<WatchMediaState> {
    this.lifetime.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (!this.apiReady) return { position: 0, paused: true, rate: 1, duration: null, readyState: 0, buffered: null, ended: false };
    const p = this.player!, state = p.getPlayerState(), duration = p.getDuration();
    if (youtubeVideoId(p.getVideoUrl()) !== this.id) throw new Error("watch_source_changed");
    return { position: p.getCurrentTime(), paused: state === 3 ? this.paused : state !== 1,
      rate: p.getPlaybackRate(), duration: duration > 0 ? duration : null,
      readyState: this.played ? state === 1 ? 3 : 2 : 1, buffered: null, ended: state === 0 };
  }

  async patch(value: WatchMediaPatch): Promise<void> {
    if (!Object.keys(value).length) return;
    this.lifetime.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (!this.visible || !this.mounted) throw new Error("watch_autoplay_blocked");
    await abortable(this.mounted, this.lifetime.signal);
    if (value.paused === false) await this.waitForEligibility();
    const p = this.player!;
    if (value.rate !== undefined && !this.playbackRates().includes(value.rate)) throw new Error("watch_media_unsupported");
    // Issue the final pause after seekTo, which can itself start a non-paused player.
    if (value.rate !== undefined) p.setPlaybackRate(value.rate);
    if (value.position !== undefined) p.seekTo(value.position, true);
    if (value.paused === true) p.pauseVideo();
    else if (value.paused === false) p.playVideo();
    // The API returns void: dispatch is not confirmation. WatchPlayer reads real state
    // and SDK events report playback, rate changes, autoplay denial and failure.
    this.lifetime.signal.throwIfAborted();
    if (this.failure) throw this.failure;
  }

  private waitForEligibility(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => { this.visibility.removeEventListener("change", check); this.lifetime.signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      const check = () => { if (!this.visible) finish(new Error("watch_autoplay_blocked")); else if (this.automaticPlayback) finish(); };
      const abort = () => finish(this.lifetime.signal.reason);
      this.visibility.addEventListener("change", check); this.lifetime.signal.addEventListener("abort", abort, { once: true }); check();
    });
  }

  listen(changed: (event: WatchMediaEvent) => void): () => void { this.listeners.add(changed); return () => this.listeners.delete(changed); }
  private emit(event: WatchMediaEvent): void { if (!this.lifetime.signal.aborted) for (const changed of this.listeners) changed(event); }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); this.player?.destroy(); this.element.remove();
    for (const changed of this.listeners) changed("closed");
    this.listeners.clear();
  }
}
