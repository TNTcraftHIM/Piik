// Film F component kit: industrial sci-fi HUD primitives (hairlines, corner brackets, chamfered panels, mono labels,
// hazard stripes), the fictional gacha game, phones, party ID cards, the remote-control dialog, cursors, cast faces
// with a scream mouth, and the pieces of the rainbow reveal. Components return elements plus set()/update(t);
// everything is a pure function of the time passed in (no wall clock, no CSS animation).
import { h, s, T, ST, O, prog, E, clamp, lerp, rng, hash, noise, show, TAU } from '../../engine/core.js';
import { C, CAST, person, icon, reaction } from '../../engine/art.js';
import { decode } from '../../engine/type.js';

export const P = {
  bg: '#0b0d10', bg2: '#101419', panel: '#141a20', panel2: '#1a2129', panel3: '#222b35',
  hair: 'rgba(225,232,240,.065)', line: 'rgba(225,232,240,.2)', line2: 'rgba(225,232,240,.42)',
  white: '#eef1f3', dim: '#8d97a1', dim2: '#5c6670',
  hot: '#ff5a1f', hot2: '#ff8a4c',
  blue: '#4aa8ff', purple: '#b06cff', gold: '#ffc53d', goldD: '#c98a12',
};
/** Summon light by tier: blue (3*), purple (4*), gold (5*), white-hot (6* about to burst). */
export const TIERS = [P.blue, P.purple, P.gold, '#fff3d1'];
export const RAINBOW = ['#ff4d6d', '#ff9f43', '#ffe14d', '#5cff9d', '#4dd2ff', '#7a7bff', '#d65cff'];
export const HOLO = 'linear-gradient(118deg, #ff9adf 0%, #c3a6ff 14%, #8fd3ff 28%, #9fffd0 42%, #fff3a1 56%, #ffb48a 70%, #ff9adf 84%, #c3a6ff 100%)';

// single-quoted family names: these strings also go into style="..." attributes inside innerHTML
export const FF = {
  zh: "'Noto Sans SC', sans-serif",
  kin: "'Smiley Sans', 'Noto Sans SC', sans-serif",
  en: 'Anton, sans-serif',
  lab: "'Barlow Condensed', sans-serif",
  mono: "'JetBrains Mono', monospace",
};
/** Headline face per language: zh = Smiley Sans (oblique, techy), en = Anton (condensed). */
export const HEAD = lang => (lang === 'en' ? { ff: 'Anton', w: 400 } : { ff: "'Smiley Sans'", w: 400 });

// ---------------------------------------------------------------- measuring (fonts are loaded before build)
const cv = document.createElement('canvas').getContext('2d');
export function textW(text, px, ff, w = 400, ls = 0) {
  cv.font = `${w} ${px}px ${ff}`;
  return cv.measureText(text).width + ls * px * Math.max(0, [...text].length - 1);
}
/** Largest px <= maxPx so that `text` fits maxW. */
export function fitPx(text, maxW, maxPx, ff, w = 400, ls = 0) {
  const at100 = textW(text, 100, ff, w, ls);
  return Math.max(8, Math.min(maxPx, Math.floor((100 * maxW) / Math.max(1, at100))));
}

// ---------------------------------------------------------------- primitives
export const clip = c => `polygon(${c}px 0, 100% 0, 100% calc(100% - ${c}px), calc(100% - ${c}px) 100%, 0 100%, 0 ${c}px)`;
export const chamferPts = (w, hh, c) => `${c},0 ${w},0 ${w},${hh - c} ${w - c},${hh} 0,${hh} 0,${c}`;
export const hazard = (a = P.hot, b = P.bg, w = 10) => `repeating-linear-gradient(-45deg, ${a} 0 ${w}px, ${b} ${w}px ${w * 2}px)`;

/** Chamfered panel with a hairline outline (clip-path cuts borders, so the outline is an SVG polygon). */
export function panel(parent, { x = 0, y = 0, w, h: hh, c = 18, bg = P.panel, line = P.line2, lw = 2, accent = null } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' });
  const fill = h('div', { class: 'fill' }, el);
  Object.assign(fill.style, { background: bg, clipPath: clip(c) });
  const sv = s('svg', { width: w, height: hh, style: 'position:absolute;left:0;top:0;overflow:visible' }, el);
  const outline = s('polygon', { points: chamferPts(w, hh, c), fill: 'none', stroke: line, 'stroke-width': lw }, sv);
  if (accent) s('path', { d: `M${c + 10} 0H${c + 90}`, stroke: accent, 'stroke-width': 7 }, sv);
  const body = h('div', { class: 'fill' }, el);
  return { el, fill, body, svg: sv, outline, w, h: hh };
}

/** Four corner brackets around a w×h box. */
export function brackets(parent, { w, h: hh, len = 34, sw = 4, color = P.white, x = 0, y = 0 } = {}) {
  const el = s('svg', { width: w, height: hh, style: `position:absolute;left:${x}px;top:${y}px;overflow:visible` }, parent);
  const d = `M0 ${len}V0H${len}M${w - len} 0H${w}V${len}M${w} ${hh - len}V${hh}H${w - len}M${len} ${hh}H0V${hh - len}`;
  const path = s('path', { d, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'square' }, el);
  return { el, path };
}

/** Mono / condensed label. */
export function lab(parent, text, { x = 0, y = 0, size = 22, color = P.dim, ls = 0.18, ff = FF.mono, w = 700, align = null, width = null } = {}) {
  const el = h('div', { class: 'abs', text }, parent);
  Object.assign(el.style, { left: x + 'px', top: y + 'px', font: `${w} ${size}px/1 ${ff}`, letterSpacing: ls + 'em', color, whiteSpace: 'nowrap' });
  if (width) Object.assign(el.style, { width: width + 'px', textAlign: align || 'left' });
  return el;
}

/** Industrial decode of el's text: random glyphs resolve left to right. */
export function decoder(el, text, seed = 1) {
  let last = null;
  return (t, t0, dur = 0.35) => {
    const v = t < t0 ? '' : decode(text, t, t0, dur, seed);
    if (v !== last) { el.textContent = v; last = v; }
  };
}

/** A tiny barcode as an SVG string (seeded). */
export function barcodeSVG(w = 160, hh = 30, seed = 7, color = P.dim) {
  const r = rng(seed);
  let x = 0, d = '';
  while (x < w) { const bw = 1 + Math.floor(r() * 4); if (x + bw > w) break; d += `M${x} 0h${bw}v${hh}h-${bw}Z`; x += bw + 1 + Math.floor(r() * 3); }
  return `<svg width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}"><path d="${d}" fill="${color}"/></svg>`;
}

