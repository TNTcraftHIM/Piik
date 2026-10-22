import { C, r, path, group, text, small, english, star, clamp } from './drawing.js';
import { COLOURS } from './cast.js';
import { tiles, actors } from './party-sprites.js';
import { PARTY, poseAt } from './party-score.js';

const tile = (column, row, x, y, size = 54) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${column * 18} ${row * 18} 18 18" overflow="hidden"><use href="#party-tiles"/></svg>`;
const character = (actor, x, y, frame, size = 96) =>
  `<svg x="${x - size / 2}" y="${y - size}" width="${size}" height="${size}" viewBox="${(actor * 2 + frame) * 24} 0 24 24" overflow="hidden"><use href="#party-actors"/></svg>`;

function island(x, y, columns, rows) {
  let art = '';
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    art += tile(row === 0 ? col === 0 ? 0 : col === columns - 1 ? 3 : 1 : 4 + (col + row) % 2,
      row === 0 ? 0 : 1, x + col * 54, y + row * 54);
  }
  return art;
}

const platforms = island(40, 670, 6, 5) + island(435, 565, 5, 7) +
  island(805, 450, 5, 9) + island(1165, 565, 7, 7) + island(700, 760, 2, 3);

// An authored, seekable platform-race scene, not a network/performance recording.
// The source thumbnail and the large action shot render this same scene.
export function partyMarkup(beat = 0, waiting = false, id = 'party') {
  const b = waiting ? 0 : beat, won = b >= PARTY.goal;
  let art = r(0, 0, 1600, 900, '#bde7ed');
  for (let i = 0; i < 8; i++) {
    const x = i * 239 - 80 - Math.sin(b * .08) * 12;
    art += path(`M${x} 700v-215h45v-66h63v66h50v104h55v111Z`, '#a4d0d5');
  }
  for (const [x, y, s] of [[100, 220, 100], [440, 340, 80], [650, 190, 110], [1220, 275, 100], [1450, 160, 75]]) {
    art += group('', tile(14, 7, x + Math.sin(b * .07) * 12, y, s) + tile(15, 7, x + s, y, s), 'opacity=".45"');
  }
  art += platforms;
  art += tile(8, 4, 267, 616) + tile(5, 6, 94, 616) + tile(6, 6, 1500, 511) +
    tile(6, 6, 480, 511) + tile(8, 6, 970, 396);
  const flagWave = Math.sin(b * 3) * 6;
  art += r(1435, 369, 9, 196, '#36435b') +
    path(`M1444 373h95v49l-95 ${flagWave}Z`, won ? COLOURS[1] : '#f2c44e') +
    r(1421, 555, 40, 10, '#36435b');
  const hazardX = 1000 + Math.sin((b - 10.5) * 1.4) * 37;
  art += `<svg x="${hazardX - 36}" y="378" width="72" height="72" viewBox="144 24 24 24" overflow="hidden"><use href="#party-actors"/></svg>`;
  for (let i = 0; i < 3; i++) {
    const collector = poseAt(i < 2 ? 0 : 1, PARTY.coins[i]);
    const x = collector.x - 22, y = collector.y - 65;
    const collected = !waiting && b > PARTY.coins[i];
    if (!collected) art += tile(12, 7, x, y + Math.sin(b * 2 + i) * 6, 45);
    else if (b < PARTY.coins[i] + .8) art += star(x + 22, y + 22, 65 * (1 - (b - PARTY.coins[i]) / .8), C.yellow, b * 20);
  }
  for (const actor of [0, 1]) {
    const pose = poseAt(actor, b);
    if (waiting && actor === 1) {
      art += r(pose.x - 43, pose.y - 90, 86, 90, '#ffffff55', 12,
        'stroke="#56879a" stroke-width="4" stroke-dasharray="9 9"') +
        english(pose.x, pose.y - 20, '?', 62, '#56879a', 'text-anchor="middle"');
      continue;
    }
    const foot = pose.y, stride = Math.floor(b * 4) % 2;
    const squish = pose.landing ? Math.max(0, 1 - pose.landing / .35) : 0;
    const rotation = actor === 0 && b >= 10.5 && b < 13.5 ? (b - 10.5) * 150 : 0;
    art += `<ellipse cx="${pose.x}" cy="${foot + 5}" rx="37" ry="8" fill="#1e5361" opacity=".15"/>` +
      group(`translate(${pose.x} ${foot}) rotate(${rotation}) scale(${1 + squish * .12} ${1 - squish * .12})`,
        character(actor, 0, 0, stride)) +
      group(`translate(${pose.x} ${foot - 111})`, r(-40, -20, 80, 29, C.ink, 3) +
        small(0, 1, actor ? '2P' : '1P', 21, actor ? '#aacfff' : '#bcf2bc', 'text-anchor="middle"'));
    if (actor === 0 && b >= 10.5 && b < 11.3) art += star(pose.x, foot - 48, 100 * (1 - (b - 10.5) / .8), '#fff7d2', b * 35);
  }
  art += r(0, 0, 1600, 110, '#213449') +
    character(0, 65, 81, 0, 60) + small(111, 61, '阿团 · 1P', 29, C.paper) +
    character(1, 1400, 81, 0, 60) + small(1445, 61, waiting ? '等你' : '小圆', 29, C.paper) +
    text(800, 64, waiting ? '跳跳派对 · 双人夺旗' : '先碰到旗子就赢！', 36, C.paper, 'text-anchor="middle"') +
    small(800, 96, waiting ? '1P READY       2P ？' : won ? '2P WINS!' : 'ROUND 01', 18, '#bde7ed', 'text-anchor="middle"');
  if (won) {
    for (let i = 0; i < 18; i++) {
      const p = clamp((b - PARTY.goal) / 3), a = i * 2.4, dist = p * (180 + i * 9);
      art += r(1440 + Math.cos(a) * dist, 385 + Math.sin(a) * dist + p * p * 180,
        9, 14, [C.yellow, C.blue, C.paper, '#ef3f56'][i % 4]);
    }
  }
  const sprites = `<defs><image id="${id}-tiles" href="${tiles}" width="360" height="162" style="image-rendering:pixelated"/><image id="${id}-actors" href="${actors}" width="216" height="72" style="image-rendering:pixelated"/></defs>`;
  return sprites + group('', art.replaceAll('#party-', `#${id}-`), 'font-family="StudyDisplay,Segoe UI,Microsoft YaHei,sans-serif" font-weight="700"');
}

export function arena(x, y, w, beat, waiting = false, id = 'party') {
  return group(`translate(${x} ${y}) scale(${w / 1600})`, partyMarkup(beat, waiting, id));
}
