import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Pass the product dev URL, and optionally a built website URL for README captures.
const list = process.argv[2] === '--list';
const preview = new URL('/__guide-preview', !list && process.argv[2] || 'http://127.0.0.1:8787');
const readmePreview = process.argv[3] ? new URL('/film/ui/index.html', process.argv[3]) : null;
const output = fileURLToPath(new URL('../docs/assets/guide/', import.meta.url));
const browser = process.env.AGENT_BROWSER_PATH || (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe')
  : 'agent-browser');
const session = 'piik-guide-images-' + process.pid;
const execute = promisify(execFile);
const root = '[data-guide-capture][data-guide-ready]';
const sceneControls = {
  'app-modes': ['.lr-client-modes'],
  'virtual-lan-address': ['details:has(.lr-client-lan)', 'details:has(.lr-client-lan) > summary'],
  'invite-copy': ['.cp-guide-invite'],
  'invite-qr': ['.lr-invite-qr:popover-open', '.lr-invite-field [popovertarget]'],
  'join-code': [root],
  'join-password': [root],
  'share-source': ['.lr-source-picker-panel'],
  'share-source-confirm': ['.lr-source-picker-panel', '.lr-source-option'],
  'sharing-settings': ['.lr-sharing-panel'],
  'room-voice': ['.lr-interaction-panel:has([id$="-voice-tab"][aria-selected=true])', '.lr-scene button[popovertarget]', '.lr-interaction-panel [role="tab"][id$="-voice-tab"]'],
  'share-failure': ['dialog.lr-share-help[open]', 'button.lr-status-indicator'],
  'viewer-route-failure': ['.lr-tv-screen'],
};

function batch(commands) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, 'batch', '--bail'], {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error('Screenshot batch failed with exit code ' + code));
    });
    child.stdin.once('error', reject);
    child.stdin.end(JSON.stringify(commands));
  });
}

function capture(url, selector, directory, filename, actions = []) {
  const guide = url.pathname === '/__guide-preview' && selector !== root && filename.split('.')[0] !== 'invite-copy';
  const captureSelector = guide ? '#guide-image-bounds' : selector;
  const prepare = `(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target.matches('dialog') && target.contains(document.activeElement) && !target.matches('.lr-tv')) document.activeElement.blur();
    target.scrollIntoView({ block: 'center', inline: 'center' });
    await document.fonts.ready;
    await Promise.all(Array.from(target.querySelectorAll('img'), image => image.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (${guide}) {
      const rect = target.getBoundingClientRect();
      const margin = 12;
      const left = Math.max(0, rect.left + scrollX - margin);
      const top = Math.max(0, rect.top + scrollY - margin);
      const bounds = document.createElement('div');
      bounds.id = 'guide-image-bounds';
      bounds.setAttribute('aria-hidden', 'true');
      Object.assign(bounds.style, {
        position: 'absolute', pointerEvents: 'none',
        left: left + 'px',
        top: top + 'px',
        width: (rect.width + 2 * margin) + 'px',
        height: (rect.height + 2 * margin) + 'px',
      });
      document.body.append(bounds);
    }
  })()`;
  return [
    ['open', url.href],
    ['wait', actions.length ? root : selector],
    ...actions.flatMap(action => [
      ['wait', action],
      ['eval', '-b', Buffer.from('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))').toString('base64')],
      ['click', action],
    ]),
    ['wait', selector],
    ['mouse', 'move', '1', '1'],
    ['eval', '-b', Buffer.from(prepare).toString('base64')],
    ['screenshot', captureSelector, join(directory, filename + '.png')],
  ];
}

if (!list) await execute(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), '--tsconfig',
  fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
  fileURLToPath(new URL('./update-guide-diagrams.tsx', import.meta.url))]);
if (!list) await mkdir(output, { recursive: true });
try {
  for (const theme of ['light', 'dark']) {
    const commands = [['set', 'viewport', '1280', '900'], ['set', 'media', theme, 'reduced-motion']];
    for (const [lang, locale] of [['en', 'en'], ['zh', 'zh-CN']]) {
      const suffix = locale + (theme === 'dark' ? '.dark' : '');
      for (const [scene, [selector, ...actions]] of Object.entries(sceneControls)) {
        const url = new URL(preview);
        url.search = new URLSearchParams({ scene, lang, theme });
        if (scene === 'room-voice') commands.push(['set', 'viewport', '1280', '440']);
        commands.push(...capture(url, selector, output, scene + '.' + suffix, actions));
        if (scene === 'room-voice') commands.push(['set', 'viewport', '1280', '900']);
      }
    }
    if (readmePreview) {
      commands.push(['set', 'viewport', '1160', '1040']);
      for (const lang of ['en', 'zh']) {
        const url = new URL(readmePreview);
        url.search = new URLSearchParams({ still: 'viewer', lang, theme });
        commands.push(...capture(url, '.is-still .lr-app', join(output, '..'), 'room-' + lang + '-' + theme));
      }
    }
    if (list) {
      for (const [action, , path] of commands) if (action === 'screenshot') console.log(path);
    } else await batch(commands);
  }
} finally {
  if (!list) await execute(browser, ['--session', session, 'close'], { timeout: 5000 }).catch(error => {
    console.warn('Could not close the screenshot browser:', error.message);
  });
}
