import { mascotMarkup } from './brand.js';

// One original RPG scene and score, shared by the film and generated hero SVG.
export const GAME_LOOP = 12;
const INK = '#203037';
const round = n => Math.round(n * 100) / 100;
const clamp = n => Math.min(1, Math.max(0, n));
const ease = n => { const t = clamp(n); return t * t * (3 - 2 * t); };

export function gameMarkup(prefix) {
  const tree = (x,y,s=1) => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cy="65" rx="73" ry="23" fill="#31594b" opacity=".18"/><path d="M-7 9h14v57H-7Z" fill="#816947"/><path d="M-69 12q-2-48 38-46 6-66 54-38 43-3 40 40 42 36 4 65-24 24-57 3-46 13-79-24Z" fill="#428570"/><path d="M-58-6q-9-32 29-32 11-45 44-34 37 8 35 35-21 29-47 14-20 36-61 17Z" fill="#72aa7e"/></g>`;
  return `<style>${Object.entries(poses(6.8)).map(([key,value])=>`#${prefix}-${key}{transform:${value}}`).join('')}</style><rect width="1600" height="900" fill="#bbd596"/>
    <path d="M0 0h1600v240q-263-98-520-33T480 181 0 280Z" fill="#91b780"/>
    <path d="M0 567q224-38 290 148t227 185H0Z" fill="#91c9c6"/>
    <path d="M0 558q224-38 299 158t230 184" fill="none" stroke="#eef0bd" stroke-width="18"/>
    <g id="${prefix}-water" fill="none" stroke="#d4ece0" stroke-width="5" stroke-linecap="round"><path d="M33 690h102m-75 60h109m50 90h111M28 845h76"/></g>
    <path d="M436 934q78-205 231-276t386-179 230-229" fill="none" stroke="#d7cc99" stroke-width="94"/>
    <path d="M436 934q78-205 231-276t386-179 230-229" fill="none" stroke="#e9dfb1" stroke-width="65"/>
    <g fill="#a3bd7c">${[[391,330,230,100],[740,167,220,72],[1110,740,310,90]].map(([x,y,rx,ry])=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>`).join('')}</g>
    <g fill="none" stroke="#86aa74" stroke-width="5" stroke-linecap="round">${[[330,400],[580,302],[910,699],[1080,643],[715,786],[1440,566],[469,626]].map(([x,y])=>`<path d="m${x} ${y} -5-12m11 11 5-15m7 18 6-9"/>`).join('')}</g>
    <g transform="translate(1240 276)"><ellipse cy="83" rx="150" ry="32" fill="#31594b" opacity=".16"/>
      <path d="M-114 82V-97q0-41 40-41H71q40 0 40 41V82H63V-85H-65V82Z" fill="#758d83"/>
      <path d="M-105 67V-102q0-26 29-26H73q29 0 29 26v24H-105Z" fill="#b5c6aa"/>
      <path d="M-63-78H63V74H-63Z" fill="#355e56"/>
      <path d="m0-111 11 15-11 15-11-15Z" fill="#e9dfb1"/>
      <path d="m-104 8 35 1m35-125 4 36m73-33-7 36m68 6-35 2" stroke="#607f73" stroke-width="4"/>
      <path d="m-122 64 25-3 8 21h-42Zm218 13 17-19 24 13 6 16h-48Z" fill="#9eaf99"/></g>
    ${tree(172,302,1.35)}${tree(380,155,.92)}${tree(1460,335,1.2)}${tree(969,96,.9)}
    <g id="${prefix}-flowers" fill="#faf5e7">${[[467,205],[478,222],[745,717],[777,745],[1340,661],[1370,679]].map(([x,y])=>`<path d="m${x} ${y} -7-5 1-7 7 3 5-5 5 4-4 7 6 4-3 5-7-3-5 4-5-5Z"/>`).join('')}</g>
    <g transform="translate(1028 477)"><ellipse cy="63" rx="87" ry="21" fill="#31594b" opacity=".18"/>
      <path d="m-66 5 115 29 36-38-114-29Z" fill="#503e36" stroke="#f0c66d" stroke-width="7" stroke-linejoin="round"/>
      <path d="m-66 5 115 29v47L-66 52Z" fill="#b37748"/><path d="m49 34 36-38v47L49 81Z" fill="#805337"/>
      <path d="m-45 13v45m70-27v45" stroke="#edbf64" stroke-width="11"/><path d="m-64 49 112 28 35-37" fill="none" stroke="#d9a34f" stroke-width="5"/>
      <path d="m-29 20 45 12v8l-45-12Z" fill="#996139"/><path d="m-15 20 20 5v24l-20-5Z" fill="#ffe1a0"/><path d="m-7 30 5 1v8l-5-1Z" fill="#815b37"/>
      <g transform="translate(-29 -33) rotate(14)"><g id="${prefix}-lid">
        <path d="M0 0h119l-26 46H-27Z" fill="#c58950" stroke="#f0c66d" stroke-width="6" stroke-linejoin="round"/>
        <path d="M21 1-5 45m97-44L66 45" stroke="#ffe1a0" stroke-width="11"/>
        <path d="M44 10h29l-12 24H31Z" fill="#a86f45"/>
      </g></g>
    </g>
    <ellipse id="${prefix}-shadow" rx="46" ry="13" fill="#31594b" opacity=".22"/>
    <g id="${prefix}-player" style="color:${INK}"><g transform="translate(-36 -44) scale(2.4)"><rect x="1" y="13" width="10" height="14" rx="3" fill="#db8755"/>${mascotMarkup(prefix+'-hero','#faf5e7')}</g></g>
    <g id="${prefix}-treasure"><circle r="53" fill="#fff3bd" opacity=".22"/><path d="m0-31 24 31-24 31-24-31Z" fill="#ffe391" stroke="#bb8537" stroke-width="3"/><path d="m0-31 0 62-24-31Z" fill="#fff5cd"/><path d="m-45-8-12-6m11 37-10 9m102-40 12-6m-11 37 10 9M0-55v-12" stroke="#fff5ce" stroke-width="5" stroke-linecap="round"/></g>
    ${tree(1435,779,1.6)}${tree(744,952,1.22)}
    <g transform="translate(1415 94)" stroke="#faf5e7" stroke-width="4" fill="none"><circle r="32"/><path d="m0-19 8 19-8 19-8-19Z" fill="#faf5e7"/><path d="M0-41v-8m41 49h8m-49 41v8m-41-49h-8"/></g>`;
}

export function poses(time) {
  const p = time === GAME_LOOP ? 1 : ((time % GAME_LOOP) + GAME_LOOP) % GAME_LOOP / GAME_LOOP;
  const walk = ease(p / .67), back = ease((p - .88) / .12);
  const progress = walk * (1-back);
  const x = 567 + 364 * progress, y = 684 - 169 * progress;
  const bounce = Math.sin(progress * Math.PI * 22);
  const reveal = ease((p - .7) / .05) * (1-ease((p - .855) / .025));
  return {
    water:`translate(${round(Math.sin(p*Math.PI*2)*14)}px,0px)`,
    flowers:`skewX(${round(Math.sin(p*Math.PI*2)*3)}deg)`,
    shadow:`translate(${round(x)}px,${round(y+19)}px)`,
    player:`translate(${round(x)}px,${round(y-3*Math.abs(bounce))}px) rotate(${round(bounce*3)}deg)`,
    lid:`scaleY(${round(1-ease((p-.68)/.035)*(1-ease((p-.86)/.025))*1.7)})`,
    treasure:`translate(1028px,${round(457-105*ease((p-.7)/.08))}px) scale(${round(reveal)})`,
  };
}

export function createGame(svg,prefix) {
  const nodes=Object.fromEntries(Object.keys(poses(0)).map(key=>[key,svg.querySelector(`#${prefix}-${key}`)]));
  return time=>{ for(const [key,transform] of Object.entries(poses(time))) nodes[key].style.transform=transform; };
}
