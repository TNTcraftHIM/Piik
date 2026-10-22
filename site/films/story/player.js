import { STUDY, durationOf, cuesOf, sceneAt } from './score.js';
import { defs, ease } from './drawing.js';
import { COLOURS } from './cast.js';
import { story } from './story.js';
import { mountBrands } from '../../assets/brand.js';
import { spokenUnits, SPEECH_STEP } from './speech.js';

mountBrands();
const byId = id => document.getElementById(id);
const audio = byId('audio'), seek = byId('seek'), stage = byId('stage');
const query = new URLSearchParams(location.search);
document.body.classList.toggle('embedded', query.get('embedded') === '1');
const study = STUDY;
let time = 0, started = false, playing = false, frame = 0, request = 0;
const stamp = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const duration = () => durationOf(study);

function draw(target, selected, position, id) {
  const shot = sceneAt(selected, position);
  shot.speaker = cuesOf(selected).find(cue => position >= cue.at && position < cue.at + spokenUnits(cue).length * SPEECH_STEP)?.actor;
  const result = story(shot, position, id);
  target.innerHTML = defs(id) + result.art + (id === 'motion' ? '' : result.front || '');
  return { ...result, shot };
}

function placeUI(ui, speaker) {
  const clip = byId('ui-clip');
  clip.hidden = !ui;
  if (!ui) return;
  const scale = stage.clientWidth / 1600;
  clip.style.left = `${ui.x / 16}%`;
  clip.style.top = `${ui.y / 9}%`;
  clip.style.width = `${ui.w / 16}%`;
  clip.style.height = `${(ui.clipHeight ?? ui.w * 740 / 1100) / 9}%`;
  const source = ui.source || { x: 0, y: 0, w: 1100 };
  const zoom = ui.w * scale / source.w;
  byId('product-ui').style.transform = `translate(${-source.x * zoom}px,${-source.y * zoom}px) scale(${zoom})`;
  byId('product-ui').contentWindow?.postMessage({ type: 'piik-film-ui',
    scene: ui.scene, local: ui.local, time: ui.time, speaker: speaker ?? null, lang: 'zh-CN' }, '*');
}

function paint() {
  if (playing) time = Math.min(duration(), audio.currentTime);
  const result = draw(byId('art'), study, time, 'motion');
  byId('front').innerHTML = result.front || '';
  placeUI(result.ui, result.shot.speaker);
  seek.value = String(time);
  seek.setAttribute('aria-valuetext', `${stamp(time)} / ${stamp(duration())}`);
  byId('time').textContent = `${stamp(time)} / ${stamp(duration())}`;
  document.querySelectorAll('#chapters button').forEach((button, index) => button.setAttribute('aria-current', String(result.shot.index === index)));
  const cue = started && cuesOf(study).find(item => time >= item.at && time < item.at + 1.6);
  const subtitles = byId('subtitles');
  subtitles.hidden = !cue;
  if (cue) {
    const name = document.createElement('b'), line = document.createElement('span');
    name.textContent = ['阿团', '小圆', '阿点'][cue.actor];
    line.textContent = cue.zh;
    subtitles.replaceChildren(name, line);
    subtitles.style.setProperty('--speaker-color', COLOURS[cue.actor]);
    subtitles.style.setProperty('--caption-enter', String(ease((time - cue.at) / .13)));
  }
  if (playing) frame = requestAnimationFrame(paint);
}

function state() {
  byId('curtain').hidden = started;
  byId('play').setAttribute('aria-label', playing ? '暂停' : '播放');
  byId('play-shape').setAttribute('d', playing ? 'M6 5h4v14H6Zm8 0h4v14h-4Z' : 'm8 5 11 7-11 7Z');
  byId('sound').setAttribute('aria-pressed', String(!audio.muted));
}

function pause() {
  request++;
  if (playing) time = Math.min(duration(), audio.currentTime);
  playing = false;
  audio.pause();
  cancelAnimationFrame(frame);
  state();
}

async function play(fromStart = false) {
  pause();
  if (!started || fromStart || time >= duration() - .05) time = 0;
  started = true;
  const generation = ++request;
  if (!audio.getAttribute('src')) audio.src = `./assets/${study.id}.mp3`;
  audio.currentTime = time;
  byId('player-status').textContent = '';
  playing = true;
  state();
  paint();
  try {
    await audio.play();
  } catch (error) {
    if (generation !== request) return;
    pause();
    byId('player-status').textContent = '音频未能开始播放，请再点一次播放。仍可拖动查看分镜。';
    console.error(error);
  }
}

function seekTo(value) {
  pause();
  time = Math.max(0, Math.min(duration(), value));
  started = true;
  if (audio.getAttribute('src') && audio.readyState) audio.currentTime = time;
  state();
  paint();
}

function initialize() {
  const selected = study;
  pause();
  started = false;
  time = selected.stills[0];
  audio.removeAttribute('src');
  audio.load();
  seek.max = String(duration());
  byId('name').textContent = selected.name;
  byId('style').textContent = selected.subtitle;
  byId('description').textContent = selected.description;
  byId('verdict').textContent = selected.verdict;
  byId('player-status').textContent = '';
  byId('chapters').replaceChildren(...selected.scenes.map(([beat, name]) => {
    const button = document.createElement('button');
    button.innerHTML = `<span>${stamp(beat * 60 / selected.bpm)}</span>${name}`;
    button.addEventListener('click', () => seekTo(beat * 60 / selected.bpm + .5));
    return button;
  }));
  byId('frames').replaceChildren(...selected.stills.map((at, index) => {
    const shot = selected.scenes[sceneAt(selected, at).index][1];
    const button = document.createElement('button');
    button.innerHTML = `<svg viewBox="0 0 1600 900" aria-hidden="true"></svg><span class="frame-caption">${String(index + 1).padStart(2, '0')} / ${shot}<em>${stamp(at)}</em></span>`;
    button.setAttribute('aria-label', `查看 ${shot}`);
    draw(button.querySelector('svg'), selected, at, `still-${selected.id}-${index}`);
    button.addEventListener('click', () => { seekTo(at); stage.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
    return button;
  }));
  state();
  paint();
}

byId('start').addEventListener('click', () => void play(true));
byId('play').addEventListener('click', () => playing ? pause() : void play());
byId('restart').addEventListener('click', () => void play(true));
byId('sound').addEventListener('click', () => { audio.muted = !audio.muted; state(); });
seek.addEventListener('input', () => seekTo(Number(seek.value)));
const fullscreen = () => document.fullscreenElement ? document.exitFullscreen() : document.querySelector('.review-player').requestFullscreen();
byId('fullscreen').addEventListener('click', () => void fullscreen());
audio.addEventListener('ended', () => { pause(); time = duration(); paint(); });
audio.addEventListener('error', () => { pause(); byId('player-status').textContent = '音轨加载失败，请刷新后重试。'; });
window.addEventListener('resize', () => { if (!playing) paint(); });
window.addEventListener('message', event => {
  if (event.source === byId('product-ui').contentWindow && event.data?.type === 'piik-film-ui-ready' && !playing) paint();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) pause(); });
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); playing ? pause() : void play(); }
  if (event.code === 'KeyR') void play(true);
  if (event.code === 'KeyM') { audio.muted = !audio.muted; state(); }
  if (event.code === 'KeyF') void fullscreen();
  if (event.code === 'ArrowLeft') { event.preventDefault(); seekTo(time - 1); }
  if (event.code === 'ArrowRight') { event.preventDefault(); seekTo(time + 1); }
});

initialize();
if (query.has('t') && Number.isFinite(Number(query.get('t')))) seekTo(Number(query.get('t')));
