import { mountBrands } from './assets/brand.js';
import { initialLanguage, rememberLanguage } from './assets/language.js';
mountBrands();
// Content stays HTML; scripts only add preferences and replayable illustrations.
const root = document.documentElement;
const language = document.getElementById('language');
const theme = document.getElementById('theme');
const description = document.querySelector('meta[name="description"]');
const roomIllustration = document.querySelector('.living-room');
const film = document.getElementById('film-preview');
const filmFrame = document.getElementById('website-film');
const filmLink = document.querySelector('[data-film-link]');
const welcomeLines = document.getElementById('welcome-lines')?.content.children;
if (welcomeLines?.length) {
  const line = Math.floor(Math.random() * welcomeLines.length);
  document.getElementById('welcome-line').replaceChildren(welcomeLines[line].cloneNode(true));
}
function syncFilmPreferences() {
  const target = new URL(filmLink.href);
  target.searchParams.set('lang', root.lang);
  target.searchParams.set('theme', theme.value);
  filmLink.href = target.href;
  filmFrame.contentWindow?.postMessage({type:'piik-film-preferences',lang:root.lang,theme:theme.value}, location.origin);
}
const copy = {
  en: {
    title: document.title,
    description: description.content,
    themes: Object.fromEntries(Array.from(theme.options, (option) => [option.value, option.textContent])),
    image: roomIllustration.alt,
  },
  'zh-CN': {
    title: 'Piik — 来，看点好康的。',
    description: '游戏、绘画、电影、照片。Piik 是免费开源的屏幕共享工具，邀请最多 20 位朋友用浏览器观看。',
    themes: { system: '跟随系统', light: '浅色', dark: '深色' },
    image: '戴着小金冠的房主分享 RPG 游戏、绘画、旅行照片和动画电影，三位朋友坐在沙发上观看。',
  },
};
function setLanguage(lang) {
  root.lang = lang;
  const chinese = lang === 'zh-CN';
  language.lang = chinese ? 'en' : 'zh-CN';
  language.textContent = chinese ? 'English' : '简体中文';
  language.setAttribute('aria-label', chinese ? 'Switch to English' : '切换到简体中文');
  const current = copy[root.lang];
  document.title = current.title;
  description.content = current.description;
  roomIllustration.alt = current.image;
  for (const option of theme.options) option.textContent = current.themes[option.value];
  syncFilmPreferences();
}
language.addEventListener('click', () => {
  setLanguage(root.lang === 'zh-CN' ? 'en' : 'zh-CN');
  rememberLanguage(root.lang);
});
function syncThemeColor() {
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--wall').trim();
}
theme.addEventListener('change', () => {
  root.dataset.theme = theme.value;
  syncThemeColor();
  syncFilmPreferences();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);
syncThemeColor();
document.querySelector('.preferences').hidden = false;

// Ordinary links carry explicit choices between the page and its film.
const preferences = new URLSearchParams(location.search);
setLanguage(initialLanguage());
if (['light', 'dark'].includes(preferences.get('theme'))) {
  theme.value = preferences.get('theme');
  root.dataset.theme = theme.value;
  syncThemeColor();
}
syncFilmPreferences();
filmLink.setAttribute('aria-controls', 'film-preview');
filmLink.setAttribute('aria-expanded', 'false');
filmLink.addEventListener('click', (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const target = new URL(event.currentTarget.href);
  target.searchParams.set('embedded', '1');
  if (!film.open) filmFrame.src = target.href;
  film.hidden = false;
  film.open = true;
  filmLink.setAttribute('aria-expanded', 'true');
  film.querySelector('summary').focus({preventScroll:true});
  film.scrollIntoView({block:'start'});
});
film.addEventListener('toggle', () => {
  if (film.open) return;
  // Closing releases the frame, its music and its animation loop together.
  filmFrame.removeAttribute('src');
  film.hidden = true;
  filmLink.setAttribute('aria-expanded', 'false');
  filmLink.focus({preventScroll:true});
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
document.querySelectorAll('.step-art').forEach((control) => {
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
