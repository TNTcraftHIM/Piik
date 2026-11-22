import type { BrowserCaptureSource } from "./quality";
import { audioInputConstraints } from "./audio-capture";
import { MicrophoneInput } from "./microphone-input";
import { acquireMediaStream } from "./capture-stream";
import { waitForConnectionOperation } from "../webrtc/connection-operation";
import { debugOperation } from "../lib/debug";

export interface CommentaryInput { deviceId: string; volume: number; voiceProcessing: boolean }

// The Host owns video. This owner mixes source sound and optional commentary
// into one stable output, independently of playback and room voice.
export class HostAudio {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private microphone: MicrophoneInput | null = null;
  private microphoneNode: MediaStreamAudioSourceNode | null = null;
  private microphoneRequest: AbortController | null = null;
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
  get outputGainAvailable(): boolean { return this.context !== null && this.destination !== null; }
  get commentaryAvailable(): boolean { return this.outputGainAvailable; }
  get microphoneEnabled(): boolean { return this.microphone !== null; }
  output(volume = this.volume): MediaStream {
    if (volume !== this.volume) {
      this.volume = volume;
      if (this.gain) this.gain.gain.value = volume;
    }
    if (this.destination) return new MediaStream([...this.source.getVideoTracks(), ...this.destination.stream.getAudioTracks()]);
    // An unavailable mixer can pass through unity gain. Keep other levels off the raw transport.
    return volume === 1 || !this.sourceAudioAvailable ? this.source : new MediaStream(this.source.getVideoTracks());
  }
  // Use the source-selection gesture while the system picker is opening.
  static activate(): AudioContext | null {
    try {
      const context = new AudioContext();
      void context.resume().catch(() => {});
      return context;
    } catch { return null; }
  }
  // A running graph keeps the same output track as inputs change.
  start(context: AudioContext | null = HostAudio.activate()): MediaStream {
    const complete = debugOperation("capture", "audio-prepare", { source: this.kind, sourceAudio: this.sourceAudioAvailable });
    this.context = context;
    try {
      if (context?.state !== "running") throw new Error("Shared audio context is unavailable");
      this.destination = context.createMediaStreamDestination();
      this.destination.stream.getAudioTracks()[0]!.contentHint = "music";
      this.gain = context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.destination);
      this.connectSource();
      complete("resumed", { state: context.state });
    } catch (error) {
      complete("fallback", { state: context?.state ?? null }, error);
      this.closeGraph();
    }
    return this.output();
  }
  private closeGraph(): void {
    this.sourceNode?.disconnect(); this.sourceNode = null;
    this.gain?.disconnect(); this.gain = null;
    this.destination?.stream.getTracks().forEach(track => track.stop()); this.destination = null;
    void this.context?.close().catch(() => {}); this.context = null;
  }
  private connectSource(): void {
    this.sourceNode?.disconnect(); this.sourceNode = null;
    if (this.context && this.destination && this.sourceAudioAvailable) {
      this.sourceNode = this.context.createMediaStreamSource(this.source);
      this.sourceNode.connect(this.gain!);
    }
  }
  async setMicrophone(enabled: boolean, settings: CommentaryInput): Promise<void> {
    this.microphoneRequest?.abort();
    this.microphoneRequest = null;
    if (!enabled) { this.clearMicrophone(); return; }
    if (!this.context || !this.destination || this.closed) throw new Error("Shared audio is unavailable");
    const request = this.microphoneRequest = new AbortController();
    const context = new AudioContext();
    let stream: MediaStream | undefined, input: MicrophoneInput | undefined;
    try {
      const resumed = Promise.all([context.resume(), this.context.resume()]).then(() => true, () => false);
      stream = await acquireMediaStream(() => navigator.mediaDevices.getUserMedia({ audio: { ...audioInputConstraints(settings.voiceProcessing),
        ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}) }, video: false }), request.signal);
      if (!await waitForConnectionOperation(request.signal, () => resumed)) throw new Error("Microphone audio could not start");
      request.signal.throwIfAborted();
      if (!stream.getAudioTracks().some(track => track.readyState === "live")) throw new Error("No live microphone");
      input = new MicrophoneInput(stream, context, settings.volume, () => {
        if (this.microphone === input) this.clearMicrophone();
      });
      const node = this.context.createMediaStreamSource(input.stream);
      node.connect(this.gain!);
      const previousInput = this.microphone, previousNode = this.microphoneNode;
      this.microphone = input;
      this.microphoneNode = node;
      previousNode?.disconnect(); previousInput?.close();
      this.microphoneChanged(true); this.reportAvailability();
    } catch (error) {
      input?.close();
      if (!request.signal.aborted) throw error;
    } finally {
      if (this.microphoneRequest === request) this.microphoneRequest = null;
      if (!input) { stream?.getTracks().forEach(track => track.stop()); void context.close().catch(() => {}); }
    }
  }
  microphoneVolume(value: number): void { this.microphone?.volume(value); }
  setVolume(volume: number): void {
    this.volume = volume;
    this.gain?.gain.setTargetAtTime(volume, this.context!.currentTime, .01);
  }
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
    this.closed = true; this.microphoneRequest?.abort(); this.microphoneRequest = null;
    this.unwatchSource();
    this.clearMicrophone(); this.closeGraph();
    this.source.getAudioTracks().forEach(track => track.stop());
  }
}
