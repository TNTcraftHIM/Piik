import type Hls from "hls.js";
import type { WatchByteSource, WatchTimeline, WatchFormat } from "./protocol";
import { canReadWatchResources, limitWatchReads, openWatchResource, type WatchByteReader, type WatchResourceLease } from "./watch-resource";
import { createWatchHlsLoader, watchHlsUrl } from "./watch-hls-loader";
import { canReadWatchMp4, isWatchMp4, WatchMp4Media } from "./watch-mp4-media";
import { watchElementFailure } from "./watch-media-failure";
import { WatchDashMedia, canReadWatchDash } from "./watch-dash-media";
import { WatchHlsTimeline, type WatchLiveWindow } from "./watch-hls-timeline";

export interface WatchAudioTrack { id: number; name: string; language?: string; channels?: string; selected: boolean }
export interface WatchMediaState {
  position: number;
  paused: boolean;
  rate: number;
  duration: number | null;
  readyState: number;
  buffered: [number, number][] | null;
  ended: boolean;
  live?: WatchLiveWindow;
}
export type WatchMediaPatch = Partial<Pick<WatchMediaState, "position" | "paused" | "rate">>;
export type WatchMediaEvent = "loadedmetadata" | "loadeddata" | "play" | "playing" | "pause" | "seeked" | "ratechange" | "ended" | "waiting" | "error" | "blocked" | "closed" | "audiotracks";

/** Local player access only. Domain clocks and shared playback belong to WatchPlayer. */
export type WatchPresentation = { kind: "video"; element: HTMLVideoElement }
  | { kind: "embed"; element: HTMLElement; setVisible(visible: boolean, automaticPlayback?: boolean): void; mounted(): void }
  | { kind: "external" };

export interface WatchMedia {
  readonly page?: AppPagePort | null;
  readonly retainedByteSource?: WatchByteSource;
  audioAvailable?(): boolean | undefined;
  readonly presentation?: WatchPresentation;
  readonly seekTolerance?: number;
  readonly seekEvents?: boolean;
  playbackAvailable?(): boolean;
  playbackRates?(): readonly number[];
  audioTracks?(): readonly WatchAudioTrack[];
  selectAudioTrack?(id: number): void;
  waitForPresentation?(signal: AbortSignal): Promise<void>;
  read(): Promise<WatchMediaState>;
  patch(value: WatchMediaPatch): Promise<void>;
  ready(signal: AbortSignal): Promise<void>;
  listen(changed: (event: WatchMediaEvent) => void): () => void;
  close(): void;
}

export function waitForWatchMedia(media: Pick<WatchMedia, "read" | "listen">, signal: AbortSignal, setup?: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let checking = false, checkAgain = false, finished = false, prepared = !setup, failed = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      unlisten(); signal.removeEventListener("abort", cancel);
      error ? reject(error) : resolve();
    };
    const cancel = () => finish(new DOMException("Cancelled", "AbortError"));
    const check = () => {
      if (!prepared || finished) return;
      if (checking) { checkAgain = true; return; }
      checking = true;
      void media.read().then(state => {
        if (failed) finish(new Error("watch_media_failed"));
        else if (state.readyState >= 2) finish();
      }, error => finish(error))
        .finally(() => {
          checking = false;
          if (checkAgain) { checkAgain = false; check(); }
        });
    };
    const unlisten = media.listen(event => {
      if (event === "closed") finish(new Error("watch_media_failed"));
      else {
        if (event === "error" && prepared) failed = true;
        check();
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else if (setup) void setup.then(() => { prepared = true; check(); }, error => finish(error));
    else check();
  });
}

