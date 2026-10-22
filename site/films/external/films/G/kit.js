// Film G kit — the phantom-thief evidence board around the real UI: board, evidence photos (real UI cards and
// polaroids) with tape and pins, red string, comic click bursts, mission banners and tracker, callouts, VS splash,
// dossier and stamps. graphic collage language from Film A on a red/black board. Every component exposes set()/update(t).
import { h, s, T, ST, O, prog, E, clamp, lerp, rng, show, pulse, TAU } from '../../engine/core.js';
import { C, CAST, mascot, person, sofa, icon, burst, jagRect, halftone, stripes, barcode } from '../../engine/art.js';
import { ransom, TILES } from '../../engine/type.js';
import { grungeURL, paperURL } from '../../engine/tex.js';
import { FACE } from './strings.js';

export const G = {
  board: '#0e0b0d', red: '#ff3b30', red2: '#c8141e', ink: C.ink2, cream: C.cream, paper: C.paper, yellow: C.yellow,
  tape: 'rgba(246,242,232,.78)', manila: '#e9cf8f', manila2: '#d9b86c',
};
export const MONO = "'JetBrains Mono', 'Noto Sans SC', monospace";
export const HUD = "'Barlow Condensed', 'Noto Sans SC', sans-serif";
export const HAND = "'Smiley Sans', 'Noto Sans SC', sans-serif";
export const WORDMARK = px => `700 ${px}px/1 Arimo, Arial, sans-serif`;
const face = lang => FACE[lang] || FACE.zh;
/** Escape text for innerHTML templates. */
export const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- 2D pose math (world space)
/** Rotate (x, y) by r degrees. */
export const rot = (x, y, r) => {
  const a = (r * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  return { x: x * c - y * sn, y: x * sn + y * c };
};

// ---------------------------------------------------------------- the board (world background)
/** Black evidence board with red glows, halftone, Angular slashes and white marker scribbles. Static. */
export function board(parent, { x = -700, y = -600, w = 5200, hgt = 3500, lang = 'zh' } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, {
    left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px',
    background: [
      'radial-gradient(1400px 1000px at 72% 36%, rgba(214,24,34,.62), transparent 70%)',
      'radial-gradient(1200px 900px at 18% 82%, rgba(200,20,30,.42), transparent 70%)',
      `${halftone('rgba(255,59,48,.16)', 26, 26)}`,
      G.board,
    ].join(', '),
  });
  const sv = s('svg', { width: w, height: hgt, style: 'position:absolute;left:0;top:0' }, el);
  const r = rng(77);
  // big red slashes (jagged wedges) behind the evidence
  const slash = (pts, fill, o = 1) => s('polygon', { points: pts.map(p => p.join(',')).join(' '), fill, opacity: o }, sv);
  slash([[0, 2300], [1500, 1700], [1350, 1900], [2600, 1500], [2450, 1720], [3900, 1300], [3900, 1560], [2500, 2050], [2650, 1820], [1300, 2300], [1450, 2080], [0, 2700]], G.red2, 0.85);
  slash([[2700, 0], [4300, 0], [3600, 900], [3800, 860], [3200, 1500], [3300, 1100], [3050, 1180]], G.red2, 0.55);
  slash([[400, 300], [1300, 120], [1000, 420], [1700, 330], [600, 720]], '#000', 0.55);
  // marker scribbles (white, rough)
  const ink = (d, wid = 7, o = 0.75) => s('path', { d, fill: 'none', stroke: G.cream, 'stroke-width': wid, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: o }, sv);
  ink('M3760 2350c90-40 180-30 260 30M3990 2330l40 50-60 20');
  ink('M820 2900c160-60 320-60 470 10');
  ink('M4400 1300c-60 120-60 260 10 380M4360 1640l50 60 50-70', 6, 0.55);
  for (const [tx, ty, txt, sz, rt] of [[4150, 2900, '23:00', 92, -6], [880, 3010, 'ROOM 9527', 70, 3], [4520, 1240, '?!', 120, 8], [420, 1260, lang === 'en' ? 'NO APP?' : '不装 App？', 64, -8]]) {
    const t = s('text', { x: tx, y: ty, fill: G.cream, opacity: 0.72, 'font-family': '"Smiley Sans", "Noto Sans SC"', 'font-size': sz, transform: `rotate(${rt} ${tx} ${ty})` }, sv);
    t.textContent = txt;
  }
  for (let i = 0; i < 26; i++) { // stray pin holes / dust
    s('circle', { cx: r() * w, cy: r() * hgt, r: 2 + r() * 4, fill: '#000', opacity: 0.5 }, sv);
  }
  return { el };
}

