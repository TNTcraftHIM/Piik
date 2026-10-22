import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUDY, durationOf, cuesOf, SOURCE_READ } from './score.js';
import { rate, clamp, voiceTreatment, characters, percussion, pcmWave } from '../../../scripts/film-audio.mjs';
import { spokenUnits, SPEECH_STEP } from './speech.js';
import { BEAT as UI_BEAT, UI_CUES } from './ui-score.js';
import { PARTY } from './party-score.js';

const cache = new URL('../../../build/films/story/', import.meta.url);
await mkdir(cache, { recursive: true });
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const study = STUDY;
const source = new URL(`${study.music}-source.mp3`, cache);
if (!existsSync(source)) {
  const response = await fetch('https://incompetech.com/music/royalty-free/mp3-royaltyfree/Funky%20Chunk.mp3', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${study.music}: ${response.status}`);
  await writeFile(source, Buffer.from(await response.arrayBuffer()));
}
const duration = durationOf(study), cues = cuesOf(study), beat = 60 / study.bpm;
const pcm = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(study.trim), '-i', fileURLToPath(source),
  '-t', String(duration), '-ar', String(rate), '-ac', '2', '-f', 'f32le', 'pipe:1'],
{ maxBuffer: rate * 8 * (duration + 2), windowsHide: true });
const music = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
const voice = characters(cues, voiceTreatment, duration);
const fxCues = study.scenes.slice(1).map(([at], i) => ({ at: at * beat, kind: i === 4 ? 'win' : i % 2 ? 'tap' : 'cut' }));
fxCues.push(...PARTY.impacts.map(at => ({ at: (68 + at) * beat, kind: 'tap' })),
  ...PARTY.coins.map(at => ({ at: (68 + at) * beat, kind: 'win' })),
  { at: (68 + PARTY.goal) * beat, kind: 'win' }, { at: 36 * beat, kind: 'win' },
  ...[100, 104, 108, 112].map(at => ({ at: at * beat, kind: 'cut' })));
// The real UI's cue positions are expressed on its own score. Map them to
// this edit's beat once, for the same visible click and audible accent.
for (const [scene, cue] of [[16, UI_CUES.share], [16, UI_CUES.source],
  [24, UI_CUES.copy], [24, UI_CUES.send], [40, UI_CUES.voice.hostMic],
  [40, UI_CUES.voice.viewerMic], [56, UI_CUES.control.open], [56, UI_CUES.control.allow]]) {
  const cueBeat = cue / UI_BEAT;
  const hold = scene === 16 && cueBeat > SOURCE_READ.at ? SOURCE_READ.beats : 0;
  fxCues.push({ at: (scene + cueBeat + hold) * beat, kind: 'tap' });
}
const fx = percussion(fxCues, duration);
const speechWindows = cues.map(cue => [cue.at, cue.at + spokenUnits(cue).length * SPEECH_STEP]);
const mixed = new Float32Array(voice.length * 2);
let peak = 0;
for (let i = 0; i < voice.length; i++) {
  const t = i / rate;
  const duck = Math.max(0, ...speechWindows.map(([start, end]) => clamp((t - start + .08) / .08) * clamp((end + .2 - t) / .2)));
  // One small held breath before the arrival; otherwise preserve the track's own groove.
  const rest = t > 35 * beat && t < 36 * beat ? .18 : 1;
  const fade = Math.min(1, t / .015, (duration - t) / .65);
  for (let channel = 0; channel < 2; channel++) {
    const index = i * 2 + channel;
    mixed[index] = ((music[index] || 0) * .64 * (1 - .68 * duck) * rest + voice[i] * .9 + fx[i]) * fade;
    peak = Math.max(peak, Math.abs(mixed[index]));
  }
}
const gain = Math.min(1, .94 / peak);
for (let i = 0; i < mixed.length; i++) mixed[i] *= gain;
execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '192k',
  '-map_metadata', '-1', fileURLToPath(new URL('assets/story.mp3', import.meta.url))], { input: pcmWave(mixed, 2), windowsHide: true });
console.log(`${study.id}: ${duration.toFixed(2)} seconds, peak ${(peak * gain).toFixed(3)}`);
