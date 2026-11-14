import Hls from "hls.js";
import { openWatchResource, type WatchByteReader, type WatchResourceLease } from "./watch-resource";

export interface WatchMediaState {
  position: number;
  paused: boolean;
  rate: number;
  duration: number | null;
  readyState: number;
  ended: boolean;
}
export type WatchMediaPatch = Partial<Pick<WatchMediaState, "position" | "paused" | "rate">>;
export type WatchMediaEvent = "loadedmetadata" | "loadeddata" | "play" | "playing" | "pause" | "seeked" | "ratechange" | "ended" | "waiting" | "error" | "blocked" | "closed";

/** Local player access only. Domain clocks and shared playback belong to WatchPlayer. */
export interface WatchMedia {
  read(): Promise<WatchMediaState>;
  patch(value: WatchMediaPatch): Promise<void>;
  ready(signal: AbortSignal): Promise<void>;
  listen(changed: (event: WatchMediaEvent) => void): () => void;
  close(): void;
}

function ready(media: WatchMedia, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let checking = false, finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); unlisten(); signal.removeEventListener("abort", cancel);
      error ? reject(error) : resolve();
    };
    const cancel = () => finish(new DOMException("Cancelled", "AbortError"));
    const check = () => {
      if (checking || finished) return;
      checking = true;
      void media.read().then(state => { if (state.readyState >= 2) finish(); }, error => finish(error))
        .finally(() => { checking = false; });
    };
    const timer = setTimeout(() => finish(new Error("watch_media_failed")), 20000);
    const unlisten = media.listen(event => {
      if (event === "error" || event === "closed") finish(new Error("watch_media_failed"));
      else check();
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel(); else check();
  });
}

export class HTMLVideoMedia implements WatchMedia {
  readonly video = document.createElement("video");
  private lifetime = new AbortController();
  private setup: Promise<void>;
  private hls?: Hls;
  private resource?: WatchResourceLease;
  private failed = false;
  constructor(url: string | ((signal: AbortSignal) => Promise<WatchResourceLease>), format?: "file" | "hls") {
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.setup = this.load(url, format).catch(error => {
      if (this.lifetime.signal.aborted) return;
      this.failed = true; this.video.dispatchEvent(new Event("error"));
      throw error;
    });
    void this.setup.catch(() => {});
  }
  private async load(source: string | ((signal: AbortSignal) => Promise<WatchResourceLease>), format?: "file" | "hls"): Promise<void> {
    let url: string;
    if (typeof source === "function") {
      const resource = await source(this.lifetime.signal);
      if (this.lifetime.signal.aborted) { resource.close(); return; }
      this.resource = resource; url = resource.url;
    } else url = source;
    const detected = format ?? await detectWatchFormat(url, this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    if (detected === "hls" && Hls.isSupported()) {
      const hls = this.hls = new Hls({ backBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_event, error) => {
        if (!error.fatal || this.lifetime.signal.aborted) return;
        this.failed = true; this.video.dispatchEvent(new Event("error"));
      });
      hls.loadSource(url); hls.attachMedia(this.video);
    } else this.video.src = url;
  }
  async read(): Promise<WatchMediaState> {
    await this.setup;
    const video = this.video;
    if (video.error || this.failed) throw new Error("watch_media_failed");
    return { position: video.currentTime, paused: video.paused, rate: video.playbackRate,
      duration: Number.isFinite(video.duration) ? video.duration : null, readyState: video.readyState, ended: video.ended };
  }
  async patch(value: WatchMediaPatch): Promise<void> {
    await this.setup;
    this.lifetime.signal.throwIfAborted();
    if (value.position !== undefined) this.video.currentTime = value.position;
    if (value.rate !== undefined) this.video.playbackRate = value.rate;
    if (value.paused === true) this.video.pause();
    else if (value.paused === false) await this.video.play();
  }
  ready(signal: AbortSignal): Promise<void> { return ready(this, signal); }
  listen(changed: (event: WatchMediaEvent) => void): () => void {
    const lifetime = new AbortController();
    for (const event of ["loadedmetadata", "loadeddata", "play", "playing", "pause", "seeked", "ratechange", "ended", "waiting", "error", "closed"] as const)
      this.video.addEventListener(event, () => changed(event), { signal: lifetime.signal });
    return () => lifetime.abort();
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); this.hls?.destroy(); this.resource?.close();
    this.video.dispatchEvent(new Event("closed"));
    this.video.pause(); this.video.removeAttribute("src"); this.video.load(); this.video.remove();
  }
}

/** The owner's rewritten HLS playlists use only opaque resource UUID basenames. */
export function createPeerWatchMedia(source: { resourceId: string; format: "file" | "hls" }, read: WatchByteReader): HTMLVideoMedia {
  return new HTMLVideoMedia(signal => openWatchResource(source.resourceId, read, signal), source.format);
}

async function detectWatchFormat(url: string, signal: AbortSignal): Promise<"file" | "hls"> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5000);
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-511" }, signal: AbortSignal.any([signal, timeout.signal]) });
    const reader = response.body?.getReader();
    try {
      if (!response.ok) return "file";
      if (/^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return "hls";
      if (!reader) return "file";
      const header = new Uint8Array(512); let used = 0;
      while (used < header.length) {
        const chunk = await reader.read(); if (chunk.done) break;
        const length = Math.min(chunk.value.byteLength, header.length - used);
        header.set(chunk.value.subarray(0, length), used); used += length;
      }
      return new TextDecoder().decode(header.subarray(0, used)).replace(/^\uFEFF/, "").startsWith("#EXTM3U") ? "hls" : "file";
    } finally { await reader?.cancel(); }
  } catch { signal.throwIfAborted(); return "file"; }
  finally { clearTimeout(timer); }
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
  ready(signal: AbortSignal): Promise<void> { return ready(this, signal); }
  listen(changed: (event: WatchMediaEvent) => void): () => void { this.listeners.add(changed); return () => this.listeners.delete(changed); }
  close(): void { this.lifetime.abort(); this.unlisten?.(); this.listeners.clear(); this.page?.close(); }
}
