// Film G — 作战会议 / MISSION BRIEFING. Strategy (ii): the REAL Piik UI (frontend/ui demo build, driven frame by frame
// through its film-mode message API, three same-origin iframes) pinned as evidence photos on a phantom-thief board,
// wrapped in Film A's graphic collage language: ransom titles, comic click bursts, red string, cut-ins, stamps.
// 120 BPM (= the UI demo's own 0.5 s grid, so every real click lands on a beat or an 8th), 23 bars, 46 s, zh / en.
import { Film, clock, h, s, T, ST, O, prog, E, clamp, lerp, show, pulse, shake } from '../../engine/core.js';
import { C, CAST, mascot, reaction, halftone, rays, barcode } from '../../engine/art.js';
import { ransom } from '../../engine/type.js';
import { grainLayer, paperURL } from '../../engine/tex.js';
import { cutin, wipe, thrown } from '../A/kit.js';
import { realUI } from '../../engine/ui.js';
import { pongSVG, setRally, rallyFromTimes, P1C, P2C } from './pong.js';
import { STRINGS } from './strings.js';
import { G, MONO, HUD, HAND, WORDMARK, rot, board, photoCard, polaroid, redString, clickBurst, missionBanner, tracker, callout, dialog, stamp, keycaps, sofaArt, friendArt } from './kit.js';

