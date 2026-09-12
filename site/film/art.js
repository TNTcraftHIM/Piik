// One seekable score, measured in musical bars. No scene owns a timer.
export const BAR = 240 / 101;
export const DURATION = 16 * BAR;
const INK = '#22303e';
const PAPER = '#f7f4e9';
const ORANGE = '#ec7646';
const MINT = '#b9dcca';
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
const ease = (n) => 1 - (1 - clamp(n)) ** 3;
const mix = (a, b, n) => a + (b - a) * n;
const pop = (n) => { const t = clamp(n) - 1; return 1 + 2.4 * t ** 3 + 1.4 * t ** 2; };
const colours = ['#99c9e6', '#e6a8bc', '#9cb9cf', '#b6addc', '#85baa8'];
const rect = (x, y, w, h, r, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
const circle = (x, y, r, fill, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
const text = (x, y, value, size, fill = INK, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" font-weight="850" letter-spacing="-.055em" fill="${fill}" ${extra}>${value}</text>`;
const small = (x, y, value, fill = INK, extra = '') => text(x, y, value, 18, fill, `style="letter-spacing:.1em;font-weight:550" ${extra}`);

function person(id, x, y, scale, colour, host = false) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g id="${id}">
    <use href="#pawn" fill="${colour}"/>
    <g id="${id}-eyes"><ellipse cx="-7" cy="-30.75" rx="2.75" ry="3.75" fill="${INK}"/><ellipse cx="7" cy="-30.75" rx="2.75" ry="3.75" fill="${INK}"/></g>
    ${host ? '<use href="#crown" transform="translate(-15 -70) scale(2.5)"/>' : ''}
  </g></g>`;
}

function mascot(id, x, y, scale, colour = PAPER) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g id="${id}">
    <g transform="translate(-16 -16)" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="m11 4 5 4 5-4M10 29l2-3m10 3-2-3"/>
      <rect x="4" y="8" width="24" height="18" rx="4" fill="${colour}"/>
      <g id="${id}-eyes"><circle cx="11.5" cy="16.5" r="1.25" fill="${INK}" stroke="none"/><path d="M19 17q2.3-3 4.7 0"/></g>
    </g></g></g>`;
}

function couch(x, y, width) {
  return `<g transform="translate(${x} ${y})">
    <path d="M24 77v20m${width - 48}-20v20" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
    ${rect(0, 0, width, 86, 28, '#edbb72')}
    ${rect(12, 62, width - 24, 27, 13, '#d99a56')}
    ${rect(-7, 35, 26, 58, 13, '#d99a56')}${rect(width - 19, 35, 26, 58, 13, '#d99a56')}
  </g>`;
}

function browserCard(id, x, y, width, content, angle = 0) {
  return `<g transform="translate(${x} ${y})"><g id="${id}">
    <g id="${id}-tilt" transform="rotate(${angle})" filter="url(#card-shadow)">
      ${rect(0, 0, width, width * .65, 22, PAPER)}
      ${circle(23, 22, 4, '#df8f74')}${circle(37, 22, 4, '#e3bd64')}${circle(51, 22, 4, '#85baa8')}
      ${rect(width * .38, 18, width * .24, 7, 3.5, '#d2dfd7')}
      <svg x="12" y="42" width="${width - 24}" height="${width * .65 - 54}" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid slice" overflow="hidden">${content}</svg>
    </g></g></g>`;
}

export function createArt(svg, language) {
  const zh = language === 'zh-CN';
  const say = (en, cn) => zh ? cn : en;
  const game = '<use href="#game-still"/>';
  const drawing = `<rect width="1000" height="560" fill="#efdec3"/>
    <circle cx="670" cy="140" r="240" fill="#f3c765"/>
    <path d="M130 440Q210 120 430 340T870 250" fill="none" stroke="#e77d5b" stroke-width="94" stroke-linecap="round"/>
    <g transform="translate(370 70) rotate(-8 130 190)"><rect width="260" height="380" rx="10" fill="${PAPER}"/>
    <path d="m100 112 30 26 30-26M70 280l17-23m105 23-17-23" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <rect x="56" y="138" width="149" height="115" rx="27" fill="none" stroke="${INK}" stroke-width="9"/>
    <circle cx="103" cy="189" r="7" fill="${INK}"/><path d="M150 192q14-18 28 0" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/></g>
    <g transform="translate(700 200) rotate(32)"><rect width="35" height="225" rx="10" fill="#7cad9a"/><path d="m0 225 17.5 42L35 225Z" fill="${PAPER}"/><path d="m10 251 7.5 16 7.5-16" fill="${INK}"/></g>`;
  const code = `<rect width="1000" height="560" fill="${INK}"/>
    ${text(70, 185, '{', 180, MINT)}${text(825, 455, '}', 180, ORANGE)}
    ${[240, 180, 380, 300, 200].map((w, i) => rect(250 + (i % 2) * 38, 130 + i * 67, w, 15, 7, ['#8ebeb0', '#f0c573', '#e0a3b6'][i % 3])).join('')}
    ${rect(658, 397, 18, 31, 3, PAPER)}`;

  svg.innerHTML = `<defs>
    <filter id="card-shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="24" stdDeviation="22" flood-color="#14232b" flood-opacity=".15"/></filter>
    <clipPath id="reveal"><rect id="reveal-shape" width="1600" height="900"/></clipPath>
    <clipPath id="reveal-round"><circle id="reveal-circle" cx="800" cy="450" r="0"/></clipPath>
    <g id="pawn"><circle cy="-31" r="20"/><path d="M-35 51.5c0-32.5 12.5-50 35-50s35 17.5 35 50q0 7.5-7.5 7.5h-55Q-35 59-35 51.5Z"/></g>
    <g id="crown" fill="#edc35d" stroke="#846634" stroke-width=".85" stroke-linejoin="round"><path d="m1.2 6.3-1.2-3.7q-.2-.7.5-.4L3 3.6l2.4-2.5q.6-.7 1.2 0L9 3.6l2.5-1.4q.7-.3.5.4l-1.2 3.7q-.2.9-1.2.9H2.4q-1 0-1.2-.9Z"/><path d="M2.1 6.5h7.8" stroke="#ba8b39" stroke-width="1"/></g>
    <g id="landscape">
      ${rect(0, 0, 1600, 900, 0, '#c7e4dd')}
      ${circle(1200, 245, 182, '#efc866')}${circle(1200, 245, 218, 'none', 'stroke="#fff7df" stroke-width="2"')}
      <path d="M-150 870Q20 230 380 490T920 480T1700 400V980H-150Z" fill="#a4ccbc"/>
      <path d="M-140 970Q260 310 600 790T1310 620T1730 650V980H-140Z" fill="#82b5a5"/>
      <g fill="${PAPER}"><rect x="110" y="260" width="185" height="26" rx="13"/><rect x="154" y="235" width="89" height="42" rx="21"/><rect x="765" y="175" width="130" height="20" rx="10"/><rect x="802" y="157" width="53" height="24" rx="12"/><rect x="1320" y="434" width="215" height="22" rx="11"/></g>
      <g fill="#d99460"><path d="M214 653h342l-52 95q-112 91-241-5Z"/><path d="M637 510h275l-43 90q-87 55-193-7Z"/><path d="M1028 668h372l-71 107q-137 79-248-2Z"/></g>
      <g fill="#f6e6bc"><rect x="205" y="625" width="360" height="42" rx="21"/><rect x="624" y="480" width="301" height="43" rx="21"/><rect x="1013" y="639" width="397" height="43" rx="21"/></g>
      <g fill="#b77952"><path d="m280 682 37 45-9-45Z"/><path d="m731 534 25 39 16-39Z"/><path d="m1140 704 31 46 25-46Z"/></g>
      <path d="M1340 628V481" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
      <path d="M1344 483h95l-23 29 23 29h-95Z" fill="${ORANGE}"/>
    </g>
    <g id="game-still"><svg width="1000" height="560" viewBox="0 0 1600 900"><use href="#landscape"/>
      ${mascot('card-tv', 380, 552, 5, '#f8ce76')}
      ${circle(775, 330, 29, '#f8cb5d', 'stroke="#b48638" stroke-width="4"')}
      ${circle(995, 215, 24, '#f8cb5d', 'stroke="#b48638" stroke-width="3"')}
    </svg></g>
    <g id="game-after"><svg width="1000" height="560" viewBox="0 0 1600 900"><use href="#landscape"/>
      ${mascot('card-tv-after', 1200, 566, 5, '#f8ce76')}
    </svg></g>
  </defs>

  <g id="scene-hello">
    ${rect(0, 0, 1600, 900, 0, INK)}
    ${small(84, 76, 'PIIK / GOOD COMPANY', '#bad2c7')}
    ${small(1516, 833, say('A LITTLE SOMETHING TO SHARE', '给你看个好东西'), '#bad2c7', 'text-anchor="end"')}
    <g id="hello-type">${text(160, 630, say('Psst.', '嘿。'), zh ? 330 : 390, PAPER)}</g>
    <g id="hello-orbits" fill="none" stroke="#b9dcca" stroke-width="1.5" opacity=".28"><circle cx="1140" cy="440" r="235"/><circle cx="1140" cy="440" r="320"/><circle cx="1140" cy="440" r="405"/></g>
    <g id="hello-dot">${circle(1140, 440, 115, ORANGE)}</g>
    ${mascot('hello-tv', 1140, 440, 6.4)}
    ${circle(800, 450, 1, ORANGE, 'id="hello-wipe"')}
  </g>

  <g id="scene-discover">
    ${rect(0, 0, 1600, 900, 0, PAPER)}
    <g id="discover-disc">${circle(1340, 580, 565, '#e8bf6d')}${circle(1340, 580, 422, 'none', 'stroke="#f7f4e9" stroke-width="2"')}</g>
    ${small(90, 75, say('FOUND SOMETHING GOOD?', '发现了什么好东西？'))}
    <g id="discover-line-one">${text(100, 320, say('Good', '好东西，'), zh ? 162 : 208)}</g>
    <g id="discover-line-two">${text(95, 520, say('things.', '别藏着。'), zh ? 162 : 208)}</g>
    <g id="discover-note">${small(108, 754, say('GAMES · CREATIONS · NEW DISCOVERIES', '游戏 · 画画 · 新鲜事'))}</g>
    ${browserCard('discover-code', 920, 165, 430, code, 13)}
    ${browserCard('discover-drawing', 900, 290, 450, drawing, -14)}
    ${browserCard('discover-game', 840, 405, 560, game, -4)}
    <g id="discover-pointer" transform="translate(1170 650)"><path d="M0 0v64l18-16 15 30 16-8-16-29 26-3Z" fill="${INK}" stroke="${PAPER}" stroke-width="5" stroke-linejoin="round"/></g>
  </g>

  <g id="scene-game">
    <g id="game-camera">
      <use href="#landscape"/>
      <g id="game-title">${text(95, 200, say('Watch this.', '看这一跳。'), zh ? 112 : 132)}</g>
      ${small(1512, 76, say('YOUR SCREEN, SHARED', '你的画面，现在开播'), INK, 'text-anchor="end"')}
      <g id="game-coin">${circle(775, 330, 29, '#f8cb5d', 'stroke="#b48638" stroke-width="4"')}<path d="M775 315v30" stroke="${PAPER}" stroke-width="6" stroke-linecap="round"/></g>
      <g id="game-coin-two">${circle(995, 215, 24, '#f8cb5d', 'stroke="#b48638" stroke-width="3"')}<path d="M995 203v24" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/></g>
      <ellipse id="game-shadow" cx="380" cy="624" rx="67" ry="12" fill="#355e511f"/>
      <g id="game-runner">${mascot('runner-tv', 0, 0, 5, '#f8ce76')}</g>
      <g id="game-burst">${Array.from({ length: 8 }, (_, i) => `<path id="burst-${i}" d="M0-15v-19" stroke="${PAPER}" stroke-width="7" stroke-linecap="round"/>`).join('')}</g>
      <g id="game-cheer">${rect(1030, 124, 360, 98, 49, PAPER)}${text(1210, 188, say('NICE!', '漂亮！'), 54, INK, 'text-anchor="middle"')}</g>
    </g>
  </g>

  <g id="scene-invite">
    ${rect(0, 0, 1600, 900, 0, MINT)}
    <g id="invite-bands" fill="none" stroke="#f7f4e9" stroke-width="80" opacity=".5"><path d="M-130 980 860-10M530 980 1520-10M1190 980 2180-10"/></g>
    ${small(90, 75, say('GOOD THINGS TRAVEL.', '好东西，要叫朋友来看。'))}
    <g id="invite-title">${text(110, 288, say('Send a link.', '发个链接。'), zh ? 145 : 156)}</g>
    ${browserCard('invite-window', 175, 365, 540, '<use href="#game-after"/>', -7)}
    <g id="invite-link" transform="translate(800 350)">
      ${rect(0, 0, 600, 108, 54, INK)}
      <g transform="translate(28 26)" stroke="${PAPER}" stroke-width="5" fill="none" stroke-linecap="round"><path d="m22 18 12-12a14 14 0 0 1 20 20L42 38M32 36 20 48A14 14 0 0 1 0 28l12-12M18 32l18-18"/></g>
      ${text(110, 69, say('Your invite link', '邀请链接'), 37, PAPER, 'style="letter-spacing:-.02em;font-weight:650"')}
      <g id="invite-check" transform="translate(527 51)" stroke="#b9dcca" stroke-width="5" fill="none" stroke-linecap="round"><path d="m-13 0 9 9 18-20"/></g>
    </g>
    <g id="invite-friends">
      ${[0, 1, 2].map((i) => `${circle(910 + i * 195, 666, 82, PAPER)}${person(`invite-person-${i}`, 910 + i * 195, 655, 1.05, colours[i])}`).join('')}
    </g>
    ${small(1110, 820, say('OPEN IT. YOU’RE IN.', '点开，就到。'), INK, 'text-anchor="middle"')}
    <g id="invite-token">${circle(0, 0, 35, ORANGE)}<path d="m-12-8 29-8-8 29-6-13Z" fill="${PAPER}"/></g>
  </g>

  <g id="scene-people">
    ${rect(0, 0, 1600, 900, 0, PAPER)}
    <g id="people-disc">${circle(1440, 850, 635, '#dfebdf')}</g>
    ${small(90, 75, say('SAVE THEM A SEAT.', '沙发给你留着呢。'))}
    <g id="people-type">
      ${text(90, 292, say('Your', '朋友，'), zh ? 151 : 174)}
      ${text(90, 462, say('people.', '都到齐。'), zh ? 151 : 174)}
      ${text(94, 667, '1', 125)}${text(190, 650, '+', 64, '#668877')}${text(266, 667, '20', 125, '#427862')}
      ${small(100, 730, say('ONE HOST · UP TO 20 VIEWERS', '一位房主 · 最多二十位观众'))}
    </g>
    <g id="people-seats">
      ${[0, 1, 2, 3].map((row) => `<g id="seat-row-${row}" transform="translate(785 ${204 + row * 145})">
        ${couch(0, 0, 635)}
        ${[0, 1, 2, 3, 4].map((col) => person(`seat-${row * 5 + col}`, 66 + col * 126, -7, .83, colours[(row + col) % 5])).join('')}
      </g>`).join('')}
    </g>
    <g id="people-host">${couch(555, 702, 136)}${person('host', 623, 686, .96, '#83c4a5', true)}</g>
  </g>

  <g id="scene-more">
    ${rect(0, 0, 1600, 900, 0, INK)}
    <g id="more-game">
      ${rect(0, 0, 1600, 900, 0, ORANGE)}
      ${small(90, 75, say('THERE’S ALWAYS SOMETHING.', '总有点什么，值得一起看。'))}
      ${circle(1390, 640, 230, '#e8bd72')}${circle(135, 210, 125, '#f4a66d')}
      ${browserCard('more-game-card', 376, 163, 870, game, -5)}
      <g id="more-game-type">${text(800, 811, say('ONE MORE ROUND.', '再来一局。'), zh ? 161 : 124, INK, 'text-anchor="middle"')}</g>
    </g>
    <g id="more-art">
      ${rect(0, 0, 1600, 900, 0, '#e8bd72')}
      <g id="more-art-picture"><svg x="150" y="-80" width="1700" height="980" viewBox="0 0 1000 560">${drawing}</svg></g>
      ${circle(-20, 710, 420, PAPER)}
      ${small(90, 75, say('A WORK IN PROGRESS.', '灵感，现场发生。'))}
      <g id="more-art-type">${text(88, 655, say('Make', '画两笔。'), zh ? 151 : 190)}${text(88, 819, say('a little.', ''), 153)}</g>
    </g>
    <g id="more-code">
      ${rect(0, 0, 1600, 900, 0, INK)}
      ${small(90, 75, say('FOLLOW YOUR CURIOSITY.', '来，一起折腾。'), MINT)}
      <g id="more-code-picture"><svg x="752" y="164" width="930" height="610" viewBox="0 0 1000 560">${code}</svg></g>
      <g id="more-code-type">${text(95, 387, say('Try', '再试点'), 179, PAPER)}${text(95, 565, say('something.', '新东西。'), zh ? 156 : 127, MINT)}</g>
      ${small(100, 810, say('BRING THEM ALONG.', '你的新发现，也是朋友的新鲜事。'), PAPER)}
    </g>
  </g>

  <g id="scene-end">
    ${rect(0, 0, 1600, 900, 0, PAPER)}
    <g id="end-disc">${circle(1445, 290, 630, '#d4e5d9')}${circle(1445, 290, 497, 'none', 'stroke="#f7f4e9" stroke-width="2"')}</g>
    <g id="end-brand">${small(109, 97, say('SCREEN SHARING. GOOD COMPANY.', '开个房间，叫朋友来。'))}
      ${text(100, 297, 'Piik', 236)}${circle(516, 277, 20, ORANGE)}
    </g>
    <g id="end-type">${text(108, 445, say('Good things.', '好东西，'), zh ? 110 : 96)}${text(108, 564, say('Shared.', '一起看。'), zh ? 110 : 113, '#427862')}</g>
    <g id="end-room"><g transform="translate(765 244)">
      <path d="M16 280C-14 126 113 35 269 33S472-35 640 41s186 352 86 462-451 87-602 19S36 385 16 280Z" fill="#f7f4e9"/>
      <ellipse cx="381" cy="530" rx="369" ry="35" fill="#b5d1c1"/>
      <g stroke="${INK}" stroke-width="6" stroke-linecap="round" fill="none"><path d="m367 22 28 24 28-24M215 325l-15 20m370-20 15 20"/></g>
      ${rect(155, 48, 480, 284, 30, INK)}
      <svg x="174" y="68" width="442" height="239" viewBox="0 0 1000 560" overflow="hidden">${game}</svg>
      ${circle(395, 321, 3, PAPER)}
      ${rect(124, 355, 540, 17, 8.5, '#d6b58d')}
      <path d="M151 373v57m486-57v57" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
      ${couch(35, 409, 153)}${couch(225, 411, 490)}
      ${person('end-host', 112, 399, 1.16, '#83c4a5', true)}
      ${person('end-friend-0', 305, 401, 1.12, '#99c9e6')}
      ${person('end-friend-1', 470, 401, 1.12, '#e8c371')}
      ${person('end-friend-2', 635, 401, 1.12, '#e6a8bc')}
      <g id="end-gamepad" transform="translate(112 438) rotate(-9)">
        <path d="M-28-11h56q11 0 16 15l4 14q3 10-7 11-5 0-17-13h-48q-12 13-17 13-10-1-7-11l4-14q5-15 16-15Z" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
        <path d="M-24-2v15m-7.5-7.5h15" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
        ${circle(26, 0, 3, '#df8f74')}${circle(33, 7, 3, '#8bbedb')}${circle(19, 7, 3, '#85baa8')}${circle(26, 14, 3, '#e8c371')}
        ${circle(-38, 15, 9, '#83c4a5')}${circle(37, 15, 9, '#83c4a5')}
      </g>
      <g transform="translate(702 137) rotate(12)">${rect(-45, -46, 90, 90, 28, PAPER)}${mascot('end-mascot', 0, 0, 2.3)}</g>
    </g></g>
    <g id="end-url">${text(112, 705, 'piik.tv', 47, INK, 'style="letter-spacing:-.035em;font-weight:650"')}${small(112, 758, say('OPEN SOURCE · MADE FOR YOUR PEOPLE', '开源 · 把好东西分享给朋友'))}</g>
    <g id="end-credit">${text(800, 856, 'Music: “Funkorama” — Kevin MacLeod · incompetech.com · CC BY 4.0 · edited excerpt', 15, '#52635e', 'text-anchor="middle" style="letter-spacing:0;font-weight:400"')}${text(800, 879, 'creativecommons.org/licenses/by/4.0/', 14, '#52635e', 'text-anchor="middle" style="letter-spacing:0;font-weight:400"')}</g>
  </g>`;

  const nodes = new Map(Array.from(svg.querySelectorAll('[id]'), (el) => [el.id, el]));
  const node = (id) => nodes.get(id);
  const attr = (id, key, value) => node(id).setAttribute(key, String(value));
  const transform = (id, value) => attr(id, 'transform', value);
  const opacity = (id, value) => attr(id, 'opacity', clamp(value));
  const entrance = (id, progress, x = 0, y = 100, angle = 0) => {
    const p = ease(progress);
    transform(id, `translate(${x * (1 - p)} ${y * (1 - p)}) rotate(${angle * (1 - p)})`);
    opacity(id, p);
  };
  const blink = (id, t, phase) => {
    const pulse = clamp(1 - Math.abs(t - phase) / .075);
    transform(`${id}-eyes`, `translate(0 ${-30.75 * pulse * .86}) scale(1 ${1 - pulse * .86})`);
  };

  function hello(t) {
    entrance('hello-type', t / .55, -140, 40, -8);
    const p = pop((t - .12) / .6);
    transform('hello-dot', `translate(${1140 * (1 - p)} ${440 * (1 - p)}) scale(${p})`);
    const turn = Math.sin(clamp((t - .5) / 1.1) * Math.PI) * -12;
    transform('hello-tv', `rotate(${turn}) scale(${pop((t - .5) / .48)})`);
    opacity('hello-tv', (t - .45) / .16);
    const expand = ease((t - 1.82) / .55);
    attr('hello-wipe', 'r', expand * 1050);
    transform('hello-orbits', `translate(${1140 * -.016 * t} ${440 * -.016 * t}) scale(${1 + .016 * t})`);
  }

  function discover(t) {
    entrance('discover-line-one', t / .6, 0, 170);
    entrance('discover-line-two', (t - .22) / .6, 0, 190);
    entrance('discover-note', (t - .55) / .55, 0, 30);
    entrance('discover-code', (t - .24) / .85, 410, 280, 15);
    entrance('discover-drawing', (t - .52) / .85, 340, 310, -9);
    entrance('discover-game', (t - .9) / .85, 250, 380, 5);
    const point = ease((t - 2.4) / .6);
    transform('discover-pointer', `translate(${mix(1570, 1200, point)} ${mix(950, 650, point)}) scale(${1 - .15 * Math.sin(clamp((t - 3) / .22) * Math.PI)})`);
    opacity('discover-pointer', point);
    // The selected window comes forward before the cut into its game.
    const zoom = ease((t - 3.65) / 1.1);
    const scale = mix(1, 1600 / 536, zoom);
    transform('discover-game', `translate(${(-840 - 12 * scale) * zoom} ${(-405 - 42 * scale) * zoom + 380 * (1 - ease((t - .9) / .85))}) scale(${scale})`);
    transform('discover-game-tilt', `rotate(${-4 * (1 - zoom)})`);
    opacity('discover-pointer', point * (1 - zoom));
    transform('discover-disc', `translate(${-15 * t} 0)`);
  }

  function gameScene(t) {
    const first = clamp((t - .55) / 1.9);
    const second = clamp((t - 3.35) / 1.8);
    const x = second > 0 ? mix(775, 1200, second) : mix(380, 775, first);
    const y = second > 0 ? mix(412, 566, second) - Math.sin(second * Math.PI) * 286 : mix(552, 412, first) - Math.sin(first * Math.PI) * 235;
    const jump = second > 0 ? second : first;
    const squash = Math.sin(clamp((t - 2.4) / .35) * Math.PI) * .1 + Math.sin(clamp((t - 5.1) / .35) * Math.PI) * .1;
    transform('game-runner', `translate(${x} ${y}) rotate(${-Math.sin(jump * Math.PI * 2) * 10}) scale(${1 + squash} ${1 - squash})`);
    attr('game-shadow', 'cx', x); attr('game-shadow', 'cy', second > 0 ? mix(480, 639, second) : mix(625, 480, first));
    attr('game-shadow', 'rx', 67 - Math.sin(jump * Math.PI) * 35);
    const camera = 1 + .035 * Math.sin(clamp(t / 6.2) * Math.PI);
    transform('game-camera', `translate(${800 * (1 - camera)} ${450 * (1 - camera)}) scale(${camera})`);
    entrance('game-title', t / .65, -80, 0, -4);
    opacity('game-coin', 1 - clamp((first - .8) * 14));
    opacity('game-coin-two', 1 - clamp((second - .56) * 14));
    const burst = clamp((t - (t < 3.35 ? 2.08 : 4.34)) / .52);
    transform('game-burst', t < 3.35 ? 'translate(775 330)' : 'translate(995 215)');
    opacity('game-burst', Math.sin(burst * Math.PI));
    for (let i = 0; i < 8; i++) transform(`burst-${i}`, `rotate(${i * 45}) translate(0 ${-70 * burst})`);
    entrance('game-cheer', (t - 5.05) / .5, 50, 60, 8);
  }

  function invite(t) {
    entrance('invite-title', (t - .4) / .6, 0, 120);
    const pull = ease(t / .95);
    const scale = mix(1600 / 516, 1, pull);
    transform('invite-window', `translate(${(-175 - 12 * scale) * (1 - pull)} ${(-365 - 42 * scale) * (1 - pull)}) scale(${scale})`);
    transform('invite-window-tilt', `rotate(${-7 * pull})`);
    const linked = ease((t - .6) / .7);
    transform('invite-link', `translate(${800 + 500 * (1 - linked)} 350)`);
    opacity('invite-link', linked);
    opacity('invite-check', (t - 1.1) / .2);
    entrance('invite-friends', (t - 1.3) / .6, 0, 210);
    const flight = clamp((t - 1.4) / 1.7);
    transform('invite-token', `translate(${mix(730, 1300, ease(flight))} ${mix(450, 666, flight) - Math.sin(flight * Math.PI) * 95}) rotate(${-18 + flight * 35}) scale(${1 - ease((flight - .85) / .15)})`);
    opacity('invite-token', (t - 1.4) / .13);
    for (let i = 0; i < 3; i++) {
      const arrival = clamp((t - 1.65 - .38 * i) / .55);
      transform(`invite-person-${i}`, `translate(0 ${-16 * Math.sin(arrival * Math.PI)}) rotate(${Math.sin(arrival * Math.PI) * (i % 2 ? -4 : 4)} 0 59)`);
      blink(`invite-person-${i}`, t, 3.4 + i * .37);
    }
    transform('invite-bands', `translate(${-20 * t} 0)`);
  }

  function people(t) {
    entrance('people-type', (t - .55) / .7, -180, 0);
    entrance('people-host', (t - .35) / .7, 0, 240);
    const pull = mix(3.4, 1, ease(t / 1.65));
    transform('people-seats', `translate(${1100 * (1 - pull)} ${445 * (1 - pull)}) scale(${pull})`);
    for (let row = 0; row < 4; row++) {
      transform(`seat-row-${row}`, `translate(785 ${204 + row * 145})`);
      for (let col = 0; col < 5; col++) {
        const index = row * 5 + col;
        const arrival = pop((t - index * .035) / .38);
        const wave = Math.sin(clamp((t - 2.5 - index * .085) / .65) * Math.PI);
        transform(`seat-${index}`, `translate(0 ${-105 * (1 - arrival) - wave * 5}) rotate(${wave * (index % 2 ? -3 : 3)} 0 59)`);
        opacity(`seat-${index}`, arrival);
        blink(`seat-${index}`, t, 3.9 + index * .103);
      }
    }
    const lean = Math.sin(clamp((t - 4.6) / 1.1) * Math.PI) * -5;
    transform('host', `rotate(${lean} 0 59)`);
    blink('host', t, 4.8);
    transform('people-disc', `translate(${-12 * t} 0)`);
  }

  function more(t) {
    const cut = Math.min(2, Math.floor(t / (BAR * 2 / 3)));
    const local = t - cut * BAR * 2 / 3;
    ['game', 'art', 'code'].forEach((name, index) => {
      node(`more-${name}`).style.display = index === cut ? '' : 'none';
      entrance(`more-${name}-type`, local / .36, 0, 100);
    });
    entrance('more-game-card', local / .5, 230, 50, 10);
    const tilt = mix(7, -3, ease(local / 1.58));
    transform('more-art-picture', `translate(800 450) rotate(${tilt}) scale(1.03) translate(-800 -450)`);
    transform('more-code-picture', `translate(${150 * (1 - ease(local / .6))} 0)`);
  }

  function end(t, poster) {
    const settle = poster ? 1 : ease(t / 1.35);
    transform('end-brand', `translate(${61 * (1 - settle)} ${-6 * (1 - settle)}) scale(${mix(2.4, 1, settle)})`);
    entrance('end-type', poster ? 1 : (t - .7) / .7, 0, 100);
    entrance('end-room', poster ? 1 : (t - .65) / 1, 500, 65, 5);
    entrance('end-url', poster ? 1 : (t - 1.3) / .65, 0, 50);
    opacity('end-credit', poster ? 0 : (t - 3.3) / .5);
    // The launch controls occupy this space on the poster; the film closes on its URL.
    opacity('end-url', poster ? 0 : (t - 1.3) / .65);
    transform('end-disc', `translate(${poster ? 0 : 30 * (1 - ease(t / 3))} 0)`);
    transform('end-host', `rotate(${poster ? 0 : Math.sin(clamp((t - 2) / 1.4) * Math.PI) * 4} 0 59)`);
    blink('end-host', poster ? 0 : t, 3.3);
    for (let i = 0; i < 3; i++) blink(`end-friend-${i}`, poster ? 0 : t, 4.1 + i * .42);
    transform('end-mascot', `rotate(${poster ? 0 : -8 * Math.sin(clamp((t - 3.8) / 1.2) * Math.PI)})`);
  }

  const scenes = [
    { id: 'hello', start: 0, render: hello },
    { id: 'discover', start: BAR, render: discover },
    { id: 'game', start: 3 * BAR, render: gameScene },
    { id: 'invite', start: 6 * BAR, render: invite },
    { id: 'people', start: 8 * BAR, render: people },
    { id: 'more', start: 11 * BAR, render: more },
    { id: 'end', start: 13 * BAR, render: end },
  ];
  function render(time, poster = false) {
    const t = clamp(time, 0, DURATION);
    const index = poster ? scenes.length - 1 : scenes.findLastIndex((scene) => t >= scene.start);
    const incoming = scenes[index];
    const local = poster ? 5 : t - incoming.start;
    // Two matched screen cuts keep content in place; the other edits use either
    // a wipe or the orange-dot iris. These are edits in the score, not timers.
    const transition = poster || index === 0 || index === 2 || index === 3 ? 1 : ease(local / .48);
    scenes.forEach((scene, i) => {
      const visible = i === index || (i === index - 1 && transition < 1);
      const element = node(`scene-${scene.id}`);
      element.style.display = visible ? '' : 'none';
      element.removeAttribute('clip-path');
      if (visible) scene.render(i === index ? local : incoming.start - scene.start, poster);
    });
    if (transition < 1) {
      const round = index === 4 || index === 6;
      node(`scene-${incoming.id}`).setAttribute('clip-path', round ? 'url(#reveal-round)' : 'url(#reveal)');
      if (round) {
        attr('reveal-circle', 'cx', index === 4 ? 1110 : 800);
        attr('reveal-circle', 'cy', index === 4 ? 666 : 450);
        attr('reveal-circle', 'r', transition * 1450);
      } else {
        attr('reveal-shape', 'x', 1600 * (1 - transition));
        attr('reveal-shape', 'width', 1600 * transition);
      }
    }
  }
  render(0, true);
  return { render };
}
