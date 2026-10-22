import '../films/external/engine/player.js';
import { initialLanguage } from '../assets/language.js';

const player = document.querySelector('piik-promo');
function language(lang) {
  document.documentElement.lang = lang;
  player.setAttribute('lang', lang === 'zh-CN' ? 'zh' : 'en');
  document.title = lang === 'zh-CN' ? 'Piik · 预告状' : 'Piik · The Calling Card';
}
language(initialLanguage());
window.addEventListener('message', event => {
  if (event.source === parent && event.origin === location.origin && event.data?.type === 'piik-film-preferences' &&
    ['en', 'zh-CN'].includes(event.data.lang)) language(event.data.lang);
});
