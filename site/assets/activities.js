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
        <rect width="672" height="440" fill="#b8dce0"/>
        <path d="M0 167h672v273H0Z" fill="#639f9e"/>
        <path d="M-12 299q210-41 696 48v98H-12Z" fill="#efd39a"/>
        <path d="M0 278q252-42 672 62" fill="none" stroke="${PAPER}" stroke-width="9"/>
        <path d="M31 220h73m42 13h65m52-37h40m237 45h62" stroke="#b9d9c8" stroke-width="5" stroke-linecap="round"/>
        <path d="m138 189 31-122 71 122Z" fill="${PAPER}"/><path d="m172 74 62 106h-62Z" fill="#e88955"/><path d="m124 199 126-2-23 21h-76Z" fill="${INK}"/>
        <path d="M469 178V64h45v121" fill="#edcf93"/><path d="M459 73h65l-32-34Z" fill="#b6644c"/><rect x="477" y="87" width="28" height="28" rx="3" fill="#395f66"/>
        <path d="m450 184 91-4 54 31-166-2Z" fill="#4f827d"/>
        <path d="M309 127q16-14 32 0m13 7q13-13 26 0" fill="none" stroke="#456d70" stroke-width="5" stroke-linecap="round"/>
        <path d="m89 340 42 9-10 21-30-6Z" fill="#b66e50"/><path d="m100 355 8-10m1 15 9-11" stroke="#e8ad72" stroke-width="5"/>
        <path d="M379 471q-35-109 4-192 22-44 80-38 60 6 68 72l93 161Z" fill="#c5d6cb"/>
        <path d="M451 477q-58-107-21-191 16-35 58-37 52-3 67 55l40 173Z" fill="${PAPER}"/>
        <path d="m533 302 73 25-68 23Z" fill="#edb74f"/>
        <circle cx="512" cy="292" r="7" fill="${INK}"/><circle cx="510" cy="290" r="2" fill="${PAPER}"/>
        <path d="M438 337q-58 22-32 96" fill="none" stroke="#8aa7a2" stroke-width="7" stroke-linecap="round"/>
        <path d="m560 338 22 19-26 9-17-19Z" fill="#ba7952"/><path d="m558 343 11 10" stroke="#edba70" stroke-width="5"/>
      </svg>
      <path d="M60 501h181m-181 17h114" stroke="#b2b5a3" stroke-width="6" stroke-linecap="round"/>
      <text x="625" y="523" fill="#597b69" font-family="ui-monospace,monospace" font-size="36" font-weight="700">02</text>
      <path d="m663-8 59 66-34 24-57-66Z" fill="#d7b179" opacity=".9"/>
    </g>`;
}

export function movieMarkup(planeId) {
  return `<path d="M0 378q448-63 832 24t768-5v503H0Z" fill="#3e6172"/>
    <circle cx="1254" cy="260" r="146" fill="#edc875"/>
    <path d="M0 409h88V287h113v79h84V243h116v181h82V320h116v67h127V293h86v125h147V331h138v90h147V295h76v124h118V267h146v169h119v464H0Z" fill="#365267"/>
    <path d="M0 579q416-59 770-5t830-3v329H0Z" fill="#274657"/>
    ${[160,393,640,980,1450].map((x,i)=>`<circle cx="${x}" cy="${119+i%3*58}" r="2.5" fill="${PAPER}" opacity=".8"/>`).join('')}
    <path d="M565 656h256m-333 37h374m-273 51h314m-239 47h373m-184 46h401" stroke="#507682" stroke-width="8" stroke-linecap="round"/>
    <path d="M228 754q390-380 788-92l55 65-77 20-38-46q-301-207-659 107Z" fill="#688386"/>
    <path d="M202 772q417-398 850-64" fill="none" stroke="#a0aaa0" stroke-width="13"/>
    <path d="M292 707v117m186-215v178m212-193v197m210-143v165" stroke="#416173" stroke-width="31"/>
    <g fill="#ebbc70" opacity=".9">${[0,1,2,3].map(i=>`<rect x="${102+i*31}" y="320" width="11" height="24" rx="2"/><rect x="${316+i*24}" y="276" width="9" height="18" rx="2"/><rect x="${519+i*26}" y="351" width="11" height="22" rx="2"/>`).join('')}</g>
    <g transform="translate(870 537)">
      <path d="M0 87h202v276H0Z" fill="#496a70"/><path d="m-24 87 121-102 130 102Z" fill="#233a4d"/>
      <path d="M119 20h34v-73h-34Z" fill="#233a4d"/><path d="M48 145h102v94H48Z" fill="#e5bd7b"/><path d="M99 145v94m-51-47h102" stroke="#6e8280" stroke-width="9"/>
      <path d="M-21 113h244" stroke="#91a9a1" stroke-width="10"/>
      <path d="M38 302h51v61H38Z" fill="#233a4d"/>
    </g>
    <g transform="translate(1460 427)">
      <path d="M0 81h149v392H0Z" fill="#759291"/><path d="M16 102h117v371H16Z" fill="#4e7279"/>
      <path d="M10 15h129v80H10Z" fill="#a3b2a4"/><path d="m-18 15 91-113 96 113Z" fill="#20364a"/>
      <circle cx="74" cy="48" r="29" fill="#e9ce94"/><path d="M74 28v22l15 8" fill="none" stroke="#45586a" stroke-width="6" stroke-linecap="round"/>
      <rect x="48" y="142" width="54" height="68" rx="25" fill="#ebbd76"/>
      <path d="M-27 238h202" stroke="#9da99a" stroke-width="12"/>
      <path d="M-13 242v36m172-36v36" stroke="#6f9998" stroke-width="9"/>
    </g>
    <path d="M1336 420q-124 13-219 139" fill="none" stroke="#9eaaa0" stroke-width="3" stroke-dasharray="4 16" opacity=".45"/>
    <g id="${planeId}">
      <path d="m-48 26 61-18m-30 30 44-10" stroke="#a9c0bf" stroke-width="5" stroke-linecap="round" opacity=".65"/>
      <path d="M67-31q-8-33 10-43 19-8 31 17l14 28Z" fill="#8fc1ad"/><circle cx="81" cy="-88" r="18" fill="#8fc1ad"/>
      <path d="m77-87 3 1m10-3 3 1" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M66-68q-32 0-51-18-19-16-39-7 19 21 45 28l47 5Z" fill="#e58d61"/>
      <path d="m0 0 221-66-85 122-34-42Z" fill="${PAPER}"/>
      <path d="m221-66-119 80 3 44 31-2Z" fill="#b8d0c8"/>
      <path d="m221-66-95 95-21 29-3-44Z" fill="#789ba2"/>
      <path d="m0 0 102 14 119-80" fill="none" stroke="#d8e5d7" stroke-width="3"/>
      <path d="m52-19 35-12 17 24-38 11Z" fill="#cfac79"/><path d="m67-24 15 23" stroke="#f1d49c" stroke-width="5"/>
      <circle cx="72" cy="-26" r="7" fill="#8fc1ad"/>
    </g>
    <path d="M-48 722 37 677 172 752v148H-48Zm1161 178 238-136 296 143Z" fill="#1c3043"/>
    <path d="M1290 900V653q0-37 34-37h65m-65 0-12 47h74l-13-47" fill="none" stroke="#1c3043" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M1318 656h62l-6-27h-50Z" fill="#e9c176"/>
    <path d="M0 28h1600M0 873h1600" stroke="#152b3b" stroke-width="56"/>`;
}

export function moviePlanePose(progress) {
  const p = Math.min(1, Math.max(0, progress)), bank = Math.sin(p*Math.PI);
  return `translate(${935+255*p}px,${601-226*p-28*bank}px) rotate(${-14+6*bank}deg)`;
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
