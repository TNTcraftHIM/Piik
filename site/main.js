// Only page preferences and the approved website wordmark move. Content stays HTML.
const root = document.documentElement;
const language = document.getElementById('language');
const theme = document.getElementById('theme');
const copy = {
  en: { title: 'Piik — Your game. Their front row.', themes: ['System', 'Light', 'Dark'], image: 'An illustrated game night: a green host shares a game with friends on an orange sofa.' },
  'zh-CN': { title: 'Piik — 开一局，朋友坐前排。', themes: ['跟随系统', '浅色', '深色'], image: '游戏之夜插画：绿色房主分享游戏，朋友们坐在橙色沙发上一起看。' },
};
language.addEventListener('click', () => {
  const chinese = root.lang !== 'zh-CN';
  root.lang = chinese ? 'zh-CN' : 'en';
  language.lang = chinese ? 'en' : 'zh-CN';
  language.textContent = chinese ? 'English' : '简体中文';
  language.setAttribute('aria-label', chinese ? 'Switch to English' : '切换到简体中文');
  const current = copy[root.lang];
  document.title = current.title;
  document.querySelector('.living-room').alt = current.image;
  Array.from(theme.options).forEach((option, index) => { option.textContent = current.themes[index]; });
});
function syncThemeColor() {
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--wall').trim();
}
theme.addEventListener('change', () => { root.dataset.theme = theme.value; syncThemeColor(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
syncThemeColor();
document.querySelector('.preferences').hidden = false;

// Geometry from docs/design/piik-brand.html: P opens into the screen,
// i dots become eyes, i stems become feet, and k arms become antennae.
const morph = document.getElementById('brand-morph');
const replay = document.getElementById('replay');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const parts = [
  ['rect', { x: 108, y: 72, width: 58, height: 48, rx: 20 }, { x: 172, y: 76, width: 136, height: 102, rx: 22.667 }],
  ['line', { x1: 108, y1: 72, x2: 108, y2: 164 }, { x1: 172, y1: 98.667, x2: 172, y2: 155.333 }],
  ['line', { x1: 194, y1: 118, x2: 194, y2: 164 }, { x1: 217.333, y1: 178, x2: 206, y2: 195 }],
  ['line', { x1: 236, y1: 118, x2: 236, y2: 164 }, { x1: 262.667, y1: 178, x2: 274, y2: 195 }],
  ['line', { x1: 282, y1: 72, x2: 282, y2: 164 }, { x1: 308, y1: 98.667, x2: 308, y2: 155.333 }],
  ['line', { x1: 284, y1: 139, x2: 318, y2: 111 }, { x1: 240, y1: 76, x2: 268.333, y2: 53.333 }],
  ['line', { x1: 294, y1: 131, x2: 326, y2: 164 }, { x1: 211.667, y1: 53.333, x2: 240, y2: 76 }],
];
function element(parent, tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  parent.append(node);
  return node;
}
function animate(node, name, from, to, begin = .65, duration = 1.25) {
  element(node, 'animate', { attributeName: name, from, to, begin: `${begin}s`, dur: `${duration}s`, fill: 'freeze', calcMode: 'spline', keyTimes: '0;1', keySplines: '.4 0 .2 1' });
}
function drawBrand(still) {
  morph.replaceChildren();
  const group = element(morph, 'g', { fill: 'none', stroke: 'currentColor', 'stroke-width': still ? 13.6 : 10, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  parts.forEach(([tag, start, end]) => {
    const shape = element(group, tag, still ? end : start);
    if (!still) Object.keys(end).forEach(key => animate(shape, key, start[key], end[key]));
  });
  [194, 236].forEach((cx, index) => {
    const eyeX = index ? 270.317 : 214.5;
    const eye = element(group, 'ellipse', { cx: still ? eyeX : cx, cy: still ? 124.167 : 95, rx: still ? 7.083 : 6.5, ry: still ? (index ? 0 : 7.083) : 6.5, fill: 'currentColor', stroke: 'none' });
    if (!still) {
      animate(eye, 'cx', cx, eyeX);
      animate(eye, 'cy', 95, 124.167);
      animate(eye, 'rx', 6.5, 7.083);
      animate(eye, 'ry', 6.5, 7.083);
      if (index) animate(eye, 'ry', 7.083, 0, 2.2, .16);
    }
  });
  const wink = element(group, 'path', { d: 'M257 127c8.5-10.2 18.133-10.2 26.633 0', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': still ? 0 : 1 });
  if (!still) {
    animate(group, 'stroke-width', 10, 13.6);
    animate(wink, 'stroke-dashoffset', 1, 0, 2.3, .23);
    morph.setCurrentTime(0);
    morph.unpauseAnimations();
  }
}
function playBrand() { drawBrand(motion.matches); }
replay.addEventListener('click', playBrand);
motion.addEventListener('change', () => { drawBrand(true); replay.hidden = motion.matches; });
replay.hidden = motion.matches;
playBrand();
