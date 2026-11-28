import { watchPlaybackSchema, type WatchPlayback, type WatchMode } from "./protocol";
import { watchSeekPosition, type WatchMedia, type WatchMediaPatch, type WatchMediaState } from "./watch-media";

const mediaFailure = (error?: unknown): string => error instanceof Error && error.message ? error.message : "watch_media_failed";
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const unsupportedRate = Symbol("unsupported playback rate");
const retiredSource = Symbol("selected source retired");

export function watchPosition(playback: WatchPlayback, now: number): number {
  return playback.position + (playback.paused ? 0 : Math.max(0, now - playback.anchorTime) / 1000 * playback.rate);
}

/** One activity owns its local player, domain clock and operation queue. */
export class WatchPlayer {
  get presentation() { return this.media.presentation ?? { kind: "external" as const }; }
  get video(): HTMLVideoElement | null { return this.presentation.kind === "video" ? this.presentation.element : null; }
  mode: WatchMode | null = null;
  stopRequested = false;
  blockedReason: "autoplay" | "local-seek" | null = null;
  get blocked(): boolean { return this.blockedReason !== null; }
  private failure: string | typeof unsupportedRate | typeof retiredSource | null = null;
  get error(): string | null { return this.failure === unsupportedRate ? "watch_media_unsupported"
    : this.failure === retiredSource ? "watch_source_unavailable" : this.failure; }
  set error(value: string | null) { this.failure = value; }
  private localState: WatchMediaState | null = null;
  get mediaState(): Readonly<WatchMediaState> | null { return this.localState; }
  private mediaListeners = new Set<() => void>();
  subscribeMedia = (listener: () => void) => {
    this.mediaListeners.add(listener);
    return () => { this.mediaListeners.delete(listener); };
  };
  private offset: number | null = null;
  private playback: WatchPlayback | null = null;
  private alignedPlayback: WatchPlayback | null = null;
  private prepared = false;
  private presented = false;
  get hasPresentedFrame(): boolean { return this.presented; }
  get waitingForPicture(): boolean {
    const video = this.video;
    const media = video ?? this.mediaState;
    if (!media) return true;
    const required = media.paused || media.ended ? HAVE_CURRENT_DATA : HAVE_FUTURE_DATA;
    return media.readyState < required || Boolean(video && video.videoWidth > 0 && !this.hasPresentedFrame);
  }
  get hasUsablePicture(): boolean {
    return !this.waitingForPicture && (!this.video || this.hasPresentedFrame);
  }
  presentFrame(): void {
    if (this.signal.aborted || this.presented) return;
    this.presented = true; this.changed();
  }
  private lifetime = new AbortController();
  get signal(): AbortSignal { return this.lifetime.signal; }
  private timer: ReturnType<typeof setInterval>;
  private unlisten: () => void;
  private operations = Promise.resolve();
  private alignment: Promise<boolean> | null = null;
  private alignmentRequest: { force: boolean; explicit: boolean } | null = null;
  private publishPlayback: ((playback: WatchPlayback) => Promise<void>) | null = null;
  private lastPublished: WatchPlayback | null = null;
  private observedAt = 0;
  private ownerWaiting = false;