// ---------------------------------------------------------------- tape + pin
function tape(parent, { x, y, w = 120, hgt = 40, r = -35 }) {
  const t = h('div', { class: 'abs' }, parent);
  Object.assign(t.style, { left: x - w / 2 + 'px', top: y - hgt / 2 + 'px', width: w + 'px', height: hgt + 'px', background: G.tape, transform: `rotate(${r}deg)`, boxShadow: '0 2px 6px rgba(0,0,0,.25)',
    clipPath: 'polygon(0 8%, 6% 0, 12% 10%, 18% 0, 24% 8%, 30% 0, 36% 8%, 42% 0, 48% 8%, 54% 0, 60% 8%, 66% 0, 72% 8%, 78% 0, 84% 8%, 90% 0, 96% 8%, 100% 2%, 100% 92%, 94% 100%, 88% 92%, 82% 100%, 76% 92%, 70% 100%, 64% 92%, 58% 100%, 52% 92%, 46% 100%, 40% 92%, 34% 100%, 28% 92%, 22% 100%, 16% 92%, 10% 100%, 4% 92%, 0 100%)' });
  return t;
}
function pin(parent, { x, y, color = G.red, size = 34 }) {
  const p = s('svg', { width: size * 2, height: size * 2, viewBox: '-20 -20 40 40', style: `position:absolute;left:${x - size}px;top:${y - size}px;overflow:visible` }, parent);
  s('ellipse', { cx: 5, cy: 8, rx: 13, ry: 9, fill: '#000', opacity: 0.45 }, p);
  s('circle', { r: 12, fill: color, stroke: C.ink2, 'stroke-width': 2.5 }, p);
  s('circle', { cx: -4, cy: -4, r: 4, fill: '#fff', opacity: 0.75 }, p);
  return p;
}

// ---------------------------------------------------------------- evidence photo around a real UI
/**
 * Evidence photo: white print border + thick ink outline + hard shadow, tape, pin and an evidence tag around a
 * realUI() box. kind 'app' (the host's Piik App) or 'browser' (a friend's browser).
 * Pose: centre (cx, cy), rotation r (deg), scale s. toWorld(ux, uy) maps UI px to world px.
 */
