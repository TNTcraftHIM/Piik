import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

export const hostingGroups = { en: 'Self-hosting', zh: '自部署' };

// Explicit publication list: adding a repository document never publishes it automatically.
export const pages = [
  ['docs/guide/README.md', 'index.md', 'Start here'],
  ['docs/guide/getting-started.md', 'getting-started.md', 'Start here'],
  ['docs/guide/sharing.md', 'sharing.md', 'Using Piik'],
  ['docs/guide/room-tools.md', 'room-tools.md', 'Using Piik'],
  ['docs/guide/remote-control.md', 'remote-control.md', 'Using Piik'],
  ['cmd/piik-app/README.md', 'app.md', 'Using Piik'],
  ['docs/guide/troubleshooting.md', 'troubleshooting.md', 'Get help'],
  ['docs/guide/network.md', 'network.md', 'Networking'],
  ['docs/guide/frp.md', 'frp.md', 'Networking'],
  ['docs/deployment.md', 'deployment.md', hostingGroups.en],
  ['docs/guide/translating.md', 'translating.md', 'Contribute'],
  ['docs/guide/README.zh-CN.md', 'zh/index.md', '开始使用'],
  ['docs/guide/getting-started.zh-CN.md', 'zh/getting-started.md', '开始使用'],
  ['docs/guide/sharing.zh-CN.md', 'zh/sharing.md', '使用 Piik'],
  ['docs/guide/room-tools.zh-CN.md', 'zh/room-tools.md', '使用 Piik'],
  ['docs/guide/remote-control.zh-CN.md', 'zh/remote-control.md', '使用 Piik'],
  ['cmd/piik-app/README.zh-CN.md', 'zh/app.md', '使用 Piik'],
  ['docs/guide/troubleshooting.zh-CN.md', 'zh/troubleshooting.md', '遇到问题'],
  ['docs/guide/network.zh-CN.md', 'zh/network.md', '网络连接'],
  ['docs/guide/frp.zh-CN.md', 'zh/frp.md', '网络连接'],
  ['docs/guide/translating.zh-CN.md', 'zh/translating.md', '参与项目'],
].map(([source, path, group]) => {
  const markdown = readFileSync(new URL('../../' + source, import.meta.url), 'utf8');
  const text = /^# (.+)$/m.exec(markdown)?.[1].trim();
  if (!text) throw new Error('Missing help page title in ' + source);
  return { source, path, text, group };
});

export const repository = 'https://github.com/TNTcraftHIM/Piik';

// Repository readers switch translations below the title. On the website the header owns this control.
export function documentBody(markdown, source) {
  const file = posix.basename(source);
  const languageLinks = file.endsWith('.zh-CN.md')
    ? `[English](./${file.replace('.zh-CN.md', '.md')}) · 简体中文`
    : `English · [简体中文](./${file.replace(/\.md$/, '.zh-CN.md')})`;
  return markdown.replace(/^(# [^\r\n]+\r?\n\r?\n)([^\r\n]+)\r?\n\r?\n/m, (original, title, row) => {
    if (!row.startsWith(languageLinks)) return original;
    const guideLink = row.slice(languageLinks.length);
    return /^(?: · \[[^\]]+\]\(\.{1,2}\/[^)]+\.md\))?$/.test(guideLink) ? title : original;
  });
}

function repositoryReference(href, source) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null;
  const [, pathname, suffix] = href.match(/^([^?#]*)(.*)$/);
  if (!pathname) return null;
  const decoded = decodeURIComponent(pathname);
  const target = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(source), decoded));
  return { target, suffix };
}

// Markdown keeps repository-relative links; only the generated view uses web routes.
export function documentLink(href, source) {
  const reference = repositoryReference(href, source);
  if (!reference) return href;
  const { target, suffix } = reference;
  const page = pages.find(page => page.source === target);
  if (page) {
    const current = pages.find(page => page.source === source);
    const relative = posix.relative(posix.dirname(current.path), page.path).replace(/\.md$/, '.html');
    return `./${relative}${suffix}`;
  }
  return `${repository}/blob/main/${target}${suffix}`;
}

// Keep images local to the documentation build so Vite can hash and bundle them.
export function documentImage(src, source) {
  const reference = repositoryReference(src, source);
  if (!reference || !reference.target.startsWith('docs/assets/')) return src;
  const current = pages.find(page => page.source === source);
  return `./${posix.relative(posix.dirname(current.path), reference.target.slice('docs/'.length))}${reference.suffix}`;
}
