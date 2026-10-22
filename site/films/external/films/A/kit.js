// Film A component kit: dialog boxes, cut-ins, the shared screen, sofa room, danmaku, callouts,
// the calling card, thrown reactions, stamps and wipes. Every component exposes set()/update(t).
import { h, s, T, ST, O, kf, tw, prog, E, clamp, lerp, rng, noise, pulse, show, TAU } from '../../engine/core.js';
import { C, CAST, mascot, person, sofa, icon, reaction, burst, splat, jagRect, focusLines, streaks, barcode, halftone, stripes } from '../../engine/art.js';
import { ransom, ransomPop } from '../../engine/type.js';
import { grungeURL, paperURL } from '../../engine/tex.js';

export const FPS = 60;
export const snap = t => Math.round(t * FPS) / FPS;
/** The brand wordmark face (the brand SVG uses Arial bold); Arimo is the OFL, metric-compatible stand-in. */
export const WORDMARK = px => `700 ${px}px/1 Arimo, Arial, sans-serif`;

/** Full-width flex row for auto-centred content (no measuring needed). */
export function row(parent, { y, x = 0, w = 1920, gap = 0, justify = 'center', align = 'center' } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', display: 'flex', justifyContent: justify, alignItems: align, gap: gap + 'px' });
  return el;
}
/** Put a ransom() block into a flex row (ransom blocks are absolutely positioned by default). */
export function inRow(rowEl, r) { r.el.style.position = 'relative'; rowEl.appendChild(r.el); return r; }

// ---------------------------------------------------------------- dialog box
/** Angular dialog: skewed plate, tilted name tag, typewriter main line + optional small second-language line. */
export function dialog(parent, { who, name, tag = '', main, sub = '', x, y, w = 900, hgt = 200, cps = 0, tail = 'left' }) {
  const ch = CAST[who];
  const el = h('div', { class: 'dlg' }, parent);
  T(el, { x, y });
  const plate = h('div', { class: 'plate' }, el);
  Object.assign(plate.style, { width: w + 'px', height: hgt + 'px' });
  const tl = s('svg', { width: 120, height: 90, style: `position:absolute;left:${tail === 'left' ? 70 : w - 170}px;top:${hgt - 6}px` }, el);
  s('path', { d: tail === 'left' ? 'M8 0 L70 0 L20 80Z' : 'M50 0 L112 0 L100 80Z', fill: C.ink2, stroke: C.cream, 'stroke-width': 6, 'stroke-linejoin': 'round' }, tl);
  s('rect', { x: 4, y: -10, width: 112, height: 14, fill: C.ink2 }, tl);
  const nameEl = h('div', { class: 'name', html: `${name}${tag ? `<small>${tag}</small>` : ''}` }, el);
  Object.assign(nameEl.style, { left: '-28px', top: '-52px', background: ch.color });
  const zl = h('div', { class: 'zhline' }, el);
  Object.assign(zl.style, { left: '58px', top: '42px' });
  const spans = [...main].map(c => h('span', { text: c }, zl));
  const rate = cps || Math.max(16, spans.length * 1.7);
  const el2 = h('div', { class: 'enline', text: sub }, el);
  Object.assign(el2.style, { left: '64px', top: hgt - 58 + 'px', display: sub ? '' : 'none' });
  if (!sub) zl.style.top = (hgt - 64) / 2 + 'px';
  const set = (t, t0, t1) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const pin = E.outBack(prog(t0, t0 + 0.2, t)), pout = E.in3(prog(t1 - 0.12, t1, t));
    T(el, { x: x - pout * 60, y: y + (1 - pin) * 40, s: lerp(0.7, 1, pin) * (1 - pout * 0.1), r: (1 - pin) * -6, o: Math.min(1, pin * 1.5) * (1 - pout), ox: '0%', oy: '100%' });
    const n = Math.floor((t - t0 - 0.08) * rate);
    spans.forEach((sp, i) => { sp.style.opacity = i <= n ? 1 : 0; });
    el2.style.opacity = clamp((t - t0 - 0.25) * 4);
    nameEl.style.transform = `rotate(${-5 + (1 - pin) * -12}deg) scale(${lerp(1.4, 1, pin)})`;
  };
  return { el, set };
}