const u = p => new URL(p, import.meta.url).href;
const F = (family, file, weight) => ({ family, file, ...(weight ? { weight } : {}) });
export const meta = {
  id: 'G', title: { zh: '作战会议', en: 'Mission Briefing' },
  size: [1920, 1080], duration: 46, fps: 60, poster: 27.6, langs: ['zh', 'en'],
  css: [u('../../engine/film.css'), u('./style.css')],
  fonts: [
    F('Noto Sans SC', 'NotoSansSC-Variable.ttf', '100 900'),
    F('Noto Serif SC', 'NotoSerifSC[wght].ttf', '200 900'),
    F('ZCOOL QingKe', 'ZCOOLQingKeHuangYou-Regular.ttf'),
    F('Smiley Sans', 'SmileySans-Oblique.ttf'),
    F('Anton', 'Anton.ttf'),
    F('Archivo Black', 'ArchivoBlack-Regular.ttf'),
    F('Abril Fatface', 'AbrilFatface-Regular.ttf'),
    F('Bodoni Moda', 'BodoniModa[opsz,wght].ttf', '400 900'),
    F('Rubik Mono One', 'RubikMonoOne-Regular.ttf'),
    F('Bebas Neue', 'BebasNeue-Regular.ttf'),
    F('Barlow Condensed', 'BarlowCondensed-SemiBold.ttf', '600'),
    F('Barlow Condensed', 'BarlowCondensed-ExtraBold.ttf', '800'),
    F('JetBrains Mono', 'JetBrainsMono[wght].ttf', '100 800'),
    F('Arimo', 'Arimo[wght].ttf', '400 700'),
    F('Nunito', 'Nunito[wght].ttf', '200 1000'),
  ],
  audio: { webm: u('../../out/G/audio/web.webm'), m4a: u('../../out/G/audio/web.m4a') },
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
  const S = STRINGS[lang] || STRINGS.zh, CL = CLICKS[lang] || CLICKS.zh, EN = lang === 'en';
  const film = new Film({ stage, width: 1920, height: 1080, duration: meta.duration, fps: meta.fps, lang, background: G.board });
  film.clock = K; film.S = S;
  stage.style.fontFamily = EN ? 'Anton, "Noto Sans SC", sans-serif' : '"Noto Sans SC", sans-serif';

  // ---------------------------------------------------------------- timeline (seconds, from the cue clock)
  const M = [A(3), A(5), A(7), A(9), A(11)];               // mission starts
  const CLEAR = [A(4, 4), A(6, 4.5), A(8, 4.5), A(10, 4.5), A(13, 4.5)];
  const VS = A(14), DONE = A(17), DOSSIER = A(18), END = A(21);
  const hitT = [A(14, 3), A(15, 1), A(15, 3), A(16, 1), A(16, 2), A(16, 3)];
  setRally({ join: VS, serve: A(14, 3), hits: rallyFromTimes(hitT), missY: 70, missDur: 0.5, out: DONE, label: { [lang]: S.pong } });
  const thumbSrc = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">${pongSVG({ t: 0, lang })}</svg>`);

  // ---------------------------------------------------------------- the board (world space)
  // world poses: host app photo left, the friends' browser photos right, the target sofa top, the plan note far left
  const P = {
    host: { cx: 1250, cy: 1320, r: -2.5, s: 1 },
    v1: { cx: 2850, cy: 790, r: 3, s: 1 },
    v2: { cx: 2930, cy: 1880, r: -2.5, s: 1 },
    v1vs: { cx: 2470, cy: 1300, r: 2, s: 1 },
    target: { cx: 2050, cy: 330, r: 3, s: 1 },
    yuan: { cx: 3440, cy: 430, r: 7, s: 1 },
    dian: { cx: 3520, cy: 1540, r: -6, s: 1 },
    plan: { cx: 360, cy: 640, r: -4, s: 1 },
  };
  const ui = {};
  const world = {};
  // card geometry is fixed (UI 1100×740 + chrome); the camera maths below needs it before the cards exist
  const CARD = { app: { W: 1136, H: 818, PAD: 18, BAR: 46 }, browser: { W: 1136, H: 828, PAD: 18, BAR: 56 } };
  const uiW = (pose, cd, ux, uy) => { const v = rot((cd.PAD + ux - cd.W / 2) * pose.s, (cd.BAR + uy - cd.H / 2) * pose.s, pose.r); return { x: pose.cx + v.x, y: pose.cy + v.y }; };
  const locW = (pose, w, hh, lx, ly) => { const v = rot((lx - w / 2) * pose.s, (ly - hh / 2) * pose.s, pose.r); return { x: pose.cx + v.x, y: pose.cy + v.y }; };
  /** Camera that puts UI point (ux, uy) of a card at screen (sx, sy) with zoom z; the photo appears tilted by `tilt`. */
  const camOn = (pose, cd, ux, uy, z, sx = 960, sy = 560, tilt = 0) => {
    const p = uiW(pose, cd, ux, uy), r = -pose.r + tilt, v = rot((sx - 960) / z, (sy - 540) / z, -r);
    return { fx: p.x - v.x, fy: p.y - v.y, z, r };
  };
  // pins (world px) and the invite flight: two calling cards ride the new strings from the host's photo to each friend
  const PIN = {
    host: locW(P.host, 1136, 818, 568, 4), target: locW(P.target, 560, 500, 280, 2),
    yuan: locW(P.yuan, 440, 420, 220, 2), dian: locW(P.dian, 440, 420, 220, 2), plan: locW(P.plan, 560, 700, 280, 4),
  };
  const SAG = { plan: 160, goal: 120, y: 220, d: 260, v1: 140, v2: 180 };
  /** Point at parameter u on the sagging string p0 -> p1 (same curve redString() draws). */
  const qPoint = (p0, p1, u, sag) => { const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2 + sag, v = 1 - u; return { x: v * v * p0.x + 2 * v * u * cx + u * u * p1.x, y: v * v * p0.y + 2 * v * u * cy + u * u * p1.y }; };
  const FLY = { y: [A(6, 3), A(6, 4.3)], d: [A(6, 3.4), A(6, 4.7)] };
  const flyK = (k, t) => E.io2(prog(FLY[k][0], FLY[k][1], t));
  const flyAt = (k, t) => qPoint(PIN.host, PIN[k === 'y' ? 'yuan' : 'dian'], flyK(k, t), SAG[k]);
  const at = (k, i) => [CL[k][0] + (CL[k][2] || 0) * (i ?? 0.5), CL[k][1] + (CL[k][3] || 0) * (i ?? 0.5)];
  const HC = CARD.app, VC = CARD.browser, ctr = (k) => at(k);
  const SHOT = {
    over: { fx: 1910, fy: 940, z: 0.49, r: -1.5 },
    open: { fx: 1900, fy: 950, z: 0.64, r: -7 },
    code: { fx: 2000, fy: 960, z: 0.53, r: -3 },
    hStart: camOn(P.host, HC, ...at('start', 0), 1.32, 1070, 600, -1.5),
    hPick: camOn(P.host, HC, 542, 410, 1.26, 1010, 610, -1.5),
    hFull: camOn(P.host, HC, 560, 370, 0.84, 1000, 590, -1.5),
    hRow: camOn(P.host, HC, 430, 540, 1.28, 1010, 620, -1.5),
    hChat: camOn(P.host, HC, 560, 380, 0.92, 990, 600, -1.5),
    hSend: camOn(P.host, HC, 860, 620, 1.18, 1060, 640, -1.5),
    // follows the two flying calling cards
    follow: t => { const a = flyAt('y', t), b = flyAt('d', t); return { fx: (a.x + b.x) / 2 + 60, fy: (a.y + b.y) / 2 + 40, z: 0.6, r: -2 }; },
    v12: { fx: 2900, fy: 1330, z: 0.52, r: 1 },
    target: { fx: 2070, fy: 360, z: 1.18, r: -2 },
    v1Chat: camOn(P.v1, VC, 640, 320, 1.04, 960, 590, 1),
    v1Stage: camOn(P.v1, VC, ...ctr('stage_viewer'), 1.24, 960, 520, 1),
    v1Voice: camOn(P.v1, VC, 770, 330, 1.18, 1010, 590, 1),
    hCtrl: camOn(P.host, HC, ...ctr('remote_panel'), 1.24, 1110, 640, -1.5),
    hConsent: camOn(P.host, HC, ...ctr('consent'), 1.62, 1000, 560, -1.5),
    hCtrlW: camOn(P.host, HC, 600, 360, 0.95, 980, 580, -1.5),
    vs: { fx: 1860, fy: 1330, z: 0.765, r: 0 },
    vs2: { fx: 1900, fy: 1300, z: 0.83, r: -1.5 },
    done: { fx: 1930, fy: 1190, z: 0.45, r: -2 },
  };
  const WIPE = 0.14; // shutter-wipe half time: cuts happen while the bars cover the frame
  const mix = (a, b, k) => ({ fx: lerp(a.fx, b.fx, k), fy: lerp(a.fy, b.fy, k), z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), k)), r: lerp(a.r, b.r, k) });
  const seg = (t, keys) => { // [[t, shot, ease]]: hold between keys, ease into each key; a shot may be a function of t
    const v = x => (typeof x === 'function' ? x(t) : x);
    if (t <= keys[0][0]) return v(keys[0][1]);
    for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) {
      const [t0, a] = keys[i - 1], [t1, b, e] = keys[i];
      return mix(v(a), v(b), (E[e || 'io3'])((t - t0) / (t1 - t0)));
    }
    return v(keys[keys.length - 1][1]);
  };
  const CAM = [
    [0, SHOT.open], [0.45, SHOT.open], [2.0, SHOT.over, 'out3'], [3.95, SHOT.code, 'io2'],
    [A(3) + WIPE, SHOT.hStart, 'hold'], [A(3, 2.25), SHOT.hStart], [A(3, 2.8), SHOT.hPick, 'out3'], [A(3, 4.9), SHOT.hPick], [A(4, 1.6), SHOT.hFull, 'out3'],
    [A(4, 4.4), SHOT.hFull], [A(5, 1.6), SHOT.hRow, 'io3'], [A(5, 3.4), SHOT.hRow], [A(5, 4.1), SHOT.hChat, 'io3'], [A(6, 1.8), SHOT.hChat], [A(6, 2.4), SHOT.hSend, 'out3'],
    [A(6, 2.9), SHOT.hSend], [A(6, 3.5), SHOT.follow, 'io3'], [A(6, 4.8), SHOT.follow], [A(7, 1.4), SHOT.v12, 'io3'],
    [A(8), SHOT.v12], [A(8, 1.8), SHOT.target, 'io3'], [A(9), SHOT.target],
    [A(9) + WIPE, SHOT.v1Chat, 'hold'], [A(9, 2.8), SHOT.v1Chat], [A(9, 3.3), SHOT.v1Stage, 'out3'], [A(10, 2.4), SHOT.v1Stage], [A(10, 3.0), SHOT.v1Voice, 'out3'],
    [A(11), SHOT.v1Voice], [A(11) + WIPE, SHOT.hCtrl, 'hold'], [A(12, 2.8), SHOT.hCtrl], [A(12, 3.4), SHOT.hConsent, 'out3'], [A(13, 1.6), SHOT.hConsent], [A(13, 2.6), SHOT.hCtrlW, 'io3'],
    [A(13, 3), SHOT.hCtrlW], [A(14), SHOT.vs, 'io3'], [DONE, SHOT.vs2, 'io2'], [DONE + 1.1, SHOT.done, 'out3'],
  ];
  // shakes on the big hits (screen px)
  const SHAKES = [[A(13), 0.35, 14], [VS, 0.4, 22], [A(16, 3), 0.3, 12], [DONE, 0.5, 26]];
  const camAt = t => {
    const c = seg(t, CAM);
    const push = t >= VS && t < DONE ? 1 + 0.025 * Math.max(0, ...hitT.map(ht => pulse(t, ht, ht + 0.3, 0.02, 0.26))) : 1;
    let sx = 0, sy = 0, sr = 0;
    for (const [t0, d, a] of SHAKES) { const q = shake(t, t0, d, a, 34, Math.round(t0 * 10)); sx += q.x; sy += q.y; sr += q.r; }
    return { ...c, z: c.z * push, sx, sy, r: c.r + sr };
  };
  const toScreen = (p, c) => { const v = rot((p.x - c.fx) * c.z, (p.y - c.fy) * c.z, c.r); return { x: 960 + v.x + c.sx, y: 540 + v.y + c.sy }; };

  // card poses over time (the friends' photos slam onto the board in mission 03; Yuan's slides beside the host for VS)
  const slam = (base, t0, t) => {
    const k = prog(t0, t0 + 0.22, t), b = E.outBack(k);
    return { ...base, s: lerp(1.5, 1, b), r: base.r + (1 - b) * 9, o: t >= t0 ? Math.min(1, k * 4) : 0 };
  };
  const poseOf = {
    host: () => ({ ...P.host, o: 1 }),
    v1: t => t < A(13, 3) ? slam(P.v1, M[2], t) : (() => { const k = E.io3(prog(A(13, 3), A(14), t)); return { cx: lerp(P.v1.cx, P.v1vs.cx, k), cy: lerp(P.v1.cy, P.v1vs.cy, k), r: lerp(P.v1.r, P.v1vs.r, k), s: 1, o: 1 }; })(),
    v2: t => { const p = slam(P.v2, A(7, 3), t), away = E.io3(prog(A(13, 3), A(14), t)) * (1 - E.io3(prog(DONE, DONE + 0.8, t))); return { ...p, cx: p.cx + away * 700, cy: p.cy + away * 420 }; },
  };

  film.layer('world', root => {
    const cam = h('div', { class: 'abs' }, root);
    cam.style.transformOrigin = '0 0';
    board(cam, { lang });
    // VS slabs (world space, under the photos)
    const slabs = h('div', { class: 'abs' }, cam);
    const slabL = h('div', { class: 'abs' }, slabs), slabR = h('div', { class: 'abs' }, slabs);
    Object.assign(slabL.style, { left: '-600px', top: '500px', width: '2560px', height: '1700px', background: `${halftone('rgba(0,0,0,.16)', 22, 28)}, ${C.greenD}`, transformOrigin: '100% 50%' });
    Object.assign(slabR.style, { left: '1860px', top: '500px', width: '2560px', height: '1700px', background: `${halftone('rgba(0,0,0,.16)', 22, 28)}, ${C.blueD}`, transformOrigin: '0% 50%' });
    // strings (one world-space svg above the board, under every photo: they tuck under the pinned edges)
    const strSvg = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, cam);
    const STR = ['plan', 'goal', 'y', 'd', 'v1', 'v2'].reduce((o, k) => ({ ...o, [k]: redString(strSvg) }), {});
    // the plan note
    const note = h('div', { class: 'abs' }, cam);
    const NW = 560, NH = 700;
    Object.assign(note.style, { width: NW + 'px', height: NH + 'px', background: `url(${paperURL()}), ${G.cream}`, boxShadow: `0 0 0 6px ${C.ink2}, 16px 20px 0 6px rgba(0,0,0,.6)`, transformOrigin: '50% 50%' });
    const nt = h('div', { class: 'abs nowrap', text: EN ? 'THE PLAN' : '作战计划' }, note);
    Object.assign(nt.style, { left: '40px', top: '40px', font: `400 ${EN ? 76 : 80}px/1 ${HAND}`, color: C.ink2 });
    const strikes = S.missions.map((m, i) => {
      const row = h('div', { class: 'abs nowrap' }, note);
      Object.assign(row.style, { left: '44px', top: 170 + i * 98 + 'px', font: `400 ${EN ? 46 : 52}px/1 ${HAND}`, color: C.ink });
      row.innerHTML = `<span style="color:${G.red2};margin-right:14px">0${i + 1}</span>${EN ? m.title.join(' ') : m.title.join('')}`;
      const ln = h('div', { class: 'abs' }, row);
      Object.assign(ln.style, { left: '-6px', top: '26px', height: '9px', width: '0px', background: G.red, borderRadius: '4px', transform: 'rotate(-2deg)' });
      return ln;
    });
    const pinN = h('div', { class: 'abs' }, note);
    pinN.innerHTML = `<svg width="68" height="68" viewBox="-20 -20 40 40" style="position:absolute;left:${NW / 2 - 34}px;top:-30px;overflow:visible"><ellipse cx="5" cy="8" rx="13" ry="9" fill="#000" opacity=".45"/><circle r="12" fill="${G.red}" stroke="${C.ink2}" stroke-width="2.5"/><circle cx="-4" cy="-4" r="4" fill="#fff" opacity=".75"/></svg>`;
    T(note, { x: P.plan.cx - NW / 2, y: P.plan.cy - NH / 2, r: P.plan.r });
    // the target and the friends' polaroids
    const tgt = polaroid(cam, { w: 560, hgt: 500, caption: S.target, sub: S.targetTag, lang, art: (sv, w, hh) => sofaArt(sv, w, hh) });
    tgt.set(P.target);
    const pY = polaroid(cam, { w: 440, hgt: 420, caption: S.friends.yuan[0], sub: S.friends.yuan[1], lang, art: (sv, w, hh) => friendArt(sv, w, hh, { who: 'yuan', place: 'bed' }) });
    const pD = polaroid(cam, { w: 440, hgt: 420, caption: S.friends.dian[0], sub: S.friends.dian[1], lang, art: (sv, w, hh) => friendArt(sv, w, hh, { who: 'dian', place: 'metro' }) });
    pY.set(P.yuan); pD.set(P.dian);
    // the real UI photos
    const H = realUI(cam, { lang, signal, pongSVG, name: 'host' }), V1 = realUI(cam, { lang, signal, pongSVG, name: 'yuan' }), V2 = realUI(cam, { lang, signal, pongSVG, name: 'dian' });
    ui.H = H; ui.V1 = V1; ui.V2 = V2;
    const cH = photoCard(cam, H, { kind: 'app', title: S.host, tag: EN ? 'EVIDENCE 01 · HOST' : 'EVIDENCE 01 · 房主', lang });
    const c2 = photoCard(cam, V2, { kind: 'browser', title: S.viewer2, addr: S.addr, tag: `EVIDENCE 03 · ${S.names.dian}`, lang });
    const c1 = photoCard(cam, V1, { kind: 'browser', title: S.viewer1, addr: S.addr, tag: `EVIDENCE 02 · ${S.names.yuan}`, lang });
    world.cH = cH; world.c1 = c1; world.c2 = c2; world.tgt = tgt;
    // a red marker box around the UI's own consent sentence (card space, UI px)
    const cn = CL.consent_note, mk = s('svg', { width: 10, height: 10, style: 'position:absolute;left:0;top:0;overflow:visible' }, cH.fx);
    const bx0 = cn[0] - 14, by0 = cn[1] - 9, bx1 = cn[0] + cn[2] + 12, by1 = cn[1] + cn[3] + 9;
    const mkPath = s('path', { d: `M${bx0 + 10} ${by0 + 3}L${bx1} ${by0 - 4}L${bx1 + 5} ${by1}L${bx0 - 3} ${by1 + 4}L${bx0 + 2} ${by0 - 6}L${bx0 + 60} ${by0 - 8}`, fill: 'none', stroke: G.red, 'stroke-width': 6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': 1200, 'stroke-dashoffset': 1200 }, mk);
    // the calling card that travels along the invite strings
    const mkFlyer = () => { const flyer = h('div', { class: 'abs' }, cam);
    Object.assign(flyer.style, { width: '190px', height: '250px', background: G.cream, border: `8px solid ${C.ink2}`, boxShadow: `10px 12px 0 ${G.red}`, transformOrigin: '50% 50%' });
    flyer.innerHTML = `<div style="position:absolute;left:0;top:0;right:0;padding:10px 12px;background:${C.ink2};color:${G.cream};font:600 17px/1 ${HUD};letter-spacing:.16em">${EN ? 'CALLING CARD' : '预告状'}</div>`
      + `<div style="position:absolute;left:14px;top:56px;font:${EN ? '400 46px/1.02 Anton' : "900 46px/1.1 'Noto Sans SC'"};color:${C.ink2}">${S.card.l1}<br><span style="background:${G.yellow};padding:0 4px">${S.card.l2}</span></div>`
      + `<div style="position:absolute;right:12px;bottom:10px;font:400 30px/1 ${HAND};color:${G.red2}">${S.card.sign}</div>`;
    return flyer; };
    const flyers = { y: mkFlyer(), d: mkFlyer() };
    const linkTag = h('div', { class: 'abs nowrap', text: S.link }, cam);
    Object.assign(linkTag.style, { padding: '12px 20px', background: G.yellow, color: C.ink2, border: `5px solid ${C.ink2}`, font: `700 34px/1 ${MONO}`, boxShadow: `8px 8px 0 ${C.ink2}`, transformOrigin: '50% 50%' });
    // card-space stamps that live on the photos (they move with the camera)
    const pinOf = (pose, cd) => locW(pose, cd.W, cd.H, cd.W / 2, 4);

    // UI messages per instance (only sent while the card is on screen; offline renders await the repaint)
    const pong = t => ({ t, lang });
    const thumb = { key: 'piik-' + lang, src: thumbSrc };
    const hostMsg = t => {
      if (t < M[0] - 0.1) return { scene: 'share', local: 0.1, time: t, pong: pong(t), thumb };
      if (t < M[1] - 0.25) return { scene: 'share', local: clamp(t - (M[0] - 0.25), 0.1, 3.5), time: t, pong: pong(t), thumb };
      if (t < M[2]) return { scene: 'invite', local: clamp(t - (M[1] - 0.25), 0.05, 3.85), time: t, pong: pong(t) };
      if (t < M[4] - 0.5) return { scene: 'share', local: 3, time: t, pong: pong(t) };
      if (t < A(13, 3) + 0.2) return { scene: 'control', local: clamp(t - (M[4] - 1), 0.25, 6.2), time: t, pong: pong(t) };
      return { scene: 'share', local: 3, time: t, pong: pong(t) };
    };
    const v1Msg = t => {
      if (t < M[2] - 0.1) return null;
      if (t < M[3]) return { scene: 'arrive', local: clamp(0.3 + (t - M[2]) * 0.6, 0.3, 1.6), time: t, pong: pong(t), flags: 'nobadge' };
      if (t < A(9, 3)) return { scene: 'arrive', local: 2.0 + (t - M[3]) * 0.4, time: t, pong: pong(t), flags: 'nobadge' };
      if (t < A(10, 2.5)) return { scene: 'arrive', local: 1.6, time: t, pong: pong(t), flags: 'nobadge' };
      if (t < M[4]) return { scene: 'voice', local: 2.5 + (t - A(10, 2.5)), time: t, speaker: t >= A(10, 4.5) ? 1 : null, pong: pong(t), flags: 'nobadge' };
      return { scene: 'arrive', local: 1.2, time: t, pong: pong(t), flags: 'nobadge' };
    };
    const v2Msg = t => (t < A(7, 3) - 0.1 ? null : { scene: 'arrive', local: clamp(0.3 + (t - A(7, 3)) * 0.6, 0.3, 1.6), time: t, pong: pong(t), flags: 'nobadge' });
    const onScreen = (pose, cd, c) => {
      if (!(pose.o > 0.002)) return false;
      const pts = [[0, 0], [cd.W, 0], [0, cd.H], [cd.W, cd.H]].map(([x, y]) => toScreen(locW(pose, cd.W, cd.H, x, y), c));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return Math.max(...xs) > -40 && Math.min(...xs) < 1960 && Math.max(...ys) > -40 && Math.min(...ys) < 1120;
    };
    const flash = t => (t >= VS && t < DONE ? Math.max(0, ...hitT.map(ht => pulse(t, ht, ht + 0.18, 0.02, 0.16))) : 0);
    world.onScreen = onScreen;

    return t => {
      const c = camAt(t);
      cam.style.transform = `translate(${(960 + c.sx).toFixed(2)}px, ${(540 + c.sy).toFixed(2)}px) rotate(${c.r.toFixed(3)}deg) scale(${c.z.toFixed(4)}) translate(${(-c.fx).toFixed(2)}px, ${(-c.fy).toFixed(2)}px)`;
      // VS slabs slide in from both sides
      const vk = E.outExpo(prog(VS, VS + 0.3, t)) * (1 - E.in3(prog(DONE + 0.3, DONE + 0.8, t)));
      show(slabs, vk > 0.002);
      if (vk > 0.002) { T(slabL, { x: (1 - vk) * -2600, skx: -12 }); T(slabR, { x: (1 - vk) * 2600, skx: -12 }); }
      // plan note strikes follow the cleared missions
      strikes.forEach((ln, i) => { ln.style.width = (E.out3(prog(CLEAR[i] + 0.05, CLEAR[i] + 0.35, t)) * (EN ? 430 : 400)).toFixed(1) + 'px'; });
      // the target sofa fills: Tuan once he's live, then Yuan and Dian arrive in mission 03
      const seats = tgt.parts.seats, sit = [A(4), A(8, 1.5), A(8, 2)];
      seats.forEach((st, i) => {
        const q = t - sit[i], on = q >= 0;
        const drop = on ? E.outBounce(clamp(q / 0.35)) : 0;
        const happy = t >= DONE ? 'happy' : i === 0 ? 'lid' : 'open';
        st.p.set({ x: st.x, y: st.y - (1 - drop) * 220, s: st.s, sq: on ? 1 + Math.exp(-q * 9) * Math.sin(q * 40) * 0.12 : 1, o: on ? 1 : 0, eyes: happy, lid: 0.45, bob: t >= DONE ? Math.abs(Math.sin((t - DONE) * 9)) * -4 : 0 });
      });
      tgt.parts.ring.setAttribute('opacity', (0.95 * (1 - prog(A(8, 2), A(8, 3), t))).toFixed(3));
      // photos
      const ph = poseOf.host(), p1 = poseOf.v1(t), p2 = poseOf.v2(t);
      cH.set(ph); c1.set(p1); c2.set(p2);
      const fl = flash(t);
      for (const cd of [cH, c1]) cd.el.style.outline = fl > 0.02 ? `${(16 * fl).toFixed(1)}px solid ${G.yellow}` : 'none';
      const mkOn = t >= A(12, 3) && t < A(13) - 0.02;
      show(mk, mkOn);
      if (mkOn) mkPath.setAttribute('stroke-dashoffset', (1200 * (1 - E.out2(prog(A(12, 3.2), A(12, 3.9), t)))).toFixed(1));
      // strings (Yuan's and Dian's grow with the calling cards that carry the invite)
      const hp = PIN.host;
      STR.plan.set(PIN.plan, hp, { k: E.out2(prog(0.5, 1.1, t)), sag: SAG.plan });
      STR.goal.set(hp, PIN.target, { k: E.out2(prog(0.7, 1.3, t)), sag: SAG.goal, glow: t >= DONE ? 1 : 0 });
      STR.y.set(hp, PIN.yuan, { k: flyK('y', t), sag: SAG.y });
      STR.d.set(hp, PIN.dian, { k: flyK('d', t), sag: SAG.d });
      STR.v1.set(pinOf(p1, VC), PIN.target, { k: E.out2(prog(A(8), A(8, 1.6), t)), sag: SAG.v1, o: t < A(13, 3) ? 1 : 1 - prog(A(13, 3), A(13, 4), t), glow: t >= DONE ? 1 : 0 });
      STR.v2.set(pinOf(p2, VC), PIN.target, { k: E.out2(prog(A(8, 1.4), A(8, 2.2), t)), sag: SAG.v2, o: t < A(13, 3) ? 1 : t < DONE ? 0 : prog(DONE + 0.4, DONE + 0.8, t), glow: t >= DONE ? 1 : 0 });
      // the two calling cards: pop off the host photo, ride the strings, land on the friends' polaroids
      for (const k of ['y', 'd']) {
        const [f0, f1] = FLY[k], fl = flyers[k], on = t >= f0 && t < f1 + 0.35;
        show(fl, on);
        if (!on) continue;
        const p = flyAt(k, t), pop = E.outBack(prog(f0, f0 + 0.18, t)), land = E.in3(prog(f1, f1 + 0.35, t));
        T(fl, { x: p.x - 95, y: p.y - 125, r: (k === 'y' ? -12 : 10) + Math.sin(t * 13) * 7, s: lerp(0.2, 1.7, pop) * (1 - land * 0.85), o: 1 - land });
      }
      const lt = t >= A(6, 4) && t < A(7, 3);
      show(linkTag, lt);
      if (lt) { const m = qPoint(hp, PIN.yuan, 0.45, SAG.y); T(linkTag, { x: m.x - 190, y: m.y + 20, r: -6, s: 1.5 * E.outBack(prog(A(6, 4), A(6, 4.3), t)) }); }
      // drive the three UIs (only while on screen); the renderer awaits their repaints
      const tu = LIVE ? Math.floor(t * 30 + 1e-6) / 30 : t;
      const jobs = [];
      if (t >= DOSSIER + 0.5) return undefined;
      if (onScreen(ph, HC, c)) jobs.push(H.render(hostMsg(tu)));
      const m1 = onScreen(p1, VC, c) ? v1Msg(tu) : null, m2 = onScreen(p2, VC, c) ? v2Msg(tu) : null;
      if (m1) jobs.push(V1.render(m1));
      if (m2) jobs.push(V2.render(m2));
      const live = jobs.filter(Boolean);
      return live.length ? Promise.all(live) : undefined;
    };
  }, 10);

  // ---------------------------------------------------------------- overlays (screen space)
  film.layer('over', root => {
    const SCR = (cd, pose, ux, uy, c) => toScreen(uiW(pose, cd, ux, uy), c);
    // cold open: microtype + a red string drawn across the black
    const secret = h('div', { class: 'abs nowrap' }, root);
    Object.assign(secret.style, { left: '70px', top: '56px', font: `700 30px/1 ${MONO}`, color: G.cream, letterSpacing: '.12em' });
    const blk = h('div', { class: 'fill' }, root);
    blk.style.background = '#000';
    const coldSv = s('svg', { width: 1920, height: 1080, style: 'position:absolute;left:0;top:0' }, root);
    const coldStr = s('path', { d: 'M-40 760 Q960 560 1960 300', fill: 'none', stroke: G.red, 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-dasharray': 2400, 'stroke-dashoffset': 2400 }, coldSv);
    // codename block
    const code = h('div', { class: 'abs' }, root);
    const codeBand = h('div', { class: 'abs' }, code);
    Object.assign(codeBand.style, { left: '-160px', top: '250px', width: '1760px', height: '470px', background: C.ink2, transform: 'skewX(-14deg)', boxShadow: `22px 22px 0 ${G.red}`, borderBottom: `8px solid ${G.cream}` });
    const codeTag = h('div', { class: 'abs nowrap', text: S.codeTag }, code);
    Object.assign(codeTag.style, { left: '150px', top: '282px', font: '400 44px/1 Anton', letterSpacing: '.1em', color: G.red });
    const codeR = ransom(code, S.codename, { size: EN ? 160 : 190, seed: 21, tilt: 6, punctColor: G.cream });
    T(codeR.el, { x: 140, y: 360 });
    const codeSub = h('div', { class: 'abs nowrap', text: S.codeSub }, code);
    Object.assign(codeSub.style, { left: '150px', top: EN ? '586px' : '612px', padding: '10px 22px 12px', background: G.cream, color: C.ink2, font: EN ? '400 52px/1 Anton' : '900 56px/1 "Noto Sans SC"', letterSpacing: EN ? '.03em' : '0', boxShadow: `10px 10px 0 ${G.red}` });
    const dim = h('div', { class: 'fill' }, root);
    dim.style.background = 'rgba(0,0,0,.45)';
    // mission banners + tracker
    const banners = S.missions.map((m, i) => missionBanner(root, { no: m.no, sub: m.en, title: m.title, lang, seed: 31 + i * 7 }));
    const trk = tracker(root, { items: S.missions.map(m => m.short), lang });
    // click bursts at the UI's own cursor tips
    const CLK = [
      { t: A(3, 2), card: 'H', key: 'start' }, { t: A(3, 4.5), card: 'H', key: 'thumb' },
      { t: A(5, 2), card: 'H', key: 'copy' }, { t: A(6, 2.5), card: 'H', key: 'send' },
      { t: A(10, 4), card: 'V1', key: 'voice_join' }, { t: A(11, 2), card: 'H', key: 'switch' },
      { t: A(13), card: 'H', key: 'allow', big: true },
    ];
    const bursts = CLK.map((k, i) => clickBurst(root, { text: k.big ? S.allowClick : S.click, lang, seed: 5 + i, size: k.big ? 1.35 : 1 }));
    const smash = clickBurst(root, { text: S.smash, lang, seed: 17, size: 1.6 });
    // callouts: [t0, t1, main/sub, card, anchor key or [ux,uy], box offset from anchor]
    const CO = [
      [A(3, 2.5), A(3, 4.4), S.c_sources, 'H', at('tabs'), [-430, 330]],
      [A(5, 2.2), A(5, 3.6), S.c_copy, 'H', at('copy', 0), [-60, -250]],
      [A(5, 4.6), A(6, 2.3), S.c_chat, 'H', at('draft'), [-420, -230]],
      [A(9, 1.5), A(9, 2.9), S.c_text, 'V1', at('chatpanel'), [-700, -60]],
      [A(9, 3.1), A(9, 4.4), S.c_danmaku, 'V1', [300, 300], [-520, 330]],
      [A(9, 4.5), A(10, 2), S.c_toss, 'V1', [520, 330], [-560, 200]],
      [A(10, 4.1), A(11), S.c_voice, 'V1', at('voice_join', 0), [-560, -200]],
      [A(11, 2.3), A(12, 0.9), S.c_switch, 'H', at('switch', 0), [-680, 80]],
      [A(12, 3.3), A(13, 0.9), S.c_consent, 'H', at('consent_note', 0), [-780, 150]],
    ].map(([t0, t1, [main, sub], card, anc, off]) => ({ t0, t1, card, anc, off, el: callout(root, { main, sub, lang }) }));
    // stamps on the photos
    const ST1 = stamp(root, { main: S.live[0], sub: S.live[1], size: 92, rot: -8, lang, plate: G.cream });
    const ST2 = stamp(root, { main: S.s_browser[0], sub: S.s_browser[1], size: EN ? 66 : 70, rot: -7, lang, plate: G.cream, grunge: false });
    const ST3 = stamp(root, { main: S.s_noApp[0], sub: S.s_noApp[1], size: EN ? 66 : 70, rot: 6, lang, plate: G.cream, grunge: false });
    const ST4 = stamp(root, { main: S.s_room[0], sub: S.s_room[1], size: EN ? 60 : 58, rot: -5, color: G.yellow, lang, plate: C.ink2, grunge: false });
    // dialog lines (subtitles of the animalese voices; timings from the cue sheet)
    const dl = cues.lines.map((ln, i) => {
      const L = S.lines[i];
      const w = Math.max(420, Math.min(980, (EN ? 40 : 62) * [...L.main].length * (EN ? 0.62 : 1) + 140));
      return { t0: A(...ln.at), t1: Math.min(A(...ln.at) + ln.beats * K.spb + 0.45, i === 0 ? A(2, 4.8) : 1e9), el: dialog(root, { who: ln.who, name: S.names[ln.who], main: L.main, sub: L.sub, x: 150, y: 846, w, hgt: L.sub ? 170 : 150, lang }) };
    });
    // Yuan's request cut-in
    const cut = cutin(root, { who: 'yuan', y: 470, hgt: 340, rot: -7, faceX: 1180, scale: 17 });
    // VS overlay
    const vs = h('div', { class: 'abs' }, root);
    const vsR = ransom(vs, ['V', 'S'], { size: 230, seed: 4, tilt: 9 });
    const onePC = h('div', { class: 'abs nowrap', text: S.onePC }, vs);
    Object.assign(onePC.style, { padding: '12px 30px 14px', background: G.cream, color: C.ink2, font: EN ? '400 58px/1 Anton' : '900 60px/1 "Noto Sans SC"', letterSpacing: EN ? '.04em' : '0', boxShadow: `12px 12px 0 ${G.red}`, transform: 'skewX(-10deg)' });
    const plate = (pp, col) => {
      const el = h('div', { class: 'abs nowrap' }, vs);
      el.innerHTML = `<span style="font:400 76px/1 Anton;color:${C.ink2};margin-right:16px">${pp[0]}</span><span style="font:${EN ? '400 50px/1 Anton' : "900 50px/1 'Noto Sans SC'"};color:${C.ink2}">${pp[1]}</span>`;
      Object.assign(el.style, { padding: '10px 28px 12px', background: col, border: `6px solid ${C.ink2}`, boxShadow: `10px 10px 0 ${C.ink2}`, transform: 'skewX(-12deg)' });
      return el;
    };
    const plL = plate(S.p1, P1C), plR = plate(S.p2, P2C);
    const kL = keycaps(root, { keys: ['W', 'S'], color: P1C, label: S.keysL, lang });
    const kR = keycaps(root, { keys: ['↑', '↓'], color: P2C, label: S.keysR, lang });
    // mission complete
    const done = stamp(root, { main: EN ? S.complete.join(' ') : S.complete.join(''), sub: S.completeSub, size: EN ? 170 : 210, rot: -9, lang, plate: G.cream });

    return t => {
      const c = camAt(t);
      const pose = { H: { ...P.host }, V1: poseOf.v1(t) };
      const card = { H: HC, V1: VC };
      const scr = (cd, ux, uy) => SCR(card[cd], pose[cd], ux, uy, c);
      // cold open
      const sOn = t < 1.9;
      show(secret, sOn);
      if (sOn) { const n = Math.floor(clamp((t - 0.05) / 0.5) * [...S.secret].length); secret.textContent = [...S.secret].slice(0, n).join('') + (Math.floor(t * 4) % 2 ? '_' : ''); secret.style.opacity = 1 - prog(1.5, 1.9, t); }
      O(blk, 1 - prog(0.42, 0.62, t));
      show(coldSv, t < 0.7);
      coldStr.setAttribute('stroke-dashoffset', (2400 * (1 - E.out3(prog(0, 0.42, t)))).toFixed(1));
      coldSv.style.opacity = 1 - prog(0.5, 0.7, t);
      // codename
      const cOn = t >= A(2) && t < A(3);
      show(code, cOn);
      O(dim, cOn ? 0.45 * Math.min(1, (t - A(2)) / 0.15) * (1 - prog(A(2, 4.6), A(3), t)) : 0);
      if (cOn) {
        const kin = E.outExpo(prog(A(2), A(2) + 0.2, t)), kout = E.in3(prog(A(2, 4.5), A(3), t));
        T(code, { x: lerp(-1900, 0, kin) + kout * 2200 });
        const groups = EN ? [0, 1] : [0, 0, 1, 1];
        codeR.chars.forEach((ch, i) => {
          const t0 = A(2) + groups[i] * K.spb * 1, k = E.outBack(prog(t0, t0 + 0.16, t));
          ch.el.style.transform = `rotate(${(ch.rot + (1 - k) * (i % 2 ? 30 : -30)).toFixed(2)}deg) scale(${(t < t0 ? 0 : lerp(2.4, 1, k)).toFixed(3)})`;
        });
        T(codeSub, { x: (1 - E.outBack(prog(A(2, 2.5), A(2, 2.5) + 0.25, t))) * -900 });
        T(codeTag, { o: prog(A(2, 1.5), A(2, 2), t) });
      }
      // missions
      banners.forEach((b, i) => b.set(t, M[i] + 0.1, (i < 4 ? M[i + 1] : VS) - 0.05, i === 4 ? 0.8 : 1.1));
      const idx = t < M[0] ? -1 : t < M[1] ? 0 : t < M[2] ? 1 : t < M[3] ? 2 : t < M[4] ? 3 : 4;
      const tin = E.outBack(prog(M[0] + 0.2, M[0] + 0.5, t)) * (1 - E.in3(prog(VS - 0.3, VS, t)));
      trk.set(t, idx, CLEAR, clamp(tin));
      T(trk.el, { x: 1880 - (trk.el.offsetWidth || 700) + (1 - clamp(tin)) * 300, y: 52 });
      // click bursts
      CLK.forEach((k, i) => bursts[i].set(t, k.t, scr(k.card, ...CL[k.key])));
      smash.set(t, A(16, 3), scr('V1', CL.stage_viewer[0] + CL.stage_viewer[2] * 0.82, CL.stage_viewer[1] + CL.stage_viewer[3] * 0.3));
      // callouts
      for (const co of CO) {
        if (t < co.t0 || t >= co.t1) { co.el.set(t, co.t0, co.t1, { x: 0, y: 0, ax: 0, ay: 0 }); continue; }
        const a = scr(co.card, co.anc[0], co.anc[1]);
        co.el.set(t, co.t0, co.t1, { ax: a.x, ay: a.y, x: clamp(a.x + co.off[0], 40, 1300), y: clamp(a.y + co.off[1], 170, 960) });
      }
      // stamps on photos
      const hc = toScreen(locW(pose.H, HC.W, HC.H, HC.W - 230, 170), c);
      ST1.set(t, A(4), A(5), { x: hc.x, y: hc.y });
      const v1c = toScreen(locW(poseOf.v1(t), VC.W, VC.H, VC.W / 2 + 120, VC.H - 170), c);
      ST2.set(t, A(7, 2.5), A(9), { x: v1c.x, y: v1c.y });
      const v2c = toScreen(locW(poseOf.v2(t), VC.W, VC.H, VC.W / 2 + 100, 200), c);
      ST3.set(t, A(7, 4.5), A(9), { x: v2c.x, y: v2c.y });
      const tc = toScreen(locW(P.target, 560, 500, 280, 330), c);
      ST4.set(t, A(8, 3), A(9), { x: tc.x, y: tc.y });
      // dialogs + cut-in
      dl.forEach(d => d.el.set(t, d.t0, d.t1));
      cut.set(t, A(12), A(12, 2.85), 'spark', { look: [-2, 0] });
      // VS
      const vOn = t >= VS && t < DONE + 0.4;
      show(vs, vOn); show(kL.el, vOn); show(kR.el, vOn);
      if (vOn) {
        const out = E.in3(prog(DONE, DONE + 0.35, t));
        const ki = E.outBack(prog(VS, VS + 0.22, t));
        T(vsR.el, { x: 960 - (vsR.el.offsetWidth || 380) / 2, y: 300 - (1 - ki) * 60, s: lerp(2.6, 1, ki) * (1 - out), ox: '50%', oy: '50%' });
        vsR.chars.forEach((ch, i) => { ch.el.style.transform = `rotate(${(ch.rot + Math.sin(t * 7 + i) * 3).toFixed(2)}deg)`; });
        const kp = E.outBack(prog(VS + 0.5, VS + 0.75, t));
        T(onePC, { x: 960 - (onePC.offsetWidth || 700) / 2, y: 60 + (1 - kp) * -200 - out * 300, o: Math.min(1, kp * 2) });
        const kn = E.outExpo(prog(VS + 0.15, VS + 0.45, t));
        T(plL, { x: lerp(-900, 120, kn) - out * 1200, y: 760 });
        T(plR, { x: lerp(2800, 1800 - (plR.offsetWidth || 600), kn) + out * 1200, y: 760 });
        const kk = E.outBack(prog(VS + 0.6, VS + 0.9, t));
        T(kL.el, { x: 120, y: 920 + (1 - kk) * 260 + out * 260 });
        T(kR.el, { x: 1800 - (kR.el.offsetWidth || 520), y: 920 + (1 - kk) * 260 + out * 260 });
        const press = side => [0, 1].map(j => Math.max(0, ...hitT.map((ht, i) => (i % 2 === side && (i >> 1) % 2 === j ? pulse(t, ht - 0.12, ht + 0.12, 0.05, 0.08) : 0))));
        kL.set(press(0)); kR.set(press(1));
      }
      // mission complete
      done.set(t, DONE, DOSSIER + 0.2, { x: 960, y: 520, s: 1 + 0.04 * Math.sin(Math.max(0, t - DONE) * 6) * Math.exp(-(t - DONE) * 2) });
    };
  }, 20);

  // ---------------------------------------------------------------- danmaku + tosses inside Yuan's real UI (UI px)
  film.layer('v1fx', root => {
    const over = ui.V1.over, st = CL.stage_viewer;
    const box = h('div', { class: 'abs' }, over);
    Object.assign(box.style, { left: st[0] + 'px', top: st[1] + 'px', width: st[2] + 'px', height: st[3] + 'px', overflow: 'hidden' });
    const cols = ['#fff', G.yellow, '#ffb3c7', '#a9dcff'];
    const items = S.danmaku.map((txt, i) => {
      const d = h('div', { class: 'abs nowrap', text: txt }, box);
      Object.assign(d.style, { font: `${EN ? '400 34px/1 Anton' : '900 32px/1 "Noto Sans SC"'}`, color: cols[i % 4], WebkitTextStroke: `7px ${C.ink2}`, paintOrder: 'stroke fill', letterSpacing: EN ? '.03em' : '0' });
      return { d, at: A(9, 3) + i * 0.16, y: 16 + ((i * 61) % (st[3] - 70)) };
    });
    const tx = st[0] + st[2] * 0.6, ty = st[1] + st[3] * 0.42;
    const tosses = [
      thrown(over, { kind: 'tomato', from: [st[0] + st[2] * 0.1, st[1] + st[3] + 220], to: [tx, ty], t0: A(9, 4), dur: 0.25, arc: 180, size: 110, seed: 3, splatR: 95, life: 0.95 }),
      thrown(over, { kind: 'poop', from: [st[0] + st[2] * 0.95, st[1] + st[3] + 220], to: [st[0] + st[2] * 0.3, st[1] + st[3] * 0.7], t0: A(10, 1), dur: 0.25, arc: 160, size: 96, seed: 4, life: 0.45 }),
    ];
    return t => {
      const on = t >= A(9, 3) && t < A(10, 2.5);
      show(box, on);
      if (on) for (const it of items) {
        const dt = t - it.at, vis = dt >= 0 && dt < (st[2] + 600) / 640;
        show(it.d, vis);
        if (vis) T(it.d, { x: st[2] - dt * 640, y: it.y });
      }
      tosses.forEach(f => f(t));
    };
  }, 15);

  // ---------------------------------------------------------------- dossier: the traits, stamped
  film.scene('dossier', DOSSIER, END + 0.2, root => {
    const shade = h('div', { class: 'fill' }, root);
    shade.style.background = `${halftone('rgba(255,59,48,.18)', 22, 26)}, rgba(10,8,9,.82)`;
    const fold = h('div', { class: 'abs' }, root);
    Object.assign(fold.style, { left: '190px', top: '120px', width: '1540px', height: '860px', transformOrigin: '50% 60%' });
    const tab = h('div', { class: 'abs nowrap', text: S.dossier.tag }, fold);
    Object.assign(tab.style, { left: '60px', top: '-58px', padding: '16px 30px 26px', background: G.manila2, color: C.ink2, font: `700 28px/1 ${MONO}`, letterSpacing: '.08em', border: `6px solid ${C.ink2}`, borderBottom: 'none', borderRadius: '18px 18px 0 0' });
    const body = h('div', { class: 'abs' }, fold);
    Object.assign(body.style, { left: '0', top: '0', width: '1540px', height: '860px', background: `url(${paperURL()}), linear-gradient(170deg, ${G.manila}, ${G.manila2})`, border: `7px solid ${C.ink2}`, boxShadow: `24px 26px 0 ${G.red}`, boxSizing: 'border-box' });
    // suspect photo (the mascot) clipped to the folder
    const ph = h('div', { class: 'abs' }, body);
    Object.assign(ph.style, { left: '70px', top: '90px', width: '400px', height: '470px', background: G.paper, boxShadow: `0 0 0 5px ${C.ink2}, 12px 14px 0 rgba(0,0,0,.35)`, transform: 'rotate(-4deg)' });
    const phIn = h('div', { class: 'abs' }, ph);
    Object.assign(phIn.style, { left: '18px', top: '18px', width: '364px', height: '340px', background: `${halftone('rgba(0,0,0,.1)', 14, 26)}, ${G.yellow}`, display: 'flex', alignItems: 'center', justifyContent: 'center' });
    const mc = mascot({ stroke: C.ink2, fill: G.cream, size: 240, sparkles: false });
    phIn.appendChild(mc.el);
    const phCap = h('div', { class: 'abs nowrap', text: S.dossier.photo }, ph);
    Object.assign(phCap.style, { left: '26px', top: '384px', font: `400 52px/1 ${HAND}`, color: C.ink2 });
    const clip = h('div', { class: 'abs' }, body);
    Object.assign(clip.style, { left: '230px', top: '56px', width: '60px', height: '120px', border: `8px solid #8d99a6`, borderRadius: '30px', transform: 'rotate(-4deg)' });
    // title + subtitle + microtype
    const ttl = h('div', { class: 'abs nowrap', text: S.dossier.title }, body);
    Object.assign(ttl.style, { left: '540px', top: '84px', font: EN ? `400 112px/1 Anton` : `900 110px/1 "Noto Sans SC"`, color: C.ink2, letterSpacing: EN ? '.02em' : '0' });
    const sub = h('div', { class: 'abs nowrap', text: S.dossier.sub }, body);
    Object.assign(sub.style, { left: '546px', top: '214px', font: EN ? `400 40px/1 Anton` : `900 42px/1 "Noto Sans SC"`, color: G.red2, letterSpacing: EN ? '.03em' : '0' });
    const bc = s('svg', { width: 220, height: 50, style: 'position:absolute;left:1270px;top:40px' }, body);
    barcode(bc, { w: 220, h: 50, seed: 41, color: C.ink2 });
    const lines = h('div', { class: 'abs' }, body);
    Object.assign(lines.style, { left: '540px', top: '286px', width: '930px', height: '520px', backgroundImage: `repeating-linear-gradient(0deg, rgba(25,37,48,.22) 0 2px, transparent 2px 86px)` });
    // six trait stamps, on the beat
    const TT = [A(18, 3), A(19, 1), A(19, 3), A(20, 1), A(20, 2), A(20, 3)];
    const colors = [G.red2, C.ink2, G.red2, C.ink2, G.red2, C.ink2];
    const rots = [-6, 4, -3, 5, -5, 3];
    const stamps = S.traits.map((tr, i) => stamp(body, { main: tr, size: EN ? 58 : 64, rot: rots[i], color: colors[i], lang }));
    const top = stamp(body, { main: 'TOP SECRET', size: 54, rot: 12, color: G.red, lang: 'en' });
    return (lt, t) => {
      const kin = E.outBack(prog(DOSSIER, DOSSIER + 0.45, t)), kout = E.in3(prog(END - 0.05, END + 0.15, t));
      O(shade, Math.min(1, (t - DOSSIER) / 0.2));
      T(fold, { y: (1 - kin) * 1100 + kout * -1200, r: (1 - kin) * 8 - 1.5, o: 1 });
      mc.set({ wink: Math.floor((t - DOSSIER) * 1.2) % 3 === 0 ? 1 : 0 });
      top.set(t, DOSSIER + 0.5, 1e9, { x: 1290, y: 760 });
      stamps.forEach((st, i) => st.set(t, TT[i], 1e9, { x: 770 + (i % 2) * 470, y: 350 + Math.floor(i / 2) * 150, maxW: 440 }));
    };
  }, 40);

  // ---------------------------------------------------------------- end card
  film.scene('end', END, meta.duration, root => {
    root.style.background = G.red2;
    const bg = h('div', { class: 'fill' }, root);
    bg.style.background = `${rays('rgba(0,0,0,.22)', 'transparent', 22)}`;
    const band = h('div', { class: 'abs' }, root);
    Object.assign(band.style, { left: '-200px', top: '200px', width: '2400px', height: '470px', background: C.ink2, transform: 'rotate(-6deg)', boxShadow: `0 18px 0 ${G.cream}` });
    const l1 = ransom(root, S.endCard.l1, { size: EN ? 150 : 170, seed: 61, tilt: 7, punctColor: G.cream });
    const l2 = ransom(root, S.endCard.l2, { size: EN ? 150 : 190, seed: 67, tilt: 7, punctColor: G.cream });
    T(l1.el, { x: 170, y: 250 }); T(l2.el, { x: 330, y: 452 });
    const m = mascot({ stroke: C.ink2, fill: G.yellow, size: 250 });
    const mc = h('div', { class: 'abs' }, root);
    mc.appendChild(m.el);
    const wm = h('div', { class: 'abs nowrap', html: `Piik<span style="color:${G.yellow}">.</span>` }, root);
    Object.assign(wm.style, { left: '1410px', top: '330px', font: WORDMARK(170), letterSpacing: '-7px', color: G.cream });
    const url = h('div', { class: 'abs nowrap', text: S.url }, root);
    Object.assign(url.style, { left: '1450px', top: '770px', padding: '8px 22px 10px', background: G.cream, color: C.ink2, font: `700 40px/1 ${MONO}`, boxShadow: `8px 8px 0 ${C.ink2}` });
    const foot = h('div', { class: 'abs nowrap', text: S.footer }, root);
    Object.assign(foot.style, { left: '150px', top: '990px', font: EN ? `400 36px/1 Anton` : `900 36px/1 "Noto Sans SC"`, color: G.cream, letterSpacing: EN ? '.06em' : '.04em', opacity: 0.9 });
    const fade = h('div', { class: 'fill' }, root);
    fade.style.background = '#000';
    // pops in four groups so both languages hit the same four slaps
    const G4 = EN ? [[0], [1], [2], [3, 4]] : [[0, 1], [2, 3], [4, 5], [6, 7]];
    const all = [...l1.chars, ...l2.chars];
    const popT = [A(21, 1.5), A(21, 2.5), A(21, 3.5), A(21, 4.5)];
    return (lt, t) => {
      G4.forEach((grp, gi) => grp.forEach(ci => {
        const ch = all[ci];
        if (!ch) return;
        const t0 = popT[gi], k = E.outBack(prog(t0, t0 + 0.16, t));
        ch.el.style.transform = `rotate(${(ch.rot + (1 - k) * (ci % 2 ? 30 : -30)).toFixed(2)}deg) scale(${(t < t0 ? 0 : lerp(2.4, 1, k)).toFixed(3)})`;
      }));
      T(band, { x: (1 - E.outExpo(prog(END, END + 0.3, t))) * -2400, r: -6 });
      const L0 = A(22), q = Math.max(0, t - L0);
      const kin = E.outBack(prog(L0 - 0.2, L0 + 0.2, t));
      T(mc, { x: 1140, y: 270 + (1 - kin) * 500, r: -6 });
      m.set({ wink: t < L0 + 0.1 ? 1 : t < L0 + 0.45 ? 0 : 1, spark: pulse(t, L0, L0 + 1.4, 0.08, 0.4), antenna: Math.sin(q * 10) * 10 * Math.exp(-q * 2), squash: 1 + (t >= L0 ? Math.exp(-q * 6) * Math.sin(q * 26) * 0.06 : 0) });
      T(wm, { x: (1 - E.outExpo(prog(L0, L0 + 0.35, t))) * 200, o: prog(L0, L0 + 0.12, t) });
      T(url, { y: (1 - E.outBack(prog(A(22, 3), A(22, 3) + 0.3, t))) * 40, o: prog(A(22, 3), A(22, 3) + 0.12, t) });
      T(foot, { o: prog(A(22, 2), A(22, 3), t) * 0.9 });
      O(fade, Math.max(0, (t - 45.3) / 0.6));
    };
  }, 50);

  // ---------------------------------------------------------------- shutter wipes + white flashes (above every scene)
  film.layer('top', root => {
    const wipes = [M[0], M[3], M[4], END].map(t0 => wipe(root, { t0, d: WIPE, colors: [G.red, C.ink2, G.cream, G.red, C.ink2] }));
    const flashEl = h('div', { class: 'fill' }, root);
    flashEl.style.background = '#fff';
    return t => {
      wipes.forEach(w => w.update(t));
      O(flashEl, Math.max(pulse(t, A(13), A(13) + 0.16, 0.01, 0.14) * 0.7, pulse(t, VS, VS + 0.14, 0.01, 0.12) * 0.8, pulse(t, DONE, DONE + 0.18, 0.01, 0.16) * 0.9));
    };
  }, 900);

  // ---------------------------------------------------------------- finishing: vignette + procedural film grain (live, no post)
  film.layer('finish', root => {
    const vig = h('div', { class: 'fill' }, root);
    vig.style.background = 'radial-gradient(120% 95% at 50% 50%, transparent 60%, rgba(0,0,0,.28) 100%)';
    const grain = grainLayer(root, { W: 1920, H: 1080, opacity: 0.12 });
    return t => grain(t);
  }, 1000);

  film.dispose = () => { for (const key of ['H', 'V1', 'V2']) ui[key]?.dispose(); };
  try { await Promise.all([ui.H.ready, ui.V1.ready, ui.V2.ready]); }
  catch (error) { film.dispose(); throw error; }
  return film;
}
