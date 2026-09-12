// Original demonstration game, shared by the film and the standalone hero SVG.
// The film supplies its clock; the hero generator samples the same poses for CSS.
export const GAME_LOOP = 4.8;
const INK = '#203037';
const CREAM = '#faf5e7';
const mod = (n, d) => ((n % d) + d) % d;
const number = (n) => Math.round(n * 100) / 100;

export function gameMarkup(prefix) {
  return `<rect width="1600" height="900" fill="#cce8da"/>
    <circle cx="1260" cy="219" r="185" fill="#f4bf74"/>
    <path d="M0 304h1600M0 324h1600M0 344h1600" stroke="#cce8da" stroke-width="8"/>
    <g id="${prefix}-far" fill="#94c5b2">
      ${[-1, 0, 1, 2, 3, 4].map(i => `<path d="m${i * 640} 710 255-436q22-37 42 0l246 436Z"/>`).join('')}
    </g>
    <g id="${prefix}-near" fill="#559981">
      ${[-1, 0, 1, 2, 3, 4].map(i => `<path d="M${i * 800} 706q172-308 338-75t462 30v95h-800Z"/>`).join('')}
    </g>
    <path d="M0 690h1600v210H0Z" fill="${INK}"/>
    <path d="M0 692h1600v61H0Z" fill="#b8e2c9"/>
    <path d="M0 705h1600" stroke="${CREAM}" stroke-width="7"/>
    <g id="${prefix}-road" fill="${CREAM}" opacity=".7">
      ${Array.from({length: 14}, (_, i) => `<path d="m${i * 240 - 400} 807 65-29h54l-65 29Z"/>`).join('')}
    </g>
    <g id="${prefix}-gate">
      <g id="${prefix}-bumper">
        <path d="M1033 689v-75q0-19 19-19h64q19 0 19 19v75Z" fill="#f47843" stroke="${INK}" stroke-width="7"/>
        <path d="m1062 664 23-29 23 29" fill="none" stroke="${CREAM}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <g id="${prefix}-ring" fill="none" stroke="#f1b654" stroke-width="20">
        <ellipse cx="1085" cy="422" rx="48" ry="72"/>
        <path d="M1057 365q28-24 48 0" stroke="${CREAM}" stroke-width="6" stroke-linecap="round"/>
      </g>
      <g transform="translate(1440)"><use href="#${prefix}-bumper"/>
        <ellipse cx="1085" cy="422" rx="48" ry="72" fill="none" stroke="#f1b654" stroke-width="20"/>
        <path d="M1057 365q28-24 48 0" fill="none" stroke="${CREAM}" stroke-width="6" stroke-linecap="round"/>
      </g>
    </g>
    <ellipse id="${prefix}-shadow" cx="430" cy="693" rx="96" ry="13" fill="${INK}" opacity=".17"/>
    <g id="${prefix}-player">
      <g stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">
        <path d="m-33-111 33 23 34-23" fill="none" stroke-width="10"/>
        <rect x="-70" y="-82" width="140" height="104" rx="30" fill="${CREAM}" stroke-width="9"/>
        <path d="m-33 23-14 28m82-28 14 28" stroke-width="9"/>
        <path d="M-91 49q78 17 172-1l24-16" fill="none" stroke-width="13"/>
        <path d="M-70 69h127" stroke="#f47843" stroke-width="9"/>
        <circle cx="-25" cy="-34" r="8" fill="${INK}" stroke="none"/>
        <path d="m18-39 18 7-18 7" fill="none" stroke-width="7"/>
      </g>
      <path d="M-118 32h-81m63 20h-93m65 20h-55" stroke="${CREAM}" stroke-width="7" stroke-linecap="round" opacity=".85"/>
    </g>
    <g id="${prefix}-spark" fill="none" stroke="${CREAM}" stroke-width="9" stroke-linecap="round">
      ${[0, 60, 120, 180, 240, 300].map(a => `<path d="M0-22v-28" transform="rotate(${a})"/>`).join('')}
    </g>
    <g fill="${CREAM}" opacity=".7"><path d="M70 297h92m-30 24h119m1072 172h165m-105 25h116" stroke="${CREAM}" stroke-width="5" stroke-linecap="round"/></g>
    <g transform="translate(69 65)"><rect width="235" height="57" rx="28.5" fill="${INK}"/>
      <path d="m24 28 13-11m-13 11 13 11m6-11h18" stroke="#f47843" stroke-width="5" fill="none" stroke-linecap="round"/>
      <text x="79" y="37" fill="${CREAM}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="23" font-weight="800">DOT DASH</text>
    </g>`;
}

function poses(time) {
  const phase = time === GAME_LOOP ? 1 : mod(time, GAME_LOOP) / GAME_LOOP;
  const leap = Math.max(0, Math.min(1, (phase - .27) / .36));
  const height = Math.sin(leap * Math.PI) * 204;
  const landing = Math.sin(Math.max(0, Math.min(1, (phase - .63) / .08)) * Math.PI);
  const burst = Math.max(0, Math.min(1, (phase - .455) / .12));
  const hit = phase > .455 && phase < .58;
  return {
    far: `translate(${-number(phase * 640)}px,0px)`,
    near: `translate(${-number(phase * 800)}px,0px)`,
    road: `translate(${-number(phase * 1440)}px,0px)`,
    gate: `translate(${-number(phase * 1440)}px,0px)`,
    ring: `scale(${phase > .46 && phase < .95 ? 0 : 1})`,
    shadow: `translate(${number(430 * height / 650)}px,0px) scaleX(${number(1 - height / 650)})`,
    player: `translate(430px,${number(615 - height)}px) rotate(${number(-14 * Math.sin(leap * Math.PI * 2) + 4 * landing)}deg) scale(${number(1 + landing * .09)},${number(1 - landing * .09)})`,
    spark: `translate(430px,422px) scale(${hit ? number(.6 + burst * 1.8) : 0})`,
  };
}

export function createGame(svg, prefix) {
  const nodes = Object.fromEntries(Object.keys(poses(0)).map(key => [key, svg.querySelector(`#${prefix}-${key}`)]));
  return time => {
    for (const [key, transform] of Object.entries(poses(time))) nodes[key].style.transform = transform;
  };
}

// SVGs used by README images cannot import scripts or external SVG resources.
// Bake this score into ordinary CSS so that the hero remains self-contained.
export function gameLoopMarkup(prefix) {
  const frames = Array.from({length: 97}, (_, i) => poses(i / 96 * GAME_LOOP));
  const keys = Object.keys(frames[0]);
  const still = poses(1.9);
  const style = `<style>
    ${keys.map(key => `#${prefix}-${key}{transform:${still[key]}}`).join('')}
    @media(prefers-reduced-motion:no-preference){${keys.map(key => `#${prefix}-${key}{animation:${prefix}-${key} ${GAME_LOOP}s linear infinite}`).join('')}}
    ${keys.map(key => `:root:target #${prefix}-${key}`).join(',')}{animation:none}
    ${keys.map(key => `@keyframes ${prefix}-${key}{${frames.map((frame, i) => ['far', 'near', 'road', 'gate'].includes(key) && i > 0 && i < 96 ? '' : `${number(i / 96 * 100)}%{transform:${frame[key]}}`).join('')}}`).join('')}
  </style>`;
  return style + gameMarkup(prefix);
}
