import { debugTrack } from "../lib/debug-webrtc";
import { debugEvent, registerDebugCollector } from "../lib/debug";

const noiseWorkletURL = new URL('./rnnoise-worklet.js', import.meta.url).href;
export function supportsStrongerSuppression(): boolean {
  return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && 'audioWorklet' in AudioContext.prototype;
}

// A single microphone capture owns its device, gain and output. Transports
// borrow the output track; replacing a device never changes room authority.
export class MicrophoneInput {
  readonly stream: MediaStream;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private source: MediaStreamAudioSourceNode;
  private suppressor: AudioWorkletNode | null = null;
  private configuring = false;
  onProcessingError?: () => void;
  private readonly samples = new Float32Array(256);
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private readonly releaseDebug: () => void;

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
    this.releaseDebug = registerDebugCollector("microphone", () => {
      const input = this.captured.getAudioTracks()[0]!, output = this.stream.getAudioTracks()[0]!;
      debugTrack(input, { role: "microphone-input", outputTrackId: output.id });
      debugTrack(output, { role: "microphone-output", inputTrackId: input.id });
      debugEvent("audio", "microphone-graph", { inputTrackId: input.id, outputTrackId: output.id,
        contextState: this.context.state, sampleRate: this.context.sampleRate,
        sourceNodeChannels: this.source.channelCount, sourceNodeCountMode: this.source.channelCountMode,
        gainNodeChannels: this.gain.channelCount, gainNodeCountMode: this.gain.channelCountMode,
        destinationNodeChannels: destination.channelCount, gain: this.gain.gain.value });
    });
  }

  /** Prepare before committing; the existing voice owner supplies the capture policy. */
  async configure(captured: MediaStream, enhanced: boolean): Promise<void> {
    if (this.signal.aborted) throw new DOMException('Microphone closed', 'AbortError');
    if (this.configuring) throw new Error('microphone_processing_busy');
    if (enhanced && (!supportsStrongerSuppression() || this.context.sampleRate !== 48000)) throw new Error('voice_noise_processing_unsupported');
    if (captured === this.captured && enhanced === Boolean(this.suppressor)) return;
    this.configuring = true;
    let prepared: AudioWorkletNode | null = null;
    try {
      if (enhanced && !this.suppressor) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException('Microphone closed', 'AbortError'));
          this.signal.addEventListener('abort', abort, { once: true });
          this.context.audioWorklet.addModule(noiseWorkletURL).then(resolve, reject)
            .finally(() => this.signal.removeEventListener('abort', abort));
          if (this.signal.aborted) abort();
        });
        this.signal.throwIfAborted();
        prepared = new AudioWorkletNode(this.context, 'NoiseSuppressorWorklet', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        });
        await new Promise<void>((resolve, reject) => {
          const abort = () => finish(new DOMException('Microphone closed', 'AbortError'));
          const finish = (error?: Error) => { prepared!.port.onmessage = null; prepared!.onprocessorerror = null; this.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
          prepared!.port.onmessage = event => { if (event.data === 'ready') finish(); };
          prepared!.onprocessorerror = () => finish(new Error('voice_noise_processing_failed'));
          this.signal.addEventListener('abort', abort, { once: true });
        });
      }
      this.signal.throwIfAborted();
      if (captured.getAudioTracks()[0]?.readyState !== 'live') throw new Error('microphone_unavailable');
      const next = enhanced ? prepared ?? this.suppressor : null;
      const source = this.context.createMediaStreamSource(captured);
      source.connect(next ?? this.gain);
      if (prepared) prepared.connect(this.gain);
      const oldCapture = this.captured, previous = this.suppressor;
      this.source.disconnect(); this.source = source; this.captured = captured; this.suppressor = next;
      captured.getAudioTracks()[0]!.onended = this.ended;
      if (next) next.onprocessorerror = () => { if (!this.signal.aborted && this.suppressor === next) this.onProcessingError?.(); };
      prepared = null;
      if (previous && previous !== next) { previous.port.postMessage('close'); previous.disconnect(); previous.port.close(); }
      if (oldCapture !== captured) oldCapture.getTracks().forEach(track => { track.onended = null; track.stop(); });
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new Error('voice_noise_processing_failed', { cause: error });
    } finally {
      this.configuring = false;
      if (prepared) { prepared.port.postMessage('close'); prepared.disconnect(); prepared.port.close(); }
    }
  }

  volume(value: number): void { this.gain.gain.setTargetAtTime(value, this.context.currentTime, .01); }
  level(): number {
    if (this.signal.aborted) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
  }
  close(): void {
    if (this.signal.aborted) return;
    this.lifetime.abort();
    this.source.disconnect();
    if (this.suppressor) { this.suppressor.port.postMessage('close'); this.suppressor.disconnect(); this.suppressor.port.close(); this.suppressor = null; }
    this.releaseDebug();
    this.captured.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => {});
  }
}
