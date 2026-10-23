// Piik film engine — brand art: palette, mascot, little people, sofa, icons, reactions and graphic shapes.
// Geometry is taken from the brand SVGs (brand/*.svg, characters/*.svg) so characters stay on-model.
import { s, h, rng, TAU, clamp, lerp } from './core.js';
import { ICONS } from './icons.js';

export const C = {
  ink: '#192530', ink2: '#121b24', night: '#0d141b', cream: '#f6f2e8', paper: '#fffefb', white: '#ffffff',
  yellow: '#ffd05a', yellow2: '#ffc634', gold: '#eaaa38', amber: '#f2c05c',
  tomato: '#e96c55', red: '#ff4a3d', leaf: '#448e6b', poop: '#997554',
  green: 'oklch(0.7015 0.1204 148.3619)', blue: 'oklch(0.7100 0.1156 235.7427)',
  purple: 'oklch(0.7347 0.1109 308.7381)', orange: 'oklch(0.7500 0.1300 55)',
  greenD: 'oklch(0.55 0.12 148)', blueD: 'oklch(0.55 0.12 236)', purpleD: 'oklch(0.56 0.12 309)', orangeD: 'oklch(0.58 0.13 50)',
  primary: '#2765ce', live: '#2fa66a', sky: '#82b1ff',
};

// Character appearance follows stable IDs; cast.js owns localized handles.
export const CAST = {
  tuan: { color: C.green, dark: C.greenD, crown: true },
  yuan: { color: C.blue, dark: C.blueD },
  dian: { color: C.purple, dark: C.purpleD },
  cong: { color: C.orange, dark: C.orangeD },
};

// ---------------------------------------------------------------- mascot (TV)
/**
 * The Piik TV mascot, from brand/mascot.svg (32×32 units, stroke 2.4).
 * Returns {el, set({wink, antenna, squash, look, blink})}. wink: 1 = winking (brand default), 0 = both eyes open.
 */