// ---------------------------------------------------------------- jagged speech bubble
export function bubble(parent, { who, name, main, sub = '', x, y, w = 640, hgt = 170, seed = 3, tailTo = null }) {
  const ch = CAST[who];
  const el = h('div', { class: 'abs' }, parent);
  const sv = s('svg', { width: w + 80, height: hgt + 140, style: 'position:absolute;left:-40px;top:-40px' }, el);
  const g = s('g', { transform: 'translate(40 40)' }, sv);
  if (tailTo) s('path', { d: `M${w * 0.3} ${hgt - 20} L${tailTo[0] - x + 40 - 40} ${tailTo[1] - y} L${w * 0.45} ${hgt - 20}Z`, fill: '#fff', stroke: C.ink2, 'stroke-width': 8, 'stroke-linejoin': 'round' }, g);
  s('polygon', { points: jagRect(w, hgt, 14, 46, seed), fill: '#fff', stroke: C.ink2, 'stroke-width': 8, 'stroke-linejoin': 'round' }, g);
  s('rect', { x: 10, y: 10, width: w - 20, height: hgt - 20, fill: '#fff' }, g);
  const tag = h('div', { class: 'zh', text: name }, el);
  Object.assign(tag.style, { position: 'absolute', left: '-18px', top: '-34px', padding: '4px 14px 6px', background: ch.color, color: C.ink, font: '900 30px/1 "Noto Sans SC"', border: `5px solid ${C.ink2}`, transform: 'rotate(-6deg)' });
  const zl = h('div', { class: 'zh nowrap', text: main }, el);
  Object.assign(zl.style, { position: 'absolute', left: '36px', top: sub ? '30px' : (hgt - 62) / 2 + 'px', font: '900 56px/1.1 "Noto Sans SC"', color: C.ink2 });
  const enl = h('div', { class: 'hud nowrap', text: sub }, el);
  Object.assign(enl.style, { position: 'absolute', left: '40px', top: hgt - 50 + 'px', font: '600 24px/1 "Barlow Condensed"', color: C.red, letterSpacing: '.16em' });
  const set = (t, t0, t1) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const pin = E.outBack(prog(t0, t0 + 0.18, t)), pout = E.in3(prog(t1 - 0.1, t1, t));
    const wob = Math.sin((t - t0) * 9) * 0.8;
    T(el, { x, y, s: lerp(0.3, 1, pin) * (1 - pout), r: (1 - pin) * 10 + wob, o: 1 - pout, ox: '30%', oy: '100%' });
  };
  return { el, set };
}

// ---------------------------------------------------------------- cut-in strip
/** Character eye cut-in: a skewed band across the screen with a giant face. */
export function cutin(parent, { who, y = 540, hgt = 330, rot = -7, faceX = 1100, scale = 17 }) {
  const ch = CAST[who];
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { left: '-400px', top: y - hgt / 2 + 'px', width: '2720px', height: hgt + 'px', overflow: 'hidden', transformOrigin: '50% 50%' });
  const bg = h('div', { class: 'fill' }, el);
  bg.style.background = `${halftone('rgba(0,0,0,.18)', 16, 32)}, ${ch.dark}`;
  const lines = s('svg', { width: 2720, height: hgt, style: 'position:absolute;left:0;top:0' }, el);
  const st = s('path', { d: streaks(26, 2720, hgt, 11, 0.2, 0.7, 5), fill: 'rgba(255,255,255,.35)' }, lines);
  const face = s('svg', { width: 2720, height: hgt, style: 'position:absolute;left:0;top:0' }, el);
  const g = s('g', {}, face);
  const p = person({ color: ch.color, crown: false });
  g.appendChild(p.el);
  const edge = h('div', { class: 'fill' }, el);
  edge.style.boxShadow = `inset 0 12px 0 ${C.ink2}, inset 0 -12px 0 ${C.ink2}, inset 0 18px 0 ${C.cream}, inset 0 -18px 0 ${C.cream}`;
  const set = (t, t0, t1, eyes = 'open', extra = {}) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const pin = E.outExpo(prog(t0, t0 + 0.16, t)), pout = E.inExpo(prog(t1 - 0.14, t1, t));
    const drift = (t - t0) * 40;
    T(el, { x: (1 - pin) * -2600 + pout * 2600, r: rot, sy: lerp(0.2, 1, pin) });
    ST(g, { x: faceX - drift, y: hgt / 2 + scale * 90, s: scale });
    p.set({ eyes, ...extra });
    st.setAttribute('transform', `translate(${-((t * 1400) % 1360)} 0)`);
  };
  return { el, set, person: p };
}

