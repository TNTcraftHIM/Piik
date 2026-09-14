// One seekable score, measured in musical bars. No scene owns a timer.
import { gameMarkup, createGame } from '../assets/game.js';
import { mascotMarkup } from '../assets/brand.js';
import { GAME_KINDS, montageMarkup, createMontage } from '../assets/games.js';
import { sketchMarkup, createSketch } from '../assets/sketch.js';
import { photoMarkup, movieMarkup, movieAnswerPose } from '../assets/activities.js';
import { BEAT, BAR, INVITE_CUES, DOWNLOAD_AT, DURATION } from './score.js';
export { DURATION } from './score.js';

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
const sceneLabel = (value, fill = INK) => small(64, 64, value, fill, 'class="scene-label"');
const field = (fill) => rect(0, 0, 1600, 900, 0, fill);

function person(id, x, y, scale, colour, host = false) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g id="${id}">
    <use href="#pawn" fill="${colour}"/>
    <g id="${id}-eyes" fill="${INK}"><ellipse cx="-7" cy="-30.75" rx="2.75" ry="3.75"/><ellipse cx="7" cy="-30.75" rx="2.75" ry="3.75"/></g>
    ${host ? '<use href="#crown" transform="translate(-15 -70) scale(2.5)"/>' : ''}
  </g></g>`;
}

function mascot(id,x,y,scale,colour=PAPER) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g id="${id}" style="color:${INK}"><g transform="translate(-16 -16)">${mascotMarkup(id,colour)}</g></g></g>`;
}