export function mascot({ stroke = C.ink, fill = 'none', sw = 2.4, size = 200, sparkles = true } = {}) {
  const el = s('svg', { viewBox: '-2 -2 36 36', width: size, height: size, overflow: 'visible' });
  const root = s('g', { fill: 'none', stroke, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, el);
  const bodyG = s('g', {}, root);
  const antenna = s('path', { d: 'm11 4 5 4 5-4' }, bodyG);
  const body = s('rect', { x: 4, y: 8, width: 24, height: 18, rx: 4, fill }, bodyG);
  const face = s('g', {}, bodyG);
  const eyeL = s('circle', { cx: 11.5, cy: 16.5, r: 1.25, fill: stroke, stroke: 'none' }, face);
  const eyeR = s('circle', { cx: 21.35, cy: 16.5, r: 1.25, fill: stroke, stroke: 'none' }, face);
  const wink = s('path', { d: 'M19 17c1.5-1.8 3.2-1.8 4.7 0' }, face);
  const feet = s('path', { d: 'M10 29l2-3m10 3-2-3' }, root);
  let spark = null;
  if (sparkles) {
    spark = s('g', { stroke: '#d7982b', 'stroke-width': 1.0, fill: '#f4c14d', opacity: 0 }, el);
    s('path', { d: 'm27.5 5.5 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z' }, spark);
    s('path', { d: 'm30.2 11.6 .5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z' }, spark);
  }
  const set = ({ wink: wk = 1, antenna: an = 0, squash = 1, look = [0, 0], blink = 0, spark: sp = 0, hop = 0 } = {}) => {
    eyeR.setAttribute('opacity', 1 - wk);
    wink.setAttribute('opacity', wk);
    const by = 1 - blink * 0.9;
    eyeL.setAttribute('transform', `translate(${look[0]} ${look[1]}) translate(11.5 16.5) scale(1 ${by}) translate(-11.5 -16.5)`);
    eyeR.setAttribute('transform', `translate(${look[0]} ${look[1]}) translate(21.35 16.5) scale(1 ${by}) translate(-21.35 -16.5)`);
    wink.setAttribute('transform', `translate(${look[0]} ${look[1]})`);
    antenna.setAttribute('transform', `rotate(${an} 16 8)`);
    bodyG.setAttribute('transform', `translate(0 ${-hop}) translate(16 26) scale(${1 / Math.sqrt(squash)} ${squash}) translate(-16 -26)`);
    if (spark) { spark.setAttribute('opacity', sp); spark.setAttribute('transform', `translate(29 9) scale(${0.6 + 0.4 * sp}) translate(-29 -9)`); }
  };
  set({});
  return { el, set, parts: { body, antenna, eyeL, eyeR, wink, feet, face, sparkles: spark } };
}

// ---------------------------------------------------------------- little people
const BODY = 'M-35 52c0-33 12.5-50 35-50s35 17 35 50q0 7-7.5 7h-55Q-35 59-35 52Z';
const CROWN = 'M-14-61-18-75-6-69 0-78 6-69 18-75 14-61Z';
const EYE_KINDS = ['open', 'happy', 'closed', 'wide', 'lid', 'x', 'squeeze', 'dot', 'spark'];

function eye(parent, cx, side, color) {
  const g = s('g', { transform: `translate(${cx} -31)` }, parent);
  const inner = s('g', {}, g);
  const k = {};
  k.open = s('ellipse', { rx: 2.6, ry: 3.3, fill: C.ink }, inner);
  k.happy = s('path', { d: 'M-3.2 1.4Q0-3.6 3.2 1.4', fill: 'none', stroke: C.ink, 'stroke-width': 2, 'stroke-linecap': 'round' }, inner);
  k.closed = s('path', { d: 'M-3.2-0.6Q0 2.6 3.2-0.6', fill: 'none', stroke: C.ink, 'stroke-width': 2, 'stroke-linecap': 'round' }, inner);
  const wide = s('g', {}, inner); k.wide = wide;
  s('ellipse', { rx: 3.5, ry: 4.4, fill: C.ink }, wide);
  s('circle', { cx: -1.1 * side, cy: -1.6, r: 1.2, fill: '#fff' }, wide);
  const lid = s('g', {}, inner); k.lid = lid;
  s('ellipse', { rx: 2.6, ry: 3.3, fill: C.ink }, lid);
  const lidRect = s('rect', { x: -5, y: -9, width: 10, height: 8, fill: color }, lid);
  k.x = s('path', { d: 'M-2.8-2.8 2.8 2.8M2.8-2.8-2.8 2.8', stroke: C.ink, 'stroke-width': 1.9, 'stroke-linecap': 'round' }, inner);
  k.squeeze = s('path', { d: side < 0 ? 'M-2.8-2.8 2.4 0-2.8 2.8' : 'M2.8-2.8-2.4 0 2.8 2.8', fill: 'none', stroke: C.ink, 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, inner);
  k.dot = s('circle', { r: 1.5, fill: C.ink }, inner);
  const spark = s('g', {}, inner); k.spark = spark;
  s('ellipse', { rx: 3.2, ry: 4.1, fill: C.ink }, spark);
  s('circle', { cx: -1 * side, cy: -1.5, r: 1.3, fill: '#fff' }, spark);
  s('circle', { cx: 1.1 * side, cy: 1.6, r: 0.6, fill: '#fff' }, spark);
  return { g, inner, k, lidRect, side };
}

/**
 * A little person (brand characters/*.svg). Local origin = bottom centre of the body (feet on the ground).
 * set({x,y,s,sq,lean,tilt,bob,look:[dx,dy],eyes,blink,lid,blush,o})
 */
export function person({ color = C.green, crown = false, tag = null, tagColor = null } = {}) {
  const root = s('g', {});
  const squash = s('g', {}, root);
  const lean = s('g', {}, squash);
  const off = s('g', { transform: 'translate(0 -59)' }, lean);
  const shadow = s('ellipse', { cx: 0, cy: 59, rx: 34, ry: 6, fill: '#000', opacity: 0 }, off);
  const body = s('path', { d: BODY, fill: color }, off);
  const head = s('g', {}, off);
  const headC = s('circle', { cx: 0, cy: -31, r: 20, fill: color }, head);
  const blush = s('g', { opacity: 0 }, head);
  s('ellipse', { cx: -12, cy: -24.5, rx: 3.6, ry: 2, fill: '#ff8fa3' }, blush);
  s('ellipse', { cx: 12, cy: -24.5, rx: 3.6, ry: 2, fill: '#ff8fa3' }, blush);
  const eyes = s('g', {}, head);
  const L = eye(eyes, -7, -1, color), R = eye(eyes, 7, 1, color);
  let crownEl = null;
  if (crown) crownEl = s('path', { d: CROWN, fill: C.yellow, stroke: C.ink, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, head);
  let tagEl = null;
  if (tag) {
    tagEl = s('g', { transform: 'translate(0 74)' }, off);
    const w = 16 + tag.length * 15;
    s('rect', { x: -w / 2, y: -13, width: w, height: 26, rx: 13, fill: tagColor || '#fff', stroke: C.ink, 'stroke-width': 2.2 }, tagEl);
    s('text', { y: 6, 'text-anchor': 'middle', 'font-family': 'Noto Sans SC', 'font-weight': 800, 'font-size': 15, fill: C.ink, text: tag }, tagEl);
  }
  let cur = '';
  const set = (p = {}) => {
    const x = p.x || 0, y = p.y || 0, sc = p.s ?? 1;
    root.setAttribute('transform', `translate(${x} ${y}) scale(${sc})`);
    if (p.o !== undefined) root.setAttribute('opacity', p.o);
    const sq = p.sq ?? 1; // >1 stretch, <1 squash (volume-preserving)
    squash.setAttribute('transform', `scale(${1 / Math.sqrt(sq)} ${sq})`);
    lean.setAttribute('transform', `rotate(${p.lean || 0})`);
    head.setAttribute('transform', `translate(${p.hx || 0} ${p.bob || 0}) rotate(${p.tilt || 0} 0 -31)`);
    const kind = p.eyes || 'open';
    if (kind !== cur) {
      for (const e of [L, R]) for (const k of EYE_KINDS) e.k[k].style.display = k === kind ? '' : 'none';
      cur = kind;
    }
    const look = p.look || [0, 0], bl = 1 - (p.blink || 0) * 0.92;
    for (const e of [L, R]) {
      e.inner.setAttribute('transform', `translate(${look[0]} ${look[1]}) scale(${p.eyeScale || 1} ${(p.eyeScale || 1) * bl})`);
      if (kind === 'lid') {
        // lid: 0 = open, 1 = shut; lidAngle tilts toward the nose for a determined look
        const amt = p.lid ?? 0.5, ang = (p.lidAngle || 0) * -e.side;
        e.lidRect.setAttribute('transform', `rotate(${ang}) translate(0 ${lerp(-4.2, 2.6, amt)})`);
      }
    }
    blush.setAttribute('opacity', p.blush || 0);
    shadow.setAttribute('opacity', p.shadow || 0);
  };
  set({});
  return { el: root, set, parts: { body, head, headC, crown: crownEl, tag: tagEl, eyes } };
}

/** Wrap an SVG group in a standalone <svg> sized in px; viewBox centred on the character's feet. */
export function svgBox(w, h, vb, parent, style) {
  const el = s('svg', { width: w, height: h, viewBox: vb, overflow: 'visible' }, parent);
  if (style) Object.assign(el.style, style);
  return el;
}

// ---------------------------------------------------------------- sofa
/** The brand sofa (characters/sofa.svg). width = back width (brand default 640). Origin = top-left of the backrest. */
export function sofa({ width = 640, color = C.yellow, line = C.ink } = {}) {
  const g = s('g', {});
  const legs = [42, width - 42];
  for (let x = 42 + 520; x < width - 300; x += 520) legs.push(x);
  s('path', { d: legs.map(x => `M${x} 137v26`).join(''), fill: 'none', stroke: line, 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
  const back = s('rect', { x: 0, y: 0, width, height: 145, rx: 32, fill: color, stroke: line, 'stroke-width': 4 }, g);
  const seat = s('rect', { x: 16, y: 98, width: width - 32, height: 38, rx: 15, fill: '#00000012' }, g);
  const seam = s('path', { d: `M33 95H${width - 33}`, fill: 'none', stroke: line, 'stroke-width': 3, opacity: 0.25 }, g);
  const armL = s('rect', { x: -14, y: 55, width: 42, height: 82, rx: 18, fill: color, stroke: line, 'stroke-width': 4 }, g);
  const armR = s('rect', { x: width - 28, y: 55, width: 42, height: 82, rx: 18, fill: color, stroke: line, 'stroke-width': 4 }, g);
  return { el: g, parts: { back, seat, seam, armL, armR } };
}

// ---------------------------------------------------------------- icons & reactions
/** One of the real Piik control icons as an inline <svg>. */
export function icon(name, { size = 48, color = C.ink, sw = 2 } = {}) {
  const def = ICONS[name];
  const el = s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: def.solid ? color : 'none', stroke: def.solid ? 'none' : color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  el.style.color = color;
  el.innerHTML = def.d;
  return el;
}
export const TOMATO = '<path d="M20 11C5 3 0 31 16 34c20 5 26-30 4-23Z" fill="#e96c55"/><path d="m20 14-9-6 8 2 3-6 2 6 8-1-7 6Z" fill="#448e6b"/><path d="M10 20q-2 5 1 7" fill="none" stroke="#ffb399" stroke-width="3" stroke-linecap="round"/>';
export const POOP = '<path d="M24 5c2 7 10 7 5 13 8 1 9 7 5 10 8 8-22 9-28 3-5-5 1-9 5-10-4-5 2-8 6-9 4-1 5-4 7-7Z" fill="#997554"/><path d="M13 21q9 3 17-1M9 29q12 3 22-1" fill="none" stroke="#795b43" stroke-width="2" stroke-linecap="round"/><circle cx="18" cy="23" r="1.5" fill="#fff4dd"/><circle cx="25" cy="23" r="1.5" fill="#fff4dd"/>';
export const HEART = '<path d="M20 34C6 25 3 17 6 11c3-6 11-6 14 0 3-6 11-6 14 0 3 6 0 14-14 23Z" fill="#ff6b8b"/><path d="M10 14q-2 4 1 7" fill="none" stroke="#ffc2cf" stroke-width="3" stroke-linecap="round"/>';
export const STAR = '<path d="m20 4 4.6 10 10.9 1.2-8.1 7.4 2.3 10.7L20 27.8l-9.7 5.5 2.3-10.7-8.1-7.4L15.4 14Z" fill="#ffd05a" stroke="#d7982b" stroke-width="1.6" stroke-linejoin="round"/>';
/** Reaction glyph as an <svg> (viewBox 40×40). kind: tomato | poop | heart | star */
export function reaction(kind, size = 64) {
  const el = s('svg', { viewBox: '0 0 40 40', width: size, height: size, overflow: 'visible' });
  el.innerHTML = { tomato: TOMATO, poop: POOP, heart: HEART, star: STAR }[kind];
  return el;
}

// ---------------------------------------------------------------- graphic shapes
/** Star-burst polygon points around (0,0). */
export function burst(n = 14, r1 = 100, r2 = 60, seed = 1, jitter = 0.25) {
  const r = rng(seed), pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * TAU + (r() - 0.5) * jitter * (TAU / n / 2);
    const rr = (i % 2 ? r2 : r1) * (1 + (r() - 0.5) * jitter);
    pts.push(`${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`);
  }
  return pts.join(' ');
}
/** Smooth closed blob through polar points (Catmull-Rom → Bézier). */
export function blobPath(radii, cx = 0, cy = 0, rot = 0) {
  const n = radii.length, P = radii.map((r, i) => {
    const a = (i / n) * TAU + rot;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}
/** Tomato-style splat: lumpy core with a few spikes plus satellite droplets. Returns {core, drops:[[x,y,r]]}. */
export function splat(seed = 1, R = 100) {
  const r = rng(seed), n = 22, radii = [];
  for (let i = 0; i < n; i++) radii.push(R * (r() < 0.22 ? 1.25 + r() * 0.45 : 0.78 + r() * 0.22));
  const drops = [];
  for (let i = 0; i < 9; i++) {
    const a = r() * TAU, d = R * (1.35 + r() * 0.9);
    drops.push([Math.cos(a) * d, Math.sin(a) * d, R * (0.05 + r() * 0.12)]);
  }
  return { core: blobPath(radii, 0, 0, r()), drops };
}
/** Jagged (torn/spiky) rectangle polygon for comic panels and burst boxes. */
export function jagRect(w, h, amp = 10, step = 40, seed = 3) {
  const r = rng(seed), pts = [];
  const edge = (x0, y0, x1, y1, nx, ny) => {
    const len = Math.hypot(x1 - x0, y1 - y0), k = Math.max(2, Math.round(len / step));
    for (let i = 0; i < k; i++) {
      const t = i / k, o = (i % 2 ? 1 : -0.3) * amp * (0.5 + r());
      pts.push(`${(x0 + (x1 - x0) * t + nx * o).toFixed(1)},${(y0 + (y1 - y0) * t + ny * o).toFixed(1)}`);
    }
  };
  edge(0, 0, w, 0, 0, -1); edge(w, 0, w, h, 1, 0); edge(w, h, 0, h, 0, 1); edge(0, h, 0, 0, -1, 0);
  return pts.join(' ');
}
/** Radial speed-line wedges (manga focus lines) as one SVG path; centred at (0,0). */
export function focusLines(n = 90, rIn = 300, rOut = 1400, seed = 5, width = 0.012) {
  const r = rng(seed);
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + r() * 0.05, w = width * (0.4 + r() * 1.2), ri = rIn * (0.75 + r() * 0.6);
    const x1 = Math.cos(a - w) * rOut, y1 = Math.sin(a - w) * rOut, x2 = Math.cos(a + w) * rOut, y2 = Math.sin(a + w) * rOut;
    d += `M${(Math.cos(a) * ri).toFixed(1)} ${(Math.sin(a) * ri).toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}Z`;
  }
  return d;
}
/** Parallel speed lines (horizontal streaks) within w×h. */
export function streaks(n, w, h, seed = 9, minL = 0.15, maxL = 0.6, thick = 4) {
  const r = rng(seed);
  let d = '';
  for (let i = 0; i < n; i++) {
    const y = r() * h, L = w * (minL + r() * (maxL - minL)), x = r() * (w - L), t = thick * (0.4 + r());
    d += `M${x.toFixed(0)} ${y.toFixed(1)}h${L.toFixed(0)}l${(-t * 3).toFixed(1)} ${t.toFixed(1)}h${(-L + t * 6).toFixed(0)}Z`;
  }
  return d;
}
/** Simple bar-code as SVG rects in a group (Industrial microdetail). */
export function barcode(parent, { x = 0, y = 0, w = 160, h = 34, seed = 7, color = C.ink } = {}) {
  const r = rng(seed), g = s('g', { transform: `translate(${x} ${y})`, fill: color }, parent);
  let cx = 0;
  while (cx < w) {
    const bw = 1 + Math.floor(r() * 4), gap = 1 + Math.floor(r() * 3);
    if (cx + bw > w) break;
    s('rect', { x: cx, y: 0, width: bw, height: h }, g);
    cx += bw + gap;
  }
  return g;
}

// ---------------------------------------------------------------- CSS pattern helpers
export const halftone = (color = 'rgba(0,0,0,.25)', size = 14, dot = 30) =>
  `radial-gradient(circle at center, ${color} ${dot}%, transparent ${dot + 2}%) 0 0 / ${size}px ${size}px`;
export const stripes = (a, b, w = 24, ang = -45) => `repeating-linear-gradient(${ang}deg, ${a} 0 ${w}px, ${b} ${w}px ${w * 2}px)`;
export const rays = (a, b, n = 24, from = 0) => `repeating-conic-gradient(from ${from}deg, ${a} 0deg ${180 / n}deg, ${b} ${180 / n}deg ${360 / n}deg)`;