// ---------------------------------------------------------------- shared screen (bezel)
export function screen(parent, { x, y, w, hgt }) {
  const el = h('div', { class: 'bezel' }, parent);
  Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px' });
  const content = h('div', { class: 'content' }, el);
  h('div', { class: 'gloss' }, el);
  return { el, content, w: w - 36, h: hgt - 36 };
}

// ---------------------------------------------------------------- back-of-head silhouettes (OTS)
export function heads(parent, { y = 1000, xs = [560, 840, 1110, 1380], who = ['tuan', 'yuan', 'dian', 'cong'], scale = 3.2 } = {}) {
  const sv = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, parent);
  const sofaG = s('g', {}, sv);
  const sf = sofa({ width: 1500 });
  sofaG.appendChild(sf.el);
  ST(sofaG, { x: 210, y: y - 40, s: 1, sy: 1 });
  const list = who.map((k, i) => {
    const ch = CAST[k];
    const g = s('g', {}, sv);
    const body = s('path', { d: 'M-35 52c0-33 12.5-50 35-50s35 17 35 50v30h-70Z', fill: ch.color }, g);
    const head = s('circle', { cx: 0, cy: -31, r: 20, fill: ch.color }, g);
    const shade = s('path', { d: 'M-35 56c0-30 12.5-46 35-46s35 16 35 46v30h-70Z', fill: C.ink2, opacity: 0.55 }, g);
    const hs = s('circle', { cx: 2, cy: -29, r: 18.6, fill: C.ink2, opacity: 0.55 }, g);
    let crown = null;
    if (ch.crown) crown = s('path', { d: 'M-14-61-18-75-6-69 0-78 6-69 18-75 14-61Z', fill: C.yellow, stroke: C.ink, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, g);
    return { k, g, x: xs[i], y, head };
  });
  const set = (t, opts = {}) => {
    list.forEach((o, i) => {
      const b = opts.bob ? opts.bob(i, t) : 0;
      const tilt = opts.tilt ? opts.tilt(i, t) : 0;
      ST(o.g, { x: o.x, y: o.y + b, s: scale, r: tilt });
    });
  };
  return { el: sv, list, set, sofa: sofaG };
}

// ---------------------------------------------------------------- the sofa room (front view)
/** Front view: brand sofa with up to four seated characters. seat(i) → person controller. */
export function room(parent, { k = 1.55, sofaY = 650, cx = 960, who = ['tuan', 'yuan', 'dian', 'cong'], fr = [0.14, 0.38, 0.62, 0.86] } = {}) {
  const sv = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, parent);
  const sw = 640 * k, sx = cx - sw / 2;
  const shadow = s('ellipse', { cx, cy: sofaY + 165 * k, rx: sw * 0.56, ry: 26, fill: '#000', opacity: 0.35 }, sv);
  const sofaG = s('g', {}, sv);
  const sf = sofa({ width: 640 });
  sofaG.appendChild(sf.el);
  ST(sofaG, { x: sx, y: sofaY, s: k });
  const seats = who.map((key, i) => {
    const ch = CAST[key];
    const p = person({ color: ch.color, crown: !!ch.crown });
    sv.appendChild(p.el);
    return { key, p, x: sx + 640 * k * fr[i], y: sofaY + 67 * k, s: 1.9 * k };
  });
  const front = s('g', {}, sv); // things drawn in front of the characters (cushion, splats)
  return { el: sv, sofaG, seats, front, sx, sw, k, sofaY, cushion: sf.parts.seat };
}