  constructor(readonly roomId: string, readonly owner: boolean, readonly media: WatchMedia,
    private changed: () => void, private closed: () => void = () => {}) {
    this.unlisten = media.listen(event => {
      if (event === "closed") { this.close(); this.closed(); return; }
      if (event === "source-unavailable") { this.sourceUnavailable(); return; }
      if (event === "error") void this.mediaError();
      if (event === "playing") {
        if (this.blockedReason === "autoplay") this.blockedReason = null;
        this.changed();
      }
      if (event === "blocked") {
        const video = this.video;
        if (video && !video.paused || !owner && this.playback?.paused) return;
        this.blockedReason ??= "autoplay"; this.changed();
      }
      if (["audiotracks", "waiting", "loadeddata", "pause", "ended"].includes(event)) this.changed();
      if (event === "loadedmetadata") void this.align(true);
      if (event === "visibility-resumed" && !owner) {
        this.alignedPlayback = null;
        void this.align(true);
      }
      if (!owner) {
        // Without a local video element, picture readiness comes from the player's latest sample.
        if (!this.video && (event === "emptied" || event === "waiting" || event === "playing" || event === "loadeddata"))
          void this.align();
        return;
      }
      if (event === "waiting") {
        if (this.ownerWaiting) return;
        this.ownerWaiting = true;
      } else if (event === "playing" || event === "pause" || event === "ended") this.ownerWaiting = false;
      if (["waiting", "play", "playing", "pause", "seeked", "ratechange", "ended"].includes(event))
        void this.publish(event === "playing").catch(() => this.failMedia(new Error("watch_update_failed")));
    });
    this.timer = setInterval(() => { void this.align(); }, 1000);
  }
  async ready(signal: AbortSignal = this.lifetime.signal): Promise<void> {
    await this.media.ready(signal);
    if (this.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    this.prepared = true;
    await this.align(true);
  }
  private async mediaError(): Promise<void> {
    if (this.signal.aborted) return;
    await this.media.read().then(() => this.failMedia(), error => this.failMedia(error));
  }
  private failMedia(error?: unknown): void {
    if (this.signal.aborted || this.failure === retiredSource) return;
    const failure = mediaFailure(error);
    if (this.failure === failure) return;
    this.error = failure;
    this.changed();
  }
  sourceUnavailable(committedPause?: WatchMediaState): void {
    if (this.signal.aborted || (!committedPause && this.failure === retiredSource)) return;
    const state = committedPause ?? this.localState;
    if (state) {
      const elapsed = state.paused || state.ended || this.ownerWaiting ? 0 : (performance.now() - this.observedAt) / 1000 * state.rate;
      this.observe({ ...state, position: Math.min(state.position + elapsed, state.duration ?? Infinity), paused: true, readyState: 0, buffered: [] });
    }
    this.failure = retiredSource;
    this.changed();
    if (this.publishPlayback && state) void this.publish(true).catch(() => {});
  }
  private listening?: Pick<HTMLVideoElement, "volume" | "muted">;
  inheritListening(previous?: WatchPlayer): void {
    const settings = previous?.video ?? previous?.listening;
    if (!settings) return;
    const { volume, muted } = settings;
    const video = this.video;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    } else {
      this.listening = { volume, muted };
    }
  }
  inheritClock(player: WatchPlayer): void { this.offset = player.offset; }
  async restorePlayback(playback: WatchPlayback): Promise<void> {
    if (this.offset === null) throw new Error("watch_clock_unavailable");
    const state = await this.media.read();
    if (playback.timeline !== (state.live ? "program" : "media")) throw new Error("watch_timeline_changed");
    const position = watchPosition(playback, performance.now() + this.offset);
    const target = state.live ? watchSeekPosition(position, state.live.seekable) : Math.min(position, state.duration ?? Infinity);
    await this.media.patch({ position: target, rate: playback.rate, paused: playback.paused });
  }
  calibrate(serverTime: number, start: number, end = performance.now()): void {
    this.offset = serverTime - (start + end) / 2;
    this.alignedPlayback = null;
    void this.align(true);
  }
  async sample(): Promise<WatchPlayback> {
    if (this.offset === null) throw new Error("watch_clock_unavailable");
    const start = performance.now(), observed = this.failure === retiredSource && this.localState
      ? this.localState : await this.media.read(), end = performance.now();
    const state = this.failure === retiredSource && this.localState ? this.localState : observed;
    if (this.signal.aborted) throw new Error("watch_retired");
    this.observe(state);
    return { timeline: state.live ? "program" : "media", position: state.position, paused: state.paused || this.ownerWaiting || state.ended, rate: state.rate, anchorTime: Math.round((start + end) / 2 + this.offset) };
  }
  private observe(state: WatchMediaState): void {
    if (this.signal.aborted) return;
    const previous = this.localState;
    const changed = !previous
      || Object.entries(state).some(([key, value]) => key !== "buffered" && previous[key as keyof WatchMediaState] !== value)
      || state.buffered?.length !== previous.buffered?.length
      || !!state.buffered?.some(([start, end], index) => start !== previous.buffered?.[index][0] || end !== previous.buffered?.[index][1]);
    this.observedAt = performance.now();
    if (!changed) return;
    this.localState = state;
    for (const listener of this.mediaListeners) listener();
    // The room also shows picture readiness. Timeline and buffer updates belong to the player.
    if (!previous || previous.readyState !== state.readyState || previous.paused !== state.paused || previous.ended !== state.ended)
      this.changed();
  }
  update(playback: WatchPlayback): void {
    const changed = !this.playback || Object.entries(playback).some(([key, value]) => this.playback![key as keyof WatchPlayback] !== value);
    if (!changed) return;
    this.playback = playback;
    if (!this.owner && playback.paused && this.blockedReason === "autoplay") {
      this.blockedReason = null; this.changed();
    }
    if (!this.owner) void this.align(true);
  }
  activate(publish: (playback: WatchPlayback) => Promise<void>): void { this.publishPlayback = publish; }
  publish(force = false): Promise<void> {
    return this.serialize(async () => {
      if (!this.publishPlayback) return;
      const playback = await this.sample(), previous = this.lastPublished;
      if (!force && previous && previous.position === playback.position && previous.paused === playback.paused && previous.rate === playback.rate) return;
      await this.publishPlayback?.(playback);
      this.lastPublished = playback;
      if (!this.signal.aborted && this.error === "watch_update_failed") { this.error = null; this.changed(); }
    });
  }
  private align(force = false, explicit = false): Promise<boolean> {
    // Viewers can align from metadata; creators still prove readiness before publication.
    if (this.signal.aborted || this.failure === retiredSource || this.owner && !this.prepared || !this.owner && (!this.playback || this.offset === null)) return Promise.resolve(false);
    this.alignmentRequest = {
      force: force || this.alignmentRequest?.force || false,
      explicit: explicit || this.alignmentRequest?.explicit || false,
    };
    if (this.alignment) return this.alignment;
    let aligned = true;
    const operation = this.serialize(async () => {
      while (this.alignmentRequest && !this.signal.aborted) {
        const requested = this.alignmentRequest;
        this.alignmentRequest = null;
        try { aligned = await this.alignCurrent(requested.force, requested.explicit); }
        catch (error) { this.failMedia(error); aligned = false; }
      }
    }).then(() => aligned);
    this.alignment = operation;
    void operation.finally(() => {
      if (this.alignment !== operation) return;
      this.alignment = null;
      const requested = this.alignmentRequest;
      if (requested) void this.align(requested.force, requested.explicit);
    });
    return operation;
  }
  private async alignCurrent(force: boolean, explicit: boolean): Promise<boolean> {
    const state = await this.media.read(), now = performance.now();
    if (this.failure === retiredSource) return false;
    const previous = this.localState, previousAt = this.observedAt;
    this.observe(state); this.observedAt = now;
    if (this.owner) {
      // Some platform players expose time but no user-seek event. Reuse this observation turn.
      if (this.media.seekEvents === false && previous) {
        const expected = previous.position + (previous.paused ? 0 : (now - previousAt) / 1000 * previous.rate);
        const moved = state.paused && previous.paused ? state.position !== previous.position
          : state.readyState >= HAVE_FUTURE_DATA && Math.abs(state.position - expected) > (this.media.seekTolerance ?? 0.35);
        if (moved) void this.publish(true).catch(error => this.failMedia(error));
      }
      return true;
    }
    if (this.signal.aborted || state.readyState < 1 || !this.playback || this.offset === null) return false;
    const playback = this.playback;
    if (playback.timeline !== (state.live ? "program" : "media")) throw new Error("watch_timeline_changed");
    const position = watchPosition(playback, performance.now() + this.offset);
    const target = playback.timeline === "program" ? position : Math.min(position, state.duration ?? Infinity);
    const patch: WatchMediaPatch = {};
    if (!explicit && this.media.playbackAvailable?.() === false) return false;
    force = explicit || force && this.alignedPlayback !== playback;
    const buffered = state.buffered?.some(([start, end]) => start <= target && target < end);
    // A paused anchor identifies a fixed position, including one keyboard seek step.
    const displaced = force && playback.paused ? state.position !== target
      : Math.abs(state.position - target) > (this.media.seekTolerance ?? (force ? 0.12 : 0.35));
    // An iframe can report a shared seek one observation after dispatch.
    if (!force && displaced && this.media.seekEvents === false && previous && (state.readyState >= HAVE_FUTURE_DATA && previous.readyState >= HAVE_FUTURE_DATA || state.paused && previous.paused)
      && Math.abs(state.position - (previous.position + (previous.paused ? 0 : (now - previousAt) / 1000 * previous.rate))) > (this.media.seekTolerance ?? 0.35)) {
      this.blockedReason = "local-seek"; this.changed();
    }
    if (state.live && displaced && !buffered && !state.live.seekable.some(([start, end]) => start <= target && target <= end)) {
      await this.apply({ paused: true });
      this.error = "watch_live_position_unavailable"; this.changed();
      return false;
    }
    if (this.error === "watch_live_position_unavailable") { this.error = null; this.changed(); }
    // Unknown buffering permits explicit host commands, not invented periodic drift correction.
    if ((force || state.readyState >= HAVE_FUTURE_DATA && buffered) && displaced) patch.position = target;
    if (playback.paused && !state.paused) patch.paused = true;
    if (state.rate !== playback.rate && this.media.playbackRates && !this.media.playbackRates().includes(playback.rate)) {
      if (this.failure === null) { this.failure = unsupportedRate; this.changed(); }
      if ((force || playback.paused) && Object.keys(patch).length) await this.apply(patch);
      return false;
    }
    if (this.failure === unsupportedRate) { this.failure = null; this.changed(); }
    if (state.rate !== playback.rate) patch.rate = playback.rate;
    if (!playback.paused && state.paused && !this.blocked && !state.ended) patch.paused = false;
    // Rejoining while this patch is pending invalidates its clock alignment.
    this.alignedPlayback = playback;
    if (Object.keys(patch).length) await this.apply(patch);
    if (this.error && this.error !== "watch_update_failed") {
      this.alignedPlayback = null;
      return false;
    }
    return true;
  }
  /** Called within the player's serialized turn; explicit failures reject. */
  async editPlayback(patch: WatchMediaPatch): Promise<void> {
    watchPlaybackSchema.parse({ ...await this.sample(), ...patch });
    const ranges = this.localState?.live?.seekable;
    await this.media.patch(patch.position !== undefined && ranges
      ? { ...patch, position: watchSeekPosition(patch.position, ranges) } : patch);
  }
  private async apply(patch: WatchMediaPatch): Promise<void> {
    try {
      await this.media.patch(patch);
      if (this.error === "watch_live_position_unavailable" && patch.position !== undefined) this.error = null;
      if (this.media.seekEvents === false && Object.keys(patch).length) this.observe(await this.media.read());
    } catch (error) {
      if (!this.signal.aborted) {
        if (error instanceof Error && (error.name === "NotAllowedError" || error.message === "watch_autoplay_blocked")) {
          if (this.owner || !this.playback?.paused) this.blockedReason ??= "autoplay";
        }
        else { this.failMedia(error); return; }
      }
    }
    if (!this.signal.aborted) this.changed();
  }
  patch(value: WatchMediaPatch): Promise<void> { return this.serialize(() => this.apply(value)); }
  play(): Promise<void> { return this.patch({ paused: false }); }
  async resume(): Promise<void> {
    if (!await this.align(true, true)) return;
    if (this.blockedReason === "local-seek" || this.playback?.paused && !this.owner) {
      this.blockedReason = null; this.changed();
    }
    if (this.owner || !this.playback?.paused) await this.play();
  }
  serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(() => { if (!this.signal.aborted) return operation(); });
    this.operations = result.catch(() => {});
    return result;
  }
  close(): void {
    if (this.signal.aborted) return;
    this.alignmentRequest = null;
    this.lifetime.abort();
    this.publishPlayback = null;
    clearInterval(this.timer);
    this.unlisten();
    this.media.close();
  }
}
