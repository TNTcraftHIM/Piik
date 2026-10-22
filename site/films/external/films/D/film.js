// Film D — 一起看，咔哒一下 / Click, and watch together. The REAL Piik UI (frontend/ui demo build) driven
// frame-by-frame, framed by Tactile motion design. 120 BPM (= the UI demo's own 0.5 s grid), 26 bars, 52 s.
import { Film, clock, h, s, T, O, kf, prog, E, clamp, lerp, show, pulse, backOut } from '../../engine/core.js';
import { mascot, icon } from '../../engine/art.js';
import { realUI } from '../../engine/ui.js';
import { pongSVG, setRally, rallyFromTimes } from './pong.js';
import { STRINGS } from './strings.js';
import { D, FONT_EN, fontFor, wallBG, deviceCard, chip, clickFx, stepper, keycaps, danmakuIn, toss, tile, GLYPH } from './kit.js';

const u = p => new URL(p, import.meta.url).href;
export const meta = {
  id: 'D', title: { zh: '一起看，咔哒一下', en: 'Click, and watch together' },
  size: [1920, 1080], duration: 52, fps: 60, poster: 14.6, langs: ['zh', 'en'],
  css: [u('../../engine/film.css')],
  fonts: [
    { family: 'Noto Sans SC', file: 'NotoSansSC-Variable.ttf', weight: '100 900' },
    { family: 'Nunito', file: 'Nunito[wght].ttf', weight: '200 1000' },
  ],
  audio: { webm: u('../../out/D/audio/web.webm'), m4a: u('../../out/D/audio/web.m4a') },
  // the real UI demo bundle this film embeds (see ui.js UI_BASE)
  requires: ['frontend/ui/index.html'],
};
const CLICKS = await (await fetch(u('./clicks.json'))).json();
// offline renders load the page with ?render (engine/page.js); anything else is live playback
const LIVE = !/[?&]render(=|&|$)/.test(location.search);

