// A single microphone capture owns its device, gain and output. Transports
// borrow the output track; replacing a device never changes room authority.
export class MicrophoneInput {
  readonly stream: MediaStream;
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly samples = new Float32Array(256);
  private closed = false;

  constructor(private readonly captured: MediaStream, volume: number, ended: () => void) {
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.gain.value = volume;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    const source = this.context.createMediaStreamSource(captured);
    const destination = this.context.createMediaStreamDestination();
    source.connect(this.gain); this.gain.connect(destination); this.gain.connect(this.analyser);
    this.stream = destination.stream;
    this.stream.getAudioTracks()[0]!.contentHint = "speech";
    captured.getAudioTracks()[0]!.onended = ended;
  }

  resume(): Promise<void> { return this.context.resume(); }
  volume(value: number): void { this.gain.gain.setTargetAtTime(value, this.context.currentTime, .01); }
  level(): number {
    if (this.closed) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.captured.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => {});
  }
}
