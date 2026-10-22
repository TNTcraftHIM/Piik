// D/G share one iframe lifetime; each supplies its own deterministic game artwork.
import { h } from './core.js';

const UI_W = 1100, UI_H = 740;
const UI_BASE = new URL('../frontend/ui/', import.meta.url).href;
const EN_PATCH = [['Pong · 双人对战', 'Pong · 2-Player']];

export function realUI(parent, { lang = 'zh', artwork = 'rally', theme = '', name = 'ui', signal, pongSVG } = {}) {
  const box = h('div', { class: 'abs' }, parent);
  Object.assign(box.style, { width: UI_W + 'px', height: UI_H + 'px', overflow: 'hidden' });
  const frame = h('iframe', { title: `Piik UI (${name})`, scrolling: 'no', tabindex: '-1', 'aria-hidden': 'true' }, box);
  Object.assign(frame.style, { width: UI_W + 'px', height: UI_H + 'px', border: '0', display: 'block', background: 'transparent', pointerEvents: 'none', colorScheme: 'light' });
  const over = h('div', { class: 'abs' }, box);
  Object.assign(over.style, { width: UI_W + 'px', height: UI_H + 'px', pointerEvents: 'none' });

  let win = null, observer, disposed = false, seq = 0, last = '', pending = null;
  let firstFrame = 0, secondFrame = 0, thumbSrc = null, readyTimer, rejectReady;
  const localise = doc => {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [from, to] of EN_PATCH) if (node.nodeValue.includes(from)) node.nodeValue = node.nodeValue.replace(from, to);
    }
  };
  const patchThumbs = () => {
    if (thumbSrc) for (const image of win.document.querySelectorAll('.lr-source-option-preview img')) {
      if (image.getAttribute('src') !== thumbSrc) image.setAttribute('src', thumbSrc);
    }
    if (lang === 'en') localise(win.document);
  };
  const apply = data => {
    const doc = win.document;
    if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur?.();
    doc.documentElement.dataset.piik = data.flags || '';
    for (const animation of doc.getAnimations()) { animation.pause(); animation.currentTime = (data.time || 0) * 1000; }
    if (data.pong) {
      const svg = doc.querySelector('.sample-game');
      if (svg) svg.innerHTML = pongSVG(data.pong);
    }
    if (data.thumb) thumbSrc = data.thumb.src;
    patchThumbs();
  };
  const onFrame = event => {
    if (disposed || event.source !== window || event.origin !== location.origin || event.data?.type !== 'piik-film-ui') return;
    const data = event.data;
    apply(data);
    win.cancelAnimationFrame(firstFrame);
    win.cancelAnimationFrame(secondFrame);
    firstFrame = win.requestAnimationFrame(() => {
      apply(data);
      secondFrame = win.requestAnimationFrame(() => { if (pending?.seq === data.seq) pending.finish(); });
    });
  };
  let onReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    onReady = event => {
      if (disposed || event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'piik-film-ui-ready') return;
      try {
        win = frame.contentWindow;
        const style = win.document.createElement('style');
        style.textContent = '*:focus-visible,*:focus{outline:none!important} html[data-piik~="nobadge"] .lr-interaction-unread{display:none!important}';
        win.document.head.appendChild(style);
        observer = new win.MutationObserver(patchThumbs);
        observer.observe(win.document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'], characterData: true });
        win.addEventListener('message', onFrame);
        window.removeEventListener('message', onReady);
        clearTimeout(readyTimer);
        rejectReady = null;
        resolve();
      } catch (error) { dispose(); reject(error); }
    };
    window.addEventListener('message', onReady);
    readyTimer = setTimeout(() => { reject(new Error('Film interface did not load')); dispose(); }, 15000);
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(readyTimer);
    window.removeEventListener('message', onReady);
    signal?.removeEventListener('abort', dispose);
    observer?.disconnect();
    if (win) {
      win.removeEventListener('message', onFrame);
      win.cancelAnimationFrame(firstFrame);
      win.cancelAnimationFrame(secondFrame);
    }
    pending?.finish();
    rejectReady?.(new DOMException('Film was retired', 'AbortError'));
    rejectReady = null;
    frame.removeAttribute('src');
    frame.remove();
    win = null;
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  else {
    const query = new URLSearchParams({ lang: lang === 'en' ? 'en' : 'zh-CN', artwork });
    if (theme) query.set('theme', theme);
    frame.src = UI_BASE + 'index.html?' + query;
  }

  function render(message) {
    if (!win || disposed) return;
    const key = JSON.stringify(message);
    if (key === last) return pending?.promise;
    last = key;
    // Live playback replaces work before the next UI repaint; offline rendering
    // can await the one requested frame. Neither path retains old frame waiters.
    pending?.finish();
    const current = ++seq;
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(() => pending?.seq === current && pending.finish(), 3000);
    pending = { seq: current, promise, finish: () => {
      clearTimeout(timer);
      if (pending?.seq === current) pending = null;
      finish();
    } };
    win.postMessage({ type: 'piik-film-ui', lang: lang === 'en' ? 'en' : 'zh-CN', speaker: null, ...message, seq: current }, location.origin);
    return promise;
  }
  function rect(selector) {
    const element = win?.document.querySelector(selector);
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
  }
  function cursor() {
    const element = win?.document.getElementById('cursor');
    if (!element || element.hasAttribute('hidden')) return null;
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(element.style.transform || '');
    return match ? { x: +match[1], y: +match[2], o: +(element.style.opacity || 1) } : null;
  }
  return { el: box, frame, over, ready, render, rect, cursor, dispose, get win() { return win; }, W: UI_W, H: UI_H };
}
