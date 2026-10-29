// Public film player. Each instance owns one native audio clock and one film.
import { loadFonts } from './fonts.js';
import { CONTROL_CSS, ICON } from './playback-controls.js';

export const FILMS = {
  A: () => import('../films/A/film.js'),
};

const UI_CSS = `
:host { all: initial; display: block; position: relative; container-type: inline-size; font: 16px/1.2 system-ui, sans-serif; color: var(--ink); color-scheme: inherit; width: 100%; aspect-ratio: var(--ar, 16 / 9); background: var(--silip-dark-wall); overflow: hidden; border-radius: var(--silip-radius, 0px); contain: content; -webkit-tap-highlight-color: transparent; }
:host([hidden]) { display: none; }
.pk-bar, .pk-bar *, .pk-cover, .pk-cover *, .pk-status { box-sizing: border-box; }
.pk-frame { position: absolute; inset: 0; }
#wrap { position: absolute; left: 0; top: 0; overflow: hidden; }
#stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.pk-cover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: linear-gradient(transparent, color-mix(in srgb, var(--silip-dark-wall) 24%, transparent)); cursor: pointer; transition: opacity .25s; }
.pk-cover[hidden], .pk-loading[hidden], .pk-status:empty { display: none; }
.pk-big { --button-size: clamp(56px, 9cqw, 88px); --button-icon-size: clamp(24px, 4cqw, 36px); width: var(--button-size); padding: 0; }
.pk-bar { position: absolute; inset: auto 8px max(8px, env(safe-area-inset-bottom)); width: min(640px, calc(100% - 16px)); flex-wrap: nowrap; gap: 4px; font: 600 12px/1.2 system-ui, sans-serif; opacity: 0; pointer-events: none; transform: translateY(6px); transition: opacity 180ms ease, transform 220ms var(--spring); }
.pk-bar.show, :host(:focus-visible) .pk-bar, .pk-bar:has(:focus-visible, :active) { opacity: 1; pointer-events: auto; transform: none; }
.pk-bar .lr-btn { flex: none; min-width: 0; width: var(--control-compact-size); padding: 0; }
.pk-bar button[hidden] { display: none; }
button { font-family: inherit; cursor: pointer; touch-action: manipulation; }
.pk-track { flex: 1; width: 100%; min-width: 24px; height: var(--control-compact-size); padding: 0; margin: 0 4px; accent-color: var(--action); cursor: pointer; }
.pk-time { flex: none; margin-inline: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 500; }
.pk-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--silip-dark-ink); font: 600 13px system-ui, sans-serif; opacity: .8; }
:host([controls="none"]) .pk-bar { display: none; }
:host(:not([data-playing]):not([data-ended])) .pk-bar { opacity: 1; pointer-events: auto; transform: none; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
.pk-status { position: absolute; top: 12px; left: 12px; right: 12px; margin: 0; padding: 10px 14px; background: var(--paper); color: var(--ink); font: 14px/1.4 system-ui, sans-serif; border-radius: 12px; }
@container (max-width: 420px) {
  .pk-time { display: none; }
  .pk-bar { gap: 2px; }
  .pk-cover { padding-bottom: calc(var(--control-compact-size) + 22px); }
}
@media (hover: hover) { .pk-bar:hover { opacity: 1; pointer-events: auto; transform: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
`;
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;


