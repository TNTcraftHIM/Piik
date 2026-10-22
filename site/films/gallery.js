import { films } from './catalogue.js';
import { mountBrands } from '../assets/brand.js';
import { initialLanguage, rememberLanguage } from '../assets/language.js';
import { initTheme } from '../../src/client/ui/theme.ts';

mountBrands();
initTheme();
let language = initialLanguage();
const $ = id => document.getElementById(id);
const text = values => values[language === 'zh-CN' ? 1 : 0];
const requestedFilm = () => films.find(film => film.id === location.hash.slice(1)) || films[0];
const frame = $('film-player');
let frameSize;
let frameURL = '';
frame.addEventListener('load', () => {
  frameSize?.disconnect();
  if (!requestedFilm().controls) return;
  const document = frame.contentDocument;
  // The two original players place controls below the picture. Fit their content
  // rather than reserving a guessed height for each language and screen size.
  frameSize = new ResizeObserver(() => {
    if (!document.fullscreenElement) frame.style.height = `${Math.ceil(document.body.getBoundingClientRect().height)}px`;
  });
  frameSize.observe(document.body);
});
const destination = (film, standalone = false) => {
  const url = new URL(standalone ? film.standalone || film.path : film.path, location.href);
  url.searchParams.set('lang', film.languages.includes(language) ? language : film.languages[0]);
  return url.href;
};
const filmLinks = films.map(film => {
  const link = document.createElement('a');
  link.href = `#${film.id}`;
  const mark = document.createElement('span'); mark.className = 'film-mark'; mark.textContent = film.mark;
  const name = document.createElement('strong');
  const info = document.createElement('small'); info.textContent = `${film.duration}s · ${film.aspect.replace(' / ', ':')}`;
  link.append(mark, name, info);
  return { film, link, name };
});
$('film-list').replaceChildren(...filmLinks.map(({ link }) => link));

function render() {
  language = initialLanguage();
  const film = requestedFilm();
  document.documentElement.lang = language;
  document.querySelector('.lr-lang').setAttribute('aria-label', text(['Language', '语言']));
  $('film-list').setAttribute('aria-label', text(['Films', '宣传片']));
  document.title = `${text(film.title)} · Piik`;
  document.querySelectorAll('[data-language]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
    button.classList.toggle('is-selected', button.dataset.language === language);
  });
  $('film-mark').textContent = film.mark;
  $('film-title').textContent = text(film.title);
  $('film-description').textContent = text(film.description);
  $('film-meta').textContent = `${film.duration}s · ${film.aspect.replace(' / ', ':')}`;
  $('open-film').href = destination(film, true);
  frame.title = text(film.title);
  frame.style.setProperty('--aspect', film.aspect);
  frame.classList.toggle('vertical', film.aspect === '9 / 16');
  // Navigating the single frame retires all of the previous film's media/UI.
  const url = destination(film);
  if (frameURL !== url) {
    frameSize?.disconnect();
    frame.style.removeProperty('height');
    frameURL = url;
    // Only the gallery selection belongs in history, not an extra iframe entry.
    frame.contentWindow.location.replace(url);
  }
  for (const entry of filmLinks) {
    entry.name.textContent = text(entry.film.title);
    if (entry.film.id === film.id) entry.link.setAttribute('aria-current', 'true');
    else entry.link.removeAttribute('aria-current');
  }
}
document.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => {
  language = button.dataset.language;
  rememberLanguage(language);
  render();
}));
window.addEventListener('hashchange', render);
window.addEventListener('popstate', render);
render();
