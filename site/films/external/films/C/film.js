// Film C — 沙发够长 PLENTY OF ROOM. 9:16 social cut, 150 BPM, 12 bars + tail = 20 s, zh / en.
// One link, and the sofa keeps growing until 1 host + 20 viewers fit — a snake of a sofa.
// Module contract: engine/ENGINE.md (films/C/index.html, tools/render.py, <piik-promo film="C">).
import { Film, clock, h, s, T, ST, O, kf, prog, E, clamp, lerp, rng, show, pulse, shake } from '../../engine/core.js';
import { C, CAST, person, mascot, icon, reaction, burst, halftone, rays } from '../../engine/art.js';
import { grainLayer, grungeURL } from '../../engine/tex.js';
import { montageArt } from '../A/s5.js';
import { thrown, WORDMARK } from '../A/kit.js';
import { STRINGS } from './strings.js';

const u = p => new URL(p, import.meta.url).href;
const F = (family, file, weight) => ({ family, file, ...(weight ? { weight } : {}) });
export const meta = {
  id: 'C',
  title: { zh: '沙发够长', en: 'Plenty of Room' },
  size: [1080, 1920], duration: 20, fps: 60, poster: 9.3, langs: ['zh', 'en'],
  css: [u('../../engine/film.css'), u('./style.css')],
  fonts: [
    F('Noto Sans SC', 'NotoSansSC-Variable.ttf', '100 900'),
    F('Anton', 'Anton.ttf'),
    F('Barlow Condensed', 'BarlowCondensed-ExtraBold.ttf', '800'),
    F('JetBrains Mono', 'JetBrainsMono[wght].ttf', '100 800'),
    F('Arimo', 'Arimo[wght].ttf', '400 700'),
    F('ZCOOL KuaiLe', 'ZCOOLKuaiLe-Regular.ttf'),
    F('Smiley Sans', 'SmileySans-Oblique.ttf'),
  ],
  audio: { webm: u('../../out/C/audio/web.webm'), m4a: u('../../out/C/audio/web.m4a') },
};

/** Cubic Bézier arc length by sampling (no DOM: works before layout and inside display:none). */
function cubicLen(p0, p1, p2, p3, n = 400) {
  let L = 0, px = p0[0], py = p0[1];
  for (let i = 1; i <= n; i++) {
    const t = i / n, m = 1 - t;
    const x = m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0];
    const y = m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1];
    L += Math.hypot(x - px, y - py); px = x; py = y;
  }
  return L;
}

