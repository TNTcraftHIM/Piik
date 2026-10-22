// Procedural textures (film grain, paper fibre, stamp grunge) generated with canvas at start-up.
// No image files to download, identical in offline renders and live playback (seeded RNG).
import { h, rng, hash } from './core.js';

const cache = {};
function canvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  return c;
}
function valueNoise(w, hgt, cell, seed) {
  // tileable value noise sampled on a cell grid, bilinear with smoothstep
  const gw = Math.ceil(w / cell), gh = Math.ceil(hgt / cell);
  const r = rng(seed), g = new Float32Array(gw * gh).map(() => r());
  const out = new Float32Array(w * hgt);
  for (let y = 0; y < hgt; y++) {
    const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
    const y0 = (iy % gh) * gw, y1 = ((iy + 1) % gh) * gw;
    for (let x = 0; x < w; x++) {
      const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
      const x0 = ix % gw, x1 = (ix + 1) % gw;
      const a = g[y0 + x0] + (g[y0 + x1] - g[y0 + x0]) * sx;
      const b = g[y1 + x0] + (g[y1 + x1] - g[y1 + x0]) * sx;
      out[y * w + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/**
 * Mid-grey film-grain tile (for overlay / soft-light blending). Soft gaussian grain (sigma ~ 0.09 around 0.5) with a light
 * [k 1 k] wrap-around blur so neighbouring grains clump a little: reads as film rather than digital noise, and keeps
 * video encoders from spending their bits on per-pixel noise. Same statistics as the original grain PNGs.
 */
export function grainURL(size = 384, seed = 11, sigma = 0.092) {
  const k = `grain${size}_${seed}_${sigma}`;
  if (cache[k]) return cache[k];
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), r = rng(seed);
  const n = size * size, a = new Float32Array(n), b = new Float32Array(n), K = 0.17;
  for (let i = 0; i < n; i++) a[i] = r() + r() + r() + r() - 2; // ~gaussian
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) b[row + x] = a[row + x] + K * (a[row + (x + size - 1) % size] + a[row + (x + 1) % size]);
  }
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size, dn = ((y + 1) % size) * size, row = y * size;
    for (let x = 0; x < size; x++) a[row + x] = b[row + x] + K * (b[up + x] + b[dn + x]);
  }
  let s2 = 0;
  for (let i = 0; i < n; i++) s2 += a[i] * a[i];
  const g = sigma / Math.sqrt(s2 / n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, Math.round((0.5 + a[i] * g) * 255)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return (cache[k] = c.toDataURL('image/png'));
}

/** Warm paper fibres: transparent tile with faint light/dark fibres. */
export function paperURL(size = 512, seed = 5) {
  const k = `paper${size}_${seed}`;
  if (cache[k]) return cache[k];
  const c = canvas(size, size), ctx = c.getContext('2d'), r = rng(seed);
  for (let i = 0; i < 1400; i++) {
    const x = r() * size, y = r() * size, L = 4 + r() * 22, a = r() * Math.PI;
    ctx.strokeStyle = r() < 0.5 ? `rgba(60,45,30,${0.05 + r() * 0.08})` : `rgba(255,255,255,${0.1 + r() * 0.15})`;
    ctx.lineWidth = 0.6 + r() * 0.8;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); ctx.stroke();
  }
  for (let i = 0; i < 2600; i++) { ctx.fillStyle = `rgba(80,60,40,${r() * 0.07})`; ctx.fillRect(r() * size, r() * size, 1, 1); }
  return (cache[k] = c.toDataURL('image/png'));
}

/** Rubber-stamp ink mask: opaque with speckled and streaky holes (use as mask-image). */
export function grungeURL(size = 600, seed = 7) {
  const k = `grunge${size}_${seed}`;
  if (cache[k]) return cache[k];
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  const n1 = valueNoise(size, size, 6, seed), n2 = valueNoise(size, size, 2, seed + 1), r = rng(seed + 2);
  for (let i = 0; i < size * size; i++) {
    const v = n1[i] * 0.7 + n2[i] * 0.3;
    const hole = v > 0.66 || r() > 0.972;
    img.data[i * 4 + 3] = hole ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);
  return (cache[k] = c.toDataURL('image/png'));
}

/**
 * Full-frame animated grain layer. Uses one tile and shifts an oversized child with transforms,
 * so it stays compositor-friendly in live playback. Returns update(t).
 */
export function grainLayer(root, { W, H, opacity = 0.13, blend = 'overlay', fps = 24, size = 384 } = {}) {
  const box = h('div', { class: 'fill pk-grain' }, root);
  Object.assign(box.style, { overflow: 'hidden', mixBlendMode: blend, opacity, pointerEvents: 'none' });
  const g = h('div', { class: 'abs' }, box);
  Object.assign(g.style, { width: W + size + 'px', height: H + size + 'px', backgroundImage: `url(${grainURL(size)})`, backgroundSize: `${size}px ${size}px`, willChange: 'transform' });
  return t => {
    const f = Math.floor(t * fps);
    const x = Math.floor(hash(f * 2 + 1) * size), y = Math.floor(hash(f * 2 + 2) * size);
    g.style.transform = `translate(${-x}px, ${-y}px)`;
  };
}
