// Content stays HTML; scripts only add preferences and replayable illustrations.
const root = document.documentElement;
const language = document.getElementById('language');
const theme = document.getElementById('theme');
const description = document.querySelector('meta[name="description"]');
const roomIllustration = document.querySelector('.living-room');
const copy = {
  en: {
    title: document.title,
    description: description.content,
    themes: Object.fromEntries(Array.from(theme.options, (option) => [option.value, option.textContent])),
    image: roomIllustration.alt,
  },
  'zh-CN': {
    title: 'Piik — 和朋友分享屏幕',
    description: '游戏、画画、新鲜事，都能叫朋友来围观。Piik 支持私密屏幕共享，最多 20 位观众，点开邀请就能看。',
    themes: { system: '跟随系统', light: '浅色', dark: '深色' },
    image: '戴着金色小皇冠的房主操作手柄，游戏里的小电视踩着滑板冲刺、跃过障碍、收集金环，三位朋友坐在沙发上围观。',
  },
};
language.addEventListener('click', () => {
  const chinese = root.lang !== 'zh-CN';
  root.lang = chinese ? 'zh-CN' : 'en';
  language.lang = chinese ? 'en' : 'zh-CN';
  language.textContent = chinese ? 'English' : '简体中文';
  language.setAttribute('aria-label', chinese ? 'Switch to English' : '切换到简体中文');
  const current = copy[root.lang];
  document.title = current.title;
  description.content = current.description;
  roomIllustration.alt = current.image;
  for (const option of theme.options) option.textContent = current.themes[option.value];
});
function syncThemeColor() {
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--wall').trim();
}
theme.addEventListener('change', () => {
  root.dataset.theme = theme.value;
  syncThemeColor();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
syncThemeColor();
document.querySelector('.preferences').hidden = false;

// Carry explicit choices through the film's ordinary links, without a second
// preference store or making either page depend on the other being open.
const preferences = new URLSearchParams(location.search);
if (preferences.get('lang') === 'zh-CN') language.click();
if (['light', 'dark'].includes(preferences.get('theme'))) {
  theme.value = preferences.get('theme');
  root.dataset.theme = theme.value;
  syncThemeColor();
}
document.querySelector('[data-film-link]').addEventListener('click', (event) => {
  const target = new URL(event.currentTarget.href);
  target.searchParams.set('lang', root.lang);
  target.searchParams.set('theme', theme.value);
  event.currentTarget.href = target.href;
});

// Native disclosures remain usable without scripts; section links also reveal them.
function revealGuide(hash) {
  const target = document.getElementById(hash.slice(1));
  if (target?.matches('details.guide')) target.open = true;
}
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => revealGuide(link.hash));
});
window.addEventListener('hashchange', () => revealGuide(location.hash));
revealGuide(location.hash);

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const illustrations = document.querySelectorAll('.step-art');
document.querySelectorAll('.identity, .step-art').forEach((control) => {
  const replayScene = () =>
    control.getAnimations({ subtree: true }).forEach((animation) => {
      if (animation instanceof CSSAnimation) animation.currentTime = 0;
    });
  (control.closest('li') ?? control).addEventListener('pointerenter', replayScene);
  control.addEventListener('focus', replayScene);
  control.addEventListener('click', () => {
    control.focus({ preventScroll: true });
    replayScene();
  });
});
function syncMotionPreference() {
  illustrations.forEach((button) => {
    button.disabled = motion.matches;
  });
  roomIllustration.src = './assets/living-room.svg' + (motion.matches ? '#still' : '');
}
motion.addEventListener('change', syncMotionPreference);
syncMotionPreference();