export async function build(stage, { lang = 'zh', signal } = {}) {
const cues = await (await fetch(u('./cues.json'))).json();
const K = clock(cues.bpm, cues.beatsPerBar);
const A = (b, beat = 1) => K.at(b, beat);
const spb = K.spb;
const film = new Film({ stage, width: 1080, height: 1920, duration: cues.length, fps: 60, background: C.ink, lang });
film.clock = K;
const S = (film.S = STRINGS[lang] || STRINGS.zh), EN = lang === 'en';
const snap = t => Math.round(t * 60) / 60;

// ---------------------------------------------------------------- world: the snake sofa
const ROWS = [1100, 1430, 1760];          // feet line per row
const X0 = 190, X1 = 890, CTRL = 165;     // row extent and U-turn bulge
const SEATS_PER_ROW = 7, SP = (X1 - X0) / SEATS_PER_ROW;
const CS = 1.36;                          // character scale
const PATH = `M${X0} ${ROWS[0] + 4}H${X1}C${X1 + CTRL} ${ROWS[0] + 4} ${X1 + CTRL} ${ROWS[1] + 4} ${X1} ${ROWS[1] + 4}H${X0}C${X0 - CTRL} ${ROWS[1] + 4} ${X0 - CTRL} ${ROWS[2] + 4} ${X0} ${ROWS[2] + 4}H${X1}`;
// 21 seats: host + 20 viewers; serpentine order
const seats = [];
for (let r = 0; r < 3; r++) for (let i = 0; i < SEATS_PER_ROW; i++) {
  const k = r % 2 ? SEATS_PER_ROW - 1 - i : i;
  seats.push({ x: X0 + SP * (k + 0.5), y: ROWS[r], r });
}
// landing times: host at [1,1]; friends 1–8 on quarters (bars 3–4), 9–19 on 8ths (bars 5–6), the 20th lands with the stamp [6,3]
const LAND = [A(1, 1)];
for (let i = 0; i < 8; i++) LAND.push(A(3, 1 + i));
for (let i = 0; i < 11; i++) LAND.push(A(5, 1 + i * 0.5));
LAND.push(A(6, 3));
const HUES = [148, 236, 309, 55, 0, 190, 100, 270, 25, 330, 165, 212, 290, 75, 345, 125, 250, 40, 180, 318, 88];

/** Small accessories that make 21 identical beans read as 21 friends. */
function accessorize(p, kind, color) {
  const g = p.parts.head;
  const ink = C.ink;
  if (kind === 'phones') { s('path', { d: 'M-21-34a21 21 0 0 1 42 0', fill: 'none', stroke: ink, 'stroke-width': 3.4 }, g); s('rect', { x: -25, y: -38, width: 8, height: 14, rx: 3, fill: ink }, g); s('rect', { x: 17, y: -38, width: 8, height: 14, rx: 3, fill: ink }, g); }
  if (kind === 'cap') { s('path', { d: 'M-19-38a19 15 0 0 1 38 0Z', fill: '#ff4a3d', stroke: ink, 'stroke-width': 2 }, g); s('path', { d: 'M8-40h20', stroke: ink, 'stroke-width': 4, 'stroke-linecap': 'round' }, g); }
  if (kind === 'bow') { s('path', { d: 'M8-52l8-6v12ZM24-52l-8-6v12Z', fill: '#ff6b8b', stroke: ink, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, g); }
  if (kind === 'glasses') { s('circle', { cx: -7, cy: -31, r: 6, fill: 'none', stroke: ink, 'stroke-width': 2 }, g); s('circle', { cx: 7, cy: -31, r: 6, fill: 'none', stroke: ink, 'stroke-width': 2 }, g); s('path', { d: 'M-1-31h2', stroke: ink, 'stroke-width': 2 }, g); }
  if (kind === 'sprout') { s('path', { d: 'M0-51v-9', stroke: '#3f8f5a', 'stroke-width': 2.6 }, g); s('path', { d: 'M0-58c4-6 10-6 12-2-4 4-8 4-12 2Z', fill: '#5fc37a', stroke: ink, 'stroke-width': 1.4 }, g); }
  if (kind === 'ears') { s('path', { d: 'M-16-44l-4-14 12 7ZM16-44l4-14-12 7Z', fill: color, stroke: 'none' }, g); }
  if (kind === 'beanie') { s('path', { d: 'M-20-36a20 18 0 0 1 40 0Z', fill: '#2765ce', stroke: ink, 'stroke-width': 2 }, g); s('circle', { cx: 0, cy: -55, r: 4, fill: '#fff', stroke: ink, 'stroke-width': 1.6 }, g); }
}
const ACC = ['crown', 'phones', null, 'glasses', 'bow', 'cap', 'sprout', 'ears', 'beanie', null, 'phones', 'bow', 'glasses', 'cap', 'ears', null, 'sprout', 'beanie', 'phones', 'bow', 'glasses'];

film.scene('c-main', 0, snap(A(11, 1)), root => {
  root.style.background = `radial-gradient(90% 40% at 50% 18%, #2e4263 0%, ${C.ink} 70%)`;
  const dots = h('div', { class: 'fill' }, root);
  dots.style.background = halftone('rgba(255,208,90,.10)', 26, 22);
  const flash = h('div', { class: 'fill' }, root);
  flash.style.background = `${rays('rgba(25,37,48,.10)', 'transparent', 22)}, ${C.yellow}`;
  const world = h('div', { class: 'abs' }, root);
  Object.assign(world.style, { width: '1080px', height: '1920px', transformOrigin: '0 0' });
  // the shared screen at the top of the room
  const tv = h('div', { class: 'abs' }, world);
  Object.assign(tv.style, { left: '90px', top: '262px', width: '900px', height: '560px', background: '#1b2733', borderRadius: '30px', boxShadow: '0 0 0 6px #0b1117, 0 0 120px rgba(130,177,255,.35)' });
  const tvc = h('div', { class: 'abs' }, tv);
  Object.assign(tvc.style, { left: '18px', top: '18px', width: '864px', height: '524px', borderRadius: '16px', overflow: 'hidden' });
  const tsv = s('svg', { width: 864, height: 524, viewBox: '0 0 1584 875', preserveAspectRatio: 'xMidYMid slice' }, tvc);
  const art = montageArt(tsv);
  art.scenes.forEach((g, k) => g.style.display = k === 1 ? '' : 'none');
  const live = h('div', { class: 'abs lab', html: '<i style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#fff;margin-right:10px"></i>LIVE · PIIK' }, tv);
  Object.assign(live.style, { left: '40px', top: '40px', padding: '10px 14px', background: C.red, color: '#fff', borderRadius: '8px' });
  // sofa (one fat stroked path, revealed as people arrive)
  const sv = s('svg', { width: 1080, height: 1920, style: 'position:absolute;left:0;top:0' }, world);
  const outline = s('path', { d: PATH, fill: 'none', stroke: C.ink2, 'stroke-width': 118, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sv);
  const body = s('path', { d: PATH, fill: 'none', stroke: C.yellow, 'stroke-width': 104, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sv);
  const seam = s('path', { d: PATH, fill: 'none', stroke: 'rgba(25,37,48,.16)', 'stroke-width': 4, transform: 'translate(0 26)' }, sv);
  // arc-length of each seat along the path (computed analytically — no layout needed)
  const U = cubicLen([X1, ROWS[0] + 4], [X1 + CTRL, ROWS[0] + 4], [X1 + CTRL, ROWS[1] + 4], [X1, ROWS[1] + 4]);
  const total = 3 * (X1 - X0) + 2 * U;
  const seatLen = seats.map(st => st.r === 0 ? st.x - X0 : st.r === 1 ? (X1 - X0) + U + (X1 - st.x) : 2 * (X1 - X0) + 2 * U + (st.x - X0));
  const people = seats.map((st, i) => {
    const hue = HUES[i];
    const col = i < 4 ? [C.green, C.blue, C.purple, C.orange][i] : `oklch(0.74 0.12 ${hue})`;
    const p = person({ color: col, crown: i === 0 });
    if (ACC[i] && ACC[i] !== 'crown') accessorize(p, ACC[i], col);
    sv.appendChild(p.el);
    return { p, st, col, seed: i * 17 + 3 };
  });
  // landing puffs
  const puffG = s('g', {}, sv);
  const puffs = seats.map(() => [0, 1, 2, 3].map(() => s('circle', { r: 10, fill: C.cream, opacity: 0 }, puffG)));
  // reactions on the drop
  const fx = h('div', { class: 'fill' }, world);
  // one burst per beat of the drop; the lead item of beat 3 is a tomato ([7,3] splat) and of beat 7 a poop ([8,3] boing)
  const lead = ['heart', 'star', 'tomato', 'heart', 'star', 'heart', 'poop', 'star'];
  const flies = [];
  for (let b = 0; b < 8; b++) for (let j = 0; j < 3; j++) {
    const i = (b * 3 + j * 7 + 1) % 21, st = seats[i];
    const kind = j === 0 ? lead[b] : (b + j) % 2 ? 'heart' : 'star';
    flies.push(thrown(fx, { kind, from: [st.x, st.y - 160], to: [200 + ((b * 211 + j * 157) % 700), 340 + ((b * 97 + j * 131) % 400)], t0: A(7 + Math.floor(b / 4), 1 + (b % 4)) - spb * 0.9 + j * 0.05, dur: spb * 0.9, arc: 180, size: 92, seed: 60 + b * 3 + j, splatR: 60, life: kind === 'tomato' ? 1.2 : kind === 'poop' ? 1.0 : 0.01, spin: 240 }));
  }
  // screen-space overlays
  const ov = h('div', { class: 'fill' }, root);
  const t1 = h('div', { class: 'sticker', text: S.l1 }, ov);
  const t2 = h('div', { class: 'sticker', text: S.l2 }, ov);
  if (EN) for (const el of [t1, t2]) Object.assign(el.style, { fontFamily: 'Anton', fontWeight: 400, letterSpacing: '.02em' });
  Object.assign(t1.style, { left: '80px', top: '180px', fontSize: '118px' });
  Object.assign(t2.style, { left: '160px', top: '330px', fontSize: '118px', color: C.blue });
  const link = h('div', { class: 'abs' }, ov);
  Object.assign(link.style, { display: 'flex', alignItems: 'center', gap: '14px', padding: '18px 26px', background: C.cream, border: `6px solid ${C.ink2}`, borderRadius: '50px', font: '900 46px/1 "Noto Sans SC"', boxShadow: `8px 10px 0 ${C.ink2}`, whiteSpace: 'nowrap' });
  link.appendChild(icon('link', { size: 52, color: C.ink2, sw: 2.6 }));
  h('span', { text: S.send }, link);
  const cnt = h('div', { class: 'abs mono' }, ov);
  Object.assign(cnt.style, { right: '60px', left: 'auto', top: '70px', textAlign: 'right', color: C.cream });
  cnt.innerHTML = `<div class="lab" style="color:#ffd05a;font-size:24px">${S.viewers}</div><div><b style="font:800 150px/1 JetBrains Mono">0</b><span style="font:800 60px/1 JetBrains Mono;opacity:.7"> / 20</span></div>`;
  const cntN = cnt.querySelector('b');
  const stamp = h('div', { class: 'abs', html: `${S.stamp[0]}<br><span style="font:800 34px/1 Barlow Condensed;letter-spacing:.24em">${S.stamp[1]}</span>` }, ov);
  Object.assign(stamp.style, { left: '150px', top: '330px', padding: '18px 34px 22px', border: `12px solid ${C.red}`, color: C.red, background: 'rgba(255,254,251,.94)', font: '900 120px/1.05 "Noto Sans SC"', borderRadius: '18px', textAlign: 'center', WebkitMaskImage: `url(${grungeURL()})`, WebkitMaskSize: '700px', maskImage: `url(${grungeURL()})`, maskSize: '700px' });
  if (EN) Object.assign(stamp.style, { fontFamily: 'Anton', fontWeight: 400, fontSize: '150px', letterSpacing: '.02em' });
  const slams = S.slams.map((txt, i) => {
    const el = h('div', { class: 'sticker', text: txt }, ov);
    // keep every slam inside the 1080 px frame: size from the string length (CJK ≈ 1 em per glyph, Anton ≈ 0.48 em)
    const fit = Math.floor(960 / ([...txt].length * (EN ? 0.48 : 1)));
    Object.assign(el.style, { left: '0', width: '1080px', textAlign: 'center', top: 270 + i * 175 + 'px', fontSize: Math.min(124, fit) + 'px', ...(EN ? { fontFamily: 'Anton', fontWeight: 400, letterSpacing: '.02em' } : {}), color: [C.ink2, C.blue, C.ink2, C.red][i], transformOrigin: '50% 50%' });
    return el;
  });
  const dm = h('div', { class: 'fill' }, ov);
  const dms = S.danmaku.map((txt, i) => {
    const d = h('div', { class: 'abs', text: txt }, dm);
    Object.assign(d.style, { font: '800 58px/1 "Noto Sans SC"', color: ['#fff', '#ffd05a', '#a9dcff', '#ffb3c7'][i % 4], WebkitTextStroke: `9px ${C.ink2}`, paintOrder: 'stroke fill', whiteSpace: 'nowrap' });
    return { d, t0: A(7, 1) + i * spb * 0.5, y: 320 + (i * 137) % 460 };
  });
  return (lt, t) => {
    // ---------------- camera: close on the host, follow arrivals, then the whole snake
    const n = LAND.filter(x => t >= x).length;               // people seated
    const target = seats[Math.max(0, Math.min(20, n - 1))];
    const zoomOut = E.io3(prog(A(5, 1), A(6, 3), t));
    const focusX = kf(t, [[0, seats[0].x + 150], [A(3, 1), seats[0].x + 150], [A(4, 4), seats[7].x - 120, 'io2']]);
    const focusY = kf(t, [[0, ROWS[0] - 120], [A(4, 4), ROWS[0] - 120], [A(5, 4), ROWS[1] - 100, 'io2']]);
    const sZoom = kf(t, [[0, 2.25], [A(2, 1), 2.25], [A(2, 2), 1.85, 'out3'], [A(5, 1), 1.75]]);
    const sc = lerp(sZoom, 1, zoomOut);
    const fx2 = lerp(focusX, 540, zoomOut), fy2 = lerp(focusY, 960, zoomOut);
    const bump = pulse(t, A(7, 1), A(7, 1) + 0.4, 0.02, 0.38) * 0.05;
    const sh = shake(t, A(7, 1), 0.5, 22, 30, 5), sh2 = shake(t, A(6, 3), 0.3, 14, 40, 9);
    world.style.transform = `translate(${540 - fx2 * sc * (1 + bump) + sh.x + sh2.x}px, ${960 - fy2 * sc * (1 + bump) + sh.y + sh2.y}px) scale(${sc * (1 + bump)})`;
    // ---------------- sofa growth
    const want = n <= 1 ? seatLen[1] + SP * 0.4 : seatLen[Math.min(20, n)] + SP * 0.55;
    const prev = n <= 1 ? want : seatLen[Math.min(20, n - 1)] + SP * 0.55;
    const tl = LAND[Math.min(20, n - 1)] || 0;
    const grow = n >= 21 ? total : lerp(prev, want, E.outBack(prog(tl - 0.08, tl + 0.12, t)));
    const L = Math.min(total, Math.max(SP * 1.4, grow));
    for (const p of [outline, body]) { p.setAttribute('stroke-dasharray', `${L} ${total + 400}`); }
    seam.setAttribute('stroke-dasharray', `${Math.max(0, L - 40)} ${total + 400}`);
    // ---------------- people
    people.forEach((pp, i) => {
      const land = LAND[i];
      const fall = prog(land - 0.18, land, t);
      const after = t - land;
      const visible = t >= land - 0.18;
      let y = pp.st.y, sq = 1;
      if (!visible) { pp.p.set({ o: 0 }); return; }
      if (after < 0) { y = lerp(pp.st.y - 900, pp.st.y, E.in2(fall)); sq = 1 + 0.25 * fall; }
      else sq = 1 - 0.34 * Math.exp(-after * 9) * Math.cos(after * 26);
      const dance = t >= A(7, 1) ? Math.abs(Math.sin((t - A(7, 1)) * Math.PI / spb + i * 0.6)) * 22 : 0;
      const look = t < A(2, 2) ? [0, 0] : t < A(3, 1) && i === 0 ? [3, 0] : [0, 0];
      const eyes = after < 0.25 && after >= 0 ? 'squeeze' : t >= A(7, 1) ? 'happy' : i === 0 && t < A(3, 1) ? (t < A(2, 1) ? 'open' : 'lid') : 'open';
      pp.p.set({ x: pp.st.x, y: y - dance, s: CS, sq: sq * (1 + dance * 0.002), eyes, lid: 0.5, look, blink: (t + i * 0.37) % 2.3 > 2.2 ? 1 : 0, o: 1 });
      puffs[i].forEach((c, j) => {
        const q = prog(land, land + 0.4, t), dir = j < 2 ? -1 : 1, kx = j % 2 ? 1.6 : 1;
        c.setAttribute('cx', pp.st.x + dir * (26 + q * 60 * kx));
        c.setAttribute('cy', pp.st.y - 8 - q * 20);
        c.setAttribute('r', 7 + q * 12);
        c.setAttribute('opacity', q > 0 && q < 1 ? 0.75 * (1 - q) : 0);
      });
    });
    flies.forEach(f => f(t));
    // ---------------- overlays
    const in1 = E.outBack(prog(A(1, 3), A(1, 3) + 0.25, t)), out12 = E.in3(prog(A(2, 4), A(3, 1), t));
    T(t1, { s: in1 * (1 - out12), r: -4, o: t >= A(1, 3) ? 1 : 0 });
    const in2 = E.outBack(prog(A(2, 1), A(2, 1) + 0.25, t));
    T(t2, { s: in2 * (1 - out12), r: 3, o: t >= A(2, 1) ? 1 : 0 });
    const lp = prog(A(2, 3), A(2, 4.5), t);
    show(link, t >= A(2, 2.5) && t < A(2, 4.5));
    T(link, { x: lerp(300, 820, E.in3(lp)), y: lerp(760, -200, E.in3(lp)), s: E.outBack(prog(A(2, 2.5), A(2, 3), t)) * lerp(1, 0.6, lp), r: lp * -20 });
    cntN.textContent = Math.max(0, n - 1);
    show(cnt, t >= A(3, 1) - 0.1 && t < A(9, 1));
    T(cnt, { s: 1 + LAND.slice(1).reduce((a, x) => a + pulse(t, x, x + 0.16, 0.02, 0.14), 0) * 0.12, ox: '100%', oy: '0%', o: 1 - prog(A(8, 4), A(9, 1), t) });
    const sp = prog(A(6, 3), A(6, 3) + 0.12, t);
    show(stamp, t >= A(6, 3) && t < A(7, 1));
    T(stamp, { s: lerp(2.4, 1, E.in3(sp)), r: -7, o: Math.min(1, sp * 3) });
    slams.forEach((el, i) => {
      const t0 = [A(9, 1), A(9, 3), A(10, 1), A(10, 3)][i];
      const q = prog(t0, t0 + 0.14, t);
      show(el, t >= t0 && t < A(11, 1));
      T(el, { s: lerp(2.2, 1, E.in3(q)) * (1 + Math.sin((t - t0) * 6) * 0.01), r: [-4, 3, -3, 2][i], o: Math.min(1, q * 3) });
    });
    dms.forEach(d => { const dt = t - d.t0; show(d.d, dt >= 0 && dt < 2.2); T(d.d, { x: 1100 - dt * 700, y: d.y }); });
    O(flash, pulse(t, A(7, 1), A(7, 1) + 0.12, 0.01, 0.11));
    // TV glow brighter after the drop
    tv.style.boxShadow = `0 0 0 6px #0b1117, 0 0 ${120 + pulse(t, A(7, 1), A(9, 1), 0.1, 0.5) * 120}px rgba(130,177,255,.4)`;
  };
});

// ---------------------------------------------------------------- end card
film.scene('c-end', snap(A(11, 1)), cues.length, root => {
  root.style.background = `${halftone('rgba(25,37,48,.14)', 24, 26)}, ${C.yellow}`;
  const rr = h('div', { class: 'abs' }, root);
  Object.assign(rr.style, { left: '-900px', top: '-500px', width: '2880px', height: '2880px', background: rays('rgba(255,255,255,.22)', 'transparent', 20), transformOrigin: '50% 50%' });
  const mc = h('div', { class: 'abs' }, root);
  const m = mascot({ stroke: C.ink, fill: C.cream, size: 620 });
  mc.appendChild(m.el);
  const wm = h('div', { class: 'abs', html: 'Piik<span style="color:#e9a12c">.</span>' }, root);
  Object.assign(wm.style, { left: '0', width: '1080px', textAlign: 'center', top: '1080px', font: WORDMARK(230), letterSpacing: '-10px', color: C.ink });
  const tg = h('div', { class: 'sticker', text: S.tagline[0] }, root);
  if (EN) Object.assign(tg.style, { fontFamily: 'Anton', fontWeight: 400, letterSpacing: '.02em' });
  Object.assign(tg.style, { left: '0', width: '1080px', textAlign: 'center', top: '1370px', fontSize: '96px', color: C.ink2 });
  const en = h('div', { class: 'abs lab', text: S.tagline[1] }, root);
  Object.assign(en.style, { left: '0', width: '1080px', textAlign: 'center', top: '1520px', color: C.ink, fontSize: '36px' });
  const url = h('div', { class: 'abs mono', html: `<span style="padding:12px 26px;border:5px solid ${C.ink};border-radius:40px;background:#fffefb">piik.tv</span>` }, root);
  Object.assign(url.style, { left: '0', width: '1080px', textAlign: 'center', top: '1640px', font: '800 48px/1 "JetBrains Mono"', color: C.ink });
  const sub = h('div', { class: 'abs', text: S.footer }, root);
  Object.assign(sub.style, { left: '0', width: '1080px', textAlign: 'center', top: '1760px', font: '700 36px/1 "Noto Sans SC"', color: C.ink, opacity: 0.8 });
  const flash = h('div', { class: 'fill' }, root);
  flash.style.background = '#fff';
  return (lt, t) => {
    const L0 = A(11, 1), tt = Math.max(0, t - L0);
    rr.style.transform = `rotate(${t * 10}deg)`;
    const mp = E.outBack(prog(L0, L0 + 0.35, t));
    T(mc, { x: 230, y: 330 + (1 - mp) * 200, s: mp, r: (1 - mp) * -20, ox: '50%', oy: '70%' });
    m.set({ wink: tt < 0.9 ? 1 : tt < 1.3 ? 0 : 1, spark: pulse(t, L0 + 0.1, L0 + 1.6, 0.1, 0.4), antenna: Math.sin(tt * 10) * 10 * Math.exp(-tt * 2), squash: 1 + Math.exp(-tt * 5) * Math.sin(tt * 24) * 0.06 });
    T(wm, { y: (1 - E.outExpo(prog(L0 + 0.1, L0 + 0.5, t))) * 80, o: prog(L0 + 0.1, L0 + 0.25, t) });
    T(tg, { s: E.outBack(prog(A(11, 3), A(11, 3) + 0.25, t)), o: t >= A(11, 3) ? 1 : 0 });
    T(en, { o: prog(A(11, 3) + 0.2, A(11, 3) + 0.4, t) });
    T(url, { y: (1 - E.outExpo(prog(A(12, 1), A(12, 1) + 0.4, t))) * 40, o: prog(A(12, 1), A(12, 1) + 0.2, t) });
    T(sub, { o: prog(A(12, 1) + 0.15, A(12, 1) + 0.4, t) * 0.8 });
    O(flash, pulse(t, L0, L0 + 0.12, 0.01, 0.11) * 0.9);
  };
});

film.layer('finish', root => {
  const grain = grainLayer(root, { W: 1080, H: 1920, opacity: 0.1 });
  const fade = h('div', { class: 'fill' }, root);
  fade.style.background = '#000';
  return t => {
    grain(t);
    O(fade, Math.max(0, (t - 19.45) / 0.5));
  };
}, 1000);

return film;
}
