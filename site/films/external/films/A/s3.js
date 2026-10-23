// Film A · Act 3 — full house on the sofa, warm-up (danmaku / chat / reactions / voice), the control handover.
import { h, s, T, ST, O, kf, tw, prog, E, clamp, lerp, rng, noise, shake, show, pulse } from '../../engine/core.js';
import { C, CAST, mascot, person, icon, reaction, burst, focusLines, streaks, halftone, stripes, rays } from '../../engine/art.js';
import { ransom, ransomPop } from '../../engine/type.js';
import { dialog, bubble, cutin, screen, heads, room, danmaku, callout, thrown, snap, cursor, row, inRow } from './kit.js';
import { game } from './game.js';
import { FACE } from './strings.js';

export function build(film, K) {
  const A = (b, beat = 1) => K.at(b, beat);
  const S = film.S, EN = film.lang === 'en', F = FACE[film.lang];

  // ------------------------------------------------ S8 · FULL HOUSE
  film.scene('s8-full', snap(A(13, 1)), snap(A(15, 1)), root => {
    root.style.background = C.ink2;
    const ray = h('div', { class: 'abs' }, root);
    Object.assign(ray.style, { left: '-540px', top: '-1000px', width: '3000px', height: '3000px', background: rays('rgba(255,208,90,.16)', 'transparent', 18), transformOrigin: '50% 50%' });
    const big = h('div', { class: 'abs anton nowrap', text: 'FULL HOUSE' }, root);
    Object.assign(big.style, { left: '0', top: '120px', width: '1920px', textAlign: 'center', font: '400 380px/1 Anton', color: 'transparent', WebkitTextStroke: '4px rgba(246,242,232,.14)' });
    const rm = room(root, { k: 1.62, sofaY: 690 });
    const pins = [1, 2, 3].map(i => {
      const el = h('div', { class: 'abs nowrap center' }, root);
      const lab = S.pins[i - 1];
      Object.assign(el.style, { padding: '8px 16px', gap: '8px', background: C.cream, color: C.ink2, font: '900 30px/1 "Noto Sans SC"', borderRadius: '10px', border: `4px solid ${C.ink2}` });
      el.innerHTML = `<svg width="22" height="26" viewBox="0 0 22 26"><path d="M11 25C5 17 2 13 2 9a9 9 0 0 1 18 0c0 4-3 8-9 16Z" fill="${C.red}"/><circle cx="11" cy="9" r="3.5" fill="#fff"/></svg>${lab}`;
      return el;
    });
    const cnt = h('div', { class: 'abs mono', html: `<span class="hud" style="font:600 22px Barlow Condensed;letter-spacing:.2em;opacity:.7">${S.viewers}</span><br><b></b> / 20` }, root);
    Object.assign(cnt.style, { right: '70px', left: 'auto', top: '56px', textAlign: 'right', font: '700 72px/1.15 "JetBrains Mono"', color: C.cream });
    const cntN = cnt.querySelector('b');
    const titleRow = row(root, { y: 40 });
    const title = inRow(titleRow, ransom(root, S.fullHouse, { size: EN ? 140 : 150, seed: 77 }));
    const sub = h('div', { class: 'abs nowrap center' }, root);
    Object.assign(sub.style, { left: '0', top: '960px', width: '1920px', gap: '26px', color: C.cream });
    sub.innerHTML = `<b style="font:${EN ? '400 60px/1 Anton;letter-spacing:.03em' : '900 52px/1 Noto Sans SC'}">${S.together[0]}</b>` + (S.together[1] ? `<span style="font:600 26px/1 Barlow Condensed;letter-spacing:.22em;color:#ffd05a">${S.together[1]}</span>` : '');
    const dust = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, root);
    const puffs = [1, 2, 3].map(i => [0, 1, 2, 3, 4].map(j => s('circle', { r: 14, fill: C.cream, opacity: 0 }, dust)));
    const lands = [A(13, 1), A(13, 2), A(13, 3)];
    return (lt, t) => {
      ray.style.transform = `rotate(${t * (t > A(14, 1) ? 14 : 4)}deg)`;
      O(big, prog(A(14, 1), A(14, 1) + 0.2, t));
      let n = 0;
      rm.seats.forEach((st, i) => {
        if (i === 0) {
          const hop = i === 0 ? Math.max(0, Math.sin(prog(lands[2], lands[2] + 0.35, t) * Math.PI)) * 50 : 0;
          const beatB = t > A(14, 1) ? Math.abs(Math.sin((t - A(14, 1)) * Math.PI / K.spb)) * 14 : 0;
          st.p.set({ x: st.x, y: st.y - hop - beatB, s: st.s, eyes: t < lands[2] ? 'open' : t < lands[2] + 0.4 ? 'wide' : 'happy', look: t < A(13, 4) ? [3, 0] : [0, 0], blink: 0 });
          return;
        }
        const tl = lands[i - 1];
        if (t >= tl) n = i;
        const fall = prog(tl - 0.2, tl, t);
        const after = t - tl;
        const y = t < tl ? lerp(-900, 0, E.in2(fall)) : 0;
        let sq = 1;
        if (after >= 0) sq = 1 - 0.35 * Math.exp(-after * 9) * Math.cos(after * 26);
        else sq = 1 + 0.25 * fall;
        const beatB = t > A(14, 1) ? Math.abs(Math.sin((t - A(14, 1)) * Math.PI / K.spb + i)) * 14 : 0;
        st.p.set({ x: st.x, y: st.y + y - beatB, s: st.s, sq, eyes: after < 0.3 ? 'squeeze' : t < A(14, 1) ? 'open' : 'happy', o: t >= tl - 0.2 ? 1 : 0 });
        puffs[i - 1].forEach((c, j) => {
          const q = prog(tl, tl + 0.5, t);
          const dir = j - 2;
          c.setAttribute('cx', st.x + dir * (40 + q * 90));
          c.setAttribute('cy', st.y - 10 - q * 30 * (1 - Math.abs(dir) * 0.3));
          c.setAttribute('r', 10 + q * 18);
          c.setAttribute('opacity', q > 0 && q < 1 ? 0.8 * (1 - q) : 0);
        });
      });
      // cushion dip on each landing
      const dip = lands.reduce((a, tl) => a + Math.max(0, Math.exp(-(t - tl) * 10) * (t >= tl ? 1 : 0)), 0);
      ST(rm.sofaG, { x: rm.sx, y: rm.sofaY + dip * 10, s: rm.k, sy: 1 - dip * 0.03 });
      cntN.textContent = n;
      T(cnt, { s: 1 + 0.25 * lands.reduce((a, tl) => a + pulse(t, tl, tl + 0.2, 0.02, 0.18), 0), ox: '100%', oy: '0%' });
      show(titleRow, t >= A(14, 1));
      ransomPop(title.chars, t, title.chars.map((_, i) => A(14, 1) + i * (EN ? 0.08 : 0.045)));
      pins.forEach((p, i) => {
        const st = rm.seats[i + 1];
        const q = E.outBack(prog(A(14, 3) + i * 0.06, A(14, 3) + i * 0.06 + 0.2, t));
        T(p, { x: st.x - 64, y: st.y - 430 + (1 - q) * 30, s: q, o: t >= A(14, 3) + i * 0.06 ? 1 : 0 });
      });
      T(sub, { y: (1 - E.outExpo(prog(A(14, 3), A(14, 3) + 0.4, t))) * 60, o: prog(A(14, 3), A(14, 3) + 0.15, t) });
      const sh = shake(t, lands[2], 0.35, 16, 36, 17);
      const sh2 = shake(t, A(14, 1), 0.3, 12, 40, 19);
      T(root, { x: sh.x + sh2.x, y: sh.y + sh2.y });
    };
  });

  // ------------------------------------------------ S9 · warm-up: danmaku, chat, reactions, voice
  film.scene('s9-warm', snap(A(15, 1)), snap(A(19, 1)), root => {
    root.style.background = C.night;
    const cam = h('div', { class: 'fill' }, root);
    const glow = h('div', { class: 'fill' }, cam);
    glow.style.background = 'radial-gradient(60% 55% at 50% 45%, rgba(120,110,255,.22), transparent 70%)';
    const sc = screen(cam, { x: 150, y: 46, w: 1620, hgt: 911 });
    const g = game(sc.content, { w: sc.w, hgt: sc.h, S });
    const live = h('div', { class: 'live', html: '<i></i>LIVE' }, cam);
    Object.assign(live.style, { left: '196px', top: '88px' });
    const view = h('div', { class: 'abs mono nowrap', html: S.viewers3 }, cam);
    Object.assign(view.style, { left: '360px', top: '94px', padding: '10px 16px', background: 'rgba(18,27,36,.85)', border: `2px solid ${C.cream}`, borderRadius: '10px', color: C.cream, font: '700 28px/1 "JetBrains Mono"' });
    // danmaku inside the screen
    const dmBox = h('div', { class: 'abs' }, cam);
    Object.assign(dmBox.style, { left: '168px', top: '64px', width: '1584px', height: '875px', overflow: 'hidden', borderRadius: '16px' });
    const tom = '<svg width="46" height="46" viewBox="0 0 40 40" style="vertical-align:-8px"><path d="M20 11C5 3 0 31 16 34c20 5 26-30 4-23Z" fill="#e96c55"/><path d="m20 14-9-6 8 2 3-6 2 6 8-1-7 6Z" fill="#448e6b"/></svg>';
    const items = [
      { t0: A(15, 3), y: 190, text: S.danmaku[0] },
      { t0: A(15, 3.5), y: 300, text: S.danmaku[1], cls: 'b' },
      { t0: A(15, 4), y: 410, html: S.danmaku[2].replace('{tomato}', tom), cls: 'y' },
      { t0: A(16, 1), y: 250, text: S.danmaku[3], cls: 'p' },
      { t0: A(16, 1.5), y: 520, text: S.danmaku[4] },
      { t0: A(16, 2), y: 360, text: S.danmaku[5], cls: 'y' },
      { t0: A(16, 3), y: 170, text: S.danmaku[6] },
      { t0: A(17, 2), y: 460, text: S.danmaku[7], cls: 'b' },
      { t0: A(17, 4), y: 220, text: '666' },
      { t0: A(18, 3), y: 180, text: S.danmaku[9], cls: 'y', size: 64 },
      { t0: A(18, 3.5), y: 300, text: S.danmaku[10], size: 64 },
      { t0: A(18, 4), y: 420, text: S.danmaku[11], cls: 'p', size: 64 },
      { t0: A(18, 4.5), y: 540, text: S.danmaku[12], cls: 'b', size: 64 },
    ];
    const dm = danmaku(dmBox, items, { left: 0, right: 1584, speed: 700 });
    // chat panel (the product's interaction panel, restyled)
    const chat = h('div', { class: 'abs' }, cam);
    Object.assign(chat.style, { left: '1330px', top: '300px', width: '470px', height: '420px', background: C.paper, borderRadius: '24px', border: `5px solid ${C.ink2}`, boxShadow: `10px 12px 0 ${C.ink2}`, overflow: 'hidden' });
    const chTitle = h('div', { class: 'abs nowrap', html: S.chatTitle }, chat);
    Object.assign(chTitle.style, { left: '24px', top: '18px', font: '900 30px/1 "Noto Sans SC"', color: C.ink2 });
    const msgs = [
      { who: 'yuan', text: S.chat[0], at: A(15, 1.25) },
      { who: 'dian', text: S.chat[1], at: A(15, 2) },
      { who: 'cong', text: S.chat[2], at: A(15, 2.75) },
      { who: 'tuan', text: S.chat[3], at: A(15, 3.5) },
    ].map((m, i) => {
      const ch = CAST[m.who];
      const row = h('div', { class: 'abs nowrap' }, chat);
      Object.assign(row.style, { left: '20px', top: 80 + i * 82 + 'px', display: 'flex', alignItems: 'center', gap: '12px' });
      const av = h('i', {}, row);
      Object.assign(av.style, { width: '40px', height: '40px', borderRadius: '50%', background: ch.color, border: `3px solid ${C.ink2}`, display: 'block' });
      const bub = h('div', { text: m.text }, row);
      Object.assign(bub.style, { padding: '12px 18px', background: m.who === 'tuan' ? C.yellow : '#e9eef5', borderRadius: '16px', font: '700 28px/1 "Noto Sans SC"', color: C.ink2 });
      return { row, at: m.at };
    });
    const hd = heads(cam, { y: 1010 });
    const front = h('div', { class: 'fill' }, cam);
    const throws = [
      thrown(front, { kind: 'tomato', from: [1380, 880], to: [1180, 330], t0: A(16, 1), dur: K.spb, arc: 300, size: 110, seed: 3, splatR: 110, life: 2.6 }),
      thrown(front, { kind: 'poop', from: [1380, 880], to: [560, 760], t0: A(16, 3), dur: K.spb, arc: 360, size: 120, seed: 4, life: 2.4 }),
    ];
    // voice rings on 小圆
    const rings = s('svg', { width: 400, height: 400, style: 'position:absolute;left:0;top:0' }, cam);
    const rg = [0, 1, 2].map(i => s('circle', { cx: 200, cy: 200, r: 60, fill: 'none', stroke: C.blue, 'stroke-width': 8, opacity: 0 }, rings));
    const mic = h('div', { class: 'abs center' }, cam);
    Object.assign(mic.style, { width: '74px', height: '74px', borderRadius: '50%', background: C.blue, border: `5px solid ${C.ink2}` });
    mic.appendChild(icon('microphone', { size: 44, color: C.ink2, sw: 2.4 }));
    const b1 = bubble(cam, { who: 'yuan', name: S.names.yuan, ...S.b_yuan, x: 560, y: 560, w: EN ? 700 : 660, seed: 5 });
    const b2 = bubble(cam, { who: 'tuan', name: S.names.tuan, ...S.b_tuan, x: 250, y: 560, w: 520, seed: 8 });
    const co = [
      callout(cam, { x: 200, y: 640, main: S.callouts[0][0], sub: S.callouts[0][1], ax: 430, ay: 470 }),
      callout(cam, { x: 1010, y: 760, main: S.callouts[1][0], sub: S.callouts[1][1], ax: 1330, ay: 700, side: 'left' }),
      callout(cam, { x: 880, y: 170, main: S.callouts[2][0], sub: S.callouts[2][1], ax: 1180, ay: 330 }),
      callout(cam, { x: 1300, y: 560, main: S.callouts[3][0], sub: S.callouts[3][1], ax: 905, ay: 860 }),
    ];
    return (lt, t) => {
      g.select(t, { p2: 'wait' });
      dm.set(t);
      const cp = E.outExpo(prog(A(15, 1), A(15, 1) + 0.35, t));
      const cq = E.in3(prog(A(16, 1) - 0.05, A(16, 1) + 0.2, t));
      T(chat, { x: (1 - cp) * 600 + cq * 700, o: t >= A(15, 1) ? 1 - cq : 0 });
      msgs.forEach(m => { const q = E.outBack(prog(m.at, m.at + 0.2, t)); T(m.row, { s: q, o: t >= m.at ? 1 : 0, ox: '0%', oy: '50%' }); });
      hd.set(t, {
        bob: (i, tt) => -Math.abs(Math.sin(tt * Math.PI / K.spb + i * 0.7)) * 6 - (i === 1 ? pulse(tt, A(17, 1), A(18, 1), 0.1, 0.2) * 14 : 0),
        tilt: (i, tt) => (i === 3 ? pulse(tt, A(16, 1) - 0.1, A(16, 1) + 0.2, 0.08, 0.12) * -16 + pulse(tt, A(16, 3) - 0.1, A(16, 3) + 0.2, 0.08, 0.12) * -16 : 0),
      });
      throws.forEach(f => f(t));
      // voice: rings + mic badge on 小圆 (head 2 of 4 at x=840)
      const vOn = t >= A(17, 1) && t < A(18, 1) + 0.2;
      show(rings, vOn); show(mic, t >= A(17, 1) && t < A(19, 1));
      T(rings, { x: 840 - 200, y: 911 - 200 });
      rg.forEach((c, i) => {
        const q = ((((t - A(17, 1)) / 0.7 + i / 3) % 1) + 1) % 1;
        c.setAttribute('r', 70 + q * 130); c.setAttribute('opacity', vOn ? (1 - q) * 0.9 : 0);
      });
      T(mic, { x: 840 + 30, y: 911 - 150, s: E.outBack(prog(A(17, 1), A(17, 1) + 0.2, t)) });
      b1.set(t, A(17, 1), A(18, 1));
      b2.set(t, A(18, 1), A(19, 1));
      co[0].set(t, A(16, 1), A(17, 1));
      co[1].set(t, A(15, 2), A(16, 1));
      co[2].set(t, A(16, 2), A(17, 1.5));
      co[3].set(t, A(17, 1.5), A(18, 1.5));
      T(cam, { s: lerp(1, 1.03, prog(A(15, 1), A(19, 1), t)), ox: '50%', oy: '60%' });
    };
  });

  // ------------------------------------------------ S10 · the control handover
  film.scene('s10-hand', snap(A(19, 1)), snap(A(21, 1)), root => {
    root.style.background = C.night;
    const back = h('div', { class: 'fill' }, root);
    const sc = screen(back, { x: 150, y: 46, w: 1620, hgt: 911 });
    const g = game(sc.content, { w: sc.w, hgt: sc.h, S });
    const hd = heads(back, { y: 1010 });
    const dim = h('div', { class: 'fill' }, root);
    dim.style.background = 'rgba(8,12,18,.62)';
    // request card (the product's remote-control request, restyled)
    const req = h('div', { class: 'abs' }, root);
    Object.assign(req.style, { left: '520px', top: '230px', width: '880px', height: '560px', transform: 'skewX(-8deg)' });
    const reqIn = h('div', { class: 'fill' }, req);
    Object.assign(reqIn.style, { background: C.cream, border: `8px solid ${C.ink2}`, boxShadow: `18px 18px 0 ${C.yellow}, 18px 18px 0 8px ${C.ink2}` });
    const un = h('div', { class: 'fill' }, req);
    un.style.transform = 'skewX(8deg)';
    const tag = h('div', { class: 'abs hud nowrap', text: S.reqTag }, un);
    Object.assign(tag.style, { left: '40px', top: '-30px', padding: '10px 18px', background: C.red, color: '#fff', font: '800 26px/1 "Barlow Condensed"', letterSpacing: '.22em' });
    const av = s('svg', { width: 200, height: 220, style: 'position:absolute;left:60px;top:60px' }, un);
    const ap = person({ color: C.blue });
    av.appendChild(ap.el);
    ap.set({ x: 100, y: 210, s: 1.45, eyes: 'spark' });
    const rt = h('div', { class: 'abs zh nowrap', html: S.reqTitle(S.names.yuan) }, un);
    Object.assign(rt.style, { left: '270px', top: '86px', font: EN ? '900 54px/1 "Noto Sans SC"' : '900 76px/1 "Noto Sans SC"', color: C.ink2 });
    const rs = h('div', { class: 'abs', text: S.consent }, un);
    Object.assign(rs.style, { left: '274px', top: '186px', width: '560px', font: '500 30px/1.3 "Noto Sans SC"', color: C.ink2, opacity: 0.8, whiteSpace: EN ? 'normal' : 'nowrap' });
    const no = h('div', { class: 'abs center zh', text: S.decline }, un);
    Object.assign(no.style, { left: '120px', top: '330px', width: '270px', height: '120px', borderRadius: '60px', border: `6px solid ${C.ink2}`, font: '900 52px/1 "Noto Sans SC"', color: C.ink2, background: '#fff' });
    const yes = h('div', { class: 'abs center zh', html: '' }, un);
    Object.assign(yes.style, { left: '430px', top: '330px', width: '380px', height: '120px', borderRadius: '60px', border: `6px solid ${C.ink2}`, font: '900 52px/1 "Noto Sans SC"', color: '#fff', background: C.primary, gap: '14px' });
    yes.appendChild(icon('check', { size: 54, color: '#fff', sw: 3 }));
    h('span', { text: S.allow }, yes);
    if (EN) { no.style.fontSize = '44px'; yes.style.fontSize = '44px'; }
    const cur = cursor(root);
    // split: one computer, two players
    const split = h('div', { class: 'fill' }, root);
    const L = h('div', { class: 'fill' }, split), R = h('div', { class: 'fill' }, split);
    L.style.background = `${halftone('rgba(0,0,0,.16)', 18, 30)}, ${C.greenD}`;
    R.style.background = `${halftone('rgba(0,0,0,.16)', 18, 30)}, ${C.blueD}`;
    L.style.clipPath = 'polygon(0 0, 62% 0, 38% 100%, 0 100%)';
    R.style.clipPath = 'polygon(62% 0, 100% 0, 100% 100%, 38% 100%)';
    const kb = (parent, x, y, keys, col, label, sub) => {
      const el = h('div', { class: 'abs' }, parent);
      T(el, { x, y });
      const sv = s('svg', { width: 520, height: 260 }, el);
      s('rect', { x: 6, y: 6, width: 508, height: 248, rx: 30, fill: C.ink2 }, sv);
      const lit = [];
      const rows = [[0, 9], [1, 9], [2, 8]];
      rows.forEach(([r, n]) => {
        for (let i = 0; i < n; i++) {
          const kx = 30 + i * 52 + r * 18, ky = 30 + r * 64;
          const on = keys.includes(`${r},${i}`);
          const k = s('rect', { x: kx, y: ky, width: 44, height: 52, rx: 10, fill: on ? col : '#2e3e4f' }, sv);
          if (on) lit.push(k);
        }
      });
      s('rect', { x: 140, y: 222, width: 240, height: 22, rx: 8, fill: '#2e3e4f' }, sv);
      const lb = h('div', { class: 'abs nowrap', html: `<b style="font:400 92px/1 Anton;color:${C.cream}">${label}</b><br><span style="font:900 44px/1.4 Noto Sans SC;color:${C.cream}">${sub}</span>` }, el);
      Object.assign(lb.style, { left: '0', top: '-200px' });
      return { el, lit };
    };
    const k1 = kb(L, 150, 520, ['0,1', '1,0', '1,1', '1,2'], C.green, 'P1', S.p1Sub);
    const k2 = kb(R, 1250, 520, ['1,6', '2,5', '2,6', '2,7'], C.blue, 'P2', S.p2Sub);
    const bolt = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, split);
    const boltP = s('path', { d: 'M1230 -20 1060 420 1150 430 760 1100 980 600 880 590 1010 -20Z', fill: C.yellow, stroke: C.ink2, 'stroke-width': 10, 'stroke-linejoin': 'round' }, bolt);
    const head = h('div', { class: 'abs nowrap center' }, split);
    Object.assign(head.style, { left: '0', top: '70px', width: '1920px', gap: '20px' });
    head.innerHTML = `<span style="padding:12px 22px;background:${C.ink2};color:${C.cream};font:800 30px/1 Barlow Condensed;letter-spacing:.24em">${S.rcHead}</span>`;
    const big = h('div', { class: 'abs zh nowrap', text: S.onePC }, split);
    Object.assign(big.style, { left: '0', width: '1920px', textAlign: 'center', top: EN ? '180px' : '200px', font: F.display(EN ? 140 : 120), letterSpacing: EN ? '.03em' : '0', color: C.cream, WebkitTextStroke: `10px ${C.ink2}`, paintOrder: 'stroke fill' });
    const dl = dialog(split, { who: 'tuan', name: S.names.tuan, tag: S.tags.tuan, ...S.l_kb, x: 520, y: 840, w: 900, hgt: 190 });
    // staring contest (music stop)
    const dark = h('div', { class: 'fill' }, root);
    dark.style.background = '#05080c';
    const c1 = cutin(dark, { who: 'tuan', y: 330, hgt: 280, rot: -5, faceX: 760, scale: 16 });
    const c2 = cutin(dark, { who: 'yuan', y: 760, hgt: 280, rot: -5, faceX: 1500, scale: 16 });
    const click = A(19, 2.5), cut = A(19, 3), stop = A(20, 3);
    return (lt, t) => {
      g.select(t, { p2: 'wait' });
      hd.set(t, { bob: () => 0 });
      const rp = E.outExpo(prog(A(19, 1), A(19, 1) + 0.3, t));
      req.style.transform = `translateX(${(1 - rp) * 1400}px) skewX(-8deg) rotate(${(1 - rp) * 6}deg)`;
      O(dim, rp);
      const yp = pulse(t, click, click + 0.16, 0.03, 0.12);
      yes.style.transform = `scale(${1 - yp * 0.08})`;
      yes.style.background = t > click ? C.live : C.primary;
      const cx = kf(t, [[A(19, 1.5), 1500], [click - 0.03, 1170, 'io3']]);
      const cy = kf(t, [[A(19, 1.5), 1000], [click - 0.03, 640, 'io3']]);
      cur.set(cx, cy, yp, t >= A(19, 1.5) && t < cut ? 1 : 0, prog(click, click + 0.3, t) || -1);
      // split screen
      show(split, t >= cut && t < stop);
      const sp = E.outExpo(prog(cut, cut + 0.25, t));
      L.style.transform = `translateX(${(1 - sp) * -1200}px)`;
      R.style.transform = `translateX(${(1 - sp) * 1200}px)`;
      boltP.setAttribute('transform', `translate(0 ${(1 - E.outBack(prog(cut + 0.08, cut + 0.3, t))) * -1200})`);
      const blink = (t * 4) % 1 < 0.6 ? 1 : 0.55;
      k1.lit.forEach(k => k.setAttribute('opacity', blink));
      k2.lit.forEach(k => k.setAttribute('opacity', blink));
      T(big, { s: lerp(1.6, 1, E.outBack(prog(cut + 0.12, cut + 0.36, t))), o: prog(cut + 0.12, cut + 0.2, t) });
      dl.set(t, A(20, 1), stop);
      // staring contest during the stop
      show(dark, t >= stop);
      c1.set(t, stop, A(21, 1) + 0.05, 'lid', { lid: 0.42, lidAngle: 16 });
      c2.set(t, stop + 0.12, A(21, 1) + 0.05, 'lid', { lid: 0.42, lidAngle: 16 });
      const sh = shake(t, cut, 0.3, 16, 40, 23);
      T(root, { x: sh.x, y: sh.y });
    };
  });
}