export async function build(stage, { lang = 'zh', signal } = {}) {
  const cues = await (await fetch(u('./cues.json'), { signal })).json();
  const K = clock(cues.bpm, cues.beatsPerBar);
  const A = (b, beat = 1) => K.at(b, beat);
  const S = STRINGS[lang], CL = CLICKS[lang];
  const film = new Film({ stage, width: 1920, height: 1080, duration: 52, fps: 60, lang, background: D.wall });
  film.clock = K; film.S = S;
  stage.style.fontFamily = fontFor(lang);

  // rally: serve on [16,1]; crossings every 2 beats, then every beat; P2's smash on [19,4]; out on [20,1]
  const hitT = [A(16, 1), A(16, 3), A(17, 1), A(17, 3), A(18, 1), A(18, 2), A(18, 3), A(18, 4), A(19, 1), A(19, 2), A(19, 3), A(19, 4)];
  setRally({ join: A(15, 3.25), serve: A(16, 1), hits: rallyFromTimes(hitT), missY: 70, missDur: 0.5, out: A(20, 1), label: { [lang]: S.pong } });
  const thumbSrc = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">${pongSVG({ t: 0, lang })}</svg>`);

  // ------------------------------------------------------------ background (always on, below the UI)
  film.layer('bg', root => {
    const up = wallBG(root);
    return t => up(t, K.beat(t));
  }, 0);

  // ------------------------------------------------------------ the real UI, in device cards
  const ui = {};
  film.layer('ui', root => {
    const H = realUI(root, { lang, signal, pongSVG, name: 'host' }), V1 = realUI(root, { lang, signal, pongSVG, name: 'yuan' }), V2 = realUI(root, { lang, signal, pongSVG, name: 'dian' });
    ui.H = H; ui.V1 = V1; ui.V2 = V2;
    const cH = deviceCard(root, H, { kind: 'app', title: S.host, lang });
    const c1 = deviceCard(root, V1, { kind: 'browser', title: S.viewer1, addr: S.addr, lang });
    const c2 = deviceCard(root, V2, { kind: 'browser', title: S.viewer2, addr: S.addr, lang });
    ui.cH = cH; ui.c1 = c1; ui.c2 = c2;
    // --- per-instance state over time -------------------------------------------------------------
    const pong = t => ({ t, lang });
    const thumb = { key: 'piik-' + lang, src: thumbSrc };
    const hostMsg = t => {
      if (t < A(5, 1)) return { scene: 'share', local: Math.max(0, t - (A(3, 1) - 0.75)), time: t, pong: pong(t), thumb };
      if (t < A(7, 1)) return { scene: 'invite', local: Math.max(0.25, t - A(5, 1)), time: t, pong: pong(t) };
      if (t < A(11, 1)) return { scene: 'share', local: 3, time: t, pong: pong(t) };
      if (t < A(12, 1.5) + 0.12) return { scene: 'voice', local: 0.25 + (t - A(11, 1)), time: t, speaker: t >= A(11, 4) && t < A(12, 1.2) ? 0 : null, pong: pong(t) };
      if (t < A(13, 1)) return null;
      if (t < A(16, 1)) return { scene: 'control', local: Math.max(0.25, t - A(13, 1)), time: t, pong: pong(t) };
      if (t < A(20, 2.5) + 0.2) return { scene: 'share', local: 3, time: t, pong: pong(t) };
      return null;
    };
    const v1Msg = t => {
      if (t < A(7, 1) - 0.3) return null;
      if (t < A(9, 1)) return { scene: 'arrive', local: 0.5 + Math.max(0, t - A(7, 1)) * 0.35, time: t, pong: pong(t) };
      if (t < A(9, 3)) return { scene: 'arrive', local: 2 + (t - A(9, 1)) * 0.5, time: t, pong: pong(t), flags: 'nobadge' };
      if (t < A(11, 1) + 0.12) return { scene: 'arrive', local: 1.6, time: t, pong: pong(t), flags: 'nobadge' };
      if (t < A(12, 1.5)) return null;
      if (t < A(13, 1) + 0.12) return { scene: 'voice', local: 2.5 + (t - A(12, 1.5)), time: t, speaker: t >= A(12, 4.5) ? 1 : null, pong: pong(t), flags: 'nobadge' };
      if (t < A(16, 1) - 0.3) return null;
      if (t < A(20, 2.5) + 0.2) return { scene: 'arrive', local: 1.2, time: t, pong: pong(t), flags: 'nobadge' };
      return null;
    };
    const v2Msg = t => (t >= A(7, 3) - 0.3 && t < A(9, 1) ? { scene: 'arrive', local: 0.5 + Math.max(0, t - A(7, 3)) * 0.35, time: t, pong: pong(t) } : null);
    // --- camera / card choreography (stage px) -----------------------------------------------------
    const CW = cH.W, CHh = cH.H;
    const centre = (sc, dy = 26) => ({ x: (1920 - CW * sc) / 2, y: (1080 - CHh * sc) / 2 + dy, s: sc });
    const F = (card, key, s2, sx, sy) => { const r = CL[key]; return card.focus(r[0] + (r[2] || 0) / 2, r[1] + (r[3] || 0) / 2, s2, sx, sy); };
    const mix = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), s: lerp(a.s, b.s, k) });
    const seg = (t, keys) => { // keys: [[t, state, ease]]
      if (t <= keys[0][0]) return keys[0][1];
      for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) {
        const [t0, a] = keys[i - 1], [t1, b, e] = keys[i];
        return mix(a, b, (E[e || 'io3'])((t - t0) / (t1 - t0)));
      }
      return keys[keys.length - 1][1];
    };
    const HOME = centre(0.98), START = cH.focus(CL.start[0], CL.start[1], 1.55, 960, 600), PICK = F(cH, 'picker', 1.32, 960, 610);
    const ROW = F(cH, 'copyrow', 1.3, 960, 620), CHAT = centre(1.0), SEND = cH.focus(CL.send[0] - 200, CL.send[1] - 120, 1.25, 1040, 640);
    const VOICE = F(cH, 'voice_panel', 1.32, 1130, 580), CTRL = F(cH, 'remote_panel', 1.28, 1130, 580), CTRLW = centre(1.0);
    const leftJ = { x: 40, y: 92 + 140, s: 0.6 }, r1 = { x: 1920 - 40 - CW * 0.62, y: 120, s: 0.62 }, r2 = { x: 1920 - 70 - CW * 0.6, y: 470, s: 0.6 };
    const V1CHAT = c1.focus(550, 330, 1.18, 960, 610), V1STAGE = F(c1, 'stage_viewer', 1.32, 960, 600), V1VOICE = F(c1, 'voice_panel_v', 1.32, 1130, 580);
    const SPL = { x: 40, y: 150, s: 0.79 }, SPR = { x: 1920 - 40 - CW * 0.79, y: 150, s: 0.79 };
    const XT = A(20, 2.5), leave = (st, t) => { const q = E.in2(prog(XT - 0.12, XT + 0.1, t)); return [{ ...st, y: st.y + q * 90, s: st.s * (1 - 0.06 * q) }, 1 - q]; };
    // Sliding card swap: the old card is pushed off to the left, the new one bounces in from the right
    const PUSH = 2300, inB = backOut(0.9), T1 = A(11, 1), T2 = A(12, 1.5), T3 = A(13, 1);
    const pushOut = (st, t, T0) => ({ ...st, x: st.x - PUSH * E.in3(prog(T0 - 0.14, T0 + 0.12, t)) });
    const pushIn = (st, t, T0) => ({ ...st, x: st.x + PUSH * (1 - inB(prog(T0, T0 + 0.5, t))) });
    const clickPts = [[A(3, 1), 'start'], [A(3, 3.5), 'thumb'], [A(5, 2.5), 'copy'], [A(6, 3), 'send'], [A(11, 2), 'voice_open'], [A(12, 3), 'voice_join'], [A(13, 4), 'switch'], [A(15, 3), 'allow']];
    ui.clickPts = clickPts;
    return t => {
      // host card
      let hs = null, ho = 1;
      if (t < A(5, 1)) {
        const drop = E.outBack(prog(0, 0.62, t));
        const INTRO = centre(0.8, 120);
        hs = seg(t, [[0, INTRO], [A(2, 1), INTRO], [A(2, 2), HOME], [A(3, 1) - 0.05, START, 'io3'], [A(3, 1.5), START], [A(3, 2), PICK, 'out3'], [A(3, 3.5), PICK], [A(4, 1), HOME, 'io3']]);
        if (t < 0.62) hs = { ...hs, y: lerp(-900, hs.y, drop) };

      } else if (t < A(7, 1)) hs = seg(t, [[A(5, 1), HOME], [A(5, 1.6), ROW, 'out3'], [A(5, 4) - 0.1, ROW], [A(5, 4) + 0.25, CHAT, 'io3'], [A(6, 2.5), CHAT], [A(6, 3), SEND, 'out3'], [A(6, 4.5), SEND]]);
      else if (t < A(9, 1)) hs = seg(t, [[A(7, 1), CHAT], [A(7, 1) + 0.45, leftJ, 'outExpo']]);
      else if (t < T1) { hs = leftJ; ho = 1 - prog(A(9, 1), A(9, 1) + 0.3, t); }
      else if (t < T2 + 0.12) hs = t < T2 - 0.14 ? pushIn(VOICE, t, T1) : pushOut(VOICE, t, T2);
      else if (t < T3) { hs = VOICE; ho = 0; }
      else if (t < A(16, 1)) hs = pushIn(seg(t, [[T3, CTRLW], [A(13, 3), CTRLW], [A(13, 3.8), CTRL, 'io3'], [A(15, 4.4), CTRL], [A(16, 1), centre(0.86), 'in3']]), t, T3);
      else if (t < XT + 0.2) { const sp = E.outBack(prog(A(16, 1), A(16, 1) + 0.5, t)); [hs, ho] = leave(mix(centre(0.86), SPL, sp), t); }
      else ho = 0;
      cH.set({ ...(hs || HOME), o: ho });
      // viewer 1
      let v1 = null, v1o = 0;
      if (t >= A(7, 1) && t < A(9, 1)) { const k = E.outBack(prog(A(7, 1), A(7, 1) + 0.5, t)); v1 = { ...r1, x: lerp(2000, r1.x, k) }; v1o = 1; }
      else if (t >= A(9, 1) && t < T1 + 0.12) { v1 = pushOut(seg(t, [[A(9, 1), r1], [A(9, 1) + 0.5, V1CHAT, 'io3'], [A(9, 3) - 0.1, V1CHAT], [A(9, 3) + 0.3, V1STAGE, 'io3']]), t, T1); v1o = 1; }
      else if (t >= T2 && t < T3 + 0.12) { v1 = t < T3 - 0.14 ? pushIn(V1VOICE, t, T2) : pushOut(V1VOICE, t, T3); v1o = 1; }
      else if (t >= A(16, 1) - 0.3 && t < XT + 0.2) { const sp = E.outBack(prog(A(16, 1), A(16, 1) + 0.5, t)); let o; [v1, o] = leave(mix(centre(0.86), SPR, sp), t); v1o = (t >= A(16, 1) ? 1 : 0) * o; }
      c1.set({ ...(v1 || r1), o: v1o });
      // viewer 2
      let v2o = 0, v2 = r2;
      if (t >= A(7, 3) && t < A(9, 1)) { const k = E.outBack(prog(A(7, 3), A(7, 3) + 0.5, t)); v2 = { ...r2, x: lerp(2100, r2.x, k) }; v2o = 1 - prog(A(9, 1) - 0.25, A(9, 1), t); }
      c2.set({ ...v2, o: v2o });
      // drive the three UIs (only while visible); the renderer awaits their repaints
      const jobs = [];
      // live playback drives the iframes at 30 Hz (cards, overlays and offline renders stay at full frame rate)
      const tu = LIVE ? Math.floor(t * 30 + 1e-6) / 30 : t;
      const hm = ho > 0.002 ? hostMsg(tu) : null, m1 = v1o > 0.002 ? v1Msg(tu) : null, m2 = v2o > 0.002 ? v2Msg(tu) : null;
      if (hm) jobs.push(H.render(hm));
      if (m1) jobs.push(V1.render(m1));
      if (m2) jobs.push(V2.render(m2));
      const live = jobs.filter(Boolean);
      return live.length ? Promise.all(live) : undefined;
    };
  }, 10);

  // ------------------------------------------------------------ overlays: rail, chips, stickers, keys, danmaku
  film.layer('over', root => {
    const rail = stepper(root, { labels: S.chapters, lang });
    const big = h('div', { class: 'abs' }, root);
    Object.assign(big.style, { left: '0', top: '62px', width: '1920px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '30px' });
    const bigMc = h('div', {}, big);
    Object.assign(bigMc.style, { width: '132px', height: '132px', borderRadius: '50%', background: D.yellow, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 6px 0 ${D.ink2}, inset 0 0 0 4px ${D.ink2}` });
    const bigM = mascot({ stroke: D.ink2, fill: D.paper, size: 96, sparkles: false });
    bigMc.appendChild(bigM.el);
    const bigT = h('div', {}, big);
    bigT.innerHTML = `<div style="font:900 ${lang === 'en' ? 104 : 112}px/1 ${fontFor(lang)};color:${D.ink2};letter-spacing:${lang === 'en' ? '-.02em' : '0'}">${S.meet}</div><div style="margin-top:12px;font:800 34px/1 ${fontFor(lang)};color:${D.ink};opacity:.7">${S.meetSub}</div>`;
    const C = (text, sub, iconName, color, o = {}) => chip(root, { text, sub, iconName, color, lang, ...o });
    const ch = {
      c1b: C(S.c1b, S.c1bSub, 'display', D.primary), c1c: C(S.c1c, S.c1cSub, 'cast', D.danger),
      c2a: C(S.c2a, '', 'link', D.primary), c2b: C(S.c2b, '', 'chat', D.live),
      c3a: C(S.c3a, S.c3aSub, 'link', D.primary), c3b: C(S.c3b, S.c3bSub, 'couch', D.yellow),
      c4a: C(S.c4a, '', 'chat', D.primary), c4b: C(S.c4b, '', 'danmaku', D.p3), c4c: C(S.c4c, '', 'smile', D.danger), c4d: C(S.c4d, '', 'smile', '#ff6b8b'),
      c5a: C(S.c5a, '', 'headphones', D.live), c5b: C(S.c5b, S.c5c, 'microphone', D.p2),
      c6a: C(S.c6a, '', 'mouse', D.primary), c6b: C(S.c6b, '', 'keyboard', D.p2), c6c: C(S.c6c, S.c6e, 'check', D.live), c6d: C(S.c6d, '', null, D.ink, { size: 0.78, dark: true }),
      c7a: C(S.c7a, '', 'keyboard', D.yellow), c7b: C(S.c7b, S.c7bSub, null, D.danger),
    };
    ch.c7b.el.firstChild.innerHTML = GLYPH.bolt;
    ch.c6d.el.firstChild.style.background = D.primary;
    ch.c6d.el.firstChild.innerHTML = GLYPH.shield.replace('width="42" height="42"', 'width="24" height="24"');
    const clicks = ui.clickPts.map(() => clickFx(root, { label: S.click, lang }));
    const kL = keycaps(root, { keys: ['W', 'S'], color: D.p1, label: S.keysL, lang });
    const kR = keycaps(root, { keys: ['↑', '↓'], color: D.p2, label: S.keysR, lang });
    // speech bubbles for the animalese lines
    const bub = (who, text, color) => {
      const el = h('div', { class: 'abs' }, root);
      Object.assign(el.style, { padding: '16px 26px', borderRadius: '30px 30px 30px 8px', background: D.paper, boxShadow: `0 4px 0 ${color}, 0 12px 26px rgba(36,53,78,.16), inset 0 0 0 3px ${color}`, font: `900 34px/1 ${fontFor(lang)}`, color: D.ink2, whiteSpace: 'nowrap', transformOrigin: '0% 100%' });
      el.innerHTML = `<span style="font:800 18px/1 ${fontFor(lang)};color:${color};display:block;margin-bottom:8px">${who}</span>${text}`;
      return { el, set: (t, t0, t1, p) => { const on = t >= t0 && t < t1; show(el, on); if (!on) return; const k = E.outBack(prog(t0, t0 + 0.25, t)), q = E.in3(prog(t1 - 0.15, t1, t)); T(el, { x: p.x, y: p.y, s: k * (1 - q * 0.2), o: 1 - q, ox: '0%', oy: '100%' }); } };
    };
    const L = cues.lines.map(l => l[lang] || l.zh);
    const b1 = bub(S.names.tuan, L[0], D.p1), b2 = bub(S.names.yuan, L[1], D.p2), b3 = bub(S.names.yuan, L[2], D.p2), b4 = bub(S.names.yuan, L[3], D.p2);
    // danmaku + tosses live in Yuan's UI overlay (UI px), so they ride the card's camera
    const stV = CLICKS[lang].stage_viewer;
    const dm = danmakuIn(ui.V1.over, { lines: S.danmaku, rect: stV, t0: A(9, 3), gap: 0.22, speed: 520, lang });
    const tx = stV[0] + stV[2] * 0.62, ty = stV[1] + stV[3] * 0.4;
    const tosses = [
      toss(ui.V1.over, { kind: 'tomato', from: [stV[0] + stV[2] * 0.2, stV[1] + stV[3] + 80], to: [tx, ty], t0: A(10, 1), dur: 0.25, size: 70, seed: 3 }),
      toss(ui.V1.over, { kind: 'poop', from: [stV[0] + stV[2] * 0.85, stV[1] + stV[3] + 80], to: [stV[0] + stV[2] * 0.35, stV[1] + stV[3] * 0.62], t0: A(10, 2), dur: 0.25, size: 64, seed: 4 }),
      ...[0, 1, 2, 3].map(i => toss(ui.V1.over, { kind: i % 2 ? 'star' : 'heart', from: [stV[0] + stV[2] * (0.3 + i * 0.12), stV[1] + stV[3] + 60], to: [stV[0] + stV[2] * (0.25 + i * 0.16), stV[1] + 40 + i * 30], t0: A(10, 3) + i * 0.08, dur: 0.45, size: 56, seed: 10 + i, life: 0.01 })),
    ];
    const at = (card, ux, uy, dx = 0, dy = 0) => { const p = card.toScreen(ux, uy); return { x: p.x + dx, y: p.y + dy }; };
    // the invite link travels from the host card to each friend (bars 7-8): a dotted wire that pops in dot by dot
    const NDOT = 18;
    const wires = [0, 1].map(() => {
      const g = h('div', { class: 'abs' }, root);
      const dots = Array.from({ length: NDOT }, () => {
        const d = h('div', { class: 'abs' }, g);
        Object.assign(d.style, { left: '-8px', top: '-8px', width: '16px', height: '16px', borderRadius: '50%', background: D.primary, boxShadow: '0 3px 0 rgba(36,53,78,.2)' });
        return d;
      });
      const head = h('div', { class: 'abs' }, g);
      Object.assign(head.style, { left: '-32px', top: '-32px', width: '64px', height: '64px', borderRadius: '50%', background: D.yellow, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 5px 0 ${D.ink2}, inset 0 0 0 4px ${D.ink2}` });
      head.appendChild(icon('link', { size: 34, color: D.ink2, sw: 2.6 }));
      return { g, dots, head };
    });
    const bez = (p0, p3, u) => {
      const dx = (p3.x - p0.x) * 0.5, p1 = { x: p0.x + dx, y: p0.y }, p2 = { x: p3.x - dx, y: p3.y }, v = 1 - u;
      return { x: v * v * v * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * p3.x, y: v * v * v * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u * u * u * p3.y };
    };
    const wireSet = (w, t, t0, t1, from, to) => {
      const on = t >= t0 && t < t1;
      show(w.g, on);
      if (!on) return;
      const k = E.out2(prog(t0, t0 + 0.42, t)), o = 1 - prog(t1 - 0.2, t1, t);
      O(w.g, o);
      w.dots.forEach((d, i) => {
        const u = (i + 0.5) / NDOT, p = bez(from, to, u), pop = E.outBack(clamp((k - u) / 0.12));
        T(d, { x: p.x, y: p.y, s: pop * 0.9 + 0.1 * pop * Math.max(0, Math.sin((t - t0) * 9 - i * 0.7)), o: pop > 0.01 ? 1 : 0 });
      });
      const hp = bez(from, to, k), land = prog(t0 + 0.42, t0 + 0.6, t);
      T(w.head, { x: hp.x, y: hp.y, s: (k > 0 ? 1 : 0) * (1 - 0.6 * E.in2(land)), o: 1 - land, r: (1 - k) * -30 });
    };
    return t => {
      // rail
      const idx = t < A(5, 1) ? 0 : t < A(7, 1) ? 1 : t < A(9, 1) ? 2 : t < A(11, 1) ? 3 : t < A(13, 1) ? 4 : t < A(16, 1) ? 5 : 6;
      const rp = E.outBack(prog(A(2, 1), A(2, 1) + 0.4, t)) * (1 - prog(A(20, 2.5) - 0.1, A(20, 2.5) + 0.2, t));
      rail.set(t, idx, clamp(rp));
      T(rail.el, { x: (1920 - (rail.el.offsetWidth || 1200)) / 2, y: 28 + (1 - clamp(rp)) * -40 });
      // intro title
      const bi = E.outBack(prog(A(1, 2), A(1, 2) + 0.4, t)), bo = E.in3(prog(A(2, 1) - 0.1, A(2, 1) + 0.2, t));
      show(big, t < A(2, 1) + 0.2);
      T(big, { y: (1 - bi) * -40 - bo * 160, s: lerp(0.8, 1, bi), o: Math.min(1, bi * 2) * (1 - bo), ox: '50%', oy: '50%' });
      bigM.set({ wink: t < A(1, 4) ? 1 : t < A(1, 4.5) ? 0 : 1, antenna: Math.sin(t * 8) * 8, spark: pulse(t, A(1, 4), A(2, 1), 0.05, 0.2) });
      const H = ui.cH, V1 = ui.c1, V2 = ui.c2;
      ch.c1b.set(t, A(3, 2), A(3, 4), { x: 1180, y: 190 });
      ch.c1c.set(t, A(4, 1), A(5, 1), at(H, 120, 150));
      ch.c2a.set(t, A(5, 3), A(5, 4.3), { x: 120, y: 880 });
      ch.c2b.set(t, A(6, 1), A(6, 4.5), at(H, 120, 470));
      ch.c3a.set(t, A(7, 1.5), A(8, 1), { x: 90, y: 160 });
      ch.c3b.set(t, A(8, 1), A(9, 1), at(V1, CL.couch_viewer[0] - 80, CL.couch_viewer[1] + CL.couch_viewer[3] + 60));
      ch.c4a.set(t, A(9, 1.5), A(9, 3), at(V1, 560, 60));
      ch.c4b.set(t, A(9, 3), A(10, 1), at(V1, stV[0], stV[1] - 50));
      ch.c4c.set(t, A(10, 1), A(10, 3), at(V1, stV[0], stV[1] - 50));
      ch.c4d.set(t, A(10, 3), A(11, 1), at(V1, stV[0], stV[1] - 50));
      ch.c5a.set(t, A(11, 2.5), A(12, 1.5), { x: 110, y: 880 });
      ch.c5b.set(t, A(12, 3.5), A(13, 1), { x: 110, y: 880 });
      ch.c6a.set(t, A(13, 4.5), A(14, 3), { x: 110, y: 860 });
      ch.c6b.set(t, A(14, 3.5), A(15, 3), { x: 110, y: 860 });
      ch.c6c.set(t, A(15, 3.5), A(16, 1), { x: 110, y: 830 });
      ch.c6d.set(t, A(15, 3.75), A(16, 1), { x: 110, y: 950 });
      ch.c7a.set(t, A(16, 3), A(17, 3), { cx: 960, y: 925 });
      ch.c7b.set(t, A(17, 3), A(19, 4), { cx: 960, y: 925 });
      // click stickers at the UI cursor tips
      ui.clickPts.forEach(([t0, key], i) => {
        const card = key === 'voice_join' ? V1 : H;
        clicks[i].set(t, t0, at(card, CL[key][0], CL[key][1]));
      });
      // keycaps (play chapter)
      const kOn = t >= A(16, 1) + 0.2 && t < A(20, 2.5) + 0.2;
      show(kL.el, kOn); show(kR.el, kOn);
      if (kOn) {
        const kin = E.outBack(prog(A(16, 1) + 0.2, A(16, 1) + 0.6, t)), kout = E.in3(prog(A(20, 2.5) - 0.1, A(20, 2.5) + 0.2, t));
        T(kL.el, { x: 60, y: 880 + (1 - kin) * 200 + kout * 200 });
        T(kR.el, { x: 1920 - 60 - (kR.el.offsetWidth || 460), y: 880 + (1 - kin) * 200 + kout * 200 });
        const press = hits => [0, 1].map(k => Math.max(0, ...hits.map((ht, j) => (j % 2 === k ? pulse(t, ht - 0.12, ht + 0.12, 0.05, 0.08) : 0))));
        kL.set(press(hitT.filter((_, i) => i % 2 === 0))); kR.set(press(hitT.filter((_, i) => i % 2 === 1)));
      }
      // both screens flash together on every hit: what Tuan sees, Yuan sees
      const flash = t >= A(16, 1) && t < A(20, 1) ? Math.max(0, ...hitT.map(ht => pulse(t, ht, ht + 0.18, 0.02, 0.16))) : 0;
      for (const c of [H, V1]) c.el.style.outline = flash > 0.02 ? `${(6 * flash).toFixed(1)}px solid ${D.yellow}` : 'none';
      // speech bubbles
      b1.set(t, A(11, 4), A(12, 1.5) - 0.12, { x: 330, y: 360 });
      b2.set(t, A(12, 4.5), A(13, 1) - 0.12, { x: 330, y: 360 });
      b3.set(t, A(14, 3.5), A(15, 2.5), at(H, 230, 300));
      b4.set(t, A(20, 1.25), A(20, 2.5), at(V1, 260, 96));
      dm(t);
      tosses.forEach(f => f(t));
      // invite wires: host's right edge -> each viewer's left edge (both ends ride their cards)
      wireSet(wires[0], t, A(7, 1) + 0.08, A(9, 1), at(H, 1100, 380, 14), at(V1, 0, 380, -14));
      wireSet(wires[1], t, A(7, 3) + 0.08, A(9, 1) - 0.2, at(H, 1100, 380, 14), at(V2, 0, 380, -14));
    };
  }, 20);

  // ------------------------------------------------------------ features
  film.scene('features', A(20, 1), A(24, 1), root => {
    const F = S.feat;
    const hero = tile(root, { title: F.hero, sub: F.heroSub, iconName: 'cast', w: 720, hgt: 640, lang, hero: true });
    const specs = [['bolt', null, D.danger], ['shield', null, D.live], ['leaf', null, '#3fb97a'], ['code', null, D.ink2], [null, 'couch', D.yellow], [null, 'link', D.primary]];
    const tiles = F.items.map(([a, b], i) => tile(root, { title: a, sub: b, glyph: specs[i][0] ? GLYPH[specs[i][0]] : null, iconName: specs[i][1], color: specs[i][2], w: 490, hgt: 230, lang }));
    const row = chip(root, { text: F.row, iconName: 'headphones', color: D.p3, lang, size: 1.05 });
    const times = [A(20, 3), A(21, 1), A(21, 3), A(22, 1), A(22, 3), A(23, 1)];
    const scr = h('div', { class: 'abs' }, hero.el);
    Object.assign(scr.style, { left: '92px', top: '316px', width: '536px', height: '302px', borderRadius: '22px', overflow: 'hidden', background: '#1b2638', boxShadow: `0 5px 0 ${D.ink2}, inset 0 0 0 4px ${D.ink2}` });
    const scrSvg = s('svg', { viewBox: '0 0 1600 900', width: 536, height: 302 }, scr);
    scrSvg.style.display = 'block';
    const replay = A(20, 1) - A(16, 1); // the rally again, live in the tile, on the same beats
    return (lt, t) => {
      scrSvg.innerHTML = pongSVG({ t: t - replay, lang });
      hero.set(t, A(20, 2.5) + 0.05, { x: 90, y: 150, r: -4 });
      tiles.forEach((tl, i) => tl.set(t, times[i], { x: 860 + (i % 2) * 520, y: 120 + Math.floor(i / 2) * 260, r: i % 2 ? 5 : -5 }));
      row.set(t, A(23, 3), A(24, 1) + 1, { x: 90, y: 900 });
      const out = E.in3(prog(A(24, 1) - 0.25, A(24, 1), t));
      T(root, { s: 1 - out * 0.08, o: 1 - out, ox: '50%', oy: '50%' });
    };
  }, 30);

  // ------------------------------------------------------------ end card
  film.scene('end', A(24, 1), 52, root => {
    root.style.background = D.wall;
    const dots = h('div', { class: 'fill' }, root);
    dots.style.background = `radial-gradient(circle, ${D.wall2} 2.2px, transparent 2.6px) 0 0 / 34px 34px`;
    const card = h('div', { class: 'abs' }, root);
    Object.assign(card.style, { left: '360px', top: '170px', width: '1200px', height: '660px', borderRadius: '48px', background: D.paper, boxShadow: `0 8px 0 rgba(36,53,78,.16), 0 30px 60px rgba(36,53,78,.14), inset 0 0 0 3px ${D.line}` });
    const mc = h('div', { class: 'abs' }, card);
    const m = mascot({ stroke: D.ink2, fill: D.yellow, size: 300 });
    mc.appendChild(m.el);
    T(mc, { x: 90, y: 120 });
    const wm = h('div', { class: 'abs', html: 'Piik<span style="color:#eaaa38">.</span>' }, card);
    Object.assign(wm.style, { left: '440px', top: '150px', font: '700 200px/1 Arial, "Helvetica Neue", sans-serif', letterSpacing: '-9px', color: D.ink2 });
    const tg = h('div', { class: 'abs', text: S.end }, card);
    Object.assign(tg.style, { left: '450px', top: '390px', font: `900 60px/1 ${fontFor(lang)}`, color: D.ink2, whiteSpace: 'nowrap' });
    const sub = h('div', { class: 'abs', text: S.endSub }, card);
    Object.assign(sub.style, { left: '452px', top: '480px', font: `700 28px/1 ${fontFor(lang)}`, color: D.ink, opacity: 0.7, whiteSpace: 'nowrap' });
    const url = h('div', { class: 'abs', text: S.url }, root);
    Object.assign(url.style, { left: '0', width: '1920px', textAlign: 'center', top: '880px', font: `900 40px/1 ${FONT_EN}`, color: D.ink2 });
    const fade = h('div', { class: 'fill' }, root);
    fade.style.background = '#000';
    return (lt, t) => {
      const k = E.outBack(prog(A(24, 1), A(24, 1) + 0.5, t));
      T(card, { y: (1 - k) * 120, s: lerp(0.85, 1, k), o: Math.min(1, k * 2), ox: '50%', oy: '50%' });
      const L0 = A(25, 1), tt = Math.max(0, t - L0);
      m.set({ wink: t < L0 + 0.1 ? 1 : t < L0 + 0.5 ? 0 : 1, spark: pulse(t, L0, L0 + 1.4, 0.08, 0.4), antenna: Math.sin(tt * 10) * 10 * Math.exp(-tt * 2), squash: 1 + (t >= L0 ? Math.exp(-tt * 6) * Math.sin(tt * 26) * 0.06 : 0) });
      T(wm, { x: (1 - E.outExpo(prog(A(24, 2), A(24, 2) + 0.4, t))) * 120, o: prog(A(24, 2), A(24, 2) + 0.15, t) });
      T(tg, { y: (1 - E.outExpo(prog(A(24, 3), A(24, 3) + 0.4, t))) * 30, o: prog(A(24, 3), A(24, 3) + 0.15, t) });
      T(sub, { o: prog(A(24, 4), A(24, 4) + 0.3, t) * 0.7 });
      T(url, { y: (1 - E.outBack(prog(A(25, 3), A(25, 3) + 0.3, t))) * 30, o: prog(A(25, 3), A(25, 3) + 0.15, t) });
      O(fade, Math.max(0, (t - 51.3) / 0.6));
    };
  }, 40);

  film.dispose = () => { for (const key of ['H', 'V1', 'V2']) ui[key]?.dispose(); };
  try { await Promise.all([ui.H.ready, ui.V1.ready, ui.V2.ready]); }
  catch (error) { film.dispose(); throw error; }
  return film;
}
