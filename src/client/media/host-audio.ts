import type { BrowserCaptureSource } from "./quality";

// The Host owns the video lifecycle. This helper owns source-audio retirement
// and reports input availability independently of playback or room voice.
export class HostAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private input: MediaStreamAudioSourceNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private volume = 1;
  constructor(private source: MediaStream, private kind: BrowserCaptureSource = "browser",
    private availabilityChanged: (available: boolean) => void = () => {}) {
    this.watchSource();
  }
  get sourceStream(): MediaStream { return this.source; }
  get sourceKind(): BrowserCaptureSource { return this.kind; }
  get audioAvailable(): boolean { return this.source.getAudioTracks().some(track => track.readyState === "live"); }
  private reportAvailability = () => this.availabilityChanged(this.audioAvailable);
  private watchSource(): void {
    this.source.getAudioTracks().forEach(track => track.addEventListener("ended", this.reportAvailability));
  }
  private unwatchSource(): void {
    this.source.getAudioTracks().forEach(track => track.removeEventListener("ended", this.reportAvailability));
  }

  async outputStream(): Promise<MediaStream> {
    if (this.audioAvailable && !this.context) {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.destination = this.context.createMediaStreamDestination();
      this.destination.stream.getAudioTracks()[0]!.contentHint = "music";
      this.gain.connect(this.destination);
    }
    this.input?.disconnect();
    this.input = null;
    if (this.context && this.audioAvailable) {
      this.input = this.context.createMediaStreamSource(new MediaStream(this.source.getAudioTracks()));
      this.input.connect(this.gain!);
      await this.context.resume();
    }
    return this.destination ? new MediaStream([...this.source.getVideoTracks(), ...this.destination.stream.getAudioTracks()]) : this.source;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.gain?.gain.setTargetAtTime(volume, this.context!.currentTime, .01);
  }

  async attach(source: MediaStream, kind = this.kind): Promise<MediaStream> {
    const previous = this.source;
    this.unwatchSource(); this.source = source; this.kind = kind; this.watchSource();
    this.reportAvailability();
    if (previous !== source) previous.getAudioTracks().forEach(track => track.stop());
    return this.outputStream();
  }
  dispose(): void {
    this.unwatchSource();
    this.input?.disconnect();
    this.gain?.disconnect();
    this.destination?.stream.getTracks().forEach(track => track.stop());
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null; this.gain = null; this.input = null; this.destination = null;
    this.source.getAudioTracks().forEach(track => track.stop());
  }
}