export class HTMLVideoMedia implements WatchMedia {
  readonly video = document.createElement("video");
  readonly presentation = { kind: "video" as const, element: this.video };
  private lifetime = new AbortController();
  private setup: Promise<void>;
  // The same media lease proves initial data once; seeking does not revoke that proof.
  private initialDataReady = false;
  private hls?: Hls;
  private hlsTimeline?: WatchHlsTimeline;
  private resource?: WatchResourceLease;
  private mp4?: WatchMp4Media;
  private dash?: WatchDashMedia;
  private failure: Error | null = null;
  constructor(url: string | ((signal: AbortSignal) => Promise<WatchResourceLease>) | { resourceId: string; read: WatchByteReader }, format?: WatchFormat, private timeline?: WatchTimeline) {
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.setup = this.load(url, format).catch(error => {
      if (this.lifetime.signal.aborted) return;
      this.failure = error instanceof Error ? error : new Error("watch_media_failed"); this.video.dispatchEvent(new Event("error"));
      throw error;
    });
    void this.setup.catch(() => {});
  }
  private async load(source: string | ((signal: AbortSignal) => Promise<WatchResourceLease>) | { resourceId: string; read: WatchByteReader }, format?: WatchFormat): Promise<void> {
    let url: string;
    let hlsModule: typeof import("./watch-hls") | undefined;
    let peerRead: WatchByteReader | undefined;
    if (typeof source === "object") {
      const peer = source;
      if (format === "dash") {
        if (this.timeline === "program") throw new Error("watch_live_timeline_unsupported");
        const dash = this.dash = new WatchDashMedia(this.video, peer.resourceId, peer.read, this.lifetime.signal, error => {
          this.failure = error; this.video.dispatchEvent(new Event("error"));
        });
        await dash.open(); return;
      }
      if (format === "hls") {
        hlsModule = await import("./watch-hls");
        this.lifetime.signal.throwIfAborted();
      }
      if (hlsModule?.Hls.isSupported()) { peerRead = peer.read; source = watchHlsUrl(peer.resourceId); }
      else {
        const read = limitWatchReads(peer.read);
        if (format === "file" && canReadWatchMp4()) {
          const first = await read(peer.resourceId, 0, 65536, this.lifetime.signal);
          this.lifetime.signal.throwIfAborted();
          if (isWatchMp4(first)) {
            const mp4 = this.mp4 = new WatchMp4Media(this.video, peer.resourceId, read, first, this.lifetime.signal, error => {
              this.failure = error; this.video.dispatchEvent(new Event("error"));
            });
            try { await mp4.open(); return; }
            catch (error) {
              mp4.close(); this.mp4 = undefined; this.lifetime.signal.throwIfAborted();
              // Only a known MSE capability rejection retains the native URL path.
              if (!(error instanceof Error) || error.message !== "watch_mp4_mse_unavailable") throw error;
            }
          }
        }
        source = signal => openWatchResource(peer.resourceId, peer.read, signal);
      }
    }
    if (format === "dash") throw new Error("watch_media_unsupported");
    if (typeof source === "function") {
      const resource = await source(this.lifetime.signal);
      if (this.lifetime.signal.aborted) { resource.close(); return; }
      this.resource = resource; url = resource.url;
    } else url = source;
    const detected = format ?? await detectWatchFormat(url, this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    if (detected === "unknown" && this.timeline !== "media") throw new Error("watch_source_inspection_unavailable");
    if (detected === "hls") {
      hlsModule ??= await import("./watch-hls");
      this.lifetime.signal.throwIfAborted();
    }
    if (hlsModule?.Hls.isSupported()) {
      const { Hls, watchHlsFailure } = hlsModule;
      const hls = this.hls = new Hls({ backBufferLength: 30, liveDurationInfinity: true, lowLatencyMode: false,
        ...(peerRead && { loader: createWatchHlsLoader(peerRead, this.lifetime.signal) }) });
      this.hlsTimeline = new WatchHlsTimeline(hls, this.timeline);
      for (const event of [Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.AUDIO_TRACK_SWITCHING, Hls.Events.AUDIO_TRACK_SWITCHED])
        hls.on(event, () => this.video.dispatchEvent(new Event("audiotracks")));
      hls.on(Hls.Events.ERROR, (_event, error) => {
        if (!error.fatal || this.lifetime.signal.aborted) return;
        const failure = watchHlsFailure(error, !!peerRead);
        this.failure = new Error(failure === "watch_media_failed" ? watchElementFailure(this.video.error) ?? failure : failure); this.video.dispatchEvent(new Event("error"));
      });
      hls.loadSource(url); hls.attachMedia(this.video);
    } else {
      if (this.timeline === "program") throw new Error("watch_live_timeline_unsupported");
      if (detected === "hls" && this.timeline === undefined) await requireNativeHlsVod(url, this.lifetime.signal);
      this.video.src = url;
    }
  }
  private playbackError(): Error | null {
    if (this.failure) return this.failure;
    const code = watchElementFailure(this.video.error);
    return code ? new Error(code) : null;
  }
  async read(): Promise<WatchMediaState> {
    await this.setup;
    const video = this.video;
    const error = this.playbackError();
    if (error) throw error;
    const program = video.readyState >= 1 ? this.hlsTimeline?.read(video) : null;
    return { position: video.currentTime, paused: video.paused, rate: video.playbackRate,
      duration: program ? null : Number.isFinite(video.duration) ? video.duration : null, readyState: video.readyState,
      buffered: Array.from({ length: video.buffered.length }, (_, i): [number, number] => [video.buffered.start(i), video.buffered.end(i)]), ended: video.ended, ...program };
  }
  async patch(value: WatchMediaPatch): Promise<void> {
    await this.setup;
    this.lifetime.signal.throwIfAborted();
    if (value.position !== undefined) this.video.currentTime = this.hlsTimeline?.localPosition(value.position) ?? value.position;
    if (value.rate !== undefined) this.video.playbackRate = value.rate;
    if (value.paused === true) this.video.pause();
    // An unresolved play must not block a later seek or pause in the control owner.
    else if (value.paused === false) void this.video.play().catch(error => {
      if (this.lifetime.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof DOMException && error.name === "NotAllowedError") this.video.dispatchEvent(new Event("blocked"));
      else {
        this.failure = new Error(watchElementFailure(this.video.error) ?? "watch_media_failed");
        this.video.dispatchEvent(new Event("error"));
      }
    });
  }
  async ready(signal: AbortSignal): Promise<void> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    try {
      lifetime.throwIfAborted();
      if (!this.initialDataReady) {
        await waitForWatchMedia(this, lifetime, this.setup);
        this.initialDataReady = true;
      } else await this.read();
      lifetime.throwIfAborted();
    } catch (error) {
      const reason = lifetime.aborted ? error : this.playbackError() ?? error;
      this.dispose();
      throw reason;
    }
  }
  audioAvailable(): boolean | undefined { return this.dash?.audioAvailable(); }
  listen(changed: (event: WatchMediaEvent) => void): () => void {
    const lifetime = new AbortController();
    for (const event of ["loadedmetadata", "loadeddata", "play", "playing", "pause", "seeked", "ratechange", "ended", "waiting", "error", "blocked", "closed", "audiotracks"] as const)
      this.video.addEventListener(event, () => changed(event), { signal: lifetime.signal });
    return () => lifetime.abort();
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.dispose();
    this.video.dispatchEvent(new Event("closed"));
  }
  audioTracks(): readonly WatchAudioTrack[] {
    return this.hls?.audioTracks.map((track, id) => ({ id, name: track.name, language: track.lang,
      channels: track.channels, selected: id === this.hls!.audioTrack })) ?? [];
  }
  selectAudioTrack(id: number): void {
    if (this.lifetime.signal.aborted || !Number.isInteger(id) || !this.hls?.audioTracks[id]) return;
    const { name, lang, assocLang, characteristics, channels, audioCodec } = this.hls.audioTracks[id];
    this.hls.setAudioOption({ name, lang, assocLang, characteristics, channels, audioCodec, flushImmediate: true });
  }
  private dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); this.hls?.destroy(); this.mp4?.close(); this.dash?.close(); this.resource?.close();
    this.video.pause(); this.video.removeAttribute("src"); this.video.load(); this.video.remove();
  }
}

