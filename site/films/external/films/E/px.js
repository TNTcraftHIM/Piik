// Film E pixel kit: a 480×270 canvas drawn with hard-edged primitives (no anti-aliasing), cached sprites,
// pixel-font text with outlines, and palette-cycling "battle backgrounds" shaded per pixel.
import { rng, clamp } from '../../engine/core.js';

export const PW = 480, PH = 270;
export const FONT = '"Fusion Pixel 12"';

// Palette built from the Piik brand (ink / cream / sofa yellow / tomato / the four friends) + battle accents.
export const P = {
  ink: '#192530', night: '#0d141b', deep: '#1e2b40', slate: '#34465f', steel: '#5b6b82',
  cream: '#f6f2e8', white: '#ffffff', paper: '#e9e2cf',
  yellow: '#ffd05a', gold: '#eaaa38', amber: '#c77d1e',
  tomato: '#e96c55', red: '#ff4a3d', redD: '#b8322b', leaf: '#448e6b', pink: '#ff8fb8',
  green: '#5fb67b', greenD: '#357a50', blue: '#4ea9db', blueD: '#2b6f9e',
  purple: '#b49be6', purpleD: '#7a62b3', orange: '#e99a5b', orangeD: '#b06a33',
  gray: '#9aa1ab', grayD: '#6c7380', grayL: '#c7ccd3', lilac: '#8b86b8', mint: '#7fe0c4', sky: '#9fd8ff',
};

