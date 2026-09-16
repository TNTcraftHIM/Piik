import { posix } from 'node:path';

// Explicit publication list: adding a repository document never publishes it automatically.
export const pages = [
  ['docs/guide/README.md', 'index.md', 'Documentation', 'Start here'],
  ['docs/guide/getting-started.md', 'getting-started.md', 'Getting started', 'Start here'],
  ['docs/guide/troubleshooting.md', 'troubleshooting.md', 'Troubleshooting', 'Start here'],
  ['cmd/piik-app/README.md', 'app.md', 'App reference', 'Start here'],
  ['docs/operations/self-hosting.md', 'self-hosting.md', 'Deploy a site', 'Self-hosting'],
  ['docs/operations/service-management.md', 'service-management.md', 'Run and update', 'Self-hosting'],
  ['docs/guide/translating.md', 'translating.md', 'Translate Piik', 'Contribute'],
  ['docs/guide/README.zh-CN.md', 'zh/index.md', '文档中心', '开始使用'],
  ['docs/guide/getting-started.zh-CN.md', 'zh/getting-started.md', '快速上手', '开始使用'],
  ['docs/guide/troubleshooting.zh-CN.md', 'zh/troubleshooting.md', '问题排查', '开始使用'],
  ['cmd/piik-app/README.zh-CN.md', 'zh/app.md', 'App 使用参考', '开始使用'],
  ['docs/operations/self-hosting.zh-CN.md', 'zh/self-hosting.md', '部署站点', '自部署'],
  ['docs/operations/service-management.zh-CN.md', 'zh/service-management.md', '运行与更新', '自部署'],
  ['docs/guide/translating.zh-CN.md', 'zh/translating.md', '参与翻译', '参与项目'],
].map(([source, path, text, group]) => ({ source, path, text, group }));

export const repository = 'https://github.com/TNTcraftHIM/Piik';

// Markdown keeps repository-relative links; only the generated view uses web routes.
export function documentLink(href, source) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
  const [, pathname, suffix] = href.match(/^([^?#]*)(.*)$/);
  if (!pathname) return href;
  const decoded = decodeURIComponent(pathname);
  const target = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(source), decoded));
  const page = pages.find(page => page.source === target);
  if (page) {
    const current = pages.find(page => page.source === source);
    const relative = posix.relative(posix.dirname(current.path), page.path).replace(/\.md$/, '.html');
    return `./${relative}${suffix}`;
  }
  return `${repository}/blob/main/${target}${suffix}`;
}