// ---------------------------------------------------------------- danmaku
export function danmaku(parent, items, { left = 0, right = 1920, speed = 620 } = {}) {
  const box = h('div', { class: 'fill' }, parent);
  box.style.overflow = 'hidden';
  const els = items.map(it => {
    const d = h('div', { class: 'dm ' + (it.cls || '') }, box);
    d.innerHTML = it.html || '';
    if (!it.html) d.textContent = it.text;
    if (it.size) d.style.fontSize = it.size + 'px';
    return { d, ...it };
  });
  const set = t => {
    for (const e of els) {
      const dt = t - e.t0, sp = e.speed || speed;
      const on = dt >= 0 && dt < (right - left + 1400) / sp;
      show(e.d, on);
      if (on) T(e.d, { x: right - dt * sp, y: e.y });
    }
  };
  return { el: box, set };
}

// ---------------------------------------------------------------- callout (microtype label)
export function callout(parent, { x, y, main, sub = '', ax, ay, side = 'right' }) {
  const el = h('div', { class: 'callout' }, parent);
  const sv = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, el);
  const line = s('path', { d: `M${ax} ${ay}L${(ax + x) / 2} ${ay}L${x} ${y + 24}`, fill: 'none', stroke: C.cream, 'stroke-width': 3, 'stroke-dasharray': '2000', 'stroke-dashoffset': 2000 }, sv);
  const dot = s('circle', { cx: ax, cy: ay, r: 9, fill: C.red, stroke: C.cream, 'stroke-width': 3 }, sv);
  const box = h('div', { class: 'box', html: `<b>${main}</b>${sub ? `<i>${sub}</i>` : ''}` }, el);
  Object.assign(box.style, { left: x + (side === 'left' ? -10 : 0) + 'px', top: y + 'px', transformOrigin: side === 'left' ? '100% 50%' : '0% 50%' });
  if (side === 'left') box.style.transform = 'translateX(-100%)';
  const set = (t, t0, t1) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const p = prog(t0, t0 + 0.25, t), q = prog(t1 - 0.15, t1, t);
    line.setAttribute('stroke-dashoffset', 2000 * (1 - E.out3(p)));
    dot.setAttribute('r', 9 * E.outBack(prog(t0, t0 + 0.12, t)));
    const bp = E.outBack(prog(t0 + 0.12, t0 + 0.3, t));
    box.style.transform = `${side === 'left' ? 'translateX(-100%) ' : ''}scaleX(${bp}) translateY(${q * -20}px)`;
    el.style.opacity = 1 - q;
  };
  return { el, set };
}

// ---------------------------------------------------------------- stamp
export function stamp(parent, { main, sub = '', x, y, rot = -9, color = C.red, size = 74, face = null }) {
  const el = h('div', { class: 'stamp', html: `${main}${sub ? `<small>${sub}</small>` : ''}` }, parent);
  if (face) el.style.fontFamily = face;
  Object.assign(el.style, { left: x + 'px', top: y + 'px', borderColor: color, color, fontSize: size + 'px',
    WebkitMaskImage: `url(${grungeURL()})`, WebkitMaskSize: '600px', maskImage: `url(${grungeURL()})`, maskSize: '600px' });
  const set = (t, t0, t1 = 1e9) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const p = prog(t0, t0 + 0.12, t);
    T(el, { s: lerp(2.6, 1, E.in3(p)), r: rot, o: Math.min(1, p * 3) * (1 - prog(t1 - 0.12, t1, t)) });
  };
  return { el, set };
}

// ---------------------------------------------------------------- thrown reactions
/**
 * A tomato/poop thrown along a parabola; tomatoes splat on impact and drip, poop bounces.
 * Returns update(t).
 */
