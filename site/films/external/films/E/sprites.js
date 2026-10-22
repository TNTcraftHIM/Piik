// Film E procedural pixel sprites: the four friends (brand bean people), BOREDOM, the Piik TV mascot,
// envelope, tomato, keyboard, browser portal and the night room. Static pieces are cached canvases.
import { canvas, Px, P } from './px.js';

const cache = new Map();
const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

export const FRIENDS = {
  tuan: { col: P.green, dark: P.greenD, crown: true },
  yuan: { col: P.blue, dark: P.blueD },
  dian: { col: P.purple, dark: P.purpleD },
  cong: { col: P.orange, dark: P.orangeD },
};

/** Eyes on a head centred at (cx, cy) with eye spacing dx. kind: open|happy|closed|x|squint|wide|lid */
function eyes(px, cx, cy, dx, kind, s = 1) {
  const ink = P.ink;
  for (const side of [-1, 1]) {
    const x = Math.round(cx + side * dx), y = Math.round(cy);
    if (kind === 'open') px.rect(x - (s > 1 ? 1 : 0), y - s, s > 1 ? 2 : 1, 2 * s, ink);
    else if (kind === 'wide') { px.rect(x - s, y - s - 1, 2 * s, 2 * s + 2, ink); px.rect(x - s, y - s - 1, 1, 1, P.white); }
    else if (kind === 'happy') { px.rect(x - s, y, 1, s, ink); px.rect(x - s + 1, y - 1, Math.max(1, 2 * s - 2), s, ink); px.rect(x + s - 1, y, 1, s, ink); }
    else if (kind === 'closed') px.rect(x - s, y, 2 * s, s, ink);
    else if (kind === 'lid') { px.rect(x - s - 1, y - 1, 2 * s + 2, 1, ink); px.rect(x - (s > 1 ? 1 : 0), y, s > 1 ? 2 : 1, s, ink); }
    else if (kind === 'x') { px.line(x - s, y - s, x + s - 1, y + s - 1, ink); px.line(x + s - 1, y - s, x - s, y + s - 1, ink); }
    else if (kind === 'squint') { const d = side < 0 ? 1 : -1; px.line(x - s * d, y - s, x + s * d, y, ink); px.line(x + s * d, y, x - s * d, y + s, ink); }
  }
}
function crown(px, cx, by, k) {
  const pts = [[-5, 0], [-6, -5], [-3, -3], [0, -6], [3, -3], [6, -5], [5, 0]].map(([x, y]) => [cx + x * k, by + y * k]);
  px.poly(pts.map(([x, y]) => [x + (x < cx ? -1 : x > cx ? 1 : 0), y + (y < by ? -1 : 1)]), P.ink);
  px.poly(pts, P.yellow);
  px.rect(cx - 4 * k, by - 1 * k, 8 * k, 1 * k, P.gold);
}

/**
 * Full bean person sprite (pixel art with ink outline + 2-tone shading).
 * s = integer scale (1 ≈ 26×40 px). Returns cached {c, ox, oy}; (ox, oy) = bottom centre.
 */
