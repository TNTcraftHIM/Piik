// Film D kit — Tactile motion design around the real UI: soft UI-wall backgrounds, tactile device cards,
// pill chips with 3 px bottom shadows, "click" stickers, the chapter rail, keycaps, danmaku/toss overlays, tiles.
import { h, s, T, ST, O, kf, prog, E, clamp, lerp, rng, show, pulse, TAU } from '../../engine/core.js';
import { C, mascot, icon, reaction, splat } from '../../engine/art.js';

export const D = {
  wall: '#f3f5f8', wall2: '#e5eaf2', paper: '#fffefb', ink: '#29374a', ink2: '#192530', primary: '#2765ce',
  action: '#3478e5', live: '#2fa66a', danger: '#d64541', yellow: '#ffd05a', line: '#d6dde8',
  p1: 'oklch(0.7015 0.1204 148.3619)', p2: 'oklch(0.7100 0.1156 235.7427)', p3: 'oklch(0.7347 0.1109 308.7381)',
};
export const TACTILE = '0 4px 0 rgba(36,53,78,.16), 0 14px 30px rgba(36,53,78,.13)';
// single quotes inside: these strings also go into inline style="" attributes
export const FONT_ZH = "'Noto Sans SC', system-ui, sans-serif";
export const FONT_EN = "Nunito, 'Noto Sans SC', system-ui, sans-serif";
export const fontFor = lang => (lang === 'en' ? FONT_EN : FONT_ZH);

// ---------------------------------------------------------------- background
/** Soft wall with a dot grid and slow pastel blobs that bounce a little on the beat. Returns update(t, beatPhase). */
export function wallBG(root) {
  const el = h('div', { class: 'fill' }, root);
  el.style.background = D.wall;
  const dots = h('div', { class: 'fill' }, el);
  dots.style.background = `radial-gradient(circle, ${D.wall2} 2.2px, transparent 2.6px) 0 0 / 34px 34px`;
  const blobs = [[D.yellow, 520, 260, 210], [D.p2, 1500, 820, 260], [D.p1, 1650, 200, 170], [D.p3, 260, 880, 200]].map(([c, x, y, r], i) => {
    const b = h('div', { class: 'abs' }, el);
    Object.assign(b.style, { width: r * 2 + 'px', height: r * 2 + 'px', borderRadius: '50%', background: `radial-gradient(circle at 40% 35%, color-mix(in oklab, ${c} 55%, white), transparent 68%)`, opacity: 0.55 });
    return { b, x, y, r, i };
  });
  return (t, beat = 0) => {
    for (const o of blobs) {
      const bob = Math.sin(t * 0.6 + o.i * 1.7) * 18;
      const k = 1 + 0.03 * Math.max(0, Math.cos(beat * TAU));
      T(o.b, { x: o.x - o.r + Math.cos(t * 0.35 + o.i) * 24, y: o.y - o.r + bob, s: k });
    }
  };
}

// ---------------------------------------------------------------- device cards around a real-UI box
/**
 * Wrap a realUI() box in a tactile window. kind 'app' (Piik desktop App) or 'browser' (viewer's browser).
 * Card inner size = UI 1100×740 + chrome. Returns {el, set({x,y,s,o,r}), toScreen(ux,uy), W, H}.
 */
