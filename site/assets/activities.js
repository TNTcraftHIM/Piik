import { gameMarkup, poses } from './game.js';
import { sketchMarkup } from './sketch.js';

// Original screen content shared by the film and the standalone room image.
const INK = '#203037', PAPER = '#faf5e7';
export const HERO_KINDS = ['rpg', 'drawing', 'photos', 'movie'];
export const HERO_CUT = 5;

export function photoMarkup() {
  return `<rect width="1600" height="900" fill="${INK}"/>
    <path d="M148 683q-49-268 192-414t595-108 502 112" fill="none" stroke="#6a8b80" stroke-width="5" stroke-dasharray="11 16"/>
    <path d="m1339 258 14 29 31 4-23 22 6 31-28-15-28 15 5-31-22-22 31-4Z" fill="#f3cc68"/>
    <path d="m236 696 153 23-21 117-153-23Z" fill="#df9c6c"/>
    <path d="m255 726 86 13m-90 10 70 11m-74 11 81 12" stroke="${INK}" stroke-width="6" opacity=".55"/>
    <text x="267" y="807" transform="rotate(9 267 807)" fill="${INK}" font-family="ui-monospace,monospace" font-size="25" font-weight="700">9527</text>
    <g transform="translate(206 72) rotate(-12 410 300)">
      <rect x="11" y="15" width="820" height="645" rx="12" fill="#111f26" opacity=".35"/>
      <rect width="820" height="645" rx="12" fill="${PAPER}"/>
      <svg x="24" y="24" width="772" height="516" viewBox="0 0 772 516" overflow="hidden">
        <rect width="772" height="516" fill="#b7d6d2"/>
        <circle cx="600" cy="106" r="62" fill="#f3cc68"/>
        <path d="M-45 375 197 94 381 327 529 157 826 455v100H-45Z" fill="#85a99a"/>
        <path d="m124 178 73-84 85 107-46-13-38 26-29-32Z" fill="${PAPER}"/>
        <path d="M-43 504 185 320 365 384 486 268 833 473v96H-43Z" fill="#557f70"/>
        <path d="M-60 438q178-51 316 11t296-4 268 21v90H-60Z" fill="#8caa79"/>
        <path d="m0 474 176-3 55-63 203-1 74 91 267-9v50H0Z" fill="#c9c399"/>
        <g transform="translate(275 351) rotate(-5)"><path d="M-29 62q0-70 29-70t29 70Z" fill="#8ebbd6"/><circle cy="-33" r="23" fill="#8ebbd6"/><path d="M-29-45q29-39 58 0Z" fill="#e9d2a0"/><path d="M-38-43h76" stroke="#c6a774" stroke-width="8" stroke-linecap="round"/><path d="M-7-31v3m14-3v3" stroke="${INK}" stroke-width="4" stroke-linecap="round"/></g>
        <g transform="translate(348 365) rotate(9)"><path d="M-27 53q0-60 27-60t27 60Z" fill="#d6958c"/><circle cy="-31" r="22" fill="#d6958c"/><path d="M-8-30v3m15-3v3" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><circle cx="45" cy="-40" r="7" fill="#d6958c"/><path d="m40-45 4-11m5 14 9-5" stroke="#d6958c" stroke-width="6" stroke-linecap="round"/></g>
        <g transform="translate(138 437) rotate(22)"><path d="M-22 45q0-52 22-52t22 52Z" fill="#e8bf6c"/><circle cy="-26" r="19" fill="#e8bf6c"/><path d="m-7-28 4 3m8-1 4-3" stroke="${INK}" stroke-width="3" stroke-linecap="round"/><path d="M26-5 10 9 44 45" fill="none" stroke="#6c7052" stroke-width="5" stroke-linecap="round"/><circle cx="10" cy="9" r="6" fill="#e8bf6c"/></g>
        <path d="m-5 482 44-57-9 66 28-33-12 65m621-6 9-51 15 44 16-22 3 50" fill="#355e50"/>
      </svg>
      <path d="M61 580h226m-225 16h146" stroke="#b2b5a3" stroke-width="6" stroke-linecap="round"/>
      <text x="725" y="602" fill="#597b69" font-family="ui-monospace,monospace" font-size="36" font-weight="700">01</text>
      <path d="m319-7 155 8-10 42-153-9Z" fill="#d7b179" opacity=".9"/>
    </g>
    <g transform="translate(644 245) rotate(9 360 255)">
      <rect x="12" y="14" width="720" height="562" rx="12" fill="#111f26" opacity=".3"/>
      <rect width="720" height="562" rx="12" fill="${PAPER}"/>
      <svg x="24" y="24" width="672" height="440" viewBox="0 0 672 440" overflow="hidden">
        <rect width="672" height="440" fill="#b9d4d8"/>
        <path d="M0 228h672v212H0Z" fill="#6f9d9f"/>
        <path d="M0 246h83m25 17h91m52-20h69m44 5h112m19 21h51m53-23h73" stroke="#dbe8dc" stroke-width="5" stroke-linecap="round"/>
        <svg width="328" height="440" viewBox="0 0 328 440" overflow="hidden">
          <path d="M-37 471q10-118 78-173 28-23 28-73-3-49 37-62 49-18 82 11 24 22 27 60l-3 53q34 53 46 184Z" fill="#faf5e7"/>
          <path d="M-30 414q29-55 91-63 60-6 89 104H-30Z" fill="#8fa8aa"/>
          <path d="M14 391q27-28 55-22m-69 46q31-24 67-21" fill="none" stroke="#64878b" stroke-width="5" stroke-linecap="round"/>
          <path d="M178 221q56-6 100 32l-15 17q-39-24-84-22Z" fill="#e2b64c"/>
          <path d="m183 260 78 30q-34 10-71-4Z" fill="#c6993b"/>
          <path d="M183 245q49-1 83 20" fill="none" stroke="#657064" stroke-width="4"/>
          <circle cx="160" cy="201" r="11" fill="#e0ba57"/><circle cx="160" cy="201" r="5" fill="${INK}"/>
          <path d="m123 188 10-3m-24 22 10 1m-24 18 12 4m-13 19 11 2" stroke="#b7c6ba" stroke-width="3" stroke-linecap="round"/>
          <path d="M39 21h233q20 0 20 20v62q0 20-20 20H115l-29 28 5-28H39q-20 0-20-20V41q0-20 20-20Z" fill="#faf5e7"/>
          <circle cx="153" cy="71" r="25" fill="#60868b"/><ellipse cx="153" cy="71" rx="51" ry="11" transform="rotate(-24 153 71)" fill="none" stroke="#e0b858" stroke-width="7"/>
          <path d="m224 43 3 8 8 3-8 3-3 8-3-8-8-3 8-3Zm-127-1 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#60868b"/>
        </svg>
        <rect x="328" width="16" height="440" fill="#faf5e7"/>
        <svg x="344" width="328" height="440" viewBox="0 0 328 440" overflow="hidden">
          <path d="M-44 471q0-110 77-143 31-14 37-73l29-68 128 51-4 81q70 32 89 152Z" fill="#9cafb0"/>
          <path d="M50 291q21-23 22-62-3-47 29-68 36-24 73-8 41 17 40 71l-2 50q-64-19-89 5-41 38-73 12Z" fill="#faf5e7"/>
          <path d="M204 211q53 0 99 31l-7 13q-49-22-93-19Z" fill="#e2b64c"/>
          <path d="m205 247 92 23q-31 10-87-6Z" fill="#c6993b"/>
          <path d="M212 231q44 1 85 18" fill="none" stroke="#657064" stroke-width="4"/>
          <circle cx="185" cy="198" r="10" fill="#e0ba57"/><circle cx="185" cy="198" r="5" fill="${INK}"/>
          <path d="M79 315q69 3 91 70m-149-27q77 4 98 82m45-95q55 22 60 83" fill="none" stroke="#6e8a8f" stroke-width="6" stroke-linecap="round"/>
          <path d="M67 20h197q22 0 22 22v61q0 22-22 22h-47l-20 29-5-29H67q-22 0-22-22V42q0-22 22-22Z" fill="#faf5e7"/>
          <g transform="translate(167 75) rotate(-8)">
            <path d="M-22 2v-33m12 31v-42m12 42v-32m12 32v-39m12 38v-27" stroke="#e1b449" stroke-width="9" stroke-linecap="round"/>
            <path d="m-35-4 10 44q24 9 46 0l11-44q-35 13-67 0Z" fill="#df8a57"/><circle cy="23" r="7" fill="#faf5e7"/>
          </g>
        </svg>
      </svg>
      <path d="M60 501h181m-181 17h114" stroke="#b2b5a3" stroke-width="6" stroke-linecap="round"/>
      <text x="625" y="523" fill="#597b69" font-family="ui-monospace,monospace" font-size="36" font-weight="700">02</text>
      <path d="m663-8 59 66-34 24-57-66Z" fill="#d7b179" opacity=".9"/>
    </g>`;
}

