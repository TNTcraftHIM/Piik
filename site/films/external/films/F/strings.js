// Film F — 出金了！ / GOLD! Every user-facing string, zh / en. Scene code reads film.S (set in film.js build()).
// The en cut must not contain any CJK glyph: its web font subset is Latin-only.
// UI copy marked (UI) is the product's own wording (frontend/ui: remote.consent, remote.allow, host.live, ...).

import { NAMES } from '../../engine/cast.js';

const EN = NAMES.en;

export const STRINGS = {
  zh: {
    names: NAMES.zh,
    host: '房主', viewer: '观众',
    // the fictional game
    game: { banner: '限定卡池', bannerSub: 'LIMITED BANNER', up: '★6 概率UP', single: '单抽', ten: '十连', tenSub: '×10', window: '星港卡池 · 游戏窗口' },
    // cold open
    saved: ['攒了', '三个月。'], savedSub: 'SAVING: 92 DAYS',
    // host
    l1: '这么重要的时刻……', l2: '得有人见证。',
    // share (UI copy: host.start / host.live; sources as in the picker)
    start: '开始分享', pick: '选择分享来源',
    sources: [['浏览器', 'BROWSER'], ['摄像头', 'CAMERA'], ['窗口', 'WINDOW'], ['屏幕', 'SCREEN']],
    live: '分享中',
    feat1: ['分享画面', 'SHARE YOUR SCREEN'],
    // invite (UI copy: host.invite.copy, viewer.title, viewer.title.watching)
    copy: '复制邀请链接', copied: '已复制', inviteChip: '邀请链接 · 9527',
    msgFrom: '阿团', msg: '来见证我出金！',
    places: { tuan: ['沙发', 'SOFA'], yuan: ['被窝', 'BED'], dian: ['地铁', 'SUBWAY'], cong: ['工位', 'OFFICE'] },
    viewerTitle: '阿团 的屏幕', watching: '观看中',
    viewers: '观众',
    feat2: ['点开链接就能看', 'JUST OPEN THE LINK'], noApp: '浏览器打开 · 不用装 App',
    // party
    chat: [['dian', '蓝色，很适合你。'], ['cong', '非酋别抽了'], ['yuan', '冲！']],
    dm1: ['非酋别抽了', '我赌全蓝', '保底在哪', '冲冲冲', '前方高能', '十连！'],
    voiceOn: '正在说话', go: '冲！', watch: '看好了！',
    feat3: ['语音 · 聊天 · 表情', 'VOICE · CHAT · REACTIONS'],
    // dud
    allBlue: '全蓝。', allBlueSub: 'ALL BLUE', dots: '……',
    dm2: ['哈哈哈哈哈哈', '哈哈哈哈哈哈哈', '非酋实锤', '笑死', 'F', '哈哈哈哈', '心疼三个月', '哈哈哈哈哈哈哈哈'],
    // remote control (UI copy: remote.requests, remote.waiting, remote.consent, remote.decline, remote.allow, remote.controlling)
    yuanLine: ['让我来！', '沾沾欧气。'],
    reqHeader: '控制请求', reqWho: '请求控制',
    consent: '允许后，对方可以操作这台电脑的鼠标和键盘。',
    decline: '拒绝', allow: '允许控制', controlling: '正在控制',
    feat4: ['远程控制', 'REMOTE CONTROL'], ctrlNote: '房主允许 · 一位朋友用键鼠接手',
    // tension / reveal
    gold: '出金了！！！',
    scream: ['同时尖叫，', '没人剧透。'], feat5: ['低延迟', 'LOW LATENCY'],
    dm3: ['出金了！！！', '欧皇！', '小圆是神', '？？？', '啊啊啊啊', '截图了截图了', '阿团：？', '恭喜恭喜'],
    rarity: 'RARITY 06 · LEGENDARY',
    // payoff
    p1: '……这是我的号。', p2: '不客气~',
    // spec sheet
    specHead: '私人屏幕共享', specHeadSub: 'PIIK // SPEC SHEET',
    spec: [
      ['分享屏幕', 'SCREEN SHARING'],
      ['浏览器点开就看', 'VIEWERS JUST OPEN A LINK'],
      ['语音 · 聊天 · 表情', 'VOICE · CHAT · REACTIONS'],
      ['远程控制（房主允许）', 'REMOTE CONTROL · HOST APPROVES'],
      ['低延迟 · 高可用 · 资源占用低', 'LOW LATENCY · HIGH AVAILABILITY · LIGHT'],
      ['免费 · 开源', 'FREE · OPEN SOURCE'],
      ['1 位房主 + 最多 20 位观众', '1 HOST + UP TO 20 VIEWERS'],
    ],
    // end card
    tagline: '来，看点好康的。', taglineSub: 'SHARE THE GOOD STUFF.',
    footer: '免费开源的私人屏幕共享',
    hudTag: 'F-01 // 十连之夜',
  },
  en: {
    names: EN,
    host: 'HOST', viewer: 'VIEWER',
    game: { banner: 'LIMITED BANNER', bannerSub: 'STARPORT SUMMON', up: 'RATE UP: 6-STAR', single: 'x1', ten: 'SUMMON', tenSub: 'x10', window: 'Starport Summon - Game window' },
    saved: ['THREE MONTHS', 'OF SAVING.'], savedSub: 'SAVING: 92 DAYS',
    l1: 'A moment like this...', l2: 'needs witnesses.',
    start: 'Start sharing', pick: 'Choose what to share',
    sources: [['BROWSER', ''], ['CAMERA', ''], ['WINDOW', ''], ['SCREEN', '']],
    live: 'Sharing',
    feat1: ['SHARE YOUR SCREEN', ''],
    copy: 'Copy invite link', copied: 'Copied', inviteChip: 'Invite link · 9527',
    msgFrom: EN.tuan, msg: 'Come watch me pull gold!',
    places: { tuan: ['SOFA', ''], yuan: ['BED', ''], dian: ['SUBWAY', ''], cong: ['OFFICE', ''] },
    viewerTitle: `${EN.tuan}'s screen`, watching: 'Watching',
    viewers: 'VIEWERS',
    feat2: ['JUST OPEN THE LINK', ''], noApp: 'In the browser · no app to install',
    chat: [['dian', 'Blue suits you.'], ['cong', 'don\'t do it lol'], ['yuan', 'Go go go!']],
    dm1: ['don\'t do it', 'all blue incoming', 'RIP savings', 'GO GO GO', 'here we go', 'TEN PULL!'],
    voiceOn: 'Speaking', go: 'Go go go!', watch: 'Watch this!',
    feat3: ['VOICE · CHAT · REACTIONS', ''],
    allBlue: 'ALL BLUE.', allBlueSub: '', dots: '...',
    dm2: ['HAHAHAHAHA', 'LMAOOO', 'called it', 'hahahaha', 'F', 'HAHAHAHAHAHA', 'not the blues', 'lol lol lol'],
    yuanLine: ['MOVE OVER.', 'I\'M LUCKY.'],
    reqHeader: 'Control requests', reqWho: 'Requesting control',
    consent: 'Allowing control gives this Viewer access to this computer\'s mouse and keyboard.',
    decline: 'Decline', allow: 'Allow control', controlling: 'Controlling',
    feat4: ['REMOTE CONTROL', ''], ctrlNote: 'Host approves · one friend takes keyboard & mouse',
    gold: 'GOLD!!!',
    scream: ['EVERYONE SCREAMS', 'AT ONCE.'], feat5: ['LOW LATENCY', ''],
    dm3: ['GOLD!!!', 'NO WAY', `${EN.yuan} is a legend`, '???', 'AAAAAA', 'screenshot it', `${EN.tuan}: ?`, 'GG'],
    rarity: 'RARITY 06 · LEGENDARY',
    p1: '...That\'s MY account.', p2: 'You\'re welcome~',
    specHead: 'PRIVATE SCREEN SHARING', specHeadSub: 'PIIK // SPEC SHEET',
    spec: [
      ['SCREEN SHARING', ''],
      ['VIEWERS JUST OPEN A LINK', ''],
      ['VOICE · CHAT · REACTIONS', ''],
      ['REMOTE CONTROL · HOST APPROVES', ''],
      ['LOW LATENCY · HIGH AVAILABILITY', 'AND LIGHT ON RESOURCES'],
      ['FREE · OPEN SOURCE', ''],
      ['1 HOST + UP TO 20 VIEWERS', ''],
    ],
    tagline: 'Share the good stuff.', taglineSub: '',
    footer: 'Free & open-source private screen sharing',
    hudTag: 'F-01 // GACHA NIGHT',
  },
};