export function deviceCard(parent, ui, { kind = 'app', title = '', addr = '', lang = 'zh' } = {}) {
  const PAD = 12, BAR = kind === 'browser' ? 60 : 52;
  const W = 1100 + PAD * 2, H = 740 + BAR + PAD;
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: W + 'px', height: H + 'px', transformOrigin: '0 0', borderRadius: '30px', background: D.paper, boxShadow: `${TACTILE}, inset 0 0 0 2px ${D.line}` });
  const bar = h('div', { class: 'abs' }, el);
  Object.assign(bar.style, { left: '0', top: '0', width: W + 'px', height: BAR + 'px', display: 'flex', alignItems: 'center', gap: '12px', padding: '0 22px', boxSizing: 'border-box', font: `800 20px/1 ${fontFor(lang)}`, color: D.ink });
  if (kind === 'app') {
    const m = mascot({ stroke: D.ink2, size: 30, sparkles: false });
    bar.appendChild(m.el);
    h('span', { text: 'Piik' }, bar);
    const sub = h('span', { text: '· ' + title }, bar);
    sub.style.cssText = 'font-weight:600;opacity:.55';
    const sp = h('span', {}, bar); sp.style.flex = '1';
    ['—', '▢', '✕'].forEach(g => { const d = h('span', { text: g }, bar); d.style.cssText = `width:30px;text-align:center;font:600 16px/1 system-ui;opacity:.45`; });
  } else {
    ['#ff6b5e', '#ffc542', '#3fc46b'].forEach(c => { const d = h('i', {}, bar); Object.assign(d.style, { width: '14px', height: '14px', borderRadius: '50%', background: c, display: 'block', flex: 'none' }); });
    const pill = h('div', {}, bar);
    Object.assign(pill.style, { marginLeft: '14px', flex: '1', height: '36px', borderRadius: '18px', background: D.wall, boxShadow: `inset 0 0 0 2px ${D.line}`, display: 'flex', alignItems: 'center', gap: '10px', padding: '0 16px', font: `700 18px/1 ${fontFor(lang)}`, color: D.ink });
    pill.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${D.live}" stroke-width="2.6" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>${addr}</span>`;
    const who = h('div', { text: title }, bar);
    Object.assign(who.style, { padding: '8px 14px', borderRadius: '16px', background: D.wall2, font: `800 17px/1 ${fontFor(lang)}` });
  }
  const body = h('div', { class: 'abs' }, el);
  Object.assign(body.style, { left: PAD + 'px', top: BAR + 'px', width: '1100px', height: '740px', borderRadius: '18px', overflow: 'hidden', boxShadow: `inset 0 0 0 2px ${D.line}` });
  body.appendChild(ui.el);
  let cur = { x: 0, y: 0, s: 1 };
  const set = (p) => {
    cur = { x: p.x ?? 0, y: p.y ?? 0, s: p.s ?? 1 };
    el.style.transform = `translate(${cur.x.toFixed(2)}px, ${cur.y.toFixed(2)}px) scale(${cur.s.toFixed(4)})${p.r ? ` rotate(${p.r}deg)` : ''}`;
    if (p.o !== undefined) { el.style.opacity = clamp(p.o); show(el, p.o > 0.002); }
  };
  /** UI px → stage px for the current transform (rotation ignored). */
  const toScreen = (ux, uy) => ({ x: cur.x + (PAD + ux) * cur.s, y: cur.y + (BAR + uy) * cur.s });
  /** Card transform that puts UI point (ux,uy) at stage (sx,sy) with scale s. */
  const focus = (ux, uy, s2, sx, sy) => ({ x: sx - (PAD + ux) * s2, y: sy - (BAR + uy) * s2, s: s2 });
  return { el, set, toScreen, focus, W, H, PAD, BAR };
}

