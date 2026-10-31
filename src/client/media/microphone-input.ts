// A single microphone capture owns its device, gain and output. Transports
// borrow the output track; replacing a device never changes room authority.
export class MicrophoneInput {
  readonly stream: MediaStream;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private source: MediaStreamAudioSourceNode;
  private readonly samples = new Float32Array(256);
  private closed = false;

  constructor(private captured: MediaStream, private readonly context: AudioContext,
    volume: number, private readonly ended: () => void) {
    this.gain = this.context.createGain();
    this.gain.gain.value = volume;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.samples.length;
    this.source = this.context.createMediaStreamSource(captured);
    const destination = this.context.createMediaStreamDestination();
    this.source.connect(this.gain); this.gain.connect(destination); this.gain.connect(this.analyser);
    this.stream = destination.stream;
    this.stream.getAudioTracks()[0]!.contentHint = "speech";
    captured.getAudioTracks()[0]!.onended = ended;
  }

  replace(captured: MediaStream): void {
    if (this.closed || captured.getAudioTracks()[0]?.readyState !== "live") throw new DOMException("Microphone input is unavailable", "InvalidStateError");
    const source = this.context.createMediaStreamSource(captured);
    source.connect(this.gain);
    const previous = this.captured;
    this.source.disconnect();
    this.source = source;
    this.captured = captured;
    captured.getAudioTracks()[0]!.onended = this.ended;
    previous.getTracks().forEach(track => { track.onended = null; track.stop(); });
  }

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