export function photoCard(parent, ui, { kind = 'app', title = '', addr = '', tag = '', lang = 'zh', shadow = 'rgba(0,0,0,.62)' } = {}) {
  const PAD = 18, BAR = kind === 'browser' ? 56 : 46;
  const W = 1100 + PAD * 2, H = 740 + BAR + PAD + 14;
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: W + 'px', height: H + 'px', transformOrigin: '50% 50%', background: G.paper, boxShadow: `0 0 0 7px ${C.ink2}, 22px 26px 0 7px ${shadow}` });
  const bar = h('div', { class: 'abs' }, el);
  Object.assign(bar.style, { left: PAD + 'px', top: '10px', width: 1100 + 'px', height: BAR - 10 + 'px', display: 'flex', alignItems: 'center', gap: '12px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '10px 10px 0 0', font: `800 20px/1 ${lang === 'en' ? 'Nunito, "Noto Sans SC"' : '"Noto Sans SC"'}` });
  if (kind === 'app') {
    Object.assign(bar.style, { background: C.ink2, color: G.cream });
    const m = mascot({ stroke: G.cream, size: 26, sparkles: false });
    bar.appendChild(m.el);
    h('span', { text: 'Piik' }, bar);
    const sub = h('span', { text: '· ' + title }, bar);
    sub.style.cssText = 'font-weight:600;opacity:.6';
  } else {
    Object.assign(bar.style, { background: '#e6eaf0', color: C.ink });
    ['#ff6b5e', '#ffc542', '#3fc46b'].forEach(c => { const d = h('i', {}, bar); Object.assign(d.style, { width: '13px', height: '13px', borderRadius: '50%', background: c, display: 'block', flex: 'none' }); });
    const pill = h('div', {}, bar);
    Object.assign(pill.style, { marginLeft: '10px', flex: '1', height: '30px', borderRadius: '15px', background: '#fff', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px', font: `700 17px/1 ${MONO}`, color: C.ink });
    pill.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2fa66a" stroke-width="2.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>${esc(addr)}</span>`;
    const who = h('div', { text: title }, bar);
    Object.assign(who.style, { padding: '6px 12px', borderRadius: '13px', background: C.ink2, color: G.cream, font: `800 16px/1 ${lang === 'en' ? 'Nunito, "Noto Sans SC"' : '"Noto Sans SC"'}` });
  }
  const body = h('div', { class: 'abs' }, el);
  Object.assign(body.style, { left: PAD + 'px', top: BAR + 'px', width: '1100px', height: '740px', overflow: 'hidden', background: '#f3f5f8' });
  body.appendChild(ui.el);
  // evidence dressing: tape on the top corners, a red pin, an evidence tag hanging off the bottom-left corner
  tape(el, { x: 40, y: 8, r: -32 });
  tape(el, { x: W - 40, y: 8, r: 32 });
  pin(el, { x: W / 2, y: 4 });
  let tg = null;
  if (tag) {
    tg = h('div', { class: 'abs nowrap', text: tag }, el);
    Object.assign(tg.style, { left: '-26px', top: H - 30 + 'px', padding: '10px 18px 11px', background: G.yellow, color: C.ink2, font: `700 22px/1 ${MONO}`, letterSpacing: '.06em', border: `4px solid ${C.ink2}`, transform: 'rotate(-4deg)', boxShadow: `6px 7px 0 ${C.ink2}` });
  }
  // overlay in card space (not clipped by the UI box): stamps, underline marks
  const fx = h('div', { class: 'abs' }, el);
  Object.assign(fx.style, { left: PAD + 'px', top: BAR + 'px', width: '1100px', height: '740px', pointerEvents: 'none' });
  let pose = { cx: 0, cy: 0, r: 0, s: 1 };
  const set = (p) => {
    pose = { cx: p.cx ?? pose.cx, cy: p.cy ?? pose.cy, r: p.r ?? pose.r, s: p.s ?? pose.s };
    el.style.transform = `translate(${(pose.cx - W / 2).toFixed(2)}px, ${(pose.cy - H / 2).toFixed(2)}px) rotate(${pose.r.toFixed(3)}deg) scale(${pose.s.toFixed(4)})`;
    if (p.o !== undefined) { el.style.opacity = clamp(p.o); show(el, p.o > 0.002); }
  };
  /** UI px → world px for the current pose. */
  const toWorld = (ux, uy) => {
    const v = rot((PAD + ux - W / 2) * pose.s, (BAR + uy - H / 2) * pose.s, pose.r);
    return { x: pose.cx + v.x, y: pose.cy + v.y };
  };
  /** Card-local px (0..W, 0..H) → world px. */
  const localToWorld = (lx, ly) => {
    const v = rot((lx - W / 2) * pose.s, (ly - H / 2) * pose.s, pose.r);
    return { x: pose.cx + v.x, y: pose.cy + v.y };
  };
  return { el, set, toWorld, localToWorld, get pose() { return pose; }, fx, tag: tg, W, H, PAD, BAR };
}

// ---------------------------------------------------------------- polaroid (illustrated evidence)
/** Small instant photo with an SVG scene and a hand-written caption. art(svg, w, h) draws into the photo. */
export function polaroid(parent, { w = 520, hgt = 470, caption = '', sub = '', lang = 'zh', art = null, bg = '#2a3442' }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: hgt + 'px', transformOrigin: '50% 50%', background: G.paper, boxShadow: `0 0 0 6px ${C.ink2}, 16px 20px 0 6px rgba(0,0,0,.6)` });
  const ph = h('div', { class: 'abs' }, el);
  const pw = w - 36, phh = hgt - 120;
  Object.assign(ph.style, { left: '18px', top: '18px', width: pw + 'px', height: phh + 'px', overflow: 'hidden', background: bg });
  const sv = s('svg', { width: pw, height: phh, viewBox: `0 0 ${pw} ${phh}`, style: 'position:absolute;left:0;top:0' }, ph);
  const parts = art ? art(sv, pw, phh) : {};
  const cap = h('div', { class: 'abs nowrap', text: caption }, el);
  Object.assign(cap.style, { left: '26px', top: hgt - 92 + 'px', font: `400 ${lang === 'en' ? 46 : 52}px/1 ${HAND}`, color: C.ink2, transform: 'rotate(-2deg)' });
  const sb = h('div', { class: 'abs nowrap', text: sub }, el);
  Object.assign(sb.style, { left: '30px', top: '30px', padding: '6px 12px 7px', background: G.red, color: '#fff', font: `700 22px/1 ${MONO}`, letterSpacing: '.08em', transform: 'rotate(-3deg)', display: sub ? '' : 'none' });
  tape(el, { x: w / 2, y: 2, w: 150, hgt: 44, r: -4 });
  let pose = { cx: 0, cy: 0, r: 0, s: 1 };
  const set = (p) => {
    pose = { cx: p.cx ?? pose.cx, cy: p.cy ?? pose.cy, r: p.r ?? pose.r, s: p.s ?? pose.s };
    el.style.transform = `translate(${(pose.cx - w / 2).toFixed(2)}px, ${(pose.cy - hgt / 2).toFixed(2)}px) rotate(${pose.r.toFixed(3)}deg) scale(${pose.s.toFixed(4)})`;
    if (p.o !== undefined) { el.style.opacity = clamp(p.o); show(el, p.o > 0.002); }
  };
  const localToWorld = (lx, ly) => {
    const v = rot((lx - w / 2) * pose.s, (ly - hgt / 2) * pose.s, pose.r);
    return { x: pose.cx + v.x, y: pose.cy + v.y };
  };
  return { el, set, localToWorld, get pose() { return pose; }, parts, W: w, H: hgt, photo: ph };
}

// ---------------------------------------------------------------- red string
/** Sagging red string between two world points; draws on from p0. set(p0, p1, {k, sag, o, glow}). */
export function redString(svg) {
  const g = s('g', {}, svg);
  const shadow = s('path', { fill: 'none', stroke: '#000', 'stroke-width': 9, 'stroke-linecap': 'round', opacity: 0.45 }, g);
  const glow = s('path', { fill: 'none', stroke: G.red, 'stroke-width': 22, 'stroke-linecap': 'round', opacity: 0 }, g);
  const main = s('path', { fill: 'none', stroke: G.red, 'stroke-width': 7, 'stroke-linecap': 'round' }, g);
  const hi = s('path', { fill: 'none', stroke: '#ff9a8a', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.8 }, g);
  const set = (p0, p1, { k = 1, sag = 120, o = 1, glow: gl = 0 } = {}) => {
    show(g, k > 0.001 && o > 0.001);
    if (k <= 0.001 || o <= 0.001) return null;
    const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2 + sag;
    // quadratic from p0 to p1, cut at parameter k (de Casteljau) so the string "travels" without measuring paths
    const qx = lerp(p0.x, cx, k), qy = lerp(p0.y, cy, k), rx = lerp(cx, p1.x, k), ry = lerp(cy, p1.y, k);
    const ex = lerp(qx, rx, k), ey = lerp(qy, ry, k);
    const d = `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}Q${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    for (const p of [shadow, glow, main, hi]) p.setAttribute('d', d);
    shadow.setAttribute('transform', 'translate(6 9)');
    glow.setAttribute('opacity', (0.35 * gl).toFixed(3));
    g.setAttribute('opacity', o.toFixed(3));
    return { x: ex, y: ey };
  };
  /** Point at parameter u on the full string (for things riding it). */
  const at = (p0, p1, u, sag = 120) => {
    const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2 + sag, v = 1 - u;
    return { x: v * v * p0.x + 2 * v * u * cx + u * u * p1.x, y: v * v * p0.y + 2 * v * u * cy + u * u * p1.y };
  };
  return { g, set, at };
}

// ---------------------------------------------------------------- comic click burst (screen space)
/** Jagged white burst with ink outline and a red word, popping at t0 for ~0.6 s. set(t, t0, {x, y}). */
export function clickBurst(parent, { text, lang = 'zh', seed = 3, size = 1 }) {
  const el = h('div', { class: 'abs' }, parent);
  const sv = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, el);
  const lines = s('g', {}, sv);
  const rays = [...Array(10)].map(() => s('path', { stroke: C.ink2, 'stroke-width': 9, 'stroke-linecap': 'round', fill: 'none' }, lines));
  const g = s('g', {}, sv);
  s('polygon', { points: burst(13, 118 * size, 78 * size, seed, 0.35), fill: C.ink2, transform: 'translate(10 12)' }, g);
  s('polygon', { points: burst(13, 118 * size, 78 * size, seed, 0.35), fill: '#fff', stroke: C.ink2, 'stroke-width': 7, 'stroke-linejoin': 'round' }, g);
  const tx = h('div', { class: 'abs nowrap', text }, el);
  const fs = (lang === 'en' ? 54 : 50) * size;
  Object.assign(tx.style, { left: '0', top: '0', font: lang === 'en' ? `400 ${fs}px/1 Anton` : `900 ${fs}px/1 "Noto Sans SC"`, color: G.red, WebkitTextStroke: `2px ${C.ink2}`, transformOrigin: '50% 50%' });
  const set = (t, t0, p) => {
    const q = (t - t0) / 0.5, on = q >= 0 && q < 1;
    show(el, on);
    if (!on) return;
    const k = E.outBack(clamp(q / 0.22)), out = E.in3(prog(0.7, 1, q));
    T(el, { x: p.x, y: p.y });
    ST(g, { s: lerp(0.2, 1, k) * (1 - out * 0.5), r: -8 + (1 - k) * -30 });
    g.setAttribute('opacity', (1 - out).toFixed(3));
    rays.forEach((ry, i) => {
      const a = (i / rays.length) * TAU + 0.2, r0 = (90 + E.outExpo(q) * 80) * size, r1 = r0 + 40 * size * (1 - q);
      ry.setAttribute('d', `M${(Math.cos(a) * r0).toFixed(1)} ${(Math.sin(a) * r0).toFixed(1)}L${(Math.cos(a) * r1).toFixed(1)} ${(Math.sin(a) * r1).toFixed(1)}`);
      ry.setAttribute('opacity', (1 - q).toFixed(3));
    });
    const w = tx.offsetWidth || 120, hh = tx.offsetHeight || 50;
    T(tx, { x: -w / 2, y: -hh / 2 - 2, s: lerp(0.3, 1, k) * (1 - out * 0.4), r: -8, o: 1 - out });
  };
  return { el, set };
}

// ---------------------------------------------------------------- mission banner (screen space)
/** Big skewed black band with "MISSION 0X" + ransom title; shrinks to a compact tag after `hold`. */
export function missionBanner(parent, { no, sub = '', title, lang = 'zh', seed = 5 }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { transformOrigin: '0% 0%' });
  const band = h('div', { class: 'abs' }, el);
  Object.assign(band.style, { left: '-80px', top: '0', width: '1120px', height: '210px', background: C.ink2, transform: 'skewX(-14deg)', boxShadow: `14px 14px 0 ${G.red}`, borderBottom: `6px solid ${G.cream}` });
  const lab = h('div', { class: 'abs nowrap' }, el);
  Object.assign(lab.style, { left: '48px', top: '22px', display: 'flex', alignItems: 'baseline', gap: '18px' });
  lab.innerHTML = `<span style="font:${lang === 'en' ? '400 50px/1 Anton' : "900 50px/1 'Noto Sans SC'"};color:${G.red};letter-spacing:.04em">${esc(no)}</span>` + (sub ? `<span style="font:400 30px/1 Anton;color:${G.cream};opacity:.8;letter-spacing:.12em">${esc(sub)}</span>` : '');
  const size = lang === 'en' ? (title.length > 3 ? 76 : 88) : 96;
  const r = ransom(el, title, { size, seed, tilt: 6, punctColor: G.cream });
  T(r.el, { x: 46, y: 90 });
  const set = (t, t0, t1, hold = 1.4) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const pin = E.outExpo(prog(t0, t0 + 0.2, t)), mini = E.io3(prog(t0 + hold, t0 + hold + 0.35, t)), out = E.in3(prog(t1 - 0.2, t1, t));
    T(el, { x: lerp(-1300, 54, pin) - out * 1300, y: 48, s: lerp(1, 0.5, mini), ox: '0%', oy: '0%' });
    r.chars.forEach((c, i) => {
      const k = E.outBack(prog(t0 + 0.08 + i * 0.035, t0 + 0.26 + i * 0.035, t));
      c.el.style.transform = `rotate(${(c.rot + (1 - k) * (i % 2 ? 25 : -25)).toFixed(2)}deg) scale(${(t < t0 + 0.08 + i * 0.035 ? 0 : lerp(2, 1, k)).toFixed(3)})`;
    });
  };
  return { el, set };
}

