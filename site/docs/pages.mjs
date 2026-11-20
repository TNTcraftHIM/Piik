import { posix } from 'node:path';

// Explicit publication list: adding a repository document never publishes it automatically.
export const pages = [
  ['docs/guide/README.md', 'index.md', 'Documentation', 'Start here'],
  ['docs/guide/getting-started.md', 'getting-started.md', 'Getting started', 'Start here'],
  ['docs/guide/sharing.md', 'sharing.md', 'Sharing and playback', 'Using Piik'],
  ['docs/guide/room-tools.md', 'room-tools.md', 'Chat, voice and remote control', 'Using Piik'],
  ['docs/guide/remote-control.md', 'remote-control.md', 'Remote control and playing together', 'Using Piik'],
  ['cmd/piik-app/README.md', 'app.md', 'App reference', 'Using Piik'],
  ['docs/guide/troubleshooting.md', 'troubleshooting.md', 'Troubleshooting', 'Get help'],
  ['docs/guide/no-media-route.md', 'no-media-route.md', 'No media route available', 'Get help'],
  ['docs/guide/sound-help.md', 'sound-help.md', 'Sound and microphone', 'Get help'],
  ['docs/guide/network.md', 'network.md', 'Network connections', 'Networking'],
  ['docs/guide/frp.md', 'frp.md', 'Fixed invitations with frp', 'Networking'],
  ['docs/operations/self-hosting.md', 'self-hosting.md', 'Deploy a site', 'Self-hosting'],
  ['docs/operations/service-management.md', 'service-management.md', 'Run and update', 'Self-hosting'],
  ['docs/guide/translating.md', 'translating.md', 'Translate Piik', 'Contribute'],
  ['docs/guide/README.zh-CN.md', 'zh/index.md', '文档中心', '开始使用'],
  ['docs/guide/getting-started.zh-CN.md', 'zh/getting-started.md', '快速上手', '开始使用'],
  ['docs/guide/sharing.zh-CN.md', 'zh/sharing.md', '分享与播放', '使用 Piik'],
  ['docs/guide/room-tools.zh-CN.md', 'zh/room-tools.md', '聊天、语音与远程控制', '使用 Piik'],
  ['docs/guide/remote-control.zh-CN.md', 'zh/remote-control.md', '远程控制与多人同乐', '使用 Piik'],
  ['cmd/piik-app/README.zh-CN.md', 'zh/app.md', 'App 使用参考', '使用 Piik'],
  ['docs/guide/troubleshooting.zh-CN.md', 'zh/troubleshooting.md', '问题排查', '遇到问题'],
  ['docs/guide/no-media-route.zh-CN.md', 'zh/no-media-route.md', '没有可用的媒体线路', '遇到问题'],
  ['docs/guide/sound-help.zh-CN.md', 'zh/sound-help.md', '声音和麦克风', '遇到问题'],
  ['docs/guide/network.zh-CN.md', 'zh/network.md', '进阶网络排查', '网络连接'],
  ['docs/guide/frp.zh-CN.md', 'zh/frp.md', '用 frp 设置固定邀请', '网络连接'],
  ['docs/operations/self-hosting.zh-CN.md', 'zh/self-hosting.md', '部署站点', '自部署'],
  ['docs/operations/service-management.zh-CN.md', 'zh/service-management.md', '运行与更新', '自部署'],
  ['docs/guide/translating.zh-CN.md', 'zh/translating.md', '参与翻译', '参与项目'],
].map(([source, path, text, group]) => ({ source, path, text, group }));

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
