// Film E — 打倒无聊 · DEFEAT BOREDOM. Pixel-art JRPG battle: friends join through a Piik invite and team up.
// 150 BPM, 36 bars + tail = 58 s. Everything is drawn into one 480×270 canvas (×4, image-rendering: pixelated).
import { Film, clock, prog, E, clamp, lerp, rng, hash, pulse } from '../../engine/core.js';
import { STRINGS } from './strings.js';
import { PW, PH, P, canvas, Px, text, measure, wrap, makeBG, ditherScreen, ditherFill, burstParticles, BAYER } from './px.js';
import { person, portrait, drawBoss, mascot, sparkle, envelope, tomato, splat, keyboard, drawPortal, roomBG, FRIENDS } from './sprites.js';

const u = p => new URL(p, import.meta.url).href;
export const meta = {
  id: 'E',
  title: { zh: '打倒无聊', en: 'Defeat Boredom' },
  size: [1920, 1080], duration: 58, fps: 60, poster: 7.4, langs: ['zh', 'en'],
  css: [u('../../engine/film.css'), u('./style.css')],
  fonts: [{ family: 'Fusion Pixel 12', file: 'FusionPixel12-zh_hans.woff2' }],
  audio: { webm: u('../../out/E/audio/web.webm'), m4a: u('../../out/E/audio/web.m4a') },
};

const ORDER = ['tuan', 'yuan', 'dian', 'cong'];
const BOX = i => ({ x: 6 + i * 118, y: 214, w: 112, h: 50 });