export function movieMarkup(answerId) {
  return `<rect width="1600" height="900" fill="#293e50"/>
    <circle cx="1220" cy="387" r="302" fill="#516d76"/>
    <path d="M1108 105a298 298 0 0 1 403 331" fill="none" stroke="#83938a" stroke-width="2"/>
    ${[150,365,632,859,1042,1491].map((x,i)=>`<path d="M${x} ${107+i%3*66}v10m-5-5h10" stroke="#b5c9c1" stroke-width="3" stroke-linecap="round"/>`).join('')}
    <path d="M0 631 244 465 415 579 681 425 911 586 1211 466 1600 589v311H0Z" fill="#385661"/>
    <path d="M0 728 312 650 594 700 859 616 1142 740 1600 644v256H0Z" fill="#233a47"/>
    <path d="M837 805h727l-22-38H868Z" fill="#91a499"/>
    <path d="M870 763h670l-24-37H902Z" fill="#a4b0a0"/>
    <path d="M904 722h610l-29-38H936Z" fill="#bbc0a5"/>
    <path d="M938 681h545l-25-38H970Z" fill="#d2ccb0"/>
    <g id="${answerId}-machine">
      <path d="m1112 581-68 67h321l-77-67Z" fill="#b69360"/>
      <path d="m1164 478-42 132h155l-29-121Z" fill="#a48150"/>
      <path d="m1137 535 11 66 19-42 29-2 45 54 9-84Z" fill="#354851"/>
      <path d="m999 176 52-45 424 43q17 2 15 19l-28 290-56 53Z" fill="#a7804d"/>
      <path d="m1001 176 50-45 422 44-50 46Z" fill="#efd78f"/>
      <path d="M1009 176 1420 219q15 1 13 18l-26 294q-2 16-18 14L987 499q-17-2-16-20l22-287q1-18 16-16Z" fill="#d6ae65"/>
      <path d="m1010 194 399 42-22 289-397-44Z" fill="#e6c580"/>
      <path d="M1067 285 1349 314l-12 139-282-30Z" fill="#263d43"/>
      <path d="m1077 297 258 27-8 113-260-28Z" fill="#365654"/>
      <path d="m1016 241 76 8m235 25 65 7m-376 209 58 6m192 21 77 8" stroke="#b49155" stroke-width="5" stroke-linecap="round"/>
      <path d="m1456 225-19 213m6-160-12 134" stroke="#806843" stroke-width="6" stroke-linecap="round"/>
      <circle cx="1304" cy="487" r="6" fill="#9bba93"/><circle cx="1327" cy="490" r="6" fill="#9bba93"/><circle cx="1350" cy="493" r="6" fill="#9bba93"/>
      <g id="${answerId}" transform="translate(1202 368) rotate(6)" fill="none" stroke="#f3d786" stroke-width="15" stroke-linecap="round" stroke-linejoin="round">
        <path d="M-51-42-80 13h59m-14-55v89M4-23q0-26 27-26t27 24q0 13-16 27L7 42h54"/>
      </g>
    </g>
    ${[[907,753,'#97bbad'],[1031,784,'#d69883'],[1410,738,'#a6b9cf'],[1514,790,'#d7bb7c']].map(([x,y,colour],i)=>`<g transform="translate(${x} ${y}) rotate(${i%2?-7:6})"><path d="M-14 45q0-37 14-37t14 37Z" fill="${colour}"/><circle cy="-7" r="10" fill="${colour}"/><path d="M-4-8v2m8-2v2" stroke="#263b43" stroke-width="2" stroke-linecap="round"/></g>`).join('')}
    <path d="M0 28h1600M0 873h1600" stroke="#152b3b" stroke-width="56"/>`;
}