/** 6-point star path centred at 0,0. */
export function star6(r = 40, k = 0.5) {
  let d = '';
  for (let i = 0; i < 12; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 6, rr = i % 2 ? r * k : r; d += `${i ? 'L' : 'M'}${(Math.cos(a) * rr).toFixed(1)} ${(Math.sin(a) * rr).toFixed(1)}`; }
  return d + 'Z';
}
/** 5-point star path (rarity pips). */
export function star5(r = 12) {
  let d = '';
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; d += `${i ? 'L' : 'M'}${(Math.cos(a) * rr).toFixed(2)} ${(Math.sin(a) * rr).toFixed(2)}`; }
  return d + 'Z';
}

/** The featured prize: a crest (diamonds, wings, rays, six-point star). Drawn into an SVG group centred at 0,0. */
export function crest(parent, { r = 200, color = '#ffd76a', ink = 'rgba(0,0,0,.35)', sw = 6 } = {}) {
  const g = s('g', {}, parent);
  let rays = '';
  for (let i = 0; i < 16; i++) {
    const a = (i * TAU) / 16, w = i % 2 ? 0.035 : 0.06, r0 = r * 0.62, r1 = r * (i % 2 ? 0.88 : 1.02);
    rays += `M${(Math.cos(a) * r0).toFixed(1)} ${(Math.sin(a) * r0).toFixed(1)}L${(Math.cos(a - w) * r1).toFixed(1)} ${(Math.sin(a - w) * r1).toFixed(1)}L${(Math.cos(a + w) * r1).toFixed(1)} ${(Math.sin(a + w) * r1).toFixed(1)}Z`;
  }
  s('path', { d: rays, fill: color, opacity: 0.55 }, g);
  // wings: stacked chevrons left and right
  let wing = '';
  for (let k = 0; k < 3; k++) {
    const o = r * (0.5 + k * 0.13), hh = r * (0.34 - k * 0.07);
    wing += `M${o} ${-hh}L${o + r * 0.16} 0L${o} ${hh}L${o + r * 0.07} 0Z M${-o} ${-hh}L${-o - r * 0.16} 0L${-o} ${hh}L${-o - r * 0.07} 0Z`;
  }
  s('path', { d: wing, fill: color }, g);
  s('rect', { x: -r * 0.42, y: -r * 0.42, width: r * 0.84, height: r * 0.84, transform: 'rotate(45)', fill: ink, stroke: color, 'stroke-width': sw }, g);
  s('rect', { x: -r * 0.3, y: -r * 0.3, width: r * 0.6, height: r * 0.6, transform: 'rotate(45)', fill: 'none', stroke: color, 'stroke-width': sw * 0.5, opacity: 0.8 }, g);
  s('path', { d: star6(r * 0.27, 0.48), fill: color }, g);
  s('circle', { r: r * 0.07, fill: ink }, g);
  return g;
}

// ---------------------------------------------------------------- cast faces (with a scream mouth for this film)
/**
 * A cast member drawn into an SVG group; adds an optional open mouth (the brand beans have no mouth: it appears only
 * when they scream or laugh). set(p) = person.set plus {mouth: 0..1, mouthKind: 'scream'|'laugh'}.
 */
export function face(parent, who, { crown = null, glasses = false, phones = false } = {}) {
  const ch = CAST[who];
  const p = person({ color: ch.color, crown: crown ?? !!ch.crown });
  parent.appendChild(p.el);
  const hd = p.parts.head;
  const ink = C.ink;
  if (glasses) {
    s('circle', { cx: -7, cy: -31, r: 6.2, fill: 'rgba(255,255,255,.08)', stroke: ink, 'stroke-width': 2 }, hd);
    s('circle', { cx: 7, cy: -31, r: 6.2, fill: 'rgba(255,255,255,.08)', stroke: ink, 'stroke-width': 2 }, hd);
    s('path', { d: 'M-1-31h2', stroke: ink, 'stroke-width': 2 }, hd);
  }
  if (phones) {
    s('path', { d: 'M-21-34a21 21 0 0 1 42 0', fill: 'none', stroke: ink, 'stroke-width': 3.4 }, hd);
    s('rect', { x: -25, y: -38, width: 8, height: 14, rx: 3, fill: ink }, hd);
    s('rect', { x: 17, y: -38, width: 8, height: 14, rx: 3, fill: ink }, hd);
  }
  const mouthG = s('g', { opacity: 0 }, hd);
  const scream = s('g', {}, mouthG);
  s('path', { d: 'M-6.5-24Q0-26.2 6.5-24Q7.6-16.5 0-14.2Q-7.6-16.5-6.5-24Z', fill: ink }, scream);
  s('ellipse', { cx: 0, cy: -16.4, rx: 3.6, ry: 1.9, fill: '#ff8fa3' }, scream);
  const laugh = s('path', { d: 'M-5.5-23.5Q0-22.8 5.5-23.5Q4.5-17.2 0-17Q-4.5-17.2-5.5-23.5Z', fill: ink }, mouthG);
  const sweat = s('path', { d: 'M17-46q4 6 0 8.5q-4-2.5 0-8.5Z', fill: '#bfe6ff', stroke: ink, 'stroke-width': 1.2, opacity: 0 }, hd);
  const set = (o = {}) => {
    p.set(o);
    const m = o.mouth || 0;
    mouthG.setAttribute('opacity', m > 0.01 ? 1 : 0);
    if (m > 0.01) {
      const kind = o.mouthKind || 'scream';
      scream.style.display = kind === 'scream' ? '' : 'none';
      laugh.style.display = kind === 'laugh' ? '' : 'none';
      mouthG.setAttribute('transform', `translate(0 -20) scale(${(0.35 + 0.65 * m).toFixed(3)} ${m.toFixed(3)}) translate(0 20)`);
    }
    sweat.setAttribute('opacity', o.sweat || 0);
  };
  return { p, set, el: p.el };
}

/** Head-and-shoulders portrait in its own <svg> (w×hh), feet off the bottom edge. */
export function bust(parent, who, { w = 200, h: hh = 200, sc = 3.4, headY = 0.46, ...opt } = {}) {
  const sv = s('svg', { width: w, height: hh, style: 'position:absolute;left:0;top:0;overflow:hidden' }, parent);
  const g = s('g', {}, sv);
  const f = face(g, who, opt);
  const footY = hh * headY + 90 * sc;
  const set = (o = {}) => { f.set({ ...o, x: w / 2 + (o.x || 0), y: footY + (o.y || 0), s: sc * (o.s ?? 1) }); };
  set({});
  return { el: sv, set, face: f };
}

