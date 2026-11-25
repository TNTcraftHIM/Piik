// Runs on the audio thread, so a throttled background page cannot delay the
// gate's release or activation hold. The rules live in voice-gate.ts.
import {
  closedVoiceGate, retuneVoiceGate, VOICE_GATE_PROCESSOR, VOICE_GATE_RAMP_SECONDS, voiceGateUntil,
  type VoiceGate, type VoiceGateSettings,
} from "./voice-gate";

// AudioWorkletGlobalScope; TypeScript ships no library for it.
declare const currentTime: number;
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class VoiceGateProcessor extends AudioWorkletProcessor {
  private gate: VoiceGate = { ...closedVoiceGate };
  private gain = 0;
  private open = false;
  private closed = false;
  private readonly step = 1 / (VOICE_GATE_RAMP_SECONDS * sampleRate);

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<VoiceGateSettings | "close">) => {
      if (data === "close") { this.closed = true; this.port.close(); }
      else this.gate = retuneVoiceGate(this.gate, data);
    };
    this.port.postMessage("ready");
  }

  process([input = []]: Float32Array[][], [output = []]: Float32Array[][]): boolean {
    if (this.closed) return false;
    let sum = 0, count = 0;
    for (const channel of input) {
      for (const sample of channel) sum += sample * sample;
      count += channel.length;
    }
    this.gate.until = voiceGateUntil(this.gate, count ? Math.sqrt(sum / count) : 0, currentTime);
    const open = currentTime < this.gate.until;
    // The page shows speaking only while the gate is open.
    if (open !== this.open) { this.open = open; this.port.postMessage(open); }
    const target = open ? 1 : 0;
    for (let index = 0; index < (output[0]?.length ?? 0); index++) {
      this.gain = target > this.gain ? Math.min(target, this.gain + this.step) : Math.max(target, this.gain - this.step);
      for (let channel = 0; channel < output.length; channel++) output[channel][index] = (input[channel]?.[index] ?? 0) * this.gain;
    }
    return true;
  }
}

registerProcessor(VOICE_GATE_PROCESSOR, VoiceGateProcessor);