export async function build(stage, { lang = 'zh', signal } = {}) {
  const cues = await (await fetch(u('./cues.json'), { signal })).json();
  const K = clock(cues.bpm, cues.beatsPerBar);
  const A = (b, k = 1) => K.at(b, k);
  const spb = K.spb;
  const S = STRINGS[lang];
  const film = new Film({ stage, width: 1920, height: 1080, duration: cues.length, fps: 60, lang, background: '#000' });
  film.clock = K; film.S = S;

  const view = canvas(PW, PH);
  Object.assign(view.c.style, { position: 'absolute', left: '0', top: '0', width: '1920px', height: '1080px', imageRendering: 'pixelated' });
  const px = new Px(view.ctx);
  const bg = makeBG();
  const work = canvas(PW, PH); // scratch (room snapshot, dissolves)
  const wpx = new Px(work.ctx);
  const tmp = canvas(190, 170, { read: true }); // per-frame pixel dissolve

  // ---------------------------------------------------------------- message boxes from the cue sheet
  const boxes = cues.boxes.map(b => {
    const str = b.key.startsWith('join') ? S.join(S.names[b.key.slice(4).toLowerCase()]) : S[b.key];
    const lines = wrap(str, 440 - (b.who !== 'sys' ? 0 : 0));
    return { ...b, t0: A(...b.at), t1: A(...b.until), dur: b.type * spb, lines, total: [...lines.join('')].length };
  });
  const boxAt = t => { let cur = null; for (const b of boxes) if (t >= b.t0 && t < b.t1) cur = b; return cur; };

  // ---------------------------------------------------------------- mood bars (pure functions of t)
  const moodOf = (who, t) => {
    if (who === 'tuan') return kf(t, [[0, 0.62], [A(8, 3), 0.62], [A(8, 3) + 0.4, 0.22], [A(16, 1), 0.22], [A(16, 1) + 0.6, 1], [A(19, 4), 1], [A(19, 4) + 0.25, 0.7], [A(26, 3), 0.7], [A(26, 3) + 0.5, 1]]);
    const j = { yuan: A(12, 1), dian: A(12, 3), cong: A(13, 1) }[who];
    return kf(t, [[j, 0.75], [A(16, 1), 0.75], [A(16, 1) + 0.6, 1]]);
  };
  const joined = (who, t) => who === 'tuan' || t >= { yuan: A(12, 1), dian: A(12, 3), cong: A(13, 1) }[who] + 0.35;

  // ---------------------------------------------------------------- UI pieces
  function messageBox(t) {
    const b = boxAt(t);
    if (!b) return;
    const pin = E.outBack(prog(b.t0 - 0.04, b.t0 + 0.08, t));
    const h = Math.round(42 * pin);
    if (h < 4) return;
    px.window(6, 6, 468, h, { fill: P.ink, rim: P.cream });
    if (pin < 0.95) return;
    const r = clamp((t - b.t0) / b.dur);
    let left = Math.ceil(r * b.total);
    b.lines.forEach((ln, i) => {
      const chars = [...ln];
      const n = Math.min(chars.length, left);
      left -= n;
      if (n > 0) text(px, chars.slice(0, n).join(''), 16, (b.who !== 'sys' ? 19 : 13) + i * 15, P.cream); // speaker lines start below the name tab
    });
    if (b.who !== 'sys') {
      const nm = S.names[b.who];
      const col = b.who === 'boss' ? P.grayL : FRIENDS[b.who].col;
      const w = text(px, nm, -999, -999) + 12; // measure
      px.window(14, 0, w, 17, { fill: col, rim: P.ink, edge: P.ink, r: 2 });
      text(px, nm, 20, 3, P.ink);
    }
    if (r >= 1 && Math.floor(t * 4) % 2 === 0) { px.rect(458, 38, 7, 2, P.yellow); px.rect(459, 40, 5, 1, P.yellow); px.rect(460, 41, 3, 1, P.yellow); px.rect(461, 42, 1, 1, P.yellow); }
  }
  function statusPanel(t, { highlight = null, levels = null, bounce = 0 } = {}) {
    ORDER.forEach((who, i) => {
      const bx = BOX(i);
      const on = joined(who, t);
      const hl = highlight === who;
      const yb = bx.y - (hl ? 3 : 0) - (bounce ? Math.round(Math.abs(Math.sin((t * Math.PI) / spb + i)) * bounce) : 0);
      if (!on) {
        // empty seat: dashed outline
        for (let x = bx.x; x < bx.x + bx.w; x += 6) { px.rect(x, bx.y, 3, 1, P.steel); px.rect(x, bx.y + bx.h - 1, 3, 1, P.steel); }
        for (let y = bx.y; y < bx.y + bx.h; y += 6) { px.rect(bx.x, y, 1, 3, P.steel); px.rect(bx.x + bx.w - 1, y, 1, 3, P.steel); }
        text(px, S.empty, bx.x + bx.w / 2, bx.y + 19, P.steel, { align: 'center' });
        return;
      }
      const jt = { yuan: A(12, 1), dian: A(12, 3), cong: A(13, 1) }[who];
      const pop = who === 'tuan' ? 1 : E.outBack(prog(jt + 0.3, jt + 0.5, t));
      // the acting friend peeks up from behind their status window
      if (hl && pop >= 1) {
        const q = Math.min(1, (t - (turnStart(who, t) ?? t)) / 0.18);
        const sp = person(who, who === 'tuan' && t >= A(19, 4) && t < A(21, 1) ? 'x' : 'happy', 1);
        px.img(sp.c, bx.x + bx.w - 30 - sp.ox, bx.y + 6 - Math.round(E.outBack(q) * 36) - sp.oy + 36);
      }
      const hh = Math.max(4, Math.round(bx.h * pop));
      px.window(bx.x, yb + (bx.h - hh), bx.w, hh, { fill: hl ? P.slate : P.ink, rim: hl ? P.yellow : P.cream });
      if (pop < 0.9) return;
      const f = FRIENDS[who];
      const kind = who === 'tuan' && t >= A(19, 4) && t < A(21, 1) ? 'x' : who === 'tuan' && t >= A(8, 3) && t < A(16, 1) ? 'closed' : t >= A(25, 1) ? 'happy' : 'open';
      px.img(portrait(who, kind), bx.x + 4, yb + 6);
      text(px, S.names[who], bx.x + 28, yb + 5, f.col);
      // level sits under the portrait so long names (BIG BRAIN) keep the whole row
      const lv = levels && t >= levels[i] ? 2 : 1;
      text(px, `Lv.${lv}`, bx.x + 15, yb + 32, lv > 1 ? P.yellow : P.grayL, { align: 'center' });
      text(px, S.mood, bx.x + 28, yb + 21, P.grayL);
      const m = moodOf(who, t);
      const bxx = bx.x + 28 + measure(S.mood) + 4, bw = bx.x + bx.w - 6 - bxx;
      px.rect(bxx - 1, yb + 24, bw + 2, 7, P.night);
      px.rect(bxx, yb + 25, Math.round(bw * m), 5, m < 0.35 ? P.red : m < 0.7 ? P.yellow : P.mint);
      // little extras
      if (who === 'yuan' && t >= A(22, 3) && t < A(28, 3)) { px.img(keyboard(), bx.x + bx.w - 46, yb + 34); text(px, 'P2', bx.x + bx.w - 49, yb + 35, P.blue, { align: 'right' }); }
      if (who === 'tuan' && t >= A(19, 4) && t < A(21, 1)) px.img(splat(3), bx.x - 2, yb - 4);
    });
  }
  const TURNS = [['tuan', A(9, 1), A(11, 3)], ['yuan', A(15, 1), A(17, 1)], ['dian', A(17, 1), A(19, 1)], ['cong', A(19, 1), A(20, 3)], ['tuan', A(21, 3), A(22, 3)]];
  const turnStart = (who, t) => { const r = TURNS.find(([w, a0, a1]) => w === who && t >= a0 && t < a1); return r ? r[1] : null; };
  function menu(x, y, items, cursor, sel, t, { w = 112, title = null } = {}) {
    const hh = 14 + items.length * 18;
    px.window(x, y, w, hh, { fill: P.ink, rim: P.cream });
    items.forEach((it, i) => {
      const isPiik = it === 'PIIK';
      const col = i === cursor ? (sel > 0 && Math.floor(sel * 12) % 2 ? P.white : P.yellow) : isPiik ? P.yellow : P.cream;
      if (isPiik) { px.rect(x + 22, y + 10 + i * 18, 11, 8, P.yellow); px.rect(x + 23, y + 11 + i * 18, 9, 6, P.ink); px.rect(x + 25, y + 13 + i * 18, 1, 1, P.yellow); px.rect(x + 29, y + 13 + i * 18, 1, 1, P.yellow); px.line(x + 24, y + 7 + i * 18, x + 27, y + 10 + i * 18, P.yellow); px.line(x + 31, y + 7 + i * 18, x + 28, y + 10 + i * 18, P.yellow); }
      text(px, it, x + (isPiik ? 38 : 22), y + 8 + i * 18, col);
    });
    if (cursor >= 0 && Math.floor(t * 5) % 2 === 0) {
      const cy = y + 10 + cursor * 18;
      px.rect(x + 9, cy, 2, 9, P.yellow); px.rect(x + 11, cy + 1, 2, 7, P.yellow); px.rect(x + 13, cy + 3, 2, 3, P.yellow);
    }
  }
  function numberPop(str, x, y, q, col = P.white) {
    if (q < 0 || q > 0.8) return;
    const rise = Math.round(-14 * E.out3(Math.min(1, q / 0.35)) + (q > 0.35 ? 0 : 0));
    const bounce = q < 0.15 ? Math.round(-6 * Math.sin((q / 0.15) * Math.PI)) : 0;
    text(px, str, x, y + rise + bounce, col, { scale: 2, align: 'center', outline: P.ink });
  }

  // ---------------------------------------------------------------- scenes
  function drawRoom(t) {
    const room = roomBG();
    px.img(room, 0, 0);
    // city lights twinkle
    for (let k = 0; k < 16; k++) if (hash(k * 7 + Math.floor(t * 2 + k)) > 0.45) px.rect(157 + ((k * 31) % 166), 74 + ((k * 13) % 40), 2, 2, P.yellow);
    // 阿团 on the sofa with a laptop; eyes half shut, a sigh
    const bored = t >= A(2, 3);
    const sp = person('tuan', bored ? 'lid' : (t % 2.4) > 2.25 ? 'closed' : 'open', 2);
    const bob = bored ? Math.round(Math.sin(prog(A(2, 3), A(3, 4), t) * Math.PI) * 2) : 0;
    px.img(sp.c, 240 - sp.ox, 176 - sp.oy + bob);
    // laptop glow on his face + the laptop itself
    ditherFill(px, 206, 120, 68, 40, '#9fd8ff', 0.12 + 0.05 * Math.sin(t * 9));
    px.rect(214, 160, 52, 4, P.ink); px.rect(218, 142, 44, 20, P.ink); px.rect(220, 144, 40, 16, Math.floor(t * 6) % 5 ? '#4b8fd0' : '#6aa9e0');
    for (let k = 0; k < 4; k++) px.rect(224 + ((k * 11 + Math.floor(t * 8) * 3) % 30), 148 + ((k * 5) % 9), 3, 3, k % 2 ? P.yellow : P.mint);
    if (bored) { const q = prog(A(2, 3), A(3, 2), t); if (q > 0 && q < 1) for (let k = 0; k < 3; k++) px.disc(278 + k * 7 + q * 8, 96 - k * 5 - q * 10, 2 + k, P.grayL); }
    // omen glitch at [3,3]
    if (t >= A(3, 3) && t < A(3, 3) + 0.15) { for (let k = 0; k < 6; k++) { const y = Math.floor(hash(k + Math.floor(t * 60)) * 260); px.ctx.drawImage(view.c, 0, y, PW, 6, Math.round((hash(k * 3 + 1) - 0.5) * 20), y, PW, 6); } }
    if (t < 0.35) ditherScreen(px, '#000', 1 - t / 0.35);
  }
  let snapDone = false;
  function drawSwirl(t) {
    if (!snapDone) { drawRoom(A(4, 1) - 1 / 60); work.ctx.drawImage(view.c, 0, 0); snapDone = true; }
    const p = prog(A(4, 1), A(4, 4.5), t);
    px.rect(0, 0, PW, PH, '#000');
    const B = 30;
    for (let by = 0; by < PH; by += B) for (let bx = 0; bx < PW; bx += B) {
      const cx = bx + B / 2 - PW / 2, cy = by + B / 2 - PH / 2;
      const r0 = Math.hypot(cx, cy), a0 = Math.atan2(cy, cx);
      const delay = (r0 / 280) * 0.35;
      const q = E.in2(clamp((p - delay) / (1 - delay)));
      const a = a0 + q * 5, r = r0 * (1 - q);
      const s = 1 - q;
      if (s <= 0.02) continue;
      const x = PW / 2 + Math.cos(a) * r - (B * s) / 2, y = PH / 2 + Math.sin(a) * r - (B * s) / 2;
      px.ctx.drawImage(work.c, bx, by, B, B, Math.round(x), Math.round(y), Math.max(1, Math.round(B * s)), Math.max(1, Math.round(B * s)));
    }
    if (t >= A(4, 4.5) - 0.05 && t < A(4, 4.5) + 0.05) px.rect(0, 0, PW, PH, P.white);
  }

  function drawBattle(t) {
    const tB = t - A(5, 1);
    // ---- background mode
    const toParty = prog(A(12, 1), A(13, 3), t), toGold = prog(A(25, 1), A(25, 3), t);
    let mode = 'sleep', mixTo = null, mix = 0;
    if (toGold > 0) { mode = toParty >= 1 ? 'party' : 'sleep'; mixTo = 'gold'; mix = toGold; if (toGold >= 1) { mode = 'gold'; mixTo = null; } }
    else if (toParty > 0) { mode = 'sleep'; mixTo = 'party'; mix = toParty; if (toParty >= 1) { mode = 'party'; mixTo = null; } }
    const energy = t >= A(15, 1) ? 1.3 : 1;
    px.img(bg.draw(t, mode, energy, mixTo, mix), 0, 0);
    ditherFill(px, 0, 0, PW, 52, P.night, 0.5);
    ditherFill(px, 0, 206, PW, 64, P.night, 0.5);
    // battle intro fade from black
    if (t < A(5, 1) + 0.3) ditherScreen(px, '#000', 1 - (t - A(5, 1)) / 0.3);

    // ---- boss
    const drop = prog(A(5, 1) - 0.25, A(5, 1), t);
    const by = Math.round(lerp(-80, 182, E.in2(drop)));
    let state = 'idle', flash = 0, open = 0;
    const hitTimes = [A(7, 2), A(17, 3), A(17, 3.5), A(17, 4), A(17, 4.5), A(18, 1), A(18, 1.5), A(18, 2), A(18, 2.5), A(24, 1), A(24, 2), A(24, 3), A(24, 4)];
    const lastHit = hitTimes.filter(h => t >= h).pop();
    if (lastHit !== undefined && t - lastHit < 0.12) { flash = 1; state = 'hit'; }
    if (t >= A(8, 1) && t < A(8, 3)) { state = 'yawn'; open = Math.sin(prog(A(8, 1), A(8, 3), t) * Math.PI); }
    if (t >= A(21, 1) && t < A(21, 3)) state = 'laugh';
    if (t >= A(24, 4) && t < A(25, 1)) state = 'hit';
    const breath = 1 + Math.sin(t * 2.2) * 0.03 + (t - A(5, 1) < 0.25 && t > A(5, 1) ? -0.18 * Math.sin(((t - A(5, 1)) / 0.25) * Math.PI) : 0);
    let shakeX = 0;
    if (lastHit !== undefined && t - lastHit < 0.2) shakeX = Math.round(Math.sin(t * 90) * 4 * (1 - (t - lastHit) / 0.2));
    if (t < A(25, 1)) drawBoss(px, 240 + shakeX, by, t, { state, squash: breath, flash, open });
    else {
      // dissolve into pixels
      const q = prog(A(25, 1), A(26, 1), t);
      if (q < 1) {
        tmp.ctx.clearRect(0, 0, 190, 170);
        const tp = new Px(tmp.ctx);
        drawBoss(tp, 92, 150, t, { state: 'dead', squash: 1 - q * 0.3, flash: q < 0.1 ? 1 : 0 });
        const im = tmp.ctx.getImageData(0, 0, 190, 170), d = im.data;
        for (let y = 0; y < 170; y++) for (let x = 0; x < 190; x++) if (hash(y * 190 + x) < q * 1.15 - (170 - y) / 700) d[(y * 190 + x) * 4 + 3] = 0;
        tmp.ctx.putImageData(im, 0, 0);
        px.img(tmp.c, 240 - 92, 182 - 150 - Math.round(q * 10));
        burstParticles(25, 40, t - A(25, 1), { speed: 70, grav: -40, spread: Math.PI * 2 }).forEach(([dx, dy, r]) => px.rect(240 + dx, 130 + dy, 2, 2, r > 0.5 ? P.grayL : P.white));
      }
    }
    // zzz bubbles while bored
    if (t < A(12, 1)) for (let k = 0; k < 3; k++) { const q = ((t * 0.6 + k / 3) % 1); text(px, 'z', 330 + q * 30 + k * 6, 66 - q * 26 - k * 4, P.grayL, { scale: k === 2 ? 2 : 1, outline: P.ink }); }
    // nameplate
    if (t >= A(6, 1) && t < A(25, 1)) {
      const nx = 10, ny = 56;
      px.window(nx, ny, 128, 22, { fill: P.ink, rim: P.grayL });
      text(px, S.bossTag, nx + 8, ny + 5, P.grayL);
      text(px, S.bossLv, nx + 120, ny + 5, P.grayL, { align: 'right' });
      const hp = kf(t, [[A(6, 1), 0], [A(6, 2), 1, 'out2'], [A(17, 3), 1], [A(18, 3), 0.62], [A(24, 1), 0.62], [A(24, 4), 0.12], [A(24, 4) + 0.2, 0]]);
      px.rect(nx + 4, ny + 25, 120, 5, P.night);
      px.rect(nx + 5, ny + 26, Math.round(118 * hp), 3, hp < 0.3 ? P.red : P.yellow);
    }
    // ---- screen share: LIVE frame
    const live = prog(A(10, 1), A(10, 2), t);
    if (live > 0) {
      const pulseC = Math.floor(t * 4) % 2 ? P.yellow : P.gold;
      const k = Math.round(E.out3(live) * 2);
      px.rect(0, 0, PW, k, pulseC); px.rect(0, PH - k, PW, k, pulseC); px.rect(0, 0, k, PH, pulseC); px.rect(PW - k, 0, k, PH, pulseC);
      if (t >= A(10, 3)) {
        const w = text(px, S.live, -999, -999) + 14;
        px.window(PW - w - 8, 54, w, 16, { fill: P.red, rim: P.white, r: 2 });
        px.rect(PW - w - 2, 60, 3, 3, Math.floor(t * 3) % 2 ? P.white : P.red);
        text(px, S.live, PW - w + 4, 56, P.white);
      }
      if (t < A(10, 2)) ditherScreen(px, P.white, 0.35 * (1 - live));
      // capture scan: a bright line sweeps the frame as sharing starts
      const sc = prog(A(10, 1), A(10, 1) + 0.45, t);
      if (sc > 0 && sc < 1) { const y = Math.round(sc * PH); px.rect(0, y, PW, 2, P.white); px.rect(0, y - 3, PW, 2, P.yellow); ditherFill(px, 0, 0, PW, y, P.yellow, 0.12); }
    }
    // ---- invite letter → three copies
    if (t >= A(11, 1.5) && t < A(11, 3.5)) {
      const q0 = prog(A(11, 1.5), A(11, 2), t);
      const from = [62, 214];
      if (t < A(11, 2)) px.img(envelope(), from[0] - 11 + q0 * 20, from[1] - 20 - q0 * 40);
      [[60, 70], [240, 66], [420, 70]].forEach((to, i) => {
        const t0 = A(11, 2 + i * 0.25), q = prog(t0, t0 + spb * 1.1, t);
        if (q <= 0 || q >= 1) return;
        const x = lerp(82, to[0], E.out2(q)), y = lerp(154, to[1], E.out2(q)) - Math.sin(q * Math.PI) * 30;
        px.img(envelope(), x - 11, y - 8);
        for (let k = 1; k < 5; k++) { const qq = Math.max(0, q - k * 0.04); px.rect(lerp(82, to[0], E.out2(qq)), lerp(154, to[1], E.out2(qq)) - Math.sin(qq * Math.PI) * 30, 2, 2, P.yellow); }
      });
    }
    // ---- portals + friends dropping in
    [['yuan', A(12, 1), 60], ['dian', A(12, 3), 240], ['cong', A(13, 1), 420]].forEach(([who, t0, x], i) => {
      const o = pulse(t, t0 - 0.2, t0 + 1.0, 0.18, 0.3);
      if (o > 0) drawPortal(px, x, 92, 70, 48, o, t);
      const q = prog(t0, t0 + 0.35, t);
      if (q > 0 && q < 1) {
        const bx = BOX(i + 1);
        const sp = person(who, 'wide', 1);
        const xx = lerp(x, bx.x + bx.w / 2, E.in2(q)), yy = lerp(100, bx.y + 18, E.in2(q));
        px.img(sp.c, xx - sp.ox, yy - sp.oy + 30);
      }
      if (t >= t0 && t < t0 + 0.6) burstParticles(40 + i, 16, t - t0, { speed: 80, grav: 140 }).forEach(([dx, dy, r]) => px.rect(x + dx, 96 + dy, 2, 2, r > 0.5 ? P.yellow : P.white));
    });
    if (t >= A(13, 3) && t < A(15, 1)) {
      const w = text(px, S.joinTag, -999, -999) + 14;
      px.window(PW / 2 - w / 2, 192, w, 16, { fill: P.ink, rim: P.mint, r: 2 });
      text(px, S.joinTag, PW / 2, 194, P.mint, { align: 'center' });
    }
    // ---- voice rings around 小圆
    if (t >= A(15, 2) && t < A(16, 2)) {
      const bx = BOX(1);
      for (let k = 0; k < 3; k++) {
        const q = (((t - A(15, 2)) / 0.6 + k / 3) % 1);
        const r = 10 + q * 40;
        ringPx(bx.x + 16, bx.y + 14, r, k % 2 ? P.blue : P.sky, q);
      }
      text(px, '♪', bx.x + 40 + Math.sin(t * 8) * 4, bx.y - 14 - ((t * 20) % 10), P.sky, { outline: P.ink });
    }
    // morale up arrows
    if (t >= A(16, 1) && t < A(17, 1)) ORDER.forEach((w, i) => {
      const t0 = A(16, 1 + i * 0.5), q = prog(t0, t0 + 0.6, t);
      if (q <= 0) return;
      const bx = BOX(i);
      const y = bx.y - 6 - q * 14;
      px.rect(bx.x + bx.w - 16, y + 4, 4, 8, P.mint); px.rect(bx.x + bx.w - 18, y + 4, 8, 2, P.mint); px.rect(bx.x + bx.w - 17, y + 2, 6, 2, P.mint); px.rect(bx.x + bx.w - 15, y, 2, 2, P.mint);
    });
    // ---- danmaku barrage
    if (t >= A(17, 1) && t < A(18, 4)) S.danmaku.forEach((msg, k) => {
      const hitT = A(17, 3 + k * 0.5), speed = 300, x0 = 480, xb = 290;
      const spawn = hitT - (x0 - xb) / speed;
      const x = x0 - (t - spawn) * speed;
      if (t < spawn || x < -200) return;
      const y = 62 + ((k * 41) % 96);
      const col = [P.white, P.mint, P.pink, P.sky][k % 4]; // no yellow: damage numbers own it
      text(px, msg, x, y, col, { outline: P.ink, scale: 2 });
      const [nx, ny] = [[-44, 6], [36, -4], [-6, -18], [58, 10], [-34, -30], [16, 4], [-60, -12], [44, -28]][k];
      numberPop(String([12, 25, 8, 31, 17, 44, 9, 66][k]), 240 + nx, 122 + ny, t - hitT, P.yellow);
    });
    // ---- tomato arc → splat on 阿团
    if (t >= A(19, 3) && t < A(19, 4)) {
      const q = prog(A(19, 3), A(19, 4), t);
      const a = BOX(3), b = BOX(0);
      const x = lerp(a.x + 16, b.x + 14, q), y = lerp(a.y + 10, b.y + 10, q) - Math.sin(q * Math.PI) * 90;
      px.img(tomato(), x - 7, y - 7);
    }
    if (t >= A(19, 4) && t < A(19, 4) + 0.3) burstParticles(9, 18, t - A(19, 4), { speed: 70, grav: 160 }).forEach(([dx, dy]) => px.rect(BOX(0).x + 16 + dx, BOX(0).y + 14 + dy, 2, 2, P.tomato));
    // ---- keyboard pass
    if (t >= A(22, 2) && t < A(22, 3)) {
      const q = E.io2(prog(A(22, 2), A(22, 3), t));
      const a = BOX(0), b = BOX(1);
      px.img(keyboard(), lerp(a.x + 40, b.x + 66, q) - 20, lerp(a.y - 4, b.y + 30, q) - Math.sin(q * Math.PI) * 50);
    }
    if (t >= A(22, 3) && t < A(23, 1)) {
      const w = text(px, S.remoteTag, -999, -999) + 14;
      px.window(PW / 2 - w / 2, 192, w, 16, { fill: P.ink, rim: P.sky, r: 2 });
      text(px, S.remoteTag, PW / 2, 194, P.sky, { align: 'center' });
    }
  }
  function ringPx(cx, cy, r, col, q) {
    const n = Math.max(12, Math.round(r * 2));
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; if ((i + Math.floor(q * 8)) % 3 === 0) continue; px.rect(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.7, 2, 2, col); }
  }

  function dualTech(t) {
    if (t >= A(23, 1) && t < A(24, 1)) {
      const q = prog(A(23, 1), A(23, 1) + 0.15, t);
      const h = Math.round(92 * E.outBack(q));
      const y0 = 135 - Math.round(h / 2);
      px.rect(0, y0 - 3, PW, h + 6, P.yellow);
      px.rect(0, y0, PW, h, P.ink);
      for (let k = 0; k < 14; k++) { const y = y0 + 4 + ((k * 13) % Math.max(1, h - 8)); const x = ((k * 97 + t * 900) % 560) - 80; px.rect(PW - x, y, 40 + (k % 3) * 20, 1, k % 2 ? P.slate : P.steel); }
      if (h > 60) {
        const a = person('tuan', 'wide', 2), b = person('yuan', 'wide', 2);
        px.img(a.c, 70 - a.ox + Math.round((1 - q) * -80), y0 + h - 2 - a.oy);
        px.img(b.c, 410 - b.ox + Math.round((1 - q) * 80), y0 + h - 2 - b.oy);
        text(px, S.p1, 70, y0 + 6, P.green, { align: 'center', outline: P.ink });
        text(px, S.p2, 410, y0 + 6, P.blue, { align: 'center', outline: P.ink });
        const big = prog(A(23, 1) + 0.1, A(23, 1) + 0.3, t);
        if (big > 0) text(px, S.dual, PW / 2, y0 + h / 2 - 12, P.yellow, { scale: 2, align: 'center', outline: P.ink });
        // charge sparks
        burstParticles(77 + Math.floor(t * 10), 10, ((t * 10) % 1) * 0.3, { speed: 120, grav: 0 }).forEach(([dx, dy, r]) => px.rect(PW / 2 + dx, y0 + h / 2 + 10 + dy * 0.4, 2, 2, r > 0.5 ? P.yellow : P.white));
      }
    }
    // the combo: alternating slashes from P1 (green, left) and P2 (blue, right)
    [[A(24, 1), 'L'], [A(24, 2), 'R'], [A(24, 3), 'L'], [A(24, 4), 'X']].forEach(([t0, side], k) => {
      const q = prog(t0 - 0.06, t0 + 0.14, t);
      if (q <= 0 || q >= 1) return;
      const col = side === 'L' ? P.green : side === 'R' ? P.blue : P.white;
      const L = Math.round(lerp(0, 1, E.out3(q)) * 260);
      const dirs = side === 'X' ? [1, -1] : [side === 'L' ? 1 : -1];
      for (const d of dirs) for (let w = -2; w <= 2; w++) px.line(240 - d * 130, 40 + w, 240 - d * 130 + d * L, 40 + w + L * 0.6, w === 0 ? P.white : col, 2);
      numberPop(['99', '99', '99', '9999'][k], 240 + (k - 1.5) * 24, 92, t - t0, k === 3 ? P.yellow : P.white);
    });
    if (t >= A(24, 4) && t < A(24, 4) + 0.08) px.rect(0, 0, PW, PH, P.white);
  }

  function victory(t) {
    if (t < A(25, 1)) return;
    // LEVEL UP popups on the boxes
    ORDER.forEach((w, i) => {
      const t0 = A(26, 3 + i * 0.5), q = t - t0;
      if (q < 0 || q > 1.6) return;
      const bx = BOX(i);
      text(px, S.lvup, bx.x + bx.w / 2, bx.y - 14 - Math.round(E.out3(Math.min(1, q / 0.3)) * 6), P.yellow, { align: 'center', outline: P.ink });
    });
    // loot window
    if (t >= A(27, 1) && t < A(28, 4)) {
      const q = E.outBack(prog(A(27, 1), A(27, 1) + 0.2, t));
      const w = 120, h = Math.round(86 * q), x = PW / 2 - w / 2, y = 108 - h / 2;
      if (h > 6) px.window(x, y, w, h, { fill: P.ink, rim: P.yellow });
      if (q > 0.9) {
        const bob = Math.round(Math.sin(t * 5) * 2);
        px.img(mascot(1, { screen: P.yellow }).c, PW / 2 - 15, y + 14 + bob);
        for (let k = 0; k < 4; k++) { const a = t * 3 + k * 1.57; sparkle(px, Math.round(PW / 2 + Math.cos(a) * 30), Math.round(y + 30 + Math.sin(a) * 18), 2 + (k % 2)); }
        text(px, S.lootItem, PW / 2, y + h - 18, P.yellow, { align: 'center' });
      }
    }
  }

  function drawStats(t) {
    px.img(bg.draw(t, 'teal', 0.6), 0, 0);
    ditherScreen(px, P.night, 0.35);
    const q = E.outBack(prog(A(29, 1) - 0.1, A(29, 1) + 0.12, t));
    const h = Math.round(246 * q);
    px.window(12, 12 + (246 - h) / 2, 456, h, { fill: P.ink, rim: P.cream });
    if (q < 0.95) return;
    text(px, `${S.statsTitle}`, 28, 22, P.yellow, { scale: 2 });
    text(px, 'ITEM No.001', 452, 28, P.steel, { align: 'right' });
    px.rect(24, 48, 432, 1, P.steel);
    // item card
    px.window(26, 58, 128, 188, { fill: P.deep, rim: P.slate, r: 3 });
    const wk = Math.floor((t - A(29, 1)) / spb) % 4 === 3 ? 0 : 1;
    px.img(mascot(3, { wink: wk }).c, 45, 66 + Math.round(Math.sin(t * 3) * 2));
    text(px, 'Piik.', 90, 162, P.cream, { align: 'center', scale: 2 });
    text(px, S.cardSub, 90, 192, P.grayL, { align: 'center' });
    for (let k = 0; k < 5; k++) sparkle(px, 62 + k * 14, 220, 3, P.yellow);
    const rowsAt = [A(29, 2), A(29, 3), A(29, 4), A(30, 1), A(30, 2), A(30, 3), A(30, 4), A(31, 1), A(31, 2)];
    const lx = 176, vx = lang === 'zh' ? 248 : 270;
    let cur = -1;
    S.stats.forEach(([k, v], i) => {
      if (t < rowsAt[i]) return;
      cur = i;
      const y = 60 + i * 20;
      const pop = E.outBack(prog(rowsAt[i], rowsAt[i] + 0.15, t));
      const dx = Math.round((1 - pop) * 24);
      if (t < rowsAt[i] + spb) px.rect(166, y - 2, 290, 17, P.slate);
      text(px, k, lx + dx, y, P.grayL);
      for (let x = lx + (lang === 'zh' ? 56 : 82); x < vx - 6; x += 4) px.rect(x + dx, y + 8, 1, 1, P.steel);
      text(px, v, vx + dx, y, i >= 3 && i <= 7 ? P.yellow : P.cream);
    });
    if (cur >= 0 && Math.floor(t * 5) % 2 === 0) { const cy = 61 + cur * 20; px.rect(166, cy, 2, 9, P.yellow); px.rect(168, cy + 1, 2, 7, P.yellow); px.rect(170, cy + 3, 2, 3, P.yellow); }
  }

  function drawEnd(t) {
    px.img(bg.draw(t, 'party', 0.7), 0, 0);
    ditherScreen(px, P.ink, 0.62);
    const L0 = A(33, 1), tl = t - L0;
    const mp = E.outBack(prog(L0, L0 + 0.3, t));
    const wink = tl < 0.9 ? 1 : tl < 1.25 ? 0 : 1;
    if (mp > 0.05) {
      const m = mascot(3, { wink });
      const s = Math.max(0.1, mp);
      const w = Math.round(90 * s);
      px.ctx.drawImage(m.c, Math.round(PW / 2 - w / 2), Math.round(26 + (90 - w) / 2 + Math.sin(t * 3) * 2), w, w);
      if (tl > 0.15 && tl < 1.8) for (let k = 0; k < 6; k++) { const a = k * 1.05 + tl * 2; sparkle(px, Math.round(PW / 2 + Math.cos(a) * 62), Math.round(70 + Math.sin(a) * 40), 2 + (k % 2)); }
    }
    if (tl > 0.12) text(px, 'Piik.', PW / 2, 124, P.cream, { scale: 4, align: 'center', outline: P.ink });
    if (t >= A(33, 3)) text(px, S.tagline, PW / 2, 180, P.yellow, { scale: 2, align: 'center', outline: P.ink });
    if (t >= A(33, 3) + 0.2) text(px, S.taglineSub, PW / 2, 208, P.grayL, { align: 'center' });
    if (t >= A(34, 1)) { const w = text(px, S.url, -999, -999) + 16; px.window(PW / 2 - w / 2, 226, w, 17, { fill: P.cream, rim: P.ink, r: 3 }); text(px, S.url, PW / 2, 229, P.ink, { align: 'center' }); }
    if (t >= A(34, 3) && Math.floor((t - A(34, 3)) * 2.5) % 2 === 0) text(px, S.start, PW / 2, 252, P.cream, { align: 'center' });
    if (t > cues.length - 0.6) ditherScreen(px, '#000', (t - (cues.length - 0.6)) / 0.5);
  }

  // ---------------------------------------------------------------- frame
  function draw(t) {
    const ctx = view.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    px.rect(0, 0, PW, PH, '#000');
    // camera shake on big moments
    const shakes = [[A(5, 1), 0.3, 4], [A(19, 4), 0.25, 3], [A(24, 1), 0.15, 3], [A(24, 2), 0.15, 3], [A(24, 3), 0.15, 3], [A(24, 4), 0.4, 6], [A(25, 1), 0.4, 4]];
    let sx = 0, sy = 0;
    for (const [t0, d, a] of shakes) if (t >= t0 && t < t0 + d) { const k = 1 - (t - t0) / d; sx += Math.round((hash(Math.floor(t * 60) * 2) - 0.5) * 2 * a * k); sy += Math.round((hash(Math.floor(t * 60) * 2 + 1) - 0.5) * 2 * a * k); }
    ctx.setTransform(1, 0, 0, 1, sx, sy);
    if (t < A(4, 1)) { drawRoom(t); messageBox(t); }
    else if (t < A(5, 1)) drawSwirl(t);
    else if (t < A(29, 1)) {
      drawBattle(t);
      dualTech(t);
      // menus
      if (t >= A(6, 3) && t < A(7, 1) + 0.12) menu(6, 118, S.cmd, 0, t >= A(7, 1) ? prog(A(7, 1), A(7, 1) + 0.12, t) : 0, t);
      if (t >= A(9, 1) && t < A(9, 3)) menu(6, 118, S.cmd, t < A(9, 1.5) ? 0 : t < A(9, 2) ? 1 : 2, t >= A(9, 2.5) ? 1 : 0, t);
      if (t >= A(9, 3) && t < A(9, 4) + 0.12) { menu(6, 118, S.cmd, 2, 0, t); menu(120, 96, S.piik, 0, t >= A(9, 4) ? 1 : 0, t, { w: 150 }); }
      if (t >= A(10, 4) && t < A(11, 1) + 0.15) menu(120, 96, S.piik, 1, t >= A(11, 1) ? 1 : 0, t, { w: 150 });
      if (t >= A(15, 1) && t < A(15, 2)) menu(120, 96, S.piik, 2, t >= A(15, 1.5) ? 1 : 0, t, { w: 150 });
      if (t >= A(17, 1) && t < A(17, 2)) menu(120, 96, S.piik, 3, t >= A(17, 1.5) ? 1 : 0, t, { w: 150 });
      if (t >= A(21, 3) && t < A(21, 4) + 0.15) menu(120, 96, S.piik, t < A(21, 3.5) ? 3 : 4, t >= A(21, 4) ? 1 : 0, t, { w: 150 });
      const hl = t >= A(15, 1) && t < A(17, 1) ? 'yuan' : t >= A(17, 1) && t < A(19, 1) ? 'dian' : t >= A(19, 1) && t < A(20, 3) ? 'cong' : (t >= A(9, 1) && t < A(11, 3)) || (t >= A(21, 3) && t < A(22, 3)) ? 'tuan' : null;
      statusPanel(t, { highlight: hl, levels: [A(26, 3), A(26, 3.5), A(26, 4), A(26, 4.5)], bounce: t >= A(25, 2) ? 2 : 0 });
      victory(t);
      messageBox(t);
      // wipe to the stats screen
      const wq = prog(A(28, 4), A(29, 1), t);
      if (wq > 0) for (let x = 0; x < PW; x += 16) { const k = clamp(wq * 1.6 - (x / PW) * 0.6); px.rect(x, 0, 16, Math.round(PH * k), P.ink); }
    } else if (t < A(33, 1)) drawStats(t);
    else drawEnd(t);
  }

  film.layer('px', root => { root.appendChild(view.c); return t => draw(t); }, 1);
  return film;
}

function kf(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1, e] = keys[i];
      const p = (t - t0) / (t1 - t0);
      const q = e === 'out2' ? 1 - (1 - p) ** 2 : p;
      return v0 + (v1 - v0) * q;
    }
  }
  return keys[keys.length - 1][1];
}
