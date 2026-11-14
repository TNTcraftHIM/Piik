import type { WatchPlayback } from "./protocol";

export function watchPosition(playback: WatchPlayback, now: number): number {
  return playback.position + (playback.paused ? 0 : Math.max(0, now - playback.anchorTime) / 1000 * playback.rate);
}

/** One activity owns this element through preparation, mounting and recovery. */
export class WatchPlayer {
  readonly video = document.createElement("video");
  blocked = false;
  error: string | null = null;
  private offset: number | null = null;
  private playback: WatchPlayback | null = null;
  private retired = false;
  private timer: ReturnType<typeof setInterval>;
  private lifetime = new AbortController();
  private operations = Promise.resolve();
  private publishPlayback: ((playback: WatchPlayback) => Promise<void>) | null = null;
  private lastPublished: WatchPlayback | null = null;

  constructor(readonly roomId: string, readonly owner: boolean, url: string, private changed: () => void) {
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.src = url;
    this.video.addEventListener("loadedmetadata", () => this.align(true), { signal: this.lifetime.signal });
    this.video.addEventListener("error", () => { this.error = "watch_media_failed"; this.changed(); }, { signal: this.lifetime.signal });
    if (owner) for (const type of ["play", "playing", "pause", "seeked", "ratechange", "ended"]) {
      this.video.addEventListener(type, () => { void this.publish(type === "playing").catch(() => {
        if (!this.retired) { this.error = "watch_update_failed"; this.changed(); }
      }); }, { signal: this.lifetime.signal });
    }
    this.timer = setInterval(() => this.align(), 1000);
  }

  ready(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.video.removeEventListener("loadeddata", loaded);
        this.video.removeEventListener("error", failed);
        signal.removeEventListener("abort", cancelled);
        error ? reject(error) : resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error("watch_media_failed"));
      const cancelled = () => finish(new DOMException("Cancelled", "AbortError"));
      const timer = setTimeout(failed, 20000);
      this.video.addEventListener("loadeddata", loaded);
      this.video.addEventListener("error", failed);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else if (this.video.readyState >= 2) loaded();
      else if (this.video.error) failed();
    });
  }

  calibrate(serverTime: number, start: number, end = performance.now()): void {
    this.offset = serverTime - (start + end) / 2;
    this.align(true);
  }
  sample(): WatchPlayback {
    if (this.offset === null) throw new Error("watch_clock_unavailable");
    return { position: this.video.currentTime, paused: this.video.paused, rate: this.video.playbackRate, anchorTime: Math.round(performance.now() + this.offset) };
  }
  update(playback: WatchPlayback): void {
    const changed = !this.playback || Object.entries(playback).some(([key, value]) => this.playback![key as keyof WatchPlayback] !== value);
    this.playback = playback;
    if (!this.owner && changed) this.align(true);
  }
  activate(publish: (playback: WatchPlayback) => Promise<void>): void { this.publishPlayback = publish; }
  publish(force = false): Promise<void> {
    if (!this.publishPlayback) return Promise.resolve();
    const playback = this.sample(), previous = this.lastPublished;
    if (!force && previous && previous.position === playback.position && previous.paused === playback.paused && previous.rate === playback.rate) return Promise.resolve();
    this.lastPublished = playback;
    return this.serialize(async () => {
      await this.publishPlayback?.(playback);
      if (!this.retired && this.error === "watch_update_failed") { this.error = null; this.changed(); }
    });
  }
  private align(force = false): void {
    if (this.retired || this.owner || !this.playback || this.offset === null || this.video.readyState < 1) return;
    const target = Math.min(watchPosition(this.playback, performance.now() + this.offset), Number.isFinite(this.video.duration) ? this.video.duration : Infinity);
    if (Math.abs(this.video.currentTime - target) > (force ? 0.12 : 0.35)) this.video.currentTime = target;
    this.video.playbackRate = this.playback.rate;
    if (this.playback.paused) this.video.pause();
    else if (this.video.paused && !this.blocked && !this.video.ended) void this.play();
  }
  async play(): Promise<void> {
    if (this.retired) return;
    try { await this.video.play(); this.blocked = false; }
    catch { if (!this.retired) this.blocked = true; }
    if (!this.retired) this.changed();
  }
  resume(): Promise<void> {
    this.align(true);
    return !this.owner && this.playback?.paused ? Promise.resolve() : this.play();
  }
  serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(() => { if (!this.retired) return operation(); });
    this.operations = result.catch(() => {});
    return result;
  }
  close(): void {
    this.retired = true;
    this.publishPlayback = null;
    clearInterval(this.timer);
    this.lifetime.abort();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
  }
}
