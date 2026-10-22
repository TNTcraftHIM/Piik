// Shared offline character voices and percussion for the film and its review cuts.
import { readFile } from 'node:fs/promises';
import { spokenUnits, SPEECH_STEP } from '../site/films/story/speech.js';
export const rate = 48000;
const tau = Math.PI * 2;
const bank = await readFile(new URL('./assets/dialogue-letters.wav', import.meta.url));
const bankRate = bank.readUInt32LE(24), letterSamples = Math.floor(bankRate * .15);
export const clamp = n => Math.min(1, Math.max(0, n));
export const voiceTreatment = { pitch: [1.75, 2.2, 2.05], cutoff: 3300 };

export function characters(cues, variant, duration) {
  const output = new Float32Array(Math.ceil(duration * rate));
  for (const cue of cues) {
    const units = spokenUnits(cue), question = cue.en.endsWith('?');
    for (const [index, unit] of units.entries()) {
      const contour = (index / Math.max(1, units.length - 1) - .5) * (question ? 3 : -2);
      const pitch = variant.pitch[cue.actor] * 2 ** ((contour + [0, 1.2, -.7, .5][index % 4]) / 12);
      const start = 44 + letterSamples * (unit.charCodeAt(0) - 97);
      const at = Math.round((cue.at + index * SPEECH_STEP) * rate);
      const duration = Math.min(.07, .145 / pitch), count = Math.floor(duration * rate);
      const alpha = 1 - Math.exp(-tau * variant.cutoff / rate);
      let filtered = 0;
      for (let i = 0; i < count; i++) {
        const offset = i / rate * bankRate * pitch;
        const whole = Math.floor(offset), fraction = offset - whole;
        const sample = ((bank[start + whole] * (1 - fraction) + bank[start + whole + 1] * fraction) - 127.5) / 128;
        filtered += alpha * (sample - filtered);
        const envelope = Math.min(1, i / (rate * .004), (count - i) / (rate * .008));
        output[at + i] += Math.tanh(filtered * 1.5) * envelope * .42;
      }
    }
  }
  return output;
}

export function percussion(cues, duration) {
  const output = new Float32Array(Math.ceil(duration * rate));
  const voices = {
    cut: { length: .12, high: 145, low: 65, decay: 32, noise: .45, gain: .16 },
    tap: { length: .055, high: 850, low: 300, decay: 65, noise: .12, gain: .12 },
    win: { length: .28, high: 260, low: 120, decay: 22, noise: .3, gain: .2 },
  };
  let seed = 20261021;
  for (const cue of cues) {
    const voice = voices[cue.kind], start = Math.round(cue.at * rate), count = Math.round(voice.length * rate);
    let filtered = 0;
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      filtered += .2 * (seed / 2147483648 - 1 - filtered);
      const phase = tau * (voice.low * t + (voice.high - voice.low) * (1 - Math.exp(-35 * t)) / 35);
      const envelope = Math.min(1, i / (rate * .001), (count - i) / (rate * .012)) * Math.exp(-voice.decay * t);
      output[start + i] += (Math.sin(phase) * (1 - voice.noise) + filtered * voice.noise) * envelope * voice.gain;
    }
  }
  return output;
}

export function pcmWave(samples, channels) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return wav;
}
