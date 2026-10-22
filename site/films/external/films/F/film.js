// Film F — 出金了！ / GOLD! 9:16 social cut, 140 BPM, 21 bars = 36 s, zh / en.
// A gacha ten-pull watch party: the host shares the game window, friends open the link in their browsers, the first
// pull is all blue, a friend takes remote control (host approves) and pulls a rainbow, and everyone screams at once.
// Graphic industrial HUD design around the cute Piik cast. Module contract: engine/ENGINE.md.
import { Film, clock, h, s, T, ST, O, kf, prog, E, clamp, lerp, hash, noise, show, pulse, shake, TAU } from '../../engine/core.js';
import { C, CAST, mascot, icon, reaction, sofa } from '../../engine/art.js';
import { grainLayer } from '../../engine/tex.js';
import { thrown, WORDMARK } from '../A/kit.js';
import { STRINGS } from './strings.js';
import {
  P, TIERS, FF, HEAD, fitPx, textW, clip, hazard, panel, brackets, lab, decoder, barcodeSVG, crest, star5, face, bust,
  cursor, gameWindow, BTN10, phone, idCard, chatFeed, controlDialog, prismRays, sparks, foilCard, rgbText,
} from './kit.js';

const u = p => new URL(p, import.meta.url).href;
const F = (family, file, weight) => ({ family, file, ...(weight ? { weight } : {}) });
export const meta = {
  id: 'F',
  title: { zh: '出金了！', en: 'GOLD!' },
  size: [1080, 1920], duration: 36, fps: 60, poster: 25.35, langs: ['zh', 'en'],
  css: [u('../../engine/film.css'), u('./style.css')],
  fonts: [
    F('Noto Sans SC', 'NotoSansSC-Variable.ttf', '100 900'),
    F('Smiley Sans', 'SmileySans-Oblique.ttf'),
    F('Anton', 'Anton.ttf'),
    F('Barlow Condensed', 'BarlowCondensed-ExtraBold.ttf', '800'),
    F('JetBrains Mono', 'JetBrainsMono[wght].ttf', '100 800'),
    F('Arimo', 'Arimo[wght].ttf', '400 700'),
  ],
  audio: { webm: u('../../out/F/audio/web.webm'), m4a: u('../../out/F/audio/web.m4a') },
};

const W = 1080, H = 1920;