export function person(who, kind = 'open', s = 1) {
  return memo(`p|${who}|${kind}|${s}`, () => {
    const f = FRIENDS[who] || { col: P.gray, dark: P.grayD };
    const W = 28 * s + 6, H = 46 * s + 10;
    const { c, ctx } = canvas(W, H);
    const px = new Px(ctx);
    const cx = Math.round(W / 2), by = H - 1;
    const bw = 11 * s, bh = 18 * s, hr = 7 * s, hy = by - bh - hr + 2 * s;
    const body = (col, g) => {
      px.rrect(cx - bw - g, by - bh - g, 2 * bw + 2 * g, bh + g, Math.round(bw * 0.95) + g, col);
      px.disc(cx, hy, hr + g, col);
    };
    body(P.ink, 1);
    body(f.col, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(cx + Math.round(bw * 0.45), 0, W, H); ctx.clip();
    body(f.dark, 0);
    ctx.restore();
    px.rect(cx - Math.round(bw * 0.55), hy - Math.round(hr * 0.55), Math.max(1, 2 * s), Math.max(1, s), 'rgba(255,255,255,.55)');
    eyes(px, cx, hy, Math.max(2, Math.round(2.6 * s)), kind, Math.max(1, s));
    if (f.crown) crown(px, cx, hy - hr - 1, Math.max(1, s));
    return { c, ox: cx, oy: by };
  });
}
/** Head-only portrait for status boxes (20×20). */
export function portrait(who, kind = 'open') {
  return memo(`pt|${who}|${kind}`, () => {
    const f = FRIENDS[who];
    const { c, ctx } = canvas(22, 22);
    const px = new Px(ctx);
    px.disc(11, 13, 8, P.ink);
    px.disc(11, 13, 7, f.col);
    ctx.save(); ctx.beginPath(); ctx.rect(14, 0, 22, 22); ctx.clip(); px.disc(11, 13, 7, f.dark); ctx.restore();
    px.rect(7, 9, 2, 1, 'rgba(255,255,255,.6)');
    eyes(px, 11, 13, 3, kind, 1);
    if (f.crown) crown(px, 11, 5, 1);
    return { c };
  });
}

/**
 * BOREDOM: a big sleepy grey mochi in a night-cap. Drawn live (it breathes / yawns).
 * state: idle | yawn | hit | laugh | dead. (cx, by) = bottom centre.
 */
export function drawBoss(px, cx, by, t, { state = 'idle', squash = 1, flash = 0, open = 0 } = {}) {
  const W = Math.round(66 * (2 - squash)), H = Math.round(88 * squash);
  const top = by - H;
  const body = flash > 0.5 ? P.white : P.gray, dark = flash > 0.5 ? P.grayL : P.grayD, lite = flash > 0.5 ? P.white : P.grayL;
  px.ellipse(cx, by + 3, W * 1.05, 6, 'rgba(13,20,27,.5)');
  const blob = (col, g) => {
    px.rrect(cx - W - g, top + 10 - g, 2 * W + 2 * g, H - 10 + 2 * g, Math.round(W * 0.85) + g, col);
    px.rrect(cx - W - 4 - g, by - 26 - g, 2 * W + 8 + 2 * g, 26 + 2 * g, 12 + g, col); // squishy bottom
  };
  blob(P.ink, 2);
  blob(body, 0);
  px.ctx.save(); px.ctx.beginPath(); px.ctx.rect(cx + Math.round(W * 0.42), 0, 999, 999); px.ctx.clip(); blob(dark, 0); px.ctx.restore();
  px.ellipse(cx - W * 0.42, top + 30, W * 0.2, 9, lite);
  px.rect(cx - Math.round(W * 0.55), top + 24, 6, 3, P.white);
  // night-cap (tilted to the right, pom-pom swings)
  const sway = Math.sin(t * 2.4) * 4;
  const capPts = [[cx - W * 0.62, top + 26], [cx + W * 0.5, top + 20], [cx + W * 0.95 + sway, top - 18], [cx + W * 1.08 + sway, top - 4]];
  px.poly([[capPts[0][0] - 2, capPts[0][1] + 2], [capPts[1][0] + 2, capPts[1][1] + 2], [cx + W * 0.96 + sway, top - 22], [capPts[0][0] + 10, top - 2]], P.ink);
  px.poly([capPts[0], capPts[1], [cx + W * 0.94 + sway, top - 19], [capPts[0][0] + 12, top]], P.lilac);
  for (let k = 0; k < 3; k++) { const q = 0.25 + k * 0.25; px.line(lerp(capPts[0][0] + 12, capPts[0][0], q), lerp(top, capPts[0][1], q), lerp(cx + W * 0.94 + sway, capPts[1][0], q), lerp(top - 19, capPts[1][1], q), P.purpleD, 2); }
  px.rrect(capPts[0][0] - 4, capPts[0][1] - 4, capPts[1][0] - capPts[0][0] + 10, 9, 4, P.ink);
  px.rrect(capPts[0][0] - 3, capPts[0][1] - 3, capPts[1][0] - capPts[0][0] + 8, 7, 3, P.cream);
  px.disc(cx + W * 1.0 + sway, top - 18, 7, P.ink); px.disc(cx + W * 1.0 + sway, top - 18, 6, P.cream);
  // eyes: heavy lids, eye bags
  const ey = Math.round(top + H * 0.46), ex = Math.round(W * 0.36);
  for (const sd of [-1, 1]) {
    const x = Math.round(cx + sd * ex);
    if (state === 'hit' || state === 'dead') { px.line(x - 6, ey - 6, x + 6, ey + 6, P.ink, 3); px.line(x + 6, ey - 6, x - 6, ey + 6, P.ink, 3); }
    else if (state === 'laugh') { px.line(x - 8, ey + 3, x, ey - 4, P.ink, 3); px.line(x, ey - 4, x + 8, ey + 3, P.ink, 3); }
    else {
      px.rect(x - 9, ey - 2, 18, 3, P.ink);
      if (state !== 'yawn') px.rect(x - 4, ey + 1, 8, 4, P.ink);
      px.rect(x - 7, ey + 7, 14, 2, dark);
      px.rect(x - 5, ey + 9, 10, 1, dark);
    }
  }
  // mouth
  const my = Math.round(top + H * 0.72);
  if (state === 'yawn' || open > 0) {
    const o = state === 'yawn' ? Math.max(0.5, open) : open;
    px.ellipse(cx, my, 14 + 8 * o, 6 + 15 * o, P.ink);
    px.ellipse(cx, my + 4 + 8 * o, 9 + 4 * o, 3 + 6 * o, P.pink);
  } else if (state === 'laugh') { px.ellipse(cx, my, 16, 9, P.ink); px.rect(cx - 17, my - 10, 34, 9, body); px.ellipse(cx, my + 4, 8, 3, P.pink); }
  else if (state === 'hit' || state === 'dead') px.ellipse(cx, my, 8, 6, P.ink);
  else { px.rect(cx - 10, my, 6, 2, P.ink); px.rect(cx - 4, my + 1, 8, 2, P.ink); px.rect(cx + 4, my, 6, 2, P.ink); }
}
const lerp = (a, b, q) => a + (b - a) * q;

/** Piik TV mascot in pixel art. s = integer scale (1 = 30×30). wink 1 = brand wink, 0 = both eyes open. */
export function mascot(s = 1, { wink = 1, screen = P.cream, line = P.ink } = {}) {
  return memo(`m|${s}|${wink}|${screen}|${line}`, () => {
    const W = 30 * s, H = 30 * s;
    const { c, ctx } = canvas(W, H);
    const px = new Px(ctx);
    const t = Math.max(2, 2 * s);
    px.line(9 * s, 2 * s, 15 * s, 7 * s, line, t);
    px.line(21 * s, 2 * s, 15 * s, 7 * s, line, t);
    px.rrect(3 * s, 7 * s, 24 * s, 18 * s, 4 * s, line);
    px.rrect(3 * s + t, 7 * s + t, 24 * s - 2 * t, 18 * s - 2 * t, Math.max(1, 4 * s - t), screen);
    px.rect(10 * s, 15 * s, Math.max(2, 2 * s), Math.max(2, Math.round(2.4 * s)), line);
    if (wink) {
      const x0 = 18 * s, y0 = Math.round(16.5 * s);
      px.line(x0, y0, x0 + 2 * s, y0 - 2 * s, line, t);
      px.line(x0 + 2 * s, y0 - 2 * s, x0 + 4 * s, y0, line, t);
    } else px.rect(Math.round(19.5 * s), 15 * s, Math.max(2, 2 * s), Math.max(2, Math.round(2.4 * s)), line);
    px.line(10 * s, 28 * s, 12 * s, 25 * s, line, t);
    px.line(20 * s, 28 * s, 18 * s, 25 * s, line, t);
    return { c };
  });
}
export function sparkle(px, x, y, r, col = P.yellow) {
  px.rect(x - r, y, 2 * r + 1, 1, col);
  px.rect(x, y - r, 1, 2 * r + 1, col);
  if (r > 2) { px.rect(x - 1, y - 1, 3, 3, col); px.rect(x, y, 1, 1, P.white); }
}

export function envelope() {
  return memo('env', () => {
    const { c, ctx } = canvas(24, 18);
    const px = new Px(ctx);
    px.rect(1, 2, 22, 15, P.ink);
    px.rect(2, 3, 20, 13, P.cream);
    px.line(2, 3, 12, 10, P.ink); px.line(21, 3, 12, 10, P.ink);
    px.disc(12, 11, 3.5, P.ink); px.disc(12, 11, 2.5, P.red);
    px.rect(11, 10, 2, 2, P.yellow);
    return { c };
  });
}
export function tomato() {
  return memo('tom', () => {
    const { c, ctx } = canvas(16, 16);
    const px = new Px(ctx);
    px.disc(8, 9, 7, P.ink);
    px.disc(8, 9, 6, P.tomato);
    px.rect(4, 6, 3, 2, '#ffb399');
    px.rect(5, 1, 6, 3, P.ink); px.rect(6, 2, 4, 2, P.leaf);
    return { c };
  });
}
export function splat(seed = 1) {
  return memo('spl' + seed, () => {
    const { c, ctx } = canvas(32, 32);
    const px = new Px(ctx);
    let s = seed * 9301 + 49297;
    const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    px.disc(16, 16, 9, P.redD);
    for (let i = 0; i < 9; i++) { const a = r() * 6.283, d = 7 + r() * 7; px.disc(16 + Math.cos(a) * d, 16 + Math.sin(a) * d, 1 + r() * 3, P.redD); }
    px.disc(15, 15, 7, P.tomato);
    px.rect(12, 12, 3, 2, '#ffb399');
    return { c };
  });
}
export function keyboard() {
  return memo('kb', () => {
    const { c, ctx } = canvas(40, 16);
    const px = new Px(ctx);
    px.rrect(0, 0, 40, 16, 3, P.ink);
    px.rrect(1, 1, 38, 14, 2, P.slate);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 9; k++) {
      const x = 3 + k * 4 + r, y = 3 + r * 4;
      const wasd = (r === 0 && k === 1) || (r === 1 && k <= 2);
      const arrows = (r === 2 && k >= 6) || (r === 1 && k === 7);
      px.rect(x, y, 3, 3, wasd ? P.green : arrows ? P.blue : P.grayL);
    }
    return { c };
  });
}
/** Browser-window portal (w×h), opening amount o 0..1 drawn live. */
export function drawPortal(px, cx, cy, w, h, o, t) {
  if (o <= 0) return;
  const ww = Math.max(4, Math.round(w * Math.min(1, o * 1.3))), hh = Math.max(2, Math.round(h * o));
  const x = Math.round(cx - ww / 2), y = Math.round(cy - hh / 2);
  px.rrect(x - 2, y - 2, ww + 4, hh + 4, 5, P.ink);
  px.rrect(x, y, ww, hh, 3, P.cream);
  px.rect(x + 2, y + 2, ww - 4, Math.min(8, hh - 4), P.paper);
  if (ww > 30) { px.rect(x + 5, y + 4, 3, 3, P.red); px.rect(x + 10, y + 4, 3, 3, P.yellow); px.rect(x + 15, y + 4, 3, 3, P.green); px.rrect(x + 21, y + 3, ww - 26, 5, 2, P.grayL); }
  if (hh > 14) {
    const ix = x + 3, iy = y + 11, iw = ww - 6, ih = hh - 14;
    px.rect(ix, iy, iw, ih, P.deep);
    for (let k = 0; k < 10; k++) {
      const a = t * 5 + k * 0.7, rr = (k / 10) * Math.min(iw, ih) * 0.48;
      px.rect(Math.round(ix + iw / 2 + Math.cos(a) * rr), Math.round(iy + ih / 2 + Math.sin(a) * rr * 0.6), 2, 2, k % 3 === 0 ? P.yellow : k % 3 === 1 ? P.sky : P.pink);
    }
  }
}

