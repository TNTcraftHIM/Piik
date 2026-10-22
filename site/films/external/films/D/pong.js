// The shared game: a 2-player pong drawn in the UI demo's own rally style (1600×900 viewBox), but animated,
// beat-synced and bilingual. Pure function of film time; the same state renders in the host's and the viewer's UI.
const INK = '#192530', FIELD = '#213a51', PAPER = '#f6f2e8', YELLOW = '#ffd05a';
export const P1C = 'oklch(0.7015 0.1204 148.3619)', P2C = 'oklch(0.7100 0.1156 235.7427)';
const S = 1.32, CX = 166, CY = 89, FW = 960, FH = 540, PAD_H = 90, PAD_W = 24 / S;
const LX = 8 / S + PAD_W, RX = 1238 / S; // paddle faces in field units

/** Rally script in film seconds (set by the film from its cue clock): serve, hits, the winning smash. */
export const RALLY = { join: 29.125, serve: 30, hits: [], miss: 0, out: 0, label: {} };

export function setRally(o) { Object.assign(RALLY, o); }

const ys = [270, 140, 395, 110, 430, 190, 350, 95, 455, 240, 160, 410];
function ballAt(t) {
  const H = RALLY.hits;
  if (!H.length || t < H[0].t) return { x: LX + 10, y: H.length ? H[0].y : 270, moving: false };
  for (let i = 0; i < H.length - 1; i++) {
    const a = H[i], b = H[i + 1];
    if (t <= b.t) {
      const p = (t - a.t) / (b.t - a.t);
      return { x: a.side === 'L' ? LX + (RX - LX) * p : RX - (RX - LX) * p, y: a.y + (b.y - a.y) * p, moving: true };
    }
  }
  // after the last hit: the smash flies past P1 and leaves the field
  const a = H[H.length - 1], dt = t - a.t, v = (RX - LX) / Math.max(0.2, RALLY.missDur || 0.5);
  const x = RX - v * dt, y = a.y + (RALLY.missY - a.y) * Math.min(1, dt / (RALLY.missDur || 0.5));
  return { x, y, moving: x > -40 };
}
function paddleY(side, t) {
  const H = RALLY.hits.filter(h => h.side === side);
  let target = FH / 2, last = null;
  for (const hh of H) {
    if (t < hh.t + 0.25) { target = hh.y; break; }
    last = hh;
  }
  const next = H.find(hh => t < hh.t + 0.25);
  if (!next) return last ? last.y + (FH / 2 - last.y) * Math.min(1, (t - last.t - 0.25) / 1.2) : FH / 2;
  const prev = H[H.indexOf(next) - 1];
  const from = prev ? prev.y : FH / 2, t0 = (prev ? prev.t + 0.25 : next.t - 1.2), t1 = next.t - 0.04;
  const p = Math.max(0, Math.min(1, (t - t0) / Math.max(0.05, t1 - t0)));
  const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  return from + (target - from) * e;
}
const star = (x, y, r, rot) => `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${(r / 100).toFixed(3)})"><path d="M0-100 23-23 100 0 23 23 0 100-23 23-100 0-23-23Z" fill="${YELLOW}"/></g>`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** SVG markup for the game at film time t. o: {t, lang, waiting?} */
export function pongSVG(o) {
  const t = o.t, L = RALLY.label[o.lang] || RALLY.label.zh || {};
  const waiting = t < RALLY.join;
  const joinK = Math.max(0, Math.min(1, (t - RALLY.join) / 0.3));
  const score = [0, t >= RALLY.out ? 1 : 0];
  let g = `<rect width="1600" height="900" fill="${INK}"/><rect x="${CX}" y="${CY}" width="1268" height="713" rx="10" fill="${FIELD}"/>`;
  g += `<path d="M800 ${CY}v713M${CX} ${CY}h1268v713H${CX}Z" fill="none" stroke="${PAPER}" stroke-width="3" stroke-dasharray="10 16" opacity=".35"/>`;
  g += `<circle cx="800" cy="445" r="160" fill="none" stroke="${PAPER}" stroke-width="2" opacity=".17"/>`;
  g += `<text x="180" y="50" fill="${P1C}" font-size="30" font-weight="800">${esc(L.p1 || '')}</text>`;
  g += `<text x="1418" y="50" fill="${waiting ? PAPER : P2C}" font-size="30" font-weight="800" text-anchor="end">${esc(waiting ? L.wait || '' : L.p2 || '')}</text>`;
  g += `<text x="712" y="209" fill="${PAPER}" font-size="100" font-weight="800" text-anchor="end">${score[0]}</text>`;
  g += `<text x="886" y="209" fill="${PAPER}" font-size="100" font-weight="800">${score[1]}</text>`;
  const p1y = paddleY('L', t), p2y = paddleY('R', t);
  g += `<rect x="${CX + 8}" y="${(CY + (p1y - PAD_H / 2) * S).toFixed(1)}" width="24" height="${PAD_H * S}" rx="7" fill="${P1C}"/>`;
  if (waiting) {
    g += `<rect x="${CX + 1238}" y="${CY + 225 * S}" width="24" height="${PAD_H * S}" rx="7" fill="none" stroke="${PAPER}" stroke-width="3" stroke-dasharray="8 9"/>`;
    g += `<g transform="translate(940 394)"><rect width="440" height="104" rx="14" fill="${PAPER}"/><text x="30" y="68" fill="${INK}" font-size="46" font-weight="800">${esc(L.waitBox || '')}</text></g>`;
  } else {
    const k = 1 + (1 - joinK) * 0.6 * Math.sin(joinK * Math.PI);
    const y = CY + (p2y - PAD_H / 2) * S, hh = PAD_H * S;
    g += `<rect x="${CX + 1238 - (k - 1) * 12}" y="${(y - (k - 1) * hh / 2).toFixed(1)}" width="${(24 * k).toFixed(1)}" height="${(hh * k).toFixed(1)}" rx="7" fill="${P2C}" opacity="${joinK.toFixed(2)}"/>`;
  }
  if (!waiting && t >= RALLY.serve - 0.6) {
    const b = t < RALLY.serve ? { x: LX + 12, y: RALLY.hits[0]?.y ?? 270, moving: false } : ballAt(t);
    if (b.moving) for (let i = 5; i >= 1; i--) {
      const q = t < RALLY.serve ? b : ballAt(t - i / 60);
      g += `<circle cx="${(CX + q.x * S).toFixed(1)}" cy="${(CY + q.y * S).toFixed(1)}" r="${10 - i}" fill="${YELLOW}" opacity="${(0.12 + 0.03 * (5 - i)).toFixed(2)}"/>`;
    }
    if (b.x > -30) g += `<circle cx="${(CX + b.x * S).toFixed(1)}" cy="${(CY + b.y * S).toFixed(1)}" r="12" fill="${YELLOW}"/>`;
    const hit = RALLY.hits.filter(hh => t >= hh.t).pop();
    if (hit) {
      const k = Math.max(0, 1 - (t - hit.t) / 0.19);
      if (k > 0) g += star(CX + (hit.side === 'L' ? LX : RX) * S, CY + hit.y * S, 70 * k, t * 900);
    }
  }
  if (t >= RALLY.out) {
    const k = Math.max(0, Math.min(1, (t - RALLY.out) / 0.25));
    g += `<g transform="translate(800 470) scale(${(0.6 + 0.4 * k).toFixed(3)})" opacity="${k.toFixed(2)}"><rect x="-260" y="-70" width="520" height="140" rx="70" fill="${YELLOW}"/><text y="26" text-anchor="middle" fill="${INK}" font-size="72" font-weight="900">${esc(L.point || '')}</text></g>`;
  }
  return `<g font-family="Segoe UI, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif">${g}</g>`;
}

/** Build the hit list from beat times (seconds). sides alternate starting with the serve by P1. */
export function rallyFromTimes(times) {
  return times.map((t, i) => ({ t, side: i % 2 ? 'R' : 'L', y: ys[i % ys.length] }));
}