export function canvas(w, h, { read = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

/** Hard-edged drawing helpers on a 2D context (integer pixels only). */
export class Px {
  constructor(ctx) { this.ctx = ctx; }
  col(c) { this.ctx.fillStyle = c; return this; }
  rect(x, y, w, h, c) { if (c) this.ctx.fillStyle = c; this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  /** filled ellipse via horizontal spans */
  ellipse(cx, cy, rx, ry, c) {
    if (c) this.ctx.fillStyle = c;
    const y0 = Math.ceil(cy - ry), y1 = Math.floor(cy + ry);
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      if (Math.abs(dy) > 1) continue;
      const hw = rx * Math.sqrt(1 - dy * dy);
      const xa = Math.round(cx - hw), xb = Math.round(cx + hw);
      if (xb > xa) this.ctx.fillRect(xa, y, xb - xa, 1);
    }
  }
  disc(cx, cy, r, c) { this.ellipse(cx, cy, r, r, c); }
  /** rounded rectangle via spans (r in px) */
  rrect(x, y, w, h, r, c) {
    if (c) this.ctx.fillStyle = c;
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    r = Math.min(r, w / 2, h / 2);
    for (let j = 0; j < h; j++) {
      let inset = 0;
      if (j < r) inset = r - Math.sqrt(Math.max(0, r * r - (r - j - 0.5) ** 2));
      else if (j >= h - r) inset = r - Math.sqrt(Math.max(0, r * r - (j - (h - r) + 0.5) ** 2));
      const a = Math.round(inset);
      this.ctx.fillRect(x + a, y + j, w - 2 * a, 1);
    }
  }
  /** crisp scanline polygon fill (even-odd), pts = [[x, y], ...] */
  poly(pts, c) {
    if (c) this.ctx.fillStyle = c;
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.ceil(y0 - 0.5); y <= Math.floor(y1 + 0.5); y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [xa, ya] = pts[i], [xb, yb] = pts[(i + 1) % pts.length];
        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) { const a1 = Math.round(xs[k]), b1 = Math.round(xs[k + 1]); if (b1 > a1) this.ctx.fillRect(a1, y, b1 - a1, 1); }
    }
  }
  /** 1-px Bresenham line (or thickness t square brush) */
  line(x0, y0, x1, y1, c, t = 1) {
    if (c) this.ctx.fillStyle = c;
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, o = Math.floor(t / 2);
    for (;;) {
      this.ctx.fillRect(x0 - o, y0 - o, t, t);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  /** pixel-art window: outer ink, light rim, fill, inner shadow */
  window(x, y, w, h, { fill = P.ink, rim = P.cream, edge = P.night, r = 3 } = {}) {
    this.rrect(x - 1, y - 1, w + 2, h + 2, r + 1, edge);
    this.rrect(x, y, w, h, r, rim);
    this.rrect(x + 2, y + 2, w - 4, h - 4, Math.max(1, r - 1), fill);
  }
  img(src, x, y, s = 1) {
    if (!src) return;
    const c = src.c || src;
    if (s === 1) this.ctx.drawImage(c, Math.round(x), Math.round(y));
    else this.ctx.drawImage(c, Math.round(x), Math.round(y), Math.round(c.width * s), Math.round(c.height * s));
  }
}

// ---------------------------------------------------------------------------------------- text
const textCache = new Map();
/** Measure a string in the 12 px pixel font (1× pixels). */
let measureCtx = null;
export function measure(str) {
  measureCtx ||= canvas(4, 4).ctx;
  measureCtx.font = `12px ${FONT}`;
  return Math.ceil(measureCtx.measureText(str).width);
}
/**
 * Render a string to a cached bitmap (1× pixels) with optional 1-px outline and drop shadow.
 * Returns {c, w, h}. Text is drawn on integer coordinates so pixel-font glyphs stay crisp.
 */
const rgbCache = new Map();
let rgbCtx = null;
function rgbOf(col) {
  if (rgbCache.has(col)) return rgbCache.get(col);
  rgbCtx ||= canvas(1, 1, { read: true }).ctx;
  rgbCtx.clearRect(0, 0, 1, 1);
  rgbCtx.fillStyle = col;
  rgbCtx.fillRect(0, 0, 1, 1);
  const v = [...rgbCtx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  rgbCache.set(col, v);
  return v;
}
export function textBitmap(str, color = P.cream, { outline = null, shadow = null } = {}) {
  const key = `${str}|${color}|${outline}|${shadow}`;
  if (textCache.has(key)) return textCache.get(key);
  const pad = 2, w = measure(str) + pad * 2 + 1, h = 12 + pad * 2 + 1;
  const { c, ctx } = canvas(w, h);
  ctx.font = `12px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff';
  ctx.fillText(str, pad, pad);
  // Recover the 1-bit glyph mask. Some rasterisers (DirectWrite greyscale) smear vertical edges
  // sideways, so a 1-px gap between two strokes reads ~50 % and a lone stroke ~90 % — cut between.
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3] > 160 ? 1 : 0;
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  // fill > outline (8-neighbour ring) > drop shadow (+1,+1), all hard-edged
  const fc = rgbOf(color), oc = outline && rgbOf(outline), sc = shadow && rgbOf(shadow);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let col = null;
    if (m[i]) col = fc;
    else if (oc && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1) || on(x - 1, y - 1) || on(x + 1, y - 1) || on(x - 1, y + 1) || on(x + 1, y + 1))) col = oc;
    else if (sc && on(x - 1, y - 1)) col = sc;
    const j = i * 4;
    if (col) { d[j] = col[0]; d[j + 1] = col[1]; d[j + 2] = col[2]; d[j + 3] = 255; } else d[j + 3] = 0;
  }
  ctx.putImageData(im, 0, 0);
  const out = { c, w, h, pad };
  textCache.set(key, out);
  return out;
}
/** Draw text; align 'left' | 'center' | 'right'; scale integer. Returns drawn width (in canvas px). */
export function text(px, str, x, y, color = P.cream, { scale = 1, align = 'left', outline = null, shadow = null } = {}) {
  if (!str) return 0;
  const b = textBitmap(str, color, { outline, shadow });
  const w = (b.w - b.pad * 2) * scale;
  const ox = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
  px.ctx.drawImage(b.c, Math.round(x + ox - b.pad * scale), Math.round(y - b.pad * scale), b.w * scale, b.h * scale);
  return w;
}
/** Greedy wrap for mixed CJK/Latin text into lines no wider than maxW (1× px). Explicit \n breaks. */
export function wrap(str, maxW) {
  const out = [];
  for (const para of str.split('\n')) {
    let line = '';
    // tokens: CJK chars individually, Latin words with trailing space
    const tokens = para.match(/[　-鿿＀-￯]|[^\s　-鿿＀-￯]+\s*|\s+/g) || [''];
    for (const tk of tokens) {
      const trial = line + tk;
      if (measure(trial.trimEnd()) > maxW && line) { out.push(line.trimEnd()); line = tk.trimStart(); }
      else line = trial;
    }
    out.push(line.trimEnd());
  }
  return out;
}

// ---------------------------------------------------------------------------------------- backgrounds
/**
 * Psychedelic battle background shaded per pixel into an ImageData: palette cycling over a warped pattern.
 * mode: 'sleep' (grey-lilac slow waves) | 'party' (bright stripes) | 'gold' (victory rays) | 'room'
 */
export function makeBG() {
  const { c, ctx } = canvas(PW, PH);
  const im = ctx.createImageData(PW, PH);
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const PALS = {
    sleep: ['#2a2d45', '#33375a', '#3d4268', '#484d77', '#555b86', '#484d77', '#3d4268', '#33375a'].map(hex),
    party: ['#2a1f4f', '#3b2a6b', '#55358a', '#7a3f8f', '#a84d86', '#cf6a6e', '#e08f5c', '#cf6a6e', '#a84d86', '#7a3f8f', '#55358a', '#3b2a6b'].map(hex),
    gold: ['#4a2c10', '#6b3d12', '#8f5418', '#b8741e', '#d99a2b', '#eaaa38', '#f4c45a', '#eaaa38', '#d99a2b', '#b8741e', '#8f5418', '#6b3d12'].map(hex),
    teal: ['#10283a', '#16405a', '#1d5c78', '#2a7f96', '#3aa3ad', '#2a7f96', '#1d5c78', '#16405a'].map(hex),
  };
  const draw = (t, mode = 'sleep', energy = 1, mixTo = null, mix = 0) => {
    const d = im.data;
    const pal = PALS[mode], pal2 = mixTo ? PALS[mixTo] : null;
    const n = pal.length, n2 = pal2 ? pal2.length : 1;
    const sp = mode === 'sleep' ? 0.55 : mode === 'gold' ? 1.1 : 1.25 * energy;
    for (let y = 0; y < PH; y++) {
      const warp = Math.sin(y * 0.045 + t * 1.3 * energy) * (mode === 'sleep' ? 10 : 16) + Math.sin(y * 0.11 - t * 2.1) * 4;
      for (let x = 0; x < PW; x++) {
        const u = x + warp, v = y;
        let f;
        if (mode === 'sleep') f = Math.sin(u * 0.035 + Math.sin(v * 0.04 + t * 0.6) * 1.6) + Math.sin(v * 0.05 - t * 0.4);
        else if (mode === 'gold') { const dx = u - 240, dy = v - 110; f = Math.atan2(dy, dx) * 3.2 + Math.hypot(dx, dy) * 0.012; }
        else if (mode === 'teal') f = ((Math.floor(u / 12) + Math.floor(v / 12)) & 1) * 1.5 + Math.sin((u + v) * 0.05) * 1.2;
        else f = (u * 0.028 + v * 0.016) + Math.sin(v * 0.05 + t * 0.9) * 0.9 + Math.sin(u * 0.02 - t * 0.5) * 0.6;
        const idx = ((Math.floor(f * 2.2 + t * sp * 3) % n) + n) % n;
        const k = (y * PW + x) * 4;
        let r = pal[idx][0], g = pal[idx][1], b = pal[idx][2];
        if (pal2 && mix > 0) {
          const j = ((Math.floor(f * 2.2 + t * sp * 3) % n2) + n2) % n2;
          // ordered-dither cross fade keeps it pixel-art (no blended colours)
          const th = BAYER[(y & 3) * 4 + (x & 3)];
          if (mix > th) { r = pal2[j][0]; g = pal2[j][1]; b = pal2[j][2]; }
        }
        d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    return c;
  };
  return { c, draw };
}
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

/** Ordered-dither fill (0..1) with a cached 4×4 Bayer pattern (16 levels) — crisp and cheap. */
const ditherPatterns = new Map();
function ditherPattern(ctx, color, amount) {
  const lv = Math.round(clamp(amount) * 16);
  if (lv <= 0) return null;
  const key = color + '|' + lv;
  if (!ditherPatterns.has(key)) {
    const { c, ctx: pc } = canvas(4, 4);
    pc.fillStyle = color;
    for (let i = 0; i < 16; i++) if (lv / 16 > BAYER[i]) pc.fillRect(i % 4, Math.floor(i / 4), 1, 1);
    ditherPatterns.set(key, ctx.createPattern(c, 'repeat'));
  }
  return ditherPatterns.get(key);
}
export function ditherFill(px, x, y, w, h, color, amount) {
  const pat = ditherPattern(px.ctx, color, amount);
  if (!pat) return;
  px.ctx.fillStyle = pat;
  px.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
export function ditherScreen(px, color, amount) { ditherFill(px, 0, 0, PW, PH, color, amount); }

/** Deterministic pixel particles: returns positions for a burst at time q (seconds since burst). */
export function burstParticles(seed, n, q, { speed = 90, grav = 120, spread = Math.PI * 2, dir = -Math.PI / 2 } = {}) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const a = dir + (r() - 0.5) * spread, v = speed * (0.4 + r() * 0.8);
    out.push([Math.cos(a) * v * q, Math.sin(a) * v * q + 0.5 * grav * q * q, r()]);
  }
  return out;
}