// ---------------------------------------------------------------- cursor
/** Arrow cursor (+ optional name tag for the remote friend). set(x, y, press 0..1, o, click 0..1 ring). */
export function cursor(parent, { color = P.white, edge = P.bg, size = 52, tag = null, tagColor = P.blue, tagInk = '#fff' } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  el.style.transformOrigin = '0 0';
  const sv = s('svg', { width: size, height: (size * 70) / 60, viewBox: '0 0 60 70', style: 'position:absolute;left:0;top:0;overflow:visible' }, el);
  const ring = s('circle', { cx: 3, cy: 3, r: 10, fill: 'none', stroke: P.hot, 'stroke-width': 5, opacity: 0 }, sv);
  s('path', { d: 'M3 3v55l16-16 13 27 14-6-14-27 27-3Z', fill: color, stroke: edge, 'stroke-width': 4, 'stroke-linejoin': 'round' }, sv);
  if (tag) {
    const t = h('div', { class: 'abs', text: tag }, el);
    Object.assign(t.style, { left: size * 0.7 + 'px', top: size * 1.05 + 'px', padding: '6px 14px 7px', background: tagColor, color: tagInk, font: `800 ${Math.round(size * 0.46)}px/1 ${FF.zh}`, borderRadius: '6px', whiteSpace: 'nowrap', boxShadow: `0 0 0 3px ${P.bg}` });
  }
  const set = (x, y, press = 0, o = 1, click = -1) => {
    T(el, { x, y, s: 1 - press * 0.16, o });
    if (click >= 0 && click < 1) { ring.setAttribute('r', 10 + click * 50); ring.setAttribute('opacity', 1 - click); }
    else ring.setAttribute('opacity', 0);
  };
  return { el, set };
}

// ---------------------------------------------------------------- the fictional gacha game (1600×900 design space)
const GBTN10 = { x: 1210, y: 676, w: 340, h: 186 }, GBTN1 = { x: 930, y: 706, w: 250, h: 136 };
export const GACHA_W = 1600, GACHA_H = 900;
/** Centre of the ten-pull button in design space. */
export const BTN10 = [GBTN10.x + GBTN10.w / 2, GBTN10.y + GBTN10.h / 2];
const CARD = { w: 214, h: 292, x0: 205, dx: 244, y0: 150, dy: 330 };

/**
 * The game window's content. state = {press, hover, dim, cards:[{deal, flip}], tier, rarity:'blue'}.
 * `mini` drops the star field (phones).
 */
