import { mountBrands } from './assets/brand.js';
import { initialLanguage, rememberLanguage } from './assets/language.js';
import { createTextCycle } from '../src/client/ui/text-rotation.ts';
import { applyTheme, currentTheme, currentThemePreference, initTheme, subscribeTheme } from '../src/client/ui/theme.ts';
import { DEFAULT_RELEASE_API_URL, parseReleaseMetadata } from '../src/client/lib/release-update.ts';
import { splitReleaseHeadline } from '../scripts/release-headline.mjs';
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
  }).then(response => response.ok ? response.json() : null)
    .then(metadata => {
      const release = parseReleaseMetadata(metadata);
      if (!release?.publishedAt) return;
      releaseLabel.querySelector('b').textContent = release.version;
      const date = releaseLabel.querySelector('time');
      date.dateTime = release.publishedAt;
      date.textContent = release.publishedAt.slice(0, 10);
      releaseLabel.hidden = false;
      const { headline } = splitReleaseHeadline(metadata.body);
      if (headline) {
        const label = document.getElementById('download-headline');
        for (const text of label.querySelectorAll('[lang]')) {
          text.querySelector('strong').textContent = headline[text.lang].title;
          const description = text.querySelector('span');
          description.textContent = headline[text.lang].description;
          description.hidden = !headline[text.lang].description;
        }
        label.hidden = false;
      }
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
const selectedWelcome = new Map();
function syncWelcome() {
  if (!welcomeLines) return;
  const element = document.getElementById('welcome-line');
  const pool = Array.from(welcomeLines).filter(line => line.lang === root.lang);
  if (!selectedWelcome.has(root.lang)) selectedWelcome.set(root.lang, createTextCycle(pool)());
  const line = selectedWelcome.get(root.lang);
  element.hidden = pool.length === 0;
  element.replaceChildren(...(line ? [line.cloneNode(true)] : []));
}
function syncFilmPreferences() {
  const target = new URL(filmLink.href);
  target.searchParams.set('lang', root.lang);
  const preference = currentThemePreference() ?? 'system';
  target.searchParams.set('theme', preference);
  filmLink.href = target.href;
  if (film.open) filmFrame.contentWindow?.postMessage({type:'piik-film-preferences',lang:root.lang,theme:preference}, location.origin);
}
const copy = {
  en: {
    title: document.title,
    description: description.content,
    image: roomIllustration.alt,
  },
  'zh-CN': {
    title: 'Piik — 免费开源的屏幕共享',
    description: 'Piik 是免费开源的私密屏幕共享工具，适合游戏直播、一起看电影、展示绘画和照片。支持自部署站点，邀请最多 20 位朋友通过浏览器观看。',
    image: '戴着小金冠的房主分享 RPG 游戏、绘画、旅行照片和动画电影，三位朋友坐在沙发上观看。',
  },
};
function setLanguage(lang) {
  root.lang = lang;
  const chinese = lang === 'zh-CN';
  language.setAttribute('aria-label', chinese ? '语言' : 'Language');
  for (const button of language.querySelectorAll('button')) {
    const selected = button.dataset.language === lang;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
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
  syncThemeControl();
  syncWelcome();
  syncFilmPreferences();
}
for (const button of language.querySelectorAll('button')) {
  button.addEventListener('click', () => {
    if (root.lang !== button.dataset.language) setLanguage(button.dataset.language);
    rememberLanguage(root.lang);
  });
}
function syncThemeControl() {
  const target = currentTheme() === 'dark' ? 'light' : 'dark';
  if (theme.dataset.target !== target) {
    theme.replaceChildren(document.getElementById(`theme-${target}`).content.cloneNode(true));
    theme.dataset.target = target;
  }
  theme.setAttribute('aria-label', theme.querySelector(`[lang="${root.lang}"]`).dataset.label);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--wall').trim();
}
theme.addEventListener('click', (event) => {
  if (event.detail !== 0) theme.blur();
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  const url = new URL(location.href);
  url.searchParams.set('theme', currentTheme());
  history.replaceState(history.state, '', url);
});
subscribeTheme(() => {
  syncThemeControl();
  syncFilmPreferences();
});

// Ordinary links carry explicit choices between the page and its film.
const preferences = new URLSearchParams(location.search);
const requestedTheme = preferences.get('theme');
initTheme(requestedTheme === 'system' ? null : ['light', 'dark'].includes(requestedTheme) ? requestedTheme : undefined);
setLanguage(initialLanguage());
document.querySelector('.preferences').hidden = false;
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
