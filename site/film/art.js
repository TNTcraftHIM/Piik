// One seekable score, measured in musical bars. No scene owns a timer.
const BAR = 240 / 101;
export const DURATION = 16 * BAR;
const BEAT = BAR / 4;
const INK = '#203037';
const PAPER = '#faf5e7';
const ORANGE = '#f47843';
const MINT = '#b8e2c9';
const YELLOW = '#f3cc68';
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
const ease = (n) => 1 - (1 - clamp(n)) ** 4;
const mix = (a, b, n) => a + (b - a) * n;
const pop = (n) => { const t = clamp(n) - 1; return 1 + 2.5 * t ** 3 + 1.5 * t ** 2; };
const colours = ['#99c9e6', '#e6a8bc', '#9cb9cf', '#b6addc', '#85baa8'];
const rect = (x, y, w, h, r, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
const circle = (x, y, r, fill, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
const text = (x, y, value, size, fill = INK, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" font-weight="900" letter-spacing="-.06em" fill="${fill}" ${extra}>${value}</text>`;
const small = (x, y, value, fill = INK, extra = '') => text(x, y, value, 19, fill, `style="letter-spacing:.1em;font-weight:650" ${extra}`);
const field = (fill) => rect(0, 0, 1600, 900, 0, fill);

function person(id, x, y, scale, colour, host = false) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g id="${id}">
    <use href="#pawn" fill="${colour}"/>
    <g id="${id}-eyes" fill="${INK}"><ellipse cx="-7" cy="-30.75" rx="2.75" ry="3.75"/><ellipse cx="7" cy="-30.75" rx="2.75" ry="3.75"/></g>
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
    ${rect(0, 0, width, 86, 28, '#edbb72')}${rect(12, 62, width - 24, 27, 13, '#d99a56')}
    ${rect(-7, 35, 26, 58, 13, '#d99a56')}${rect(width - 19, 35, 26, 58, 13, '#d99a56')}
  </g>`;
}

function screen(id, x, y, width, content, angle = 0) {
  const height = (width - 24) * 9 / 16;
  return `<g transform="translate(${x} ${y})"><g id="${id}"><g id="${id}-tilt" transform="rotate(${angle})">
    ${rect(13, 18, width, height + 56, 24, INK)}${rect(0, 0, width, height + 56, 24, PAPER)}
    ${[23, 37, 51].map((cx, i) => circle(cx, 23, 4, [ORANGE, YELLOW, '#85baa8'][i])).join('')}
    ${rect(width * .4, 19, width * .2, 7, 3.5, '#b8c9bf')}
    <svg x="12" y="44" width="${width - 24}" height="${height}" viewBox="0 0 1600 900" overflow="hidden">${content}</svg>
  </g></g></g>`;
}

export function createArt(svg, language) {
  const zh = language === 'zh-CN';
  const say = (en, cn) => zh ? cn : en;
  const game = '<use href="#game-still"/>';
  const drawing = `<rect width="1600" height="900" fill="${YELLOW}"/>
    <path d="M-130 750Q220-60 600 580T1720 300" fill="none" stroke="${ORANGE}" stroke-width="190"/>
    <g transform="translate(690 370) rotate(-12)">${rect(-185, -260, 370, 520, 9, PAPER)}
      <path d="m-48-102 46 40 47-40M-90 155l25-35m155 35-25-35" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round"/>
      ${rect(-119, -59, 239, 178, 38, 'none', `stroke="${INK}" stroke-width="11"`)}
      ${circle(-53, 19, 10, INK)}<path d="M24 23q23-29 46 0" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>
    </g>`;
  const code = `${field(INK)}${text(80, 480, '{', 600, MINT)}${text(1100, 810, '}', 600, ORANGE)}
    ${[370, 250, 490, 330, 210].map((w, i) => rect(520 + i % 2 * 52, 205 + i * 99, w, 23, 11.5, [MINT, YELLOW, '#e6a8bc'][i % 3])).join('')}`;

  svg.innerHTML = `<defs>
    <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">${circle(4, 4, 2, INK)}</pattern>
    <clipPath id="slash"><path id="slash-path"/></clipPath>
    <clipPath id="title-top"><rect x="-1600" y="-900" width="4800" height="1226"/></clipPath>
    <clipPath id="title-bottom"><rect x="-1600" y="324" width="4800" height="1476"/></clipPath>
    <g id="wordmark">${text(85, 477, 'Piik', 407, PAPER)}</g>
    <g id="pawn"><circle cy="-31" r="20"/><path d="M-35 51.5c0-32.5 12.5-50 35-50s35 17.5 35 50q0 7.5-7.5 7.5h-55Q-35 59-35 51.5Z"/></g>
    <g id="crown" fill="#edc35d" stroke="#846634" stroke-width=".85" stroke-linejoin="round"><path d="m1.2 6.3-1.2-3.7q-.2-.7.5-.4L3 3.6l2.4-2.5q.6-.7 1.2 0L9 3.6l2.5-1.4q.7-.3.5.4l-1.2 3.7q-.2.9-1.2.9H2.4q-1 0-1.2-.9Z"/><path d="M2.1 6.5h7.8" stroke="#ba8b39" stroke-width="1"/></g>
    <g id="landscape">
      ${field(MINT)}${circle(1270, 214, 259, YELLOW)}
      <path d="M-60 785 376 176 551 722 855 128 1150 759 1650 210v690H-60Z" fill="#8cbda8"/>
      <path d="m-100 846 500-316 480 368 420-560 360 443v180H-100Z" fill="#507e6e"/>
      ${text(570, 390, 'GO', 465, PAPER, 'transform="rotate(-12 800 300)" opacity=".55"')}
      <g fill="${INK}"><path d="M215 649h342l-52 96-242 24Z"/><path d="M637 508h275l-43 90-193 19Z"/><path d="M1028 666h372l-71 107-248 31Z"/></g>
      <g fill="${PAPER}"><rect x="205" y="625" width="360" height="42" rx="21"/><rect x="624" y="480" width="301" height="43" rx="21"/><rect x="1013" y="639" width="397" height="43" rx="21"/></g>
      <path d="M1340 628V481" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
      <path d="M1344 483h95l-23 29 23 29h-95Z" fill="${ORANGE}"/>
      ${circle(1530, 860, 265, 'url(#dots)', 'opacity=".35"')}
    </g>
    <g id="game-still"><use href="#landscape"/>${mascot('card-tv', 380, 552, 5, YELLOW)}${circle(775, 330, 29, ORANGE)}${circle(995, 215, 24, ORANGE)}</g>
    <g id="pad">
      <path d="M-115-52h230q47 0 66 61l20 74q12 49-34 49-29 0-72-55H-95q-43 55-72 55-46 0-34-49l20-74q19-61 66-61Z" fill="${PAPER}"/>
      <path d="M-103-9v58m-29-29h58" fill="none" stroke="${INK}" stroke-width="15" stroke-linecap="round"/>
      ${circle(104, 0, 12, ORANGE)}${circle(134, 29, 12, '#8bbedb')}${circle(74, 29, 12, '#85baa8')}${circle(104, 58, 12, YELLOW)}
      ${rect(-26, 28, 15, 6, 3, INK)}${circle(24, 31, 5, INK)}
    </g>
  </defs>

  <g id="scene-hello">
    ${field(INK)}
    <g id="hello-slab"><path d="M980-100h890v1080H665Z" fill="${ORANGE}"/>${circle(1430, 430, 480, 'url(#dots)', 'opacity=".25"')}</g>
    <g id="hello-echo" fill="none" stroke="${MINT}" stroke-width="1.5" opacity=".3">
      ${text(-75, 396, 'PIIK', 535, 'none')}${text(-75, 864, 'PIIK', 535, 'none')}
    </g>
    <g id="hello-word" transform="rotate(-12 740 450)">
      <path d="M-70 171h945l-34 386H-105Z" fill="${PAPER}"/>
      ${text(58, 472, say('HEY.', '嘿。'), zh ? 307 : 365)}
      ${small(92, 640, say('GOT A MINUTE?', '给你看个好东西。'), PAPER)}
    </g>
    <g id="hello-character"><g transform="translate(1190 436) rotate(14)">
      ${mascot('hello-tv', 0, -15, 21, PAPER)}
      ${small(0, 294, 'PIIK / HELLO THERE', INK, 'text-anchor="middle"')}
    </g></g>
    <g id="hello-label">${small(64, 64, 'SCREEN SHARING / GOOD COMPANY', MINT)}${small(1536, 836, 'PIIK.TV', INK, 'text-anchor="end"')}</g>
    ${circle(800, 450, 0, ORANGE, 'id="hello-dot"')}
  </g>

  <g id="scene-discover">
    ${field(PAPER)}
    <g id="discover-type" transform="rotate(-12 800 450)">
      <g id="discover-line-top">${text(-70, 180, say('GOOD STUFF', '好东西'), zh ? 345 : 265, 'none', `stroke="${INK}" stroke-width="2"`)}</g>
      <g id="discover-line-middle">${text(-60, 533, say('GOOD STUFF', '好东西'), zh ? 345 : 265)}</g>
      <g id="discover-line-bottom">${text(-60, 886, say('GOOD STUFF', '好东西'), zh ? 345 : 265, ORANGE)}</g>
    </g>
    <g id="discover-photo">
      ${rect(910, -170, 580, 1210, 0, MINT, 'transform="rotate(12 1200 450)"')}
      ${screen('discover-drawing', 976, -134, 530, drawing, 12)}
      ${screen('discover-game', 842, 310, 655, game, -12)}
      ${screen('discover-code', 1025, 798, 530, code, 12)}
    </g>
    <g id="discover-ticket" transform="translate(130 632) rotate(-12)">
      ${rect(12, 13, zh ? 661 : 795, 159, 0, ORANGE)}${rect(0, 0, zh ? 661 : 795, 159, 0, INK)}
      ${text(28, 120, say('SHARE IT.', '别藏着。'), zh ? 125 : 150, PAPER)}
    </g>
    <g id="discover-label">${small(58, 55, say('SOMETHING WORTH SHARING', '总有些画面，想让朋友也看看。'))}</g>
    <g id="discover-pointer"><path d="M0 0v91l25-24 21 43 23-11-22-43 39-5Z" fill="${INK}" stroke="${PAPER}" stroke-width="6" stroke-linejoin="round"/></g>
  </g>

  <g id="scene-game">
    ${field(INK)}
    <g id="game-camera"><use href="#landscape"/>
      <g id="game-coin">${circle(775, 330, 29, ORANGE)}<path d="M775 315v30" stroke="${PAPER}" stroke-width="6" stroke-linecap="round"/></g>
      <g id="game-coin-two">${circle(995, 215, 24, ORANGE)}<path d="M995 203v24" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/></g>
      <ellipse id="game-shadow" cx="380" cy="624" rx="67" ry="12" fill="#20303730"/>
      <g id="game-runner">${mascot('runner-tv', 0, 0, 5, YELLOW)}</g>
      <g id="game-burst" fill="none" stroke="${PAPER}" stroke-width="7" stroke-linecap="round">
        ${Array.from({ length: 8 }, (_, i) => `<path id="burst-${i}" d="M0-20v-31"/>`).join('')}
      </g>
    </g>
    <g id="game-title" transform="rotate(-12 300 150)">${rect(-70, 5, zh ? 645 : 790, 181, 0, INK)}${text(34, 150, say('WATCH THIS.', '看这一跳。'), zh ? 117 : 120, PAPER)}</g>
    <g id="game-cheer">
      <path d="M-30 900 197 0H570L344 900Z" fill="${ORANGE}"/>
      <path d="M570 0h490L817 900H344Z" fill="${PAPER}"/>
      <path d="M1060 0h570v900H817Z" fill="${MINT}"/>
      <g transform="translate(1270 360) rotate(15)">${mascot('cheer-tv', 0, 0, 20, YELLOW)}</g>
      <g id="game-cheer-type" transform="rotate(-12 720 540)">
        ${text(45, 675, say('NICE.', '漂亮！'), zh ? 307 : 405, INK, `stroke="${PAPER}" stroke-width="10" paint-order="stroke"`)}
      </g>
      ${small(1502, 814, say('YOU SAW THAT, RIGHT?', '看到了吧！'), INK, 'text-anchor="end"')}
    </g>
  </g>

  <g id="scene-invite">
    ${field(ORANGE)}
    <g id="invite-echo" transform="rotate(-12 800 450)">
      ${text(-140, 281, 'PASS IT ON', 335, 'none', `stroke="${INK}" stroke-width="2"`)}
      ${text(-135, 951, 'PASS IT ON', 335, 'none', `stroke="${INK}" stroke-width="2"`)}
    </g>
    <g id="invite-strip" transform="rotate(-12 800 450)">
      ${rect(-250, 234, 2120, 349, 0, INK)}
      <g id="invite-title">${zh ? text(48, 497, '发个链接。', 207, PAPER) : text(58, 329, 'SEND', 78, PAPER) + text(48, 527, 'A LINK.', 219, PAPER)}</g>
      <g id="invite-link" transform="translate(214 628)">
        ${rect(0, 0, 560, 81, 40.5, PAPER)}
        <g transform="translate(32 16)" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"><path d="m22 18 12-12a14 14 0 0 1 20 20L42 38M32 36 20 48A14 14 0 0 1 0 28l12-12M18 32l18-18"/></g>
        ${text(116, 55, say('Your invite link', '邀请链接'), 37)}
        <path id="invite-check" d="m492 39 11 11 24-25" fill="none" stroke="#427862" stroke-width="6" stroke-linecap="round"/>
      </g>
    </g>
    <g id="invite-arrivals">
      <path d="M1160-60h510v1030H901Z" fill="${MINT}"/>
      ${[0, 1, 2].map((i) => `<g id="invite-tile-${i}" transform="translate(${1309 - i * 90} ${156 + i * 274}) rotate(12)">
        ${rect(-104, -106, 208, 224, 28, PAPER)}${person(`invite-person-${i}`, 0, -6, 1.65, colours[i])}
      </g>`).join('')}
    </g>
    <g id="invite-arrow"><path d="M-126-27H4v-80L134 0 4 107V27h-130Z" fill="${YELLOW}"/></g>
    ${small(59, 58, say('INVITE YOUR PEOPLE', '叫上朋友。'))}
    ${small(57, 842, say('THEY WATCH IN A BROWSER.', '点开邀请，在浏览器里就能看。'))}
  </g>

  <g id="scene-people">
    ${field(MINT)}
    <g id="people-backdrop" transform="rotate(-12 800 450)">
      ${text(-160, 263, 'TOGETHER', 325, PAPER)}${text(-160, 918, 'TOGETHER', 325, 'none', `stroke="${INK}" stroke-width="2"`)}
      <path d="M640-200h300v1320H640Z" fill="${INK}" opacity=".08"/>
    </g>
    <g id="people-type" transform="rotate(-12 280 450)">
      ${text(76, 301, '1', 254)}${text(251, 290, '+', 141)}
      ${text(33, 708, '20', 409)}
      ${small(60, 790, say('ONE HOST', '一位房主'))}${small(60, 824, say('UP TO 20 VIEWERS', '最多二十位观众'))}
    </g>
    <g transform="rotate(-12 1120 450)"><g id="people-seats">
      ${[0, 1, 2, 3].map((row) => `<g id="seat-row-${row}" transform="translate(${674 + row * 15} ${167 + row * 180})">
        ${couch(0, 0, 790)}
        ${[0, 1, 2, 3, 4].map((col) => person(`seat-${row * 5 + col}`, 79 + col * 157, -11, 1.02, colours[(row + col) % 5])).join('')}
      </g>`).join('')}
    </g></g>
    <g id="people-host"><g transform="translate(495 379) rotate(-12)">${couch(-61, 9, 122)}${person('host', 0, -7, .91, '#83c4a5', true)}</g></g>
    ${small(55, 55, say('A LITTLE ROOM. A LOT OF COMPANY.', '一个房间，就聚齐了。'))}
    <g id="people-close">
      ${field(INK)}
      ${[PAPER, ORANGE, MINT].map((colour, i) => `<g id="close-panel-${i}">
        ${rect(i * 536, 0, 538, 900, 0, colour)}
        <g transform="translate(${267 + i * 536} 591)">
          ${person(`close-person-${i}`, 0, 0, 5.1, colours[i])}
        </g>
        ${text(66 + i * 536, 180, ['01', '02', '03'][i], 159, 'none', `stroke="${INK}" stroke-width="2" opacity=".28"`)}
      </g>`).join('')}
      <g id="people-close-type" transform="rotate(-8 800 650)">${rect(-50, 640, 1710, 190, 0, INK)}${text(88, 786, say('GOOD COMPANY.', '都在这儿。'), zh ? 175 : 159, PAPER)}</g>
      ${small(63, 55, say('THAT’S MORE LIKE IT.', '这下热闹了。'))}
    </g>
  </g>

  <g id="scene-more">
    <g id="more-game">${field(ORANGE)}
      <g transform="rotate(-12 800 450)">${text(-60, 364, say('ONE MORE', '再来'), zh ? 378 : 278)}
        ${rect(-240, 537, 2120, 343, 0, INK)}
      </g>
      <g id="more-game-picture"><g transform="translate(910 370) rotate(14) scale(2.3)"><use href="#pad"/></g></g>
      <g transform="rotate(-12 800 450)">${text(zh ? 620 : 490, 800, say('ROUND.', '一局。'), zh ? 255 : 240, PAPER, `stroke="${INK}" stroke-width="10" paint-order="stroke"`)}</g>
      ${small(58, 60, say('PLAY / PASS THE GOOD TIMES ON', '玩游戏。也玩在一起。'))}
    </g>
    <g id="more-art">${field(YELLOW)}
      <g id="more-art-picture"><svg x="160" y="-86" width="1660" height="1040" viewBox="0 0 1600 900">${drawing}</svg></g>
      <g id="more-art-type" transform="rotate(-12 800 450)">
        ${rect(-110, 347, 616, 414, 0, INK)}${text(46, 509, say('MAKE', '画'), zh ? 177 : 127, PAPER)}${text(37, 715, say('A LITTLE.', '两笔。'), zh ? 192 : 101, PAPER)}
      </g>
      <g id="more-pencil" transform="translate(1190 150) rotate(32)">${rect(0, 0, 57, 435, 14, INK)}<path d="m0 435 28.5 85 28.5-85Z" fill="${PAPER}"/><path d="m18 489 10.5 31 10.5-31Z" fill="${INK}"/></g>
      ${small(58, 60, say('MAKE / FOLLOW A LITTLE SPARK', '灵感，现场发生。'))}
    </g>
    <g id="more-code">${field(INK)}
      <g id="more-code-picture"><svg x="-156" y="-80" width="1870" height="1130" viewBox="0 0 1600 900">${code}</svg></g>
      <g id="more-code-type" transform="rotate(-12 800 450)">
        ${rect(-170, 300, 1940, 289, 0, MINT)}${text(51, 529, say('WHAT IF?', '一起折腾。'), zh ? 218 : 255)}
      </g>
      ${small(58, 60, say('EXPLORE / FIND YOUR NEXT THING', '新发现，一起试。'), PAPER)}
    </g>
  </g>

  <g id="scene-end">
    ${field(MINT)}
    <g id="end-slab"><path d="M-60-60h1160L859 940H-60Z" fill="${INK}"/></g>
    <g id="end-echo" transform="rotate(-12 1100 450)">${text(974, 720, 'PIIK', 390, 'none', `stroke="${INK}" stroke-width="2" opacity=".15"`)}</g>
    <g id="end-brand">
      <g clip-path="url(#title-top)"><use id="end-brand-top" href="#wordmark"/></g>
      <g clip-path="url(#title-bottom)"><use id="end-brand-bottom" href="#wordmark"/></g>
      <g id="end-brand-dot">${circle(809, 442, 33, ORANGE)}</g>
    </g>
    <g id="end-type">${text(96, 604, say('Good things.', '好东西，'), zh ? 114 : 112, PAPER)}${text(96, 734, say('Shared.', '一起看。'), zh ? 114 : 119, MINT)}</g>
    <g id="end-character"><g transform="translate(1290 294) rotate(14)">
      ${circle(0, 0, 242, ORANGE)}${circle(35, 24, 242, 'url(#dots)', 'opacity=".25"')}${mascot('end-tv', 0, 0, 15, PAPER)}
    </g></g>
    <g id="end-room"><g transform="translate(961 637) rotate(-12)">
      ${couch(0, 0, 577)}
      ${person('end-host', 77, -13, 1.25, '#83c4a5', true)}
      ${person('end-friend-0', 221, -13, 1.25, '#99c9e6')}${person('end-friend-1', 365, -13, 1.25, '#b6addc')}${person('end-friend-2', 509, -13, 1.25, '#e6a8bc')}
      <g id="end-gamepad" transform="translate(77 32) rotate(-9) scale(.25)"><use href="#pad"/>${circle(-167, 70, 35, '#83c4a5')}${circle(167, 70, 35, '#83c4a5')}</g>
    </g></g>
    <g id="end-label">${small(65, 67, say('SCREEN SHARING / GOOD COMPANY', '开个房间，叫朋友来。'), MINT)}</g>
    <g id="end-url">${text(1500, 799, 'piik.tv', 46, INK, 'text-anchor="end"')}${small(98, 802, say('OPEN SOURCE. MAKE IT YOURS.', '开源 · 把好东西分享给朋友'), PAPER)}</g>
    <g id="end-credit">${rect(0, 846, 1600, 54, 0, PAPER)}${text(800, 869, 'Music: “Funkorama” — Kevin MacLeod · incompetech.com · CC BY 4.0 · edited excerpt', 15, INK, 'text-anchor="middle" style="letter-spacing:0;font-weight:450"')}${text(800, 890, 'creativecommons.org/licenses/by/4.0/', 14, INK, 'text-anchor="middle" style="letter-spacing:0;font-weight:450"')}</g>
  </g>`;

  const nodes = new Map(Array.from(svg.querySelectorAll('[id]'), (el) => [el.id, el]));
  const node = (id) => nodes.get(id);
  const attr = (id, key, value) => node(id).setAttribute(key, String(value));
  const transform = (id, value) => attr(id, 'transform', value);
  const opacity = (id, value) => attr(id, 'opacity', clamp(value));
  const slide = (id, progress, x, y, base = '') => {
    const p = ease(progress);
    transform(id, `translate(${x * (1 - p)} ${y * (1 - p)}) ${base}`);
  };
  const scaleAt = (id, scale, x = 800, y = 450, angle = 0) => transform(id, `translate(${x} ${y}) rotate(${angle}) scale(${scale}) translate(${-x} ${-y})`);
  const blink = (id, t, phase) => {
    const pulse = clamp(1 - Math.abs(t - phase) / .075);
    transform(`${id}-eyes`, `translate(0 ${-30.75 * pulse * .86}) scale(1 ${1 - pulse * .86})`);
  };

  function hello(t) {
    const open = ease((t - .12) / .58);
    slide('hello-slab', open, 1100, 0);
    slide('hello-word', (t - .17) / .32, -1380, 265, 'rotate(-12 740 450)');
    const arrive = pop((t - .33) / .47);
    scaleAt('hello-character', mix(2.7, 1, arrive), 1190, 436, mix(-19, 0, arrive));
    opacity('hello-character', (t - .26) / .1);
    transform('hello-tv-eyes', `translate(${2 * Math.sin(clamp((t - 1.25) / .6) * Math.PI)} 0)`);
    transform('hello-echo', `translate(${-18 * t} 0)`);
    opacity('hello-label', (t - .64) / .2);
    // The brand dot begins the film and opens the next cut, like an aperture.
    attr('hello-dot', 'r', t < .35 ? 19 * (1 - ease(t / .35)) : 1080 * ease((t - 1.99) / .386));
  }

  function discover(t) {
    transform('discover-type', `translate(${-30 * t} ${12 * t}) rotate(-12 800 450)`);
    slide('discover-line-top', t / .34, -920, 0);
    slide('discover-line-middle', (t - .08) / .36, 1230, 0);
    slide('discover-line-bottom', (t - .16) / .34, -1380, 0);
    slide('discover-photo', t / .48, 770, -160);
    slide('discover-ticket', (t - BEAT * 2) / .26, -1100, 220, 'translate(130 632) rotate(-12)');
    const click = ease((t - 2.7) / .5);
    transform('discover-pointer', `translate(${mix(1640, 1230, click)} ${mix(940, 586, click)}) scale(${1 - .22 * Math.sin(clamp((t - 3.15) / .24) * Math.PI)})`);
    opacity('discover-pointer', click * (1 - ease((t - 3.6) / .22)));
    const zoom = ease((t - 3.63) / 1.12);
    const scale = mix(1, 1600 / 631, zoom);
    transform('discover-game', `translate(${(-842 - 12 * scale) * zoom} ${(-310 - 44 * scale) * zoom}) scale(${scale})`);
    transform('discover-game-tilt', `rotate(${-12 * (1 - zoom)})`);
    opacity('discover-drawing', 1 - zoom); opacity('discover-code', 1 - zoom);
    opacity('discover-ticket', 1 - ease((zoom - .1) / .4));
    opacity('discover-label', 1 - zoom);
  }

  function gameScene(t) {
    // A brief hold near the second coin gives the leap an impact pose.
    const action = t < 4.32 ? t : t < 4.5 ? 4.32 : t - .18;
    const first = clamp((action - .48) / 1.75);
    const second = clamp((action - 3.13) / 1.72);
    const x = second > 0 ? mix(775, 1200, second) : mix(380, 775, first);
    const y = second > 0 ? mix(412, 566, second) - Math.sin(second * Math.PI) * 286 : mix(552, 412, first) - Math.sin(first * Math.PI) * 235;
    const jump = second > 0 ? second : first;
    const squash = Math.sin(clamp((action - 2.23) / .3) * Math.PI) * .14 + Math.sin(clamp((action - 4.85) / .3) * Math.PI) * .14;
    transform('game-runner', `translate(${x} ${y}) rotate(${-Math.sin(jump * Math.PI * 2) * 14}) scale(${1 + squash} ${1 - squash})`);
    attr('game-shadow', 'cx', x); attr('game-shadow', 'cy', second > 0 ? mix(480, 639, second) : mix(625, 480, first));
    attr('game-shadow', 'rx', 67 - Math.sin(jump * Math.PI) * 35);
    scaleAt('game-camera', 1 + .08 * Math.sin(clamp(t / 5.1) * Math.PI), 800, 450);
    slide('game-title', t / .36, -920, 170, 'rotate(-12 300 150)');
    opacity('game-title', 1 - ease((t - 2.2) / .4));
    opacity('game-coin', 1 - clamp((first - .8) * 14));
    opacity('game-coin-two', 1 - clamp((second - .56) * 14));
    const burst = clamp((action - (action < 3.13 ? 1.88 : 4.09)) / .5);
    transform('game-burst', action < 3.13 ? 'translate(775 330)' : 'translate(995 215)');
    opacity('game-burst', Math.sin(burst * Math.PI));
    for (let i = 0; i < 8; i++) transform(`burst-${i}`, `rotate(${i * 45}) translate(0 ${-93 * burst})`);
    node('game-cheer').style.display = t >= 5.32 ? '' : 'none';
    const hit = ease((t - 5.32) / .22);
    scaleAt('game-cheer', mix(1.25, 1, hit), 900, 450);
    transform('game-cheer-type', `translate(${-18 * clamp(t - 5.32, 0, 2)} 0) rotate(-12 720 540)`);
    transform('cheer-tv', `rotate(${-5 * Math.sin(clamp((t - 5.45) / 1.1) * Math.PI)})`);
  }

  function invite(t) {
    transform('invite-echo', `translate(${-24 * t} 0) rotate(-12 800 450)`);
    slide('invite-title', t / .29, -1390, 0);
    slide('invite-link', (t - .55) / .36, -1090, 0, 'translate(214 628)');
    opacity('invite-check', (t - 1.03) / .13);
    slide('invite-arrivals', (t - 1.15) / .45, 810, -170);
    const flight = ease((t - .9) / 1.5);
    transform('invite-arrow', `translate(${mix(-180, 1030, flight)} ${mix(680, 450, flight)}) rotate(-12) scale(${1 - ease((t - 3.3) / .25)})`);
    opacity('invite-arrow', (t - .9) / .1);
    for (let i = 0; i < 3; i++) {
      const p = pop((t - 1.5 - i * BEAT / 2) / .4);
      transform(`invite-person-${i}`, `translate(0 ${-75 * (1 - p)}) rotate(${Math.sin(clamp((t - 2.7 - i * .2) / .6) * Math.PI) * 5} 0 59)`);
      opacity(`invite-person-${i}`, p);
      blink(`invite-person-${i}`, t, 3.3 + i * .32);
    }
  }

  function people(t) {
    slide('people-type', (t - .25) / .42, -640, 140, 'rotate(-12 280 450)');
    slide('people-host', (t - .55) / .42, 0, 700);
    const zoom = mix(2.6, 1, ease(t / 1.62));
    scaleAt('people-seats', zoom, 1100, 300);
    transform('people-backdrop', `translate(${-13 * t} 0) rotate(-12 800 450)`);
    for (let i = 0; i < 20; i++) {
      const p = pop((t - .2 - i * .045) / .4);
      const wave = Math.sin(clamp((t - 2.1 - i * .085) / .6) * Math.PI);
      transform(`seat-${i}`, `translate(0 ${-135 * (1 - p) - wave * 10}) rotate(${wave * (i % 2 ? -5 : 5)} 0 59)`);
      opacity(`seat-${i}`, p);
      blink(`seat-${i}`, t, 4.2 + i * .103);
    }
    transform('host', `rotate(${Math.sin(clamp((t - 4.6) / .9) * Math.PI) * -5} 0 59)`);
    blink('host', t, 4.8);
    const close = t - 7 * BEAT;
    node('people-close').style.display = close >= 0 ? '' : 'none';
    for (let i = 0; i < 3; i++) {
      slide(`close-panel-${i}`, (close - i * .12) / .28, 0, i % 2 ? 980 : -980);
      const lean = Math.sin(clamp((close - .7 - i * .19) / 1.1) * Math.PI) * (i % 2 ? -5 : 5);
      transform(`close-person-${i}`, `rotate(${lean} 0 59)`);
      blink(`close-person-${i}`, close, 1.5 + i * .2);
    }
    slide('people-close-type', (close - .37) / .24, -1740, 240, 'rotate(-8 800 650)');
  }

  function more(t) {
    const cut = Math.min(2, Math.floor(t / (BAR * 2 / 3)));
    const local = t - cut * BAR * 2 / 3;
    ['game', 'art', 'code'].forEach((name, index) => { node(`more-${name}`).style.display = index === cut ? '' : 'none'; });
    const hit = pop(local / .34);
    scaleAt('more-game-picture', mix(1.75, 1, hit), 910, 370, mix(-22, 0, hit));
    transform('more-art-picture', `translate(800 450) rotate(${mix(8, -3, ease(local / 1.58))}) scale(1.05) translate(-800 -450)`);
    slide('more-art-type', local / .23, -850, 170, 'rotate(-12 800 450)');
    transform('more-pencil', `translate(${1190 - local * 62} ${150 + 20 * Math.sin(local * 3)}) rotate(32)`);
    scaleAt('more-code-picture', 1 + .035 * local);
    slide('more-code-type', local / .24, 1880, -400, 'rotate(-12 800 450)');
  }

  function end(t, poster) {
    const p = poster ? 1 : ease(t / .66);
    slide('end-slab', p, -1200, 0);
    scaleAt('end-brand', mix(2.15, 1, p), 510, 420, mix(-12, 0, p));
    slide('end-brand-top', poster ? 1 : (t - .08) / .55, -800, 0);
    slide('end-brand-bottom', poster ? 1 : (t - .2) / .48, 800, 0);
    const dot = poster ? 1 : pop((t - .62) / .48);
    transform('end-brand-dot', `translate(0 ${-450 * (1 - dot)})`);
    slide('end-type', poster ? 1 : (t - .55) / .42, -1040, 0);
    const character = poster ? 1 : pop((t - .45) / .57);
    scaleAt('end-character', mix(2, 1, character), 1290, 294, mix(-25, 0, character));
    opacity('end-character', poster ? 1 : (t - .4) / .13);
    slide('end-room', poster ? 1 : (t - .9) / .46, 600, 400);
    opacity('end-label', poster ? 1 : (t - .65) / .3);
    opacity('end-url', poster ? 1 : (t - 1.3) / .35);
    opacity('end-credit', poster ? 0 : (t - 3.3) / .5);
    transform('end-echo', `translate(${poster ? 0 : -12 * t} 0) rotate(-12 1100 450)`);
    transform('end-tv', `rotate(${poster ? 0 : -6 * Math.sin(clamp((t - 2.8) / 1.1) * Math.PI)})`);
    transform('end-host', `rotate(${poster ? 0 : 4 * Math.sin(clamp((t - 2) / 1.1) * Math.PI)} 0 59)`);
    blink('end-host', poster ? 0 : t, 3.3);
    for (let i = 0; i < 3; i++) blink(`end-friend-${i}`, poster ? 0 : t, 4.1 + i * .42);
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
    // The selected window fills the frame before the game; other edits use a
    // short diagonal cut. Long holds between edits keep the score from flickering.
    const cut = poster || index === 0 || index === 2 ? 1 : ease(local / .25);
    scenes.forEach((scene, i) => {
      const visible = i === index || (i === index - 1 && cut < 1);
      node(`scene-${scene.id}`).style.display = visible ? '' : 'none';
      node(`scene-${scene.id}`).removeAttribute('clip-path');
      if (visible) scene.render(i === index ? local : incoming.start - scene.start, poster);
    });
    if (cut < 1) {
      const edge = mix(1960, 0, cut);
      attr('slash-path', 'd', `M${edge} 0H1600V900H${edge - 360}Z`);
      node(`scene-${incoming.id}`).setAttribute('clip-path', 'url(#slash)');
    }
  }
  render(0, true);
  return { render };
}
