// Film A · Act 2 — the three-step Silip flow: pick a source → copy the invite (calling card) → friends open it in a browser.
import { h, s, T, ST, O, kf, tw, prog, E, clamp, lerp, rng, noise, shake, show, pulse } from '../../engine/core.js';
import { C, CAST, mascot, person, icon, burst, focusLines, streaks, halftone, stripes } from '../../engine/art.js';
import { ransom, ransomPop } from '../../engine/type.js';
import { screen, stamp, snap, cursor, callingCard, browser, row, inRow } from './kit.js';
import { game } from './game.js';
import { FACE } from './strings.js';

const GRID = 'linear-gradient(rgba(246,242,232,.045) 2px, transparent 2px) 0 0 / 80px 80px, linear-gradient(90deg, rgba(246,242,232,.045) 2px, transparent 2px) 0 0 / 80px 80px';

/** Big outlined step numeral + title + microtype, shared by the three steps. */
function header(parent, { n, title, sub, dark = true, lang = 'zh' }) {
  const el = h('div', { class: 'abs' }, parent);
  const num = h('div', { class: 'abs anton', text: n }, el);
  Object.assign(num.style, { left: '96px', top: '28px', font: '400 250px/1 Anton', color: 'transparent', WebkitTextStroke: `4px ${dark ? C.cream : C.ink2}` });
  const tz = h('div', { class: 'abs zh nowrap', text: title }, el);
  Object.assign(tz.style, { left: '360px', top: lang === 'en' ? '78px' : '86px', font: lang === 'en' ? '400 112px/1 Anton' : '900 92px/1 "Noto Sans SC"', letterSpacing: lang === 'en' ? '.02em' : '0', color: dark ? C.cream : C.ink2 });
  const te = h('div', { class: 'abs hud nowrap', text: sub }, el);
  Object.assign(te.style, { left: '366px', top: '206px', font: '600 28px/1 "Barlow Condensed"', letterSpacing: '.24em', color: dark ? C.yellow : C.ink2 });
  const bar = h('div', { class: 'abs' }, el);
  Object.assign(bar.style, { left: '366px', top: '196px', width: '120px', height: '6px', background: C.red });
  return (t, t0) => {
    const p = E.outExpo(prog(t0, t0 + 0.3, t));
    T(num, { x: (1 - p) * -260, o: p });
    T(tz, { x: (1 - p) * 180, o: prog(t0 + 0.04, t0 + 0.14, t) });
    T(te, { x: (1 - E.outExpo(prog(t0 + 0.08, t0 + 0.38, t))) * 220, o: prog(t0 + 0.08, t0 + 0.2, t) });
    bar.style.transform = `scaleX(${E.outExpo(prog(t0 + 0.1, t0 + 0.4, t))})`;
    bar.style.transformOrigin = '0 50%';
    bar.style.top = '256px';
  };
}