// ---------------------------------------------------------------- chips
/** Tactile pill chip: optional icon, main text and a small sub line. set(t, t0, t1, {x,y}) — (x,y) = left-middle. */
export function chip(parent, { text, sub = '', iconName = null, color = D.primary, lang = 'zh', size = 1, dark = false } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { display: 'flex', alignItems: 'center', gap: `${14 * size}px`, padding: `${14 * size}px ${26 * size}px ${14 * size}px ${16 * size}px`, borderRadius: `${40 * size}px`, background: dark ? D.ink2 : D.paper, color: dark ? D.paper : D.ink2, boxShadow: `0 ${4 * size}px 0 rgba(36,53,78,.18), 0 ${12 * size}px ${26 * size}px rgba(36,53,78,.14), inset 0 0 0 ${2 * size}px ${dark ? 'transparent' : D.line}`, whiteSpace: 'nowrap', transformOrigin: '0% 50%' });
  const dot = h('div', {}, el);
  Object.assign(dot.style, { width: `${48 * size}px`, height: `${48 * size}px`, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', boxShadow: `inset 0 -${3 * size}px 0 rgba(0,0,0,.14)` });
  if (iconName) dot.appendChild(icon(iconName, { size: 28 * size, color: '#fff', sw: 2.4 }));
  const tx = h('div', {}, el);
  const a = h('div', { text }, tx);
  Object.assign(a.style, { font: `900 ${32 * size}px/1.1 ${fontFor(lang)}`, letterSpacing: lang === 'en' ? '-.005em' : '0' });
  let b = null;
  if (sub) {
    b = h('div', { text: sub }, tx);
    Object.assign(b.style, { marginTop: `${6 * size}px`, font: `700 ${19 * size}px/1.2 ${fontFor(lang)}`, opacity: 0.62 });
  }
  const set = (t, t0, t1, p = {}) => {
    const on = t >= t0 && t < t1;
    show(el, on);
    if (!on) return;
    const k = E.outBack(prog(t0, t0 + 0.32, t));
    const q = E.in3(prog(t1 - 0.18, t1, t));
    const x = p.cx !== undefined ? p.cx - (el.offsetWidth || 400) / 2 : p.x ?? 0;
    T(el, { x, y: (p.y ?? 0) - (el.offsetHeight || 76 * size) / 2 + (1 - k) * 14, s: lerp(0.6, 1, k) * (1 - q * 0.15), o: Math.min(1, k * 1.6) * (1 - q), ox: p.cx !== undefined ? '50%' : p.origin || '0%', oy: '50%' });
  };
  return { el, set };
}

// ---------------------------------------------------------------- click sticker
/** The "咔哒 / Click" sticker + ring + rays at a stage point. set(t, t0, {x,y}) */
export function clickFx(parent, { label = '咔哒', lang = 'zh', color = D.yellow } = {}) {
  const el = h('div', { class: 'abs' }, parent);
  const sv = s('svg', { width: 260, height: 260, viewBox: '-130 -130 260 260', style: 'position:absolute;left:-130px;top:-130px;overflow:visible' }, el);
  const ring = s('circle', { r: 20, fill: 'none', stroke: D.ink2, 'stroke-width': 5 }, sv);
  const ring2 = s('circle', { r: 20, fill: 'none', stroke: color, 'stroke-width': 10 }, sv);
  const rays = [...Array(8)].map((_, i) => s('path', { d: '', stroke: D.ink2, 'stroke-width': 7, 'stroke-linecap': 'round' }, sv));
  const tag = h('div', { text: label }, el);
  Object.assign(tag.style, { position: 'absolute', left: '26px', top: '-86px', padding: '8px 18px 10px', borderRadius: '24px', background: color, color: D.ink2, font: `900 30px/1 ${fontFor(lang)}`, boxShadow: `0 4px 0 ${D.ink2}`, border: `3px solid ${D.ink2}`, whiteSpace: 'nowrap', transformOrigin: '0% 100%' });
  const set = (t, t0, p) => {
    const q = (t - t0) / 0.55;
    const on = q >= 0 && q < 1;
    show(el, on);
    if (!on) return;
    T(el, { x: p.x, y: p.y });
    const r = 18 + E.outExpo(q) * 70;
    ring.setAttribute('r', r); ring.setAttribute('opacity', 1 - q);
    ring2.setAttribute('r', r * 0.82); ring2.setAttribute('opacity', (1 - q) * 0.9);
    rays.forEach((ry, i) => {
      const a = (i / 8) * TAU + 0.3, r0 = 30 + E.outExpo(q) * 50, r1 = r0 + 26 * (1 - q);
      ry.setAttribute('d', `M${Math.cos(a) * r0} ${Math.sin(a) * r0}L${Math.cos(a) * r1} ${Math.sin(a) * r1}`);
      ry.setAttribute('opacity', 1 - q);
    });
    const k = E.outBack(clamp(q * 4)), out = E.in3(prog(0.6, 1, q));
    tag.style.transform = `scale(${(lerp(0.3, 1, k) * (1 - out * 0.3)).toFixed(3)}) rotate(${-6 + (1 - k) * -14}deg)`;
    tag.style.opacity = 1 - out;
  };
  return { el, set };
}

// ---------------------------------------------------------------- chapter rail
export function stepper(parent, { labels, lang = 'zh' }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { display: 'flex', gap: '10px', alignItems: 'center', padding: '10px', borderRadius: '34px', background: 'rgba(255,254,251,.9)', boxShadow: `0 3px 0 rgba(36,53,78,.12), inset 0 0 0 2px ${D.line}` });
  const items = labels.map((l, i) => {
    const d = h('div', {}, el);
    Object.assign(d.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px 9px 9px', borderRadius: '24px', font: `800 19px/1 ${fontFor(lang)}`, color: D.ink, whiteSpace: 'nowrap' });
    const n = h('span', { text: String(i + 1) }, d);
    Object.assign(n.style, { width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `900 16px/1 ${FONT_EN}`, background: D.wall2, color: D.ink });
    h('span', { text: l }, d);
    return { d, n };
  });
  const set = (t, idx, pIn = 1) => {
    show(el, pIn > 0.002);
    el.style.opacity = pIn;
    items.forEach((it, i) => {
      const cur = i === idx, done = i < idx;
      it.d.style.background = cur ? D.yellow : 'transparent';
      it.d.style.boxShadow = cur ? `0 3px 0 ${D.ink2}, inset 0 0 0 2px ${D.ink2}` : 'none';
      it.d.style.opacity = cur || done ? 1 : 0.5;
      it.n.style.background = done ? D.live : cur ? D.ink2 : D.wall2;
      it.n.style.color = done || cur ? '#fff' : D.ink;
      it.n.textContent = done ? '✓' : String(i + 1);
    });
  };
  return { el, set };
}

// ---------------------------------------------------------------- keycaps
export function keycaps(parent, { keys, color, label, lang = 'zh' }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 18px', borderRadius: '26px', background: D.paper, boxShadow: `${TACTILE}, inset 0 0 0 2px ${D.line}` });
  const caps = keys.map(k => {
    const c = h('div', { text: k }, el);
    Object.assign(c.style, { width: '58px', height: '58px', borderRadius: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `900 28px/1 ${FONT_EN}`, color: D.ink2, background: D.wall, boxShadow: `inset 0 -5px 0 ${D.line}, inset 0 0 0 2px ${D.line}` });
    return c;
  });
  const lab = h('div', { text: label }, el);
  Object.assign(lab.style, { marginLeft: '8px', font: `800 21px/1.2 ${fontFor(lang)}`, color: D.ink, whiteSpace: 'nowrap' });
  const set = (press = [0, 0]) => {
    caps.forEach((c, i) => {
      const p = press[i] || 0;
      c.style.background = p > 0.05 ? color : D.wall;
      c.style.color = p > 0.05 ? '#fff' : D.ink2;
      c.style.transform = `translateY(${p * 4}px)`;
      c.style.boxShadow = p > 0.05 ? `inset 0 -1px 0 rgba(0,0,0,.2)` : `inset 0 -5px 0 ${D.line}, inset 0 0 0 2px ${D.line}`;
    });
  };
  return { el, set };
}

// ---------------------------------------------------------------- danmaku over a rect (UI px, inside a realUI overlay)
export function danmakuIn(over, { lines, rect, t0, gap = 0.25, speed = 420, lang = 'zh' }) {
  const box = h('div', { class: 'abs' }, over);
  Object.assign(box.style, { left: rect[0] + 'px', top: rect[1] + 'px', width: rect[2] + 'px', height: rect[3] + 'px', overflow: 'hidden', borderRadius: '10px' });
  const items = lines.map((txt, i) => {
    const d = h('div', { text: txt }, box);
    Object.assign(d.style, { position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', font: `800 ${i % 3 === 0 ? 30 : 26}px/1 ${fontFor(lang)}`, color: ['#fff', D.yellow, '#bfe3ff', '#ffc2cf'][i % 4], WebkitTextStroke: `6px ${D.ink2}`, paintOrder: 'stroke fill' });
    return { d, at: t0 + i * gap, y: 18 + ((i * 53) % Math.max(60, rect[3] - 70)) };
  });
  return t => {
    for (const it of items) {
      const dt = t - it.at, on = dt >= 0 && dt < (rect[2] + 500) / speed;
      show(it.d, on);
      if (on) T(it.d, { x: rect[2] - dt * speed, y: it.y });
    }
  };
}

// ---------------------------------------------------------------- tossed reaction (UI px)
export function toss(over, { kind = 'tomato', from, to, t0, dur = 0.5, arc = 160, size = 64, seed = 1, life = 1.8 }) {
  const el = h('div', { class: 'abs' }, over);
  el.appendChild(reaction(kind, size));
  const sp = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, over);
  const g = s('g', {}, sp);
  const sh = splat(seed, size * 0.55);
  const col = kind === 'tomato' ? '#e2473a' : kind === 'poop' ? '#8a6446' : '#ff6b8b';
  s('path', { d: sh.core, fill: col }, g);
  const drops = sh.drops.map(([x, y, r]) => s('circle', { cx: x, cy: y, r, fill: col }, g));
  return t => {
    const fly = t >= t0 && t < t0 + dur, hit = t >= t0 + dur && t < t0 + dur + life;
    show(el, fly || (hit && kind !== 'tomato'));
    show(sp, hit && kind === 'tomato');
    if (fly) {
      const p = (t - t0) / dur;
      T(el, { x: lerp(from[0], to[0], p) - size / 2, y: lerp(from[1], to[1], p) - Math.sin(p * Math.PI) * arc - size / 2, r: p * 420, s: lerp(0.7, 1.1, p) });
    } else if (hit && kind !== 'tomato') {
      const q = t - t0 - dur, b = Math.abs(Math.sin(q * 10)) * Math.exp(-q * 5) * 30;
      T(el, { x: to[0] - size / 2, y: to[1] - size / 2 - b, o: 1 - prog(life - 0.3, life, q) });
    }
    if (hit && kind === 'tomato') {
      const q = t - t0 - dur;
      ST(g, { x: to[0], y: to[1], s: lerp(0.2, 1, E.outExpo(clamp(q / 0.1))) });
      drops.forEach(d => d.setAttribute('transform', `scale(${clamp(q / 0.12)})`));
      sp.style.opacity = 1 - prog(life - 0.4, life, q);
    }
  };
}

// ---------------------------------------------------------------- feature tile
export function tile(parent, { title, sub, iconName = null, glyph = null, color = D.primary, w = 420, hgt = 220, lang = 'zh', hero = false }) {
  const el = h('div', { class: 'abs' }, parent);
  Object.assign(el.style, { width: w + 'px', height: hgt + 'px', borderRadius: '34px', background: hero ? D.yellow : D.paper, boxShadow: `0 6px 0 ${hero ? D.ink2 : 'rgba(36,53,78,.18)'}, 0 18px 34px rgba(36,53,78,.14), inset 0 0 0 ${hero ? 4 : 2}px ${hero ? D.ink2 : D.line}`, transformOrigin: '50% 60%', overflow: 'hidden' });
  const ic = h('div', {}, el);
  Object.assign(ic.style, { position: 'absolute', left: '28px', top: '28px', width: (hero ? 96 : 72) + 'px', height: (hero ? 96 : 72) + 'px', borderRadius: '50%', background: hero ? D.ink2 : color, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 -4px 0 rgba(0,0,0,.15)' });
  if (iconName) ic.appendChild(icon(iconName, { size: hero ? 56 : 40, color: hero ? D.yellow : '#fff', sw: 2.3 }));
  if (glyph) ic.innerHTML = glyph;
  const a = h('div', { text: title }, el);
  Object.assign(a.style, { position: 'absolute', left: '28px', top: (hero ? 150 : 118) + 'px', font: `900 ${hero ? 76 : 40}px/1.05 ${fontFor(lang)}`, color: D.ink2, whiteSpace: 'nowrap' });
  const b = h('div', { text: sub }, el);
  Object.assign(b.style, { position: 'absolute', left: '30px', top: (hero ? 250 : 170) + 'px', font: `700 ${hero ? 26 : 20}px/1.25 ${fontFor(lang)}`, color: D.ink, opacity: 0.7, whiteSpace: 'nowrap' });
  const set = (t, t0, p) => {
    const k = E.outBack(prog(t0, t0 + 0.34, t));
    show(el, t >= t0);
    T(el, { x: p.x, y: p.y + (1 - k) * 60, s: lerp(0.4, 1, k), r: (1 - k) * (p.r ?? -6), o: Math.min(1, k * 2) });
  };
  return { el, set };
}

// small inline glyphs for features that have no product icon
export const GLYPH = {
  bolt: '<svg width="44" height="44" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7Z" fill="#fff"/></svg>',
  shield: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke-linecap="round"/></svg>',
  leaf: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19C4 11 9 5 20 4c0 10-5 15-13 15"/><path d="M5 19c3-5 6-8 10-10"/></svg>',
  code: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>',
};
