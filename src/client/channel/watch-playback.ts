import type { WatchPlayback, WatchMode } from "./protocol";
import { HTMLVideoMedia, type WatchMedia, type WatchMediaPatch, type WatchMediaState } from "./watch-media";

const mediaFailure = (error?: unknown): string => error instanceof Error && error.message ? error.message : "watch_media_failed";

export function watchPosition(playback: WatchPlayback, now: number): number {
  return playback.position + (playback.paused ? 0 : Math.max(0, now - playback.anchorTime) / 1000 * playback.rate);
}

/** One activity owns its local player, domain clock and operation queue. */
export class WatchPlayer {
  get video(): HTMLVideoElement | null { return this.media instanceof HTMLVideoMedia ? this.media.video : null; }
  mode: WatchMode = "direct";
  blocked = false;
  error: string | null = null;
  private localState: WatchMediaState | null = null;
  get mediaState(): Readonly<WatchMediaState> | null { return this.localState; }
  private offset: number | null = null;
  private playback: WatchPlayback | null = null;
  private retired = false;
  private prepared = false;
  private lifetime = new AbortController();
  private timer: ReturnType<typeof setInterval>;
  private unlisten: () => void;
  private operations = Promise.resolve();
  private alignment: Promise<void> | null = null;
  private publishPlayback: ((playback: WatchPlayback) => Promise<void>) | null = null;
  private lastPublished: WatchPlayback | null = null;

  constructor(readonly roomId: string, readonly owner: boolean, readonly media: WatchMedia,
    private changed: () => void, private closed: () => void = () => {}) {
    this.unlisten = media.listen(event => {
      if (event === "closed") { this.close(); this.closed(); return; }
      if (event === "error") void this.mediaError();
      if (event === "blocked") { this.blocked = true; this.changed(); }
      if (event === "loadedmetadata") void this.align(true);
      if (owner && ["play", "playing", "pause", "seeked", "ratechange", "ended"].includes(event))
        void this.publish(event === "playing").catch(() => {
          if (!this.retired) { this.error = "watch_update_failed"; this.changed(); }
        });
    });
    this.timer = setInterval(() => { void this.align(); }, 1000);
  }
  async ready(signal: AbortSignal = this.lifetime.signal): Promise<void> {
    await this.media.ready(signal);
    if (this.retired) throw new DOMException("Cancelled", "AbortError");
    this.prepared = true;
    await this.align(true);
  }
  private async mediaError(): Promise<void> {
    if (this.retired) return;
    await this.media.read().then(() => this.failMedia(), error => this.failMedia(error));
  }
  private failMedia(error?: unknown): void {
    if (this.retired) return;
    this.error = mediaFailure(error);
    this.changed();
  }
  calibrate(serverTime: number, start: number, end = performance.now()): void {
    this.offset = serverTime - (start + end) / 2;
    void this.align(true);
  }
  async sample(): Promise<WatchPlayback> {
    if (this.offset === null) throw new Error("watch_clock_unavailable");
    const start = performance.now(), state = await this.media.read(), end = performance.now();
    if (this.retired) throw new Error("watch_retired");
    this.observe(state);
    return { position: state.position, paused: state.paused, rate: state.rate, anchorTime: Math.round((start + end) / 2 + this.offset) };
  }
  private observe(state: WatchMediaState): void {
    if (this.retired) return;
    const previous = this.localState;
    const changed = !previous
      || Object.entries(state).some(([key, value]) => key !== "buffered" && previous[key as keyof WatchMediaState] !== value)
      || state.buffered.length !== previous.buffered.length
      || state.buffered.some(([start, end], index) => start !== previous.buffered[index][0] || end !== previous.buffered[index][1]);
    this.localState = state;
    if (changed) this.changed();
  }
  update(playback: WatchPlayback): void {
    const changed = !this.playback || Object.entries(playback).some(([key, value]) => this.playback![key as keyof WatchPlayback] !== value);
    this.playback = playback;
    if (!this.owner && changed) void this.align(true);
  }
  activate(publish: (playback: WatchPlayback) => Promise<void>): void { this.publishPlayback = publish; }
  publish(force = false): Promise<void> {
    return this.serialize(async () => {
      if (!this.publishPlayback) return;
      const playback = await this.sample(), previous = this.lastPublished;
      if (!force && previous && previous.position === playback.position && previous.paused === playback.paused && previous.rate === playback.rate) return;
      this.lastPublished = playback;
      await this.publishPlayback?.(playback);
      if (!this.retired && this.error === "watch_update_failed") { this.error = null; this.changed(); }
    });
  }
  private align(force = false): Promise<void> {
    if (this.retired || !this.prepared || !this.owner && (!this.playback || this.offset === null)) return Promise.resolve();
    if (this.alignment) return this.alignment;
    const operation = this.serialize(async () => {
      const state = await this.media.read();
      this.observe(state);
      if (this.owner) return;
      if (this.retired || state.readyState < 1 || !this.playback || this.offset === null) return;
      const playback = this.playback;
      const target = Math.min(watchPosition(playback, performance.now() + this.offset), state.duration ?? Infinity);
      const patch: WatchMediaPatch = {};
      const buffered = state.buffered.some(([start, end]) => start <= target && target < end);
      if ((force || state.readyState >= 3 && buffered) && Math.abs(state.position - target) > (force ? 0.12 : 0.35)) patch.position = target;
      if (state.rate !== playback.rate) patch.rate = playback.rate;
      if (playback.paused && !state.paused) patch.paused = true;
      else if (!playback.paused && state.paused && !this.blocked && !state.ended) patch.paused = false;
      await this.apply(patch);
    }).catch(error => this.failMedia(error));
    this.alignment = operation;
    void operation.finally(() => { if (this.alignment === operation) this.alignment = null; });
    return operation;
  }
  private async apply(patch: WatchMediaPatch): Promise<void> {
    try {
      await this.media.patch(patch);
      if (patch.paused === false && !this.retired) this.blocked = false;
    } catch (error) {
      if (!this.retired) {
        if (error instanceof Error && (error.name === "NotAllowedError" || error.message === "watch_autoplay_blocked")) this.blocked = true;
        else { this.failMedia(error); return; }
      }
    }
    if (!this.retired) this.changed();
  }
  patch(value: WatchMediaPatch): Promise<void> { return this.serialize(() => this.apply(value)); }
  play(): Promise<void> { return this.patch({ paused: false }); }
  async resume(): Promise<void> {
    await this.align(true);
    if (this.owner || !this.playback?.paused) await this.play();
  }
  serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(() => { if (!this.retired) return operation(); });
    this.operations = result.catch(() => {});
    return result;
  }
  close(): void {
    if (this.retired) return;
    this.retired = true;
    this.lifetime.abort();
    this.publishPlayback = null;
    clearInterval(this.timer);
    this.unlisten();
    this.media.close();
  }
}
