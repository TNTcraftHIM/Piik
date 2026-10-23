// Piik film engine — kinetic typography helpers (ransom-note letters, split text, decode/typewriter).
import { h, rng, pick, range, clamp, prog, E, T } from './core.js';
import { C } from './art.js';

const CJK = /[㐀-鿿＀-￯　-〿]/;
const PUNCT = /[，。！？、…—：；,.!?:;\-~·]/;

export const FONTS_CN = [
  { f: '"Noto Sans SC"', w: 900 },
  { f: '"Noto Serif SC"', w: 900 },
  { f: '"ZCOOL QingKe"', w: 400 },
  { f: '"Smiley Sans"', w: 400 },
  { f: '"Noto Sans SC"', w: 900 },
];
/** Condensed faces for whole-word tiles (wide display faces overflow small cards). */
export const FONTS_LATIN_WORD = [{ f: 'Anton', w: 400 }, { f: '"Bebas Neue"', w: 400 }, { f: 'Anton', w: 400 }, { f: '"Archivo Black"', w: 400 }];
export const FONTS_LATIN = [
  { f: 'Anton', w: 400 }, { f: '"Archivo Black"', w: 400 }, { f: '"Abril Fatface"', w: 400 },
  { f: '"Bodoni Moda"', w: 900 }, { f: '"Rubik Mono One"', w: 400 }, { f: '"Bebas Neue"', w: 400 },
];
// tile palettes: [background, foreground]
export const TILES = {
  collage: [[C.ink, C.cream], [C.cream, C.ink], [C.yellow, C.ink], [C.red, C.cream], [C.ink, C.yellow], [C.paper, C.red]],
  card: [[C.ink, C.cream], [C.cream, C.ink], [C.yellow, C.ink], [C.red, C.cream], [C.paper, C.ink]],
};

/**
 * Ransom-note text: every token is its own tilted tile with a different face/colour.
 * `text` is a string (one tile per character) or an array of tokens (e.g. English words).
 * Returns {el, chars:[{el, ch, i, rot, s}]}; animate chars individually with T().
 */
export function ransom(parent, text, { size = 120, seed = 1, tiles = TILES.collage, gap = 0.06, tilt = 7, pad = 0.12, outline = true, punctScale = 0.55, punctColor = C.cream } = {}) {
  const r = rng(seed);
  const el = h('div', { class: 'ransom' }, parent);
  Object.assign(el.style, { display: 'flex', alignItems: 'center', gap: `${gap * size}px`, whiteSpace: 'nowrap', position: 'absolute' });
  const chars = [];
  let prev = -1;
  (Array.isArray(text) ? text : [...text]).forEach((ch, i) => {
    const isP = ch.length === 1 && PUNCT.test(ch), cjk = CJK.test(ch);
    const box = h('span', { class: 'rc' }, el);
    const inner = h('span', { text: ch }, box);
    let ti = Math.floor(r() * tiles.length);
    if (ti === prev) ti = (ti + 1) % tiles.length;
    prev = ti;
    const [bg, fg] = tiles[ti];
    const face = cjk || isP ? pick(r, FONTS_CN) : pick(r, ch.length > 1 ? FONTS_LATIN_WORD : FONTS_LATIN);
    const word = ch.length > 1;
    const sc = isP ? punctScale : word ? range(r, 0.86, 1.0) : range(r, 0.9, 1.12);
    const rot = range(r, -tilt, tilt) * (word ? 0.6 : 1);
    const fs = size * sc;
    Object.assign(box.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: isP ? 'transparent' : bg, color: isP ? punctColor : fg,
      padding: isP ? '0' : `${pad * fs}px ${pad * 1.1 * fs}px`,
      lineHeight: 1, fontFamily: face.f, fontWeight: face.w, fontSize: `${fs}px`,
      transform: `rotate(${rot}deg) translateY(${range(r, -0.07, 0.07) * size}px)`,
      boxShadow: isP || !outline ? 'none' : `${0.05 * size}px ${0.06 * size}px 0 ${C.ink2}`,
      border: isP || !outline ? 'none' : `${Math.max(2, 0.03 * size)}px solid ${C.ink}`,
      borderRadius: `${range(r, 0, 0.06) * size}px`,
      willChange: 'transform',
    });
    chars.push({ el: box, inner, ch, i, rot, s: sc, punct: isP });
  });
  return { el, chars };
}

/** Animate ransom chars popping in on given times (one per char). Call each frame. */
export function ransomPop(chars, t, times, { dur = 0.16, from = 2.2, spin = 30, out = null } = {}) {
  chars.forEach((c, i) => {
    const t0 = times[Math.min(i, times.length - 1)];
    const p = prog(t0, t0 + dur, t);
    const k = E.outBack(p);
    let sc = t < t0 ? 0 : from + (1 - from) * k, o = t < t0 ? 0 : 1;
    let extra = (1 - p) * spin * (i % 2 ? 1 : -1);
    if (out && t > out[0]) {
      const q = E.in3(prog(out[0] + i * (out[2] || 0), out[1] + i * (out[2] || 0), t));
      sc *= 1 - q; o *= 1 - q;
    }
    c.el.style.transform = `rotate(${(c.rot + extra).toFixed(2)}deg) scale(${Math.max(0, sc).toFixed(3)})`;
    c.el.style.opacity = o;
  });
}

/** Split text into per-character spans (for staggered reveals). */
export function split(parent, text, style = {}) {
  const el = h('div', {}, parent);
  Object.assign(el.style, { whiteSpace: 'pre', display: 'inline-block' }, style);
  const chars = [...text].map(ch => { const c = h('span', { text: ch }, el); c.style.display = 'inline-block'; return c; });
  return { el, chars };
}

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&@$*+=/<>';
/** Industrial decode: random glyphs resolve left-to-right into the target text. */
export function decode(text, t, t0, dur = 0.5, seed = 1) {
  if (t < t0) return '';
  const p = clamp((t - t0) / dur), n = text.length, shown = Math.floor(p * n * 1.25);
  let out = '';
  const fr = Math.floor(t * 30);
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (i < shown - 3 || p >= 1 || ch === ' ') out += ch;
    else if (i < shown) out += GLYPHS[Math.floor(rng(seed * 997 + i * 31 + fr)() * GLYPHS.length)];
    else break;
  }
  return out;
}
/** Typewriter substring by characters-per-second. */
export const typed = (text, t, t0, cps = 18) => (t < t0 ? '' : [...text].slice(0, Math.floor((t - t0) * cps) + 1).join(''));