export function thrown(parent, { kind = 'tomato', from, to, t0, dur = 0.42, arc = 260, size = 120, seed = 1, splatR = 120, life = 3, spin = 540 }) {
  const el = h('div', { class: 'abs' }, parent);
  const glyph = reaction(kind, size);
  el.appendChild(glyph);
  const sp = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, parent);
  const g = s('g', {}, sp);
  const sh = splat(seed, splatR);
  const col = kind === 'tomato' ? '#e2473a' : '#8a6446';
  const core = s('path', { d: sh.core, fill: col }, g);
  const hi = s('path', { d: sh.core, fill: kind === 'tomato' ? '#ff7a5c' : '#a98262', transform: 'scale(.55) translate(-10 -14)' }, g);
  const drops = sh.drops.map(([x, y, r]) => s('circle', { cx: x, cy: y, r, fill: col }, g));
  const drips = [0, 1, 2].map(i => s('rect', { x: -splatR * 0.5 + i * splatR * 0.45, y: 0, width: splatR * 0.16, height: 10, rx: splatR * 0.08, fill: col }, g));
  if (kind === 'tomato') {
    const seeds = s('g', { fill: '#ffd7a8' }, g);
    const r = rng(seed + 5);
    for (let i = 0; i < 7; i++) s('ellipse', { cx: (r() - 0.5) * splatR, cy: (r() - 0.5) * splatR * 0.8, rx: 5, ry: 8, transform: `rotate(${r() * 180})` }, seeds);
  }
  const update = t => {
    const fly = t >= t0 && t < t0 + dur;
    const hit = t >= t0 + dur && t < t0 + dur + life;
    show(el, fly || (kind === 'poop' && hit));
    show(sp, kind === 'tomato' && hit);
    if (fly) {
      const p = (t - t0) / dur;
      const x = lerp(from[0], to[0], p), y = lerp(from[1], to[1], p) - Math.sin(p * Math.PI) * arc;
      T(el, { x: x - size / 2, y: y - size / 2, r: p * spin, s: lerp(0.6, 1.15, p) });
    } else if (hit && kind === 'poop') {
      const q = t - t0 - dur;
      const bounce = Math.abs(Math.sin(q * 11)) * Math.exp(-q * 6) * 60;
      const sq = 1 - Math.exp(-q * 9) * Math.cos(q * 30) * 0.25;
      T(el, { x: to[0] - size / 2, y: to[1] - size / 2 - bounce, sy: sq, sx: 2 - sq, o: 1 - prog(life - 0.3, life, q), oy: '100%' });
    }
    if (hit && kind === 'tomato') {
      const q = t - t0 - dur;
      const k = E.outExpo(clamp(q / 0.09));
      ST(g, { x: to[0], y: to[1], s: lerp(0.2, 1, k) * (1 + q * 0.02) });
      drops.forEach((d, i) => d.setAttribute('transform', `scale(${clamp(q / 0.12)})`));
      drips.forEach((d, i) => d.setAttribute('height', Math.min(splatR * 1.3, 10 + Math.max(0, q - 0.15) * (90 + i * 50))));
      sp.style.opacity = 1 - prog(life - 0.4, life, q);
    }
  };
  return update;
}

// ---------------------------------------------------------------- shutter wipe
/** Diagonal bars sweep across the frame: cover during [t0, t0+d], uncover during [t0+d, t0+2d]. */
export function wipe(parent, { t0, d = 0.16, colors = [C.yellow, C.ink2, C.red, C.cream, C.ink2], angle = -20 }) {
  const el = h('div', { class: 'fill' }, parent);
  el.style.pointerEvents = 'none';
  const bars = colors.map((c, i) => {
    const b = h('div', { class: 'abs' }, el);
    Object.assign(b.style, { left: '-600px', width: '3200px', height: 1600 / colors.length + 4 + 'px', top: -260 + i * (1600 / colors.length) + 'px', background: c, transformOrigin: '50% 50%' });
    return b;
  });
  const update = t => {
    const on = t >= t0 && t < t0 + 2 * d + 0.08;
    show(el, on);
    if (!on) return;
    bars.forEach((b, i) => {
      const lag = i * 0.018;
      const a = E.out3(prog(t0 + lag, t0 + d + lag, t)), z = E.in3(prog(t0 + d + lag, t0 + 2 * d + lag, t));
      const x = z > 0 ? z * 3400 : (a - 1) * 3400;
      b.style.transform = `rotate(${angle}deg) translateX(${x}px)`;
    });
  };
  return { el, update };
}

