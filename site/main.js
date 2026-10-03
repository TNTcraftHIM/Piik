import { mountBrands } from './assets/brand.js';
import { initialLanguage, rememberLanguage } from './assets/language.js';
import { createTextCycle, startTextRotation } from '../src/client/ui/text-rotation.ts';
import { DEFAULT_RELEASE_API_URL, parseReleaseMetadata } from '../src/client/lib/release-update.ts';
mountBrands();
const architecturePickers = document.querySelectorAll('.download-architecture');
function syncDownloadLinks(picker) {
  const selected = picker.querySelector('input:checked');
  for (const link of picker.closest('.download-card').querySelectorAll('a')) {
    const target = new URL(link.href);
    target.pathname = target.pathname.replace(/piik-app-[a-z0-9]+-[a-z0-9]+\.zip$/, `piik-app-${selected.value}.zip`);
    link.href = target.href;
  }
}
for (const picker of architecturePickers) {
  picker.disabled = picker.querySelectorAll('input').length < 2;
  syncDownloadLinks(picker);
  picker.addEventListener('change', () => syncDownloadLinks(picker));
}
// Content and download links remain usable without scripts or release metadata.
const releaseLabel = document.getElementById('download-release');
if (releaseLabel) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  void fetch(DEFAULT_RELEASE_API_URL, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    signal: controller.signal, headers: { Accept: 'application/vnd.github+json' },
  }).then(async response => {
    if (!response.ok) return null;
    return parseReleaseMetadata(await response.json());
  })
    .then(release => {
      if (!release?.publishedAt) return;
      releaseLabel.querySelector('b').textContent = release.version;
      const date = releaseLabel.querySelector('time');
      date.dateTime = release.publishedAt;
      date.textContent = release.publishedAt.slice(0, 10);
      releaseLabel.hidden = false;
    }).catch(() => {}).finally(() => clearTimeout(timeout));
}
const root = document.documentElement;
const language = document.getElementById('language');
const theme = document.getElementById('theme');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const motionControl = document.getElementById('reduce-motion');
const motionStorageKey = 'piik:site-reduced-motion';
let preferStill = false;
try {
  preferStill = localStorage.getItem(motionStorageKey) === 'true';
} catch {
  // Restricted storage still permits a preference for this visit.
}
const reducedMotion = () => motion.matches || preferStill;
const description = document.querySelector('meta[name="description"]');
const roomIllustration = document.querySelector('.living-room');
const film = document.getElementById('film-preview');
const filmFrame = document.getElementById('website-film');
const filmLink = document.querySelector('[data-film-link]');
const welcomeLines = document.getElementById('welcome-lines')?.content.children;
let stopWelcome = () => {};
let syncWelcomeMotion = () => {};
function syncWelcome() {
  if (!welcomeLines) return;
  const element = document.getElementById('welcome-line');
  const pool = Array.from(welcomeLines).filter(line => line.lang === root.lang);
  const next = createTextCycle(pool);
  const show = () => element.replaceChildren(...(pool.length ? [next().cloneNode(true)] : []));
  element.hidden = pool.length === 0;
  show();
  syncWelcomeMotion = () => {
    stopWelcome();
    stopWelcome = pool.length > 1 && !reducedMotion() ? startTextRotation(show, element) : () => {};
  };
  syncWelcomeMotion();
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
  document.querySelector('.site-header nav').setAttribute('aria-label', chinese ? '主导航' : 'Main');
  document.querySelector('.guide-links').setAttribute('aria-label', chinese ? '教程目录' : 'Guides');
  for (const link of document.querySelectorAll('[data-doc-page]')) {
    link.href = `./docs/${chinese ? 'zh/' : ''}${link.dataset.docPage}${chinese ? '' : '?lang=en'}`;
  }
  filmFrame.title = chinese ? 'Piik 宣传片' : 'Piik introduction';
  for (const option of theme.options) option.textContent = current.themes[option.value];
  syncWelcome();
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
  const still = reducedMotion();
  root.toggleAttribute('data-reduced-motion', still);
  motionControl.checked = still;
  motionControl.disabled = motion.matches;
  motionControl.setAttribute('aria-describedby', motion.matches ? 'display-motion-help display-motion-system' : 'display-motion-help');
  document.getElementById('display-motion-system').hidden = !motion.matches;
  illustrations.forEach((button) => {
    button.disabled = still;
  });
  roomIllustration.src = './assets/living-room.svg' + (still ? '#still' : '');
  syncWelcomeMotion();
}
motionControl.addEventListener('change', () => {
  preferStill = motionControl.checked;
  try {
    if (preferStill) localStorage.setItem(motionStorageKey, 'true');
    else localStorage.removeItem(motionStorageKey);
  } catch {
    // The current page keeps its explicit choice without persistence.
  }
  syncMotionPreference();
});
motion.addEventListener('change', syncMotionPreference);
syncMotionPreference();
document.getElementById('display-settings').hidden = false;
