import { playbackOutput } from "./playback-output";
import { debugTrack } from "../lib/debug-webrtc";
import { debugEvent, registerDebugCollector } from "../lib/debug";

export interface ViewerAudioSnapshot {
  level: number;
  muted: boolean;
  boostAvailable: boolean;
}

/** Room voice outputs share one context while any of them uses a gain graph. */
export class VoicePlaybackContext {
  private context: AudioContext | null = null;
  private outputs = 0;
  private detach?: ReturnType<typeof playbackOutput.attach>;
  get output() { return this.detach; }

  acquire(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.detach = playbackOutput.attach(this.context);
    }
    this.outputs++;
    return this.context;
  }

  release(): void {
    if (--this.outputs === 0) {
      this.detach?.();
      void this.context!.close().catch(() => {});
      this.context = null;
    }
  }
}

export class ViewerAudio {
  private level = 1;
  private muted = false;
  private boostAvailable = typeof AudioContext !== "undefined";
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private track: MediaStreamTrack | null = null;
  private disposed = false;
  private detachElement: ReturnType<typeof playbackOutput.attach>;
  private detachContext?: ReturnType<typeof playbackOutput.attach>;
  private nativeVolume: number;
  private nativeMuted: boolean;
  private readonly releaseDebug: () => void;
  private readonly releaseOutput: () => void;

  constructor(
    private readonly video: HTMLMediaElement,
    private readonly onChange: (snapshot: ViewerAudioSnapshot) => void,
    private readonly voiceContext?: VoicePlaybackContext,
    private readonly maxLevel = 2,
    private readonly onOutputReady?: (ready: boolean) => void,
  ) {
    this.detachElement = playbackOutput.attach(video);
    this.level = video.volume;
    this.muted = video.muted;
    this.nativeVolume = video.volume;
    this.nativeMuted = video.muted;
    this.releaseOutput = playbackOutput.subscribe(this.sync);
    this.releaseDebug = registerDebugCollector("audio-playback", () => {
      if (this.track) debugTrack(this.track, { role: "audio-playback-input" });
      debugEvent("audio", "playback-graph", { trackId: this.track?.id ?? null,
        route: this.context?.state === "running" && this.source ? "web-audio" : "native-element",
        requestedLevel: this.level, muted: this.muted, elementMuted: this.video.muted,
        contextState: this.context?.state ?? null, sampleRate: this.context?.sampleRate ?? null,
        sourceNodeChannels: this.source?.channelCount ?? null, sourceNodeCountMode: this.source?.channelCountMode ?? null,
        gainNodeChannels: this.gain?.channelCount ?? null, gainNodeCountMode: this.gain?.channelCountMode ?? null,
        gain: this.gain?.gain.value ?? null, destinationNodeChannels: this.context?.destination.channelCount ?? null });
    });
    video.addEventListener("play", this.onPlay);
    video.addEventListener("volumechange", this.onNativeVolume);
    for (const event of ["pause", "ended"]) {
      video.addEventListener(event, this.sync);
    }
    if (this.detachElement.getWaiting()) {
      this.sync();
      void this.detachElement.ready.then(this.sync);
    }
    onChange(this.snapshot);
  }

  get snapshot(): ViewerAudioSnapshot {
    return {
      level: this.level,
      muted: this.muted,
      boostAvailable: this.boostAvailable,
    };
  }

  bind(stream: MediaStream | null): void {
    if (this.disposed) return;
    const track = stream?.getAudioTracks()[0] ?? null;
    if (track !== this.track) {
      this.track = track;
      this.bindSource();
    }
    this.sync();
  }

