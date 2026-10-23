import type { BrowserCaptureSource } from "./quality";
import { audioInputConstraints } from "./audio-capture";
import { MicrophoneInput } from "./microphone-input";

export interface CommentaryInput { deviceId: string; volume: number; voiceProcessing: boolean }

// The Host owns video. This owner mixes source sound and optional commentary
// into one stable output, independently of playback and room voice.
export class HostAudio {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private microphone: MicrophoneInput | null = null;
  private microphoneNode: MediaStreamAudioSourceNode | null = null;
  private microphoneRequest = 0;
  private closed = false;
  constructor(private source: MediaStream, private kind: BrowserCaptureSource = "browser",
    private availabilityChanged: (available: boolean) => void = () => {},
    private microphoneChanged: (enabled: boolean) => void = () => {}) {
    this.watchSource();
  }
  get sourceStream(): MediaStream { return this.source; }
  get sourceKind(): BrowserCaptureSource { return this.kind; }
  get sourceAudioAvailable(): boolean { return this.source.getAudioTracks().some(track => track.readyState === "live"); }
  get audioAvailable(): boolean { return this.sourceAudioAvailable || this.microphone !== null; }
  get commentaryAvailable(): boolean { return this.context !== null && this.destination !== null; }
  private output(): MediaStream {
    return this.destination ? new MediaStream([...this.source.getVideoTracks(), ...this.destination.stream.getAudioTracks()]) : this.source;
  }
  // Install one audio track before publishing, even when the selected picture
  // has no sound. Input changes never replace the transport's output track.
  async start(): Promise<MediaStream> {
    try {
      const context = this.context = new AudioContext();
      this.destination = context.createMediaStreamDestination();
      this.destination.stream.getAudioTracks()[0]!.contentHint = "music";
      this.connectSource();
      await context.resume();
    } catch {
      // Commentary is optional. A failed graph must not retire a valid picture
      // or source sound; this share continues with its original audio track.
      this.closeGraph();
    }
    if (this.closed) throw new Error("Shared audio has stopped");
    return this.output();
  }
  private closeGraph(): void {
    this.sourceNode?.disconnect(); this.sourceNode = null;
    this.destination?.stream.getTracks().forEach(track => track.stop()); this.destination = null;
    void this.context?.close().catch(() => {}); this.context = null;
  }
  private connectSource(): void {
    this.sourceNode?.disconnect(); this.sourceNode = null;
    if (this.context && this.destination && this.sourceAudioAvailable) {
      this.sourceNode = this.context.createMediaStreamSource(this.source);
      this.sourceNode.connect(this.destination);
    }
  }
  async setMicrophone(enabled: boolean, settings: CommentaryInput): Promise<void> {
    const request = ++this.microphoneRequest;
    if (!enabled) { this.clearMicrophone(); return; }
    if (!this.context || !this.destination || this.closed) throw new Error("Shared audio is unavailable");
    const context = new AudioContext();
    let stream: MediaStream | undefined, input: MicrophoneInput | undefined;
    try {
      const resumed = context.resume().then(() => true, () => false);
      await this.context.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audioInputConstraints(settings.voiceProcessing),
        ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}) }, video: false });
      if (!await resumed) throw new Error("Microphone audio could not start");
      if (this.closed || request !== this.microphoneRequest) return;
      if (!stream.getAudioTracks().some(track => track.readyState === "live")) throw new Error("No live microphone");
      input = new MicrophoneInput(stream, context, settings.volume, () => {
        if (this.microphone === input) { ++this.microphoneRequest; this.clearMicrophone(); }
      });
      const node = this.context.createMediaStreamSource(input.stream);
      node.connect(this.destination);
      const previousInput = this.microphone, previousNode = this.microphoneNode;
      this.microphone = input;
      this.microphoneNode = node;
      previousNode?.disconnect(); previousInput?.close();
      this.microphoneChanged(true); this.reportAvailability();
    } catch (error) {
      input?.close(); throw error;
    } finally {
      if (!input) { stream?.getTracks().forEach(track => track.stop()); void context.close().catch(() => {}); }
    }
  }
  microphoneVolume(value: number): void { this.microphone?.volume(value); }
  private clearMicrophone(): void {
    this.microphoneNode?.disconnect(); this.microphoneNode = null;
    this.microphone?.close(); this.microphone = null;
    this.microphoneChanged(false); this.reportAvailability();
  }
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
    this.connectSource();
    this.reportAvailability();
    if (previous !== source) previous.getAudioTracks().forEach(track => track.stop());
    return this.output();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; ++this.microphoneRequest;
    this.unwatchSource();
    this.clearMicrophone(); this.closeGraph();
    this.source.getAudioTracks().forEach(track => track.stop());
  }
}
