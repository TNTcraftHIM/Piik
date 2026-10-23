// Film A · Act 4 — VS splash, the pillow fight on the shared screen, K.O., the tomato rain.
import { h, s, T, ST, O, kf, tw, prog, E, clamp, lerp, rng, noise, shake, show, pulse } from '../../engine/core.js';
import { C, CAST, person, icon, burst, focusLines, streaks, halftone, stripes, rays } from '../../engine/art.js';
import { ransom, ransomPop } from '../../engine/type.js';
import { dialog, bubble, cutin, room, thrown, snap, row, inRow } from './kit.js';
import { game } from './game.js';
import { FACE } from './strings.js';

export function build(film, K) {
  const A = (b, beat = 1) => K.at(b, beat);
  const S = film.S, EN = film.lang === 'en';

  // ------------------------------------------------ S11 · VS
  film.scene('s11-vs', snap(A(21, 1)), snap(A(23, 1)), root => {
    root.style.background = C.ink2;
    const L = h('div', { class: 'fill' }, root), R = h('div', { class: 'fill' }, root);
    L.style.background = `${halftone('rgba(0,0,0,.2)', 20, 30)}, linear-gradient(120deg, ${C.green}, ${C.greenD})`;
    R.style.background = `${halftone('rgba(0,0,0,.2)', 20, 30)}, linear-gradient(300deg, ${C.blue}, ${C.blueD})`;
    L.style.clipPath = 'polygon(0 0, 59% 0, 41% 100%, 0 100%)';
    R.style.clipPath = 'polygon(59% 0, 100% 0, 100% 100%, 41% 100%)';
    const stL = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, L);
    const stLp = s('path', { d: streaks(30, 3840, 1080, 51, 0.1, 0.4, 7), fill: 'rgba(255,255,255,.16)' }, stL);
    const stR = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, R);
    const stRp = s('path', { d: streaks(30, 3840, 1080, 53, 0.1, 0.4, 7), fill: 'rgba(255,255,255,.16)' }, stR);
    const pv = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, root);
    const pL = person({ color: C.green, crown: true }), pR = person({ color: C.blue });
    const gL = s('g', {}, pv), gR = s('g', {}, pv);
    gL.setAttribute('clip-path', 'polygon(0 0)');
    gL.appendChild(pL.el); gR.appendChild(pR.el);
    // clip portraits to their halves
    const defs = s('defs', {}, pv);
    const cl = s('clipPath', { id: 'vsL' }, defs); s('polygon', { points: '0,0 1133,0 787,1080 0,1080' }, cl);
    const cr = s('clipPath', { id: 'vsR' }, defs); s('polygon', { points: '1133,0 1920,0 1920,1080 787,1080' }, cr);
    gL.setAttribute('clip-path', 'url(#vsL)'); gR.setAttribute('clip-path', 'url(#vsR)');
    const bolt = s('path', { d: 'M1160 -30 1010 380 1110 392 860 760 960 770 760 1120 1000 700 900 690 1150 330 1050 318 1220 -30Z', fill: C.yellow, stroke: C.ink2, 'stroke-width': 12, 'stroke-linejoin': 'round' }, pv);
    const vs = h('div', { class: 'abs anton nowrap', text: 'VS' }, root);
    Object.assign(vs.style, { left: '0', top: '200px', width: '1920px', textAlign: 'center', font: '400 520px/1 Anton', color: C.cream, WebkitTextStroke: `18px ${C.ink2}`, paintOrder: 'stroke fill', textShadow: `22px 22px 0 ${C.red}` });
    const rowL = row(root, { y: 770, x: 120, w: 800, justify: 'flex-start' }), rowR = row(root, { y: 770, x: 1000, w: 800, justify: 'flex-end' });
    const nameL = inRow(rowL, ransom(root, S.vsNameL, { size: EN ? 130 : 150, seed: 91 }));
    const nameR = inRow(rowR, ransom(root, S.vsNameR, { size: EN ? 130 : 150, seed: 93 }));
    const subL = h('div', { class: 'abs hud nowrap', text: S.vsSubL }, root);
    const subR = h('div', { class: 'abs hud nowrap', text: S.vsSubR }, root);
    for (const el of [subL, subR]) Object.assign(el.style, { top: '960px', padding: '8px 16px', background: C.ink2, color: C.cream, font: '800 30px/1 "Barlow Condensed"', letterSpacing: '.2em' });
    subL.style.left = '128px';
    Object.assign(subR.style, { left: 'auto', right: '128px' });
    const round = h('div', { class: 'abs nowrap center' }, root);
    Object.assign(round.style, { left: '-100px', top: '470px', width: '2120px', height: '150px', background: C.ink2, transform: 'rotate(-4deg)', font: '400 110px/1 Anton', color: C.yellow, letterSpacing: '.12em' });
    round.textContent = 'ROUND 1';
    const fight = h('div', { class: 'abs nowrap', text: 'FIGHT!' }, root);
    Object.assign(fight.style, { left: '0', top: '330px', width: '1920px', textAlign: 'center', font: '400 300px/1 "Rubik Mono One"', color: C.red, WebkitTextStroke: `16px ${C.cream}`, paintOrder: 'stroke fill', textShadow: `16px 16px 0 ${C.ink2}` });
    const flash = h('div', { class: 'fill' }, root);
    flash.style.background = '#fff';
    return (lt, t) => {
      const t0 = A(21, 1);
      const sp = E.outExpo(prog(t0, t0 + 0.3, t));
      L.style.transform = `translateX(${(1 - sp) * -1300}px)`;
      R.style.transform = `translateX(${(1 - sp) * 1300}px)`;
      stLp.setAttribute('transform', `translate(${-((t * 900) % 1920)} 0)`);
      stRp.setAttribute('transform', `translate(${-1920 + ((t * 900) % 1920)} 0)`);
      const br = Math.sin(t * 3) * 0.01;
      pL.set({ x: 430 + (1 - sp) * -900, y: 1690, s: 10, sq: 1 + br, eyes: 'lid', lid: 0.4, lidAngle: 18, blink: 0 });
      pR.set({ x: 1500 + (1 - sp) * 900, y: 1690, s: 10, sq: 1 - br, eyes: 'lid', lid: 0.45, lidAngle: 14 });
      bolt.setAttribute('transform', `translate(0 ${(1 - E.outBack(prog(t0 + 0.05, t0 + 0.28, t))) * -1300})`);
      const vp = prog(t0, t0 + 0.16, t);
      const vq = E.in3(prog(A(22, 3) - 0.08, A(22, 3) + 0.04, t));
      T(vs, { s: (lerp(3.2, 1, E.in3(vp)) + Math.sin(t * 20) * 0.006) * (1 - vq * 0.6), o: t >= t0 ? 1 - vq : 0 });
      show(rowL, t >= A(21, 3)); show(rowR, t >= A(21, 4));
      ransomPop(nameL.chars, t, nameL.chars.map((_, i) => A(21, 3) + i * (EN ? 0.035 : 0.06)));
      ransomPop(nameR.chars, t, nameR.chars.map((_, i) => A(21, 4) + i * (EN ? 0.035 : 0.06)));
      T(subL, { x: (1 - E.outExpo(prog(A(21, 3) + 0.1, A(21, 3) + 0.4, t))) * -500 });
      T(subR, { x: (1 - E.outExpo(prog(A(21, 4) + 0.1, A(21, 4) + 0.4, t))) * 500 });
      const rp = E.outExpo(prog(A(22, 1), A(22, 1) + 0.25, t)), rq = E.in3(prog(A(22, 2.6), A(22, 3), t));
      round.style.transform = `rotate(-4deg) translateX(${(1 - rp) * 2200 - rq * 2200}px)`;
      const fp = prog(A(22, 3), A(22, 3) + 0.12, t);
      T(fight, { s: lerp(2.8, 1, E.in3(fp)) * (1 + pulse(t, A(22, 4), A(23, 1), 0.2, 0.2) * 0.06), o: t >= A(22, 3) ? 1 : 0, r: -4 });
      O(flash, Math.max(pulse(t, t0, t0 + 0.12, 0.01, 0.1), pulse(t, A(22, 3), A(22, 3) + 0.1, 0.01, 0.09)) * 0.9);
      const sh = shake(t, t0, 0.45, 26, 34, 29), sh2 = shake(t, A(22, 3), 0.4, 22, 40, 31);
      T(root, { x: sh.x + sh2.x, y: sh.y + sh2.y, r: sh.r + sh2.r });
    };
  });

  // ------------------------------------------------ S12 · the fight (on the shared screen)
  const ins = A(24, 3), insEnd = A(24, 4);
  film.scene('s12-fight', snap(A(23, 1)), snap(A(26, 1)), root => {
    root.style.background = '#000';
    const gw = h('div', { class: 'fill' }, root);
    const g = game(gw, { w: 1920, hgt: 1080, S });
    const hud = h('div', { class: 'abs nowrap center' }, root);
    Object.assign(hud.style, { left: '40px', top: '970px', gap: '14px', padding: '10px 18px', background: 'rgba(18,27,36,.82)', borderRadius: '12px', border: `2px solid ${C.cream}`, color: C.cream, font: '700 26px/1 "JetBrains Mono"' });
    hud.innerHTML = `<span style="background:${C.red};color:#fff;padding:6px 10px;border-radius:6px;font:400 24px Anton;letter-spacing:.08em">LIVE</span> ${S.hudChip}`;
    const ci = cutin(root, { who: 'yuan', y: 540, hgt: 340, rot: -8, faceX: 1300, scale: 19 });
    const sp = h('div', { class: 'abs zh nowrap', text: S.special }, root);
    Object.assign(sp.style, { left: '220px', top: EN ? '400px' : '420px', font: EN ? '400 220px/1 Anton' : '900 190px/1 "Noto Sans SC"', color: C.cream, WebkitTextStroke: `12px ${C.ink2}`, paintOrder: 'stroke fill', transform: 'rotate(-8deg)' });
    // reaction insert: the sofa
    const insL = h('div', { class: 'fill' }, root);
    insL.style.background = `${rays('rgba(255,208,90,.2)', 'transparent', 16)}, ${C.ink2}`;
    const rm = room(insL, { k: 1.7, sofaY: 600 });
    const ohRow = row(insL, { y: 120 });
    const oh = inRow(ohRow, ransom(insL, S.ooh, { size: 160, seed: 61 }));
    const flash = h('div', { class: 'fill' }, root);
    flash.style.background = '#fff';
    // fight state machine (pure function of t)
    const b = beat => A(23, 1) + beat * K.spb; // beats from the start of bar 23
    const hits = [
      { t: b(0), x: 792, y: 500, text: 'BONK!', s: 1.3 },
      { t: b(1.5), x: 930, y: 470, text: 'POW!' },
      { t: b(2), x: 660, y: 470, text: 'BONK!' },
      { t: b(4), x: 640, y: 450, text: 'BAM!' },
      { t: b(5), x: 600, y: 480, text: 'BAM!' },
      { t: b(5.5), x: 560, y: 450, text: 'BAM!!' },
      { t: b(7), x: 980, y: 430, text: 'BONK!' },
      // Leave room for the letters at peak camera punch; the burst can break its frame.
      { t: b(9), x: 450, y: 430, text: 'KA-POW!', s: 1.7 },
    ];
    return (lt, t) => {
      const inInsert = t >= ins && t < insEnd;
      show(insL, inInsert);
      show(gw, !inInsert);
      // positions
      let x1 = kf(t, [[b(-0.4), 520], [b(0), 700, 'out3'], [b(0.6), 640, 'out2'], [b(1.5), 760, 'out3'], [b(2), 600, 'out3'], [b(4), 520, 'out3'], [b(5), 450, 'out3'], [b(5.5), 380, 'out3'], [b(6.55), 420], [b(7), 820, 'out2'], [b(8), 700], [b(9), 700], [b(9.6), -260, 'out2']]);
      let x2 = kf(t, [[b(-0.4), 1064], [b(0), 884, 'out3'], [b(0.6), 940, 'out2'], [b(1.5), 1020, 'out3'], [b(2), 820, 'out3'], [b(4), 690, 'out3'], [b(5), 620, 'out3'], [b(5.5), 560, 'out3'], [b(6.9), 900], [b(7.05), 1060, 'out3'], [b(8), 960], [b(9), 620, 'in2']]);
      const y1 = Math.max(0, Math.sin(prog(b(6.5), b(7.1), t) * Math.PI) * 260) + (t > b(9) ? Math.sin(prog(b(9), b(9.6), t) * Math.PI) * 300 + prog(b(9), b(10), t) * 200 : 0);
      const lastHit = hits.filter(hh => t >= hh.t).pop();
      const hp = hh => hh ? (t - hh.t) / 0.5 : 1;
      const hp1 = kf(t, [[b(2), 1], [b(2.05), 0.82], [b(4), 0.82], [b(4.05), 0.66], [b(5), 0.66], [b(5.05), 0.52], [b(5.5), 0.52], [b(5.55), 0.4], [b(9), 0.4], [b(9.05), 0]]);
      const hp2 = kf(t, [[b(1.5), 1], [b(1.55), 0.86], [b(7), 0.86], [b(7.05), 0.72]]);
      const lag = (v, d) => kf(t, d);
      const sw1 = t < b(0) ? -40 : kf(t, [[b(0) - 0.12, -100], [b(0), 30, 'out3'], [b(1.4), -100], [b(1.5), 40, 'out3'], [b(6.85), -120], [b(7), 50, 'out3'], [b(7.4), -40]]);
      const sw2 = kf(t, [[b(0) - 0.12, -100], [b(0), 30, 'out3'], [b(1.9), -100], [b(2), 40, 'out3'], [b(3.9), -100], [b(4), 40, 'out3'], [b(4.9), -100], [b(5), 40, 'out3'], [b(5.4), -100], [b(5.5), 40, 'out3'], [b(8.9), -140], [b(9), 70, 'out3'], [b(9.6), -30]]);
      const hitOn = lastHit && t - lastHit.t < 0.5;
      const X = v => 792 + (v - 792) * 1.32;
      g.fight(t, {
        x1: X(x1), x2: X(x2), y1, sw1, sw2,
        lean1: t > b(9) ? -prog(b(9), b(9.6), t) * 720 : 0,
        e1: t > b(9) ? 'x' : t > b(4) ? 'squeeze' : 'lid', lid1: 0.35,
        e2: t > b(9.2) ? 'happy' : 'lid', lid2: 0.45,
        hp1, hp2, lag1: hp1 + 0.1 * Math.max(0, 1 - (t - (lastHit?.t || 0)) * 2), lag2: hp2,
        hit: hitOn ? { x: X(lastHit.x), y: lastHit.y - 40, p: hp(lastHit), text: lastHit.text, s: lastHit.s || 1, r: (hits.indexOf(lastHit) % 2 ? 8 : -8) } : null,
        combo: t > b(4) && t < b(7) ? `${t > b(5.5) ? 4 : t > b(5) ? 3 : 2} HITS` : '',
        ko: t >= A(25, 3) ? t - A(25, 3) : 0,
        feathers: t >= b(9) ? { t0: b(9), x: X(420), y: 400 } : t >= b(0) ? { t0: b(0), x: 792, y: 440 } : null,
        timer: Math.max(0, 99 - Math.floor((t - A(23, 1)) * 2)),
      });
      // super cut-in at bar 25
      ci.set(t, A(25, 1), A(25, 2), 'spark');
      show(sp, t >= A(25, 1) + 0.06 && t < A(25, 2));
      T(sp, { s: lerp(1.8, 1, E.outBack(prog(A(25, 1) + 0.06, A(25, 1) + 0.2, t))), r: -8 });
      // insert reaction
      if (inInsert) {
        rm.seats.forEach((st, i) => {
          const e = i === 0 ? 'squeeze' : i === 1 ? 'lid' : 'wide';
          const jump = i >= 2 ? Math.sin(prog(ins, ins + 0.3, t) * Math.PI) * 40 : 0;
          st.p.set({ x: st.x, y: st.y - jump, s: st.s, eyes: e, lid: 0.45, lidAngle: 14, sq: i >= 2 ? 1.06 : 1 });
        });
        show(ohRow, true);
        ransomPop(oh.chars, t, [ins, ins + 0.05, ins + 0.1, ins + 0.15]);
      }
      O(flash, Math.max(pulse(t, b(9), b(9) + 0.1, 0.01, 0.09), pulse(t, A(25, 3), A(25, 3) + 0.12, 0.01, 0.1)) * 0.9);
      let sx = 0, sy = 0;
      for (const hh of hits) { const q = shake(t, hh.t, 0.22, hh.s ? 26 : 12, 40, hits.indexOf(hh) + 40); sx += q.x; sy += q.y; }
      const k = shake(t, A(25, 3), 0.5, 30, 30, 61);
      T(root, { x: sx + k.x, y: sy + k.y });
      // camera punch-in on every hit, drifting toward the action
      const punch = hits.reduce((a, hh) => a + pulse(t, hh.t, hh.t + 0.3, 0.02, 0.28) * (hh.s ? 0.1 : 0.05), 0);
      const mid = (x1 + x2) / 2;
      T(gw, { s: 1.0 + punch, x: (792 - mid) * 0.25, ox: '50%', oy: '72%' });
    };
  });

  // ------------------------------------------------ S12b · winner + tomato rain
  film.scene('s12b-rain', snap(A(26, 1)), snap(A(27, 1)), root => {
    root.style.background = `${rays('rgba(255,74,61,.12)', 'transparent', 20)}, ${C.ink2}`;
    const rm = room(root, { k: 1.5, sofaY: 700 });
    const win = h('div', { class: 'abs nowrap center' }, root);
    Object.assign(win.style, { left: '0', top: '70px', width: '1920px', gap: '30px' });
    win.innerHTML = `<span style="font:400 150px/1 Anton;color:${C.yellow};-webkit-text-stroke:10px ${C.ink2};paint-order:stroke fill;letter-spacing:.04em">WINNER</span><span style="padding:10px 26px;background:${C.blue};border:7px solid ${C.ink2};font:900 110px/1 Noto Sans SC;color:${C.ink2};transform:rotate(-4deg)">${S.names.yuan}</span>`;
    const front = h('div', { class: 'fill' }, root);
    const tuan = rm.seats[0];
    const head = [tuan.x, tuan.y - 90 * tuan.s];
    const T0 = [A(26, 1), A(26, 1.5), A(26, 2), A(26, 2.25), A(26, 2.5)];
    const fl = [
      { kind: 'tomato', from: [rm.seats[2].x, rm.seats[2].y - 300], dx: -18, dy: 10, seed: 11 },
      { kind: 'tomato', from: [rm.seats[3].x, rm.seats[3].y - 300], dx: 26, dy: -20, seed: 12 },
      { kind: 'tomato', from: [2000, 200], dx: -10, dy: 40, seed: 13 },
      { kind: 'poop', from: [rm.seats[3].x, rm.seats[3].y - 280], dx: 0, dy: -110, seed: 14 },
      { kind: 'tomato', from: [rm.seats[2].x, rm.seats[2].y - 280], dx: 30, dy: 60, seed: 15 },
    ];
    const throws = fl.map((f, i) => thrown(front, { kind: f.kind, from: f.from, to: [head[0] + f.dx, head[1] + f.dy], t0: T0[i] - K.spb * 0.5, dur: K.spb * 0.5, arc: 200, size: 100, seed: f.seed, splatR: 70, life: 3, spin: 720 }));
    const dl = dialog(root, { who: 'tuan', name: S.names.tuan, tag: S.tags.tuan, ...S.l_nope, x: 820, y: 290, w: 720, hgt: 180 });
    return (lt, t) => {
      T(win, { s: lerp(1.5, 1, E.outBack(prog(A(26, 1), A(26, 1) + 0.2, t))), o: prog(A(26, 1), A(26, 1) + 0.05, t) });
      rm.seats.forEach((st, i) => {
        const b = Math.abs(Math.sin((t - A(26, 1)) * Math.PI / K.spb + i)) * 18;
        if (i === 0) {
          const hit = T0.filter(x => t >= x).length;
          const jolt = T0.reduce((a, x) => a + pulse(t, x, x + 0.18, 0.02, 0.16), 0);
          st.p.set({ x: st.x - jolt * 12, y: st.y, s: st.s, eyes: hit === 0 ? 'open' : t > A(26, 3) ? 'lid' : hit % 2 ? 'squeeze' : 'x', lid: 0.5, tilt: -jolt * 8, sq: 1 - jolt * 0.06 });
        } else st.p.set({ x: st.x, y: st.y - b, s: st.s, eyes: 'happy', sq: 1 + b * 0.002 });
      });
      throws.forEach(f => f(t));
      dl.set(t, A(26, 3), A(27, 1) + 0.1);
      const sh = T0.reduce((a, x, i) => { const q = shake(t, x, 0.16, 10, 40, 70 + i); return [a[0] + q.x, a[1] + q.y]; }, [0, 0]);
      T(root, { x: sh[0], y: sh[1] });
    };
  });
}
