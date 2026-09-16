import { defineConfig } from 'vitepress';
import { pages, documentLink, repository } from '../pages.mjs';
import { githubSlug } from '../../../scripts/markdown-slug.mjs';

const editPattern = ({ frontmatter }) => `https://github.com/TNTcraftHIM/Piik/edit/main/${frontmatter.source}`;
const base = process.env.PIIK_DOCS_BASE || '/docs/';

const sidebar = chinese => {
  const groups = new Map();
  for (const page of pages.filter(page => page.path.startsWith('zh/') === chinese)) {
    if (!groups.has(page.group)) groups.set(page.group, []);
    groups.get(page.group).push({ text: page.text, link: `/${page.path.replace(/\.md$/, '.html')}` });
  }
  groups.get(chinese ? '自部署' : 'Self-hosting').push({
    text: chinese ? '完整配置参考（英文）' : 'Configuration reference',
    link: `${repository}/blob/main/docs/standards/configuration.md`,
  });
  return Array.from(groups, ([text, items]) => ({ text, items }));
};

export default defineConfig({
  base,
  srcDir: '../../build/docs-source',
  outDir: '../../build/site/docs',
  cacheDir: '../../build/docs-cache',
  tempDir: '../../build/docs-temp',
  title: 'Piik',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}../assets/favicon.svg` }]],
  description: 'Piik guides, troubleshooting and self-hosting.',
  cleanUrls: false,
  appearance: true,
  lastUpdated: false,
  vite: { publicDir: false },
  locales: {
    root: { label: 'English', lang: 'en', themeConfig: { sidebar: sidebar(false) } },
    zh: {
      label: '简体中文', lang: 'zh-CN', description: 'Piik 使用教程、问题排查与自部署指南。',
      themeConfig: {
        sidebar: sidebar(true),
        nav: [{ text: '官网', link: 'https://piik.tv/?lang=zh-CN' }, { text: '在线使用', link: 'https://demo.piik.tv' }],
        outline: { level: [2, 3], label: '本页内容' },
        docFooter: { prev: '上一页', next: '下一页' },
        editLink: { pattern: editPattern, text: '在 GitHub 上改进此页' },
        sidebarMenuLabel: '目录', returnToTopLabel: '回到顶部', darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换浅色', darkModeSwitchTitle: '切换深色', langMenuLabel: '语言',
        skipToContentLabel: '跳到正文',
      },
    },
  },
  themeConfig: {
    nav: [{ text: 'Website', link: 'https://piik.tv/?lang=en' }, { text: 'Use online', link: 'https://demo.piik.tv' }],
    socialLinks: [{ icon: 'github', link: repository }],
    outline: [2, 3],
    editLink: {
      pattern: editPattern,
      text: 'Improve this page on GitHub',
    },
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            tokenize: text => Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(text))
              .filter(part => part.isWordLike).map(part => part.segment),
          },
        },
        locales: {
          zh: { translations: {
            button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
            modal: {
              displayDetails: '显示详细结果', resetButtonTitle: '清空搜索', backButtonTitle: '返回',
              noResultsText: '没有找到相关内容',
              footer: { selectText: '打开', navigateText: '切换', closeText: '关闭' },
            },
          } },
        },
      },
    },
  },
  markdown: {
    anchor: { slugify: githubSlug },
    headers: { slugify: githubSlug },
    toc: { slugify: githubSlug },
    config(md) {
      md.core.ruler.after('inline', 'piik-document-links', state => {
        const page = pages.find(page => page.path === state.env.relativePath);
        if (!page) return;
        for (const token of state.tokens.flatMap(token => token.children ?? [])) {
          if (token.type === 'link_open') token.attrSet('href', documentLink(token.attrGet('href'), page.source));
        }
      });
    },
  },
  transformPageData(data) {
    const page = pages.find(page => page.path === data.relativePath);
    if (page) data.frontmatter.source = page.source;
  },
});
