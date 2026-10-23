// Film A · Act 1 — cold open (alone with the CPU), friends elsewhere, the idea, Piik appears.
import { h, s, T, ST, O, kf, tw, prog, E, clamp, lerp, rng, noise, shake, show, pulse } from '../../engine/core.js';
import { C, CAST, mascot, person, burst, focusLines, streaks, halftone, stripes, rays } from '../../engine/art.js';
import { ransom, ransomPop } from '../../engine/type.js';
import { dialog, cutin, screen, heads, room, snap, row, inRow, WORDMARK } from './kit.js';
import { game } from './game.js';
import { FACE } from './strings.js';

export function build(film, K) {
  const A = (b, beat = 1) => K.at(b, beat);
  const S = film.S, EN = film.lang === 'en', F = FACE[film.lang];

  // ------------------------------------------------ S1 · OTS: alone vs the CPU
  film.scene('s1-ots', 0, snap(A(2, 3)), root => {
    root.style.background = C.night;
    const cam = h('div', { class: 'fill' }, root);
    const glow = h('div', { class: 'fill' }, cam);
    glow.style.background = 'radial-gradient(60% 55% at 50% 45%, rgba(120,110,255,.22), transparent 70%)';
    const sc = screen(cam, { x: 150, y: 46, w: 1620, hgt: 911 });
    const g = game(sc.content, { w: sc.w, hgt: sc.h, S });
    const hd = heads(cam, { y: 1010, xs: [690], who: ['tuan'], scale: 3.3 });
    const corner = h('div', { class: 'abs hud', html: 'FRI&nbsp;&nbsp;23:00<br><span style="opacity:.55">ROOM — / VIEWERS 0</span>' }, root);
    Object.assign(corner.style, { left: '64px', top: '40px', font: '600 24px/1.4 "Barlow Condensed"', letterSpacing: '.2em', color: C.cream, opacity: 0.8 });
    const dl = dialog(root, { who: 'tuan', name: S.names.tuan, tag: S.tags.tuan, ...S.l_cpu, x: 900, y: 760, w: 860, hgt: 190 });
    // CRT turn-on
    const crt = h('div', { class: 'fill' }, root);
    crt.style.background = '#000';
    const line = h('div', { class: 'abs' }, crt);
    Object.assign(line.style, { left: '0', top: '538px', width: '1920px', height: '4px', background: '#fff', boxShadow: '0 0 40px 12px rgba(200,220,255,.8)' });
    const scan = h('div', { class: 'fill' }, root);
    scan.style.background = 'repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 2px, transparent 2px 5px)';
    return (lt, t) => {
      const p = prog(0.05, 0.32, t);
      // line grows horizontally, then opens vertically
      const lw = E.outExpo(prog(0.0, 0.12, t));
      line.style.transform = `scaleX(${lw}) scaleY(${1 + E.in3(p) * 60})`;
      line.style.opacity = 1 - prog(0.22, 0.34, t);
      crt.style.opacity = 1 - E.out2(prog(0.12, 0.34, t));
      show(crt, t < 0.36);
      scan.style.opacity = 0.9 - prog(0.2, 1.2, t) * 0.75;
      T(cam, { s: lerp(1.0, 1.045, E.io2(prog(0, A(2, 3), t))), ox: '50%', oy: '40%' });
      g.select(t, { p2: 'cpu', p1eyes: 'lid' });
      hd.set(t, { bob: () => Math.sin(t * 1.3) * 2 });
      dl.set(t, A(1, 3), A(2, 3) + 0.2);
    };
  });

  // ------------------------------------------------ S2 · front view: one person, a very long sofa
  film.scene('s2-alone', snap(A(2, 3)), snap(A(3, 1)), root => {
    root.style.background = `radial-gradient(70% 60% at 50% 38%, #26364a 0%, ${C.night} 75%)`;
    const big = h('div', { class: 'abs zh nowrap', text: S.alone }, root);
    Object.assign(big.style, { left: '0', top: EN ? '60px' : '90px', width: '1920px', textAlign: 'center', font: EN ? '400 520px/1 Anton' : '900 430px/1 "Noto Sans SC"', color: 'transparent', WebkitTextStroke: '3px rgba(246,242,232,.16)', letterSpacing: EN ? '.04em' : '.1em' });
    const rm = room(root, { k: 1.55, sofaY: 640, who: ['tuan'], fr: [0.18] });
    const cnt = h('div', { class: 'abs mono', html: `<span class="hud" style="font-size:22px;letter-spacing:.2em;opacity:.7">${S.viewers}</span><br>0 / 20` }, root);
    Object.assign(cnt.style, { right: '70px', left: 'auto', top: '56px', textAlign: 'right', font: '700 64px/1.15 "JetBrains Mono"', color: C.cream });
    const puff = s('svg', { width: 200, height: 120, style: 'position:absolute;left:0;top:0' }, root);
    const pc = [0, 1, 2].map(i => s('circle', { cx: 40 + i * 34, cy: 60 - i * 8, r: 18 + i * 6, fill: 'none', stroke: C.cream, 'stroke-width': 5, opacity: 0.8 }, puff));
    return (lt, t) => {
      const sigh = prog(A(2, 3.5), A(2, 4.2), t);
      const s0 = rm.seats[0];
      s0.p.set({ x: s0.x, y: s0.y, s: s0.s, sq: 1 - 0.12 * E.out3(sigh) + Math.sin(t * 2) * 0.005, eyes: 'lid', lid: 0.55 + 0.25 * sigh, tilt: -6 * sigh, look: [0, 1] });
      T(puff, { x: s0.x + 60, y: s0.y - 330 - sigh * 60, o: pulse(t, A(2, 3.5), A(3, 1), 0.08, 0.2) });
      pc.forEach((c, i) => c.setAttribute('r', (18 + i * 6) * (0.6 + sigh * 0.5)));
      T(root, { s: lerp(1.06, 1.0, E.out3(prog(A(2, 3), A(3, 1), t))) });
    };
  });

  // ------------------------------------------------ S3 · triptych: everyone's somewhere else
  film.scene('s3-tri', snap(A(3, 1)), snap(A(5, 1)), root => {
    root.style.background = `${halftone('rgba(25,37,48,.22)', 18, 30)}, ${C.yellow}`;
    const strip = h('div', { class: 'fill' }, root);
    strip.style.background = stripes('rgba(25,37,48,.08)', 'transparent', 26, -60);
    const P = [
      { who: 'yuan', at: A(3, 1), x: 70, place: S.places.yuan[0], en: S.places.yuan[1], bg: '#1d3350', from: -1 },
      { who: 'dian', at: A(3, 3), x: 680, place: S.places.dian[0], en: S.places.dian[1], bg: '#35284f', from: 1 },
      { who: 'cong', at: A(4, 1), x: 1290, place: S.places.cong[0], en: S.places.cong[1], bg: '#4d2f1f', from: -1 },
    ];
    const panels = P.map((d, i) => {
      const ch = CAST[d.who];
      const el = h('div', { class: 'abs' }, root);
      Object.assign(el.style, { left: d.x + 'px', top: '60px', width: '580px', height: '900px', transform: 'skewX(-9deg)', background: C.ink2, padding: '10px', boxSizing: 'border-box' });
      const inner = h('div', { class: 'fill' }, el);
      Object.assign(inner.style, { left: '10px', top: '10px', width: '560px', height: '880px', overflow: 'hidden', background: d.bg });
      const art = s('svg', { width: 760, height: 880, viewBox: '0 0 760 880', style: 'position:absolute;left:-100px;top:0;transform:skewX(9deg);transform-origin:50% 100%' }, inner);
      const p = person({ color: ch.color });
      const parts = scenery(art, d.who, p, ch, S);
      const cap = h('div', { class: 'abs' }, el);
      Object.assign(cap.style, { left: '30px', top: '700px', transform: 'skewX(9deg)' });
      const nm = h('div', { class: 'zh nowrap', text: S.names[d.who] }, cap);
      Object.assign(nm.style, { display: 'inline-block', padding: '6px 20px 10px', background: ch.color, color: C.ink, font: '900 64px/1 "Noto Sans SC"', border: `6px solid ${C.ink2}`, transform: 'rotate(-4deg)' });
      const pl = h('div', { class: 'nowrap', html: `<b>${d.place}</b>${d.en ? `&nbsp;&nbsp;<span class="hud">${d.en}</span>` : ''}` }, cap);
      Object.assign(pl.style, { marginTop: '14px', padding: '8px 18px', background: C.ink2, color: C.cream, font: EN ? '400 44px/1 Anton' : '900 40px/1 "Noto Sans SC"', letterSpacing: EN ? '.04em' : '0', display: 'inline-block' });
      if (d.en) pl.querySelector('.hud').style.cssText = 'font:600 22px/1 "Barlow Condensed";letter-spacing:.2em;color:#ffd05a';
      return { el, d, p, parts, cap };
    });
    const band = h('div', { class: 'abs' }, root);
    Object.assign(band.style, { left: '-100px', top: '770px', width: '2200px', height: '190px', background: C.ink2, transform: 'rotate(-3deg)' });
    const bandRow = row(band, { y: 34, x: 100, w: 2000, gap: EN ? 34 : 0, justify: 'center' });
    const l1 = h('div', { class: 'zh nowrap', text: S.band[0] }, bandRow);
    const l2 = h('div', { class: 'zh nowrap', text: S.band[1] }, bandRow);
    const l3 = h('div', { class: 'hud nowrap', text: S.band[2] }, bandRow);
    Object.assign(l1.style, { font: F.display(104), color: C.cream, letterSpacing: EN ? '.02em' : '0' });
    Object.assign(l2.style, { font: F.display(104), color: C.yellow, letterSpacing: EN ? '.02em' : '0', transformOrigin: '0% 50%' });
    Object.assign(l3.style, { marginLeft: '60px', font: '600 26px/1.2 "Barlow Condensed"', letterSpacing: '.2em', color: C.cream, width: '420px', whiteSpace: 'normal', opacity: 0.75, display: S.band[2] ? '' : 'none' });
    return (lt, t) => {
      panels.forEach((pn, i) => {
        const p = E.outExpo(prog(pn.d.at, pn.d.at + 0.22, t));
        const off = (1 - p) * 1200 * pn.d.from;
        pn.el.style.transform = `translateY(${off}px) skewX(-9deg)`;
        show(pn.el, t >= pn.d.at - 0.01);
        pn.parts(t, t - pn.d.at);
        T(pn.cap, { x: (1 - E.outBack(prog(pn.d.at + 0.1, pn.d.at + 0.35, t))) * -300 });
        pn.cap.style.transform += ' skewX(9deg)';
      });
      const bp = E.outExpo(prog(A(4, 3), A(4, 3) + 0.2, t));
      band.style.transform = `rotate(-3deg) translateX(${(1 - bp) * -2300}px)`;
      O(l1, prog(A(4, 3), A(4, 3) + 0.05, t));
      O(l2, prog(A(4, 4), A(4, 4) + 0.05, t));
      T(l2, { s: lerp(1.5, 1, E.outBack(prog(A(4, 4), A(4, 4) + 0.18, t))), ox: '0%', oy: '50%' });
      O(l3, prog(A(4, 4.5), A(4, 4.5) + 0.2, t) * 0.75);
      const sh = shake(t, A(4, 4), 0.25, 10, 40, 3);
      T(root, { x: sh.x, y: sh.y });
    };
  });

  // ------------------------------------------------ S4 · the idea: eye cut-in, ransom, Piik appears
  film.scene('s4-idea', snap(A(5, 1)), snap(A(7, 1)), root => {
    root.style.background = C.yellow;
    const fl = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, root);
    const flg = s('g', { transform: 'translate(960 560)' }, fl);
    const lines = s('path', { d: focusLines(110, 330, 1500, 21, 0.012), fill: C.ink2, opacity: 0.85 }, flg);
    const dots = h('div', { class: 'fill' }, root);
    dots.style.background = halftone('rgba(25,37,48,.28)', 20, 26);
    dots.style.webkitMaskImage = 'radial-gradient(circle at 50% 50%, transparent 25%, #000 75%)';
    const ci = cutin(root, { who: 'tuan', y: 540, hgt: 340, rot: -6, faceX: 1240, scale: 19 });
    const glint = s('svg', { width: 300, height: 300, style: 'position:absolute;left:0;top:0' }, root);
    s('path', { d: 'M150 10 L170 130 L290 150 L170 170 L150 290 L130 170 L10 150 L130 130Z', fill: '#fff' }, glint);
    const rw1 = row(root, { y: 170, x: EN ? 0 : 300, w: EN ? 1920 : 1620, justify: EN ? 'center' : 'flex-start' });
    const rw2 = row(root, { y: 430 });
    const r1 = inRow(rw1, ransom(root, S.idea1, { size: EN ? 130 : 150, seed: 4 }));
    const r2 = inRow(rw2, ransom(root, S.idea2, { size: EN ? 150 : 190, seed: 9 }));
    const mc = h('div', { class: 'abs' }, root);
    const m = mascot({ stroke: C.ink, fill: C.cream, size: 420 });
    mc.appendChild(m.el);
    const wm = h('div', { class: 'abs nowrap', html: 'Piik<span class="identity-dot">.</span>' }, root);
    Object.assign(wm.style, { left: '1010px', top: '420px', font: WORDMARK(210), letterSpacing: '-10px', color: C.ink });
    const wmS = h('div', { class: 'abs hud nowrap', text: S.wordmarkSub }, root);
    Object.assign(wmS.style, { left: '1022px', top: '650px', font: '600 30px/1 "Barlow Condensed"', letterSpacing: '.2em', color: C.ink });
    const inv = h('div', { class: 'fill' }, root);
    Object.assign(inv.style, { background: '#fff', mixBlendMode: 'difference' });
    const times1 = [A(5, 3), A(5, 3.5), A(5, 4), A(5, 4)];
    const times2 = [A(6, 1), A(6, 1.25), A(6, 1.5), A(6, 1.75), A(6, 2), A(6, 2.25)];
    return (lt, t) => {
      flg.setAttribute('transform', `translate(960 560) rotate(${t * 6})`);
      lines.setAttribute('opacity', 0.75 + 0.15 * Math.sin(t * 30));
      ci.set(t, A(5, 1), A(5, 3), t < A(5, 2) ? 'lid' : 'spark', { lid: 0.45, lidAngle: 14 });
      const gp = prog(A(5, 2), A(5, 2) + 0.3, t);
      show(glint, gp > 0 && gp < 1);
      T(glint, { x: 1290 - 150, y: 440 - 150, s: Math.sin(gp * Math.PI) * 1.2, r: gp * 90 });
      show(rw1, t >= A(5, 3) && t < A(6, 3) + 0.12);
      show(rw2, t >= A(6, 1) && t < A(6, 3) + 0.12);
      ransomPop(r1.chars, t, times1, { out: [A(6, 3) - 0.1, A(6, 3) + 0.02, 0.012] });
      ransomPop(r2.chars, t, times2, { out: [A(6, 3) - 0.1, A(6, 3) + 0.02, 0.012] });
      const sh = shake(t, A(6, 1), 0.3, 18, 40, 5);
      T(rw2, { x: sh.x, y: sh.y });
      O(inv, t >= A(6, 1) && t < A(6, 1) + 0.05 ? 1 : 0);
      // mascot pop + zoom-through into its screen
      const mp = E.outBack(prog(A(6, 3), A(6, 3) + 0.25, t));
      const zoom = E.inExpo(prog(A(6, 4.25), A(7, 1), t));
      const scale = lerp(0, 1, mp) * lerp(1, 46, zoom);
      const hop = Math.abs(Math.sin((t - A(6, 3)) * 7)) * 18 * (1 - zoom) * (t > A(6, 3) + 0.25 ? 1 : 0);
      // body centre (16,17) of 36-unit box = 46.4% / 50% of the svg
      Object.assign(mc.style, { left: lerp(520, 960 - 420 * (18 / 36), zoom) + 'px', top: lerp(300, 540 - 420 * (19 / 36), zoom) + 'px' });
      mc.style.transformOrigin = `${(18 / 36) * 100}% ${(19 / 36) * 100}%`;
      mc.style.transform = `translateY(${-hop}px) scale(${scale}) rotate(${(1 - mp) * -30}deg)`;
      show(mc, t >= A(6, 3));
      m.set({ wink: t < A(6, 3.6) ? 1 : t < A(6, 3.9) ? 0 : 1, spark: pulse(t, A(6, 4), A(7, 1), 0.06, 0.2), antenna: Math.sin(t * 14) * 8 * (1 - zoom) });
      T(wm, { x: (1 - E.outExpo(prog(A(6, 3) + 0.04, A(6, 3) + 0.24, t))) * 300 + zoom * 900, o: prog(A(6, 3) + 0.04, A(6, 3) + 0.1, t) * (1 - prog(A(6, 4.25), A(6, 4.25) + 0.12, t)) });
      O(wmS, E.out3(prog(A(6, 3.5), A(6, 3.5) + 0.15, t)) * (1 - prog(A(6, 4.25), A(6, 4.25) + 0.1, t)));
      // entering the TV: its screen turns into the dark stage of the next scene
      const zl = prog(A(6, 4.25), A(7, 1) - 0.04, t);
      m.parts.body.setAttribute('fill', zl > 0 ? `color-mix(in srgb, ${C.ink2} ${Math.round(E.in2(zl) * 100)}%, ${C.cream})` : C.cream);
    };
  });
}