// ---------------------------------------------------------------- mission tracker (screen space)
/** Five skewed tags top-right: current one expanded with its label, cleared ones get a red check. */
export function tracker(parent, { items, lang = 'zh' }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { display: 'flex', gap: '10px', alignItems: 'center' });
  const tags = items.map((it, i) => {
    const d = h('div', { class: 'nowrap' }, el);
    Object.assign(d.style, { position: 'relative', display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px 9px', border: `4px solid ${G.cream}`, background: C.ink2, color: G.cream, transform: 'skewX(-12deg)', font: `400 28px/1 Anton` });
    const n = h('span', { text: String(i + 1).padStart(2, '0') }, d);
    const lb = h('span', { text: it }, d);
    lb.style.font = lang === 'en' ? '400 26px/1 Anton' : '900 24px/1 "Noto Sans SC"';
    const ck = s('svg', { width: 54, height: 46, viewBox: '0 0 54 46', style: 'position:absolute;right:-14px;top:-18px;overflow:visible' }, d);
    const path = s('path', { d: 'M6 24 L20 38 L48 6', fill: 'none', stroke: G.red, 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': 70, 'stroke-dashoffset': 70 }, ck);
    return { d, n, lb, path };
  });
  /** idx = current mission (0-based, -1 none); cleared[i] = time mission i was ticked. */
  const set = (t, idx, cleared, pIn = 1) => {
    show(el, pIn > 0.002);
    el.style.opacity = pIn;
    tags.forEach((g, i) => {
      const cur = i === idx, done = cleared[i] !== undefined && t >= cleared[i];
      g.d.style.background = cur ? G.red : C.ink2;
      g.d.style.borderColor = cur ? C.ink2 : G.cream;
      g.d.style.color = cur ? '#fff' : G.cream;
      g.d.style.opacity = cur || done ? 1 : 0.6;
      show(g.lb, cur);
      const k = done ? E.out3(prog(cleared[i], cleared[i] + 0.18, t)) : 0;
      g.path.setAttribute('stroke-dashoffset', (70 * (1 - k)).toFixed(1));
    });
  };
  return { el, set };
}

// ---------------------------------------------------------------- callout (screen space)
/** A-style microtype callout: cream box with red edge + leader line to an anchor. set(t, t0, t1, {x, y, ax, ay}). */
export function callout(parent, { main, sub = '', lang = 'zh' }) {
  const el = h('div', { class: 'abs' }, parent);
  const sv = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, el);
  const line = s('path', { fill: 'none', stroke: G.cream, 'stroke-width': 4 }, sv);
  const dot = s('circle', { r: 10, fill: G.red, stroke: G.cream, 'stroke-width': 4 }, sv);
  const box = h('div', { class: 'abs nowrap' }, el);
  Object.assign(box.style, { display: 'flex', alignItems: 'baseline', gap: '12px', padding: '10px 18px 12px', background: G.cream, color: C.ink2, borderLeft: `12px solid ${G.red}`, boxShadow: `8px 8px 0 ${C.ink2}`, transformOrigin: '0% 50%' });
  box.innerHTML = `<b style="font:${lang === 'en' ? '400 38px/1 Anton;letter-spacing:.02em' : "900 36px/1 'Noto Sans SC'"}">${esc(main)}</b>` + (sub ? `<i style="font:800 20px/1 ${HUD};letter-spacing:.18em;font-style:normal;color:${G.red2}">${esc(sub)}</i>` : '');
  const set = (t, t0, t1, p) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const a = E.out3(prog(t0, t0 + 0.2, t)), b = E.outBack(prog(t0 + 0.1, t0 + 0.3, t)), q = prog(t1 - 0.15, t1, t);
    const ex = lerp(p.ax, p.x, a), ey = lerp(p.ay, p.y + 26, a);
    line.setAttribute('d', `M${p.ax.toFixed(1)} ${p.ay.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}`);
    dot.setAttribute('cx', p.ax.toFixed(1)); dot.setAttribute('cy', p.ay.toFixed(1));
    dot.setAttribute('r', (10 * E.outBack(prog(t0, t0 + 0.12, t))).toFixed(2));
    T(box, { x: p.x, y: p.y, sx: b, o: 1 - q });
    el.style.opacity = (1 - q).toFixed(3);
  };
  return { el, set };
}

// ---------------------------------------------------------------- dialog plate (screen space)
/** Angular dialog: skewed plate, tilted name tag, typewriter line + optional small second-language line. */
export function dialog(parent, { who, name, tag = '', main, sub = '', x, y, w = 820, hgt = 170, lang = 'zh' }) {
  const ch = CAST[who];
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { transformOrigin: '0% 100%' });
  const plate = h('div', { class: 'abs' }, el);
  Object.assign(plate.style, { width: w + 'px', height: hgt + 'px', background: C.ink2, border: `6px solid ${G.cream}`, boxShadow: `14px 14px 0 ${G.red}, 14px 14px 0 6px ${C.ink2}`, transform: 'skewX(-12deg)' });
  const tl = s('svg', { width: 120, height: 90, style: `position:absolute;left:70px;top:${hgt - 4}px` }, el);
  s('path', { d: 'M8 0 L70 0 L20 80Z', fill: C.ink2, stroke: G.cream, 'stroke-width': 6, 'stroke-linejoin': 'round' }, tl);
  s('rect', { x: 4, y: -10, width: 112, height: 14, fill: C.ink2 }, tl);
  const nm = h('div', { class: 'abs nowrap', html: `${name}${tag ? `<small style="font:600 20px/1 ${HUD};letter-spacing:.14em;margin-left:10px;vertical-align:middle">${tag}</small>` : ''}` }, el);
  Object.assign(nm.style, { left: '-28px', top: '-52px', padding: '6px 22px 8px', background: ch.color, color: C.ink, border: `5px solid ${C.ink2}`, font: lang === 'en' ? '400 40px/1 Anton' : '900 40px/1 "Noto Sans SC"', transform: 'rotate(-5deg)' });
  const zl = h('div', { class: 'abs nowrap' }, el);
  Object.assign(zl.style, { left: '58px', top: sub ? '34px' : (hgt - 62) / 2 + 'px', font: lang === 'en' ? '400 60px/1.05 Anton' : '900 58px/1.1 "Noto Sans SC"', color: G.cream, letterSpacing: lang === 'en' ? '.02em' : '0' });
  const spans = [...main].map(c => h('span', { text: c }, zl));
  const rate = Math.max(16, spans.length * 1.8);
  const el2 = h('div', { class: 'abs nowrap', text: sub }, el);
  Object.assign(el2.style, { left: '64px', top: hgt - 56 + 'px', font: `600 26px/1 ${HUD}`, letterSpacing: '.16em', color: G.yellow, textTransform: 'uppercase', display: sub ? '' : 'none' });
  const set = (t, t0, t1) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const pin = E.outBack(prog(t0, t0 + 0.2, t)), pout = E.in3(prog(t1 - 0.12, t1, t));
    T(el, { x: x - pout * 60, y: y + (1 - pin) * 40, s: lerp(0.7, 1, pin) * (1 - pout * 0.1), r: (1 - pin) * -6, o: Math.min(1, pin * 1.5) * (1 - pout), ox: '0%', oy: '100%' });
    const n = Math.floor((t - t0 - 0.06) * rate);
    spans.forEach((sp, i) => { sp.style.opacity = i <= n ? 1 : 0; });
    el2.style.opacity = clamp((t - t0 - 0.25) * 4);
    nm.style.transform = `rotate(${-5 + (1 - pin) * -12}deg) scale(${lerp(1.4, 1, pin)})`;
  };
  return { el, set };
}