/** Night room, front view (static part cached): window + city, lamp, clock, the big yellow brand sofa. */
export function roomBG() {
  return memo('room', () => {
    const { c, ctx } = canvas(480, 270);
    const px = new Px(ctx);
    px.rect(0, 0, 480, 270, P.deep);
    for (let x = 0; x < 480; x += 12) px.rect(x, 0, 1, 196, '#22324a');
    // window with skyline + moon
    px.rect(150, 18, 180, 104, P.ink);
    px.rect(154, 22, 172, 96, '#0f1828');
    for (let i = 0; i < 17; i++) { const bx = 154 + i * 10 + (i % 3) * 2, bh = 18 + ((i * 37) % 44); px.rect(bx, 118 - bh, 9, bh, '#192841'); }
    px.disc(296, 44, 11, '#ffe9a8'); px.disc(290, 40, 11, '#0f1828');
    px.rect(238, 22, 4, 96, P.ink); px.rect(154, 68, 172, 3, P.ink);
    px.rect(146, 122, 188, 5, P.ink); px.rect(148, 123, 184, 3, P.slate);
    // floor + rug
    px.rect(0, 196, 480, 74, '#2a2238');
    px.ellipse(240, 238, 190, 22, '#3a2c4a');
    // lamp (left)
    px.rect(56, 96, 4, 100, P.ink); px.rect(44, 194, 28, 4, P.ink);
    px.poly([[38, 96], [78, 96], [70, 70], [46, 70]], P.ink); px.poly([[40, 95], [76, 95], [69, 72], [47, 72]], P.gold);
    // clock (right wall)
    px.disc(402, 52, 18, P.ink); px.disc(402, 52, 16, P.cream);
    px.rect(402, 40, 2, 13, P.ink); px.rect(402, 52, 9, 2, P.ink);
    // plant (right)
    px.rect(420, 168, 22, 28, P.ink); px.rect(422, 170, 18, 26, P.amber);
    for (const [x, y] of [[424, 144], [434, 138], [418, 154], [440, 152], [431, 128]]) { px.ellipse(x, y, 7, 11, P.ink); px.ellipse(x, y, 6, 10, P.leaf); }
    // sofa (brand yellow, front view)
    const sx = 112, sy = 118, sw = 256, sh = 82;
    px.rrect(sx - 2, sy - 2, sw + 4, sh + 4, 20, P.ink); px.rrect(sx, sy, sw, sh, 18, P.yellow);
    px.rect(sx + 10, sy + 54, sw - 20, 18, P.gold);
    px.rect(sx + 12, sy + 52, sw - 24, 2, '#d99a2b');
    px.rrect(sx - 18, sy + 30, 28, 56, 10, P.ink); px.rrect(sx - 16, sy + 32, 24, 52, 9, P.yellow);
    px.rrect(sx + sw - 10, sy + 30, 28, 56, 10, P.ink); px.rrect(sx + sw - 8, sy + 32, 24, 52, 9, P.yellow);
    px.rect(sx + 18, sy + sh, 6, 12, P.ink); px.rect(sx + sw - 24, sy + sh, 6, 12, P.ink);
    return { c, sofa: { sx, sy, sw, sh } };
  });
}
