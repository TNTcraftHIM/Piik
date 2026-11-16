import type { WatchPlayback, WatchMode } from "./protocol";
import { type WatchMedia, type WatchMediaPatch, type WatchMediaState } from "./watch-media";

const mediaFailure = (error?: unknown): string => error instanceof Error && error.message ? error.message : "watch_media_failed";

export function watchPosition(playback: WatchPlayback, now: number): number {
  return playback.position + (playback.paused ? 0 : Math.max(0, now - playback.anchorTime) / 1000 * playback.rate);
}

/** One activity owns its local player, domain clock and operation queue. */
export class WatchPlayer {
  get presentation() { return this.media.presentation ?? { kind: "external" as const }; }
  get video(): HTMLVideoElement | null { return this.presentation.kind === "video" ? this.presentation.element : null; }
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
  private alignment: Promise<boolean> | null = null;
  private publishPlayback: ((playback: WatchPlayback) => Promise<void>) | null = null;
  private lastPublished: WatchPlayback | null = null;
  private observedAt = 0;

  constructor(readonly roomId: string, readonly owner: boolean, readonly media: WatchMedia,
    private changed: () => void, private closed: () => void = () => {}) {
    this.unlisten = media.listen(event => {
      if (event === "closed") { this.close(); this.closed(); return; }
      if (event === "error") void this.mediaError();
      if (event === "playing") { this.blocked = false; this.changed(); }
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
    return { timeline: state.live ? "program" : "media", position: state.position, paused: state.paused, rate: state.rate, anchorTime: Math.round((start + end) / 2 + this.offset) };
  }
  private observe(state: WatchMediaState): void {
    if (this.retired) return;
    const previous = this.localState;
    const changed = !previous
      || Object.entries(state).some(([key, value]) => key !== "buffered" && previous[key as keyof WatchMediaState] !== value)
      || state.buffered?.length !== previous.buffered?.length
      || !!state.buffered?.some(([start, end], index) => start !== previous.buffered?.[index][0] || end !== previous.buffered?.[index][1]);
    this.localState = state;
    this.observedAt = performance.now();
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
  private align(force = false, explicit = false): Promise<boolean> {
    if (this.retired || !this.prepared || !this.owner && (!this.playback || this.offset === null)) return Promise.resolve(false);
    if (this.alignment) return this.alignment;
    let aligned = true;
    const operation = this.serialize(async () => {
      const state = await this.media.read(), now = performance.now();
      const previous = this.localState, previousAt = this.observedAt;
      this.observe(state); this.observedAt = now;
      if (this.owner) {
        // Some platform players expose time but no user-seek event. Reuse this observation turn.
        if (this.media.seekEvents === false && previous && (state.readyState >= 3 || state.paused && previous.paused)
          && Math.abs(state.position - (previous.position + (previous.paused ? 0 : (now - previousAt) / 1000 * previous.rate))) > (this.media.seekTolerance ?? 0.35))
          void this.publish(true).catch(error => this.failMedia(error));
        return;
      }
      if (this.retired || state.readyState < 1 || !this.playback || this.offset === null) { aligned = false; return; }
      if (this.media.seekEvents === false && previous && (state.readyState >= 3 && previous.readyState >= 3 || state.paused && previous.paused)
        && Math.abs(state.position - (previous.position + (previous.paused ? 0 : (now - previousAt) / 1000 * previous.rate))) > (this.media.seekTolerance ?? 0.35)) {
        this.blocked = true; this.changed();
      }
      const playback = this.playback;
      if (playback.timeline !== (state.live ? "program" : "media")) throw new Error("watch_timeline_changed");
      const position = watchPosition(playback, performance.now() + this.offset);
      const target = playback.timeline === "program" ? position : Math.min(position, state.duration ?? Infinity);
      const patch: WatchMediaPatch = {};
      if (!explicit && this.media.playbackAvailable?.() === false) { aligned = false; return; }
      const buffered = state.buffered?.some(([start, end]) => start <= target && target < end);
      const displaced = Math.abs(state.position - target) > (this.media.seekTolerance ?? (force ? 0.12 : 0.35));
      if (state.live && displaced && !buffered && !state.live.seekable.some(([start, end]) => start <= target && target <= end)) {
        aligned = false;
        await this.apply({ paused: true });
        this.error = "watch_live_position_unavailable"; this.changed();
        return;
      }
      if (this.error === "watch_live_position_unavailable") { this.error = null; this.changed(); }
      // Unknown buffering permits explicit host commands, not invented periodic drift correction.
      if ((force || state.readyState >= 3 && buffered) && displaced) patch.position = target;
      if (state.rate !== playback.rate) {
        if (this.media.playbackRates && !this.media.playbackRates().includes(playback.rate)) throw new Error("watch_media_unsupported");
        patch.rate = playback.rate;
      }
      if (playback.paused && !state.paused) patch.paused = true;
      else if (!playback.paused && state.paused && !this.blocked && !state.ended) patch.paused = false;
      await this.apply(patch);
      aligned = !this.error || this.error === "watch_update_failed";
    }).then(() => aligned).catch(error => { this.failMedia(error); return false; });
    this.alignment = operation;
    void operation.finally(() => { if (this.alignment === operation) this.alignment = null; });
    return operation;
  }
  private async apply(patch: WatchMediaPatch): Promise<void> {
    try {
      await this.media.patch(patch);
      if (this.error === "watch_live_position_unavailable" && patch.position !== undefined) this.error = null;
      if (this.media.seekEvents === false && Object.keys(patch).length) this.observe(await this.media.read());
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
    if (!await this.align(true, true)) return;
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
