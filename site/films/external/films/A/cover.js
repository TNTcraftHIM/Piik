import { C, mascot, person, sofa } from '../../engine/art.js';
import { paperURL } from '../../engine/tex.js';
import { loadFonts } from '../../engine/fonts.js';
import { meta } from './film.js';
import { game } from './game.js';
import { STRINGS } from './strings.js';

const cover = document.querySelector('#cover');
const classic = new URLSearchParams(location.search).get('ratio') === '4:3';
cover.classList.toggle('classic', classic);
for (const name of ['green', 'blue']) cover.style.setProperty(`--${name}`, C[name]);
const brand = mascot({ size: 118, stroke: C.ink, sparkles: false });
document.querySelector('.brand-art').append(brand.el);
document.querySelector('.paper').style.backgroundImage = `url(${paperURL()})`;
const audience = document.querySelector('.audience');
const seats = sofa({ width: 610, color: C.cream });
seats.el.setAttribute('transform', 'translate(55 135)');
audience.append(seats.el);
for (const [index, color] of [C.green, C.blue, C.purple].entries()) {
  const friend = person({ color });
  friend.set({ x: 200 + index * 160, y: 200, s: 1.45, eyes: index === 1 ? 'happy' : 'open', tilt: index === 1 ? 0 : (index - 1) * 6 });
  audience.append(friend.el);
}

await loadFonts(meta, 'zh');
await document.fonts.load('900 232px "Cover Sans"');
const play = game(document.querySelector('.game'), { S: STRINGS.zh });
play.el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
play.fight(1.25, {
  x1: 520, x2: 1020, y1: 75, y2: 0, lean1: 14, lean2: -8,
  sw1: -20, sw2: -50, e1: 'happy', e2: 'squeeze', hp1: .76, hp2: .9,
  hit: { x: 790, y: 290, p: .22, s: .72, text: 'BONK!' },
  feathers: { t0: 1, x: 860, y: 420 }, timer: 88,
});
function fit() {
  const width = classic ? 1440 : 1920;
  const scale = Math.min(innerWidth / width, innerHeight / 1080);
  cover.style.transform = `scale(${scale})`;
  cover.style.left = `${(innerWidth - width * scale) / 2}px`;
  cover.style.top = `${(innerHeight - 1080 * scale) / 2}px`;
}
addEventListener('resize', fit);
fit();
document.body.dataset.ready = 'true';
