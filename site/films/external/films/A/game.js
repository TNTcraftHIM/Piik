// "枕头大乱斗 PILLOW BRAWL" — the fictional local two-player game on 阿团's PC (Film A).
// Its own cute night-time palette keeps it readable as "what's on the shared screen".
import { h, s, T, ST, E, prog, clamp, lerp, rng, noise, show, TAU } from '../../engine/core.js';
import { C, CAST, person, burst } from '../../engine/art.js';

const G = { night: '#2b2457', night2: '#3b3274', pink: '#ff8fb8', mint: '#7fe0c4', star: '#ffe08a', wood: '#c98b5a', wood2: '#b07548', pillow: '#fbf7ff' };

function pillow(parent) {
  const g = s('g', {}, parent);
  s('rect', { x: -34, y: -22, width: 68, height: 44, rx: 16, fill: G.pillow, stroke: C.ink2, 'stroke-width': 3.5 }, g);
  s('path', { d: 'M-22-10q22 8 44 0M-22 10q22-8 44 0', fill: 'none', stroke: '#d9d0ef', 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
  return g;
}

/** Build the game inside a w×h box. Returns {el, select(t, o), fight(t, o)}. */
const ZH = { title: '枕头大乱斗', sub: 'PILLOW BRAWL', cpu: '电脑', wait: '等待中…', p1: 'P1 阿团', p2: 'P2 小圆', n1: '阿团', n2: '小圆' };
export function game(parent, { w: dw = 1584, hgt: dh = 875, S = null } = {}) {
  const L = S ? { ...S.game, n1: S.names.tuan, n2: S.names.yuan } : ZH;
  const w = 1584, hgt = 875; // internal layout units; displayed at dw×dh
  const el = s('svg', { width: dw, height: dh, viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'xMidYMid slice', style: 'position:absolute;left:0;top:0' }, parent);
  const defs = s('defs', {}, el);
  const pid = 'pbStars' + (++gameCount);
  const pat = s('pattern', { id: pid, width: 120, height: 120, patternUnits: 'userSpaceOnUse' }, defs);
  s('path', { d: 'm30 18 4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1Z', fill: G.star, opacity: 0.55 }, pat);
  s('circle', { cx: 92, cy: 80, r: 4, fill: G.star, opacity: 0.4 }, pat);
  s('circle', { cx: 70, cy: 30, r: 2.5, fill: '#fff', opacity: 0.35 }, pat);

  // ---- select screen
  const sel = s('g', {}, el);
  s('rect', { width: w, height: hgt, fill: G.night }, sel);
  s('rect', { width: w, height: hgt, fill: `url(#${pid})` }, sel);
  const title = s('g', { transform: `translate(${w / 2} 150)` }, sel);
  s('text', { 'text-anchor': 'middle', 'font-family': 'ZCOOL KuaiLe', 'font-size': 118, fill: '#fff', stroke: G.pink, 'stroke-width': 22, 'paint-order': 'stroke', 'stroke-linejoin': 'round', text: L.title }, title);
  s('text', { y: 62, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 34, fill: G.mint, 'letter-spacing': 6, text: L.sub }, title);
  const slot = (x, label) => {
    const g = s('g', { transform: `translate(${x} 300)` }, sel);
    const card = s('rect', { x: -230, y: 0, width: 460, height: 430, rx: 34, fill: G.night2, stroke: '#fff', 'stroke-width': 6 }, g);
    s('text', { x: -200, y: 54, 'font-family': 'Rubik Mono One', 'font-size': 36, fill: '#fff', text: label }, g);
    const nameT = s('text', { y: 404, 'text-anchor': 'middle', 'font-family': 'ZCOOL KuaiLe', 'font-size': 52, fill: '#fff', text: '' }, g);
    const ready = s('text', { x: 200, y: 54, 'text-anchor': 'end', 'font-family': 'Rubik Mono One', 'font-size': 28, fill: G.mint, text: 'READY' }, g);
    return { g, card, nameT, ready };
  };
  const s1 = slot(w / 2 - 330, 'P1'), s2 = slot(w / 2 + 330, 'P2');
  const p1 = person({ color: C.green, crown: true });
  s1.g.appendChild(p1.el);
  p1.set({ x: 0, y: 340, s: 2.1, eyes: 'open' });
  const p2 = person({ color: C.blue });
  s2.g.appendChild(p2.el);
  const cpu = s('g', {}, s2.g);
  const cpuP = person({ color: '#8b93a6' });
  cpu.appendChild(cpuP.el);
  cpuP.set({ x: 0, y: 340, s: 2.1, eyes: 'dot' });
  s('rect', { x: -58, y: 106, width: 116, height: 36, rx: 10, fill: '#5d6577', stroke: C.ink2, 'stroke-width': 4 }, cpu);
  s('text', { y: 135, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 26, fill: '#c8f7ff', text: 'CPU' }, cpu);
  const wait = s('text', { y: 250, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 150, fill: '#fff', opacity: 0.85, text: '?' }, s2.g);
  s('text', { x: w / 2, y: 540, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 64, fill: G.star, stroke: C.ink2, 'stroke-width': 10, 'paint-order': 'stroke', text: 'VS' }, sel);
  const press = s('text', { x: w / 2, y: hgt - 50, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 34, fill: '#fff', text: 'PRESS START' }, sel);

  // ---- fight stage
  const fg = s('g', {}, el);
  s('rect', { width: w, height: hgt, fill: G.night2 }, fg);
  s('rect', { width: w, height: hgt * 0.72, fill: `url(#${pid})` }, fg);
  s('rect', { x: w * 0.7, y: 120, width: 260, height: 220, rx: 18, fill: '#1d1840', stroke: '#fff', 'stroke-width': 8 }, fg);
  s('circle', { cx: w * 0.7 + 180, cy: 190, r: 40, fill: G.star }, fg);
  s('path', { d: `M${w * 0.7 + 130} 120v220M${w * 0.7} 230h260`, stroke: '#fff', 'stroke-width': 8 }, fg);
  s('rect', { x: 80, y: hgt * 0.5, width: 420, height: 140, rx: 30, fill: '#6b5fb3' }, fg);
  s('rect', { x: 100, y: hgt * 0.5 - 40, width: 140, height: 70, rx: 24, fill: '#fff' }, fg);
  s('rect', { y: hgt * 0.72, width: w, height: hgt * 0.28, fill: G.wood }, fg);
  for (let i = 0; i < 9; i++) s('path', { d: `M${i * 200 - 60} ${hgt * 0.72}l-80 ${hgt * 0.28}`, stroke: G.wood2, 'stroke-width': 6 }, fg);
  s('rect', { y: hgt * 0.72 - 6, width: w, height: 12, fill: G.wood2 }, fg);
  const shadow1 = s('ellipse', { rx: 80, ry: 16, fill: '#000', opacity: 0.25 }, fg);
  const shadow2 = s('ellipse', { rx: 80, ry: 16, fill: '#000', opacity: 0.25 }, fg);
  const f1 = person({ color: C.green, crown: true }); fg.appendChild(f1.el);
  const f2 = person({ color: C.blue }); fg.appendChild(f2.el);
  const pw1 = pillow(fg), pw2 = pillow(fg);
  // feathers
  const feathers = s('g', {}, fg);
  const fr = rng(77);
  const FE = Array.from({ length: 40 }, () => ({ el: s('ellipse', { rx: 9, ry: 4, fill: '#fff', stroke: '#d9d0ef', 'stroke-width': 1.5 }, feathers), a: fr() * TAU, v: 300 + fr() * 700, sp: (fr() - 0.5) * 900, w: fr() }));
  // hit bursts
  const hitG = s('g', {}, fg);
  const hitB = s('polygon', { points: burst(12, 150, 80, 4, 0.35), fill: G.star, stroke: C.ink2, 'stroke-width': 8, 'stroke-linejoin': 'round' }, hitG);
  const hitT = s('text', { y: 18, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 52, fill: C.ink2, text: 'BONK!' }, hitG);
  // HUD
  const hud = s('g', {}, fg);
  const bar = (x, dir, col, name) => {
    const g = s('g', { transform: `translate(${x} 74)` }, hud);
    s('rect', { x: dir > 0 ? 0 : -560, y: 0, width: 560, height: 54, rx: 12, fill: C.ink2, stroke: '#fff', 'stroke-width': 5 }, g);
    const fill = s('rect', { x: dir > 0 ? 8 : -552, y: 8, width: 544, height: 38, rx: 7, fill: col }, g);
    const lag = s('rect', { x: dir > 0 ? 8 : -552, y: 8, width: 544, height: 38, rx: 7, fill: '#fff', opacity: 0.55 }, g);
    s('text', { x: dir > 0 ? 6 : -6, y: 100, 'text-anchor': dir > 0 ? 'start' : 'end', 'font-family': 'ZCOOL KuaiLe', 'font-size': 40, fill: '#fff', stroke: C.ink2, 'stroke-width': 8, 'paint-order': 'stroke', text: name }, g);
    return { fill, lag, dir };
  };
  const hp1 = bar(120, 1, C.green, L.p1), hp2 = bar(w - 120, -1, C.blue, L.p2);
  s('circle', { cx: w / 2, cy: 102, r: 52, fill: C.ink2, stroke: '#fff', 'stroke-width': 5 }, hud);
  const timer = s('text', { x: w / 2, y: 122, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 50, fill: '#fff', text: '99' }, hud);
  const combo = s('text', { x: w - 90, y: 250, 'text-anchor': 'end', 'font-family': 'Rubik Mono One', 'font-size': 60, fill: G.star, stroke: C.ink2, 'stroke-width': 10, 'paint-order': 'stroke', text: '' }, fg);
  const ko = s('g', {}, fg);
  s('text', { x: w / 2, y: hgt / 2 + 90, 'text-anchor': 'middle', 'font-family': 'Rubik Mono One', 'font-size': 300, fill: G.star, stroke: C.ink2, 'stroke-width': 26, 'paint-order': 'stroke', 'stroke-linejoin': 'round', text: 'K.O.' }, ko);

  const setHP = (b, v, lagv) => {
    const W0 = 544;
    const wv = Math.max(0, W0 * v), wl = Math.max(0, W0 * lagv);
    b.fill.setAttribute('width', wv); b.lag.setAttribute('width', wl);
    if (b.dir < 0) { b.fill.setAttribute('x', -8 - wv); b.lag.setAttribute('x', -8 - wl); }
  };

  return {
    el,
    /** o: {p2:'cpu'|'wait'|'yuan', blink:bool, t} */
    select(t, o = {}) {
      show(sel, true); show(fg, false);
      const p2s = o.p2 || 'cpu';
      show(cpu, p2s === 'cpu'); show(wait, p2s === 'wait'); show(p2.el, p2s === 'yuan');
      s2.nameT.textContent = p2s === 'cpu' ? L.cpu : p2s === 'wait' ? L.wait : L.n2;
      s1.nameT.textContent = L.n1;
      s2.ready.style.display = p2s === 'wait' ? 'none' : '';
      s2.card.setAttribute('fill', p2s === 'yuan' ? '#2f5f86' : p2s === 'wait' ? G.night2 : '#4a4f63');
      s1.card.setAttribute('fill', '#2f6a4c');
      p1.set({ x: 0, y: 340 + Math.sin(t * 6) * 4, s: 2.1, eyes: o.p1eyes || 'open', blink: (t % 2.7) < 0.12 ? 1 : 0 });
      p2.set({ x: 0, y: 340 + Math.sin(t * 6 + 1) * 4, s: 2.1, eyes: 'lid', lid: 0.35, lidAngle: 10 });
      cpuP.set({ x: 0, y: 340, s: 2.1, eyes: 'dot', look: [Math.sin(t * 2) * 2, 0] });
      wait.setAttribute('opacity', 0.5 + 0.4 * Math.sin(t * 8));
      press.setAttribute('opacity', (t * 2) % 1 < 0.6 ? 1 : 0.15);
    },
    /** o: {x1,x2,y1,y2,sq1,sq2,lean1,lean2,sw1,sw2 (pillow angles), e1,e2 (eyes), hp1,hp2,lag1,lag2,hit:{x,y,p,text},combo,ko,feathers:{t0,x,y},timer} */
    fight(t, o) {
      show(sel, false); show(fg, true);
      const gy = hgt * 0.84;
      f1.set({ x: o.x1, y: gy - (o.y1 || 0), s: 3.1, sq: o.sq1 || 1, lean: o.lean1 || 0, eyes: o.e1 || 'lid', lid: o.lid1 ?? 0.3, lidAngle: 12, blink: 0 });
      f2.set({ x: o.x2, y: gy - (o.y2 || 0), s: 3.1, sq: o.sq2 || 1, lean: o.lean2 || 0, eyes: o.e2 || 'lid', lid: o.lid2 ?? 0.3, lidAngle: 12 });
      ST(shadow1, { x: o.x1, y: gy + 4, s: 1.35 * (1 - (o.y1 || 0) / 700) });
      ST(shadow2, { x: o.x2, y: gy + 4, s: 1.35 * (1 - (o.y2 || 0) / 700) });
      ST(pw1, { x: o.x1 + 160 * Math.cos(rad(o.sw1 ?? -40)), y: gy - (o.y1 || 0) - 200 + 160 * Math.sin(rad(o.sw1 ?? -40)), r: (o.sw1 ?? -40) + 90, s: 1.35 });
      ST(pw2, { x: o.x2 - 160 * Math.cos(rad(o.sw2 ?? -40)), y: gy - (o.y2 || 0) - 200 + 160 * Math.sin(rad(o.sw2 ?? -40)), r: -(o.sw2 ?? -40) - 90, s: 1.35 });
      setHP(hp1, o.hp1 ?? 1, o.lag1 ?? o.hp1 ?? 1);
      setHP(hp2, o.hp2 ?? 1, o.lag2 ?? o.hp2 ?? 1);
      timer.textContent = String(o.timer ?? 99);
      if (o.hit && o.hit.p < 1) {
        show(hitG, true);
        const k = E.outBack(clamp(o.hit.p * 3)), fade = 1 - prog(0.6, 1, o.hit.p);
        ST(hitG, { x: o.hit.x, y: o.hit.y, s: k * (o.hit.s || 1), r: o.hit.r || 0, o: fade });
        hitT.textContent = o.hit.text || 'BONK!';
      } else show(hitG, false);
      combo.textContent = o.combo || '';
      show(ko, !!o.ko);
      if (o.ko) ko.setAttribute('transform', `translate(${w / 2} ${hgt / 2}) scale(${lerp(2.4, 1, E.outBack(clamp(o.ko * 4)))}) rotate(-6) translate(${-w / 2} ${-hgt / 2})`);
      const fz = o.feathers;
      FE.forEach((f, i) => {
        if (!fz || t < fz.t0) { show(f.el, false); return; }
        const q = t - fz.t0;
        show(f.el, q < 2.4);
        const x = fz.x + Math.cos(f.a) * f.v * q * 0.6 + Math.sin(q * 3 + i) * 30;
        const y = fz.y + Math.sin(f.a) * f.v * q * 0.6 + 160 * q * q;
        f.el.setAttribute('transform', `translate(${x} ${y}) rotate(${f.sp * q})`);
        f.el.setAttribute('opacity', 1 - prog(1.6, 2.4, q));
      });
    },
  };
}
const rad = d => (d * Math.PI) / 180;
let gameCount = 0;
