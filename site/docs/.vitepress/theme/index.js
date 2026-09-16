import DefaultTheme from 'vitepress/theme-without-fonts';
import { useData, withBase } from 'vitepress';
import { h } from 'vue';
import { mascotMarkup } from '../../../assets/brand.js';
import { initialLanguage, rememberLanguage } from '../../../assets/language.js';
import '../../../assets/brand.css';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    const { lang } = useData();
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h('span', { class: 'identity', 'aria-hidden': 'true',
        innerHTML: `<svg class="mascot" viewBox="0 0 32 32">${mascotMarkup('docs-brand')}</svg>` }),
      'doc-bottom': () => h('p', { class: 'docs-license' }, [
        h('a', { href: withBase('/third-party-licenses.txt') },
          lang.value === 'zh-CN' ? '第三方软件许可' : 'Third-party licenses'),
      ]),
    });
  },
  enhanceApp({ router }) {
    if (import.meta.env.SSR) return;
    const base = import.meta.env.BASE_URL;
    if (location.pathname === base && initialLanguage() === 'zh-CN') {
      location.replace(`${base}zh/${location.search}${location.hash}`);
      return;
    }
    const remember = path => rememberLanguage(path.startsWith(`${base}zh/`) ? 'zh-CN' : 'en');
    remember(location.pathname);
    router.onAfterRouteChanged = remember;
    try {
      document.documentElement.toggleAttribute('data-reduced-motion', localStorage.getItem('piik:site-reduced-motion') === 'true');
    } catch { /* Storage restrictions keep the system motion preference. */ }
  },
};