// ---------------------------------------------------------------- cursor (the product's film cursor)
export function cursor(parent, { color = '#203037', edge = '#faf5e7', size = 58 } = {}) {
  const el = s('svg', { width: size, height: (size * 70) / 60, viewBox: '0 0 60 70', style: 'position:absolute;left:0;top:0;overflow:visible;transform-origin:0 0' }, parent);
  s('path', { d: 'M3 3v55l16-16 13 27 14-6-14-27 27-3Z', fill: color, stroke: edge, 'stroke-width': 4, 'stroke-linejoin': 'round' }, el);
  const ring = s('circle', { cx: 3, cy: 3, r: 10, fill: 'none', stroke: C.yellow, 'stroke-width': 5, opacity: 0 }, el);
  const set = (x, y, press = 0, o = 1, click = -1) => {
    T(el, { x, y, s: 1 - press * 0.16, o });
    if (click >= 0 && click < 1) { ring.setAttribute('r', 10 + click * 46); ring.setAttribute('opacity', 1 - click); }
    else ring.setAttribute('opacity', 0);
  };
  return { el, set };
}

// ---------------------------------------------------------------- the calling card
/** Invitation "calling card": cream front with ransom headline, yellow back with the mascot. */
export function callingCard(parent, { w = 560, hgt = 780, lines, sign, top: topLabel = 'No.9527', seed = 12, sizes = [112, 128] } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: hgt + 'px', transformStyle: 'preserve-3d' });
  const cut = 'polygon(30px 0, calc(100% - 30px) 0, 100% 30px, 100% calc(100% - 30px), calc(100% - 30px) 100%, 30px 100%, 0 calc(100% - 30px), 0 30px)';
  const face = (bg) => {
    const f = h('div', { class: 'fill' }, el);
    Object.assign(f.style, { background: C.ink2, clipPath: cut, backfaceVisibility: 'hidden' });
    const inner = h('div', { class: 'abs' }, f);
    Object.assign(inner.style, { left: '12px', top: '12px', width: w - 24 + 'px', height: hgt - 24 + 'px', background: bg, clipPath: 'polygon(22px 0, calc(100% - 22px) 0, 100% 22px, 100% calc(100% - 22px), calc(100% - 22px) 100%, 22px 100%, 0 calc(100% - 22px), 0 22px)', overflow: 'hidden' });
    return { f, inner };
  };
  const front = face(C.cream);
  front.inner.style.backgroundImage = `url(${paperURL()})`;
  const band = h('div', { class: 'abs' }, front.inner);
  Object.assign(band.style, { left: '-80px', top: '250px', width: w + 160 + 'px', height: '260px', background: C.yellow, transform: 'rotate(-11deg)' });
  const top = h('div', { class: 'abs hud nowrap', html: `<span>PIIK · INVITATION</span><span>${topLabel}</span>` }, front.inner);
  Object.assign(top.style, { left: '0', top: '0', width: w - 24 + 'px', padding: '18px 26px', boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', background: C.ink2, color: C.cream, font: '600 22px/1 "Barlow Condensed"', letterSpacing: '.2em' });
  const r1 = ransom(front.inner, lines[0], { size: sizes[0], seed, tilt: 6, punctColor: C.ink2, punctScale: 0.8 });
  const r2 = ransom(front.inner, lines[1], { size: sizes[1], seed: seed + 7, tilt: 7, punctColor: C.ink2, punctScale: 0.8 });
  T(r1.el, { x: 40, y: 150 }); T(r2.el, { x: 44, y: 330 });
  const sg = h('div', { class: 'abs nowrap', text: sign }, front.inner);
  Object.assign(sg.style, { left: '220px', top: '545px', font: '400 62px/1 "Smiley Sans"', color: C.ink, transform: 'rotate(-4deg)' });
  const foot = h('div', { class: 'abs nowrap' }, front.inner);
  Object.assign(foot.style, { left: '26px', top: hgt - 24 - 92 + 'px', display: 'flex', alignItems: 'center', gap: '14px', font: '700 30px/1 "JetBrains Mono"', color: C.ink });
  const li = icon('link', { size: 40, color: C.ink, sw: 2.4 });
  foot.appendChild(li);
  h('span', { text: 'ROOM 9527' }, foot);
  const bc = s('svg', { width: 150, height: 40, style: 'position:absolute;left:' + (w - 24 - 190) + 'px;top:' + (hgt - 24 - 96) + 'px' }, front.inner);
  barcode(bc, { w: 150, h: 40, seed: 31 });
  const seal = h('div', { class: 'abs center' }, front.inner);
  Object.assign(seal.style, { left: w - 24 - 205 + 'px', top: '590px', width: '150px', height: '150px', borderRadius: '50%', border: `7px solid ${C.red}`, transform: 'rotate(14deg)', WebkitMaskImage: `url(${grungeURL()})`, WebkitMaskSize: '300px', maskImage: `url(${grungeURL()})`, maskSize: '300px' });
  const sm = mascot({ stroke: C.red, size: 100, sparkles: false });
  seal.appendChild(sm.el);
  const back = face(C.yellow);
  back.f.style.transform = 'rotateY(180deg)';
  back.inner.style.background = `${stripes('rgba(25,37,48,.12)', 'transparent', 22, -45)}, ${C.yellow}`;
  const bm = mascot({ stroke: C.ink, fill: C.cream, size: 320, sparkles: false });
  back.inner.appendChild(bm.el);
  Object.assign(bm.el.style, { position: 'absolute', left: (w - 24 - 320) / 2 + 'px', top: '180px' });
  const bw = h('div', { class: 'abs nowrap', html: 'Piik<span class="identity-dot">.</span>' }, back.inner);
  Object.assign(bw.style, { left: '0', width: w - 24 + 'px', textAlign: 'center', top: '540px', font: WORDMARK(120), letterSpacing: '-6px', color: C.ink });
  return { el, front, back, r1, r2, sg };
}

// ---------------------------------------------------------------- browser + devices
/** Stylised browser window showing the shared screen. Returns {el, content}. */
export function browser(parent, { w = 520, hgt = 420, label = 'ROOM 9527', dark = false } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: hgt + 'px', background: C.paper, borderRadius: '18px', border: `5px solid ${C.ink2}`, overflow: 'hidden', boxShadow: `10px 12px 0 ${C.ink2}` });
  const bar = h('div', { class: 'abs' }, el);
  Object.assign(bar.style, { left: 0, top: 0, width: '100%', height: '58px', background: '#e9edf3', borderBottom: `4px solid ${C.ink2}`, display: 'flex', alignItems: 'center', gap: '10px', padding: '0 16px', boxSizing: 'border-box' });
  ['#ff6b5e', '#ffc542', '#3fc46b'].forEach(c => { const d = h('i', {}, bar); Object.assign(d.style, { width: '14px', height: '14px', borderRadius: '50%', background: c, display: 'block', border: `2px solid ${C.ink2}` }); });
  const addr = h('div', { class: 'mono nowrap' }, bar);
  Object.assign(addr.style, { marginLeft: '12px', flex: 1, height: '34px', borderRadius: '17px', background: '#fff', border: `3px solid ${C.ink2}`, display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px', font: '700 18px/1 "JetBrains Mono"', color: C.ink });
  addr.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${C.ink}" stroke-width="2.6" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>${label}</span>`;
  const content = h('div', { class: 'abs' }, el);
  Object.assign(content.style, { left: 0, top: '62px', width: '100%', height: hgt - 62 + 'px', overflow: 'hidden', background: '#0c1219' });
  return { el, content, cw: w - 10, ch: hgt - 72 };
}