  setLevel(level: number): void {
    if (this.disposed || !Number.isFinite(level)) return;
    this.level = Math.max(0, Math.min(this.boostAvailable ? this.maxLevel : 1, level));
    if (this.voiceContext && this.level === 1) this.releaseGraph();
    // iPhone video.volume is system-owned. Explicit adjustment uses the same
    // gain node below and above 100%; untouched playback stays native.
    if (this.level !== 1 && this.boostAvailable && !this.context) {
      try {
        this.context = this.voiceContext?.acquire() ?? new AudioContext();
        if (!this.voiceContext) this.detachContext = playbackOutput.attach(this.context);
        const output = this.detachContext ?? this.voiceContext?.output;
        if (output?.getWaiting()) void output.ready.then(this.sync);
        this.gain = this.context.createGain();
        this.gain.gain.value = 0;
        this.gain.connect(this.context.destination);
        this.context.addEventListener("statechange", this.sync);
        this.bindSource();
      } catch {
        this.disableBoost();
      }
    }
    this.resume();
    this.sync();
    this.onChange(this.snapshot);
  }

  setMuted(muted: boolean): void {
    if (this.disposed) return;
    this.muted = muted;
    if (!muted) this.resume();
    this.sync();
    this.onChange(this.snapshot);
  }

  resume(): void {
    const context = this.context;
    if (this.disposed || !context || context.state === "running") return;
    void context.resume().then(
      () => {
        if (this.context === context) this.sync();
      },
      () => {
        if (this.context === context) this.disableBoost();
      },
    );
  }

  useNativeControls(): void {
    if (this.disposed) return;
    this.releaseGraph();
    this.level = Math.min(this.level, 1);
    this.sync();
    this.onChange(this.snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseOutput();
    this.detachElement();
    this.releaseDebug();
    this.video.removeEventListener("play", this.onPlay);
    this.video.removeEventListener("volumechange", this.onNativeVolume);
    for (const event of ["pause", "ended"]) {
      this.video.removeEventListener(event, this.sync);
    }
    this.releaseGraph();
    this.video.volume = Math.min(this.level, 1);
    this.video.muted = this.muted;
  }

  private bindSource(): void {
    this.source?.disconnect();
    this.source = null;
    if (!this.context || !this.gain || !this.track) return;
    try {
      // A stream source keeps its initial track even if that stream later changes.
      this.source = this.context.createMediaStreamSource(
        new MediaStream([this.track]),
      );
      this.source.connect(this.gain);
    } catch {
      this.disableBoost();
    }
  }

  private readonly sync = (): void => {
    if (this.disposed) return;
    const output = this.detachContext ?? this.voiceContext?.output;
    const nativeReady = !this.detachElement.getWaiting() && !playbackOutput.failedFor(this.video);
    const boosted = !output?.getWaiting() && !playbackOutput.failedFor(this.context)
      && this.context?.state === "running" && this.source !== null;
    if (this.gain) {
      this.gain.gain.value =
        boosted && !this.muted && !this.video.paused && !this.video.ended
          ? this.level
          : 0;
    }
    this.video.volume = Math.min(this.level, 1);
    this.video.muted = !nativeReady || this.muted || this.level === 0 || boosted;
    // iPhone may ignore volume writes; echoes must match actual native state,
    // while the requested listening level stays owned by the gain graph.
    this.nativeVolume = this.video.volume;
    this.nativeMuted = this.video.muted;
    this.onOutputReady?.(boosted || nativeReady);
  };

  private readonly onPlay = (): void => {
    this.resume();
    this.sync();
  };

  private readonly onNativeVolume = (): void => {
    if (this.disposed) return;
    const { volume, muted } = this.video;
    // Ignore our queued writes, including the native mute while WebAudio plays.
    if (volume === this.nativeVolume && muted === this.nativeMuted) return;
    this.level = volume;
    this.muted = muted;
    // PiP/native controls now own listening intent. Retire the parallel graph
    // before honoring an unmute; later explicit gain adjustment can restore it.
    this.useNativeControls();
  };

  private disableBoost(): void {
    this.boostAvailable = false;
    this.useNativeControls();
  }

  private releaseGraph(): void {
    this.source?.disconnect();
    this.source = null;
    this.gain?.disconnect();
    this.gain = null;
    const context = this.context;
    this.context = null;
    this.detachContext?.();
    if (context) {
      context.removeEventListener("statechange", this.sync);
      if (this.voiceContext) this.voiceContext.release();
      else void context.close().catch(() => undefined);
    }
  }
}
