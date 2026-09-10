// Content stays HTML; scripts only add preferences and replayable illustrations.
const root = document.documentElement;
const language = document.getElementById('language');
const theme = document.getElementById('theme');
const copy = {
  en: { title: 'Piik — Screen sharing with friends', themes: ['System', 'Light', 'Dark'], image: 'An illustrated game night: a green host shares a game with friends on an orange sofa.' },
  'zh-CN': { title: 'Piik — 和朋友分享屏幕', themes: ['跟随系统', '浅色', '深色'], image: '游戏之夜插画：绿色房主分享游戏，朋友们坐在橙色沙发上一起看。' },
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

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const illustrations = document.querySelectorAll('.step-art');
document.querySelectorAll('.identity, .step-art').forEach(control => {
  const replayScene = () => control.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 0; });
  (control.closest('li') ?? control).addEventListener('pointerenter', replayScene);
  control.addEventListener('focus', replayScene);
  control.addEventListener('click', () => { control.focus({ preventScroll: true }); replayScene(); });
});
function syncMotionControls() {
  illustrations.forEach(button => { button.disabled = motion.matches; });
}
motion.addEventListener('change', syncMotionControls);
syncMotionControls();