// ---------------------------------------------------------------- stamp (grunge rubber stamp)
/**
 * Rubber stamp block: bordered text with a grunge ink mask, slams from 2.6x at t0. set(t, t0, t1, {x, y}) (x, y = centre).
 * plate: optional solid backing (unmasked) so the stamp stays readable over a busy UI; grunge: false for a clean label.
 */
export function stamp(parent, { main, sub = '', color = G.red, size = 74, rot: rt = -9, lang = 'zh', plate = null, grunge = true }) {
  const el = h('div', { class: 'abs nowrap' }, parent);
  Object.assign(el.style, { transformOrigin: '50% 50%' });
  const back = plate ? h('div', { class: 'abs' }, el) : null;
  const ink = h('div', { class: 'nowrap' }, el);
  ink.innerHTML = `<div style="font:${lang === 'en' ? `400 ${Math.round(size * 1.05)}px/1 Anton;letter-spacing:.02em` : `900 ${size}px/1 'Noto Sans SC'`}">${esc(main)}</div>` + (sub ? `<div style="font:800 ${Math.round(size * 0.32)}px/1.2 ${HUD};letter-spacing:.3em;text-align:center;margin-top:6px">${esc(sub)}</div>` : '');
  Object.assign(ink.style, { position: 'relative', padding: `${size * 0.14}px ${size * 0.4}px ${size * 0.18}px`, border: `${Math.max(6, size * 0.13)}px solid ${color}`, color, borderRadius: `${size * 0.18}px`, textAlign: 'center' });
  if (grunge) Object.assign(ink.style, { WebkitMaskImage: `url(${grungeURL()})`, WebkitMaskSize: '600px', maskImage: `url(${grungeURL()})`, maskSize: '600px' });
  if (back) Object.assign(back.style, { left: '-10px', top: '-10px', right: '-10px', bottom: '-10px', background: plate, borderRadius: `${size * 0.22}px`, boxShadow: `8px 9px 0 ${C.ink2}` });
  const set = (t, t0, t1 = 1e9, p = { x: 0, y: 0 }) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const k = prog(t0, t0 + 0.11, t);
    const w = el.offsetWidth || 400, hh = el.offsetHeight || 120;
    const fit = p.maxW ? Math.min(1, p.maxW / w) : 1; // long labels shrink to fit their slot
    T(el, { x: p.x - w / 2, y: p.y - hh / 2, s: lerp(2.6, 1, E.in3(k)) * (p.s ?? 1) * fit, r: rt + (p.r ?? 0), o: Math.min(1, k * 3) * (1 - prog(t1 - 0.12, t1, t)) });
  };
  return { el, set };
}

