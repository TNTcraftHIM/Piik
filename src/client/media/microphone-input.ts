import { debugTrack } from "../lib/debug-webrtc";
import { debugEvent, registerDebugCollector } from "../lib/debug";
import gateWorkletURL from "./voice-gate-worklet.ts?worker&url";
import { levelFromDbfs, SPEAKING_LEVEL, VOICE_GATE_PROCESSOR, type MicrophoneMode, type VoiceGateSettings } from "./voice-gate";

const noiseWorkletURL = new URL('./rnnoise-worklet.js', import.meta.url).href;
export function supportsStrongerSuppression(): boolean {
  return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && 'audioWorklet' in AudioContext.prototype;
}

function retireWorklet(node: AudioWorkletNode): void {
  node.port.postMessage('close'); node.disconnect(); node.port.close();
}

// A single microphone capture owns its device, gain, gate and output. Transports
// borrow the output track; replacing a device never changes room authority.
export class MicrophoneInput {
  readonly stream: MediaStream;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private source: MediaStreamAudioSourceNode;
  private suppressor: AudioWorkletNode | null = null;
  // Push to talk and voice activation sit between the gain and the output; the analyser reads before them.
  private gateNode: AudioWorkletNode | null = null;
  private gateSettings: VoiceGateSettings = { mode: "push", threshold: SPEAKING_LEVEL, pressed: false };
  private gateOpen = false;
  private configuring = false;
  onProcessingError?: (error: "voice_noise_processing_failed" | "voice_gate_failed") => void;
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
    const destination = this.destination = this.context.createMediaStreamDestination();
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
        destinationNodeChannels: destination.channelCount, gain: this.gain.gain.value,
        mode: this.gateNode ? this.gateSettings.mode : "open" });
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
      if (enhanced && !this.suppressor) prepared = await this.worklet(noiseWorkletURL, 'NoiseSuppressorWorklet', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
      });
      this.signal.throwIfAborted();
      if (captured.getAudioTracks()[0]?.readyState !== 'live') throw new Error('microphone_unavailable');
      const next = enhanced ? prepared ?? this.suppressor : null;
      const source = this.context.createMediaStreamSource(captured);
      source.connect(next ?? this.gain);
      if (prepared) prepared.connect(this.gain);
      const oldCapture = this.captured, previous = this.suppressor;
      this.source.disconnect(); this.source = source; this.captured = captured; this.suppressor = next;
      captured.getAudioTracks()[0]!.onended = this.ended;
      if (next) next.onprocessorerror = () => { if (!this.signal.aborted && this.suppressor === next) this.onProcessingError?.('voice_noise_processing_failed'); };
      prepared = null;
      if (previous && previous !== next) retireWorklet(previous);
      if (oldCapture !== captured) oldCapture.getTracks().forEach(track => { track.onended = null; track.stop(); });
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new Error('voice_noise_processing_failed', { cause: error });
    } finally {
      this.configuring = false;
      if (prepared) retireWorklet(prepared);
    }
  }

  /**
   * Open microphone has no gate, so its graph stays as it always was. Push to talk
   * and voice activation prepare the gate before it takes effect, and start released.
   */
  async gate(mode: MicrophoneMode): Promise<void> {
    if (this.signal.aborted) throw new DOMException('Microphone closed', 'AbortError');
    if (this.configuring) throw new Error('microphone_processing_busy');
    const current = this.gateNode;
    if (mode === "open") {
      if (!current) return;
      this.gain.connect(this.destination); this.gain.disconnect(current);
      this.gateNode = null;
      retireWorklet(current);
      return;
    }
    this.gateSettings = { ...this.gateSettings, mode, pressed: false };
    if (current) { current.port.postMessage(this.gateSettings); return; }
    this.configuring = true;
    let prepared: AudioWorkletNode | null = null;
    try {
      prepared = await this.worklet(gateWorkletURL, VOICE_GATE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1 });
      this.signal.throwIfAborted();
      const node = prepared;
      node.port.onmessage = ({ data }) => { if (typeof data === "boolean") this.gateOpen = data; };
      // A failed processor outputs silence; its owner retires the microphone instead of implying it still sends.
      node.onprocessorerror = () => { if (!this.signal.aborted && this.gateNode === node) this.onProcessingError?.('voice_gate_failed'); };
      node.port.postMessage(this.gateSettings);
      this.gateOpen = false;
      node.connect(this.destination); this.gain.connect(node); this.gain.disconnect(this.destination);
      this.gateNode = node;
      prepared = null;
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new Error('voice_gate_failed', { cause: error });
    } finally {
      this.configuring = false;
      if (prepared) retireWorklet(prepared);
    }
  }

  /** Voice activation's threshold, in dBFS. */
  threshold(dbfs: number): void {
    this.gateSettings = { ...this.gateSettings, threshold: levelFromDbfs(dbfs) };
    this.gateNode?.port.postMessage(this.gateSettings);
  }

  /** The talk key is held. Only push to talk reads it. */
  press(pressed: boolean): void {
    if (pressed === this.gateSettings.pressed) return;
    this.gateSettings = { ...this.gateSettings, pressed };
    this.gateNode?.port.postMessage(this.gateSettings);
  }

  /** The output carries the microphone now: always without a gate, and while the gate last reported open with one. */
  get transmitting(): boolean { return !this.gateNode || this.gateOpen; }

  volume(value: number): void { this.gain.gain.setTargetAtTime(value, this.context.currentTime, .01); }
  /** Post-gain linear RMS, read before any gate. */
  level(): number {
    if (this.signal.aborted) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
  }
  close(): void {
    if (this.signal.aborted) return;
    this.lifetime.abort();
    this.source.disconnect();
    if (this.suppressor) { retireWorklet(this.suppressor); this.suppressor = null; }
    if (this.gateNode) { retireWorklet(this.gateNode); this.gateNode = null; }
    this.releaseDebug();
    this.captured.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => {});
  }

  /** Loads a worklet and waits until its processor runs. Closing the microphone aborts both waits. */
  private async worklet(url: string, name: string, options: AudioWorkletNodeOptions): Promise<AudioWorkletNode> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('Microphone closed', 'AbortError'));
      this.signal.addEventListener('abort', abort, { once: true });
      this.context.audioWorklet.addModule(url).then(resolve, reject)
        .finally(() => this.signal.removeEventListener('abort', abort));
      if (this.signal.aborted) abort();
    });
    this.signal.throwIfAborted();
    const node = new AudioWorkletNode(this.context, name, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => finish(new DOMException('Microphone closed', 'AbortError'));
        const finish = (error?: Error) => { node.port.onmessage = null; node.onprocessorerror = null; this.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        node.port.onmessage = event => { if (event.data === 'ready') finish(); };
        node.onprocessorerror = () => finish(new Error('worklet_processor_failed'));
        this.signal.addEventListener('abort', abort, { once: true });
      });
    } catch (error) {
      retireWorklet(node);
      throw error;
    }
    return node;
  }
}