/** Native-supplied manifests resolve only opaque resources through their reader. */
export function canReceivePeerWatch(format?: WatchFormat, hlsSupported = false): boolean {
  if (format === "dash") return canReadWatchDash();
  return format === "hls" && hlsSupported || format === "file" && canReadWatchMp4() || canReadWatchResources();
}

export function createPeerWatchMedia(source: { resourceId: string; format: WatchFormat }, read: WatchByteReader, timeline?: WatchTimeline): HTMLVideoMedia {
  return new HTMLVideoMedia({ resourceId: source.resourceId, read }, source.format, timeline);
}

async function detectWatchFormat(url: string, signal: AbortSignal): Promise<WatchFormat | "unknown"> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5000);
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-511" }, signal: AbortSignal.any([signal, timeout.signal]) });
    const reader = response.body?.getReader();
    try {
      if (!response.ok) return "unknown";
      if (/^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return "hls";
      if (!reader) return "unknown";
      const header = new Uint8Array(512); let used = 0;
      while (used < header.length) {
        const chunk = await reader.read(); if (chunk.done) break;
        const length = Math.min(chunk.value.byteLength, header.length - used);
        header.set(chunk.value.subarray(0, length), used); used += length;
      }
      return new TextDecoder().decode(header.subarray(0, used)).replace(/^\uFEFF/, "").startsWith("#EXTM3U") ? "hls" : "file";
    } finally { await reader?.cancel(); }
  } catch { signal.throwIfAborted(); return "unknown"; }
  finally { clearTimeout(timer); }
}