/** Little environment vignettes for the triptych. Returns an animator (t, localT). */
function scenery(svg, who, p, ch, S) {
  if (who === 'yuan') {
    s('rect', { x: 430, y: 90, width: 220, height: 260, rx: 16, fill: '#2c4b70', stroke: '#0e1b2b', 'stroke-width': 10 }, svg);
    s('circle', { cx: 560, cy: 170, r: 46, fill: '#ffe9a8' }, svg);
    s('circle', { cx: 540, cy: 160, r: 46, fill: '#2c4b70' }, svg);
    s('path', { d: 'M430 220h220M540 90v260', stroke: '#0e1b2b', 'stroke-width': 8 }, svg);
    s('rect', { x: 120, y: 470, width: 340, height: 110, rx: 50, fill: '#e7eef7', stroke: '#0e1b2b', 'stroke-width': 8 }, svg);
    svg.appendChild(p.el);
    const blanket = s('path', { d: 'M60 880V600q0-60 70-64l520-20q60 0 60 70v294Z', fill: '#3d6c9e', stroke: '#0e1b2b', 'stroke-width': 9 }, svg);
    s('path', { d: 'M120 640q260-30 520-36', fill: 'none', stroke: '#5f8dbd', 'stroke-width': 10, 'stroke-linecap': 'round' }, svg);
    const phone = s('g', {}, svg);
    s('rect', { x: -45, y: -80, width: 90, height: 160, rx: 16, fill: C.ink2, stroke: '#0e1b2b', 'stroke-width': 6 }, phone);
    s('rect', { x: -36, y: -68, width: 72, height: 136, rx: 9, fill: '#bfe3ff' }, phone);
    const beam = s('path', { d: 'M0 0 L-180 -40 L-180 120Z', fill: '#bfe3ff', opacity: 0.18 }, svg);
    return (t, lt) => {
      p.set({ x: 300, y: 640, s: 2.6, eyes: 'open', look: [3, 1], blink: (lt % 2.2) > 2.05 ? 1 : 0, tilt: 8 });
      ST(phone, { x: 470 + Math.sin(t * 2) * 4, y: 420, r: -12 });
      ST(beam, { x: 430, y: 420 });
    };
  }
  if (who === 'dian') {
    const win = s('rect', { x: 0, y: 160, width: 760, height: 300, fill: '#1b1430' }, svg);
    const lights = s('path', { d: streaks(22, 1600, 260, 41, 0.08, 0.3, 6), fill: '#ffe08a', opacity: 0.7 }, svg);
    s('rect', { x: 0, y: 150, width: 760, height: 20, fill: '#7c6aa3' }, svg);
    s('rect', { x: 0, y: 450, width: 760, height: 20, fill: '#7c6aa3' }, svg);
    s('rect', { x: 0, y: 70, width: 760, height: 16, rx: 8, fill: '#c9c2dc' }, svg);
    const straps = [160, 360, 560].map(x => { const g = s('g', {}, svg); s('path', { d: 'M0 0v70', stroke: '#c9c2dc', 'stroke-width': 8 }, g); s('path', { d: 'M-26 70h52l-26 50Z', fill: 'none', stroke: '#c9c2dc', 'stroke-width': 9, 'stroke-linejoin': 'round' }, g); return [g, x]; });
    s('rect', { x: 0, y: 700, width: 760, height: 180, fill: '#2a2040' }, svg);
    const sign = s('g', { transform: 'translate(560 230)' }, svg);
    s('rect', { x: -70, y: -40, width: 140, height: 80, rx: 12, fill: '#ffd05a' }, sign);
    s('text', { y: 14, 'text-anchor': 'middle', 'font-family': 'Noto Sans SC', 'font-weight': 900, 'font-size': 42, fill: C.ink, text: S.metro }, sign);
    svg.appendChild(p.el);
    const phone = s('g', {}, svg);
    s('rect', { x: -40, y: -70, width: 80, height: 140, rx: 14, fill: C.ink2 }, phone);
    s('rect', { x: -32, y: -60, width: 64, height: 120, rx: 8, fill: '#e8d5ff' }, phone);
    return (t, lt) => {
      lights.setAttribute('transform', `translate(${-((t * 2400) % 800)} 180)`);
      const sway = Math.sin(t * 3.2) * 5;
      straps.forEach(([g, x], i) => g.setAttribute('transform', `translate(${x} 86) rotate(${sway * 1.4 + i})`));
      p.set({ x: 330, y: 760, s: 2.8, lean: sway * 0.6, eyes: 'open', look: [3, 2], blink: (lt % 1.9) > 1.78 ? 1 : 0 });
      ST(phone, { x: 470, y: 470 + Math.sin(t * 3.2) * 6, r: 10 });
    };
  }
  // cong — working late
  s('rect', { x: 470, y: 110, width: 170, height: 170, rx: 85, fill: '#f3e3cf', stroke: '#2b1a10', 'stroke-width': 10 }, svg);
  const hand1 = s('path', { d: 'M555 195V140', stroke: '#2b1a10', 'stroke-width': 9, 'stroke-linecap': 'round' }, svg);
  s('path', { d: 'M555 195h40', stroke: '#2b1a10', 'stroke-width': 9, 'stroke-linecap': 'round' }, svg);
  s('text', { x: 555, y: 320, 'text-anchor': 'middle', 'font-family': 'JetBrains Mono', 'font-weight': 700, 'font-size': 30, fill: '#f3e3cf', text: '23:00' }, svg);
  svg.appendChild(p.el);
  s('rect', { x: 40, y: 640, width: 700, height: 40, fill: '#2b1a10' }, svg);
  s('rect', { x: 400, y: 380, width: 320, height: 220, rx: 14, fill: '#2b1a10' }, svg);
  const mon = s('rect', { x: 414, y: 394, width: 292, height: 190, rx: 8, fill: '#ffcf9a' }, svg);
  s('rect', { x: 540, y: 600, width: 40, height: 40, fill: '#2b1a10' }, svg);
  const papers = s('g', {}, svg);
  for (let i = 0; i < 6; i++) s('rect', { x: 90 + (i % 2) * 6, y: 600 - i * 22, width: 200, height: 20, rx: 3, fill: i % 2 ? '#f3e3cf' : '#e2cdb3', stroke: '#2b1a10', 'stroke-width': 4 }, papers);
  const sweat = s('path', { d: 'M0 0q14 22 0 30q-14-8 0-30Z', fill: '#bfe3ff', stroke: '#2b1a10', 'stroke-width': 3 }, svg);
  return (t, lt) => {
    hand1.setAttribute('transform', `rotate(${(t * 40) % 360} 555 195)`);
    p.set({ x: 250, y: 650, s: 2.7, eyes: 'lid', lid: 0.62, look: [4, 1], tilt: -4 + Math.sin(t * 1.5) * 2 });
    mon.setAttribute('fill', (t * 3) % 1 < 0.5 ? '#ffcf9a' : '#ffd8ae');
    ST(sweat, { x: 330, y: 330 + (lt % 1.2) * 30, o: 1 - (lt % 1.2) / 1.2 });
  };
}
