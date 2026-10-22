import { C, background, r, circle, path, group, text, small, english, star, pawn, sofa, speech, brand, cursor, footer, uiFrame, ease, spring, mix, clamp } from './drawing.js';
import { arena } from './game.js';
import { PARTY } from './party-score.js';
import { COLOURS } from './cast.js';
import { BEAT as UI_BEAT } from './ui-score.js';
import { SOURCE_READ } from './score.js';

const red = '#ef3f56';
const backgrounds = [C.ink, C.paper, C.blue, C.yellow, red, C.paper, C.blue, C.ink, C.ink, red, C.paper];
const wipe = (b, color) => {
  const x = ease(b / .7) * 1960;
  return b < .7 ? group(`translate(${x} 0)`, path('M-180 0H1600L1410 900H-370Z', color)) : '';
};
const title = (x, y, words, size, color, b, angle = -5) => {
  const p = spring(b / .85), shift = (1 - ease(b / .55)) * 180;
  return group(`translate(${x + shift} ${y}) rotate(${angle}) scale(${1.14 - p * .14} ${.75 + p * .25})`,
    (color === C.ink ? '' : text(9, 12, words, size, C.ink)) + text(0, 0, words, size, color), `opacity="${clamp(b * 7)}"`);
};
const rays = (x, y, b, color, id) => group(`translate(${x} ${y}) rotate(${b * 2})`,
  Array.from({ length: 14 }, (_, i) => group(`rotate(${i * 360 / 14})`,
    path('M180-5 1300-30 1300 30 180 5Z', color))).join(''), `opacity=".13" id="${id}"`);
const keycap = (x, y, key, fill) => group(`translate(${x} ${y}) rotate(-5)`,
  r(0, 7, 94, 76, C.ink, 7) + r(0, 0, 94, 76, fill, 7, `stroke="${C.ink}" stroke-width="3"`) +
  text(47, 53, key, 43, C.ink, 'text-anchor="middle"'));
function portrait(x, y, w, actor, time, speaking = false) {
  return group(`translate(${x} ${y})`,
    path(`M-10 0 ${w} -25 ${w - 50} 360 -45 385Z`, C.ink) +
    path(`M0 0 ${w - 10} -15 ${w - 60} 340 -33 365Z`, C.paper) +
    path(`M0 0 ${w - 10} -15 ${w - 17} 37 -4 52Z`, COLOURS[actor]) +
    pawn(w * .45, 188, 2.35, actor, time, { talking: speaking, eyes: actor === 0 ? 2 : -2 }) +
    group(`translate(30 332) rotate(-4)`, r(-14, -32, w * .74, 54, C.paper) +
      small(0, 5, ['阿团 · 房主', '小圆 · 朋友', '阿点 · 围观'][actor], 26)));
}
function invitation(x, y, w, b) {
  return group(`translate(${x} ${y}) rotate(${mix(-17, -4, ease(b))})`,
    r(12, 14, w, 205, C.ink) + r(0, 0, w, 205, C.paper, 0, `stroke="${C.ink}" stroke-width="4"`) +
    text(27, 68, '阿团邀请你一起玩', 42) +
    small(29, 116, 'Piik · 屏幕共享', 26) +
    r(27, 141, w - 54, 39, C.blue) +
    small(w / 2, 170, '打开邀请', 25, C.paper, 'text-anchor="middle"'));
}