/** Native HLS has no cross-player date API: an explicit ended media playlist proves VOD. */
async function requireNativeHlsVod(url: string, signal: AbortSignal): Promise<void> {
  const reading = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const response = await fetch(url, { signal: reading });
  const reader = response.body?.getReader();
  const limit = 1024 * 1024, bytes = new Uint8Array(limit);
  let used = 0;
  try {
    if (!response.ok || !reader) throw new Error("watch_source_inspection_unavailable");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.length > limit) throw new Error("watch_manifest_limit");
      bytes.set(chunk.value, used); used += chunk.value.length;
    }
  } finally { await reader?.cancel(); }
  signal.throwIfAborted();
  const text = new TextDecoder().decode(bytes.subarray(0, used));
  const { M3U8Parser, PlaylistLevelType } = await import("./watch-hls");
  signal.throwIfAborted();
  if (!M3U8Parser.isMediaPlaylist(text)) throw new Error("watch_source_inspection_unavailable");
  const details = M3U8Parser.parseLevelPlaylist(text, url, 0, PlaylistLevelType.MAIN, 0, null);
  if (details.live || details.playlistParsingError || !details.fragments.length) throw new Error("watch_live_timeline_unsupported");
}

/** The App link owns the selected webpage and rejects outstanding reads on close. */
export interface AppPagePort {
  read(): Promise<WatchMediaState>;
  patch(value: WatchMediaPatch): Promise<void>;
  listen(changed: (event: WatchMediaEvent) => void): () => void;
  focus(): Promise<void>;
  close(): void;
}
export class AppPageMedia implements WatchMedia {
  readonly presentation = { kind: "external" as const };
  page: AppPagePort | null = null;
  readonly opening: Promise<AppPagePort>;
  private lifetime = new AbortController();
  private listeners = new Set<(event: WatchMediaEvent) => void>();
  private unlisten?: () => void;
  constructor(page: AppPagePort | ((signal: AbortSignal) => Promise<AppPagePort>)) {
    this.opening = Promise.resolve().then(() => typeof page === "function" ? page(this.lifetime.signal) : page).then(value => {
      if (this.lifetime.signal.aborted) { value.close(); throw new DOMException("Cancelled", "AbortError"); }
      this.page = value;
      this.unlisten = value.listen(event => { for (const listener of this.listeners) listener(event); });
      return value;
    });
    void this.opening.catch(() => {});
  }
  async read(): Promise<WatchMediaState> { return (await this.opening).read(); }
  async patch(value: WatchMediaPatch): Promise<void> { await (await this.opening).patch(value); }
  ready(signal: AbortSignal): Promise<void> { return waitForWatchMedia(this, signal); }
  listen(changed: (event: WatchMediaEvent) => void): () => void { this.listeners.add(changed); return () => this.listeners.delete(changed); }
  close(): void { this.lifetime.abort(); this.unlisten?.(); this.listeners.clear(); this.page?.close(); }
}

/** Explicit sharer seeks land on available content without changing received anchors. */
export function watchSeekPosition(position: number, ranges: readonly (readonly [number, number])[], direction = 0): number {
  if (direction > 0) {
    const range = ranges.find(([, end]) => position <= end);
    return range ? Math.max(position, range[0]) : (ranges.at(-1)?.[1] ?? position);
  }
  if (direction < 0) {
    const range = ranges.findLast(([start]) => start <= position);
    return range ? Math.min(position, range[1]) : (ranges[0]?.[0] ?? position);
  }
  let nearest = position, distance = Infinity;
  for (const [start, end] of ranges) {
    const target = Math.max(start, Math.min(position, end)), delta = Math.abs(target - position);
    if (delta < distance) { nearest = target; distance = delta; }
  }
  return nearest;
}
