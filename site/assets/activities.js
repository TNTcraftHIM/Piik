import { gameMarkup, poses } from './game.js';
import { sketchMarkup } from './sketch.js';

// Original screen content shared by the film and the standalone room image.
const INK = '#203037', PAPER = '#faf5e7';
export const HERO_KINDS = ['rpg', 'drawing', 'photos', 'movie'];
export const HERO_CUT = 5;

export function photoMarkup() {
  return `<rect width="1600" height="900" fill="${INK}"/>
    <g transform="translate(206 72) rotate(-12 410 300)">
      <rect width="820" height="645" rx="12" fill="${PAPER}"/><rect x="24" y="24" width="772" height="516" rx="3" fill="#a6ced3"/>
      <circle cx="641" cy="144" r="63" fill="#f3cc68"/><path d="M24 496 264 143 470 425 648 254 796 454v86H24Z" fill="#719585"/><path d="m160 298 104-155 113 155-65-29-45 32-45-25Z" fill="${PAPER}"/>
    </g>
    <g transform="translate(644 245) rotate(9 360 255)">
      <rect width="720" height="562" rx="12" fill="${PAPER}"/><rect x="24" y="24" width="672" height="440" rx="3" fill="#b8dce0"/>
      <path d="M24 206h672v258H24Z" fill="#639f9e"/><path d="M24 310q252-42 672 82v72H24Z" fill="#efd39a"/><path d="M24 288q252-42 672 82" fill="none" stroke="${PAPER}" stroke-width="13"/>
      <path d="m391 254 42-174 97 174Z" fill="${PAPER}"/><path d="m435 92 90 153h-90Z" fill="#f47843"/><path d="m365 268 182-2-34 29H394Z" fill="${INK}"/>
    </g>`;
}

export function movieMarkup(planeId) {
  return `<circle cx="1240" cy="264" r="143" fill="#f3cc68"/>
    <path d="M-80 810 335 337 651 747 916 412 1670 806v150H-80Z" fill="#527b87"/>
    <path d="m-80 913 646-375 304 283 413-338 453 496Z" fill="#263b4b"/>
    ${[160,393,640,980,1450].map((x,i)=>`<circle cx="${x}" cy="${141+i%3*73}" r="3" fill="${PAPER}"/>`).join('')}
    <g id="${planeId}"><path d="m0 0 198-61-74 106-30-42-94-3Z" fill="${PAPER}"/><path d="m198-61-104 64 1 40 29-19" fill="#aac8c9"/></g>`;
}

export function moviePlanePose(progress) {
  const p = 1 - (1 - Math.min(1, Math.max(0, progress))) ** 4;
  return `translate(${935+255*p}px,${601-226*p}px) rotate(-8deg)`;
}

export function heroMarkup() {
  return `<g id="activity-rpg">${gameMarkup('hero-rpg')}</g>
    <g id="activity-drawing">
      <rect width="1600" height="900" fill="#f3cc68"/>
      <path d="M-130 750Q220-60 600 580T1720 300" fill="none" stroke="#f47843" stroke-width="190"/>
      <g id="hero-paper"><g transform="translate(490 85) rotate(8 310 360)">${sketchMarkup('hero-sketch')}</g></g>
      <g id="hero-pencil"><path d="M-11-255h22v217l-11 38-11-38Z" fill="${INK}"/><path d="m-11-38 11 38 11-38Z" fill="#d6b68b"/><path d="M-3-10 0 0 3-10Z" fill="${INK}"/><path d="M-4-240v188" stroke="${PAPER}" stroke-width="3"/></g>
    </g>
    <g id="activity-photos"><rect width="1600" height="900" fill="${INK}"/><g id="hero-photos">${photoMarkup()}</g></g>
    <g id="activity-movie"><rect width="1600" height="900" fill="#324458"/>${movieMarkup('hero-plane')}</g>`;
}

// The generator samples this score into CSS, so README images need no script.
export function heroFrame(kind, progress) {
  if (kind === 'rpg') return Object.fromEntries(Object.entries(poses(6.8+progress*3.45)).map(([id,transform])=>['hero-rpg-'+id,{transform}]));
  if (kind === 'drawing') return {
    'hero-paper': {transform:`translate(0px,${6*Math.sin(progress*Math.PI*2)}px)`},
    'hero-pencil': {transform:`translate(${1160+18*Math.sin(progress*Math.PI*2)}px,${660+10*Math.cos(progress*Math.PI*2)}px) rotate(${28+3*Math.sin(progress*Math.PI*2)}deg)`},
  };
  if (kind === 'photos') return {'hero-photos':{transform:`translate(800px,450px) scale(${.97+progress*.045}) translate(-800px,-450px)`}};
  return {'hero-plane':{transform:moviePlanePose(progress)}};
}
