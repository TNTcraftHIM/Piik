// Silip film engine — core.
// Every frame is a pure function of time t (seconds): no CSS transitions, no wall-clock animation.
// That makes frames reproducible, renderable out of order (parallel workers) and frame-locked to the audio.

export const W = 1920, H = 1080;

// ---------------------------------------------------------------- math
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
/** Normalised progress of x through [a, b], clamped to 0..1. */
export const prog = (a, b, x) => (b === a ? (x >= b ? 1 : 0) : clamp((x - a) / (b - a)));
export const fract = x => x - Math.floor(x);
export const TAU = Math.PI * 2;
export const deg = r => (r * 180) / Math.PI;
export const rad = d => (d * Math.PI) / 180;

// ---------------------------------------------------------------- easing
const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1, c4 = TAU / 3;
function bounceOut(x) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
export const E = {
  lin: x => x,
  in2: x => x * x, out2: x => 1 - (1 - x) ** 2, io2: x => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
  in3: x => x ** 3, out3: x => 1 - (1 - x) ** 3, io3: x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  in4: x => x ** 4, out4: x => 1 - (1 - x) ** 4, io4: x => (x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
  in5: x => x ** 5, out5: x => 1 - (1 - x) ** 5, io5: x => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  inExpo: x => (x === 0 ? 0 : 2 ** (10 * x - 10)),
  outExpo: x => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
  ioExpo: x => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
  inCirc: x => 1 - Math.sqrt(1 - x * x), outCirc: x => Math.sqrt(1 - (x - 1) ** 2),
  inBack: x => c3 * x ** 3 - c1 * x * x,
  outBack: x => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
  ioBack: x => (x < 0.5 ? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2 : ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
  outElastic: x => (x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
  outBounce: bounceOut,
  hold: x => (x < 1 ? 0 : 1),
};
/** outBack with adjustable overshoot. */
export const backOut = (s = c1) => x => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
/** Spring-like settle: overshoots and decays (k = oscillations, d = damping). */
export const spring = (k = 2.2, d = 5) => x => (x >= 1 ? 1 : 1 - Math.exp(-d * x) * Math.cos(TAU * k * x) * (1 - x));
export const stepped = (n, f = E.lin) => x => Math.floor(f(x) * n) / n;
const easeOf = e => (typeof e === 'function' ? e : E[e] || E.lin);

/**
 * Keyframe interpolation. keys = [[t, value, ease?], ...] sorted by t.
 * The ease on a key shapes the segment that ENDS at that key. Values may be numbers or number arrays.
 */
export function kf(t, keys) {
  const n = keys.length;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 1;
  while (keys[i][0] <= t) i++;
  const [t0, v0] = keys[i - 1];
  const [t1, v1, e] = keys[i];
  const q = easeOf(e)((t - t0) / (t1 - t0));
  return Array.isArray(v0) ? v0.map((a, j) => a + (v1[j] - a) * q) : v0 + (v1 - v0) * q;
}
/** Single tween from a (at t0) to b (at t1). */
export const tw = (t, t0, t1, a, b, e = 'lin') => a + (b - a) * easeOf(e)(prog(t0, t1, t));
/** 0→1 pulse: rises over [t0, t0+up], holds, falls over [t1-down, t1]. */
export const pulse = (t, t0, t1, up = 0.1, down = 0.1, eIn = 'out3', eOut = 'in3') =>
  t < t0 || t > t1 ? 0 : Math.min(easeOf(eIn)(prog(t0, t0 + up, t)), 1 - easeOf(eOut)(prog(t1 - down, t1, t)));

// ---------------------------------------------------------------- music clock
/** Beat clock: at(bar, beat) → seconds (1-indexed, beat may be fractional). */
export function clock(bpm, beatsPerBar = 4, offset = 0) {
  const spb = 60 / bpm;
  return {
    bpm, spb, bar: spb * beatsPerBar,
    at: (bar, beat = 1) => offset + ((bar - 1) * beatsPerBar + (beat - 1)) * spb,
    beat: t => (t - offset) / spb, // continuous beat index from 0
  };
}

// ---------------------------------------------------------------- noise / random
export function hash(i) {
  let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
/** Smooth 1D value noise in [-1, 1]. */
export function noise(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = hash(i + seed * 7919) * 2 - 1, b = hash(i + 1 + seed * 7919) * 2 - 1;
  return a + (b - a) * u;
}
/** Seeded PRNG (mulberry32) → function returning [0,1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
export const range = (r, a, b) => a + (b - a) * r();

/** Deterministic camera shake: returns {x, y, r} decaying from t0 over dur. */
export function shake(t, t0, dur, amp = 20, freq = 30, seed = 1) {
  if (t < t0 || t > t0 + dur) return { x: 0, y: 0, r: 0 };
  const k = 1 - (t - t0) / dur, a = amp * k * k;
  return { x: noise(t * freq, seed) * a, y: noise(t * freq, seed + 3) * a, r: noise(t * freq * 0.7, seed + 7) * a * 0.04 };
}

// ---------------------------------------------------------------- DOM
const SVGNS = 'http://www.w3.org/2000/svg';
function applyAttrs(el, attrs, isSvg) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class' && !isSvg) el.className = v;
    else el.setAttribute(k, v);
  }
}
/** Create an HTML element. */
export function h(tag, attrs, parent) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs, false);
  if (parent) parent.appendChild(el);
  return el;
}
/** Create an SVG element (use tag 'svg' for a root). */
export function s(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  applyAttrs(el, attrs, true);
  if (parent) parent.appendChild(el);
  return el;
}
/** Parse an SVG/HTML string into a node. */
export function frag(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

/**
 * Set CSS transform/opacity on an HTML element. p: {x,y,s,sx,sy,r,skx,sky,o,ox,oy}.
 * Order: translate → rotate → skew → scale (about transform-origin).
 */
export function T(el, p) {
  let tr = '';
  if (p.x || p.y) tr += `translate(${(p.x || 0).toFixed(2)}px,${(p.y || 0).toFixed(2)}px)`;
  if (p.r) tr += ` rotate(${p.r.toFixed(3)}deg)`;
  if (p.skx || p.sky) tr += ` skew(${(p.skx || 0).toFixed(3)}deg,${(p.sky || 0).toFixed(3)}deg)`;
  const sc = p.s ?? 1, sx = sc * (p.sx ?? 1), sy = sc * (p.sy ?? 1);
  if (sx !== 1 || sy !== 1) tr += ` scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
  el.style.transform = tr || 'none';
  if (p.o !== undefined) el.style.opacity = clamp(p.o).toFixed(3);
  if (p.ox !== undefined || p.oy !== undefined) el.style.transformOrigin = `${p.ox ?? '50%'} ${p.oy ?? '50%'}`;
  return el;
}
/** Set an SVG transform attribute. p: {x,y,s,sx,sy,r,skx,cx,cy} (rotation/scale about cx,cy). */
export function ST(el, p) {
  const cx = p.cx || 0, cy = p.cy || 0;
  const sc = p.s ?? 1, sx = sc * (p.sx ?? 1), sy = sc * (p.sy ?? 1);
  let tr = `translate(${(p.x || 0) + cx} ${(p.y || 0) + cy})`;
  if (p.r) tr += ` rotate(${p.r})`;
  if (p.skx) tr += ` skewX(${p.skx})`;
  if (sx !== 1 || sy !== 1) tr += ` scale(${sx} ${sy})`;
  if (cx || cy) tr += ` translate(${-cx} ${-cy})`;
  el.setAttribute('transform', tr);
  if (p.o !== undefined) el.setAttribute('opacity', clamp(p.o).toFixed(3));
  return el;
}
/** Show/hide without losing a custom inline display (e.g. flex): the value is remembered while hidden. */
export const show = (el, on) => {
  if (on) { if (el.style.display === 'none') el.style.display = el.__disp ?? ''; }
  else if (el.style.display !== 'none') { el.__disp = el.style.display; el.style.display = 'none'; }
};
export const O = (el, o) => { el.style.opacity = clamp(o).toFixed(3); show(el, o > 0.001); };

// ---------------------------------------------------------------- film / scenes
export class Film {
  /**
   * @param {object} o {width, height, duration, fps, background}
   */
  constructor(o) {
    this.W = o.width || W; this.H = o.height || H;
    this.duration = o.duration; this.fps = o.fps || 60;
    this.lang = o.lang || 'zh';
    this.stage = o.stage || document.getElementById('stage');
    this.stage.style.width = this.W + 'px';
    this.stage.style.height = this.H + 'px';
    if (o.background) this.stage.style.background = o.background;
    this.scenes = [];
    this.layers = [];
  }
  /** Add a scene visible during [t0, t1). build(root) returns update(localTime, globalTime). */
  scene(name, t0, t1, build, z = 0) {
    const root = h('div', { class: 'scene', 'data-scene': name }, this.stage);
    root.style.zIndex = z;
    root.style.display = 'none';
    const update = build(root, { t0, t1, dur: t1 - t0 }) || (() => {});
    this.scenes.push({ name, t0, t1, root, update, on: false });
    return root;
  }
  /** Always-on layer (grain, flashes, letterbox). build(root) returns update(t). */
  layer(name, build, z = 100) {
    const root = h('div', { class: 'scene layer', 'data-layer': name }, this.stage);
    root.style.zIndex = z;
    const update = build(root) || (() => {});
    this.layers.push({ name, root, update });
    return root;
  }
  /** Render time t. Returns a Promise only if some scene/layer update returned one (e.g. a real-UI iframe catching up). */
  render(t) {
    let wait = null;
    const take = r => { if (r && typeof r.then === 'function') (wait ||= []).push(r); };
    for (const sc of this.scenes) {
      const on = t >= sc.t0 && t < sc.t1;
      if (on !== sc.on) { sc.root.style.display = on ? '' : 'none'; sc.on = on; }
      if (on) take(sc.update(t - sc.t0, t));
    }
    for (const l of this.layers) take(l.update(t));
    return wait ? Promise.all(wait) : undefined;
  }
}
