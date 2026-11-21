import '../films/external/engine/player.js';
import { initialLanguage, rememberLanguage } from '../assets/language.js';
import { initTheme } from '../../src/client/ui/theme.ts';

function theme(value) {
  initTheme(value === 'system' ? null : ['light', 'dark'].includes(value) ? value : undefined);
}
theme(new URLSearchParams(location.search).get('theme'));

const player = document.querySelector('piik-promo');
function language(lang) {
  document.documentElement.lang = lang;
  player.setAttribute('lang', lang === 'zh-CN' ? 'zh' : 'en');
  document.title = lang === 'zh-CN' ? 'Piik · 预告状' : 'Piik · The Calling Card';
}
language(initialLanguage());
try {
  player.reducedMotion = localStorage.getItem('piik:site-reduced-motion') === 'true';
} catch { /* The player still follows the system preference. */ }
player.addEventListener('languagechange', event => {
  event.preventDefault();
  if (parent === window) {
    language(event.detail);
    rememberLanguage(event.detail);
  } else {
    parent.postMessage({ type: 'piik-film-language', lang: event.detail }, location.origin);
  }
});
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'piik-film-preferences') return;
  if (typeof event.data.reducedMotion === 'boolean') player.reducedMotion = event.data.reducedMotion;
  if (['en', 'zh-CN'].includes(event.data.lang)) language(event.data.lang);
  if (['light', 'dark', 'system'].includes(event.data.theme)) theme(event.data.theme);
});