export function movieAnswerPose(progress) {
  const p = Math.min(1, Math.max(0, progress)/.36), reveal = 1-(1-p)**3;
  return `translate(1202px,${368+12*(1-reveal)}px) rotate(6deg) scale(${.92+.08*reveal},${.08+.92*reveal})`;
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
    <g id="activity-movie"><rect width="1600" height="900" fill="#324458"/>${movieMarkup('hero-answer')}</g>`;
}

// The generator samples this score into CSS, so README images need no script.
export function heroFrame(kind, progress) {
  if (kind === 'rpg') return Object.fromEntries(Object.entries(poses(6.8+progress*3.45)).map(([id,transform])=>['hero-rpg-'+id,{transform}]));
  if (kind === 'drawing') return {
    'hero-paper': {transform:`translate(0px,${6*Math.sin(progress*Math.PI*2)}px)`},
    'hero-pencil': {transform:`translate(${1160+18*Math.sin(progress*Math.PI*2)}px,${660+10*Math.cos(progress*Math.PI*2)}px) rotate(${28+3*Math.sin(progress*Math.PI*2)}deg)`},
    'hero-brush': {transform:`translate(${26+3*Math.sin(progress*Math.PI*2)}px,${27+2*Math.cos(progress*Math.PI*2)}px) rotate(${18+8*Math.sin(progress*Math.PI*2)}deg)`},
  };
  if (kind === 'photos') return {
    'hero-photos':{transform:`translate(800px,450px) scale(${.97+progress*.045}) translate(-800px,-450px)`},
    'hero-camera':{transform:`translate(0px,${26-40*Math.sin(Math.PI*progress)**4}px) rotate(${-4+4*Math.sin(Math.PI*progress)**4}deg)`},
  };
  return {
    'hero-answer':{transform:movieAnswerPose(progress)},
    'hero-remote':{transform:`translate(20px,${34-3*Math.sin(Math.PI*progress)**4}px) rotate(${20-8*Math.sin(Math.PI*progress)**4}deg)`},
  };
}
