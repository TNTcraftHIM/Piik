import DefaultTheme from 'vitepress/theme-without-fonts';
import { useData, withBase } from 'vitepress';
import { h, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { useStorage } from '@vueuse/core';
import { THEME_STORAGE_KEY } from '../../../../src/client/ui/theme.ts';
import { bindBrandMotion, brandMarkup } from '../../../assets/brand.js';
import { initialLanguage, rememberLanguage } from '../../../assets/language.js';
import '../../../assets/brand.css';
import './style.css';

const DocumentationBrand = {
  setup() {
    const element = ref();
    let stopMotion;
    onMounted(() => {
      stopMotion = bindBrandMotion(element.value.querySelector('.lr-brand-mark'));
    });
    onBeforeUnmount(() => stopMotion?.());
    return () => h('span', { ref: element, class: 'identity', innerHTML: brandMarkup('docs-brand') });
  },
};

export default {
  extends: DefaultTheme,
  setup() {
    const { isDark } = useData();
    const preference = useStorage(THEME_STORAGE_KEY, 'auto', undefined, { flush: 'sync' });
    provide('toggle-appearance', () => {
      const selected = isDark.value ? 'light' : 'dark';
      isDark.value = selected === 'dark';
      // useDark queues auto when a mode matches the OS. Commit synchronously
      // so that queued write cannot erase the deliberate shared choice.
      preference.value = selected;
    });
  },
  Layout() {
    const { lang } = useData();
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h(DocumentationBrand),
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
