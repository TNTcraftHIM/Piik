import { createArt, DURATION } from './art.js';

const root = document.documentElement;
const body = document.body;
const byId = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
root.lang = params.get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
if (['light', 'dark'].includes(params.get('theme'))) root.dataset.theme = params.get('theme');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const audio = byId('soundtrack');
const seek = byId('seek');
seek.max = String(Math.ceil(DURATION * 100) / 100);
let art = createArt(byId('film-art'), root.lang);
let time = 0;
let origin = 0;
let playing = false;
let sound = true;
let started = false;
let frame = 0;
let generation = 0;
const say = (en, zh) => root.lang === 'zh-CN' ? zh : en;
const bounded = (value) => Math.min(DURATION, Math.max(0, value));
const stamp = (value) => `0:${String(Math.floor(value)).padStart(2, '0')}`;

// Audible playback follows the media clock, including buffering/seeking. Muted
// playback needs no audio request and uses one monotonic anchor instead.
function position() {
  if (!playing) return time;
  return bounded(sound ? (audio.readyState ? audio.currentTime : time) : time + (performance.now() - origin) / 1000);
}

function showState() {
  body.toggleAttribute('data-playing', playing);
  body.toggleAttribute('data-started', started);
  byId('play').setAttribute('aria-label', time >= DURATION ? say('Replay', '重播') : playing ? say('Pause', '暂停') : say('Play', '播放'));
  byId('replay').setAttribute('aria-label', say('Replay', '从头播放'));
  byId('sound').setAttribute('aria-label', say('Sound', '声音'));
  byId('sound').setAttribute('aria-pressed', String(sound));
  byId('capture').setAttribute('aria-label', say('Clean fullscreen view', '全屏干净画面'));
  byId('curtain').hidden = started;
  byId('transport').hidden = !started;
}

function paint() {
  const current = position();
  art.render(current, !started);
  seek.value = String(current);
  seek.setAttribute('aria-valuetext', `${stamp(current)} / ${stamp(DURATION)}`);
  byId('time').textContent = `${stamp(current)} / ${stamp(DURATION)}`;
  if (playing && current >= DURATION) {
    pause();
  } else if (playing) {
    frame = requestAnimationFrame(paint);
  }
}

function pause() {
  time = position();
  playing = false;
  generation++;
  audio.pause();
  cancelAnimationFrame(frame);
  showState();
  paint();
}

async function play(audible = sound, fromStart = false) {
  pause();
  if (fromStart || time >= DURATION) time = 0;
  sound = audible;
  playing = true;
  started = true;
  origin = performance.now();
  const owner = ++generation;
  byId('player-status').textContent = '';
  if (sound) {
    // Setting src here, rather than on the poster, keeps the first visit light.
    if (!audio.getAttribute('src')) audio.src = './assets/funkorama.mp3';
    else if (audio.error) audio.load();
    audio.currentTime = time;
  }
  showState();
  paint();
  if (sound) {
    try {
      await audio.play();
    } catch {
      if (owner !== generation || !sound) return;
      continueMuted();
    }
  }
}

function seekTo(value) {
  const resume = playing;
  pause();
  time = bounded(value);
  started = true;
  if (resume && time < DURATION) void play();
  else { showState(); paint(); }
}

function continueMuted() {
  time = bounded(audio.currentTime || time);
  audio.pause();
  sound = false;
  origin = performance.now();
  byId('player-status').textContent = say('Music could not play. The film will continue without sound.', '音乐暂时无法播放，短片将继续静音播放。');
  showState();
}

function toggleSound() {
  if (playing) void play(!sound);
  else { sound = !sound; showState(); }
}

function localize() {
  const language = byId('language');
  language.textContent = say('简体中文', 'English');
  language.setAttribute('aria-label', say('切换到简体中文', 'Switch to English'));
  document.title = say('Piik — Good things. Shared.', 'Piik — 好东西，一起看。');
  document.querySelectorAll('[data-home]').forEach((link) => {
    const url = new URL(link.getAttribute('href'), location.href);
    url.searchParams.set('lang', root.lang);
    if (root.dataset.theme) url.searchParams.set('theme', root.dataset.theme);
    link.href = url.href;
  });
  byId('reduced-note').hidden = !reduceMotion.matches;
  showState();
}

byId('start').addEventListener('click', () => { void play(true, true); byId('play').focus({ preventScroll: true }); });
byId('start-muted').addEventListener('click', () => { void play(false, true); byId('play').focus({ preventScroll: true }); });
byId('play').addEventListener('click', () => playing ? pause() : void play());
byId('replay').addEventListener('click', () => void play(sound, true));
byId('sound').addEventListener('click', toggleSound);
seek.addEventListener('input', () => seekTo(Number(seek.value)));
byId('language').addEventListener('click', () => {
  root.lang = root.lang === 'en' ? 'zh-CN' : 'en';
  art = createArt(byId('film-art'), root.lang);
  localize();
  // The active loop will render the new artwork at the same media position.
  if (!playing) paint();
});
byId('capture').addEventListener('click', async () => {
  body.classList.add('clean');
  byId('capture').blur();
  try { await root.requestFullscreen(); } catch { /* A clean window also supports ordinary browser/OS capture. */ }
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) body.classList.remove('clean');
});
byId('about').addEventListener('click', () => {
  pause();
  byId('credits').showModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && body.classList.contains('clean')) {
    body.classList.remove('clean');
    if (document.fullscreenElement) void document.exitFullscreen();
  }
  if (byId('credits').open || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
  if (event.code === 'Space' && !event.target.closest('button,a')) { event.preventDefault(); if (playing) pause(); else void play(); }
  if (event.key.toLowerCase() === 'r') void play(sound, true);
  if (event.key.toLowerCase() === 'm') toggleSound();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) pause(); });
window.addEventListener('pagehide', pause);
reduceMotion.addEventListener('change', () => {
  if (reduceMotion.matches && playing) pause();
  byId('reduced-note').hidden = !reduceMotion.matches;
});
audio.addEventListener('waiting', () => {
  if (playing && sound) byId('player-status').textContent = say('Loading music…', '正在加载音乐…');
});
audio.addEventListener('playing', () => { byId('player-status').textContent = ''; });
audio.addEventListener('pause', () => {
  // Native/OS media controls share the same pause owner as the visible button.
  if (playing && sound && audio.paused && !audio.ended && !audio.error) pause();
});
audio.addEventListener('error', () => { if (playing && sound) continueMuted(); });
audio.addEventListener('ended', () => {
  if (!playing || !sound) return;
  // Codec duration rounding can end the soundtrack a fraction of a frame early.
  if (audio.currentTime >= DURATION - 1 / 60) {
    time = DURATION;
    playing = false;
    pause();
  } else {
    continueMuted();
  }
});

byId('language').hidden = false;
byId('about').hidden = false;
body.dataset.ready = '';
localize();
paint();