export function story({ index, local: b, speaker }, time, id) {
  let art = '', ui, front = '';
  const p = ease(b / 1.2);
  if (index === 0) {
    // Establish a visible missing second player before introducing the tool.
    art = background(C.ink) +
      group(`translate(800 465) rotate(${mix(4, -2, p)}) scale(${mix(1.12, 1, p)})`, arena(-730, -365, 1460, 0, true, id + '-game')) +
      path('M0 0H1060L960 220H0Z', C.blue) +
      title(62, 170, '来一局？', 150, C.paper, b, -3) +
      small(1530, 82, '这局，想和你一起玩。', 29, C.paper, 'text-anchor="end"') +
      portrait(55 - (1 - p) * 400, 470, 350, 0, time, speaker === 0) +
      speech(390, 567, '缺个对手。', spring((b - 1.4) / .9), C.yellow, 4) +
      footer('Piik 屏幕共享 / 把朋友叫到屏幕这边。', C.paper);
    if (b > 6.8) front = group(`translate(${1600 - ease((b - 6.8) / 1.2) * 1900} 0)`, path('M0 0H1900V900H-220Z', C.paper));
  } else if (index === 1) {
    art = background(C.paper) +
      path('M0 0H685L480 900H0Z', C.blue) + path('M1000 0H1600V900H1210Z', red) +
      portrait(105 - (1 - p) * 450, 270, 420, 0, time, speaker === 0) +
      portrait(1110 + (1 - p) * 450, 270, 420, 1, time, speaker === 1) +
      group(`translate(800 173) rotate(-4)`, text(0, 0, '人不在旁边？', 107, C.ink, 'text-anchor="middle"')) +
      title(530, 417, '叫过来。', 115, C.blue, b - .7, -8) +
      path('M560 500C670 700 960 300 1060 520m-42-30 42 30-48 16', 'none', `stroke="${C.ink}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${850 * ease((b - .9) / 2)} 850"`) +
      small(800, 746, '让朋友打开你的邀请，就能看到你的屏幕。', 33, C.ink, 'text-anchor="middle"') +
      footer('一台电脑开局，朋友在远处加入。');
  } else if (index === 2) {
    art = background(C.blue) +
      text(70, 118, '先，分享你的屏幕。', 80, C.paper) +
      english(1210, 160, '01', 140, C.yellow) +
      uiFrame(260, 164, 1118, 675) +
      small(74, 436, '选', 88, C.paper) + small(74, 546, '源', 88, C.paper) +
      star(1480, 690, 62, C.yellow, b * 5) + footer('选择游戏窗口 → 开始分享', C.paper);
    const sourceBeat = b - Math.max(0, Math.min(SOURCE_READ.beats, b - SOURCE_READ.at));
    ui = { x: 274, y: 210, w: 1090, scene: 'share', local: sourceBeat * UI_BEAT, time, clipHeight: 615 };
  } else if (index === 3) {
    const arrival = ease((b - 8.1) / 1.1);
    art = background(C.yellow) +
      text(65, 116, b < 8.1 ? '发个邀请。' : '点开，就在同一个房间。', b < 8.1 ? 108 : 75) +
      path('M1300 0H1600V900H1100Z', C.paper) +
      uiFrame(105, 150, 956, 680) +
      pawn(1380, 542 - arrival * 65, 3.2, 1, time, { talking: speaker === 1, tilt: (1 - p) * 15, eyes: -2 }) +
      speech(1190, 244, b < 8.1 ? '发我！' : '看到了！', 1, C.paper, 5) +
      small(1350, 755, '朋友无需安装', 28, C.ink, 'text-anchor="middle"') +
      footer('复制邀请 → 发给朋友 → 浏览器打开');
    ui = { x: 118, y: 196, w: 930, scene: 'invite', local: b * UI_BEAT, time, clipHeight: 627 };
    if (b > 6.2 && b < 8.8) {
      const travel = ease((b - 6.2) / 2.6);
      front = invitation(mix(430, 1150, travel), 410 - Math.sin(travel * Math.PI) * 200, 450, b) +
        cursor(mix(860, 1400, travel), 570 - Math.sin(travel * Math.PI) * 160, 1.2, C.blue, -15);
    }
  } else if (index === 4) {
    // The call becomes a microphone action in the next shot.
    art = background(red) + rays(800, 450, b, C.paper, id + '-summon') +
      path('M0 0 1600 150 1600 660 0 830Z', C.ink) +
      group(`translate(${mix(-950, 0, ease(b / .4))} 0)`,
        portrait(50, 275, 430, 0, time, speaker === 0)) +
      group(`translate(${mix(850, 0, ease((b - .4) / .5))} 0)`,
        portrait(1140, 275, 430, 1, time, speaker === 1)) +
      group(`translate(800 490) rotate(-9) scale(${mix(1.7, 1, ease((b - .25) / .5))})`,
        text(8, 12, '开麦！', 210, red, 'text-anchor="middle"') +
        text(0, 0, '开麦！', 210, C.paper, 'text-anchor="middle"')) +
      text(800, 747, '一边看，一边聊。', 64, C.paper, 'text-anchor="middle"') +
      small(70, 82, '有话，直接说。', 32, C.paper);
  } else if (index === 5) {
    art = background(C.paper) +
      path('M0 0H620L410 900H0Z', C.blue) +
      title(68, 220, '听见了。', 116, C.paper, b, -5) +
      pawn(228, 580, 3.6, 0, time, { talking: speaker === 0, eyes: 2 }) +
      speech(318, 390, b < 7 ? '听得到吗？' : '来了来了。', 1, C.yellow, -5) +
      uiFrame(706, 115, 690, 680) +
      small(1050, 86, '开启语音 → 朋友加入 → 打开麦克风', 26, C.ink, 'text-anchor="middle"') +
      footer('房间语音，一边看一边聊。', C.paper);
    ui = { x: 720, y: 161, w: 662, scene: 'voice', local: b * UI_BEAT, time,
      source: { x: 430, y: 10, w: 650 }, clipHeight: 620 };
  } else if (index === 6) {
    const handoff = ease((b - .25) / 1.4);
    art = background(C.blue) +
      group(`translate(${mix(-700, 0, p)} 0)`, path('M0 0H780L480 900H0Z', C.yellow)) +
      portrait(75, 235, 420, 0, time) + portrait(1115, 235, 420, 1, time, speaker === 1) +
      title(501, 190, '换手！', 160, C.paper, b, -8) +
      group(`translate(${mix(440, 1050, handoff)} ${450 - Math.sin(handoff * Math.PI) * 70}) rotate(${mix(-23, 8, handoff)})`,
        r(-140, -69, 280, 138, C.ink) + english(0, 22, 'YOUR TURN', 55, C.paper, 'text-anchor="middle"')) +
      text(800, 765, '不只围观。你也来一局。', 64, C.ink, 'text-anchor="middle"') +
      footer('远程控制 · 房主确认后，朋友接手。');
  } else if (index === 7) {
    art = background(C.ink) +
      title(67, 207, '轮到你啦。', 104, C.yellow, b, -6) +
      small(75, 320, '朋友请求，房主确认。', 34, C.paper) +
      pawn(260, 594, 3, 1, time, { talking: speaker === 1, eyes: 2 }) +
      keycap(110, 730, '←', COLOURS[1]) + keycap(245, 730, '↑', COLOURS[1]) +
      uiFrame(713, 113, 754, 672) +
      small(1090, 84, '房主仍可随时收回控制', 27, C.paper, 'text-anchor="middle"') +
      footer('接手同一台电脑里的双人游戏。', C.paper);
    ui = { x: 727, y: 159, w: 726, scene: 'control', local: b * UI_BEAT, time,
      source: { x: 490, y: 5, w: 650 }, clipHeight: 612 };
  } else if (index === 8) {
    art = background(C.ink) +
      arena(0, 0, 1600, b, false, id + '-game') +
      group('translate(45 750)', r(-10, -17, 330, 103, C.paper) + small(8, 15, '阿团：W / A / D', 26) + small(8, 55, '小圆：↑ / ← / →', 26)) +
      group('translate(1180 780)', pawn(80, 0, 1, 2, time, { talking: speaker === 2 }) +
        speech(126, -90, b < 10.5 ? '快，抢旗！' : '哎，小心！', .72, C.yellow, -3));
    if (b > PARTY.goal) front += group(`translate(755 235) rotate(-7) scale(${mix(1.6, 1, ease((b - PARTY.goal) / .5))})`,
      r(-380, -103, 760, 170, red) + text(0, 22, '小圆先到！', 112, C.paper, 'text-anchor="middle"'));
  } else if (index === 9) {
    art = background(red) +
      path('M0 160 1600 0 1600 730 0 900Z', C.paper) +
      title(79, 206, '不是，你来真的？', 105, C.ink, b, -6) +
      portrait(170, 365, 390, 0, time, speaker === 0) +
      portrait(1015, 295, 390, 1, time, speaker === 1) +
      speech(607, 394, b < 3.2 ? '承让。' : '再来！', 1.45, C.yellow, -8) +
      pawn(810, 735, 1.4, 2, time, { talking: speaker === 2, tilt: -8 }) +
      small(800, 862, '屏幕那头，还是熟悉的损友。', 29, C.paper, 'text-anchor="middle"');
  } else {
    if (b < 16) {
      const part = Math.floor(b / 4), sub = b % 4;
      const fills = [C.blue, C.yellow, red, C.ink];
      const enter = ease(sub / .75);
      art = background(fills[part]);
      if (part === 0) {
        art += group(`translate(${mix(1760, 1180, enter)} 450) rotate(8)`,
          circle(0, 0, 320, C.paper) + english(0, 217, '0', 620, C.blue, 'text-anchor="middle"') +
          group('rotate(-12)', r(-240, -36, 480, 84, C.ink) + small(0, 17, '订阅费 / 门票', 35, C.paper, 'text-anchor="middle"'))) +
          title(80, 305, '免费。', 210, C.paper, sub, -5) +
          title(94, 580, '开源。', 210, C.paper, sub - .2, -5) +
          small(94, 735, '没有订阅，代码公开。', 38, C.paper);
      } else if (part === 1) {
        art += title(80, 217, '点开，就到场。', 142, C.ink, sub, -4) +
          invitation(580, 370, 530, sub) +
          pawn(260, 584, 2.6, 1, time, { tilt: -8 * (1 - enter), eyes: 2 }) +
          pawn(1330, 584, 2.6, 2, time, { tilt: 8 * (1 - enter), eyes: -2 }) +
          cursor(mix(1380, 1055, enter), mix(770, 540, enter), 1.8, C.blue, -8) +
          small(800, 771, '朋友无需安装。浏览器里，见。', 42, C.ink, 'text-anchor="middle"');
      } else if (part === 2) {
        art += group(`translate(800 478) rotate(${mix(8, -3, enter)})`, arena(-620, -315, 1240, 5 + sub, false, id + '-game')) +
          group(`translate(${mix(-800, 0, enter)} 0)`, path('M0 0H1600L1500 209H0Z', C.paper)) +
          text(70, 153, '分享画面，跟得上。', 121, C.ink) +
          group('translate(1130 570) rotate(-8)', r(-40, -40, 450, 170, C.yellow) +
            text(0, 55, '一起看！', 82)) +
          small(64, 828, '低延迟、高效分享。游戏、画画、看片，都行。', 34, C.paper);
      } else {
        art += title(65, 290, '你的站点，', 139, C.paper, sub, -4) +
          title(73, 495, '你的朋友。', 139, C.paper, sub - .15, -4) +
          group(`translate(${mix(1650, 1020, enter)} 280) rotate(5)`,
            path('M-75 12 190-160 450 12 450 405H-75Z', C.blue) +
            sofa(10, 230, 360, C.yellow) +
            [0, 1, 2].map((actor, i) => pawn(90 + i * 100, 216, .95, actor, time)).join('')) +
          small(80, 714, '也支持自部署。由你做主。', 41, C.paper);
      }
      if (part > 0 && sub < .5) front = wipe(sub, fills[part - 1]);
    } else {
      const end = b - 16, settle = ease(end / 1.2);
      art = background(C.paper) +
        r(0, 0, 28, 900, C.blue) +
        small(91, 110, '屏幕共享，和朋友一起。', 41) +
        group(`translate(${mix(-900, 0, settle)} 0) rotate(${mix(-8, 0, settle)} 550 350)`,
          brand(150, 437, 2.18, C.ink, id + '-mark')) +
        ['一起看。', '一起聊。', '一起玩。'].map((words, i) => {
          const arrive = ease((end - .65 - i * .5) / .65);
          return group(`translate(1135 ${255 + i * 91 + (1 - arrive) * 38})`,
            r(-7, -8, 290 * arrive, 13, [C.yellow, C.blue, red][i]) +
            text(0, 0, words, 69), `opacity="${arrive}"`);
        }).join('') +
        group(`translate(0 ${mix(430, 0, ease((end - .35) / 1.2))})`,
          path('M0 596 1600 543V900H0Z', C.blue) +
          text(92, 738, '来，看点好康的。', 100, C.paper) +
          small(99, 829, 'piik.tv', 41, C.yellow) +
          small(344, 825, '免费开源 · 打开 Piik，叫上朋友', 28, C.paper) +
          sofa(1070, 733, 440, C.yellow) +
          [0, 1, 2].map((actor, i) => {
            const jump = Math.max(0, Math.sin(clamp((end - 1.3 - i * .25) / 1.1) * Math.PI)) * 65;
            return pawn(1158 + i * 130, 718 - jump, 1.3, actor, time);
          }).join(''));
      if (end < .6) front = wipe(end, C.ink);
    }
  }
  if (index > 0 && b < .65) front = wipe(b, backgrounds[index - 1]) + front;
  return { art, ui, front };
}