// ---------------------------------------------------------------- keycaps (screen space)
export function keycaps(parent, { keys, color, label, lang = 'zh' }) {
  const el = h('div', { class: 'abs nowrap' }, parent);
  Object.assign(el.style, { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 18px', background: C.ink2, border: `5px solid ${G.cream}`, transform: 'skewX(-10deg)', boxShadow: `10px 10px 0 ${color}` });
  const caps = keys.map(k => {
    const c = h('div', { text: k }, el);
    Object.assign(c.style, { width: '58px', height: '58px', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '400 34px/1 Anton, "Noto Sans SC"', color: C.ink2, background: G.cream, border: `4px solid ${C.ink2}`, boxShadow: `0 6px 0 ${C.ink2}` });
    return c;
  });
  const lab = h('div', { text: label }, el);
  Object.assign(lab.style, { marginLeft: '6px', font: lang === 'en' ? '400 28px/1 Anton' : '900 26px/1 "Noto Sans SC"', color: G.cream, letterSpacing: lang === 'en' ? '.04em' : '0' });
  const set = (press = [0, 0]) => {
    caps.forEach((c, i) => {
      const p = press[i] || 0;
      c.style.background = p > 0.05 ? color : G.cream;
      c.style.transform = `translateY(${(p * 6).toFixed(1)}px)`;
      c.style.boxShadow = `0 ${(6 - p * 6).toFixed(1)}px 0 ${C.ink2}`;
    });
  };
  return { el, set };
}

// ---------------------------------------------------------------- sofa scene for the target polaroid
/** Draw the target: the brand sofa in a dim room, with seats that fill. Returns {seat(i).set(...)}. */
export function sofaArt(svg, w, hgt, { who = ['tuan', 'yuan', 'dian'] } = {}) {
  s('rect', { width: w, height: hgt, fill: '#26303c' }, svg);
  s('rect', { y: hgt * 0.72, width: w, height: hgt * 0.28, fill: '#1c242e' }, svg);
  const lamp = s('g', {}, svg);
  s('path', { d: `M${w * 0.86} ${hgt * 0.1}l-40 70h80Z`, fill: C.yellow, opacity: 0.9 }, lamp);
  s('rect', { x: w * 0.86 - 3, y: hgt * 0.1 + 70, width: 6, height: hgt * 0.5, fill: '#11161c' }, lamp);
  s('ellipse', { cx: w * 0.86, cy: hgt * 0.32, rx: 120, ry: 90, fill: C.yellow, opacity: 0.1 }, lamp);
  const k = 0.62, sw = 640 * k, sx = (w - sw) / 2 - 20, sy = hgt * 0.42;
  const sf = sofa({ width: 640 });
  const sg = s('g', {}, svg);
  sg.appendChild(sf.el);
  ST(sg, { x: sx, y: sy, s: k });
  const seats = who.map((key, i) => {
    const ch = CAST[key];
    const p = person({ color: ch.color, crown: !!ch.crown });
    svg.appendChild(p.el);
    const fr = [0.2, 0.5, 0.8][i];
    return { key, p, x: sx + sw * fr, y: sy + 67 * k, s: 1.9 * k };
  });
  const ring = s('ellipse', { cx: w / 2 - 20, cy: sy + 70, rx: sw * 0.62, ry: 120, fill: 'none', stroke: G.red, 'stroke-width': 10, 'stroke-dasharray': '30 14', opacity: 0.95, transform: `rotate(-4 ${w / 2} ${sy + 70})` }, svg);
  return { seats, ring };
}

/** A friend somewhere else: in bed (moon window) or on the metro (handles), holding a phone. */
export function friendArt(svg, w, hgt, { who = 'yuan', place = 'bed' } = {}) {
  const ch = CAST[who];
  if (place === 'bed') {
    s('rect', { width: w, height: hgt, fill: '#24324a' }, svg);
    s('rect', { x: w * 0.58, y: hgt * 0.1, width: w * 0.3, height: hgt * 0.36, fill: '#1a2537', stroke: '#3c4d68', 'stroke-width': 8 }, svg);
    s('path', { d: `M${w * 0.78} ${hgt * 0.18}a26 26 0 1 0 22 40a32 32 0 0 1 -22 -40Z`, fill: C.yellow }, svg);
    s('rect', { x: -10, y: hgt * 0.64, width: w + 20, height: hgt * 0.4, rx: 30, fill: '#3d5b8a' }, svg);
  } else {
    s('rect', { width: w, height: hgt, fill: '#2b2440' }, svg);
    s('rect', { y: hgt * 0.12, width: w, height: 10, fill: '#8c86a8' }, svg);
    for (const fx of [0.25, 0.5, 0.75]) s('path', { d: `M${w * fx} ${hgt * 0.13}v40l-16 26h32l-16-26`, fill: 'none', stroke: '#c9c3df', 'stroke-width': 6 }, svg);
    s('rect', { y: hgt * 0.36, width: w, height: 8, fill: C.yellow, opacity: 0.5 }, svg);
  }
  const p = person({ color: ch.color });
  svg.appendChild(p.el);
  p.set({ x: w * 0.36, y: hgt * 0.98, s: 2.3, eyes: 'open', look: [1.5, 0] });
  const ph = s('g', {}, svg);
  s('rect', { x: w * 0.46, y: hgt * 0.4, width: 44, height: 74, rx: 9, fill: '#e9f0ff', stroke: C.ink2, 'stroke-width': 5, transform: `rotate(14 ${w * 0.46} ${hgt * 0.4})` }, ph);
  return { p };
}
