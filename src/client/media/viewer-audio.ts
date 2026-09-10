export interface ViewerAudioSnapshot {
  level: number;
  muted: boolean;
  boostAvailable: boolean;
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

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onChange: (snapshot: ViewerAudioSnapshot) => void,
  ) {
    this.level = video.volume;
    this.muted = video.muted;
    video.addEventListener("play", this.onPlay);
    video.addEventListener("volumechange", this.onNativeVolume);
    for (const event of ["pause", "ended"]) {
      video.addEventListener(event, this.sync);
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
    this.level = Math.max(0, Math.min(this.boostAvailable ? 2 : 1, level));
    // iPhone video.volume is system-owned. Explicit adjustment uses the same
    // gain node below and above 100%; untouched playback stays native.
    if (this.level !== 1 && this.boostAvailable && !this.context) {
      try {
        this.context = new AudioContext();
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
    const boosted = this.context?.state === "running" && this.source !== null;
    if (this.gain) {
      this.gain.gain.value =
        boosted && !this.muted && !this.video.paused && !this.video.ended
          ? this.level
          : 0;
    }
    this.video.volume = Math.min(this.level, 1);
    this.video.muted = this.muted || this.level === 0 || boosted;
  };

  private readonly onPlay = (): void => {
    this.resume();
    this.sync();
  };

  private readonly onNativeVolume = (): void => {
    if (this.disposed || this.context) return;
    const { volume, muted } = this.video;
    if (this.level === volume && this.muted === muted) return;
    this.level = volume;
    this.muted = muted;
    this.onChange(this.snapshot);
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
    if (context) {
      context.removeEventListener("statechange", this.sync);
      void context.close().catch(() => undefined);
    }
  }
}
