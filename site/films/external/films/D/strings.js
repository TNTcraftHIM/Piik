// Film D — every on-screen word, zh + en. Product wording follows the UI bundle's own i18n strings.
import { NAMES } from '../../engine/cast.js';

const EN = NAMES.en;

export const STRINGS = {
  zh: {
    names: NAMES.zh,
    title: '一起看，咔哒一下',
    meet: '这是 Piik。', meetSub: '免费开源的屏幕共享',
    chapters: ['开播', '邀请', '加入', '互动', '语音', '远控', '一起玩'],
    host: '阿团的电脑', viewer1: '小圆的浏览器', viewer2: '阿点的浏览器', addr: '邀请链接 · 9527',
    click: '咔哒',
    c1a: '开始分享', c1b: '选择分享来源', c1bSub: '浏览器 · 摄像头 · 程序/窗口 · 屏幕', c1c: '开播！', c1cSub: '游戏、影片、画画、软件，都能分享',
    c2a: '复制邀请链接', c2b: '发到群里', c2c: '发送',
    c3a: '朋友点开链接', c3aSub: '浏览器就能看，不用装 App', c3b: '都坐上沙发了', c3bSub: '一位房主，最多 20 位观众',
    c4a: '文字聊天', c4b: '弹幕', c4c: '丢番茄', c4d: '比个心',
    c5a: '开启房间语音', c5b: '加入语音', c5c: '开麦，边看边聊',
    c6a: '开启远控', c6b: '小圆 请求控制', c6c: '允许控制', c6d: '允许后，对方可以操作这台电脑的鼠标和键盘。', c6e: '房主同意，一位朋友接手键鼠',
    c7a: '一台电脑，两位玩家', c7b: '低延迟', c7bSub: '你按下，TA 就看到', keysL: '阿团 · 本机键盘', keysR: '小圆 · 远程键鼠',
    feat: {
      hero: '屏幕共享', heroSub: '游戏 · 影片 · 画画 · 照片 · 软件',
      items: [['低延迟', '一起玩游戏也跟手'], ['高可用', '说开就开'], ['资源占用低', '不拖慢电脑'], ['免费开源', 'MIT 许可'], ['最多 20 位观众', '一位房主'], ['浏览器就能看', '观众无需安装']],
      row: '语音 · 文字聊天 · 弹幕 · 远程同乐',
    },
    danmaku: ['前排！', '这球能接住？', '小圆冲！', '阿团别慌', '自带番茄', '666', '哈哈哈哈', '再来一局'],
    end: '来，看点好康的。', endSub: '免费开源的屏幕共享', url: 'piik.tv',
    pong: { p1: '阿团 · 本机', p2: '小圆 · 远程', wait: '等待 P2', waitBox: 'P2 等待加入…', point: '小圆 得分！' },
  },
  en: {
    names: EN,
    title: 'Click, and watch together',
    meet: 'Meet Piik.', meetSub: 'Free, open-source screen sharing',
    chapters: ['Go live', 'Invite', 'Join', 'Chat', 'Voice', 'Control', 'Play'],
    host: `${EN.tuan}'s PC`, viewer1: `${EN.yuan}'s browser`, viewer2: `${EN.dian}'s browser`, addr: 'Invite link · 9527',
    click: 'Click',
    c1a: 'Start sharing', c1b: 'Choose what to share', c1bSub: 'Browser · Camera · Apps / Windows · Screens', c1c: "You're live!", c1cSub: 'Games, videos, drawings, apps — share anything',
    c2a: 'Copy invite link', c2b: 'Drop it in the group chat', c2c: 'Send',
    c3a: 'Friends open the link', c3aSub: 'Right in the browser — nothing to install', c3b: 'Everyone on the sofa', c3bSub: '1 Host, up to 20 Viewers',
    c4a: 'Chat', c4b: 'On-screen chat', c4c: 'Toss tomato', c4d: 'Love it',
    c5a: 'Open room voice', c5b: 'Join voice', c5c: 'Talk while you watch',
    c6a: 'Enable remote control', c6b: `${EN.yuan} requests control`, c6c: 'Allow control', c6d: "Allowing control gives this Viewer access to this computer's mouse and keyboard.", c6e: 'Your OK — one friend takes the keyboard & mouse',
    c7a: 'One PC, two players', c7b: 'Low latency', c7bSub: 'You press, they see it', keysL: `${EN.tuan} · local keyboard`, keysR: `${EN.yuan} · remote keyboard & mouse`,
    feat: {
      hero: 'Screen sharing', heroSub: 'Games · Video · Art · Photos · Apps',
      items: [['Low latency', 'Snappy enough to play together'], ['High availability', 'Ready when you are'], ['Low resource usage', 'Easy on your PC'], ['Free & open source', 'MIT licensed'], ['Up to 20 Viewers', 'per Host'], ['Just a browser', 'Viewers install nothing']],
      row: 'Voice · Chat · On-screen chat · Remote play',
    },
    danmaku: ['Front row!', 'Can he return that?', `Go ${EN.yuan}!`, `${EN.tuan}, focus`, 'BYO tomatoes.', 'GG', 'lol lol', 'Rematch!'],
    end: 'Share the good stuff.', endSub: 'Free, open-source screen sharing', url: 'piik.tv',
    pong: { p1: `${EN.tuan} · Local`, p2: `${EN.yuan} · Remote`, wait: 'Waiting for P2', waitBox: 'P2 · waiting…', point: `Point, ${EN.yuan}!` },
  },
};
