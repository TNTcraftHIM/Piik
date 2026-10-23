// Film A · Act 5 — not just games (stop-time montage), the facts, the calling card returns, logo.
import { h, s, T, ST, O, kf, tw, prog, E, clamp, lerp, rng, noise, shake, show, pulse } from '../../engine/core.js';
import { C, CAST, mascot, person, icon, reaction, burst, focusLines, streaks, halftone, stripes, rays } from '../../engine/art.js';
import { ransom, ransomPop } from '../../engine/type.js';
import { screen, heads, snap, callingCard, row, inRow, WORDMARK } from './kit.js';
import { FACE } from './strings.js';

/** Six flat "screens" for the montage, drawn into a 1584×875 svg. */
const SET_ZH = { title: '设置', rows: ['显示', '声音', '网络', '账户'], tip: '妈，点这个' };
export function montageArt(svg, set = SET_ZH) {
  const W = 1584, H = 875;
  const mk = () => s('g', {}, svg);
  const out = [];
  // 1 drawing app
  let g = mk(); out.push(g);
  s('rect', { width: W, height: H, fill: '#efe9dc' }, g);
  s('rect', { width: 120, height: H, fill: '#2b3644' }, g);
  ['#ff6b5e', '#ffd05a', '#7fe0c4', '#82b1ff', '#c59cff'].forEach((c, i) => s('circle', { cx: 60, cy: 120 + i * 110, r: 32, fill: c, stroke: '#fff', 'stroke-width': i === 1 ? 8 : 0 }, g));
  s('rect', { x: 260, y: 80, width: 1180, height: 720, rx: 8, fill: '#fffdf7' }, g);
  const dg = s('g', { transform: 'translate(560 140) scale(19)', fill: 'none', stroke: '#2b3644', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
  s('rect', { x: 4.3, y: 8.4, width: 23.6, height: 17.4, rx: 4, fill: '#ffd05a' }, dg);
  s('path', { d: 'm11 4 5 4 5-4M10 29l2-3m10 3-2-3M19 17c1.5-1.8 3.2-1.8 4.7 0' }, dg);
  s('circle', { cx: 11.5, cy: 16.5, r: 1.3, fill: '#2b3644', stroke: 'none' }, dg);
  s('path', { d: 'M3.6 9.2c2-1.4 6-.8 8.3-1.1M27.5 24c-3 2.4-9 2-14 2.2', stroke: '#2b3644', 'stroke-width': 0.6, opacity: 0.6 }, dg);
  const brush = s('g', { transform: 'translate(1180 600) rotate(35)' }, g);
  s('rect', { x: -16, y: -160, width: 32, height: 200, rx: 10, fill: '#ff6b5e', stroke: '#2b3644', 'stroke-width': 6 }, brush);
  s('path', { d: 'M-16 40h32l-16 50Z', fill: '#2b3644' }, brush);
  // 2 video player
  g = mk(); out.push(g);
  const sky = s('linearGradient', { id: 'mSky', x1: 0, y1: 0, x2: 0, y2: 1 }, svg);
  s('stop', { offset: 0, 'stop-color': '#ff9a76' }, sky); s('stop', { offset: 1, 'stop-color': '#ffd59a' }, sky);
  s('rect', { width: W, height: H, fill: 'url(#mSky)' }, g);
  s('circle', { cx: 1100, cy: 500, r: 150, fill: '#fff3c4' }, g);
  s('rect', { y: 560, width: W, height: 320, fill: '#5b7fb8' }, g);
  s('path', { d: 'M0 640Q400 520 800 620T1584 600V875H0Z', fill: '#2e3f5e' }, g);
  const sil = (x, c) => { const p = person({ color: c }); g.appendChild(p.el); p.set({ x, y: 640, s: 1.6, eyes: 'closed' }); };
  sil(520, '#1e2a40'); sil(640, '#1e2a40');
  s('rect', { y: H - 90, width: W, height: 90, fill: 'rgba(0,0,0,.55)' }, g);
  s('rect', { x: 140, y: H - 50, width: 1300, height: 10, rx: 5, fill: 'rgba(255,255,255,.35)' }, g);
  s('rect', { x: 140, y: H - 50, width: 700, height: 10, rx: 5, fill: '#ff4a3d' }, g);
  s('circle', { cx: 840, cy: H - 45, r: 16, fill: '#fff' }, g);
  s('path', { d: 'M60 795v30l26-15Z', fill: '#fff' }, g);
  // 3 photos grid
  g = mk(); out.push(g);
  s('rect', { width: W, height: H, fill: '#f3f5f8' }, g);
  const ph = [
    ['#9ad1ff', (p) => { s('path', { d: 'M0 300 160 120 260 220 340 140 460 300Z', fill: '#4f7a6a' }, p); s('circle', { cx: 380, cy: 80, r: 40, fill: '#ffd05a' }, p); }],
    ['#ffe2b8', (p) => { s('ellipse', { cx: 230, cy: 200, rx: 180, ry: 70, fill: '#e9e2d4' }, p); s('path', { d: 'M60 190Q230 330 400 190Z', fill: '#d9603b' }, p); s('path', { d: 'M110 185q40-40 80 0t80 0 80 0', fill: 'none', stroke: '#ffe9a8', 'stroke-width': 14, 'stroke-linecap': 'round' }, p); }],
    ['#c9b8ff', (p) => { s('path', { d: 'M110 300q0-160 120-160t120 160Z', fill: '#f39b4b' }, p); s('path', { d: 'M130 160l10-60 50 40M330 160l-10-60-50 40', fill: '#f39b4b' }, p); s('circle', { cx: 190, cy: 200, r: 10, fill: '#2b3644' }, p); s('circle', { cx: 270, cy: 200, r: 10, fill: '#2b3644' }, p); }],
    ['#8fd9e8', (p) => { s('rect', { y: 200, width: 460, height: 100, fill: '#ffe1a8' }, p); s('path', { d: 'M0 200q115-40 230 0t230 0V150H0Z', fill: '#3fa7c9' }, p); }],
    ['#2b3366', (p) => { [40, 120, 200, 290, 370].forEach((x, i) => s('rect', { x, y: 120 + (i % 2) * 40, width: 60, height: 200, fill: '#1b2140' }, p)); for (let i = 0; i < 14; i++) s('rect', { x: 50 + (i % 5) * 80, y: 150 + Math.floor(i / 5) * 40, width: 14, height: 14, fill: '#ffd05a' }, p); }],
    ['#ffd1dc', (p) => { [[150, 180], [250, 140], [330, 210]].forEach(([x, y]) => { for (let k = 0; k < 5; k++) s('ellipse', { cx: x + Math.cos(k * 1.256) * 30, cy: y + Math.sin(k * 1.256) * 30, rx: 26, ry: 16, transform: `rotate(${k * 72} ${x + Math.cos(k * 1.256) * 30} ${y + Math.sin(k * 1.256) * 30})`, fill: '#ff7aa2' }, p); s('circle', { cx: x, cy: y, r: 14, fill: '#ffd05a' }, p); }); }],
  ];
  ph.forEach(([bg, draw], i) => {
    const p = s('g', { transform: `translate(${110 + (i % 3) * 470} ${90 + Math.floor(i / 3) * 360}) rotate(${(i % 2 ? 1 : -1) * 2} 230 160)` }, g);
    s('rect', { x: -14, y: -14, width: 488, height: 348, rx: 16, fill: '#fff', stroke: '#d5dbe4', 'stroke-width': 3 }, p);
    s('rect', { width: 460, height: 320, rx: 10, fill: bg }, p);
    const cp = s('g', {}, p);
    draw(cp);
  });
  // 4 how-to (settings window)
  g = mk(); out.push(g);
  s('rect', { width: W, height: H, fill: '#dfe6ef' }, g);
  s('rect', { x: 290, y: 90, width: 1000, height: 700, rx: 20, fill: '#fff', stroke: '#2b3644', 'stroke-width': 5 }, g);
  s('rect', { x: 290, y: 90, width: 1000, height: 70, rx: 20, fill: '#2b3644' }, g);
  s('text', { x: 330, y: 138, 'font-family': 'Noto Sans SC', 'font-weight': 900, 'font-size': 32, fill: '#fff', text: set.title }, g);
  set.rows.forEach((t2, i) => {
    s('text', { x: 360, y: 250 + i * 110, 'font-family': 'Noto Sans SC', 'font-weight': 700, 'font-size': 40, fill: '#2b3644', text: t2 }, g);
    s('rect', { x: 1080, y: 214 + i * 110, width: 120, height: 54, rx: 27, fill: i === 2 ? '#2765ce' : '#c8d1dc' }, g);
    s('circle', { cx: i === 2 ? 1173 : 1107, cy: 241 + i * 110, r: 21, fill: '#fff' }, g);
  });
  s('rect', { x: 1060, y: 418, width: 160, height: 100, rx: 50, fill: 'none', stroke: '#ff4a3d', 'stroke-width': 10 }, g);
  const tip = s('g', { transform: 'translate(820 560)' }, g);
  s('rect', { x: -40, y: 0, width: 300, height: 90, rx: 14, fill: '#ff4a3d' }, tip);
  s('text', { x: 110, y: 60, 'text-anchor': 'middle', 'font-family': 'Noto Sans SC', 'font-weight': 900, 'font-size': set.tip.length > 8 ? 34 : 44, fill: '#fff', text: set.tip }, tip);
  s('path', { d: 'M200 0l60-60', stroke: '#ff4a3d', 'stroke-width': 12, 'stroke-linecap': 'round' }, tip);
  // 5 camera: the cat
  g = mk(); out.push(g);
  s('rect', { width: W, height: H, fill: '#c9b59a' }, g);
  s('rect', { x: 0, y: 560, width: W, height: 320, fill: '#a68a6a' }, g);
  s('rect', { x: 1100, y: 120, width: 300, height: 380, rx: 10, fill: '#d9c8ad' }, g);
  const cat = s('g', { transform: 'translate(792 520)' }, g);
  s('path', { d: 'M-330 360q0-420 330-420t330 420Z', fill: '#f39b4b' }, cat);
  s('path', { d: 'M-250-10l-40-240 190 130M250-10l40-240-190 130', fill: '#f39b4b' }, cat);
  s('path', { d: 'M-230-60l-25-130 100 70M230-60l25-130-100 70', fill: '#ffc9a8' }, cat);
  s('path', { d: 'M-40 40l-120-20M-40 60l-120 20M40 40l120-20M40 60l120 20', stroke: '#7a4a2a', 'stroke-width': 6, 'stroke-linecap': 'round' }, cat);
  const catEyes = [s('ellipse', { cx: -110, cy: -40, rx: 26, ry: 34, fill: '#2b3644' }, cat), s('ellipse', { cx: 110, cy: -40, rx: 26, ry: 34, fill: '#2b3644' }, cat)];
  s('path', { d: 'M-18 10h36l-18 18Z', fill: '#e2607a' }, cat);
  s('path', { d: 'M0 28q-20 30-46 10M0 28q20 30 46 10', fill: 'none', stroke: '#7a4a2a', 'stroke-width': 6, 'stroke-linecap': 'round' }, cat);
  const rec = s('g', { transform: 'translate(70 70)' }, g);
  s('circle', { r: 18, fill: '#ff4a3d' }, rec);
  s('text', { x: 34, y: 14, 'font-family': 'Anton', 'font-size': 40, fill: '#fff', text: 'CAM' }, rec);
  // 6 homework
  g = mk(); out.push(g);
  s('rect', { width: W, height: H, fill: '#e9e2cf' }, g);
  s('rect', { x: 300, y: 60, width: 980, height: 760, fill: '#fffdf5', stroke: '#c9c0a8', 'stroke-width': 4 }, g);
  for (let i = 0; i < 12; i++) s('path', { d: `M330 ${150 + i * 56}h920`, stroke: '#cfe0f5', 'stroke-width': 3 }, g);
  s('path', { d: 'M400 60v760', stroke: '#ffb3b3', 'stroke-width': 4 }, g);
  ['3x + 5 = 20', 'x = 5  ✓', '√144 = 12  ✓', '2⁸ = 256'].forEach((q, i) => s('text', { x: 440, y: 200 + i * 112, 'font-family': 'Smiley Sans', 'font-size': 64, fill: i % 2 ? '#2765ce' : '#2b3644', text: q }, g));
  const pen = s('g', { transform: 'translate(1080 560) rotate(40)' }, g);
  s('rect', { x: -14, y: -220, width: 28, height: 240, fill: '#ffd05a', stroke: '#2b3644', 'stroke-width': 5 }, pen);
  s('path', { d: 'M-14 20h28L0 60Z', fill: '#f3d2a4', stroke: '#2b3644', 'stroke-width': 5, 'stroke-linejoin': 'round' }, pen);
  return { scenes: out, catEyes };
}

export function build(film, K) {
  const A = (b, beat = 1) => K.at(b, beat);
  const S = film.S, EN = film.lang === 'en', F = FACE[film.lang];

  // ------------------------------------------------ S13 · NOT JUST GAMES
  const cuts = [A(27, 3), A(27, 4), A(28, 1), A(28, 2), A(28, 3), A(28, 4)];
  const labels = S.montage;
  film.scene('s13-more', snap(A(27, 1)), snap(A(29, 1)), root => {
    root.style.background = C.night;
    const mont = h('div', { class: 'fill' }, root);
    const glow = h('div', { class: 'fill' }, mont);
    glow.style.background = 'radial-gradient(60% 55% at 50% 45%, rgba(255,208,90,.16), transparent 70%)';
    const sc = screen(mont, { x: 150, y: 46, w: 1620, hgt: 911 });
    const sv = s('svg', { width: sc.w, height: sc.h, viewBox: '0 0 1584 875', preserveAspectRatio: 'xMidYMid slice' }, sc.content);
    const art = montageArt(sv, S.settings);
    const hd = heads(mont, { y: 1010 });
    const tags = labels.map(([zh, en], i) => {
      const el = h('div', { class: 'abs' }, mont);
      const r = ransom(el, zh, { size: 120, seed: 100 + i * 7 });
      const e = h('div', { class: 'abs hud nowrap', text: en }, el);
      if (!en) e.style.display = 'none';
      Object.assign(e.style, { left: '6px', top: '150px', padding: '8px 14px', background: C.ink2, color: C.yellow, font: '800 28px/1 "Barlow Condensed"', letterSpacing: '.22em' });
      T(el, { x: 210, y: 110 });
      return { el, r };
    });
    const sup = h('div', { class: 'abs nowrap center' }, root);
    Object.assign(sup.style, { left: '0', top: '820px', width: '1920px', height: '120px', gap: '26px', background: C.red, color: '#fff', transform: 'rotate(-2deg)' });
    sup.innerHTML = `<b style="font:${EN ? '400 76px/1 Anton;letter-spacing:.03em' : '900 70px/1 Noto Sans SC'}">${S.anything[0]}</b>` + (S.anything[1] ? `<span style="font:800 28px/1 Barlow Condensed;letter-spacing:.22em">${S.anything[1]}</span>` : '');
    // title card
    const tc = h('div', { class: 'fill' }, root);
    tc.style.background = `${halftone('rgba(255,208,90,.14)', 22, 26)}, ${C.ink2}`;
    const tz = h('div', { class: 'abs zh nowrap', text: S.notJust[0] }, tc);
    Object.assign(tz.style, { left: '0', width: '1920px', textAlign: 'center', top: EN ? '330px' : '300px', font: EN ? '400 250px/1 Anton' : '900 300px/1 "Noto Sans SC"', letterSpacing: EN ? '.02em' : '0', color: C.cream });
    const te = h('div', { class: 'abs anton nowrap', text: S.notJust[1] }, tc);
    if (!S.notJust[1]) te.style.display = 'none';
    Object.assign(te.style, { left: '0', width: '1920px', textAlign: 'center', top: '650px', font: '400 120px/1 Anton', color: C.yellow, letterSpacing: '.06em' });
    const strike = h('div', { class: 'abs' }, tc);
    Object.assign(strike.style, { left: '560px', top: '700px', width: '800px', height: '0' });
    return (lt, t) => {
      const idx = cuts.filter(c => t >= c).length - 1;
      show(tc, idx < 0);
      show(mont, idx >= 0);
      T(tz, { s: lerp(1.5, 1, E.outBack(prog(A(27, 1), A(27, 1) + 0.18, t))) });
      T(te, { y: (1 - E.outExpo(prog(A(27, 1) + 0.08, A(27, 1) + 0.4, t))) * 60, o: prog(A(27, 1) + 0.08, A(27, 1) + 0.16, t) });
      art.scenes.forEach((g, i) => g.style.display = i === idx ? '' : 'none');
      tags.forEach((tg, i) => {
        show(tg.el, i === idx);
        if (i === idx) ransomPop(tg.r.chars, t, tg.r.chars.map((_, k) => cuts[i] + k * 0.04), { dur: 0.12 });
      });
      art.catEyes.forEach(e => e.setAttribute('ry', (t * 3) % 1 > 0.85 ? 4 : 34));
      hd.set(t, { bob: (i, tt) => idx >= 0 ? -pulse(tt, cuts[idx], cuts[idx] + 0.25, 0.03, 0.2) * (10 + i * 3) : 0 });
      const zp = idx >= 0 ? E.out3(prog(cuts[idx], cuts[idx] + 0.3, t)) : 0;
      T(mont, { s: lerp(1.06, 1, zp), ox: '50%', oy: '45%' });
      const sp = E.outExpo(prog(cuts[0], cuts[0] + 0.3, t));
      sup.style.transform = `rotate(-2deg) translateX(${(1 - sp) * -2000}px)`;
      show(sup, idx >= 0);
    };
  });

  // ------------------------------------------------ S14 · the facts
  const facts = [
    { ic: 'check', zh: S.facts[0][0], en: S.facts[0][1], at: A(29, 1) },
    { ic: 'link', zh: S.facts[1][0], en: S.facts[1][1], at: A(29, 3) },
    { ic: 'couch', zh: S.facts[2][0], en: S.facts[2][1], at: A(30, 1) },
    { ic: 'play', zh: S.facts[3][0], en: S.facts[3][1], at: A(30, 3) },
    { ic: 'sliders', zh: S.facts[4][0], en: S.facts[4][1], at: A(31, 1) },
  ];
  film.scene('s14-facts', snap(A(29, 1)), snap(A(31, 3)), root => {
    root.style.background = `${halftone('rgba(25,37,48,.2)', 18, 30)}, ${C.yellow}`;
    const wedge = h('div', { class: 'abs' }, root);
    Object.assign(wedge.style, { left: '-300px', top: '-200px', width: '1150px', height: '1500px', background: C.ink2, transform: 'rotate(12deg)' });
    const mc = h('div', { class: 'abs' }, root);
    const m = mascot({ stroke: C.cream, fill: C.ink2, size: 560 });
    mc.appendChild(m.el);
    const lab = h('div', { class: 'abs hud nowrap', html: 'PIIK<br>FACT SHEET' }, root);
    Object.assign(lab.style, { left: '120px', top: '820px', font: '800 44px/1.1 "Barlow Condensed"', letterSpacing: '.2em', color: C.yellow });
    const rows = facts.map((f, i) => {
      const el = h('div', { class: 'abs' }, root);
      Object.assign(el.style, { left: '760px', top: 90 + i * 182 + 'px', width: '1100px', height: '150px', background: i % 2 ? C.cream : C.ink2, border: `6px solid ${C.ink2}`, boxShadow: `12px 12px 0 ${i % 2 ? C.ink2 : C.red}`, transform: 'skewX(-12deg)' });
      const un = h('div', { class: 'fill' }, el);
      un.style.transform = 'skewX(12deg)';
      const n = h('div', { class: 'abs anton', text: '0' + (i + 1) }, un);
      Object.assign(n.style, { left: '30px', top: '24px', font: '400 96px/1 Anton', color: i % 2 ? C.red : C.yellow });
      const ic = icon(f.ic, { size: 84, color: i % 2 ? C.ink2 : C.cream, sw: 2.2 });
      Object.assign(ic.style, { position: 'absolute', left: '150px', top: '30px' });
      un.appendChild(ic);
      const z = h('div', { class: 'abs zh nowrap', text: f.zh }, un);
      Object.assign(z.style, { left: '270px', top: f.en ? '22px' : '36px', font: EN ? `400 ${f.zh.length > 22 ? 58 : 76}px/1 Anton` : '900 64px/1 "Noto Sans SC"', letterSpacing: EN ? '.03em' : '0', color: i % 2 ? C.ink2 : C.cream });
      const e = h('div', { class: 'abs hud nowrap', text: f.en }, un);
      Object.assign(e.style, { left: '274px', top: '100px', font: '800 26px/1 "Barlow Condensed"', letterSpacing: '.22em', color: i % 2 ? C.ink2 : C.yellow, opacity: 0.85 });
      return { el, f, i };
    });
    return (lt, t) => {
      const wp = E.outExpo(prog(A(29, 1), A(29, 1) + 0.35, t));
      wedge.style.transform = `rotate(12deg) translateX(${(1 - wp) * -1300}px)`;
      const bob = Math.abs(Math.sin((t - A(29, 1)) * Math.PI / K.spb));
      T(mc, { x: 90 + (1 - wp) * -900, y: 160 - bob * 26 });
      m.set({ wink: Math.floor((t - A(29, 1)) / K.spb) % 4 === 3 ? 0 : 1, squash: 1 - bob * 0.05, antenna: Math.sin(t * 9) * 6 });
      T(lab, { x: (1 - wp) * -500 });
      rows.forEach(r => {
        const p = E.outBack(prog(r.f.at, r.f.at + 0.24, t));
        const off = (1 - E.outExpo(prog(r.f.at, r.f.at + 0.24, t))) * 1400;
        r.el.style.transform = `translateX(${off}px) skewX(-12deg) rotate(${(1 - p) * (r.i % 2 ? 4 : -4)}deg)`;
        r.el.style.opacity = t >= r.f.at ? 1 : 0;
      });
      let sx = 0, sy = 0;
      facts.forEach((f, i) => { const q = shake(t, f.at, 0.2, 10, 40, 80 + i); sx += q.x; sy += q.y; });
      T(root, { x: sx, y: sy });
    };
  });

  // ------------------------------------------------ S15 · the calling card returns → logo
  film.scene('s15-end', snap(A(31, 3)), 64.0, root => {
    root.style.background = `${halftone('rgba(25,37,48,.2)', 18, 30)}, ${C.yellow}`;
    const fl = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, root);
    const flg = s('g', { transform: 'translate(960 540)' }, fl);
    s('path', { d: focusLines(100, 460, 1500, 33, 0.011), fill: C.ink2, opacity: 0.5 }, flg);
    const persp = h('div', { class: 'fill' }, root);
    persp.style.perspective = '1800px';
    const card = callingCard(persp, { lines: [S.endCard.l1, S.endCard.l2], sign: S.endCard.sign, top: 'No.9527', seed: 21, sizes: EN ? [100, 100] : [112, 128] });
    // logo lockup (wordmark-dark)
    const lock = h('div', { class: 'fill' }, root);
    lock.style.background = C.ink2;
    const lstr = h('div', { class: 'abs' }, lock);
    Object.assign(lstr.style, { left: '-400px', top: '-400px', width: '2800px', height: '1900px', background: stripes('rgba(255,208,90,.045)', 'transparent', 30, -35) });
    const brand = row(lock, { x: 470, y: 75, w: 980, gap: 40, justify: 'flex-start', align: 'baseline' });
    const lm = h('div', {}, brand);
    // The visible feet end at 30.2 in the [-2, 34] SVG bounds, above its box baseline.
    lm.style.translate = `0 ${3.8 / 36 * 100}%`;
    const m = mascot({ stroke: C.cream, size: 380 });
    m.el.classList.add('lr-brand-mark', 'is-animated');
    const shell = s('g', { class: 'lr-brand-shell' }, m.parts.body.parentNode);
    shell.append(m.parts.antenna, m.parts.body, m.parts.feet);
    for (const [name, part] of Object.entries({ frame: m.parts.body, antenna: m.parts.antenna,
      feet: m.parts.feet, face: m.parts.face, 'eye-left': m.parts.eyeL,
      'eye-open': m.parts.eyeR, 'eye-wink': m.parts.wink, sparkles: m.parts.sparkles })) {
      part.classList.add(`lr-brand-${name}`);
    }
    for (const part of shell.children) part.setAttribute('pathLength', '1');
    m.parts.sparkles.removeAttribute('transform');
    m.parts.sparkles.children[0].setAttribute('d', 'm25 11.5 .8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z');
    m.parts.sparkles.children[1].setAttribute('d', 'm25 17.2 .45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45.45-1.1Z');
    lm.appendChild(m.el);
    const wm = h('div', { class: 'nowrap', html: 'Piik<span class="identity-dot">.</span>' }, brand);
    Object.assign(wm.style, { font: WORDMARK(300), letterSpacing: '-14px', color: C.cream });
    const tag = h('div', { class: 'abs nowrap' }, lock);
    Object.assign(tag.style, { left: '0', width: '1920px', textAlign: 'center', top: '535px', color: C.cream });
    tag.innerHTML = `<div style="font:${EN ? '400 96px/1 Anton;letter-spacing:.02em' : '900 76px/1 Noto Sans SC'};color:${C.yellow}">${S.tagline[0]}</div>` + (S.tagline[1] ? `<div style="margin-top:22px;font:800 34px/1 Barlow Condensed;letter-spacing:.3em">${S.tagline[1]}</div>` : '');
    const features = h('div', { class: `a-ending-features${EN ? ' is-english' : ''}` }, lock);
    S.closingFeatures.forEach((label, i) => {
      const item = h('div', { class: 'a-ending-feature' }, features);
      const glyph = icon(['cast', 'microphone', 'mouse'][i], { size: 56, color: C.ink2 });
      item.appendChild(glyph);
      h('span', { text: label }, item);
    });
    const url = h('div', { class: 'abs nowrap center' }, lock);
    Object.assign(url.style, { left: '0', width: '1920px', top: '870px', font: '700 68px/1 "JetBrains Mono"', color: C.cream });
    url.innerHTML = `<span style="padding:8px 28px;border:3px solid ${C.cream};border-radius:48px">piik.tv</span>`;
    const note = h('div', { class: 'abs nowrap', html: S.footer }, lock);
    Object.assign(note.style, { left: '0', top: '90px', width: '1920px', textAlign: 'center', font: '500 30px/1 "Noto Sans SC"', letterSpacing: '.04em', color: C.cream, opacity: '.75' });
    const flash = h('div', { class: 'fill' }, root);
    flash.style.background = '#fff';
    const land = A(32, 1);
    const pops = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(x => land + x * K.spb);
    return (lt, t) => {
      flg.setAttribute('transform', `translate(960 540) rotate(${t * 8})`);
      const fly = E.out3(prog(A(31, 3), land, t));
      const tx = lerp(2300, 680, fly), ty = lerp(-700, 150, fly);
      card.el.style.transform = `translate(${tx}px, ${ty}px) rotateZ(${(1 - fly) * -540}deg) rotateY(${(1 - fly) * 180}deg) scale(${lerp(0.4, 1, fly) * (1 + pulse(t, land, land + 0.2, 0.02, 0.18) * 0.04)})`;
      card.sg.style.opacity = prog(A(32, 4.5), A(32, 4.5) + 0.1, t);
      // zh: one character per jingle note; en: words land on the strong notes
      ransomPop(card.r1.chars, t, EN ? [pops[0], pops[2]] : pops.slice(0, 4));
      ransomPop(card.r2.chars, t, EN ? [pops[4], pops[6], pops[7]] : pops.slice(4));
      // logo
      const L = A(33, 1);
      show(lock, t >= L);
      lstr.style.transform = `translateX(${((t * 40) % 84.85)}px)`;
      const mp = E.outBack(prog(L, L + 0.3, t));
      T(lm, { y: (1 - mp) * 80, s: lerp(0.4, 1, mp), r: (1 - mp) * -20 });
      lm.style.transformOrigin = '50% 70%';
      const tl = Math.max(0, t - L);
      // Scrub the shared product animation with the film clock, including seeks.
      for (const animation of m.el.getAnimations({ subtree: true })) {
        animation.currentTime = tl * 1000;
      }
      T(wm, { x: (1 - E.outExpo(prog(L + 0.08, L + 0.45, t))) * 260, o: prog(L + 0.08, L + 0.18, t) });
      T(tag, { y: (1 - E.outExpo(prog(A(33, 3), A(33, 3) + 0.4, t))) * 40, o: prog(A(33, 3), A(33, 3) + 0.15, t) });
      T(features, { y: (1 - E.outExpo(prog(A(33, 4), A(34, 1), t))) * 45, o: prog(A(33, 4), A(33, 4) + 0.15, t) });
      T(url, { o: prog(A(34, 1), A(34, 1) + 0.25, t) });
      O(flash, pulse(t, L, L + 0.14, 0.01, 0.13) * 0.95);
      const sh = shake(t, land, 0.25, 12, 40, 91);
      T(persp, { x: sh.x, y: sh.y });
    };
  });
}