export function build(film, K) {
  const A = (b, beat = 1) => K.at(b, beat);
  const S = film.S, EN = film.lang === 'en', lang = film.lang;

  // ------------------------------------------------ S5 · STEP 01 pick a source
  film.scene('s5-source', snap(A(7, 1)), snap(A(9, 1)), root => {
    root.style.background = `${GRID}, ${C.ink2}`;
    const band = h('div', { class: 'abs' }, root);
    Object.assign(band.style, { left: '-200px', top: '420px', width: '2400px', height: '440px', background: C.yellow, transform: 'rotate(-6deg)' });
    const bandDots = h('div', { class: 'fill' }, band);
    bandDots.style.background = halftone('rgba(25,37,48,.16)', 16, 30);
    const hd = header(root, { n: '01', title: S.step1[0], sub: S.step1[1], lang });
    const data = ['cast', 'camera', 'window', 'display'].map((ic, i) => ({ zh: S.sources[i][0], en: S.sources[i][1], ic, k: 'ABCD'[i] }));
    const cards = data.map((d, i) => {
      const el = h('div', { class: 'abs' }, root);
      Object.assign(el.style, { left: 250 + i * 375 + 'px', top: '420px', width: '330px', height: '420px', background: C.cream, border: `7px solid ${C.ink2}`, boxShadow: `14px 14px 0 ${C.ink2}`, transformOrigin: '50% 60%' });
      const inner = h('div', { class: 'fill' }, el);
      inner.style.transform = 'skewX(7deg)';
      const k = h('div', { class: 'abs anton', text: d.k }, inner);
      Object.assign(k.style, { left: '26px', top: '16px', font: '400 52px/1 Anton', color: C.red });
      const ic = icon(d.ic, { size: 140, color: C.ink2, sw: 2 });
      Object.assign(ic.style, { position: 'absolute', left: '95px', top: '70px' });
      inner.appendChild(ic);
      const z = h('div', { class: 'abs zh nowrap', text: d.zh }, inner);
      Object.assign(z.style, { left: '0', width: '100%', textAlign: 'center', top: EN ? '244px' : '236px', font: EN ? '400 80px/1 Anton' : '900 70px/1 "Noto Sans SC"', letterSpacing: EN ? '.03em' : '0', color: C.ink2 });
      const e = h('div', { class: 'abs hud nowrap', text: d.en }, inner);
      Object.assign(e.style, { left: '0', width: '100%', textAlign: 'center', top: '330px', font: '600 26px/1 "Barlow Condensed"', letterSpacing: '.22em', color: C.ink2 });
      return { el, inner, i };
    });
    // the chosen window: becomes the live screen
    const big = h('div', { class: 'abs' }, root);
    Object.assign(big.style, { left: '0', top: '0', width: '1920px', height: '1080px', transformOrigin: '0 0' });
    const sc = screen(big, { x: 150, y: 46, w: 1620, hgt: 911 });
    const g = game(sc.content, { w: sc.w, hgt: sc.h, S });
    const live = h('div', { class: 'live', html: '<i></i>LIVE' }, big);
    Object.assign(live.style, { left: '196px', top: '88px' });
    const chip = h('div', { class: 'abs nowrap', html: S.sharingChip }, big);
    Object.assign(chip.style, { left: '370px', top: '92px', padding: '10px 20px', background: 'rgba(18,27,36,.85)', color: C.cream, font: '500 28px/1 "Noto Sans SC"', borderRadius: '10px', border: `2px solid ${C.cream}` });
    const goRow = row(root, { y: 400 });
    const go = inRow(goRow, ransom(root, S.live, { size: EN ? 190 : 210, seed: 41 }));
    const cur = cursor(root);
    cur.el.style.zIndex = 20;
    const inv = h('div', { class: 'fill' }, root);
    inv.style.zIndex = 30;
    Object.assign(inv.style, { background: '#fff', mixBlendMode: 'difference' });
    return (lt, t) => {
      hd(t, A(7, 1));
      band.style.transform = `rotate(-6deg) translateX(${(1 - E.outExpo(prog(A(7, 1), A(7, 1) + 0.4, t))) * 2400}px)`;
      const hover = E.out3(prog(A(7, 3.5), A(7, 3.5) + 0.14, t));
      const click = A(8, 1), zoomT0 = A(8, 2), zoomT1 = A(8, 2) + 0.36;
      cards.forEach(c => {
        const t0 = A(7, 1) + c.i * K.spb * 0.25;
        const p = E.outExpo(prog(t0, t0 + 0.32, t));
        const away = E.in3(prog(zoomT0, zoomT0 + 0.2, t));
        const chosen = c.i === 2;
        let sc2 = 1, op = 1, flip = 1;
        if (chosen) {
          sc2 = 1 + 0.1 * hover - 0.06 * pulse(t, click, click + 0.12, 0.04, 0.08);
          c.el.style.background = hover > 0.5 ? C.yellow : C.cream;
          const f = prog(click, click + 0.16, t);
          flip = f < 0.5 ? 1 - f * 2 : (f - 0.5) * 2;
          show(c.el, t < zoomT0 + 0.02);
        } else {
          op = 1 - 0.6 * hover;
          sc2 = 1 - 0.05 * hover;
        }
        c.el.style.transform = `translateX(${(1 - p) * 1500 + (chosen ? 0 : away * (c.i < 2 ? -1800 : 1800))}px) rotate(${(1 - p) * 10}deg) skewX(-7deg) scale(${sc2 * flip},${sc2})`;
        c.el.style.opacity = op * (chosen ? 1 : 1 - away);
        c.el.style.zIndex = chosen ? 2 : 1;
      });
      // the screen grows from the chosen card's rectangle
      const cardRect = { x: 250 + 2 * 375, y: 420, w: 330, h: 420 };
      const z = E.outExpo(prog(zoomT0 - 0.02, zoomT1, t));
      const s0 = cardRect.w / 1620;
      const scl = lerp(s0, 1, z);
      const bx = lerp(cardRect.x - 150 * s0, 0, z), by = lerp(cardRect.y + 80 - 46 * s0, 0, z);
      show(big, t >= click + 0.08);
      big.style.transform = `translate(${bx}px, ${by}px) scale(${scl})`;
      g.select(t, { p2: 'cpu' });
      const lv = E.outBack(prog(A(8, 3), A(8, 3) + 0.18, t));
      T(live, { s: lerp(2.2, 1, lv), o: t >= A(8, 3) ? 1 : 0, r: (1 - lv) * -14 });
      T(chip, { x: (1 - E.outExpo(prog(A(8, 3) + 0.08, A(8, 3) + 0.4, t))) * -200, o: prog(A(8, 3) + 0.08, A(8, 3) + 0.2, t) });
      show(goRow, t >= A(8, 3));
      ransomPop(go.chars, t, [A(8, 3), A(8, 3) + 0.06, A(8, 3) + 0.12], { out: [A(8, 4.4), A(8, 4.4) + 0.12, 0.02] });
      // cursor
      const cx = kf(t, [[A(7, 2), 1750], [A(7, 3.5), 1150, 'io3'], [click, 1160], [zoomT0, 1160], [zoomT0 + 0.3, 1700, 'in3']]);
      const cy = kf(t, [[A(7, 2), 1060], [A(7, 3.5), 640, 'io3'], [click, 650], [zoomT0, 650], [zoomT0 + 0.3, 1100, 'in3']]);
      cur.set(cx, cy, pulse(t, click, click + 0.14, 0.03, 0.1), t > A(7, 2) && t < zoomT0 + 0.3 ? 1 : 0, prog(click, click + 0.3, t) || -1);
      O(inv, t >= A(8, 3) && t < A(8, 3) + 0.05 ? 1 : 0);
      const sh = shake(t, A(8, 3), 0.3, 14, 40, 9);
      T(root, { x: sh.x, y: sh.y });
    };
  });

  // ------------------------------------------------ S6 · STEP 02 copy the invite → calling card → throw
  film.scene('s6-invite', snap(A(9, 1)), snap(A(11, 1)), root => {
    root.style.background = `${GRID}, ${C.ink2}`;
    const glow = h('div', { class: 'fill' }, root);
    glow.style.background = `${halftone('rgba(255,208,90,.35)', 22, 24)}`;
    glow.style.webkitMaskImage = 'radial-gradient(80% 80% at 100% 100%, #000 0%, transparent 60%)';
    const hd = header(root, { n: '02', title: S.step2[0], sub: S.step2[1], lang });
    // live screen in the corner keeps the context
    const pip = h('div', { class: 'abs' }, root);
    Object.assign(pip.style, { left: '1340px', top: '70px', width: '480px', height: '270px' });
    const pipSc = screen(pip, { x: 0, y: 0, w: 480, hgt: 270 });
    pipSc.el.style.borderRadius = '16px';
    const pg = game(pipSc.content, { w: pipSc.w, hgt: pipSc.h, S });
    const plive = h('div', { class: 'live', html: '<i></i>LIVE' }, pip);
    Object.assign(plive.style, { left: '-18px', top: '-18px', transform: 'scale(.7)', transformOrigin: '0 0' });
    // copy button
    const btn = h('div', { class: 'abs center' }, root);
    Object.assign(btn.style, { left: EN ? '560px' : '650px', top: '560px', width: EN ? '800px' : '620px', height: '150px', borderRadius: '75px', background: C.primary, border: `7px solid ${C.ink2}`, boxShadow: `0 12px 0 ${C.ink2}`, gap: '24px', color: '#fff' });
    const bi = icon('copy', { size: 70, color: '#fff', sw: 2.4 });
    btn.appendChild(bi);
    const bt = h('div', { class: 'zh nowrap', text: S.copy }, btn);
    bt.style.font = EN ? '900 58px/1 "Noto Sans SC"' : '900 70px/1 "Noto Sans SC"';
    const chip = h('div', { class: 'abs center nowrap' }, root);
    Object.assign(chip.style, { left: '700px', top: '420px', width: '520px', height: '96px', borderRadius: '48px', background: C.cream, border: `6px solid ${C.ink2}`, gap: '16px', font: '700 40px/1 "JetBrains Mono"', color: C.ink2 });
    chip.appendChild(icon('link', { size: 48, color: C.ink2, sw: 2.6 }));
    h('span', { text: 'ROOM 9527' }, chip);
    const card = callingCard(root, { lines: [S.card.l1, S.card.l2], sign: S.card.sign, top: S.card.top, sizes: EN ? [100, 108] : [112, 128] });
    const persp = h('div', { class: 'fill' }, root);
    persp.style.perspective = '1600px';
    persp.appendChild(card.el);
    const fp = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, root);
    const dests = [[-320, 760, 120, 690, S.names.yuan], [980, 1320, 1010, 960, S.names.dian], [2260, 700, 1650, 630, S.names.cong]];
    const paths = dests.map(([x, y, lx, ly, nm]) => {
      const p = s('path', { d: `M960 540Q${(960 + x) / 2} ${(540 + y) / 2 - 220} ${x} ${y}`, fill: 'none', stroke: C.yellow, 'stroke-width': 6, 'stroke-dasharray': '18 14', 'stroke-dashoffset': 1600, opacity: 0 }, fp);
      const lab = h('div', { class: 'abs nowrap', html: `<span style="color:#ffd05a">→</span> ${nm}` }, root);
      Object.assign(lab.style, { left: (EN && lx > 1500 ? lx - 60 : lx) + 'px', top: ly + 'px', padding: '6px 14px', background: C.cream, color: C.ink2, font: '900 34px/1 "Noto Sans SC"' });
      return { p, lab };
    });
    const sent = h('div', { class: 'abs nowrap center', html: `<b>${S.sent[0]}</b>&nbsp;&nbsp;<span style="font:600 26px Barlow Condensed;letter-spacing:.2em">${S.sent[1]}</span>` }, root);
    Object.assign(sent.style, { left: '0', top: '0', width: '660px', height: '80px', background: C.red, color: '#fff', font: '900 44px/1 "Noto Sans SC"', transform: 'skewX(-10deg)' });
    const minis = [0, 1, 2].map(i => {
      const m = callingCard(root, { lines: [S.card.l1, S.card.l2], sign: S.card.sign, top: S.card.top, seed: 12, sizes: EN ? [100, 108] : [112, 128] });
      m.el.style.transformOrigin = '50% 50%';
      return m;
    });
    const minisTo = dests.map(d => [d[0], d[1]]);
    const cur = cursor(root);
    const fl = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0;pointer-events:none' }, root);
    const flg = s('g', { transform: 'translate(960 540)' }, fl);
    const lines = s('path', { d: focusLines(90, 420, 1500, 7, 0.01), fill: C.cream, opacity: 0 }, flg);
    const press = A(9, 1.5), copied = A(9, 2), toCard = A(9, 3), thr = A(10, 1);
    return (lt, t) => {
      hd(t, A(9, 1));
      pg.select(t, { p2: 'cpu' });
      T(pip, { x: (1 - E.outExpo(prog(A(9, 1), A(9, 1) + 0.4, t))) * 700 });
      // button
      const bp = E.outBack(prog(A(9, 1) + 0.05, A(9, 1) + 0.3, t));
      const pr = pulse(t, press, press + 0.16, 0.04, 0.12);
      const done = t >= copied;
      btn.style.background = done ? C.live : C.primary;
      bt.textContent = done ? S.copied : S.copy;
      const outB = E.in3(prog(toCard, toCard + 0.16, t));
      T(btn, { s: bp * (1 - pr * 0.08) * (1 - outB), y: pr * 10, o: t >= A(9, 1) + 0.05 ? 1 - outB : 0 });
      // link chip
      const cp = E.outBack(prog(copied, copied + 0.22, t));
      const cflip = prog(toCard, toCard + 0.1, t);
      T(chip, { y: (1 - cp) * 140, s: lerp(0.4, 1, cp), sx: 1 - cflip, o: t >= copied && cflip < 1 ? 1 : 0 });
      // calling card: flip in at toCard, ransom pops, wind-up, then flicked toward the camera
      const fin = E.outBack(prog(toCard + 0.06, toCard + 0.32, t));
      const wind = E.out3(prog(thr - 0.12, thr, t)), fly = E.in3(prog(thr, A(10, 2), t));
      const tx = 680 + wind * -30 + fly * 0, ty = 250 + wind * 20 - fly * 100;
      const rz = wind * -14 + fly * 400, cs = lerp(0.3, 0.88, fin) * (1 - wind * 0.05) * lerp(1, 3.6, fly);
      show(card.el, t >= toCard + 0.06 && t < A(10, 2) + 0.08);
      card.el.style.transform = `translate(${tx}px, ${ty}px) rotateY(${(1 - fin) * 100 + fly * 160}deg) rotateZ(${rz + (1 - fin) * 8}deg) scale(${cs})`;
      card.el.style.opacity = 1 - prog(A(10, 2) - 0.04, A(10, 2) + 0.08, t);
      const rt = [0, 1, 2].map(i => toCard + 0.16 + i * 0.05);
      ransomPop(card.r1.chars, t, rt);
      ransomPop(card.r2.chars, t, [0, 1, 2, 3].map(i => toCard + 0.32 + i * 0.05));
      card.sg.style.opacity = prog(toCard + 0.5, toCard + 0.6, t);
      // three copies burst out toward the three friends
      minis.forEach((m, i) => {
        const t0 = A(10, 2) + i * K.spb * 0.25;
        const q = prog(t0, t0 + 0.5, t);
        show(m.el, q > 0 && q < 1);
        const [ex, ey] = minisTo[i];
        const k = E.out3(q);
        m.el.style.transform = `translate(${lerp(960, ex, k) - 280}px, ${lerp(540, ey, k) - 390}px) rotate(${k * (i - 1 || 1) * 720}deg) scale(${lerp(1.3, 0.3, k)})`;
        const pl = paths[i];
        pl.p.setAttribute('stroke-dashoffset', 1600 * (1 - E.out3(prog(t0, t0 + 0.45, t))));
        pl.p.setAttribute('opacity', prog(t0, t0 + 0.05, t) * (1 - prog(A(11, 1) - 0.15, A(11, 1), t)));
        T(pl.lab, { o: prog(t0 + 0.3, t0 + 0.4, t), x: (1 - E.outBack(prog(t0 + 0.3, t0 + 0.5, t))) * 40 });
      });
      O(sent, prog(A(10, 3), A(10, 3) + 0.1, t));
      T(sent, { x: 960 - 330, y: 600 + (1 - E.outExpo(prog(A(10, 3), A(10, 3) + 0.3, t))) * 40 });
      lines.setAttribute('opacity', 0.25 * pulse(t, thr, A(10, 4), 0.05, 0.3));
      flg.setAttribute('transform', `translate(960 540) rotate(${t * 20})`);
      // cursor
      const cx = kf(t, [[A(9, 1), 1500], [press - 0.02, 1000, 'io3'], [copied + 0.2, 1010], [copied + 0.5, 1650, 'in3']]);
      const cy = kf(t, [[A(9, 1), 1080], [press - 0.02, 640, 'io3'], [copied + 0.2, 650], [copied + 0.5, 1120, 'in3']]);
      cur.set(cx, cy, pr, t < copied + 0.5 ? 1 : 0, prog(press, press + 0.3, t) || -1);
      const sh = shake(t, thr, 0.25, 12, 40, 11);
      T(root, { x: sh.x, y: sh.y });
    };
  });

  // ------------------------------------------------ S7 · STEP 03 they tap the link and watch in a browser
  film.scene('s7-join', snap(A(11, 1)), snap(A(13, 1)), root => {
    root.style.background = `${halftone('rgba(25,37,48,.22)', 18, 30)}, ${C.yellow}`;
    const hd = header(root, { n: '03', title: S.step3[0], sub: S.step3[1], dark: false, lang });
    const P = [
      { who: 'yuan', at: A(11, 1), x: 120, bg: '#1d3350', dev: 'phone' },
      { who: 'dian', at: A(11, 3), x: 720, bg: '#35284f', dev: 'phone' },
      { who: 'cong', at: A(12, 1), x: 1320, bg: '#4d2f1f', dev: 'laptop' },
    ];
    const panels = P.map((d, i) => {
      const ch = CAST[d.who];
      const el = h('div', { class: 'abs' }, root);
      Object.assign(el.style, { left: d.x + 'px', top: '300px', width: '520px', height: '700px', background: C.ink2, transform: 'skewX(-9deg)' });
      const inner = h('div', { class: 'abs' }, el);
      Object.assign(inner.style, { left: '10px', top: '10px', width: '500px', height: '680px', background: d.bg, overflow: 'hidden' });
      const un = h('div', { class: 'fill' }, inner);
      un.style.transform = 'skewX(9deg)';
      // device + browser
      const bw = d.dev === 'phone' ? 300 : 440, bh = d.dev === 'phone' ? 520 : 330;
      const dev = h('div', { class: 'abs' }, un);
      Object.assign(dev.style, { left: (500 - bw) / 2 + 'px', top: d.dev === 'phone' ? '70px' : '120px', width: bw + 'px', height: bh + 'px' });
      const br = browser(dev, { w: bw, hgt: bh, label: S.inviteLink });
      const gm = game(br.content, { w: bw - 10, hgt: (bw - 10) * 875 / 1584, S });
      br.content.style.display = 'flex';
      const toast = h('div', { class: 'abs nowrap center' }, dev);
      Object.assign(toast.style, { left: '50%', top: bh - 70 + 'px', padding: '10px 18px', gap: '10px', background: C.live, color: '#fff', font: '900 28px/1 "Noto Sans SC"', borderRadius: '30px', border: `4px solid ${C.ink2}`, transform: 'translateX(-50%)' });
      toast.appendChild(icon('check', { size: 30, color: '#fff', sw: 3 }));
      h('span', { text: S.joined(S.names[d.who]) }, toast);
      if (d.dev === 'laptop') {
        const base = h('div', { class: 'abs' }, un);
        Object.assign(base.style, { left: '20px', top: '450px', width: '460px', height: '30px', background: '#cfd6df', border: `5px solid ${C.ink2}`, borderRadius: '0 0 20px 20px' });
      }
      const face = s('svg', { width: 260, height: 220, style: 'position:absolute;left:300px;top:520px' }, un);
      const p = person({ color: ch.color });
      face.appendChild(p.el);
      const mini = callingCard(root, { lines: [S.card.l1, S.card.l2], sign: S.card.sign, top: S.card.top, seed: 12, sizes: EN ? [100, 108] : [112, 128] });
      return { el, d, gm, toast, p, mini, br };
    });
    const stp = stamp(root, { main: S.noInstall[0], sub: S.noInstall[1], x: EN ? 520 : 470, y: 520, rot: -8, size: EN ? 104 : 96, face: EN ? 'Anton' : null });
    const flash = h('div', { class: 'fill' }, root);
    flash.style.background = '#fff';
    return (lt, t) => {
      hd(t, A(11, 1));
      panels.forEach((pn, i) => {
        const t0 = pn.d.at;
        const p = E.outExpo(prog(t0 - 0.12, t0 + 0.18, t));
        show(pn.el, t >= t0 - 0.12);
        const suck = E.in4(prog(A(12, 3.5), A(13, 1), t));
        pn.el.style.transform = `translateY(${(1 - p) * 900}px) translateX(${suck * (960 - pn.d.x - 260)}px) skewX(-9deg) scale(${1 - suck * 0.7})`;
        pn.el.style.opacity = 1 - suck;
        pn.gm.select(t, { p2: 'cpu' });
        // the mini card flies into the screen
        const q = prog(t0 - 0.25, t0, t);
        show(pn.mini.el, q > 0 && q < 1);
        pn.mini.el.style.transform = `translate(${lerp(1900, pn.d.x + 120, E.in2(q))}px, ${lerp(-300, 260, E.in2(q))}px) rotate(${lerp(-200, 0, q)}deg) scale(${lerp(0.4, 0.2, q)})`;
        const on = prog(t0, t0 + 0.12, t);
        pn.br.content.style.filter = `brightness(${1 + (1 - on) * 3})`;
        pn.br.content.style.opacity = on;
        const tp = E.outBack(prog(t0 + K.spb * 0.5, t0 + K.spb * 0.5 + 0.2, t));
        pn.toast.style.transform = `translateX(-50%) scale(${tp})`;
        pn.p.set({ x: 110, y: 215 + (1 - E.outBack(prog(t0 + 0.1, t0 + 0.35, t))) * 200, s: 2.4, eyes: t > t0 + 0.2 ? 'spark' : 'open', tilt: -10, look: [-3, -2] });
      });
      stp.set(t, A(12, 3), A(13, 1));
      O(flash, pulse(t, A(13, 1) - 0.08, A(13, 1) + 0.01, 0.07, 0.01));
      const sh = shake(t, A(12, 3), 0.3, 16, 40, 13);
      T(root, { x: sh.x, y: sh.y });
    };
  });
}
