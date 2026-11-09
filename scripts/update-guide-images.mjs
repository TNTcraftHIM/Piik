import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 3.0 guide images have one source: production components in the dev catalogue.
// The maintenance branch owns its 2.x screenshots and README film stills.
const preview = new URL('/__tooltip-preview', process.argv[2] || 'http://127.0.0.1:8787');
if (process.argv.length > 3) throw new Error('Usage: node scripts/update-guide-images.mjs [dev-origin]');
const output = fileURLToPath(new URL('../docs/assets/guide/', import.meta.url));
const browser = process.env.AGENT_BROWSER_PATH || (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe')
  : 'agent-browser');
const session = `piik-guide-images-${process.pid}`;

async function execute(command, args, timeout = 30000) {
  const child = spawn(command, args, { windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  // A newly launched browser daemon can inherit these pipes after its CLI exits.
  child.stdout.destroy(); child.stderr.destroy();
  if (code !== 0) throw new Error(stderr || stdout || `${command} exited with ${code}`);
  return stdout;
}
const run = async (...args) => {
  const result = JSON.parse(await execute(browser, ['--session', session, '--json', ...args]));
  if (!result.success) throw new Error(result.error);
  return result.data;
};
const evaluate = script => run('eval', '-b', Buffer.from(script).toString('base64'));

async function capture(selector, name) {
  await run('wait', selector);
  await run('mouse', 'move', '1', '1');
  await evaluate(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    await document.fonts.ready;
    await Promise.all(Array.from(target.querySelectorAll('img')).map(img => img.decode()));
    await Promise.all(target.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const isolation = selector === '.c3-guide-room' ? null : (await evaluate(`(() => {
    const guide = document.querySelector('#channel-guide-preview');
    const target = document.querySelector(${JSON.stringify(selector)});
    const previous = [guide, target].map(node => [node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
    guide.style.visibility = 'hidden'; target.style.visibility = 'visible';
    return previous;
  })()`)).result;
  try {
    await run('screenshot', selector, join(output, `${name}.png`));
  } finally {
    if (isolation) await evaluate(`(() => {
      const nodes = [document.querySelector('#channel-guide-preview'), document.querySelector(${JSON.stringify(selector)})];
      ${JSON.stringify(isolation)}.forEach(([value, priority], index) => nodes[index]?.style.setProperty('visibility', value, priority));
    })()`);
  }
  console.log(`${name}.png`);
}

await execute(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), '--tsconfig',
  fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
  fileURLToPath(new URL('./update-guide-diagrams.tsx', import.meta.url))]);
await mkdir(output, { recursive: true });
try {
  await run('set', 'viewport', '1280', '900');
  for (const theme of ['light', 'dark']) {
    await run('set', 'media', theme, 'reduced-motion');
    for (const [lang, locale] of [['en', 'en'], ['zh', 'zh-CN']]) {
      await run('open', preview.href);
      await run('wait', '#channel-guide-preview');
      await run('click', `.lr-top .lr-lang button[aria-label="${lang === 'en' ? 'English' : '简体中文'}"]`);
      if ((await evaluate('document.documentElement.dataset.theme')).result !== theme)
        await run('click', '.lr-top .lr-theme-toggle');
      await run('wait', '--fn', `document.querySelector('.c3-guide-title strong')?.textContent === ${JSON.stringify(lang === 'en' ? 'Friday with friends' : '周五小聚')}`);
      await evaluate(`(() => {
        const style = document.createElement('style');
        style.textContent = '.lr-top, .lr-tooltip-preview > :not(#channel-guide-preview), #channel-guide-preview > :not(.c3-guide-room) { display:none !important }';
        document.head.append(style); scrollTo(0, 0);
      })()`);
      const suffix = `${locale}${theme === 'dark' ? '.dark' : ''}`;
      await capture('.c3-guide-room', `channel-room.${suffix}`);
      await run('click', '[data-room-settings="friday"]');
      await run('find', 'role', 'tab', 'click', '--name', lang === 'en' ? 'Invitation' : '邀请', '--exact');
      await run('wait', '.c3-invite-copy input');
      await capture('.c3-settings-dialog[open]', `channel-invitation.${suffix}`);
      await run('press', 'Escape');
      await run('find', 'role', 'button', 'click', '--name', lang === 'en' ? 'Start sharing' : '开始分享', '--exact');
      await run('wait', '.c3-share-picker .lr-source-picker-list img');
      await capture('.c3-share-picker:popover-open', `channel-source.${suffix}`);
      await run('press', 'Escape');
      await run('find', 'role', 'button', 'click', '--name', lang === 'en' ? 'Picture and sound' : '画质与声音', '--exact');
      await capture('.c3-quality-picker:popover-open', `channel-quality.${suffix}`);
    }
  }
} finally {
  await run('close');
}
