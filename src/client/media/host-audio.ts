import type { BrowserCaptureSource } from "./quality";

// The Host owns the video lifecycle. This helper owns source-audio retirement
// and reports input availability independently of playback or room voice.
export class HostAudio {
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
  attach(source: MediaStream, kind = this.kind): MediaStream {
    const previous = this.source;
    this.unwatchSource(); this.source = source; this.kind = kind; this.watchSource();
    this.reportAvailability();
    if (previous !== source) previous.getAudioTracks().forEach(track => track.stop());
    return source;
  }
  dispose(): void {
    this.unwatchSource();
    this.source.getAudioTracks().forEach(track => track.stop());
  }
}