export async function build(stage, { lang = 'zh', signal } = {}) {
  const cues = await (await fetch(u('./cues.json'), { signal })).json();
  const K = clock(cues.bpm, cues.beatsPerBar);
  const A = (b, beat = 1) => K.at(b, beat);
  const spb = K.spb;
  const film = new Film({ stage, width: W, height: H, duration: cues.length, fps: 60, background: P.bg, lang });
  film.clock = K;
  const S = (film.S = STRINGS[lang] || STRINGS.zh), EN = lang === 'en';
  const HD = HEAD(lang);
  const snap = t => Math.round(t * 60) / 60;
  const ZH = EN ? FF.lab : FF.zh;     // UI text face (en: condensed Latin, zh: Noto Sans SC)

  // scene boundaries (frame-snapped)
  const T_HOST = snap(A(2, 1)), T_ROOM = snap(A(3, 1)), T_SPLIT = snap(A(13, 1.5)), T_PAY = snap(A(17, 1)),
    T_SPEC = snap(A(18, 1)), T_END = snap(A(20, 1)), T_DROP = snap(A(15, 1));

  /** Kinetic headline: one line, auto-fit to maxW. */
  const headline = (parent, text, { size = 140, maxW = 960, color = '#fff', ff = HD.ff, w = HD.w, ls = 0 } = {}) => {
    const px = fitPx(text, maxW, size, ff, w, ls);
    const el = h('div', { class: 'abs', text }, parent);
    Object.assign(el.style, { font: `${w} ${px}px/1 ${ff}`, letterSpacing: ls + 'em', color, whiteSpace: 'nowrap', transformOrigin: '0 50%' });
    el.__w = textW(text, px, ff, w, ls); el.__px = px;
    return el;
  };
  /**
   * Feature caption: big outlined index, mono sub beside it, kinetic main line below, hazard bar.
   * compact: index and main line side by side (for tight spots). Returns {el, set, bottom}.
   */
  const feature = (parent, { idx, main, sub = '', y, x = 60, maxW = 960, size = 150, compact = false }) => {
    const el = h('div', { class: 'abs' }, parent);
    Object.assign(el.style, { left: x + 'px', top: y + 'px' });
    const numPx = compact ? 150 : 250;
    const num = h('div', { class: 'abs', text: idx }, el);
    Object.assign(num.style, { left: '-4px', top: '0', font: `400 ${numPx}px/1 ${FF.en}`, color: 'transparent', WebkitTextStroke: `3px ${P.hot}` });
    const numW = textW(idx, numPx, 'Anton', 400) + 24;
    const mainEl = headline(el, main, { size: compact ? Math.min(size, 96) : size, maxW: compact ? maxW - numW : maxW });
    const mainTop = compact ? numPx - mainEl.__px - 6 : numPx - 8;
    Object.assign(mainEl.style, { left: (compact ? numW : 0) + 'px', top: mainTop + 'px' });
    const subEl = lab(el, sub, { x: numW + 4, y: compact ? 14 : Math.round(numPx * 0.36), size: 26, color: P.white, ff: FF.mono, w: 800, ls: 0.16 });
    const barTop = mainTop + mainEl.__px + 22;
    const bar = h('div', { class: 'abs' }, el);
    Object.assign(bar.style, { left: '0', top: barTop + 'px', width: maxW + 'px', height: '10px', background: hazard(P.hot, 'transparent', 9), transformOrigin: '0 50%' });
    const dec = decoder(subEl, sub, idx.charCodeAt(1));
    return {
      el, bottom: barTop + 10,
      set: (t, t0, t1 = 99) => {
        const on = t >= t0 && t < t1;
        show(el, on);
        if (!on) return;
        const a = E.outExpo(prog(t0, t0 + 0.28, t)), z = E.in3(prog(t1 - 0.18, t1, t));
        T(num, { x: (1 - a) * -260, o: a * (1 - z) });
        T(mainEl, { x: (1 - a) * 160, s: 1 + (1 - E.outBack(prog(t0 + 0.04, t0 + 0.24, t))) * 0.25, o: prog(t0 + 0.04, t0 + 0.1, t) * (1 - z) });
        T(bar, { sx: E.out3(prog(t0 + 0.08, t0 + 0.4, t)) * (1 - z) });
        dec(t, t0 + 0.1, 0.35);
        subEl.style.opacity = 1 - z;
      },
    };
  };

  // ================================================================ background: grid, crosses, ghost word
  const GHOST = [[0, 'SUMMON'], [T_HOST, 'HOST'], [T_ROOM, 'SHARE'], [A(5, 1), 'INVITE'], [A(7, 1), 'PARTY'], [A(9, 3.5), 'ALL BLUE'],
    [A(11, 1), 'CONTROL'], [T_SPLIT, '???'], [T_DROP, 'GOLD'], [T_PAY, 'GG'], [T_SPEC, 'SPEC'], [T_END, '']];
  film.layer('bg', root => {
    root.style.background = P.bg;
    const grid = h('div', { class: 'abs' }, root);
    Object.assign(grid.style, { left: '-60px', top: '-60px', width: W + 120 + 'px', height: H + 120 + 'px',
      background: `repeating-linear-gradient(0deg, ${P.hair} 0 1px, transparent 1px 60px), repeating-linear-gradient(90deg, ${P.hair} 0 1px, transparent 1px 60px)` });
    const sv = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0' }, root);
    let d = '';
    for (let x = 90; x < W; x += 180) for (let y = 90; y < H; y += 180) d += `M${x - 9} ${y}h18M${x} ${y - 9}v18`;
    s('path', { d, stroke: 'rgba(225,232,240,.2)', 'stroke-width': 1.6 }, sv);
    const ghost = h('div', { class: 'abs' }, root);
    Object.assign(ghost.style, { left: W - 60 + 'px', top: '150px', transformOrigin: '0 0', transform: 'rotate(90deg)', font: `400 300px/1 ${FF.en}`, color: 'transparent', WebkitTextStroke: '2px rgba(225,232,240,.11)', whiteSpace: 'nowrap', letterSpacing: '.02em' });
    let cur = null;
    return t => {
      grid.style.transform = `translate(0px, ${((t * 14) % 60).toFixed(2)}px)`;
      let k = 0;
      while (k + 1 < GHOST.length && t >= GHOST[k + 1][0]) k++;
      const [t0, word] = GHOST[k];
      const txt = decodeGhost(word, t, t0);
      if (txt !== cur) { ghost.textContent = txt; cur = txt; }
      show(ghost, t < T_END);
    };
  }, 0);
  function decodeGhost(word, t, t0) {
    if (!word) return '';
    const p = clamp((t - t0) / 0.35), n = word.length, shown = Math.ceil(p * n);
    const fr = Math.floor(t * 24);
    let out = '';
    for (let i = 0; i < n; i++) out += i < shown - 1 || p >= 1 ? word[i] : i < shown ? 'X#/%01'[Math.floor(hash(fr * 13 + i) * 6)] : ' ';
    return out;
  }

  // ================================================================ S1 · summon terminal (bar 1)
  film.scene('f-terminal', 0, T_HOST, root => {
    const cam = h('div', { class: 'fill' }, root);
    cam.style.transformOrigin = '50% 46%';
    const cross = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0' }, cam);
    const hl = s('path', { d: `M0 860H${W}`, stroke: P.line2, 'stroke-width': 2 }, cross);
    const vl = s('path', { d: `M540 0V${H}`, stroke: P.line2, 'stroke-width': 2 }, cross);
    const rings = s('g', { transform: 'translate(540 860)' }, cross);
    const r1 = s('circle', { r: 520, fill: 'none', stroke: P.line, 'stroke-width': 2, 'stroke-dasharray': '4 18' }, rings);
    const r2 = s('circle', { r: 430, fill: 'none', stroke: 'rgba(255,90,31,.35)', 'stroke-width': 3, 'stroke-dasharray': '120 40 10 40' }, rings);
    const lx = lab(cam, 'X 0540', { x: 556, y: 820, size: 18, color: P.dim, ls: 0.1 });
    const ly = lab(cam, 'Y 0860', { x: 556, y: 880, size: 18, color: P.dim, ls: 0.1 });
    // readouts
    const l1 = lab(cam, '', { x: 60, y: 170, size: 30, color: P.white, w: 800, ls: 0.12 });
    const l2 = lab(cam, '', { x: 60, y: 214, size: 20, color: P.dim, ls: 0.14 });
    const d1 = decoder(l1, 'SUMMON TERMINAL', 3), d2 = decoder(l2, EN ? 'LIMITED BANNER // 0x0A' : `${S.game.banner} // LIMITED // 0x0A`, 4);
    const cur = h('div', { class: 'abs', html: `<svg width="56" height="56" viewBox="-22 -22 44 44" style="vertical-align:-12px;margin-right:16px"><path d="M0-20 16 0 0 20-16 0Z" fill="#8fe3ff" stroke="#e9fbff" stroke-width="3"/><path d="M0-20 6 0 0 20" fill="#e9fbff" opacity=".5"/></svg>3000` }, cam);
    Object.assign(cur.style, { left: '640px', top: '160px', width: '380px', height: '84px', lineHeight: '84px', padding: '0 28px', boxSizing: 'border-box', border: `3px solid ${P.line2}`, clipPath: clip(16), font: `800 50px/84px ${FF.mono}`, color: '#fff', textAlign: 'right' });
    // the ten-pull button, close up
    const btn = h('div', { class: 'abs' }, cam);
    Object.assign(btn.style, { left: '120px', top: '720px', width: '840px', height: '280px' });
    const bfill = h('div', { class: 'fill' }, btn);
    Object.assign(bfill.style, { background: `linear-gradient(180deg, ${P.hot2}, ${P.hot} 55%, #d63c0c)`, clipPath: clip(44), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '34px', color: '#170903' });
    const bt = h('span', { text: S.game.ten }, bfill);
    Object.assign(bt.style, { font: EN ? `400 150px/1 ${FF.en}` : `900 170px/1 ${FF.zh}`, letterSpacing: EN ? '.03em' : '.1em' });
    const bs = h('span', { text: S.game.tenSub }, bfill);
    Object.assign(bs.style, { font: `800 76px/1 ${FF.mono}` });
    const bglow = h('div', { class: 'abs' }, btn);
    Object.assign(bglow.style, { left: '-120px', top: '-120px', width: '1080px', height: '520px', background: 'radial-gradient(closest-side, rgba(255,110,50,.55), rgba(255,90,31,0))', zIndex: -1 });
    const br = brackets(btn, { w: 900, h: 340, x: -30, y: -30, len: 60, sw: 6, color: P.white });
    const confirm = lab(cam, EN ? 'CONFIRM SUMMON x10 ?' : `CONFIRM SUMMON ×10 ?`, { x: 120, y: 1030, size: 24, color: P.dim, ls: 0.16 });
    // caption
    const capBox = h('div', { class: 'abs' }, cam);
    Object.assign(capBox.style, { left: '60px', top: '1180px' });
    const capLines = EN ? S.saved : [S.saved.join('')];
    const caps = capLines.map((txt, i) => {
      const el = headline(capBox, txt, { size: EN ? 150 : 168, maxW: 960 });
      el.style.top = i * (EN ? 150 : 0) + 'px';
      return el;
    });
    const capH = EN ? 300 : 170;
    const ubar = h('div', { class: 'abs' }, capBox);
    Object.assign(ubar.style, { left: 0, top: capH + 20 + 'px', width: '960px', height: '12px', background: P.hot, transformOrigin: '0 50%' });
    const sub = lab(capBox, '', { x: 0, y: capH + 56, size: 30, color: P.white, w: 800, ls: 0.16 });
    const dsub = decoder(sub, S.savedSub, 7);
    const haz = h('div', { class: 'abs' }, cam);
    Object.assign(haz.style, { left: '60px', top: '1760px', width: '960px', height: '22px', background: hazard(P.hot, P.bg, 12), opacity: 0.85 });
    return (lt, t) => {
      const b2 = A(1, 2), b3 = A(1, 3);
      T(cam, { s: 1 + t * 0.03 });
      const dl = E.outExpo(prog(0, 0.3, t));
      hl.setAttribute('transform', `translate(540 0) scale(${dl} 1) translate(-540 0)`);
      vl.setAttribute('transform', `translate(0 860) scale(1 ${dl}) translate(0 -860)`);
      rings.setAttribute('transform', `translate(540 860) rotate(${t * 18}) scale(${0.8 + 0.2 * dl})`);
      r1.setAttribute('opacity', dl); r2.setAttribute('opacity', dl);
      lx.style.opacity = ly.style.opacity = dl;
      d1(t, 0.04, 0.3); d2(t, 0.12, 0.35);
      T(cur, { o: prog(0.1, 0.2, t), x: (1 - E.outExpo(prog(0.1, 0.4, t))) * 60 });
      // button glitches in on beat 2
      const gl = t >= b2 && t < b2 + 0.16;
      const gx = gl ? (hash(Math.floor(t * 60) * 7) - 0.5) * 90 : 0;
      show(btn, t >= b2);
      T(btn, { x: gx, s: t < b2 + 0.16 ? 1.04 : 1 + Math.sin((t - b2) * 9) * 0.006 });
      bfill.style.clipPath = gl ? `polygon(0 ${(hash(Math.floor(t * 60)) * 40).toFixed(0)}%, 100% 0, 100% 100%, 0 ${(60 + hash(Math.floor(t * 60) + 3) * 40).toFixed(0)}%)` : clip(44);
      T(br.el, { s: lerp(1.3, 1, E.outExpo(prog(b2 + 0.05, b2 + 0.25, t))), o: prog(b2 + 0.05, b2 + 0.12, t) });
      bglow.style.opacity = (0.6 + 0.4 * Math.sin(t * 7)).toFixed(3);
      show(confirm, t >= b2 + 0.1);
      // caption slam on beat 3
      caps.forEach((el, i) => {
        const t0 = b3 + i * spb * 0.5, q = prog(t0, t0 + 0.12, t);
        show(el, t >= t0);
        T(el, { s: lerp(1.7, 1, E.out3(q)), o: Math.min(1, q * 3), x: (1 - q) * -40 });
      });
      T(ubar, { sx: E.outExpo(prog(b3 + 0.05, b3 + 0.4, t)) });
      dsub(t, b3 + 0.15, 0.4);
      T(haz, { x: -((t * 40) % 24) });
    };
  });

  // ================================================================ S2 · the host (bar 2)
  film.scene('f-host', T_HOST, T_ROOM, root => {
    // the monitor is "behind the camera": its light falls on him as a cone, with the orange of the ten-pull button in it
    const glow = h('div', { class: 'fill' }, root);
    glow.style.background = 'radial-gradient(90% 40% at 50% 0%, rgba(110,170,255,.38), rgba(110,170,255,0) 72%)';
    const cone = h('div', { class: 'fill' }, root);
    Object.assign(cone.style, { background: 'linear-gradient(180deg, rgba(140,195,255,.18), rgba(140,195,255,0) 85%)', clipPath: 'polygon(28% 0, 72% 0, 100% 100%, 0 100%)', mixBlendMode: 'screen' });
    const spot = h('div', { class: 'fill' }, root);
    Object.assign(spot.style, { background: 'radial-gradient(30% 14% at 62% 64%, rgba(255,110,50,.30), rgba(255,90,31,0) 75%)', mixBlendMode: 'screen' });
    const scan = h('div', { class: 'fill' }, root);
    scan.style.background = 'repeating-linear-gradient(0deg, rgba(255,255,255,.035) 0 2px, transparent 2px 6px)';
    const sv = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0' }, root);
    const g = s('g', {}, sv);
    const tu = face(g, 'tuan');
    const rim = h('div', { class: 'fill' }, root);
    rim.style.background = 'linear-gradient(180deg, rgba(150,200,255,.0) 55%, rgba(150,200,255,.16) 75%, rgba(0,0,0,.35) 100%)';
    const tag = h('div', { class: 'abs', text: `${S.names.tuan} · HOST` }, root);
    Object.assign(tag.style, { left: '60px', top: '520px', padding: '10px 18px', background: P.hot, color: '#fff', font: `800 30px/1 ${ZH}`, letterSpacing: '.06em', clipPath: clip(10), whiteSpace: 'nowrap' });
    const t1 = headline(root, S.l1, { size: EN ? 96 : 84, maxW: 960, ff: EN ? FF.en : FF.zh, w: EN ? 400 : 900 });
    Object.assign(t1.style, { left: '60px', top: '600px', color: '#dfe6ec' });
    const t2 = headline(root, S.l2, { size: EN ? 150 : 170, maxW: 960 });
    Object.assign(t2.style, { left: '60px', top: EN ? '730px' : '720px' });
    const ul = h('div', { class: 'abs' }, root);
    Object.assign(ul.style, { left: '60px', top: (EN ? 730 : 720) + t2.__px + 22 + 'px', width: Math.min(960, t2.__w) + 'px', height: '12px', background: P.hot, transformOrigin: '0 50%' });
    const ring = s('circle', { cx: 860, cy: 1660, r: 20, fill: 'none', stroke: '#fff', 'stroke-width': 5, opacity: 0 }, sv);
    return (lt, t) => {
      const b1 = A(2, 1), b3 = A(2, 3), b4 = A(2, 4);
      const push = E.out3(prog(b1, b1 + 0.5, t));
      const sq = 1 - 0.05 * Math.exp(-(t - b1) * 10) * Math.cos((t - b1) * 30);
      const think = t < b3;
      tu.set({ x: 540, y: 2080 - push * 40, s: 7.4 + push * 0.25, sq, eyes: think ? 'lid' : t < b4 ? 'spark' : 'lid', lid: think ? 0.45 : 0.3, lidAngle: think ? 0 : 12,
        look: think ? [-3, -2] : [0, 0], tilt: think ? -5 : 4, blink: 0 });
      T(tag, { x: (1 - E.outExpo(prog(b1, b1 + 0.25, t))) * -200 });
      const q1 = prog(b1 + 0.03, b1 + 0.2, t);
      T(t1, { o: q1, x: (1 - E.out3(q1)) * 60 });
      const q2 = prog(b3, b3 + 0.12, t);
      show(t2, t >= b3);
      T(t2, { s: lerp(1.6, 1, E.out3(q2)), o: Math.min(1, q2 * 3) });
      T(ul, { sx: E.outExpo(prog(b3 + 0.05, b3 + 0.35, t)) });
      const c = prog(b4, b4 + 0.3, t);
      ring.setAttribute('r', 20 + c * 80);
      ring.setAttribute('opacity', t >= b4 ? (1 - c).toFixed(3) : 0);
      spot.style.opacity = (0.7 + 0.3 * Math.sin(t * 7)).toFixed(3);
      scan.style.transform = `translateY(${((t * 30) % 6).toFixed(2)}px)`;
    };
  });

  // ================================================================ the room: share → invite → party → dud → control (bars 3–13)
  film.scene('f-room', T_ROOM, T_SPLIT, root => {
    const WIN_W = 1000;
    const win = gameWindow(root, { S, lang, w: WIN_W });
    const gk = win.game.k;                                   // design px → window px at WIN_W
    const btnIn = [BTN10[0] * gk, BTN10[1] * gk];             // ten-pull button centre inside the window (px at WIN_W)
    // layout keyframes for the window: [x, y, width]
    const WK = [
      [A(3, 1), [40, 430, 1000]],
      [A(4, 3.6), [40, 430, 1000]], [A(4, 4.5), [90, 250, 900], 'io3'],
      [A(7, 1) - 0.1, [90, 250, 900]], [A(7, 1) + 0.25, [40, 200, 1000], 'io3'],
      [A(9, 1) - 0.12, [40, 200, 1000]], [A(9, 1) + 0.22, [0, 330, 1080], 'io3'],
      [A(11, 2.5), [0, 330, 1080]], [A(11, 3) + 0.05, [40, 200, 1000], 'io3'],
    ];
    const winRect = t => { const [x, y, w] = kf(t, WK); return { x, y, w, s: w / WIN_W, h: win.h * (w / WIN_W) }; };
    const winPt = (t, px, py) => { const r = winRect(t); return [r.x + px * r.s, r.y + py * r.s]; };

    // ---------- share: Piik source picker
    const pick = panel(root, { x: 40, y: 1100, w: 1000, h: 640, c: 30, bg: 'rgba(18,23,29,.97)', line: P.line2, accent: P.hot });
    const pkHead = h('div', { class: 'abs' }, pick.el);
    Object.assign(pkHead.style, { left: '36px', top: '34px', display: 'flex', alignItems: 'center', gap: '16px', font: `900 42px/1 ${ZH}`, color: '#fff', letterSpacing: EN ? '.04em' : '.02em', whiteSpace: 'nowrap' });
    pkHead.appendChild(icon('share', { size: 44, color: P.hot, sw: 2.4 }));
    h('span', { text: S.pick }, pkHead);
    lab(pick.el, 'PIIK // SOURCE', { x: 700, y: 48, size: 18, color: P.dim2, ls: 0.14, width: 264, align: 'right' });
    const tiles = ['cast', 'camera', 'window', 'display'].map((ic, i) => {
      const x = 36 + (i % 2) * 474, y = 116 + Math.floor(i / 2) * 196;
      const tp = panel(pick.el, { x, y, w: 454, h: 176, c: 16, bg: P.panel2, line: P.line, lw: 2 });
      const ico = icon(ic, { size: 64, color: '#fff', sw: 2 });
      Object.assign(ico.style, { position: 'absolute', left: '30px', top: '56px' });
      tp.el.appendChild(ico);
      lab(tp.el, S.sources[i][0], { x: 120, y: EN ? 62 : 54, size: EN ? 52 : 50, color: '#fff', ff: EN ? FF.en : FF.zh, w: EN ? 400 : 900, ls: EN ? 0.04 : 0.04 });
      if (!EN) lab(tp.el, S.sources[i][1], { x: 122, y: 116, size: 20, color: P.dim, ls: 0.18 });
      const hi = h('div', { class: 'fill' }, tp.el);
      Object.assign(hi.style, { clipPath: clip(16), boxShadow: `inset 0 0 0 6px ${P.hot}`, background: 'rgba(255,90,31,.12)', opacity: 0 });
      return { tp, hi, x, y };
    });
    const go = h('div', { class: 'abs', text: S.start }, pick.el);
    Object.assign(go.style, { left: '36px', top: '520px', width: '928px', height: '90px', background: P.hot, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `900 44px/1 ${ZH}`, letterSpacing: EN ? '.05em' : '.1em', clipPath: clip(18), transformOrigin: '50% 50%' });
    const pulseSv = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0;pointer-events:none' }, root);
    const pulses = [0, 1, 2].map(() => s('rect', { fill: 'none', stroke: P.hot, 'stroke-width': 4, opacity: 0, rx: 4 }, pulseSv));
    const f1 = feature(root, { idx: '01', main: S.feat1[0], sub: EN ? 'SCREEN SHARING' : S.feat1[1], y: 1140, size: 160 });

    // ---------- invite: copy button, link chip, phones
    const copyB = h('div', { class: 'abs' }, root);
    Object.assign(copyB.style, { left: '290px', top: '800px', width: '500px', height: '96px', transformOrigin: '50% 50%' });
    const copyIn = h('div', { class: 'fill', html: `${icon('copy', { size: 40, color: '#fff', sw: 2.4 }).outerHTML}<span>${S.copy}</span>` }, copyB);
    Object.assign(copyIn.style, { background: P.panel3, border: `3px solid ${P.white}`, boxSizing: 'border-box', clipPath: clip(18), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#fff', font: `900 40px/1 ${ZH}`, whiteSpace: 'nowrap', letterSpacing: EN ? '.03em' : '.04em' });
    const copied = h('div', { class: 'abs', text: S.copied }, root);
    Object.assign(copied.style, { left: '810px', top: '826px', font: `800 30px/1 ${ZH}`, color: '#2fd18a', whiteSpace: 'nowrap' });
    const mkChip = () => {
      const c = h('div', { class: 'abs', html: `${icon('link', { size: 34, color: P.bg, sw: 2.6 }).outerHTML}<span>${S.inviteChip}</span>` }, root);
      Object.assign(c.style, { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 26px', background: P.white, color: P.bg, font: `900 34px/1 ${ZH}`, clipPath: clip(14), whiteSpace: 'nowrap', transformOrigin: '50% 50%' });
      return c;
    };
    const chip0 = mkChip(), chips = [mkChip(), mkChip(), mkChip()];
    const chipW = textW(S.inviteChip, 34, FF.zh, 900) + 34 + 12 + 52;
    const PH = [['yuan', 45], ['dian', 390], ['cong', 735]];
    const phones = PH.map(([who, x], i) => {
      const ph = phone(root, { S, lang, who, w: 300, h: 580 });
      ph.x = x; ph.y = 1170;
      const tagEl = h('div', { class: 'abs' }, root);
      Object.assign(tagEl.style, { left: x + 'px', top: '1104px', width: '300px', display: 'flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' });
      tagEl.innerHTML = `<b style="font:900 34px/1 ${ZH};color:${CAST[who].color}">${S.names[who]}</b><span style="font:800 24px/1 ${FF.mono};color:${P.white};letter-spacing:.08em">// ${EN ? S.places[who][0] : S.places[who][0]}</span>`;
      return { ph, who, x, tagEl, tap: A(6, 1 + i * 0.5), land: A(5, 3.5 + i * 0.5) };
    });
    const stamp = h('div', { class: 'abs' }, root);
    Object.assign(stamp.style, { left: '70px', top: '1330px', width: '940px', padding: '26px 34px 30px', boxSizing: 'border-box', background: 'rgba(11,13,16,.93)', border: `6px solid ${P.hot}`, clipPath: clip(26), transformOrigin: '50% 50%' });
    const st1 = h('div', { text: `02 ${S.feat2[0]}` }, stamp);
    Object.assign(st1.style, { font: `${HD.w} ${fitPx(`02 ${S.feat2[0]}`, 860, 96, HD.ff, HD.w)}px/1.05 ${HD.ff}`, color: '#fff', whiteSpace: 'nowrap' });
    const st2 = h('div', { text: S.noApp }, stamp);
    Object.assign(st2.style, { marginTop: '16px', font: `800 ${fitPx(S.noApp, 860, 40, FF.zh, 800)}px/1 ${ZH}`, color: P.hot, whiteSpace: 'nowrap', letterSpacing: '.04em' });

    // ---------- party: ID cards, chat, danmaku
    const ORDER = ['tuan', 'yuan', 'dian', 'cong'];
    const cards = ORDER.map((who, i) => ({ who, c: idCard(root, { S, lang, who, w: 240, h: 300, host: i === 0 }), x: 40 + i * 253 }));
    const chatItems = [
      { who: S.chat[0][0], text: S.chat[0][1], t0: A(7, 1.5) },
      { who: S.chat[1][0], text: S.chat[1][1], t0: A(7, 2.5) },
      { who: S.chat[2][0], text: S.chat[2][1], t0: A(7, 3.5) },
    ];
    const chat = chatFeed(root, { S, lang, w: 1000, h: 300, items: chatItems });
    chat.el.style.left = '40px'; chat.el.style.top = '1180px';
    const f3 = feature(root, { idx: '03', main: S.feat3[0], sub: EN ? 'IN THE ROOM' : S.feat3[1], y: 1540, size: 96, compact: true });
    // danmaku (rows are fractions of the window height, so they follow the window)
    const dmLayer = h('div', { class: 'abs' }, root);
    dmLayer.style.overflow = 'hidden';
    const DM_COL = ['#fff', '#ffd05a', '#a9dcff', '#ffb3c7', '#fff', '#c8f7d0'];
    const dm = [];
    S.dm1.forEach((text, i) => dm.push({ text, t0: A(7, 2) + i * spb * 0.5, row: [0.12, 0.3, 0.5, 0.7, 0.2, 0.62][i], speed: 560 + (i % 3) * 90, color: DM_COL[i % 6], size: 46 }));
    S.dm2.forEach((text, i) => dm.push({ text, t0: A(10, 1.25) + i * spb * 0.25, row: [0.08, 0.26, 0.44, 0.62, 0.8, 0.16, 0.36, 0.72][i], speed: 700 + (i % 3) * 120, color: i % 3 ? '#fff' : '#ffd05a', size: 52 + (i % 2) * 8 }));
    dm.forEach(d => {
      d.el = h('div', { class: 'abs', text: d.text }, dmLayer);
      Object.assign(d.el.style, { font: `900 ${d.size}px/1 ${ZH}`, color: d.color, whiteSpace: 'nowrap', paintOrder: 'stroke fill', WebkitTextStroke: `${Math.round(d.size * 0.17)}px ${P.bg}` });
      d.w = textW(d.text, d.size, EN ? FF.lab : FF.zh, 900);
    });

    // ---------- dud: result type + reactions
    const blueTint = h('div', { class: 'abs' }, root);
    blueTint.style.background = 'rgba(40,90,160,.28)';
    const dudBox = h('div', { class: 'abs' }, root);
    Object.assign(dudBox.style, { left: '0', top: '470px', width: W + 'px', height: '330px', transformOrigin: '50% 50%' });
    const dudBand = h('div', { class: 'fill' }, dudBox);
    dudBand.style.background = `linear-gradient(180deg, ${P.blue} 0 8px, rgba(6,12,24,.86) 8px calc(100% - 8px), ${P.blue} calc(100% - 8px))`;
    const dud = headline(dudBox, S.allBlue, { size: EN ? 220 : 230, maxW: 900, color: P.blue });
    Object.assign(dud.style, { left: 540 - dud.__w / 2 + 'px', top: 165 - dud.__px / 2 - 18 + 'px', textShadow: '0 0 40px rgba(74,168,255,.6)', transformOrigin: '50% 50%' });
    const dudSub = lab(dudBox, EN ? 'RESULT: 10 x 3-STAR' : 'RESULT: 10 × ★3', { x: 0, y: 165 + dud.__px / 2 - 4, size: 28, color: '#a9dcff', w: 800, ls: 0.2, width: W, align: 'center' });
    const dots = h('div', { class: 'abs' }, root);
    Object.assign(dots.style, { left: '40px', top: '1340px', width: '420px', height: '170px', transformOrigin: '0 0' });
    const dotsPn = panel(dots, { w: 420, h: 170, c: 18, bg: 'rgba(16,21,27,.96)', line: P.hot, accent: P.hot });
    const dotsAv = h('div', { class: 'abs' }, dotsPn.body);
    Object.assign(dotsAv.style, { left: '18px', top: '18px', width: '134px', height: '134px', overflow: 'hidden', background: P.bg2 });
    const db = bust(dotsAv, 'tuan', { w: 134, h: 134, sc: 1.9, headY: 0.56 });
    lab(dotsPn.body, `${S.names.tuan.toUpperCase()} //`, { x: 176, y: 30, size: 22, color: P.hot, w: 800, ls: 0.14 });
    lab(dotsPn.body, S.dots, { x: 172, y: 64, size: 80, color: '#fff', ff: FF.zh, w: 900, ls: 0.05 });
    const throws = [];
    const fx = h('div', { class: 'fill' }, root);
    const TH = [
      { kind: 'tomato', from: 2, t: A(9, 4.5), to: [300, 560] },
      { kind: 'poop', from: 3, t: A(10, 1), to: [760, 820] },
      { kind: 'tomato', from: 1, t: A(10, 1.5), to: [640, 470] },
      { kind: 'tomato', from: 3, t: A(10, 2), to: [180, 790] },
    ];
    TH.forEach((o, i) => {
      const fromX = 40 + o.from * 253 + 120;
      throws.push(thrown(fx, { kind: o.kind, from: [fromX, 1120], to: o.to, t0: o.t, dur: spb, arc: 220, size: 120, seed: 40 + i * 5, splatR: 105, life: A(11, 1) - o.t - spb - 0.05, spin: 420 }));
    });

    // ---------- control: Yuan's cut-in, the request dialog, cursors
    const cut = h('div', { class: 'abs' }, root);
    Object.assign(cut.style, { left: '-200px', top: '600px', width: '1480px', height: '620px', overflow: 'hidden', transformOrigin: '50% 50%' });
    const cutBg = h('div', { class: 'fill' }, cut);
    cutBg.style.background = `repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 2px, transparent 2px 26px), linear-gradient(180deg, #16314f, #0d1a2b)`;
    const cutEdge = h('div', { class: 'fill' }, cut);
    cutEdge.style.boxShadow = `inset 0 14px 0 ${P.hot}, inset 0 -14px 0 ${P.hot}, inset 0 22px 0 ${P.bg}, inset 0 -22px 0 ${P.bg}`;
    const cutSv = s('svg', { width: 1480, height: 620, style: 'position:absolute;left:0;top:0' }, cut);
    const cutG = s('g', {}, cutSv);
    const yu = face(cutG, 'yuan');
    const cutT1 = headline(cut, S.yuanLine[0], { size: EN ? 150 : 160, maxW: 600 });
    Object.assign(cutT1.style, { left: '650px', top: '160px' });
    const cutT2 = headline(cut, S.yuanLine[1], { size: EN ? 128 : 124, maxW: 600, color: P.gold });
    Object.assign(cutT2.style, { left: '650px', top: 185 + cutT1.__px + 'px' });
    const cutTag = lab(cut, `${S.names.yuan.toUpperCase()} // VIEWER // VOICE`, { x: 656, y: 100, size: 24, color: '#a9dcff', ls: 0.16 });
    const dlg = controlDialog(root, { S, lang, w: 940, h: 470 });
    dlg.el.style.left = '70px'; dlg.el.style.top = '1150px';
    const ctrlChip = h('div', { class: 'abs', html: `${icon('mouse', { size: 26, color: '#fff', sw: 2.4 }).outerHTML}<span>${S.controlling} · ${S.names.yuan}</span>` }, root);
    Object.assign(ctrlChip.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 16px', background: C.blue, color: '#fff', font: `800 24px/1 ${ZH}`, whiteSpace: 'nowrap', clipPath: clip(10) });
    const f4 = feature(root, { idx: '04', main: S.feat4[0], sub: EN ? 'HOST APPROVES' : S.feat4[1], y: 1150, size: 160 });
    const note4 = lab(root, S.ctrlNote, { x: 60, y: 1150 + f4.bottom + 28, size: fitPx(S.ctrlNote, 960, EN ? 40 : 44, EN ? FF.lab : FF.zh, 800), color: P.white, ff: ZH, w: 800, ls: 0.02 });
    const keysFly = h('div', { class: 'abs', html: `${icon('keyboard', { size: 64, color: '#fff', sw: 2 }).outerHTML}${icon('mouse', { size: 64, color: '#fff', sw: 2 }).outerHTML}` }, root);
    Object.assign(keysFly.style, { display: 'flex', gap: '10px', padding: '12px 16px', background: C.blue, clipPath: clip(12) });
    const hostCur = cursor(root, { size: 58 });
    const yuanCur = cursor(root, { size: 62, color: '#7fc4ff', edge: P.bg, tag: S.names.yuan, tagColor: C.blue });

    // ---------------------------------------------------------------- update
    return (lt, t) => {
      const R = winRect(t);
      T(win.el, { x: R.x, y: R.y, s: R.s });
      // phases
      const inShare = t < A(5, 1), inInvite = t >= A(5, 1) && t < A(7, 1), inParty = t >= A(7, 1) && t < A(9, 1);
      const inDud = t >= A(9, 1) && t < A(11, 1), inCtrl = t >= A(11, 1);
      // ---------- game state
      const pull1 = A(8, 3), deal1 = A(8, 4);
      const cardsSt = [];
      const pullOn = t >= deal1 - 0.05 && t < A(11, 2.5);
      for (let i = 0; i < 10; i++) {
        if (!pullOn) { cardsSt.push(null); continue; }
        const deal = prog(deal1 + i * 0.022, deal1 + i * 0.022 + 0.2, t);
        const ft = A(9, 1 + 0.25 * i);
        cardsSt.push({ deal, flip: prog(ft - 0.06, ft + 0.06, t) });
      }
      let press = 0, hover = 0;
      const host10 = winPt(t, btnIn[0], btnIn[1]);
      if (t > pull1 - 0.5 && t < pull1 + 0.3) { hover = prog(pull1 - 0.45, pull1 - 0.2, t); press = pulse(t, pull1 - 0.04, pull1 + 0.14, 0.04, 0.1); }
      const pull2 = A(13, 1);
      if (t > A(12, 3) && t < pull2 + 0.4) { hover = Math.max(hover, prog(A(12, 3.5), A(12, 4), t)); press = Math.max(press, pulse(t, pull2 - 0.04, pull2 + 0.14, 0.04, 0.1)); }
      const dim = pullOn ? prog(deal1 - 0.05, deal1 + 0.1, t) * (1 - prog(A(11, 2.3), A(11, 2.5), t)) : 0;
      const flash = pulse(t, pull2, pull2 + 0.2, 0.02, 0.18) * 0.9;
      win.set(t, { live: prog(A(4, 1), A(4, 1) + 0.35, t), select: inShare ? prog(A(3, 4), A(3, 4) + 0.12, t) * (1 - prog(A(4, 1), A(4, 1) + 0.15, t)) : 0,
        game: { press, hover, dim, cards: cardsSt, flash } });
      // broadcast pulses at go-live
      pulses.forEach((p, i) => {
        const t0 = A(4, 1) + i * spb * 0.5, q = prog(t0, t0 + 0.7, t);
        if (q <= 0 || q >= 1 || t > A(5, 1)) { p.setAttribute('opacity', 0); return; }
        const g = 20 + q * 140;
        p.setAttribute('x', R.x - g); p.setAttribute('y', R.y - 44 * R.s - g);
        p.setAttribute('width', R.w + 2 * g); p.setAttribute('height', R.h + 44 * R.s + 2 * g);
        p.setAttribute('opacity', ((1 - q) * 0.9).toFixed(3));
      });
      // ---------- share: picker
      const pin = E.outExpo(prog(A(3, 1), A(3, 1) + 0.35, t)), pout = E.in3(prog(A(4, 1.25), A(4, 1.9), t));
      show(pick.el, t < A(4, 1.9));
      T(pick.el, { y: (1 - pin) * 900 + pout * 900 });
      tiles.forEach((tl, i) => {
        const hv = i === 2 ? prog(A(3, 2.5), A(3, 3), t) : 0;
        tl.hi.style.opacity = hv.toFixed(3);
        T(tl.tp.el, { s: i === 2 ? 1 - 0.04 * pulse(t, A(3, 3) - 0.03, A(3, 3) + 0.12, 0.03, 0.1) : 1 });
      });
      T(go, { s: 1 - 0.06 * pulse(t, A(4, 1) - 0.04, A(4, 1) + 0.14, 0.04, 0.1) });
      f1.set(t, A(4, 2), A(5, 2.75));
      // ---------- invite
      const cIn = E.outBack(prog(A(5, 1) - 0.15, A(5, 1), t));
      show(copyB, inInvite || (t >= A(5, 1) - 0.15 && t < A(5, 1)));
      T(copyB, { s: cIn * (1 - 0.06 * pulse(t, A(5, 1) - 0.03, A(5, 1) + 0.12, 0.03, 0.1)), o: 1 - prog(A(5, 3.5), A(5, 4), t) });
      show(copied, t >= A(5, 1.5) && t < A(5, 4));
      T(copied, { o: prog(A(5, 1.5), A(5, 1.6), t), x: (1 - E.out3(prog(A(5, 1.5), A(5, 1.75), t))) * -20 });
      const c0 = E.outBack(prog(A(5, 2), A(5, 2) + 0.2, t));
      show(chip0, t >= A(5, 2) && t < A(5, 3));
      T(chip0, { x: 540 - chipW / 2, y: 930, s: c0 });
      chips.forEach((c, i) => {
        const t0 = A(5, 3), q = E.in2(prog(t0, t0 + spb * (1 + i * 0.5), t));
        const on = t >= t0 && q < 1;
        show(c, on);
        if (!on) return;
        const tx = PH[i][1] + 150, ty = 1420;
        T(c, { x: lerp(540, tx, q) - chipW / 2, y: lerp(930, ty, q) - Math.sin(q * Math.PI) * 160, s: lerp(1, 0.45, q), r: q * (i - 1) * 30, o: 1 - prog(0.8, 1, q) });
      });
      phones.forEach((p, i) => {
        const on = t >= p.land - 0.05 && t < A(7, 1) + 0.3;
        show(p.ph.el, on); show(p.tagEl, on);
        if (!on) return;
        const q = E.outBack(prog(p.land - 0.05, p.land + 0.15, t)), out = E.in3(prog(A(7, 1), A(7, 1) + 0.3, t));
        T(p.ph.el, { x: p.x, y: p.ph.y + (1 - q) * 500 + out * 700, r: (1 - q) * (i - 1) * 8 });
        T(p.tagEl, { o: prog(p.land + 0.05, p.land + 0.2, t) * (1 - out) });
        p.ph.set(t, { open: prog(p.tap + 0.05, p.tap + 0.25, t), note: E.outBack(prog(p.land + 0.08, p.land + 0.3, t)), tap: t >= p.tap ? prog(p.tap, p.tap + 0.35, t) : -1,
          game: {} });
      });
      const sp = prog(A(6, 3), A(6, 3) + 0.07, t);
      show(stamp, t >= A(6, 3) && t < A(7, 1) + 0.16);
      T(stamp, { s: lerp(2.2, 1, E.in3(sp)), r: -5, o: Math.min(1, sp * 3) * (1 - prog(A(7, 1) + 0.06, A(7, 1) + 0.16, t)) });
      // ---------- party layout: cards + chat
      const cardsY = kf(t, [[A(7, 1) + 0.01, 1950], [A(7, 1) + 0.36, 830, 'out3'], [A(9, 1) - 0.12, 830], [A(9, 1) + 0.22, 1010, 'io3'], [A(11, 2.5), 1010], [A(11, 3) + 0.05, 830, 'io3']]);
      const cardsOn = t >= A(7, 1) + 0.01;
      cards.forEach((cd, i) => {
        show(cd.c.el, cardsOn);
        if (!cardsOn) return;
        const lag = i * 0.035;
        const y = kf(t, [[A(7, 1) + 0.01 + lag, 1950], [A(7, 1) + 0.36 + lag, cardsY, 'out3']]);
        T(cd.c.el, { x: cd.x, y: t < A(7, 1) + 0.41 + lag ? y : cardsY });
        const who = cd.who;
        const b = (t + i * 0.61) % 3.1 > 3.0 ? 1 : 0;
        let fo = { eyes: 'open', blink: b, bob: Math.sin(t * 5 + i) * 0.6 };
        let speak = 0, mic = 1;
        if (who === 'yuan') speak = pulse(t, A(7, 3), A(7, 4), 0.03, 0.2) + pulse(t, A(11, 1), A(11, 3.5), 0.03, 0.2);
        if (who === 'tuan') speak = pulse(t, A(8, 2), A(8, 3), 0.03, 0.2);
        if (who === 'dian' || who === 'cong') speak = pulse(t, A(10, 1.5), A(10, 4), 0.05, 0.3);
        if (t >= A(9, 3.5) && t < A(11, 1)) {
          if (who === 'tuan') fo = { eyes: 'dot', sweat: 1, tilt: -6 + noise(t * 9, 3) * 2 };
          else { const hop = Math.abs(Math.sin((t - A(9, 3.5)) * 14 + i)); fo = { eyes: 'happy', mouth: t >= A(9, 4.5) ? 0.8 : 0, mouthKind: 'laugh', y: -hop * 8, tilt: Math.sin(t * 20 + i) * 6 }; }
        }
        if (t >= A(11, 1) && who === 'yuan') fo = { eyes: 'spark', blink: 0 };
        if (t >= A(12, 1) && who === 'tuan') fo = { eyes: 'lid', lid: 0.3, blink: b };
        cd.c.set(t, { face: fo, speak: clamp(speak), mic });
      });
      const chatOn = t >= A(7, 1) && t < A(9, 1) + 0.2;
      show(chat.el, chatOn);
      if (chatOn) { chat.update(t); T(chat.el, { y: (1 - E.out3(prog(A(7, 1), A(7, 1) + 0.3, t))) * 500 + E.in3(prog(A(9, 1) - 0.1, A(9, 1) + 0.2, t)) * 700 }); }
      f3.set(t, A(7, 1.25), A(9, 1) - 0.1);
      // danmaku over the window
      Object.assign(dmLayer.style, { left: R.x + 'px', top: R.y + 'px', width: R.w + 'px', height: R.h + 'px' });
      dm.forEach(d => {
        const dt = t - d.t0, x = R.w + 10 - dt * d.speed;
        const on = dt >= 0 && x > -d.w - 20 && t < A(11, 1);
        show(d.el, on);
        if (on) T(d.el, { x, y: d.row * (R.h - d.size) });
      });
      // ---------- dud
      const dudT = A(9, 3.5);
      show(blueTint, inDud && t >= dudT);
      if (inDud) Object.assign(blueTint.style, { left: R.x + 'px', top: R.y + 'px', width: R.w + 'px', height: R.h + 'px', opacity: (0.9 * prog(dudT, dudT + 0.1, t)).toFixed(3) });
      const dq = prog(dudT, dudT + 0.12, t);
      show(dudBox, t >= dudT && t < A(10, 3));
      T(dudBox, { sy: lerp(0.2, 1, E.outExpo(dq)), o: Math.min(1, dq * 4) * (1 - prog(A(10, 2.6), A(10, 3), t)) });
      T(dud, { s: lerp(1.5, 1, E.out3(prog(dudT + 0.03, dudT + 0.15, t))) });
      dudSub.style.opacity = prog(dudT + 0.1, dudT + 0.2, t);
      const dotQ = E.outBack(prog(A(9, 4), A(9, 4) + 0.18, t));
      show(dots, t >= A(9, 4) && t < A(10, 2.5));
      T(dots, { s: dotQ, o: 1 - prog(A(10, 2.2), A(10, 2.5), t) });
      db.set({ eyes: 'dot', sweat: 1, tilt: -8 });
      throws.forEach(f => f(t));
      // ---------- control: cut-in
      const ci0 = A(11, 1), ci1 = A(11, 3);
      const cOn = t >= ci0 && t < ci1;
      show(cut, cOn);
      if (cOn) {
        const pin2 = E.outExpo(prog(ci0, ci0 + 0.18, t)), pout2 = E.inExpo(prog(ci1 - 0.14, ci1, t));
        T(cut, { x: (1 - pin2) * -1500 + pout2 * 1500, r: -7, sy: lerp(0.3, 1, pin2) });
        yu.set({ x: 440 - (t - ci0) * 40, y: 330 + 90 * 6.2, s: 6.2, eyes: t < ci0 + spb ? 'lid' : 'spark', lid: 0.35, lidAngle: 14, tilt: 6, mouth: t > ci0 + 0.1 && t < ci0 + 0.9 ? 0.45 + 0.25 * Math.abs(Math.sin((t - ci0) * 18)) : 0, mouthKind: 'laugh' });
        T(cutT1, { o: prog(ci0 + 0.08, ci0 + 0.14, t), s: lerp(1.4, 1, E.out3(prog(ci0 + 0.08, ci0 + 0.2, t))) });
        T(cutT2, { o: prog(ci0 + spb, ci0 + spb + 0.08, t), s: lerp(1.4, 1, E.out3(prog(ci0 + spb, ci0 + spb + 0.12, t))) });
        cutTag.style.opacity = prog(ci0 + 0.1, ci0 + 0.2, t);
      }
      // request dialog
      const dIn = A(11, 3), allowT = A(12, 1), dOut = A(12, 1.25);
      const dOn = t >= dIn && t < dOut + 0.15;
      show(dlg.el, dOn);
      if (dOn) {
        const a = E.outBack(prog(dIn, dIn + 0.22, t)), z = E.in3(prog(dOut, dOut + 0.15, t));
        T(dlg.el, { s: a * (1 - 0.6 * z), o: 1 - z, y: z * -300 });
        dlg.set(t, { hover: prog(A(11, 4), A(11, 4.4), t), press: pulse(t, allowT - 0.04, allowT + 0.12, 0.04, 0.1), done: prog(allowT + 0.05, allowT + 0.12, t) });
      }
      const chipOn = t >= dOut && t < T_SPLIT;
      show(ctrlChip, chipOn);
      if (chipOn) T(ctrlChip, { x: R.x + R.w - 360 * R.s - 10, y: R.y - 92 * R.s, s: E.outBack(prog(dOut, dOut + 0.2, t)), o: 1 });
      const f4end = A(13, 1.4);
      f4.set(t, A(12, 1.5), f4end);
      show(note4, t >= A(12, 2) && t < f4end);
      note4.style.opacity = prog(A(12, 2), A(12, 2.2), t) * (1 - E.in3(prog(f4end - 0.18, f4end, t)));
      // keyboard + mouse fly from the dialog to Yuan's card
      const kq = prog(A(12, 1), A(12, 2), t);
      show(keysFly, kq > 0 && kq < 1);
      if (kq > 0 && kq < 1) {
        const yc = cards[1];
        const q = E.io3(kq);
        T(keysFly, { x: lerp(500, yc.x + 40, q), y: lerp(1380, cardsY + 110, q) - Math.sin(q * Math.PI) * 200, s: lerp(1, 0.6, q), o: 1 - prog(0.85, 1, kq) });
      }
      // ---------- cursors
      // host: picker window tile [3,3], go-live [4,1], copy [5,1], ten-pull [8,3], allow [12,1]
      const tile = tiles[2];
      const tileC = [40 + tile.x + 227, 1100 + tile.y + 88];
      const goC = [40 + 500, 1100 + 565];
      const copyC = [540, 848];
      const allowC = [70 + dlg.allowAt[0], 1150 + dlg.allowAt[1]];
      const HC = [
        [A(3, 1.5), [900, 1880]], [A(3, 2.6), tileC, 'io3'], [A(3, 3.4), tileC], [A(3, 4.4), goC, 'io3'], [A(4, 1.4), goC],
        [A(4, 2.2), [1000, 1060], 'io3'], [A(4, 4.3), [900, 1000], 'io3'], [A(4, 4.8), copyC, 'io3'], [A(5, 1.4), copyC], [A(5, 2.4), [980, 1060], 'io3'],
        [A(7, 4), [980, 1060]], [A(8, 2.6), host10, 'io3'], [A(8, 3.6), host10], [A(9, 1.2), [1000, 1000], 'io3'],
        [A(11, 3), [1000, 1000]], [A(11, 4.2), allowC, 'io3'], [A(12, 1.3), allowC], [A(12, 2.4), [1060, 1600], 'io3'],
      ];
      const hp = kf(t, HC);
      const hostOn = (t >= A(3, 1.5) && t < A(5, 2.6)) || (t >= A(7, 4) && t < A(9, 1.3)) || (t >= A(11, 3) && t < A(12, 2.5));
      const clickTs = [A(3, 3), A(4, 1), A(5, 1), A(8, 3), A(12, 1)];
      const cl = clickTs.find(c => t >= c && t < c + 0.3);
      hostCur.set(hp[0], hp[1], cl !== undefined ? pulse(t, cl - 0.02, cl + 0.12, 0.02, 0.1) : 0, hostOn ? 1 : 0, cl !== undefined ? (t - cl) / 0.3 : -1);
      // Yuan's remote cursor glides in after the host allows control
      const yc0 = A(12, 2);
      const YC = [[yc0, [1120, 1760]], [A(12, 3.6), [host10[0] - 40, host10[1] + 60], 'io3'], [A(12, 4.2), host10, 'io2'], [pull2 + 0.4, host10]];
      const yp = kf(t, YC);
      const wig = t >= A(12, 3.6) && t < A(12, 4.2) ? Math.sin((t - A(12, 3.6)) * 30) * 6 : 0;
      const yOn = t >= yc0;
      yuanCur.set(yp[0] + wig, yp[1], pulse(t, pull2 - 0.02, pull2 + 0.12, 0.02, 0.1), yOn ? 1 : 0, t >= pull2 && t < pull2 + 0.3 ? (t - pull2) / 0.3 : -1);
    };
  });

  // ================================================================ tension + reveal: four friends, one summon (bars 13.5–17)
  film.scene('f-split', T_SPLIT, T_PAY, root => {
    const PANELS = [
      { who: 'tuan', place: 'tuan', x: 0, y: 0, tx: 18, ty: 118, opt: {} },
      { who: 'yuan', place: 'yuan', x: 540, y: 0, tx: 792, ty: 118, opt: {} },
      { who: 'dian', place: 'dian', x: 0, y: 960, tx: 18, ty: 1330, opt: { phones: true } },
      { who: 'cong', place: 'cong', x: 540, y: 960, tx: 792, ty: 1330, opt: { glasses: true } },
    ];
    // ---- reveal background (under the panels)
    const rev = h('div', { class: 'fill' }, root);
    rev.style.background = 'radial-gradient(60% 40% at 50% 44%, #3a1d5c 0%, #120a22 60%, #07050c 100%)';
    const rays = prismRays(rev, { R: 1500 });
    Object.assign(rays.style, { left: 540 - 1500 + 'px', top: 840 - 1500 + 'px' });
    const beams = h('div', { class: 'fill' }, rev);
    beams.style.mixBlendMode = 'screen';
    const BEAMS = Array.from({ length: 10 }, (_, i) => {
      const b = h('div', { class: 'abs' }, beams);
      const bw = 30 + hash(i * 3 + 1) * 110;
      Object.assign(b.style, { left: 540 - bw / 2 + 'px', top: '-760px', width: bw + 'px', height: '3200px', transformOrigin: '50% 1600px',
        background: `linear-gradient(90deg, transparent, ${['#fff6d8', '#ffe14d', '#8fd3ff', '#ff9adf'][i % 4]}, transparent)`, opacity: 0.5 });
      return { b, a: -80 + i * 17 + hash(i) * 8, sp: (hash(i + 9) - 0.5) * 20 };
    });
    const ringsSv = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0;mix-blend-mode:screen' }, rev);
    const shock = [0, 1, 2].map(i => s('circle', { cx: 540, cy: 840, r: 10, fill: 'none', stroke: ['#fff', '#ffe14d', '#8fd3ff'][i], 'stroke-width': 18 - i * 5, opacity: 0 }, ringsSv));
    const card = foilCard(rev, { S, w: 440, h: 620 });
    Object.assign(card.el.style, { left: 540 - 220 + 'px', top: 800 - 310 + 'px' });
    const topRead = h('div', { class: 'abs' }, rev);
    Object.assign(topRead.style, { left: '300px', top: '150px', width: '480px', textAlign: 'center' });
    const tr1 = lab(topRead, '', { x: 0, y: 0, size: 24, color: '#fff', w: 800, ls: 0.16, width: 480, align: 'center' });
    const tr2 = lab(topRead, '', { x: 0, y: 40, size: 20, color: P.gold, w: 800, ls: 0.2, width: 480, align: 'center' });
    const dtr1 = decoder(tr1, 'SUMMON RESULT // 01', 21), dtr2 = decoder(tr2, 'LEGENDARY x1', 22);
    const gPx = fitPx(S.gold, 930, EN ? 240 : 180, HD.ff, HD.w), gW = textW(S.gold, gPx, HD.ff, HD.w);
    const goldT = rgbText(rev, S.gold, { size: gPx, ff: HD.ff, w: HD.w, holo: true });
    Object.assign(goldT.el.style, { left: 540 - gW / 2 + 'px', top: 1122 + 'px' });
    goldT.main.style.filter = 'drop-shadow(0 0 30px rgba(255,220,140,.7))';
    const capBox = h('div', { class: 'abs' }, rev);
    Object.assign(capBox.style, { left: '300px', top: '1372px', width: '480px' });
    const capEls = S.scream.map((line, i) => {
      const px = fitPx(line, 470, EN ? 64 : 68, EN ? FF.en : FF.zh, EN ? 400 : 900);
      const el = h('div', { class: 'abs', text: line }, capBox);
      Object.assign(el.style, { left: 0, top: i * (px + 14) + 'px', width: '480px', textAlign: 'center', font: `${EN ? 400 : 900} ${px}px/1 ${EN ? FF.en : FF.zh}`, color: '#fff', whiteSpace: 'nowrap' });
      return el;
    });
    const capTag = h('div', { class: 'abs', text: `05 · ${S.feat5[0]}` }, capBox);
    Object.assign(capTag.style, { left: '0', top: '196px', width: '480px', padding: '14px 0', textAlign: 'center', background: P.hot, color: '#fff', font: `800 ${EN ? 34 : 32}px/1 ${EN ? FF.lab : FF.zh}`, letterSpacing: '.08em', clipPath: clip(12), whiteSpace: 'nowrap' });
    const capSub = lab(capBox, 'NO SPOILERS', { x: 0, y: 274, size: 22, color: P.dim, w: 800, ls: 0.3, width: 480, align: 'center' });
    // hearts / stars bursts on every beat of bar 16
    const pops = [];
    for (let b = 0; b < 4; b++) for (let j = 0; j < 7; j++) {
      const el = h('div', { class: 'abs' }, rev);
      el.appendChild(reaction(j % 3 === 0 ? 'heart' : 'star', 70));
      const cx = [260, 820, 300, 780][b], cy = [700, 640, 1060, 1100][b], a = (j / 7) * TAU + b;
      pops.push({ el, t0: A(16, 1 + b), cx, cy, a, d: 160 + hash(b * 7 + j) * 120 });
    }
    const sp = sparks(rev, { W, H, n: 170, seed: 9 });
    const flashW = h('div', { class: 'fill' }, root);
    flashW.style.background = '#fff';
    // ---- the four panels
    const pans = PANELS.map((pd, i) => {
      const el = h('div', { class: 'abs' }, root);
      Object.assign(el.style, { left: pd.x + 'px', top: pd.y + 'px', width: '540px', height: '960px', overflow: 'hidden', transformOrigin: '0 0', background: P.bg2 });
      const art = s('svg', { width: 540, height: 960, style: 'position:absolute;left:0;top:0' }, el);
      placeArt(art, pd.place);
      const fsv = s('svg', { width: 540, height: 960, style: 'position:absolute;left:0;top:0;overflow:visible' }, el);
      const f = face(s('g', {}, fsv), pd.who, pd.opt);
      const fore = s('svg', { width: 540, height: 960, style: 'position:absolute;left:0;top:0' }, el);
      if (pd.place === 'yuan') {        // blanket hood around Yuan's face, blanket over the body
        s('path', { d: 'M-30 960C-30 560 90 300 270 300S570 560 570 960ZM270 372C190 372 150 430 150 500C150 580 200 632 270 632S390 580 390 500C390 430 350 372 270 372Z', fill: '#3b6ea8', 'fill-rule': 'evenodd', stroke: '#0b0d10', 'stroke-width': 6 }, fore);
        s('path', { d: 'M40 960C60 800 150 730 270 730S480 800 500 960Z', fill: '#4a83c4', stroke: '#0b0d10', 'stroke-width': 6 }, fore);
        s('path', { d: 'M150 820q120 40 240 0', fill: 'none', stroke: 'rgba(11,13,16,.45)', 'stroke-width': 5 }, fore);
      }
      if (pd.place === 'cong') {        // desk edge + mug in front
        s('rect', { x: -10, y: 870, width: 560, height: 120, fill: '#2a2f36', stroke: '#0b0d10', 'stroke-width': 6 }, fore);
        s('path', { d: 'M410 806h70v70q0 14-14 14h-42q-14 0-14-14Z', fill: '#e9e2d0', stroke: '#0b0d10', 'stroke-width': 5 }, fore);
        s('path', { d: 'M480 821q26 2 26 22t-26 22', fill: 'none', stroke: '#0b0d10', 'stroke-width': 5 }, fore);
      }
      const light = h('div', { class: 'fill' }, el);
      light.style.mixBlendMode = 'screen';
      const shade = h('div', { class: 'fill' }, el);
      shade.style.background = 'linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,0) 35%, rgba(0,0,0,0) 70%, rgba(0,0,0,.5))';
      const tagEl = h('div', { class: 'abs' }, el);
      Object.assign(tagEl.style, { left: '22px', top: '22px', display: 'flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' });
      tagEl.innerHTML = `<span style="font:800 20px/1 ${FF.mono};color:${P.hot};letter-spacing:.12em">LOC.0${i + 1}</span><b style="font:900 30px/1 ${ZH};color:#fff">${S.places[pd.place][0]}</b><span style="font:800 22px/1 ${ZH};color:${CAST[pd.who].color}">${S.names[pd.who]}</span>`;
      const fr = s('svg', { width: 540, height: 960, style: 'position:absolute;left:0;top:0' }, el);
      s('rect', { x: 3, y: 3, width: 534, height: 954, fill: 'none', stroke: P.bg, 'stroke-width': 6 }, fr);
      const hot = s('rect', { x: 9, y: 9, width: 522, height: 942, fill: 'none', stroke: '#fff', 'stroke-width': 4, opacity: 0 }, fr);
      return { el, f, fsv, light, pd, i, hot };
    });
    // centre summon meter
    const meter = h('div', { class: 'abs' }, root);
    Object.assign(meter.style, { left: 540 - 95 + 'px', top: 960 - 95 + 'px', width: '190px', height: '190px', transformOrigin: '50% 50%' });
    const mGlow = h('div', { class: 'abs' }, meter);
    Object.assign(mGlow.style, { left: '-150px', top: '-150px', width: '490px', height: '490px', borderRadius: '50%' });
    const mDia = h('div', { class: 'abs' }, meter);
    Object.assign(mDia.style, { left: '25px', top: '25px', width: '140px', height: '140px', transform: 'rotate(45deg)', border: `6px solid ${P.bg}`, boxSizing: 'border-box' });
    const mIn = h('div', { class: 'abs' }, meter);
    Object.assign(mIn.style, { left: '52px', top: '52px', width: '86px', height: '86px', transform: 'rotate(45deg)', background: '#fff' });
    const mLab = lab(root, 'SUMMONING', { x: 0, y: 1080, size: 22, color: '#fff', w: 800, ls: 0.3, width: W, align: 'center' });
    const dmTop = h('div', { class: 'fill' }, root);
    const DMY = [140, 1700, 220, 1772, 300, 1844, 380, 1736];
    const dm3 = S.dm3.map((text, i) => {
      const size = 50 + (i % 3) * 6, el = h('div', { class: 'abs', text }, dmTop);
      Object.assign(el.style, { font: `900 ${size}px/1 ${ZH}`, color: ['#fff', P.gold, '#ffb3c7', '#a9dcff'][i % 4], whiteSpace: 'nowrap', paintOrder: 'stroke fill', WebkitTextStroke: `${Math.round(size * 0.17)}px ${P.bg}` });
      return { el, t0: A(15, 3.5) + i * spb * 0.45, y: DMY[i % DMY.length], speed: 640 + (i % 3) * 110, w: textW(text, size, EN ? FF.lab : FF.zh, 900) };
    });
    const TIER_T = [T_SPLIT, A(13, 3), A(14, 1), A(14, 3)];
    const tierAt = t => { let k = 0; while (k + 1 < TIER_T.length && t >= TIER_T[k + 1]) k++; return k; };
    const mix = (a, b, q) => { const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16); const c = [16, 8, 0].map(sh => Math.round(lerp((pa >> sh) & 255, (pb >> sh) & 255, q))); return `rgb(${c.join(',')})`; };

    return (lt, t) => {
      const drop = T_DROP, rv = t >= drop;
      // ---------------- tension (until the drop)
      const k = tierAt(t), tk = TIER_T[k];
      const prev = TIERS[Math.max(0, k - 1)], col = k === 0 ? TIERS[0] : mix(prev, TIERS[k], prog(tk, tk + 0.12, t));
      const inten = lerp(0.35, 1, prog(T_SPLIT, A(14, 4.5), t)) + pulse(t, tk, tk + 0.3, 0.02, 0.28) * 0.5;
      const freeze = t >= A(14, 4.5) && !rv;
      pans.forEach(pn => {
        const { el, f, fsv, light, pd, i, hot } = pn;
        // slam in from the corner
        const lag = i * 0.03, q = E.outExpo(prog(T_SPLIT + lag, T_SPLIT + lag + 0.22, t));
        const dx = (pd.x ? 1 : -1) * 600, dy = (pd.y ? 1 : -1) * 400;
        let x = pd.x + (1 - q) * dx, y = pd.y + (1 - q) * dy, sc = 1, rot = 0;
        if (rv) {
          const a = E.outBack(prog(drop, drop + 0.35, t), 1.3);
          x = lerp(pd.x, pd.tx, a); y = lerp(pd.y, pd.ty, a); sc = lerp(1, 0.5, a); rot = a * (i % 2 ? 4 : -4);
          const shk = shake(t, drop, 1.2, 14, 26, 11 + i);
          x += shk.x; y += shk.y;
        }
        T(el, { x: x - pd.x, y: y - pd.y, s: sc, r: rot });
        // the face: push in, tremble, then SCREAM (same frame for everyone)
        const push = prog(T_SPLIT, drop, t);
        const trem = (rv ? 3 : 0.6 + push * 2.2) * noise(t * 30, i * 5);
        const sc0 = 6.2 + push * 0.9;
        const fy = 486 - push * 14 + 90 * sc0;
        let fo = { eyes: 'wide', look: [0, 1.5], blink: 0, tilt: trem * 1.5, hx: trem * 0.6 };
        if (freeze) fo = { eyes: 'dot', tilt: 0 };
        if (rv) fo = { eyes: 'squeeze', mouth: 1 - 0.15 * Math.abs(Math.sin((t - drop) * 22 + i)), mouthKind: 'scream', tilt: trem * 3, sq: 1 + 0.06 * Math.sin((t - drop) * 30 + i) };
        f.set({ x: 270, y: fy, s: sc0, ...fo });
        const lc = rv ? '#fff3d1' : col;
        light.style.background = `radial-gradient(85% 60% at 50% 104%, ${lc} 0%, rgba(0,0,0,0) 78%), linear-gradient(0deg, ${lc}, rgba(0,0,0,0) 60%)`;
        light.style.opacity = (rv ? 0.3 : clamp(0.25 + inten * 0.6)).toFixed(3);
        fsv.style.filter = `drop-shadow(0 0 ${rv ? 18 : (14 + 26 * inten).toFixed(0)}px ${lc})`;
        hot.setAttribute('opacity', rv ? 0.9 : 0);
      });
      // meter
      const mOn = !rv;
      show(meter, mOn); show(mLab, mOn);
      if (mOn) {
        const bump = pulse(t, tk, tk + 0.25, 0.02, 0.22);
        T(meter, { s: E.outBack(prog(T_SPLIT + 0.1, T_SPLIT + 0.3, t)) * (1 + bump * 0.25 + (freeze ? 0.4 : 0)), r: (t - T_SPLIT) * 90 * (freeze ? 0 : 1) });
        mIn.style.background = freeze ? '#fff' : col;
        mGlow.style.background = `radial-gradient(closest-side, ${freeze ? '#fff' : col}, rgba(0,0,0,0))`;
        mGlow.style.opacity = (0.55 + 0.45 * inten).toFixed(3);
        mLab.style.opacity = prog(T_SPLIT + 0.2, T_SPLIT + 0.3, t);
      }
      // ---------------- reveal
      show(rev, rv);
      if (rv) {
        const lt2 = t - drop;
        rays.style.transform = `rotate(${(lt2 * 14).toFixed(2)}deg) scale(${(0.6 + 0.4 * E.outExpo(clamp(lt2 / 0.5))).toFixed(3)})`;
        rays.style.opacity = (0.75 + 0.25 * Math.sin(lt2 * 3)).toFixed(3);
        BEAMS.forEach((b, i) => { b.b.style.transform = `rotate(${(b.a + lt2 * b.sp).toFixed(2)}deg) scaleX(${(0.6 + 0.4 * Math.sin(lt2 * 4 + i)).toFixed(3)})`; b.b.style.opacity = (0.25 + 0.3 * E.outExpo(clamp(lt2 / 0.3))).toFixed(3); });
        shock.forEach((c, i) => { const q = prog(drop + i * 0.07, drop + i * 0.07 + 0.7, t); c.setAttribute('r', 40 + E.out3(q) * 1100); c.setAttribute('opacity', q > 0 && q < 1 ? (1 - q).toFixed(3) : 0); });
        const cq = prog(drop, drop + 0.55, t);
        card.set(t, { ry: lerp(180, 0, E.outBack(cq, 1.2)), rz: Math.sin(lt2 * 1.4) * 2.5 });
        T(card.el, { s: lerp(0.55, 1, E.outBack(prog(drop, drop + 0.4, t))) * (1 + 0.02 * Math.sin(lt2 * 3)), y: Math.sin(lt2 * 2.2) * 8 });
        dtr1(t, drop + 0.2, 0.4); dtr2(t, drop + 0.35, 0.4);
        const gq = prog(drop + 0.04, drop + 0.16, t);
        const gsh = shake(t, drop + 0.04, 0.9, 16, 32, 31);
        T(goldT.el, { s: lerp(1.8, 1, E.out3(gq)) * (1 + 0.015 * Math.sin(lt2 * 18)), o: Math.min(1, gq * 3), x: gsh.x, y: gsh.y });
        goldT.set(t, 18 * Math.exp(-lt2 * 3.5) + 2);
        const c3 = A(15, 3);
        capEls.forEach((el, i) => { const q = prog(c3 + i * 0.07, c3 + i * 0.07 + 0.12, t); show(el, t >= c3 + i * 0.07); T(el, { s: lerp(1.5, 1, E.out3(q)), o: Math.min(1, q * 3) }); });
        T(capTag, { sx: E.outExpo(prog(c3 + 0.15, c3 + 0.4, t)), o: t >= c3 + 0.15 ? 1 : 0 });
        capSub.style.opacity = prog(c3 + 0.3, c3 + 0.45, t);
        pops.forEach(p => {
          const q = prog(p.t0, p.t0 + 0.6, t);
          const on = q > 0 && q < 1;
          show(p.el, on);
          if (on) { const e = E.out3(q); T(p.el, { x: p.cx + Math.cos(p.a) * p.d * e - 35, y: p.cy + Math.sin(p.a) * p.d * e - 35 + 120 * q * q, s: (1 - q * 0.6) * E.outBack(clamp(q * 4)), r: q * 200 }); }
        });
        sp(t, drop, 540, 840);
      } else sp(t, drop, 540, 840);
      O(flashW, pulse(t, drop - 0.02, drop + 0.16, 0.02, 0.14) + (freeze ? 0.25 + 0.5 * prog(A(14, 4.5), drop, t) : 0));
      dm3.forEach(d => {
        const dt = t - d.t0, x = W - dt * d.speed;
        const on = rv && dt >= 0 && x > -d.w - 20;
        show(d.el, on);
        if (on) T(d.el, { x, y: d.y });
      });
    };
  });

  /** Simple location backdrops for the four split panels (flat industrial vector). */
  function placeArt(sv, place) {
    const ink = P.bg;
    if (place === 'tuan') {          // sofa night
      s('rect', { width: 540, height: 960, fill: '#141b24' }, sv);
      s('path', { d: 'M400 120h90v260h-90Z', fill: 'none', stroke: 'rgba(225,232,240,.12)', 'stroke-width': 3 }, sv);
      const sf = sofa({ width: 560, color: C.yellow2, line: ink });
      const g = s('g', { transform: 'translate(-10 738) scale(1)' }, sv); g.appendChild(sf.el);
      s('path', { d: 'M470 260v330', stroke: 'rgba(225,232,240,.25)', 'stroke-width': 4 }, sv);
      s('path', { d: 'M430 260h80l-14-50h-52Z', fill: '#e9c46a', stroke: ink, 'stroke-width': 4 }, sv);
    } else if (place === 'yuan') {   // bed, window with moon
      s('rect', { width: 540, height: 960, fill: '#101a2c' }, sv);
      s('rect', { x: 300, y: 90, width: 190, height: 240, fill: '#0b1322', stroke: 'rgba(225,232,240,.25)', 'stroke-width': 4 }, sv);
      s('circle', { cx: 420, cy: 170, r: 34, fill: '#f6f2e8' }, sv);
      s('circle', { cx: 438, cy: 160, r: 30, fill: '#0b1322' }, sv);
      s('rect', { x: 60, y: 300, width: 420, height: 170, rx: 70, fill: '#d9e6f5', stroke: ink, 'stroke-width': 6 }, sv);
    } else if (place === 'dian') {   // subway car: window band with passing lights, pole, handles
      s('rect', { width: 540, height: 960, fill: '#161d22' }, sv);
      s('rect', { x: -10, y: 140, width: 560, height: 300, fill: '#0a0f14', stroke: 'rgba(225,232,240,.25)', 'stroke-width': 4 }, sv);
      const streak = s('g', { 'data-streaks': '1' }, sv);
      for (let i = 0; i < 6; i++) s('rect', { x: i * 190, y: 200 + (i % 3) * 70, width: 120, height: 8, rx: 4, fill: 'rgba(255,214,120,.55)' }, streak);
      s('path', { d: 'M470 0v960', stroke: '#9aa5b1', 'stroke-width': 16 }, sv);
      for (const x of [90, 250]) { s('path', { d: `M${x} 0v70`, stroke: '#9aa5b1', 'stroke-width': 5 }, sv); s('circle', { cx: x, cy: 96, r: 26, fill: 'none', stroke: '#c9d2db', 'stroke-width': 8 }, sv); }
    } else {                         // office: monitor glow, lamp
      s('rect', { width: 540, height: 960, fill: '#151a1f' }, sv);
      s('rect', { x: 40, y: 150, width: 300, height: 190, fill: '#0e1318', stroke: 'rgba(225,232,240,.25)', 'stroke-width': 4 }, sv);
      for (let i = 0; i < 5; i++) s('rect', { x: 64, y: 180 + i * 28, width: 150 + (i * 37) % 100, height: 10, fill: 'rgba(120,200,160,.35)' }, sv);
      s('path', { d: 'M430 120l50 70h-100Z', fill: '#e9c46a', stroke: P.bg, 'stroke-width': 4 }, sv);
      s('path', { d: 'M430 190v200', stroke: '#9aa5b1', 'stroke-width': 6 }, sv);
    }
  }

  // ================================================================ payoff (bar 17)
  film.scene('f-payoff', T_PAY, T_SPEC, root => {
    root.style.background = 'radial-gradient(70% 45% at 50% 30%, #2a1747 0%, #0e0a18 70%)';
    const rays = prismRays(root, { R: 1100, seed: 5 });
    Object.assign(rays.style, { left: 540 - 1100 + 'px', top: 430 - 1100 + 'px', opacity: 0.55 });
    const card = foilCard(root, { S, w: 330, h: 465 });
    Object.assign(card.el.style, { left: 540 - 165 + 'px', top: '200px' });
    const sv = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0' }, root);
    const gT = s('g', {}, sv), gY = s('g', {}, sv);
    const tu = face(gT, 'tuan'), yu = face(gY, 'yuan');
    const plate = (who, text, x, y, align) => {
      const el = h('div', { class: 'abs' }, root);
      const px = fitPx(text, 600, EN ? 84 : 78, EN ? FF.en : FF.zh, EN ? 400 : 900);
      Object.assign(el.style, { left: x + 'px', top: y + 'px', padding: '22px 28px 26px', background: 'rgba(11,13,16,.92)', border: `3px solid ${who === 'yuan' ? C.blue : P.hot}`, clipPath: clip(18), transformOrigin: align === 'left' ? '0 100%' : '100% 100%', whiteSpace: 'nowrap' });
      el.innerHTML = `<div style="font:800 24px/1 ${FF.mono};letter-spacing:.14em;color:${who === 'yuan' ? '#a9dcff' : P.hot}">${S.names[who].toUpperCase()} //</div><div style="margin-top:12px;font:${EN ? 400 : 900} ${px}px/1 ${EN ? FF.en : FF.zh};color:#fff">${text}</div>`;
      return el;
    };
    const pl1 = plate('tuan', S.p1, 60, 760, 'left');
    const p2w = textW(S.p2, fitPx(S.p2, 600, EN ? 84 : 78, EN ? FF.en : FF.zh, EN ? 400 : 900), EN ? FF.en : FF.zh, EN ? 400 : 900) + 60;
    const pl2 = plate('yuan', S.p2, 1020 - Math.max(p2w, 260), 1000, 'right');
    const hearts = Array.from({ length: 8 }, (_, i) => { const el = h('div', { class: 'abs' }, root); el.appendChild(reaction(i % 2 ? 'heart' : 'star', 64)); return el; });
    return (lt, t) => {
      rays.style.transform = `rotate(${(t * 10).toFixed(2)}deg)`;
      card.set(t, { ry: Math.sin(t * 1.3) * 12, rz: -4 });
      const b1 = A(17, 1), b3 = A(17, 3);
      tu.set({ x: 290, y: 2050, s: 6.6, eyes: 'dot', sweat: 1, tilt: -8 + noise(t * 12, 1) * 2, bob: Math.sin(t * 9) * 0.5 });
      const yh = Math.abs(Math.sin((t - b3) * 9)) * (t >= b3 ? 14 : 0);
      yu.set({ x: 810, y: 2090 - yh, s: 6.0, eyes: t >= b3 ? 'happy' : 'open', blush: t >= b3 ? 1 : 0, mouth: t >= b3 && t < b3 + 0.5 ? 0.6 : 0, mouthKind: 'laugh', tilt: t >= b3 ? 8 : 0, blink: 0 });
      const q1 = E.outBack(prog(b1, b1 + 0.2, t)), q2 = E.outBack(prog(b3, b3 + 0.2, t));
      T(pl1, { s: q1, o: t >= b1 ? 1 : 0 }); T(pl2, { s: q2, o: t >= b3 ? 1 : 0 });
      hearts.forEach((el, i) => {
        const t0 = A(17, 3.5) + i * 0.04, q = prog(t0, t0 + 0.5, t);
        show(el, q > 0 && q < 1);
        if (q > 0 && q < 1) T(el, { x: lerp(100 + i * 110, 790 + (i % 3) * 40, E.in2(q)) - 32, y: lerp(-60, 1250, E.in2(q)) - Math.sin(q * Math.PI) * 80, r: q * 260, s: 1 - 0.3 * q });
      });
    };
  });

  // ================================================================ spec sheet (bars 18–19)
  film.scene('f-spec', T_SPEC, T_END, root => {
    const head = h('div', { class: 'abs' }, root);
    Object.assign(head.style, { left: '60px', top: '170px', width: '960px' });
    const wm = h('div', { class: 'abs', html: 'Piik<span style="color:#ffd05a">.</span>' }, head);
    Object.assign(wm.style, { left: 0, top: 0, font: WORDMARK(150), letterSpacing: '-6px', color: '#fff' });
    const hs1 = lab(head, '', { x: 430, y: 30, size: 30, color: P.white, w: 800, ls: 0.14 });
    const hs2 = lab(head, '', { x: 430, y: 80, size: EN ? 30 : 34, color: P.hot, ff: ZH, w: 900, ls: 0.06 });
    const dh1 = decoder(hs1, S.specHeadSub, 31), dh2 = decoder(hs2, S.specHead, 32);
    const bc = h('div', { class: 'abs', html: barcodeSVG(220, 34, 9, P.dim) }, head);
    Object.assign(bc.style, { left: '740px', top: '128px' });
    const hz = h('div', { class: 'abs' }, head);
    Object.assign(hz.style, { left: 0, top: '186px', width: '960px', height: '14px', background: hazard(P.hot, P.bg, 10), transformOrigin: '0 50%' });
    const ICONS = ['cast', 'link', 'chat', 'mouse', 'server', 'share', 'couch'];
    const rows = S.spec.map((r, i) => {
      const y = 440 + i * 172;
      const pn = panel(root, { x: 60, y, w: 960, h: 140, c: 18, bg: P.panel, line: P.line2, lw: 2 });
      const idx = lab(pn.el, `0${i + 1}`, { x: 26, y: 38, size: 64, color: P.hot, ff: FF.en, w: 400, ls: 0.02 });
      const ic = icon(ICONS[i], { size: 54, color: '#fff', sw: 2 });
      Object.assign(ic.style, { position: 'absolute', left: '118px', top: '43px' });
      pn.el.appendChild(ic);
      const mainPx = fitPx(r[0], 740, EN ? 58 : 54, EN ? FF.lab : FF.zh, EN ? 800 : 900, EN ? 0.04 : 0.02);
      const main = lab(pn.el, '', { x: 196, y: r[1] ? 30 : 70 - mainPx / 2, size: mainPx, color: '#fff', ff: EN ? FF.lab : FF.zh, w: EN ? 800 : 900, ls: EN ? 0.04 : 0.02 });
      const sub = r[1] ? lab(pn.el, '', { x: 198, y: 30 + mainPx + 12, size: 20, color: P.dim, ff: FF.mono, w: 700, ls: 0.16 }) : null;
      const dm = decoder(main, r[0], 40 + i), ds = sub ? decoder(sub, r[1], 60 + i) : null;
      const t0 = A(18, 2 + 0.5 * i);                       // 8th notes: [18,2] .. [19,1]
      return { pn, idx, dm, ds, t0 };
    });
    return (lt, t) => {
      const t0 = T_SPEC;
      T(wm, { o: prog(t0, t0 + 0.1, t), x: (1 - E.outExpo(prog(t0, t0 + 0.3, t))) * -80 });
      dh1(t, t0 + 0.05, 0.35); dh2(t, t0 + 0.12, 0.4);
      T(hz, { sx: E.outExpo(prog(t0 + 0.05, t0 + 0.45, t)) });
      bc.style.opacity = prog(t0 + 0.2, t0 + 0.3, t);
      rows.forEach(r => {
        const q = E.outExpo(prog(r.t0 - 0.04, r.t0 + 0.16, t));
        show(r.pn.el, t >= r.t0 - 0.04);
        T(r.pn.el, { x: (1 - q) * 200, o: q });
        r.dm(t, r.t0, 0.18);
        if (r.ds) r.ds(t, r.t0 + 0.04, 0.18);
        r.idx.style.color = t < r.t0 + 0.1 ? '#fff' : P.hot;
      });
    };
  });

  // ================================================================ end card (bars 20–21)
  film.scene('f-end', T_END, cues.length, root => {
    root.style.background = C.yellow;
    const grid = h('div', { class: 'fill' }, root);
    grid.style.background = 'repeating-linear-gradient(0deg, rgba(25,37,48,.08) 0 1px, transparent 1px 60px), repeating-linear-gradient(90deg, rgba(25,37,48,.08) 0 1px, transparent 1px 60px)';
    const br = brackets(root, { w: 960, h: 1600, x: 60, y: 140, len: 70, sw: 6, color: C.ink });
    const l1 = lab(root, 'END OF TRANSMISSION', { x: 60, y: 90, size: 22, color: C.ink, w: 800, ls: 0.2 });
    const l2 = lab(root, 'PIIK // F-01', { x: 60, y: 1770, size: 22, color: C.ink, w: 800, ls: 0.2, width: 960, align: 'right' });
    const mc = h('div', { class: 'abs' }, root);
    const m = mascot({ stroke: C.ink, fill: C.cream, size: 560 });
    mc.appendChild(m.el);
    const wm = h('div', { class: 'abs', html: 'Piik<span style="color:#e9a12c">.</span>' }, root);
    Object.assign(wm.style, { left: 0, width: W + 'px', textAlign: 'center', top: '1010px', font: WORDMARK(230), letterSpacing: '-10px', color: C.ink });
    const tgPx = fitPx(S.tagline, 920, EN ? 120 : 100, EN ? FF.en : FF.zh, EN ? 400 : 900);
    const tg = h('div', { class: 'abs', text: S.tagline }, root);
    Object.assign(tg.style, { left: 0, width: W + 'px', textAlign: 'center', top: '1300px', font: `${EN ? 400 : 900} ${tgPx}px/1 ${EN ? FF.en : FF.zh}`, color: C.ink2, whiteSpace: 'nowrap' });
    const sub = lab(root, S.taglineSub, { x: 0, y: 1300 + tgPx + 26, size: 34, color: C.ink, ff: FF.lab, w: 800, ls: 0.26, width: W, align: 'center' });
    const url = h('div', { class: 'abs', html: `<span style="padding:12px 28px;border:5px solid ${C.ink};background:#fffefb;clip-path:${clip(14)}">piik.tv</span>` }, root);
    Object.assign(url.style, { left: 0, width: W + 'px', textAlign: 'center', top: '1560px', font: `800 50px/1 ${FF.mono}`, color: C.ink });
    const foot = lab(root, S.footer, { x: 0, y: 1680, size: 34, color: C.ink, ff: EN ? FF.lab : FF.zh, w: 700, ls: EN ? 0.08 : 0.04, width: W, align: 'center' });
    const flash = h('div', { class: 'fill' }, root);
    flash.style.background = '#fff';
    return (lt, t) => {
      const L0 = T_END, tt = Math.max(0, t - L0);
      const mp = E.outBack(prog(L0, L0 + 0.35, t));
      T(mc, { x: 260, y: 360 + (1 - mp) * 200, s: mp, r: (1 - mp) * -20, ox: '50%', oy: '70%' });
      m.set({ wink: tt < 0.9 ? 1 : tt < 1.3 ? 0 : 1, spark: pulse(t, L0 + 0.1, L0 + 1.6, 0.1, 0.4), antenna: Math.sin(tt * 10) * 10 * Math.exp(-tt * 2), squash: 1 + Math.exp(-tt * 5) * Math.sin(tt * 24) * 0.06 });
      T(wm, { y: (1 - E.outExpo(prog(L0 + 0.1, L0 + 0.5, t))) * 80, o: prog(L0 + 0.1, L0 + 0.25, t) });
      T(tg, { s: E.outBack(prog(A(20, 3), A(20, 3) + 0.25, t)), o: t >= A(20, 3) ? 1 : 0 });
      sub.style.opacity = prog(A(20, 3) + 0.2, A(20, 3) + 0.4, t);
      T(url, { y: (1 - E.outExpo(prog(A(21, 1), A(21, 1) + 0.4, t))) * 40, o: prog(A(21, 1), A(21, 1) + 0.2, t) });
      foot.style.opacity = prog(A(21, 1) + 0.15, A(21, 1) + 0.4, t) * 0.85;
      T(br.el, { s: lerp(1.08, 1, E.outExpo(prog(L0, L0 + 0.4, t))), o: prog(L0, L0 + 0.15, t), ox: '50%', oy: '50%' });
      l1.style.opacity = l2.style.opacity = prog(L0 + 0.2, L0 + 0.4, t);
      O(flash, pulse(t, L0, L0 + 0.12, 0.01, 0.11) * 0.9);
    };
  });

  // ================================================================ HUD (room, payoff, spec)
  film.layer('hud', root => {
    const top = h('div', { class: 'abs' }, root);
    Object.assign(top.style, { left: 0, top: 0, width: W + 'px', height: '130px' });
    lab(top, 'PIIK', { x: 40, y: 46, size: 30, color: '#fff', w: 800, ls: 0.12 });
    lab(top, '// ROOM 9527', { x: 132, y: 52, size: 22, color: P.dim, w: 700, ls: 0.12 });
    const live = h('div', { class: 'abs' }, top);
    Object.assign(live.style, { left: '440px', top: '40px', width: '200px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', font: `800 24px/1 ${FF.mono}`, letterSpacing: '.14em', whiteSpace: 'nowrap', clipPath: clip(10) });
    const vw = lab(top, '', { x: 640, y: 50, size: 24, color: '#fff', w: 800, ls: 0.1, width: 400, align: 'right' });
    const ln = h('div', { class: 'abs' }, top);
    Object.assign(ln.style, { left: '40px', top: '108px', width: '1000px', height: '2px', background: P.line });
    const lnHot = h('div', { class: 'abs' }, top);
    Object.assign(lnHot.style, { left: '40px', top: '106px', width: '120px', height: '6px', background: P.hot });
    const bot = h('div', { class: 'abs' }, root);
    Object.assign(bot.style, { left: 0, top: '1830px', width: W + 'px', height: '60px' });
    const hz = h('div', { class: 'abs' }, bot);
    Object.assign(hz.style, { left: '40px', top: '14px', width: '200px', height: '16px', background: hazard(P.hot, P.bg, 8) });
    const tc = lab(bot, '', { x: 270, y: 12, size: 20, color: P.dim, w: 700, ls: 0.12 });
    const bc = h('div', { class: 'abs', html: barcodeSVG(180, 26, 3, P.dim2) }, bot);
    Object.assign(bc.style, { left: '860px', top: '8px' });
    const rul = s('svg', { width: W, height: H, style: 'position:absolute;left:0;top:0' }, root);
    let d = '';
    for (let y = 160; y <= 1780; y += 40) { const L = (y - 160) % 200 === 0 ? 16 : 7; d += `M14 ${y}h${L}M${W - 14} ${y}h${-L}`; }
    s('path', { d, stroke: 'rgba(225,232,240,.3)', 'stroke-width': 2 }, rul);
    const mark = s('path', { d: 'M14 0l14 8-14 8Z', fill: P.hot }, rul);
    const VT = [A(6, 1), A(6, 1.5), A(6, 2)];
    let lastV = '', lastTc = '';
    return t => {
      const on = (t >= T_ROOM && t < T_SPLIT && !(t >= A(11, 1) && t < A(11, 3))) || (t >= T_PAY && t < T_END);
      show(root, on);
      if (!on) return;
      const isLive = t >= A(4, 1);
      live.innerHTML = isLive ? `<i style="width:12px;height:12px;border-radius:50%;background:#fff;opacity:${(0.5 + 0.5 * Math.cos(t * 6)).toFixed(2)}"></i>LIVE` : 'STANDBY';
      live.style.background = isLive ? P.hot : 'transparent';
      live.style.color = isLive ? '#fff' : P.dim;
      live.style.boxShadow = isLive ? 'none' : `inset 0 0 0 2px ${P.line2}`;
      const n = VT.filter(x => t >= x).length;
      const v = `${S.viewers} ${String(n).padStart(2, '0')} / 20`;
      if (v !== lastV) { vw.textContent = v; lastV = v; }
      const bump = VT.reduce((a, x) => a + pulse(t, x, x + 0.18, 0.02, 0.16), 0);
      T(vw, { s: 1 + bump * 0.25, ox: '100%', oy: '50%' });
      vw.style.color = bump > 0.05 ? P.hot : '#fff';
      const sec = Math.floor(t), cs = Math.floor((t % 1) * 100);
      const tcs = `REC  T+00:${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}   ${S.hudTag}`;
      if (tcs !== lastTc) { tc.textContent = tcs; lastTc = tcs; }
      T(lnHot, { x: ((t * 260) % 880) });
      mark.setAttribute('transform', `translate(0 ${(160 + ((t * 120) % 1620)).toFixed(1)})`);
    };
  }, 400);

  // ================================================================ glitch cuts (industrial slice wipe on hard cuts)
  film.layer('cuts', root => {
    const CUTS = [T_HOST, T_ROOM, A(11, 1), T_SPLIT, T_PAY, T_SPEC, T_END];
    const bars = Array.from({ length: 8 }, () => h('div', { class: 'abs' }, root));
    const scan = h('div', { class: 'abs' }, root);
    Object.assign(scan.style, { left: 0, width: W + 'px', height: '4px', background: '#fff' });
    return t => {
      const c = CUTS.find(x => t >= x - 0.05 && t < x + 0.1);
      const on = c !== undefined;
      show(root, on);
      if (!on) return;
      const fr = Math.floor(t * 60), q = (t - (c - 0.05)) / 0.15;
      bars.forEach((b, i) => {
        const y = hash(fr * 17 + i * 3) * H, hh = 8 + hash(fr * 5 + i) * 120;
        const col = [P.hot, '#fff', P.bg, 'rgba(255,90,31,.5)'][i % 4];
        Object.assign(b.style, { top: y.toFixed(0) + 'px', height: hh.toFixed(0) + 'px', width: W + 'px', background: col, opacity: (0.85 * (1 - Math.abs(q - 0.5) * 1.6)).toFixed(3) });
        b.style.transform = `translateX(${((hash(fr * 3 + i * 11) - 0.5) * 400).toFixed(0)}px)`;
      });
      scan.style.top = (q * H).toFixed(0) + 'px';
    };
  }, 900);

  // ================================================================ finishing: vignette + grain + end fade
  film.layer('finish', root => {
    const vig = h('div', { class: 'fill' }, root);
    vig.style.background = 'radial-gradient(120% 90% at 50% 50%, transparent 60%, rgba(0,0,0,.4) 100%)';
    const grain = grainLayer(root, { W, H, opacity: 0.09 });
    const fade = h('div', { class: 'fill' }, root);
    fade.style.background = '#000';
    return t => {
      grain(t);
      vig.style.opacity = t >= T_END ? 0.35 : 1;
      O(fade, Math.max(0, (t - (cues.length - 0.5)) / 0.48));
    };
  }, 1000);

  return film;
}
