// Film G — 作战会议 / Mission Briefing. Every on-screen word, zh + en. Scene code reads film.S.
// Ransom lines are token arrays: zh one tile per character, en one tile per word (condensed faces, see engine/type.js).
// Product wording (consent line, sources) follows the UI bundle's own strings; the UI itself renders inside the iframes.
import { NAMES } from '../../engine/cast.js';

const EN = NAMES.en;
const zh = s => [...s];

export const STRINGS = {
  zh: {
    names: NAMES.zh,
    secret: 'TOP SECRET · 机密 · 23:00',
    codename: zh('作战会议'), codeSub: '今晚目标：沙发满员', codeTag: 'OPERATION · FULL SOFA',
    target: '目标：阿团家的沙发', targetTag: 'TARGET',
    friends: { yuan: ['小圆', '被窝里'], dian: ['阿点', '地铁上'] },
    host: '阿团的电脑', viewer1: '小圆的浏览器', viewer2: '阿点的浏览器', addr: '邀请链接 · 9527',
    missions: [
      { no: '作战 01', en: 'MISSION 01', title: zh('选个画面'), short: '选画面' },
      { no: '作战 02', en: 'MISSION 02', title: zh('发出预告状'), short: '预告状' },
      { no: '作战 03', en: 'MISSION 03', title: zh('潜入'), short: '潜入' },
      { no: '作战 04', en: 'MISSION 04', title: zh('制造动静'), short: '动静' },
      { no: '作战 05', en: 'MISSION 05', title: zh('交出控制权'), short: '交接' },
    ],
    click: '咔哒！', allowClick: '允许！', smash: '扣杀！',
    c_sources: ['选择分享来源', '浏览器 · 摄像头 · 窗口 · 屏幕'],
    live: ['开播', 'LIVE'],
    c_copy: ['复制邀请链接', 'COPY'], c_chat: ['丢进群里', 'SEND'],
    card: { top: '预告状 No.9527', l1: '今晚，', l2: '来沙发。', sign: '—— 阿团' },
    link: '邀请链接 · 9527',
    s_browser: ['浏览器就能看', 'JUST A BROWSER'], s_noApp: ['不用装 App', 'NO INSTALL'],
    s_room: ['1 位房主 + 最多 20 位观众', '1 HOST · UP TO 20 VIEWERS'],
    c_text: ['文字聊天', 'CHAT'], c_danmaku: ['弹幕', 'DANMAKU'], c_toss: ['丢番茄', 'REACTIONS'], c_voice: ['开麦', 'VOICE ON'],
    danmaku: ['前排！', '阿团今天必输', '番茄已就位', '冲冲冲', '666', '好康！', '小圆上！', '哈哈哈哈'],
    c_switch: ['开启远程控制', 'REMOTE CONTROL ON'], c_request: ['小圆 请求控制', 'REQUEST'],
    c_consent: ['房主允许 · 一位朋友用键鼠接手', 'YOU APPROVE · ONE FRIEND TAKES OVER'],
    onePC: '一台电脑，两个玩家。',
    p1: ['P1', '阿团 · 本机'], p2: ['P2', '小圆 · 远程'], keysL: '阿团 · 本机键盘', keysR: '小圆 · 远程键鼠',
    complete: zh('作战成功'), completeSub: 'MISSION COMPLETE',
    dossier: { title: '档案：Piik', sub: '免费开源的私人屏幕共享', tag: 'CASE FILE No.9527', photo: '沙发惯犯' },
    traits: ['低延迟', '高可用', '资源占用低', '免费开源', '浏览器就能看', '最多 20 位观众'],
    endCard: { l1: zh('来，看点'), l2: zh('好康的。') },
    tagline: '来，看点好康的。', footer: '免费开源的私人屏幕共享', url: 'piik.tv',
    // subtitles of the animalese lines, in cues.json order (the cue sheet's zh/en only shape the babble rhythm)
    lines: [
      { main: '今晚，全员到齐。', sub: 'TONIGHT, EVERYONE SHOWS UP.' },
      { main: '收到！', sub: 'COPY THAT!' },
      { main: '我也到啦！', sub: "I'M IN TOO!" },
      { main: '哈哈哈！', sub: 'HA HA HA!' },
      { main: '让我来！', sub: 'LET ME DRIVE!' },
      { main: '键盘给你。', sub: "KEYBOARD'S YOURS." },
      { main: '赢啦！', sub: 'GOTCHA!' },
      { main: '再来一局！', sub: 'REMATCH!' },
    ],
    pong: { p1: '阿团 · 本机', p2: '小圆 · 远程', wait: '等待 P2', waitBox: 'P2 等待加入...', point: '小圆 得分！' },
  },
  en: {
    names: EN,
    secret: 'TOP SECRET · 11 PM',
    codename: ['MISSION', 'BRIEFING'], codeSub: "TONIGHT'S TARGET: A FULL SOFA", codeTag: 'OPERATION · FULL SOFA',
    target: `TARGET: ${EN.tuan.toUpperCase()}'S SOFA`, targetTag: 'TARGET',
    friends: { yuan: [EN.yuan.toUpperCase(), 'IN BED'], dian: [EN.dian.toUpperCase(), 'ON THE METRO'] },
    host: `${EN.tuan}'s PC`, viewer1: `${EN.yuan}'s browser`, viewer2: `${EN.dian}'s browser`, addr: 'Invite link · 9527',
    missions: [
      { no: 'MISSION 01', en: '', title: ['PICK', 'THE', 'TARGET'], short: 'TARGET' },
      { no: 'MISSION 02', en: '', title: ['SEND', 'THE', 'CALLING', 'CARD'], short: 'CARD' },
      { no: 'MISSION 03', en: '', title: ['INFILTRATE'], short: 'IN' },
      { no: 'MISSION 04', en: '', title: ['MAKE', 'SOME', 'NOISE'], short: 'NOISE' },
      { no: 'MISSION 05', en: '', title: ['HAND', 'OVER', 'CONTROL'], short: 'CONTROL' },
    ],
    click: 'CLICK!', allowClick: 'ALLOW!', smash: 'SMASH!',
    c_sources: ['Choose what to share', 'Browser · Camera · Window · Screen'],
    live: ["WE'RE LIVE", ''],
    c_copy: ['Copy invite link', ''], c_chat: ['Drop it in the group chat', ''],
    card: { top: 'CALLING CARD No.9527', l1: 'TONIGHT.', l2: 'MY SOFA.', sign: `— ${EN.tuan}` },
    link: 'Invite link · 9527',
    s_browser: ['JUST A BROWSER', ''], s_noApp: ['NO INSTALL', ''],
    s_room: ['1 HOST + UP TO 20 VIEWERS', ''],
    c_text: ['Chat', ''], c_danmaku: ['On-screen chat', ''], c_toss: ['Toss a tomato', ''], c_voice: ['Voice on', ''],
    danmaku: ['front row!', `${EN.tuan}'s going down`, 'tomatoes ready', "LET'S GO", 'GG', 'good stuff!', `GO ${EN.yuan.toUpperCase()}!`, 'lol lol'],
    c_switch: ['Remote control on', ''], c_request: [`${EN.yuan} requests control`, ''],
    c_consent: ['You approve · one friend takes keyboard & mouse', ''],
    onePC: 'ONE PC. TWO PLAYERS.',
    p1: ['P1', `${EN.tuan.toUpperCase()} · LOCAL`], p2: ['P2', `${EN.yuan.toUpperCase()} · REMOTE`], keysL: `${EN.tuan} · local keyboard`, keysR: `${EN.yuan} · remote keyboard & mouse`,
    complete: ['MISSION', 'COMPLETE'], completeSub: '',
    dossier: { title: 'DOSSIER: PIIK', sub: 'Free & open-source private screen sharing', tag: 'CASE FILE No.9527', photo: 'SOFA SUSPECT' },
    traits: ['LOW LATENCY', 'HIGH AVAILABILITY', 'LIGHT ON RESOURCES', 'FREE & OPEN SOURCE', 'JUST A BROWSER', 'UP TO 20 VIEWERS'],
    endCard: { l1: ['SHARE', 'THE'], l2: ['GOOD', 'STUFF', '.'] },
    tagline: 'Share the good stuff.', footer: 'Free & open-source private screen sharing', url: 'piik.tv',
    lines: [
      { main: 'Tonight, the whole crew shows up.', sub: '' },
      { main: 'Copy that!', sub: '' },
      { main: "I'm in too!", sub: '' },
      { main: 'Ha ha ha!', sub: '' },
      { main: 'Let me drive!', sub: '' },
      { main: "Keyboard's yours.", sub: '' },
      { main: 'Gotcha!', sub: '' },
      { main: 'Rematch!', sub: '' },
    ],
    pong: { p1: `${EN.tuan} · Local`, p2: `${EN.yuan} · Remote`, wait: 'Waiting for P2', waitBox: 'P2 · waiting...', point: `Point, ${EN.yuan}!` },
  },
};

/** Display faces per language: zh headlines Noto Sans SC Black, en headlines Anton (condensed). */
export const FACE = {
  zh: { display: (px, w = 900) => `${w} ${px}px/1 "Noto Sans SC"`, label: px => `800 ${px}px/1 "Barlow Condensed", "Noto Sans SC"` },
  en: { display: px => `400 ${Math.round(px * 1.08)}px/1 Anton`, label: px => `800 ${px}px/1 "Barlow Condensed"` },
};