export class SilipPromo extends HTMLElement {
  static get observedAttributes() { return ['lang', 'film']; }
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CONTROL_CSS + UI_CSS + '</style><style class="film"></style>' +
      '<div class="pk-frame"><div id="wrap"></div></div><div class="pk-loading" role="status"></div>' +
      '<div class="pk-cover" hidden><button type="button" class="lr-btn pk-big">' + ICON.play + '</button></div>' +
      '<div class="pk-bar lr-media-toolbar lr-media-controls" part="controls" role="group">' +
      '<button type="button" class="lr-btn pk-pp"></button><button type="button" class="lr-btn pk-snd"></button>' +
      '<input class="pk-track" type="range" min="0" max="0" step="0.01" value="0">' +
      '<span class="pk-time">0:00 / 0:00</span><button type="button" class="lr-btn pk-lang"></button>' +
      '<button type="button" class="lr-btn pk-fs"></button></div>' +
      '<p class="pk-status" role="status"></p><audio preload="none"></audio>';
    this.$ = sel => root.querySelector(sel);
    this.audio = this.$('audio');
    this.film = null;
    this.meta = null;
    this.t = 0;
    this.playing = false;
    this._poster = true;
    this._request = 0;
    this._raf = 0;
    this._inView = true;
    this._motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.$('.pk-big').onclick = () => void this.play();
    this.$('.pk-cover').onclick = event => { if (event.target === event.currentTarget) void this.play(); };
    this.$('.pk-pp').onclick = () => this.playing ? this.pause() : void this.play();
    this.$('.pk-snd').onclick = () => { this.muted = !this.muted; };
    this.$('.pk-lang').onclick = () => this.setAttribute('lang', this.lang2() === 'zh' ? 'en' : 'zh');
    this.$('.pk-track').oninput = event => this.seek(Number(event.target.value));
    this.$('.pk-fs').onclick = async () => {
      try {
        if (document.fullscreenElement === this) await document.exitFullscreen();
        else await this.requestFullscreen();
      } catch { this.status('Fullscreen is unavailable.', '暂时无法全屏。'); }
    };
    this.onkeydown = event => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
          event.composedPath().some(node => node instanceof Element && node.matches('button,input,a,select,textarea,[contenteditable]'))) return;
      if (event.code === 'Space' || event.code === 'KeyK') {
        event.preventDefault();
        this.playing ? this.pause() : void this.play();
      }
    };
    this.audio.onended = () => { if (this.playing && this.audio.ended) this.finish(); };
    this.audio.onpause = () => { if (this.playing && this.audio.paused && !this.audio.ended && !this.audio.error) this.pause(); };
    this.audio.onerror = () => {
      if (!this.audio.error || !this.playing || this._starting === this._request) return;
      const position = this.t;
      this.pause();
      if (this.nextSource(position)) void this.play();
      else this.status('Music could not play. Try Play again; you can still seek through the film.', '音乐暂时无法播放。请重试，或拖动进度查看短片。');
    };
    this.audio.onwaiting = () => { if (this.playing) this.status('Loading music…', '正在加载音乐…'); };
    this.audio.onplaying = () => this.status('', '');
  }
  connectedCallback() {
    this.tabIndex = this.tabIndex >= 0 ? this.tabIndex : 0;
    this._events = new AbortController();
    const options = { signal: this._events.signal };
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); else this.sync(); }, options);
    window.addEventListener('pagehide', () => this.pause(), options);
    document.addEventListener('fullscreenchange', () => this.sync(), options);
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'keydown']) {
      this.addEventListener(type, () => this.showControls(), options);
    }
    this.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'touch') this.hideControls();
    }, options);
    this._motion.addEventListener('change', () => { if (this._motion.matches) this.pause(); }, options);
    this._ro = new ResizeObserver(() => this.fit());
    this._ro.observe(this);
    // A player loads on entry and pauses on exit; resuming always belongs to the visitor.
    this._io = new IntersectionObserver(entries => {
      this._inView = entries[0].isIntersecting;
      if (this._inView && !this.film && !this._loading) void this.load();
      if (!this._inView) this.pause();
      else this.sync();
    });
    this._io.observe(this);
    this.sync();
  }
  disconnectedCallback() {
    this.pause();
    this.hideControls();
    this._loadController?.abort();
    this._loadController = null;
    this._loading = null;
    this._selection = null;
    this._events?.abort();
    this._ro?.disconnect();
    this._io?.disconnect();
    this.film?.dispose?.();
    this.film = null;
    this.meta = null;
    this.$('#wrap').replaceChildren();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.sync();
  }
  attributeChangedCallback(name, previous, next) {
    if (previous !== next && this.isConnected && (this.film || this._loading)) void this.load(true);
  }
  lang2() {
    const lang = this.getAttribute('lang') || document.documentElement.lang || navigator.language || 'en';
    return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  get duration() { return this.film?.duration || 0; }
  get currentTime() { return this.playing ? Math.min(this.duration, this.audio.currentTime) : this.t; }
  set currentTime(value) { this.seek(value); }
  get muted() { return this.audio.muted; }
  set muted(value) { this.audio.muted = !!value; this.sync(); }
  showControls() {
    clearTimeout(this._controlsTimer);
    this.$('.pk-bar').classList.add('show');
    // As in room playback, idle controls yield the picture after two seconds.
    this._controlsTimer = setTimeout(() => this.hideControls(), 2000);
  }
  hideControls() {
    clearTimeout(this._controlsTimer);
    this.$('.pk-bar').classList.remove('show');
  }
  status(en, zh) { this.$('.pk-status').textContent = this.lang2() === 'zh' ? zh : en; }
  sync() {
    const zh = this.lang2() === 'zh';
    const label = (en, cn) => zh ? cn : en;
    const play = this.playing ? label('Pause', '暂停') : this.t >= this.duration && this.duration ? label('Replay', '重播') : label('Play', '播放');
    this.toggleAttribute('data-playing', this.playing);
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', this.meta?.title[this.lang2()] || label('Silip film', 'Silip 短片'));
    this.$('.pk-bar').setAttribute('aria-label', label('Playback controls', '播放控制'));
    this.$('.pk-pp').innerHTML = this.playing ? ICON.pause : this.t >= this.duration && this.duration ? ICON.refresh : ICON.play;
    this.$('.pk-pp').setAttribute('aria-label', play);
    this.$('.pk-big').setAttribute('aria-label', play);
    const heldEnd = this.meta?.holdEnd && this.duration && this.t >= this.duration;
    this.toggleAttribute('data-ended', !!heldEnd);
    this.$('.pk-cover').hidden = this.playing || !!this._loading || heldEnd;
    this.film?.stage.toggleAttribute('data-ending-idle', !!heldEnd && !this.playing && this.isConnected && this._inView && !document.hidden);
    this.$('.pk-track').disabled = !this.film;
    this.$('.pk-track').max = String(this.duration);
    this.$('.pk-track').value = String(this.currentTime);
    this.$('.pk-track').setAttribute('aria-label', label('Film position', '播放进度'));
    this.$('.pk-lang').textContent = zh ? 'EN' : '中';
    this.$('.pk-lang').setAttribute('aria-label', zh ? 'Switch to English' : '切换到简体中文');
    this.$('.pk-snd').innerHTML = this.muted ? ICON.speakerOff : ICON.speaker;
    this.$('.pk-snd').setAttribute('aria-label', this.muted ? label('Unmute', '开启声音') : label('Mute', '静音'));
    this.$('.pk-snd').setAttribute('aria-pressed', String(this.muted));
    const fullscreen = document.fullscreenElement === this;
    this.$('.pk-fs').innerHTML = fullscreen ? ICON.contract : ICON.expand;
    this.$('.pk-fs').setAttribute('aria-label', fullscreen ? label('Exit fullscreen', '退出全屏') : label('Fullscreen', '全屏'));
    this.$('.pk-fs').hidden = !document.fullscreenEnabled;
    for (const button of this.shadowRoot.querySelectorAll('.pk-bar button')) button.title = button.getAttribute('aria-label');
    this.$('.pk-loading').hidden = !this._loading;
    this.$('.pk-loading').textContent = label('Loading film…', '正在加载短片…');
  }
  load(replace = false) {
    if (!this.isConnected) return Promise.resolve(null);
    if (this._loading && !replace) return this._loading;
    const resume = this.playing || !!this._selection?.resume;
    const id = this.getAttribute('film') || 'A';
    const position = this.meta?.id === id ? (this._poster ? null : this.currentTime)
      : this._selection?.id === id ? this._selection.position : null;
    this.pause();
    const request = this._request;
    this._selection = { id, position, resume };
    this._loadController?.abort();
    const controller = this._loadController = new AbortController();
    const { signal } = controller;
    this.film?.dispose?.();
    this.film = null;
    this.meta = null;
    this.$('#wrap').replaceChildren();
    this.audio.removeAttribute('src');
    this.audio.load();
    const lang = this.lang2();
    this.status('', '');
    const current = () => this.isConnected && this._loadController === controller && !signal.aborted;
    this._loading = (async () => {
      let film;
      try {
        if (!Object.hasOwn(FILMS, id)) throw new Error('Unknown film');
        const mod = await FILMS[id]();
        if (!current()) return null;
        const css = await Promise.all(mod.meta.css.map(async url => {
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error('Film stylesheet unavailable');
          return response.text();
        }));
        await loadFonts(mod.meta, lang);
        if (!current()) return null;
        this.$('style.film').textContent = css.join('\n');
        this.style.setProperty('--ar', mod.meta.size.join(' / '));
        const stage = document.createElement('div');
        stage.id = 'stage';
        this.$('#wrap').replaceChildren(stage);
        film = await mod.build(stage, { lang, signal });
        if (!current()) { film.dispose?.(); return null; }
        this._selection = null;
        this.film = film;
        this.meta = mod.meta;
        this._sources = [this.audio.canPlayType('audio/webm; codecs="opus"') ? mod.meta.audio.webm : null, mod.meta.audio.m4a].filter(Boolean);
        this._sourceIndex = -1;
        this.t = Math.max(0, Math.min(film.duration, position ?? 0));
        this._poster = position === null;
        this.fit();
        this.draw();
        return film;
      } catch (error) {
        film?.dispose?.();
        if (current()) {
          this.status('The film could not load. Try Play again.', '短片暂时无法加载，请点击播放重试。');
          console.warn('[silip] film unavailable', error);
        }
        return null;
      } finally {
        if (current()) { this._loading = null; this.sync(); }
      }
    })();
    const loading = this._loading;
    this.sync();
    void loading.then(film => {
      if (!film || !current() || request !== this._request) return;
      if (resume) void this.play();
      else if (position === null && this.hasAttribute('autoplay') && !this._motion.matches) { this.muted = true; void this.play(); }
    });
    return loading;
  }
  nextSource(position) {
    const url = this._sources?.[++this._sourceIndex];
    if (!url) return false;
    this.audio.src = url;
    this.audio.currentTime = position;
    return true;
  }
  async play() {
    const loading = (!this.film || this._loading) ? this.load() : null;
    if (this.playing) return;
    const request = ++this._request;
    if (loading) await loading;
    if (request !== this._request || !this.film || !this.isConnected || document.hidden || !this._inView) return;
    if (this._poster || this.t >= this.duration - 0.02) this.t = 0;
    this._poster = false;
    this.status('', '');
    if (!this.audio.getAttribute('src')) this.nextSource(this.t);
    else if (this.audio.error) this.audio.load();
    this.audio.currentTime = this.t;
    this.playing = true;
    this.sync();
    this.tick();
    this._starting = request;
    try {
      while (request === this._request) {
        try { await this.audio.play(); break; }
        catch (error) {
          if (request !== this._request) return;
          if ((this.audio.error || error.name === 'NotSupportedError') && this.nextSource(this.t)) continue;
          this.pause();
          this.status('Music could not play. Try Play again; you can still seek through the film.', '音乐暂时无法播放。请重试，或拖动进度查看短片。');
          return;
        }
      }
      if (request === this._request) this.dispatchEvent(new Event('play'));
    } finally { if (this._starting === request) this._starting = null; }
  }
  pause() {
    const was = this.playing;
    if (this._selection) this._selection.resume = false;
    if (was) this.t = this.currentTime;
    this.playing = false;
    ++this._request;
    this.audio.pause();
    cancelAnimationFrame(this._raf);
    this.sync();
    this.draw();
    if (was) this.dispatchEvent(new Event('pause'));
  }
  seek(value) {
    if (!this.film || !Number.isFinite(value)) return;
    this.t = Math.max(0, Math.min(this.duration, value));
    this._poster = false;
    if (this.audio.getAttribute('src')) this.audio.currentTime = this.t;
    this.sync();
    this.draw();
  }
  finish() {
    if (!this.film) return;
    this.pause();
    if (this.hasAttribute('loop')) { this.seek(0); void this.play(); return; }
    this.t = this.duration;
    this.sync();
    this.draw();
    this.dispatchEvent(new Event('ended'));
  }
  tick() {
    cancelAnimationFrame(this._raf);
    if (!this.playing) return;
    this.t = this.currentTime;
    if (this.t >= this.duration) { this.finish(); return; }
    this.draw();
    this._raf = requestAnimationFrame(() => this.tick());
  }
  fit() {
    if (!this.film) return;
    const w = this.clientWidth, height = this.clientHeight || w * this.film.H / this.film.W;
    const scale = Math.min(w / this.film.W, height / this.film.H);
    Object.assign(this.$('#wrap').style, { width: this.film.W * scale + 'px', height: this.film.H * scale + 'px', left: (w - this.film.W * scale) / 2 + 'px', top: (height - this.film.H * scale) / 2 + 'px' });
    this.film.stage.style.transform = 'scale(' + scale + ')';
  }
  draw() {
    if (!this.film) return;
    const t = this.currentTime;
    // The cover is a rendered frame, independent of the actual playback clock.
    const frame = this._poster ? Number(this.getAttribute('poster') ?? this.meta.poster ?? 0) : t;
    this.film.render(Math.min(this.duration - 1e-3, Math.max(0, Number.isFinite(frame) ? frame : 0)));
    this.$('.pk-track').value = String(t);
    const value = fmt(t) + ' / ' + fmt(this.duration);
    this.$('.pk-track').setAttribute('aria-valuetext', value);
    if (this.$('.pk-time').textContent !== value) {
      this.$('.pk-time').textContent = value;
      this.dispatchEvent(new Event('timeupdate'));
    }
  }
}
if (!customElements.get('silip-promo')) customElements.define('silip-promo', SilipPromo);

export function mount(container, opts = {}) {
  const element = document.createElement('silip-promo');
  for (const [key, value] of Object.entries(opts)) if (value !== false && value != null) element.setAttribute(key, value === true ? '' : value);
  container.appendChild(element);
  return element;
}
