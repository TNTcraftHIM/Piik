import { mascotMarkup } from '../../assets/brand.js';
import { COLOURS } from './cast.js';

export const C = { ink: '#192530', paper: '#f6f2e8', blue: '#3568f4', yellow: '#ffd05a', purple: '#b7a0ee', pink: '#ff9297', white: '#fffdf5' };
export const clamp = n => Math.min(1, Math.max(0, n));
export const ease = n => 1 - (1 - clamp(n)) ** 4;
export const spring = n => { const t = clamp(n); return 1 - Math.exp(-8 * t) * Math.cos(t * 10); };
export const mix = (a, b, p) => a + (b - a) * p;
export const r = (x, y, w, h, fill, rx = 0, more = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${more}/>`;
export const circle = (x, y, radius, fill, more = '') => `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" ${more}/>`;
export const path = (d, fill, more = '') => `<path d="${d}" fill="${fill}" ${more}/>`;
export const group = (transform, content, extra = '') => `<g transform="${transform}" ${extra}>${content}</g>`;
export const text = (x, y, value, size = 100, color = C.ink, more = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" class="display" ${more}>${value}</text>`;
export const small = (x, y, value, size = 24, color = C.ink, more = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" class="label" ${more}>${value}</text>`;
export const english = (x, y, value, size = 100, color = C.ink, more = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" class="latin" ${more}>${value}</text>`;
export const background = color => r(0, 0, 1600, 900, color);
export const star = (x, y, size, fill = C.yellow, angle = 0) => group(`translate(${x} ${y}) rotate(${angle}) scale(${size / 100})`, path('M0-100 23-23 100 0 23 23 0 100-23 23-100 0-23-23Z', fill));
export const headline = (x, y, value, size, color, beat, delay = 0) => group(`translate(${x} ${y})`, [...value].map((glyph, i) => {
  const p = ease((beat - delay - i * .12) / .7);
  return group(`translate(${i * size * .955} ${(1 - p) * 90}) rotate(${(1 - p) * -9})`, text(0, 0, glyph, size, color), `opacity="${p}"`);
}).join(''));

export function defs(id) {
  return `<defs><pattern id="${id}-dots" width="15" height="15" patternUnits="userSpaceOnUse">${circle(3, 3, 1.6, C.ink)}</pattern>
  <pattern id="${id}-lines" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M0 0v16" stroke="${C.ink}" stroke-width="3"/></pattern></defs>`;
}

export function pawn(x, y, scale, actor, time, { talking = false, tilt = 0, eyes = 0 } = {}) {
  const colour = COLOURS[actor];
  const blink = Math.sin(time * 1.9 + actor * 2.1) > .989;
  const bob = talking ? Math.sin(time * 22) * 1.5 : Math.sin(time * 2.2 + actor) * .8;
  const mouth = talking ? `<ellipse cy="-22" rx="2.2" ry="${1.5 + Math.abs(Math.sin(time * 25)) * 2}" fill="${C.ink}"/>` : '';
  return group(`translate(${x} ${y + bob * scale}) rotate(${tilt}) scale(${scale})`,
    path('M-35 52c0-33 12.5-50 35-50s35 17 35 50q0 7-7.5 7h-55Q-35 59-35 52Z', colour) +
    circle(0, -31, 20, colour) + group(`translate(${eyes} 0)`,
      `<ellipse cx="-7" cy="-31" rx="2.6" ry="${blink ? .7 : 3.3}" fill="${C.ink}"/><ellipse cx="7" cy="-31" rx="2.6" ry="${blink ? .7 : 3.3}" fill="${C.ink}"/>${mouth}`) +
    (actor === 0 ? path('M-14-61-18-75-6-69 0-78 6-69 18-75 14-61Z', C.yellow, `stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"`) : ''));
}

export function sofa(x, y, w, fill = C.yellow) {
  return group(`translate(${x} ${y})`,
    path(`M42 137v26M${w - 42} 137v26`, 'none', `stroke="${C.ink}" stroke-width="9" stroke-linecap="round"`) +
    r(0, 0, w, 145, fill, 32, `stroke="${C.ink}" stroke-width="4"`) +
    r(16, 98, w - 32, 38, '#00000012', 15) +
    path(`M33 95H${w - 33}`, 'none', `stroke="${C.ink}" stroke-width="3" opacity=".25"`) +
    r(-14, 55, 42, 82, fill, 18, `stroke="${C.ink}" stroke-width="4"`) +
    r(w - 28, 55, 42, 82, fill, 18, `stroke="${C.ink}" stroke-width="4"`));
}

export function room(x, y, w, actor, time, fill = C.paper, angle = 0) {
  const h = w * 1.06;
  return group(`translate(${x} ${y}) rotate(${angle} ${w / 2} ${h / 2})`,
    r(10, 13, w, h, C.ink, 3) + r(0, 0, w, h, fill, 3, `stroke="${C.ink}" stroke-width="4"`) +
    r(26, 25, w - 52, 20, C.ink) +
    r(w * .61, 76, w * .27, h * .28, C.blue, 0) +
    path(`M${w * .745} 76v${h * .28}M${w * .61} ${76 + h * .14}h${w * .27}`, 'none', `stroke="${fill}" stroke-width="4"`) +
    r(28, h - 54, w - 56, 6, C.ink) +
    pawn(w * .31, h * .62, w / 190, actor, time, { eyes: 2 }) +
    r(w * .54, h * .62, w * .34, 8, C.ink) +
    path(`M${w * .58} ${h * .63}v${h * .2}M${w * .84} ${h * .63}v${h * .2}`, 'none', `stroke="${C.ink}" stroke-width="5"`) +
    r(w * .57, h * .43, w * .28, h * .17, C.ink, 4) +
    r(w * .585, h * .444, w * .25, h * .135, actor === 1 ? C.yellow : C.purple, 2) +
    r(19, h - 38, 100, 27, C.paper, 3) +
    small(28, h - 19, ['房主', '朋友 A', '朋友 B'][actor], 17));
}

export function speech(x, y, value, scale = 1, fill = C.paper, angle = 0) {
  const width = Math.max(140, [...value].length * 33 + 65);
  return group(`translate(${x} ${y}) rotate(${angle}) scale(${scale})`,
    path(`M0 0H${width}V77H70L45 102V77H0Z`, fill, `stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"`) +
    text(28, 51, value, 32, C.ink));
}

export function brand(x, y, scale = 1, fill = C.paper, id = 'brand') {
  return group(`translate(${x} ${y}) scale(${scale})`,
    group('translate(-32 -124) scale(4.1)', mascotMarkup(id), `color="${fill}"`) +
    `<text x="126" y="0" font-family="Arial,sans-serif" font-weight="900" font-size="140" letter-spacing="-8" fill="${fill}">Piik<tspan fill="${C.yellow}">.</tspan></text>`);
}

export function cursor(x, y, scale, fill = C.yellow, angle = 0) {
  return group(`translate(${x} ${y}) rotate(${angle}) scale(${scale})`, path('M0 0v73l19-18 15 32 17-8-15-31 28-2Z', fill, `stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"`));
}

export function wave(x, y, width, height, time, fill = C.blue, count = 20) {
  return group(`translate(${x} ${y})`, Array.from({ length: count }, (_, i) => {
    const h = height * (.18 + .7 * Math.abs(Math.sin(i * .75 + time * 8)) * Math.sin((i + 1) / (count + 1) * Math.PI));
    return r(i * width / count, -h / 2, width / count * .45, h, fill, width / count * .2);
  }).join(''));
}

export function confetti(x, y, progress, seed = 0) {
  return Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16 * Math.PI * 2 + seed), d = ease(progress) * (190 + i % 4 * 60);
    const yy = y + Math.sin(a) * d + progress * progress * 110;
    return group(`translate(${x + Math.cos(a) * d} ${yy}) rotate(${i * 31 + progress * 150})`,
      r(-6, -12, 12, 24, [C.yellow, C.blue, C.paper, C.purple][i % 4]), `opacity="${1 - clamp((progress - .6) / .4)}"`);
  }).join('');
}

export function footer(label, color = C.ink) {
  return small(68, 868, 'PIIK / ' + label, 18, color);
}

export function uiFrame(x, y, w, h, fill = C.paper) {
  return r(x + 12, y + 14, w, h, C.ink, 12) +
    r(x, y, w, h, fill, 12, `stroke="${C.ink}" stroke-width="4"`) +
    [0, 1, 2].map(i => circle(x + 23 + i * 17, y + 23, 4, C.ink)).join('') +
    small(x + w / 2, y + 30, 'Piik', 19, C.ink, 'text-anchor="middle"');
}