function couch(x, y, width) {
  return `<g transform="translate(${x} ${y})">
    <path d="M24 77v20m${width - 48}-20v20" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
    ${rect(0, 0, width, 86, 28, '#e9ad63')}${rect(12, 62, width - 24, 27, 13, '#cd8845')}
    ${rect(-7, 35, 26, 58, 13, '#cd8845')}${rect(width - 19, 35, 26, 58, 13, '#cd8845')}
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

export function createArt(svg, language, onUI = () => {}) {
  const zh = language === 'zh-CN';
  const say = (en, cn) => zh ? cn : en;
  const appWindow = (id, title = 'Piik') => `<g transform="translate(540 144)"><g id="${id}">
    ${rect(17, 20, 1010, 726, 23, INK)}${rect(0, 0, 1010, 726, 23, PAPER, `stroke="${INK}" stroke-width="3"`)}
    ${[26, 43, 60].map((cx, i) => circle(cx, 24, 5, [ORANGE, YELLOW, '#85baa8'][i])).join('')}
    ${small(499, 31, title, INK, `id="${id}-title" text-anchor="middle"`)}
    <svg id="${id}-camera" x="12" y="47" width="986" height="663.31" viewBox="0 0 1100 740" overflow="hidden">${rect(-1000, -1000, 4000, 4000, 0, '#e8f3ef')}</svg>
  </g></g>`;
  const chapter = (first, second, note) => `${text(57, 286, first, zh ? 112 : 92)}${text(57, 419, second, zh ? 112 : 92)}
    ${text(62, 533, note, zh ? 29 : 26, INK, 'style="letter-spacing:-.02em;font-weight:650"')}`;
  const game = '<use href="#game-still"/>';
  const drawing = `${field(YELLOW)}<path d="M-130 750Q220-60 600 580T1720 300" fill="none" stroke="${ORANGE}" stroke-width="190"/>
    <g transform="translate(490 85) rotate(8 310 360)">${sketchMarkup('card-sketch')}</g>`;
  // Captions have a fixed left column; the objects on the right stay unobscured.
  const scenarioTitle = (id, first, second, cn, fill) => `<g id="${id}" transform="rotate(-8 380 450)">
    ${rect(-100, 270, 815, 342, 0, fill)}
    ${zh ? text(43, 492, cn, 126, fill===INK?PAPER:INK) : text(43,413,first,140,fill===INK?PAPER:INK)+text(43,555,second,140,fill===INK?PAPER:INK)}
  </g>`;
  const photos = photoMarkup();

  svg.innerHTML = `<defs>
    <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">${circle(4, 4, 2, INK)}</pattern>
    <clipPath id="slash"><path id="slash-path"/></clipPath>
    <clipPath id="title-top"><rect x="-1600" y="-900" width="4800" height="1226"/></clipPath>
    <clipPath id="title-bottom"><rect x="-1600" y="324" width="4800" height="1476"/></clipPath>
    <g id="wordmark">${text(85, 477, 'Piik', 407, PAPER)}</g>
    <g id="pawn"><circle cy="-31" r="20"/><path d="M-35 51.5c0-32.5 12.5-50 35-50s35 17.5 35 50q0 7.5-7.5 7.5h-55Q-35 59-35 51.5Z"/></g>
    <g id="crown" fill="#f7d861" stroke="#705025" stroke-width="1" stroke-linejoin="round"><path d="m1.2 6.3-1.2-3.7q-.2-.7.5-.4L3 3.6l2.4-2.5q.6-.7 1.2 0L9 3.6l2.5-1.4q.7-.3.5.4l-1.2 3.7q-.2.9-1.2.9H2.4q-1 0-1.2-.9Z"/><path d="M2.1 6.5h7.8" stroke="#b58a2f" stroke-width="1"/></g>
    <g id="game-still">${gameMarkup('card-game')}</g>
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
      ${text(70, 465, say('LOOK!', '快看！'), zh ? 248 : 270)}
      ${small(92, 640, say('PIIK / SCREEN SHARING FOR FRIENDS', 'PIIK / 和朋友分享屏幕'), PAPER)}
    </g>
    <g id="hello-character"><g transform="translate(1190 436) rotate(14)">
      ${mascot('hello-tv', 0, -15, 21, PAPER)}
      ${small(0, 294, 'PIIK / HELLO THERE', INK, 'text-anchor="middle"')}
    </g></g>
    <g id="hello-label">${sceneLabel('PIIK / SHARE THE GOOD STUFF', MINT)}${small(1536, 836, 'PIIK.TV', INK, 'text-anchor="end"')}</g>
    ${circle(800, 450, 0, ORANGE, 'id="hello-dot"')}
  </g>

  <g id="scene-discover">
    ${field(PAPER)}
    <g id="discover-type" transform="rotate(-12 800 450)">
      <g id="discover-line-top">${text(-70, 180, say('MOMENTS', '这一刻'), zh ? 345 : 265, 'none', `stroke="${INK}" stroke-width="2"`)}</g>
      <g id="discover-line-middle">${text(-60, 533, say('MOMENTS', '这一刻'), zh ? 345 : 265)}</g>
      <g id="discover-line-bottom">${text(-60, 886, say('MOMENTS', '这一刻'), zh ? 345 : 265, ORANGE)}</g>
    </g>
    <g id="discover-photo">
      ${rect(910, -170, 580, 1210, 0, MINT, 'transform="rotate(12 1200 450)"')}
      ${screen('discover-drawing', 976, -134, 530, drawing, 12)}
      ${screen('discover-game', 842, 310, 655, game, -12)}
      ${screen('discover-photos', 1025, 798, 530, photos, 12)}
    </g>
    <g id="discover-ticket" transform="translate(130 632) rotate(-12)">
      ${rect(12, 13, zh ? 661 : 795, 159, 0, ORANGE)}${rect(0, 0, zh ? 661 : 795, 159, 0, INK)}
      ${text(28, 120, say('SHARE IT.', '一起看。'), zh ? 125 : 150, PAPER)}
    </g>
    <g id="discover-label">${sceneLabel(say('SOME MOMENTS DESERVE AN AUDIENCE.', '这一刻，想让朋友也看看。'))}</g>
    <g id="discover-pointer"><path d="M0 0v91l25-24 21 43 23-11-22-43 39-5Z" fill="${INK}" stroke="${PAPER}" stroke-width="6" stroke-linejoin="round"/></g>
  </g>

  <g id="scene-game">
    ${montageMarkup()}
    <g id="montage-cheer" transform="rotate(-8 435 670)"><path d="M-70 552h945l-34 227H-105Z" fill="${YELLOW}"/>${text(63,736,say('NICE!','漂亮！'),zh?180:206)}</g>
  </g>

  <g id="scene-website">
    ${field(YELLOW)}<path d="m1170-50 230 0-254 1000H870Z" fill="${ORANGE}"/>
    ${sceneLabel('PIIK / 01')}
    <g id="website-type">${chapter(say('Get', '官网'), say('Piik.', '下载。'), say('Choose your system.', '选好对应系统的程序包。'))}
      ${small(62, 587, 'PIIK.TV')}
      ${text(55, 788, '01', 190, 'none', `stroke="${INK}" stroke-width="2" opacity=".3"`)}
    </g>
    ${appWindow('website-window', 'piik.tv')}
  </g>

  <g id="scene-desktop">
    ${field(YELLOW)}<path d="m1170-50 230 0-254 1000H870Z" fill="${ORANGE}"/>
    ${sceneLabel('PIIK / 02')}
    <g id="desktop-type">${chapter(say('Unpack.', '解压，'), say('Open.', '打开。'), say('Keep the full package together.', '保留程序包的完整目录。'))}
      ${small(62, 587, say('OPEN PIIK APP', '打开 Piik App'))}
      ${text(55, 788, '02', 190, 'none', `stroke="${INK}" stroke-width="2" opacity=".3"`)}
    </g>
    ${appWindow('desktop-window', say('Desktop', '桌面'))}
  </g>

  <g id="scene-launch">
    ${field(YELLOW)}<path d="m1170-50 230 0-254 1000H870Z" fill="${ORANGE}"/>
    ${sceneLabel('PIIK / 03')}
    <g id="launch-type">${chapter(say('Pick a', '选好'), say('mode.', '模式。'), say('Public invite for distant friends.', '异地朋友，选「公网邀请」。'))}
      ${small(62, 587, say('CONTROLS OPEN IN YOUR BROWSER', '在浏览器里，开始分享。'))}
      ${text(55, 788, '03', 190, 'none', `stroke="${INK}" stroke-width="2" opacity=".3"`)}
    </g>
    ${appWindow('launch-window')}
  </g>

  <g id="scene-share">
    <g id="share-picture">
      ${field(PAPER)}<path d="M960-100h770v1100H640Z" fill="${MINT}"/>
      <g id="share-type">${chapter(say('Pick.', '选个'), say('Share.', '画面。'), say('A window. A screen. Your call.', '窗口、屏幕，都能分享。'))}
        ${small(62, 587, say('PICTURE + SOUND', '画面与声音，一起分享'))}
        ${text(55, 788, '04', 190, 'none', `stroke="${INK}" stroke-width="2" opacity=".3"`)}
      </g>
      ${appWindow('share-window')}
    </g>
    <g id="share-label">${sceneLabel('PIIK / 04')}</g>
  </g>

  <g id="scene-invite">
    ${field(ORANGE)}<path d="M1060-100h650v1100H760Z" fill="${YELLOW}"/>
    ${sceneLabel('PIIK / 05')}
    <g id="invite-type">${chapter(say('Send a', '发个'), say('link.', '邀请。'), say('Paste it into your chat.', '把链接发到你们的聊天里。'))}
      ${small(62, 587, say('FRIENDS WATCH IN THEIR BROWSER', '朋友用浏览器就能看。'))}
      ${text(55, 788, '05', 190, 'none', `stroke="${INK}" stroke-width="2" opacity=".3"`)}
    </g>
    ${appWindow('invite-window')}
  </g>

  <g id="scene-features">
    <g id="feature-free">${field(INK)}
      <path d="m1030-100 750 0-220 1100H820Z" fill="${ORANGE}"/>
      ${text(805, 874, '0', 1070, YELLOW, 'transform="rotate(12 1160 470)"')}
      ${text(1220, 151, say('COST TO USE', '使用费用'), 42, INK, 'text-anchor="middle" style="letter-spacing:0;font-weight:800"')}
      ${zh ? text(1418, 800, '元', 87, INK) : ''}
      <g id="free-type" transform="rotate(-12 740 450)">${text(82, 370, say('FREE.', '免费。'), 248, PAPER)}${zh ? text(57, 628, '开源。', 248, MINT) : text(57, 525, 'OPEN', 160, MINT) + text(57, 680, 'SOURCE.', 160, MINT)}</g>
      ${sceneLabel(say('PIIK / FEATURES', 'PIIK / 产品特点'), PAPER)}${small(64, 833, say('MIT LICENSE / MAKE IT YOUR OWN', 'MIT 许可 / 按自己的想法改。'), PAPER)}
    </g>
    <g id="feature-p2p">${field(MINT)}
      <path d="M1255-80h475v1080H929Z" fill="${PAPER}"/>
      <g id="p2p-diagram">
        <path id="p2p-link" d="M1087 399 1347 506m-47 9 47-9-27-39" fill="none" stroke="${INK}" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
        <g id="p2p-packet">${rect(-22,-14,44,28,8,ORANGE,`stroke="${PAPER}" stroke-width="4"`)}</g>
        ${screen('p2p-source',900,181,274,game,-8)}
        ${screen('p2p-viewer',1226,559,274,game,-8)}
      </g>
      <g id="p2p-type" transform="rotate(-8 600 450)">
        ${text(74,315,say('DIRECT.','直连。'),zh?202:184)}
        ${rect(-115,383,950,200,0,INK)}${text(57,538,say('LOW LATENCY.','低延迟。'),zh?160:106,PAPER)}
      </g>
      ${sceneLabel(say('PIIK / FEATURES', 'PIIK / 产品特点'))}
      ${text(65,793,say('A direct path first, so friends can keep up.','画面优先直达朋友，精彩及时跟上。'),30,INK,'style="letter-spacing:0;font-weight:650"')}
    </g>
    <g id="feature-encode">${field(YELLOW)}
      <path d="M1200-100h580v1100H871Z" fill="${ORANGE}"/>
      <g id="encode-pictures">
        <path d="M1220 429v111M990 627v-87h426v87m-284-87v87m142-87v87" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
        ${screen('encode-picture',1000,168,410,drawing,-5)}
        <g id="encode-audience">
          ${[colours[0],colours[1],colours[3],colours[4]].map((colour,i)=>`<g transform="translate(${990+i*142} 690)"><circle cy="-5" r="61" fill="${PAPER}"/>${person(`encode-person-${i}`,0,1,1.1,colour)}</g>`).join('')}
        </g>
        ${[0,1,2,3].map(i=>`<g id="encode-packet-${i}">${rect(-12,-9,24,18,5,PAPER,`stroke="${INK}" stroke-width="3"`)}</g>`).join('')}
        ${small(1220,110,say('ONE PICTURE, SHARED.','一份画面，多人共享。'),INK,'text-anchor="middle"')}
      </g>
      <g id="encode-type" transform="rotate(-8 600 450)">
        ${text(62,321,say('EFFICIENT','高效分享。'),zh?155:140)}
        ${rect(-110,388,945,197,0,INK)}${text(48,541,say('SHARING.','轻负担。'),zh?164:153,PAPER)}
      </g>
      ${sceneLabel(say('PIIK / FEATURES', 'PIIK / 产品特点'))}
      ${text(65,793,say('Reuse picture processing where supported, for efficient sharing with friends.','能共用的画面处理，就不重复做；多人分享也讲效率。'),30,INK,'style="letter-spacing:0;font-weight:650"')}
    </g>
    <g id="feature-devices">${field(INK)}
      <path d="M1210-80h480v1060H908Z" fill="${MINT}"/>
      ${circle(1250,422,274,ORANGE)}
      <g id="devices-laptop"><g transform="translate(922 225) rotate(-8)">
        ${screen('devices-browser',0,0,480,game)}
        <path d="M-25 313h530v10q-6 15-28 15H3q-22 0-28-15Z" fill="${PAPER}"/>
        <path d="M190 314h100l-7 8h-86Z" fill="#b8c9bf"/>
      </g></g>
      <g id="devices-tablet"><g transform="translate(976 568) rotate(-8)">
        ${rect(10,12,310,194,24,INK)}${rect(0,0,310,194,24,PAPER)}
        ${rect(12,12,286,170,14,INK)}
        <svg x="14" y="18" width="282" height="158.625" viewBox="0 0 1600 900">${game}</svg>
        ${rect(124,183,62,4,2,'#b8c9bf')}
      </g></g>
      <g id="devices-phone"><g transform="translate(1352 380) rotate(9)">
        ${rect(10,12,174,330,28,INK)}${rect(0,0,174,330,28,PAPER)}
        ${rect(11,32,152,266,15,INK)}${rect(62,14,50,5,2.5,'#b8c9bf')}
        <svg x="11" y="122" width="152" height="85.5" viewBox="0 0 1600 900">${game}</svg>
        ${rect(58,312,58,5,2.5,'#b8c9bf')}
      </g></g>
      <g id="devices-type" transform="rotate(-8 600 450)">
        ${text(62,321,say('DESKTOP.','电脑手机。'),zh?155:146,PAPER)}
        ${rect(-110,388,945,197,0,YELLOW)}${text(48,541,say('MOBILE.','都能看。'),zh?180:174)}
      </g>
      ${sceneLabel(say('PIIK / FEATURES', 'PIIK / 产品特点'),PAPER)}
      ${text(65,793,say('Open the invite. Watch in your browser.','点开邀请链接，用浏览器加入。'),30,PAPER,'style="letter-spacing:0;font-weight:650"')}
    </g>
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
        ${[0, 1, 2, 3, 4].map((col) => person(`seat-${row * 5 + col}`, 79 + col * 157, -11, 1.02, colours[(row + col) % colours.length])).join('')}
      </g>`).join('')}
    </g></g>
    <g id="people-host"><g transform="translate(495 379) rotate(-12)">${couch(-61, 9, 122)}${person('host', 0, -7, .91, '#83c4a5', true)}</g></g>
    ${sceneLabel(say('SAVE YOUR FRIENDS A SEAT.', '给朋友留个位置。'))}
    <g id="people-close">
      ${field(INK)}
      ${[PAPER, ORANGE, MINT].map((colour, i) => `<g id="close-panel-${i}">
        ${rect(i * 536, 0, 538, 900, 0, colour)}
        <g transform="translate(${267 + i * 536} 591)">
          ${person(`close-person-${i}`, 0, 0, 5.1, colours[i])}
        </g>
        ${text(66 + i * 536, 180, ['01', '02', '03'][i], 159, 'none', `stroke="${INK}" stroke-width="2" opacity=".28"`)}
      </g>`).join('')}
      <g id="people-close-type" transform="rotate(-8 800 650)">${rect(-50, 590, 1710, 190, 0, INK)}${text(150, 736, say('ALL TOGETHER.', '朋友到齐。'), zh ? 175 : 159, PAPER)}</g>
      ${sceneLabel(say('THAT’S MORE LIKE IT.', '这下热闹了。'))}
    </g>
  </g>

  <g id="scene-more">
    <g id="more-game">${field(ORANGE)}
      <g transform="rotate(-12 800 450)">${text(85, 358, say('ONE MORE', '再开一局。'), 230)}
        ${rect(-240, 450, 2120, 320, 0, INK)}
      </g>
      <g id="more-game-picture"><g transform="translate(1270 425) rotate(14) scale(1.2)"><use href="#pad"/></g></g>
      <g transform="rotate(-12 800 450)">${text(zh ? 130 : 95, 660, say('ROUND.', '叫上朋友。'), zh ? 168 : 210, PAPER)}</g>
      ${sceneLabel(say('PLAY / GIVE YOUR FRIENDS A FRONT-ROW SEAT', '这一把，让朋友也看看。'))}
    </g>
    <g id="more-art">${field(YELLOW)}
      <path d="M140-40q-89 356 207 441T246 981" fill="none" stroke="${ORANGE}" stroke-width="118"/>
      <g id="more-art-picture"><g transform="translate(844 110) rotate(8 310 360)">
        ${rect(13, 17, 620, 720, 5, INK, 'opacity=".16"')}
        <g id="sketch-paper">${sketchMarkup('film-sketch')}</g>
        <g id="more-pencil"><g transform="rotate(35)">${rect(-10, -188, 20, 160, 4, INK)}<path d="m-10-28 10 28 10-28Z" fill="#d6b68b"/><path d="M-3-9 0 0 3-9Z" fill="${INK}"/><path d="M-4-172v133" stroke="${PAPER}" stroke-width="2" opacity=".4"/></g></g>
      </g></g>
      ${scenarioTitle('more-art-type','MAKE A','MARK.','画上两笔。',INK)}
      ${sceneLabel(say('DRAW / FROM FIRST LINE TO FINAL TOUCH', '从第一笔，看到最后一笔。'))}
    </g>
    <g id="more-photos">${field(INK)}
      <g id="more-photos-picture"><svg x="746" y="74" width="810" height="748" viewBox="100 0 1380 900">${photos}</svg></g>
      ${scenarioTitle('more-photos-type','PHOTO','TIME.','翻翻相册。',MINT)}
      ${sceneLabel(say('BY THE PIER / KEEP AN EYE ON YOUR FRIES.', '去码头整点薯条。'), PAPER)}
    </g>
    <g id="more-movie">${field('#324458')}
      <g id="more-movie-picture">${movieMarkup('movie-answer')}</g>
      ${scenarioTitle('more-movie-type','MOVIE','NIGHT.','看场电影。',PAPER)}
      ${sceneLabel(say('MOVIE NIGHT / THE ANSWER IS 42.', '宇宙终极答案，是 42。'), PAPER)}
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
    <g id="end-type">${text(96, 604, say('Share the', '来，看点'), zh ? 114 : 112, PAPER)}${text(96, 734, say('good stuff.', '好康的。'), zh ? 114 : 112, MINT)}</g>
    <g id="end-character"><g transform="translate(1290 294) rotate(14)">
      ${circle(0, 0, 242, ORANGE)}${circle(35, 24, 242, 'url(#dots)', 'opacity=".25"')}${mascot('end-tv', 0, 0, 15, PAPER)}
    </g></g>
    <g id="end-room"><g transform="translate(961 637) rotate(-12)">
      ${couch(0, 0, 577)}
      ${person('end-host', 77, -13, 1.25, '#83c4a5', true)}
      ${person('end-friend-0', 221, -13, 1.25, colours[0])}${person('end-friend-1', 365, -13, 1.25, colours[3])}${person('end-friend-2', 509, -13, 1.25, colours[1])}
      <g id="end-gamepad" transform="translate(77 32) rotate(-9) scale(.25)"><use href="#pad"/>${circle(-167, 70, 35, '#83c4a5')}${circle(167, 70, 35, '#83c4a5')}</g>
    </g></g>
    <g id="end-label">${sceneLabel(say('SCREEN SHARING FOR FRIENDS', '开个房间，叫朋友来。'), MINT)}</g>
    <g id="end-url">${text(1500, 799, 'piik.tv', 46, INK, 'text-anchor="end"')}${small(98, 802, say('FREE & OPEN SOURCE / GET PIIK', '免费开源 · 下载 PIIK'), PAPER)}</g>
    <g id="download-banner">
      ${rect(0,762,1600,84,0,ORANGE)}
      ${text(76,821,say('Download Piik ↗','下载 Piik ↗'),48,INK,'style="letter-spacing:-.02em"')}
      ${small(780,814,'Windows · macOS · Linux',INK,'text-anchor="middle"')}
      ${text(1500,823,'piik.tv',60,INK,'text-anchor="end"')}
    </g>
    <g id="download-credit">${rect(0,846,1600,54,0,PAPER)}${text(800,869,'Music: “Funkorama” — Kevin MacLeod · incompetech.com · CC BY 4.0 · edited excerpt',15,INK,'text-anchor="middle" style="letter-spacing:0;font-weight:450"')}${text(800,890,'creativecommons.org/licenses/by/4.0/',14,INK,'text-anchor="middle" style="letter-spacing:0;font-weight:450"')}</g>
  </g>`;

  const nodes = new Map(Array.from(svg.querySelectorAll('[id]'), (el) => [el.id, el]));
  const node = (id) => nodes.get(id);
  const endMark = node('end-tv').querySelector('.mascot-shell').parentElement;
  endMark.classList.add('lr-brand-mark');
  for (const [part, className] of [['open', 'eye-open'], ['wink', 'eye-wink'], ['sparkles', 'sparkles']]) {
    node(`end-tv-${part}`).classList.add(`lr-brand-${className}`);
  }
  const drawGame = createGame(svg, 'card-game');
  const drawMontage = createMontage(svg, 5 * BAR / GAME_KINDS.length);
  const drawSketch = createSketch(svg, 'film-sketch');
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
    slide('hello-slab', t / (BEAT / 2), 1100, 0);
    slide('hello-word', (t - BEAT / 4) / (BEAT / 2), -1380, 265, 'rotate(-12 740 450)');
    const arrive = pop((t - BEAT / 2) / BEAT);
    scaleAt('hello-character', mix(2.7, 1, arrive), 1190, 436, mix(-19, 0, arrive));
    opacity('hello-character', (t - BEAT / 2) / (BEAT / 4));
    opacity('hello-tv-open',t<1.5*BEAT?1:0);
    opacity('hello-tv-wink',t<1.5*BEAT?0:1);
    const wink=clamp((t-1.5*BEAT)/BEAT);
    opacity('hello-tv-sparkles',Math.sin(wink*Math.PI));
    transform('hello-tv-sparkles',`translate(${wink*5} ${wink*-5})`);
    transform('hello-echo', `translate(${-18 * t} 0)`);
    opacity('hello-label', (t - BEAT) / (BEAT / 2));
    // The brand dot begins the film and opens the next cut, like an aperture.
    attr('hello-dot', 'r', t < BEAT / 2 ? 19 * (1 - ease(t / (BEAT / 2))) : 1080 * ease((t - 3.5 * BEAT) / (BEAT / 2)));
  }

  function discover(t) {
    transform('discover-type', `translate(${-60 * t} ${24 * t}) rotate(-12 800 450)`);
    slide('discover-line-top', t / (BEAT / 2), -920, 0);
    slide('discover-line-middle', (t - BEAT / 8) / (BEAT / 2), 1230, 0);
    slide('discover-line-bottom', (t - BEAT / 4) / (BEAT / 2), -1380, 0);
    slide('discover-photo', t / BEAT, 770, -160);
    slide('discover-ticket', (t - BEAT) / (BEAT / 2), -1100, 220, 'translate(130 632) rotate(-12)');
    const click = ease((t - 2 * BEAT) / (BEAT / 2));
    transform('discover-pointer', `translate(${mix(1640, 1230, click)} ${mix(940, 586, click)}) scale(${1 - .22 * Math.sin(clamp((t - 3 * BEAT) / (BEAT / 2)) * Math.PI)})`);
    opacity('discover-pointer', click * (1 - ease((t - 3.5 * BEAT) / (BEAT / 2))));
  }

  function website(t) {
    slide('website-window',t/BEAT,1150,190);
    slide('website-type',t/(BEAT/2),-610,130);
  }
  function desktop(t) {
    transform('desktop-window','translate(0 0)');
    slide('desktop-type',t/(BEAT/2),-610,130);
  }
  function launch(t) {
    transform('launch-window','translate(0 0)');
    slide('launch-type',t/(BEAT/2),-610,130);
  }
  function share(t) {
    // The same product window stays in place as the chapter changes.
    transform('share-window','translate(0 0)');
    slide('share-type',t/(BEAT/2),-610,130);
    const zoom=ease((t-6*BEAT)/(2*BEAT));
    const scale=mix(1,1600/(930*986/1100),zoom);
    opacity('share-label',1-ease((t-5.5*BEAT)/(BEAT/2)));
    transform('share-picture',`translate(${-628.19*scale*zoom} ${-270.78*scale*zoom}) scale(${scale})`);
  }

  function gameScene(t) {
    drawMontage(t, 8 * BAR + t);
  }

  function invite(t) {
    node('invite-window-title').textContent = t >= INVITE_CUES.chat && t < INVITE_CUES.viewer ? say('Chat', '聊天') : 'Piik';
    slide('invite-window',t/BEAT,1140,140);
    slide('invite-type',t/(BEAT/2),-610,130);
  }

  function features(t) {
    // Four benefits fit the same five bars; no long hold after the direct hop.
    const cut = t < BAR ? 0 : t < 2 * BAR ? 1 : t < 3.5 * BAR ? 2 : 3;
    const local = t - [0, BAR, 2 * BAR, 3.5 * BAR][cut];
    ['free', 'p2p', 'encode', 'devices'].forEach((name, i) => { node(`feature-${name}`).style.display = i === cut ? '' : 'none'; });
    slide('free-type', local / (BEAT / 2), -1500, 290, 'rotate(-12 740 450)');
    slide('p2p-type', local / (BEAT / 2), -1150, 180, 'rotate(-8 600 450)');
    slide('p2p-diagram',local/BEAT,600,0);
    const packet=clamp((local-1.5*BEAT)/(1.5*BEAT));
    transform('p2p-packet',`translate(${mix(1087,1347,packet)} ${mix(399,506,packet)}) rotate(22)`);
    opacity('p2p-packet',local>=1.5*BEAT&&local<3*BEAT?1:0);
    slide('encode-type', local / (BEAT / 2), -1200, 180, 'rotate(-8 600 450)');
    slide('encode-pictures',local/BEAT,610,0);
    for(let i=0;i<4;i++) {
      const p=clamp((local-(1.5+i*.2)*BEAT)/(2*BEAT));
      const x=990+i*142;
      // One frame leaves the source and follows the shared trunk to each viewer.
      const point=p<.35?[1220,mix(429,540,p/.35)]:p<.72?[mix(1220,x,(p-.35)/.37),540]:[x,mix(540,620,(p-.72)/.28)];
      transform(`encode-packet-${i}`,`translate(${point[0]} ${point[1]})`);
      opacity(`encode-packet-${i}`,p>0&&p<1?1:0);
      const arrive=pop((local-(3.5+i*.2)*BEAT)/BEAT);
      transform(`encode-person-${i}`,`translate(0 ${-9*Math.sin(clamp(arrive)*Math.PI)})`);
      blink(`encode-person-${i}`,local,3.1+i*.23);
    }
    slide('devices-type',local/(BEAT/2),-1200,180,'rotate(-8 600 450)');
    ['laptop','tablet','phone'].forEach((device,i) => {
      const progress=pop((local-i*BEAT*.65)/BEAT);
      transform(`devices-${device}`,`translate(${420*(1-progress)} ${110*(1-progress)})`);
      opacity(`devices-${device}`,progress);
    });
  }

  function people(t) {
    slide('people-type', (t - BEAT / 2) / (BEAT / 2), -640, 140, 'rotate(-12 280 450)');
    slide('people-host', (t - BEAT) / (BEAT / 2), 0, 700);
    const zoom = mix(2.6, 1, ease(t / (2.5 * BEAT)));
    scaleAt('people-seats', zoom, 1100, 300);
    transform('people-backdrop', `translate(${-13 * t} 0) rotate(-12 800 450)`);
    for (let i = 0; i < 20; i++) {
      const p = pop((t - BEAT / 2 - i * BEAT / 16) / (BEAT / 2));
      const wave = Math.sin(clamp((t - 4 * BEAT - i * BEAT / 8) / BEAT) * Math.PI);
      transform(`seat-${i}`, `translate(0 ${-135 * (1 - p) - wave * 10}) rotate(${wave * (i % 2 ? -5 : 5)} 0 59)`);
      opacity(`seat-${i}`, p);
      blink(`seat-${i}`, t, 4.2 + i * .103);
    }
    transform('host', `rotate(${Math.sin(clamp((t - 4.6) / .9) * Math.PI) * -5} 0 59)`);
    blink('host', t, 4.8);
    const close = t - 7 * BEAT;
    node('people-close').style.display = close >= 0 ? '' : 'none';
    for (let i = 0; i < 3; i++) {
      slide(`close-panel-${i}`, (close - i * BEAT / 4) / (BEAT / 2), 0, i % 2 ? 980 : -980);
      const lean = Math.sin(clamp((close - .7 - i * .19) / 1.1) * Math.PI) * (i % 2 ? -5 : 5);
      transform(`close-person-${i}`, `rotate(${lean} 0 59)`);
      blink(`close-person-${i}`, close, 1.5 + i * .2);
    }
    slide('people-close-type', (close - BEAT) / (BEAT / 2), -1740, 240, 'rotate(-8 800 650)');
  }

  function more(t) {
    const cut = Math.min(3, Math.floor(t / (BAR * 3 / 4)));
    const local = t - cut * BAR * 3 / 4;
    ['game', 'art', 'photos', 'movie'].forEach((name, index) => { node(`more-${name}`).style.display = index === cut ? '' : 'none'; });
    const hit = pop(local / (BEAT / 2));
    scaleAt('more-game-picture', mix(1.75, 1, hit), 1270, 425, mix(-22, 0, hit));
    slide('more-art-picture',local/(BEAT/2),480,80);
    slide('more-art-type', local / (BEAT/2), -850, 120, 'rotate(-8 380 450)');
    const tip=drawSketch((local-BEAT/4)/(2*BEAT));
    transform('more-pencil',`translate(${tip.x} ${tip.y})`);
    opacity('more-pencil',1-ease((local-2.5*BEAT)/(BEAT/2)));
    scaleAt('more-photos-picture', 1 + .015 * local,1200,450);
    slide('more-photos-type', local / (BEAT/2), -850, 120, 'rotate(-8 380 450)');
    slide('more-movie-type', local / (BEAT/2), -850, 120, 'rotate(-8 380 450)');
    node('movie-answer').style.transform = movieAnswerPose(local/(3*BEAT));
  }

  function end(t, poster) {
    endMark.classList.toggle('is-animated', !poster);
    endMark.classList.toggle('is-loop-active', !poster);
    const p = poster ? 1 : ease(t / BEAT);
    slide('end-slab', poster ? 1 : t / BEAT, -1200, 0);
    scaleAt('end-brand', mix(2.15, 1, p), 510, 420, mix(-12, 0, p));
    slide('end-brand-top', poster ? 1 : (t - BEAT / 4) / BEAT, -800, 0);
    slide('end-brand-bottom', poster ? 1 : (t - BEAT / 2) / BEAT, 800, 0);
    const dot = poster ? 1 : pop((t - BEAT) / BEAT);
    transform('end-brand-dot', `translate(0 ${-450 * (1 - dot)})`);
    slide('end-type', poster ? 1 : (t - BEAT) / (BEAT / 2), -1040, 0);
    const character = poster ? 1 : pop((t - BEAT) / BEAT);
    scaleAt('end-character', mix(2, 1, character), 1290, 294, mix(-25, 0, character));
    opacity('end-character', poster ? 1 : (t - .75 * BEAT) / (BEAT / 2));
    slide('end-room', poster ? 1 : (t - 2 * BEAT) / BEAT, 600, 400);
    opacity('end-label', poster ? 1 : (t - BEAT) / (BEAT / 2));
    const outro = poster ? -1 : t - (DOWNLOAD_AT - 27 * BAR);
    opacity('end-url', (poster ? 1 : clamp((t - 3 * BEAT) / (BEAT / 2))) * (1 - ease(outro / BEAT)));
    transform('end-echo', `translate(${poster ? 0 : -12 * t} 0) rotate(-12 1100 450)`);
    transform('end-tv', `rotate(${poster ? 0 : -6 * Math.sin(clamp((t - 2.8) / 1.1) * Math.PI)})`);
    transform('end-host', `rotate(${poster ? 0 : 4 * Math.sin(clamp((t - 2) / 1.1) * Math.PI)} 0 59)`);
    blink('end-host', poster ? 0 : t, 3.3);
    for (let i = 0; i < 3; i++) blink(`end-friend-${i}`, poster ? 0 : t, 4.1 + i * .42);
    node('download-banner').style.display = outro < 0 ? 'none' : '';
    slide('download-banner',outro/BEAT,-1600,0);
    opacity('download-credit',(outro-BEAT)/BEAT);
  }

  const scenes = [
    { id: 'hello', start: 0, render: hello },
    { id: 'discover', start: BAR, render: discover },
    { id: 'website', start: 2 * BAR, render: website },
    { id: 'desktop', start: 3.5 * BAR, render: desktop },
    { id: 'launch', start: 4.5 * BAR, render: launch },
    { id: 'share', start: 6 * BAR, render: share },
    { id: 'game', start: 8 * BAR, render: gameScene },
    { id: 'invite', start: 13 * BAR, render: invite },
    { id: 'people', start: 16 * BAR, render: people },
    { id: 'features', start: 19 * BAR, render: features },
    { id: 'more', start: 24 * BAR, render: more },
    { id: 'end', start: 27 * BAR, render: end },
  ];
  function render(time, poster = false, idle = false) {
    const t = clamp(time, 0, DURATION);
    drawGame(poster ? 1.7 : t);
    const index = poster ? scenes.findIndex(scene => scene.id === 'end') : scenes.findLastIndex((scene) => t >= scene.start);
    const incoming = scenes[index];
    const local = poster ? 5 : t - incoming.start;
    // The shared preview fills the frame before the game; other edits use a
    // short diagonal cut. Long holds between edits keep the score from flickering.
    const cut = poster || index === 0 || incoming.id === 'game' ? 1 : ease(local / (BEAT / 2));
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
    // Fit three loading-mascot loops into the settled closing card. End in the
    // loop's quiet tail so both sparkles finish before the music, including the
    // last exported frame. Native idle playback continues from this same phase.
    const closingProgress = clamp((t - (27 * BAR + BEAT)) / (DURATION - (27 * BAR + BEAT)));
    endMark.getAnimations({subtree: true}).forEach(animation => {
      if (idle) {
        if (animation.playState !== 'running') animation.play();
      } else {
        animation.pause();
        animation.currentTime = closingProgress * (3 * Number(animation.effect.getTiming().duration) - BEAT * 250);
      }
    });
    const product=!poster&&['website','desktop','launch','share','invite'].includes(incoming.id);
    const camera=product?node(`${incoming.id}-window-camera`):null;
    const matrix=camera?svg.getCTM()?.inverse().multiply(camera.getCTM()):null;
    onUI({scene:product?incoming.id:null,local,time:t,matrix});
  }
  render(0, true);
  return { render };
}
