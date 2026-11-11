import { checkFeedbackDuration, feedbackClipBytes, type FeedbackClip } from "./feedback-clip";

export type FeedbackCue = "message" | "throw";
export type FeedbackClips = Partial<Record<FeedbackCue, FeedbackClip>>;

/** Original short cues, played only to this browser's output. */
export function scheduleFeedbackCue(context: BaseAudioContext, cue: FeedbackCue, destination: AudioNode, ended: () => void = () => {}) {
  const start = context.currentTime;
  const voices: { oscillator: OscillatorNode; gain: GainNode }[] = [];
  let remaining = cue === "message" ? 2 : 1;
  const note = (type: OscillatorType, from: number, to: number, duration: number, peak: number) => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + .005);
    gain.gain.exponentialRampToValueAtTime(.00001, start + duration);
    oscillator.connect(gain); gain.connect(destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); if (--remaining === 0) ended(); };
    oscillator.start(start); oscillator.stop(start + duration + .01);
    voices.push({ oscillator, gain });
  };
  if (cue === "message") {
    note("sine", 660, 660, .09, .04);
    note("sine", 1320, 1320, .06, .006);
  } else note("triangle", 280, 130, .11, .04);
  return () => { for (const { oscillator, gain } of voices) { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); } };
}

/** One page owns activation and one short cue; suspended events are never queued. */
export class FeedbackAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private activation: AbortController | null = null;
  private stopCue: (() => void) | null = null;
  private enabled = false;
  private volume = 1;
  private clips: FeedbackClips = {};
  private decoded = new Map<FeedbackCue, { data: string; buffer?: AudioBuffer; ready: Promise<void> }>();

  configure({ enabled, volume, clips = {} }: { enabled: boolean; volume: number; clips?: FeedbackClips }): void {
    for (const cue of ["message", "throw"] as const) {
      if (this.clips[cue]?.data !== clips[cue]?.data) {
        this.stopCue?.(); this.stopCue = null;
        this.decoded.delete(cue);
      }
    }
    this.clips = clips;
    this.enabled = enabled; this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
    if (!enabled || volume === 0) { this.close(); return; }
    if (this.context) this.prepareClips(this.context);
    this.armActivation();
  }

  private armActivation(): void {
    this.activation?.abort(); this.activation = null;
    if (!this.enabled || this.volume === 0 || this.context?.state === "running") return;
    this.activation = new AbortController();
    const options = { capture: true, signal: this.activation.signal };
    document.addEventListener("pointerdown", this.activate, options);
    document.addEventListener("keydown", this.activate, options);
  }

  activate = (): void => { void this.resume(); };

  private async resume(): Promise<boolean> {
    if (!this.enabled || this.volume === 0) return false;
    try {
      const context = this.context ??= new AudioContext();
      if (!this.gain) {
        this.gain = context.createGain(); this.gain.gain.value = this.volume;
        this.gain.connect(context.destination);
        context.onstatechange = () => {
          if (this.context !== context) return;
          if (context.state !== "running") { this.stopCue?.(); this.stopCue = null; }
          if (context.state === "closed") { this.gain?.disconnect(); this.gain = null; this.context = null; this.decoded.clear(); }
          this.armActivation();
        };
      }
      await context.resume();
      if (this.context !== context || !this.enabled) return false;
      this.prepareClips(context);
      this.activation?.abort(); this.activation = null;
      return context.state === "running";
    } catch { return false; }
  }

  private prepareClips(context: AudioContext): void {
    for (const cue of ["message", "throw"] as const) {
      const clip = this.clips[cue];
      if (!clip || this.decoded.has(cue)) continue;
      const entry: { data: string; buffer?: AudioBuffer; ready: Promise<void> } = { data: clip.data, ready: Promise.resolve() };
      this.decoded.set(cue, entry);
      entry.ready = (async () => {
        try {
          const buffer = await context.decodeAudioData(feedbackClipBytes(clip));
          checkFeedbackDuration(buffer);
          if (this.context === context && this.decoded.get(cue) === entry) entry.buffer = buffer;
        } catch { /* Invalid or unsupported saved audio never queues a notification. */ }
      })();
    }
  }

  play(cue: FeedbackCue): void {
    const context = this.context, gain = this.gain;
    if (!this.enabled || this.volume === 0 || context?.state !== "running" || !gain || this.stopCue) return;
    const custom = this.clips[cue];
    const buffer = this.decoded.get(cue)?.buffer;
    if (custom && !buffer) return;
    try {
      let stop: () => void;
      const ended = () => { if (this.stopCue === stop) this.stopCue = null; };
      if (buffer) {
        const source = context.createBufferSource();
        source.buffer = buffer; source.connect(gain);
        source.onended = () => { source.disconnect(); ended(); };
        stop = () => { source.stop(); source.disconnect(); };
        source.start();
      } else stop = scheduleFeedbackCue(context, cue, gain, ended);
      this.stopCue = stop;
    } catch { this.close(); }
  }

  preview = (cue: FeedbackCue = "message"): void => {
    const clip = this.clips[cue];
    void this.resume().then(async ready => {
      if (!ready) return;
      const context = this.context, entry = this.decoded.get(cue);
      await entry?.ready;
      if (this.context === context && this.clips[cue] === clip) this.play(cue);
    });
  };

  close(): void {
    this.activation?.abort(); this.activation = null;
    this.stopCue?.(); this.stopCue = null;
    this.gain?.disconnect(); this.gain = null;
    const context = this.context; this.context = null;
    this.decoded.clear();
    if (context) void context.close().catch(() => {});
  }
}