export function gacha(parent, { S, lang, w = 1000, mini = false } = {}) {
  const k = w / GACHA_W;
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: GACHA_H * k + 'px', overflow: 'hidden', background: '#0a1120' });
  const d = h('div', { class: 'abs' }, el);
  Object.assign(d.style, { width: GACHA_W + 'px', height: GACHA_H + 'px', transformOrigin: '0 0', transform: `scale(${k})`,
    background: 'radial-gradient(105% 95% at 29% 46%, #24477a 0%, #142a4a 42%, #0a1222 100%)' });
  const sv = s('svg', { width: GACHA_W, height: GACHA_H, viewBox: `0 0 ${GACHA_W} ${GACHA_H}`, style: 'position:absolute;left:0;top:0' }, d);
  s('path', { d: 'M560 0h250L420 900H170Z', fill: 'rgba(140,200,255,.07)' }, sv);
  s('path', { d: 'M900 0h80L590 900h-80Z', fill: 'rgba(140,200,255,.05)' }, sv);
  if (!mini) {
    const r = rng(77);
    let sd = '';
    for (let i = 0; i < 80; i++) { const x = r() * 1600, y = r() * 900, rr = 0.8 + r() * 1.8; sd += `M${(x - rr).toFixed(1)} ${y.toFixed(1)}a${rr.toFixed(1)} ${rr.toFixed(1)} 0 1 0 ${(2 * rr).toFixed(1)} 0a${rr.toFixed(1)} ${rr.toFixed(1)} 0 1 0 ${(-2 * rr).toFixed(1)} 0`; }
    s('path', { d: sd, fill: 'rgba(220,235,255,.55)' }, sv);
  }
  // portal ring behind the featured prize
  const ring = s('g', { transform: 'translate(470 470)' }, sv);
  s('circle', { r: 318, fill: 'rgba(255,214,110,.05)', stroke: 'rgba(255,214,110,.35)', 'stroke-width': 3 }, ring);
  s('circle', { r: 286, fill: 'none', stroke: 'rgba(255,214,110,.18)', 'stroke-width': 18, 'stroke-dasharray': '6 14' }, ring);
  const prize = s('g', { transform: 'translate(470 470)' }, sv);
  crest(prize, { r: 220, color: '#ffd76a', ink: 'rgba(10,18,34,.85)' });
  // title block
  const title = h('div', { class: 'abs', text: S.game.banner }, d);
  Object.assign(title.style, { left: '64px', top: '48px', font: lang === 'en' ? `400 86px/1 ${FF.en}` : `900 80px/1 ${FF.zh}`, letterSpacing: lang === 'en' ? '.02em' : '.06em', color: '#fff', textShadow: '0 4px 0 rgba(0,0,0,.35)' });
  lab(d, S.game.bannerSub, { x: 68, y: 150, size: 30, color: '#9fc3ea', ff: FF.lab, w: 800, ls: 0.3 });
  const up = h('div', { class: 'abs', text: S.game.up }, d);
  Object.assign(up.style, { left: '1110px', top: '196px', padding: '12px 22px', background: P.gold, color: '#1a1205', font: `900 34px/1 ${lang === 'en' ? FF.lab : FF.zh}`, letterSpacing: '.04em', clipPath: clip(12), whiteSpace: 'nowrap' });
  // currency
  const cur = h('div', { class: 'abs', html: `<svg width="44" height="44" viewBox="-22 -22 44 44" style="vertical-align:-9px;margin-right:14px"><path d="M0-20 16 0 0 20-16 0Z" fill="#8fe3ff" stroke="#e9fbff" stroke-width="3"/><path d="M0-20 6 0 0 20" fill="#e9fbff" opacity=".5"/></svg>3000` }, d);
  Object.assign(cur.style, { left: '1240px', top: '52px', width: '300px', height: '72px', padding: '0 24px', boxSizing: 'border-box', lineHeight: '72px', background: 'rgba(0,0,0,.45)', border: '3px solid rgba(160,200,240,.5)', borderRadius: '36px', font: `800 40px/72px ${FF.mono}`, color: '#fff', textAlign: 'right' });
  // buttons
  const b1 = h('div', { class: 'abs' }, d);
  Object.assign(b1.style, { left: GBTN1.x + 'px', top: GBTN1.y + 'px', width: GBTN1.w + 'px', height: GBTN1.h + 'px', background: 'rgba(8,16,30,.7)', border: '4px solid #9fc3ea', clipPath: clip(22), boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dfeeff', font: lang === 'en' ? `400 64px/1 ${FF.en}` : `900 58px/1 ${FF.zh}` });
  b1.textContent = S.game.single;
  const b10wrap = h('div', { class: 'abs' }, d);
  Object.assign(b10wrap.style, { left: GBTN10.x + 'px', top: GBTN10.y + 'px', width: GBTN10.w + 'px', height: GBTN10.h + 'px', transformOrigin: '50% 50%' });
  const glow = h('div', { class: 'abs' }, b10wrap);
  Object.assign(glow.style, { left: '-40px', top: '-40px', width: GBTN10.w + 80 + 'px', height: GBTN10.h + 80 + 'px', background: 'radial-gradient(closest-side, rgba(255,120,60,.85), rgba(255,90,31,0))', opacity: 0.4 });
  const b10 = h('div', { class: 'fill' }, b10wrap);
  Object.assign(b10.style, { background: `linear-gradient(180deg, #ff8a4c, ${P.hot} 55%, #e2430f)`, clipPath: clip(30), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#1a0b04' });
  const t10 = h('div', { text: S.game.ten }, b10);
  Object.assign(t10.style, { font: lang === 'en' ? `400 78px/1 ${FF.en}` : `900 86px/1 ${FF.zh}`, letterSpacing: lang === 'en' ? '.03em' : '.08em' });
  const s10 = h('div', { text: S.game.tenSub }, b10);
  Object.assign(s10.style, { font: `800 34px/1 ${FF.mono}`, marginTop: '8px', letterSpacing: '.1em' });
  const hb = h('div', { class: 'fill' }, b10wrap);
  Object.assign(hb.style, { clipPath: clip(30), boxShadow: 'inset 0 0 0 6px rgba(255,240,220,.9)', opacity: 0 });
  // dim + cards
  const dim = h('div', { class: 'fill' }, d);
  dim.style.background = 'rgba(3,8,16,.82)';
  const cards = Array.from({ length: 10 }, (_, i) => {
    const x = CARD.x0 + (i % 5) * CARD.dx, y = CARD.y0 + Math.floor(i / 5) * CARD.dy;
    const wrap = h('div', { class: 'abs' }, d);
    Object.assign(wrap.style, { left: x + 'px', top: y + 'px', width: CARD.w + 'px', height: CARD.h + 'px', transformOrigin: '50% 50%', willChange: mini ? 'auto' : 'transform' });
    const back = h('div', { class: 'fill' }, wrap);
    Object.assign(back.style, { background: 'repeating-linear-gradient(45deg, rgba(120,170,230,.09) 0 10px, transparent 10px 20px), linear-gradient(160deg, #233a5a, #0e1828)', border: '4px solid #3d6091', boxSizing: 'border-box', borderRadius: '10px' });
    const bsv = s('svg', { width: CARD.w, height: CARD.h, style: 'position:absolute;left:0;top:0' }, back);
    const bg = s('g', { transform: `translate(${CARD.w / 2 - 4} ${CARD.h / 2 - 4})` }, bsv);
    crest(bg, { r: 52, color: '#6f93c4', ink: 'rgba(0,0,0,.25)', sw: 3 });
    const front = h('div', { class: 'fill' }, wrap);
    Object.assign(front.style, { background: 'linear-gradient(165deg, #2b6fc0, #123663 70%)', border: `6px solid ${P.blue}`, boxSizing: 'border-box', borderRadius: '10px', boxShadow: '0 0 28px rgba(74,168,255,.55)' });
    const fsv = s('svg', { width: CARD.w, height: CARD.h, style: 'position:absolute;left:-6px;top:-6px' }, front);
    const shape = i % 3;
    const ic = s('g', { transform: `translate(${CARD.w / 2} ${CARD.h * 0.42})`, fill: 'rgba(205,232,255,.85)' }, fsv);
    if (shape === 0) s('path', { d: 'M-14-46h28v18l20 34q8 22-16 30h-36q-24-8-16-30l20-34Z' }, ic);           // potion
    else if (shape === 1) s('path', { d: 'M-6-56h12v70h22v12H6v20H-6V26h-22V14H-6Z' }, ic);                     // sword
    else s('path', { d: 'M0-52 38-30v34Q38 34 0 52-38 34-38 4v-34Z' }, ic);                                       // shield
    const pips = s('g', { transform: `translate(${CARD.w / 2 - 30} ${CARD.h - 46})`, fill: '#dff1ff' }, fsv);
    for (let j = 0; j < 3; j++) s('path', { d: star5(11), transform: `translate(${j * 30} 0)` }, pips);
    return { wrap, back, front };
  });
  const flash = h('div', { class: 'fill' }, d);
  flash.style.background = '#fff';
  const set = (o = {}) => {
    const pr = o.press || 0, hv = o.hover || 0;
    T(b10wrap, { s: 1 - 0.07 * pr + 0.03 * hv });
    glow.style.opacity = (0.35 + 0.65 * Math.max(hv, pr)).toFixed(3);
    hb.style.opacity = (hv * 0.9).toFixed(3);
    O(dim, o.dim || 0);
    const cs = o.cards || [];
    cards.forEach((c, i) => {
      const st = cs[i];
      if (!st || st.deal <= 0) { show(c.wrap, false); return; }
      show(c.wrap, true);
      const q = E.out3(clamp(st.deal));
      const fx = BTN10[0] - CARD.w / 2, fy = BTN10[1] - CARD.h / 2;
      const x = lerp(fx - (CARD.x0 + (i % 5) * CARD.dx), 0, q), y = lerp(fy - (CARD.y0 + Math.floor(i / 5) * CARD.dy), 0, q);
      const fl = clamp(st.flip || 0), sx = Math.abs(Math.cos(Math.PI * fl));
      T(c.wrap, { x, y, s: lerp(0.25, 1, q) * (1 + 0.08 * Math.sin(Math.PI * fl)), sx: Math.max(0.02, sx), r: (1 - q) * (i % 2 ? 24 : -24) });
      show(c.back, fl < 0.5); show(c.front, fl >= 0.5);
    });
    O(flash, o.flash || 0);
  };
  set({});
  return { el, set, k, w, h: GACHA_H * k };
}

// ---------------------------------------------------------------- the game window (chrome + content)
/** The shared game window as it sits on the host's PC: title bar + gacha content + LIVE frame. */
export function gameWindow(parent, { S, lang, w = 1000 }) {
  const el = h('div', { class: 'abs' }, parent);
  el.style.transformOrigin = '0 0';
  const bar = h('div', { class: 'abs' }, el);
  Object.assign(bar.style, { left: 0, top: '-44px', width: w + 'px', height: '44px', background: P.panel2, borderBottom: `2px solid ${P.line}`, display: 'flex', alignItems: 'center', gap: '12px', padding: '0 16px', boxSizing: 'border-box' });
  bar.innerHTML = `<i style="width:12px;height:12px;border-radius:50%;background:#5c6670"></i><i style="width:12px;height:12px;border-radius:50%;background:#5c6670"></i><span style="font:700 20px/1 ${FF.mono};color:${P.dim};letter-spacing:.06em;margin-left:8px;white-space:nowrap">${S.game.window}</span>`;
  const g = gacha(el, { S, lang, w });
  // LIVE frame (drawn over the window when sharing)
  const frame = s('svg', { width: w, height: g.h + 44, style: 'position:absolute;left:0;top:-44px;overflow:visible' }, el);
  const per = 2 * (w + g.h + 44);
  const border = s('rect', { x: -6, y: -6, width: w + 12, height: g.h + 56, fill: 'none', stroke: P.hot, 'stroke-width': 8, 'stroke-dasharray': `0 ${per + 100}` }, frame);
  const chip = h('div', { class: 'abs', html: `<i style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#fff;margin-right:12px;vertical-align:1px"></i>LIVE · ${S.live}` }, el);
  Object.assign(chip.style, { left: '-6px', top: '-92px', padding: '10px 18px 10px 16px', background: P.hot, color: '#fff', font: `800 26px/1 ${lang === 'en' ? FF.lab : FF.zh}`, letterSpacing: '.06em', whiteSpace: 'nowrap', clipPath: clip(10) });
  const dot = chip.querySelector('i');
  const sel = brackets(el, { w: w + 40, h: g.h + 84, x: -20, y: -64, len: 46, sw: 6, color: P.white });
  const set = (t, o = {}) => {
    g.set(o.game || {});
    const lv = clamp(o.live ?? 0);
    border.setAttribute('stroke-dasharray', `${(lv * (per + 60)).toFixed(1)} ${per + 100}`);
    show(chip, lv > 0.2);
    T(chip, { o: clamp((lv - 0.2) * 3), x: 0 });
    dot.style.opacity = lv > 0 ? (0.5 + 0.5 * Math.cos(t * 6)).toFixed(2) : 1;
    const sb = o.select ?? 0;
    show(sel.el, sb > 0.001);
    if (sb > 0.001) { sel.el.style.opacity = Math.min(1, sb * 2); sel.el.style.transform = `scale(${lerp(1.25, 1, E.out3(sb))})`; sel.el.style.transformOrigin = '50% 50%'; }
  };
  return { el, set, game: g, w, h: g.h };
}

// ---------------------------------------------------------------- phones (viewer side)
/** A phone: lock screen with the invite message, then the browser viewer page with the stream. */
export function phone(parent, { S, lang, who, w = 300, h: hh = 580 }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: hh + 'px', transformOrigin: '50% 50%' });
  const body = h('div', { class: 'fill' }, el);
  Object.assign(body.style, { borderRadius: '44px', background: '#05070a', boxShadow: `0 0 0 3px ${P.line2}, 0 26px 60px rgba(0,0,0,.6)` });
  const scr = h('div', { class: 'abs' }, el);
  const sw = w - 24, sh = hh - 24;
  Object.assign(scr.style, { left: '12px', top: '12px', width: sw + 'px', height: sh + 'px', borderRadius: '34px', overflow: 'hidden', background: 'linear-gradient(170deg, #1d2a3a, #0c1118)' });
  // lock screen
  const lock = h('div', { class: 'fill' }, scr);
  lab(lock, '23:41', { x: 0, y: 70, size: 74, color: '#fff', ff: FF.mono, w: 800, ls: 0, width: sw, align: 'center' });
  const note = h('div', { class: 'abs' }, lock);
  Object.assign(note.style, { left: '14px', top: '200px', width: sw - 28 + 'px', padding: '18px 18px 20px', boxSizing: 'border-box', background: 'rgba(238,241,243,.94)', borderRadius: '22px', color: P.bg, transformOrigin: '50% 0' });
  const nbw = h('div', { class: 'abs' }, note);
  Object.assign(nbw.style, { left: '16px', top: '16px', width: '48px', height: '48px', borderRadius: '50%', overflow: 'hidden', background: '#cfe9d6' });
  bust(nbw, 'tuan', { w: 48, h: 48, sc: 0.95, headY: 0.62 });
  const nt = h('div', {}, note);
  Object.assign(nt.style, { marginLeft: '58px', font: `800 27px/1.2 ${FF.zh}` });
  nt.textContent = S.msgFrom;
  const nm = h('div', {}, note);
  Object.assign(nm.style, { margin: '16px 0 0 0', font: `700 27px/1.3 ${FF.zh}`, color: '#2a3440', minHeight: '28px', whiteSpace: 'normal' });
  nm.textContent = S.msg;
  const nchip = h('div', { html: `${icon('link', { size: 22, color: '#fff', sw: 2.6 }).outerHTML}<span>${S.inviteChip}</span>` }, note);
  Object.assign(nchip.style, { marginTop: '14px', display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 14px', background: P.bg, color: '#fff', borderRadius: '12px', font: `800 ${fitPx(S.inviteChip, sw - 28 - 36 - 28 - 32, 22, FF.zh, 800)}px/1 ${FF.zh}`, whiteSpace: 'nowrap' });
  // browser viewer page
  const page = h('div', { class: 'fill' }, scr);
  page.style.background = '#0d1217';
  const tab = h('div', { class: 'abs' }, page);
  Object.assign(tab.style, { left: 0, top: 0, width: sw + 'px', height: '74px', background: P.panel2, borderBottom: `2px solid ${P.line}`, display: 'flex', alignItems: 'center', padding: '20px 18px 0', boxSizing: 'border-box', gap: '10px' });
  tab.innerHTML = `${icon('cast', { size: 24, color: P.hot, sw: 2.4 }).outerHTML}<span style="font:800 22px/1 ${FF.zh};color:#fff;white-space:nowrap">${S.viewerTitle}</span>`;
  const stream = gacha(page, { S, lang, w: sw, mini: true });
  stream.el.style.top = '96px';
  const live = h('div', { class: 'abs', html: `<i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${P.hot};margin-right:8px"></i>${S.watching}` }, page);
  Object.assign(live.style, { left: '16px', top: 96 + stream.h + 18 + 'px', font: `700 20px/1 ${FF.zh}`, color: '#fff', whiteSpace: 'nowrap' });
  const rx = h('div', { class: 'abs' }, page);
  Object.assign(rx.style, { left: '16px', top: 96 + stream.h + 60 + 'px', display: 'flex', gap: '12px' });
  for (const k of ['tomato', 'poop', 'heart', 'star']) {
    const b = h('div', {}, rx);
    Object.assign(b.style, { width: '54px', height: '54px', borderRadius: '14px', background: P.panel3, display: 'flex', alignItems: 'center', justifyContent: 'center' });
    b.appendChild(reaction(k, 36));
  }
  const ib = h('div', { class: 'abs', html: `${icon('chat', { size: 22, color: P.dim, sw: 2.2 }).outerHTML}<span>…</span>` }, page);
  Object.assign(ib.style, { left: '16px', top: sh - 86 + 'px', width: sw - 32 + 'px', height: '56px', borderRadius: '28px', background: P.panel3, display: 'flex', alignItems: 'center', gap: '10px', padding: '0 18px', boxSizing: 'border-box', color: P.dim, font: `600 20px/1 ${FF.zh}` });
  // tap ring
  const ring = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, scr);
  const rc = s('circle', { cx: sw / 2, cy: 300, r: 20, fill: 'rgba(255,255,255,.35)', stroke: '#fff', 'stroke-width': 4, opacity: 0 }, ring);
  const set = (t, o = {}) => {
    const open = o.open ?? 0;                       // 0 = lock screen, 1 = viewer page
    show(lock, open < 1); show(page, open > 0);
    lock.style.opacity = (1 - open).toFixed(3);
    page.style.opacity = open.toFixed(3);
    T(page, { y: (1 - E.out3(open)) * 60 });
    T(note, { s: o.note ?? 1, o: o.note ?? 1, y: (1 - (o.note ?? 1)) * -30 });
    const tp = o.tap ?? -1;
    if (tp >= 0 && tp < 1) { rc.setAttribute('r', 20 + tp * 70); rc.setAttribute('opacity', (1 - tp).toFixed(3)); }
    else rc.setAttribute('opacity', 0);
    stream.set(o.game || {});
  };
  return { el, set, w, h: hh };
}

// ---------------------------------------------------------------- party ID card
/** Party member card: chamfered panel, portrait, name, role, mic state + voice ring. */
export function idCard(parent, { S, lang, who, w = 240, h: hh = 300, host = false }) {
  const pn = panel(parent, { w, h: hh, c: 20, bg: P.panel, line: host ? P.hot : P.line2, lw: host ? 3 : 2, accent: host ? P.hot : null });
  const el = pn.el;
  const ch = CAST[who];
  const pic = h('div', { class: 'abs' }, el);
  Object.assign(pic.style, { left: '14px', top: '14px', width: w - 28 + 'px', height: hh - 120 + 'px', background: `radial-gradient(90% 80% at 50% 90%, ${ch.color}44, transparent 70%), ${P.bg2}`, overflow: 'hidden' });
  const b = bust(pic, who, { w: w - 28, h: hh - 120, sc: 2.3, headY: 0.42 });
  const ringSv = s('svg', { width: w - 28, height: hh - 120, style: 'position:absolute;left:0;top:0;overflow:visible' }, pic);
  const rings = [0, 1].map(() => s('circle', { cx: (w - 28) / 2, cy: (hh - 120) * 0.42, r: 40, fill: 'none', stroke: P.hot, 'stroke-width': 4, opacity: 0 }, ringSv));
  const nm = lab(el, S.names[who], { x: 16, y: hh - 92, size: lang === 'en' ? 34 : 34, color: '#fff', ff: lang === 'en' ? FF.lab : FF.zh, w: 900, ls: lang === 'en' ? 0.04 : 0.02 });
  const role = lab(el, host ? `${S.host} · HOST` : `${S.viewer}`, { x: 16, y: hh - 46, size: 18, color: host ? P.hot : P.dim, ff: FF.mono, w: 700, ls: 0.12 });
  if (lang === 'en') role.textContent = host ? 'HOST' : 'VIEWER';
  const mic = h('div', { class: 'abs' }, el);
  Object.assign(mic.style, { left: w - 58 + 'px', top: hh - 62 + 'px', width: '40px', height: '40px', borderRadius: '8px', background: P.panel3, display: 'flex', alignItems: 'center', justifyContent: 'center' });
  const micOn = icon('microphone', { size: 26, color: '#fff', sw: 2.2 }), micOff = icon('microphoneOff', { size: 26, color: P.dim2, sw: 2.2 });
  mic.appendChild(micOn); mic.appendChild(micOff);
  const set = (t, o = {}) => {
    b.set(o.face || {});
    const sp = o.speak || 0;
    show(micOn, (o.mic ?? 0) > 0); show(micOff, !((o.mic ?? 0) > 0));
    mic.style.background = sp > 0.01 ? P.hot : P.panel3;
    rings.forEach((r, i) => {
      const ph = ((t * 1.6 + i * 0.5) % 1);
      r.setAttribute('r', 40 + ph * 60);
      r.setAttribute('opacity', (sp * (1 - ph)).toFixed(3));
    });
  };
  return { el, set, w, h: hh, pn };
}

// ---------------------------------------------------------------- chat feed
/** Party chat: items [{who, text, t0}] slide in, newest at the bottom. */
export function chatFeed(parent, { S, lang, w = 1000, h: hh = 420, items }) {
  const pn = panel(parent, { w, h: hh, c: 22, bg: 'rgba(20,26,32,.92)', line: P.line2 });
  const el = pn.el;
  lab(el, lang === 'en' ? 'CHAT' : `聊天 · CHAT`, { x: 24, y: 22, size: 20, color: P.dim, ff: FF.mono, w: 700, ls: 0.16 });
  const list = h('div', { class: 'abs' }, el);
  Object.assign(list.style, { left: '20px', top: '64px', width: w - 40 + 'px', height: hh - 84 + 'px', overflow: 'hidden' });
  const rows = items.map(it => {
    const r = h('div', { class: 'abs' }, list);
    const ch = CAST[it.who];
    Object.assign(r.style, { left: 0, width: w - 40 + 'px', display: 'flex', alignItems: 'center', gap: '16px', font: `700 34px/1.2 ${FF.zh}`, color: '#fff', whiteSpace: 'nowrap' });
    r.innerHTML = `<i style="flex:none;width:18px;height:18px;border-radius:50%;background:${ch.color}"></i><b style="color:${ch.color};font-weight:900">${S.names[it.who]}</b><span>${it.text}</span>`;
    return { r, ...it };
  });
  const ROW = 62;
  const update = t => {
    const vis = rows.filter(x => t >= x.t0);
    rows.forEach(x => {
      const i = vis.indexOf(x);
      if (i < 0) { show(x.r, false); return; }
      show(x.r, true);
      const fromBottom = vis.length - 1 - i;
      const q = E.out3(prog(x.t0, x.t0 + 0.18, t));
      T(x.r, { x: (1 - q) * 40, y: hh - 84 - ROW * (fromBottom + 1) + (1 - q) * 20, o: q });
    });
  };
  return { el, update };
}

// ---------------------------------------------------------------- danmaku
/** Comments flying right → left across [x0, x1] at row y. items: [{text, t0, y, speed, color, size}] */
export function danmaku(parent, items, { x0 = 0, x1 = 1080, ff = FF.zh } = {}) {
  const els = items.map(it => {
    const d = h('div', { class: 'abs', text: it.text }, parent);
    Object.assign(d.style, { font: `${it.weight || 900} ${it.size || 46}px/1 ${ff}`, color: it.color || '#fff', whiteSpace: 'nowrap', paintOrder: 'stroke fill', WebkitTextStroke: `${Math.round((it.size || 46) * 0.17)}px ${P.bg}` });
    return { d, ...it, w: textW(it.text, it.size || 46, ff, it.weight || 900) };
  });
  return t => els.forEach(e => {
    const dt = t - e.t0, sp = e.speed || 520;
    const x = x1 - dt * sp;
    const on = dt >= 0 && x > x0 - e.w - 20;
    show(e.d, on);
    if (on) T(e.d, { x, y: e.y });
  });
}

// ---------------------------------------------------------------- remote control request dialog
/** The host's control-request card (product copy), industrial-styled. set(t, {in, hoverAllow, pressAllow, done}). */
export function controlDialog(parent, { S, lang, w = 940, h: hh = 470 }) {
  const pn = panel(parent, { w, h: hh, c: 28, bg: 'rgba(16,21,27,.97)', line: P.line2, lw: 2, accent: P.hot });
  const el = pn.el;
  el.style.transformOrigin = '50% 50%';
  const hd = h('div', { class: 'abs' }, el);
  Object.assign(hd.style, { left: '34px', top: '34px', display: 'flex', alignItems: 'center', gap: '14px', color: '#fff', font: `900 36px/1 ${lang === 'en' ? FF.lab : FF.zh}`, letterSpacing: lang === 'en' ? '.04em' : '.02em', whiteSpace: 'nowrap' });
  hd.appendChild(icon('mouse', { size: 38, color: P.hot, sw: 2.4 }));
  h('span', { text: S.reqHeader }, hd);
  const cnt = h('span', { text: '1' }, hd);
  Object.assign(cnt.style, { marginLeft: '6px', padding: '4px 12px', background: P.hot, color: '#fff', borderRadius: '6px', font: `800 24px/1 ${FF.mono}` });
  lab(el, 'REMOTE CONTROL // ASK EACH TIME', { x: w - 34 - 470, y: 44, size: 18, color: P.dim2, ff: FF.mono, ls: 0.12, width: 470, align: 'right' });
  const rowY = 112;
  const av = h('div', { class: 'abs' }, el);
  Object.assign(av.style, { left: '34px', top: rowY + 'px', width: '96px', height: '96px', borderRadius: '18px', background: `${P.bg2}`, overflow: 'hidden', boxShadow: `0 0 0 3px ${C.blue}` });
  const ab = bust(av, 'yuan', { w: 96, h: 96, sc: 1.55, headY: 0.55 });
  const who = h('div', { class: 'abs', html: `<b style="font-weight:900;color:#fff">${S.names.yuan}</b>&nbsp;&nbsp;<span style="color:${P.dim};font-weight:600">${S.reqWho}</span>` }, el);
  Object.assign(who.style, { left: '156px', top: rowY + 14 + 'px', font: `900 40px/1 ${FF.zh}`, whiteSpace: 'nowrap' });
  const keys = h('div', { class: 'abs' }, el);
  Object.assign(keys.style, { left: '156px', top: rowY + 66 + 'px', display: 'flex', gap: '12px' });
  keys.appendChild(icon('keyboard', { size: 34, color: P.dim, sw: 2 }));
  keys.appendChild(icon('mouse', { size: 34, color: P.dim, sw: 2 }));
  const cs = h('div', { class: 'abs', text: S.consent }, el);
  Object.assign(cs.style, { left: '34px', top: rowY + 136 + 'px', width: w - 68 + 'px', font: `600 ${lang === 'en' ? 30 : 32}px/1.45 ${FF.zh}`, color: '#d6dde3', whiteSpace: 'normal' });
  const bw = (w - 68 - 24) / 2, by = hh - 34 - 92;
  const dec = h('div', { class: 'abs', text: S.decline }, el);
  Object.assign(dec.style, { left: '34px', top: by + 'px', width: bw + 'px', height: '92px', boxSizing: 'border-box', border: `3px solid ${P.line2}`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `800 36px/1 ${FF.zh}`, clipPath: clip(16) });
  const alw = h('div', { class: 'abs' }, el);
  Object.assign(alw.style, { left: 34 + bw + 24 + 'px', top: by + 'px', width: bw + 'px', height: '92px', transformOrigin: '50% 50%' });
  const alwIn = h('div', { class: 'fill', text: S.allow }, alw);
  Object.assign(alwIn.style, { background: P.hot, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `900 38px/1 ${FF.zh}`, clipPath: clip(16) });
  const ok = h('div', { class: 'fill' }, alw);
  Object.assign(ok.style, { background: '#2fa66a', display: 'flex', alignItems: 'center', justifyContent: 'center', clipPath: clip(16) });
  ok.appendChild(icon('check', { size: 56, color: '#fff', sw: 3.4 }));
  return {
    el, w, h: hh,
    allowAt: [34 + bw + 24 + bw / 2, by + 46],
    set: (t, o = {}) => {
      T(alw, { s: 1 - 0.08 * (o.press || 0) + 0.03 * (o.hover || 0) });
      alwIn.style.boxShadow = o.hover ? `inset 0 0 0 5px rgba(255,240,220,${(0.9 * o.hover).toFixed(2)})` : 'none';
      O(ok, o.done || 0);
      ab.set({ eyes: 'open', blink: (t % 2.7) > 2.6 ? 1 : 0 });
    },
  };
}

// ---------------------------------------------------------------- reveal pieces
/**
 * Prismatic ray fan: 36 rainbow wedges fading out radially, drawn once into a small canvas and shown scaled up
 * (rays are soft, so 1024 px is plenty; no SVG ids, so it is safe in any shadow root). Rotate the element per frame.
 */
export function prismRays(parent, { R = 1500, n = 36, seed = 3 } = {}) {
  const N = 1024, c = h('canvas', { width: N, height: N }, parent);
  Object.assign(c.style, { position: 'absolute', left: 0, top: 0, width: 2 * R + 'px', height: 2 * R + 'px', transformOrigin: '50% 50%', mixBlendMode: 'screen' });
  const ctx = c.getContext('2d'), r = rng(seed), m = N / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, w = (0.35 + r() * 0.65) * (TAU / n) * 0.42;
    ctx.globalAlpha = 0.45 + r() * 0.5;
    ctx.fillStyle = RAINBOW[i % RAINBOW.length];
    ctx.beginPath(); ctx.moveTo(m, m);
    ctx.lineTo(m + Math.cos(a - w) * m, m + Math.sin(a - w) * m);
    ctx.lineTo(m + Math.cos(a + w) * m, m + Math.sin(a + w) * m);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  const g = ctx.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/** Deterministic particle burst on a canvas: diamonds and sparks in rainbow + gold. */
export function sparks(parent, { W, H, n = 160, seed = 9 }) {
  const c = h('canvas', { width: W, height: H }, parent);
  Object.assign(c.style, { position: 'absolute', left: 0, top: 0, width: W + 'px', height: H + 'px', mixBlendMode: 'screen' });
  const ctx = c.getContext('2d');
  const r = rng(seed);
  const ps = Array.from({ length: n }, (_, i) => ({ a: r() * TAU, v: 500 + r() * 1700, sz: 6 + r() * 22, spin: (r() - 0.5) * 16, life: 0.9 + r() * 1.5, col: i % 4 === 0 ? '#fff6d8' : i % 3 === 0 ? P.gold : RAINBOW[i % RAINBOW.length], delay: r() * 0.25, kind: i % 5 === 0 ? 'streak' : 'diamond' }));
  let wasOn = false;
  return (t, t0, cx, cy) => {
    const lt = t - t0;
    const on = lt >= 0 && lt < 2.8;
    if (!on) { if (wasOn) { ctx.clearRect(0, 0, W, H); wasOn = false; } show(c, false); return; }
    show(c, true); wasOn = true;
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      const q = lt - p.delay;
      if (q < 0 || q > p.life) continue;
      const k = q / p.life, dist = p.v * (1 - Math.exp(-q * 2.4)) / 2.4, g = 260 * q * q;
      const x = cx + Math.cos(p.a) * dist, y = cy + Math.sin(p.a) * dist + g;
      const al = (1 - k) * (1 - k);
      ctx.globalAlpha = al;
      ctx.fillStyle = p.col;
      ctx.save();
      ctx.translate(x, y);
      if (p.kind === 'streak') {
        ctx.rotate(p.a);
        ctx.fillRect(-p.sz * 2.4, -2, p.sz * 4.8, 4);
      } else {
        ctx.rotate(p.spin * q);
        const sz = p.sz * (1 - 0.5 * k);
        ctx.beginPath(); ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.6, 0); ctx.lineTo(0, sz); ctx.lineTo(-sz * 0.6, 0); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };
}

/** The legendary card: holographic foil front (crest + six stars), dark back; 3D flip via rotateY. */
export function foilCard(parent, { S, w = 460, h: hh = 650 }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: hh + 'px', perspective: '1600px' });
  const card = h('div', { class: 'fill' }, el);
  Object.assign(card.style, { transformStyle: 'preserve-3d', transformOrigin: '50% 50%' });
  const back = h('div', { class: 'fill' }, card);
  Object.assign(back.style, { background: 'repeating-linear-gradient(45deg, rgba(255,90,31,.12) 0 12px, transparent 12px 24px), linear-gradient(160deg, #1a2129, #0b0d10)', border: `6px solid ${P.hot}`, boxSizing: 'border-box', borderRadius: '18px', backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' });
  const bsv = s('svg', { width: w, height: hh, style: 'position:absolute;left:-6px;top:-6px' }, back);
  crest(s('g', { transform: `translate(${w / 2} ${hh / 2})` }, bsv), { r: 120, color: P.hot, ink: 'rgba(0,0,0,.3)', sw: 4 });
  const front = h('div', { class: 'fill' }, card);
  Object.assign(front.style, { borderRadius: '18px', overflow: 'hidden', backfaceVisibility: 'hidden', boxShadow: '0 0 0 6px #fff6d8, 0 0 80px rgba(255,230,160,.8)' });
  const holo = h('div', { class: 'fill' }, front);
  Object.assign(holo.style, { background: HOLO, backgroundSize: '300% 300%' });
  const inner = h('div', { class: 'abs' }, front);
  Object.assign(inner.style, { left: '22px', top: '22px', width: w - 44 + 'px', height: hh - 44 + 'px', borderRadius: '10px', background: 'radial-gradient(80% 60% at 50% 42%, rgba(255,255,255,.55), rgba(255,255,255,0) 70%), linear-gradient(170deg, rgba(40,20,70,.55), rgba(20,10,40,.75))', boxShadow: 'inset 0 0 0 3px rgba(255,255,255,.75)' });
  const fsv = s('svg', { width: w, height: hh, style: 'position:absolute;left:0;top:0' }, front);
  crest(s('g', { transform: `translate(${w / 2} ${hh * 0.43})` }, fsv), { r: 170, color: '#fff6d8', ink: 'rgba(60,30,90,.55)', sw: 7 });
  const pip = s('g', { transform: `translate(${w / 2 - 5 * 30} ${hh - 116})`, fill: '#fff6d8', stroke: '#c98a12', 'stroke-width': 1.5 }, fsv);
  for (let j = 0; j < 6; j++) s('path', { d: star5(19), transform: `translate(${j * 60} 0)` }, pip);
  lab(front, S.rarity, { x: 0, y: hh - 76, size: 20, color: '#fff', ff: FF.mono, w: 800, ls: 0.16, width: w, align: 'center' });
  const sheen = h('div', { class: 'abs' }, front);
  Object.assign(sheen.style, { left: '-40%', top: '-20%', width: '40%', height: '140%', background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.85), rgba(255,255,255,0))', transform: 'skewX(-18deg)', mixBlendMode: 'overlay' });
  return {
    el,
    set: (t, o = {}) => {
      card.style.transform = `rotateY(${(o.ry ?? 0).toFixed(2)}deg) rotateZ(${(o.rz ?? 0).toFixed(2)}deg)`;
      holo.style.backgroundPosition = `${(50 + 50 * Math.sin(t * 1.7)).toFixed(1)}% ${(50 + 50 * Math.cos(t * 1.3)).toFixed(1)}%`;
      const sp = ((t * 0.9) % 1.6) / 1.6;
      sheen.style.transform = `translateX(${(sp * 380).toFixed(1)}%) skewX(-18deg)`;
    },
  };
}

/** RGB-split headline: three stacked copies (cyan, magenta, white/holo) whose offsets come from `split` per frame. */
export function rgbText(parent, text, { size, ff, w = 400, ls = 0, holo = false, stroke = 0 } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  el.style.transformOrigin = '50% 50%';
  const mk = (color, blend) => {
    const d = h('div', { class: 'abs', text }, el);
    Object.assign(d.style, { font: `${w} ${size}px/1 ${ff}`, letterSpacing: ls + 'em', whiteSpace: 'nowrap', color, mixBlendMode: blend || 'normal' });
    return d;
  };
  const c1 = mk('#00f0ff', 'screen'), c2 = mk('#ff2d6f', 'screen');
  const main = mk('#fff');
  if (holo) Object.assign(main.style, { backgroundImage: HOLO, backgroundSize: '200% 100%', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextStroke: stroke ? `${stroke}px #fff` : '' });
  return {
    el, main,
    set: (t, split = 0) => {
      T(c1, { x: -split, y: split * 0.3 });
      T(c2, { x: split, y: -split * 0.3 });
      c1.style.opacity = c2.style.opacity = split > 0.2 ? 0.9 : 0;
      if (holo) main.style.backgroundPosition = `${((t * 60) % 200).toFixed(1)}% 0`;
    },
  };
}
