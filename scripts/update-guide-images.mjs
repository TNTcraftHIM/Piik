import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Capture the real controls with the catalogue's sample data, never a live room.
// Pass the product dev URL, and optionally a built website URL for README captures.
const preview = new URL('/__tooltip-preview', process.argv[2] || 'http://127.0.0.1:8787');
// The README fixture is bundled by build:website; it is separate from the dev catalogue.
const readmePreview = process.argv[3] ? new URL('/film/ui/index.html', process.argv[3]) : null;
const output = fileURLToPath(new URL('../docs/assets/guide/', import.meta.url));
const browser = process.env.AGENT_BROWSER_PATH || (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe')
  : 'agent-browser');
const execute = promisify(execFile);
const session = `piik-guide-images-${process.pid}`;
await execute(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), '--tsconfig',
  fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
  fileURLToPath(new URL('./update-guide-diagrams.tsx', import.meta.url))]);
const run = async (...args) => {
  const { stdout } = await execute(browser, ['--session', session, ...args], { timeout: 30000 });
  return stdout;
};
const evaluate = script => run('eval', '-b', Buffer.from(script).toString('base64'));

async function openSection(section, lang, theme, path = '/__tooltip-preview') {
  await run('open', new URL(path, preview).href);
  await run('wait', `#${section}`);
  await run('click', `.lr-top button[aria-label="${lang === 'en' ? 'English' : '简体中文'}"]`);
  await evaluate(`localStorage.setItem('piik:ui-theme', ${JSON.stringify(theme)})`);
  await run('reload');
  await run('wait', `#${section}`);
  await evaluate(`(async () => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(`
      .lr-top, .lr-tooltip-preview > :not(#${section}):not(:has(#${section})),
      #control-preview > :not(#${section}),
      #${section} > header, #${section} > .cp-tools { display: none !important; }
    `)};
    document.head.append(style);
    await document.fonts.ready;
    scrollTo(0, 0);
  })()`);
}

async function capture(selector, name, directory = output) {
  await run('wait', selector);
  await run('mouse', 'move', '1', '1');
  await evaluate(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    await Promise.all(Array.from(target.querySelectorAll('img')).map(img => img.decode()));
    // Fixed top-layer panels need a settled viewport origin for element captures.
    scrollTo(0, 0);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  await run('screenshot', selector, join(directory, `${name}.png`));
  console.log(`${name}.png`);
}

await mkdir(output, { recursive: true });
try {
  await run('set', 'viewport', '1280', '900');
  for (const theme of ['light', 'dark']) {
    await run('set', 'media', theme, 'reduced-motion');
    for (const [lang, locale] of [['en', 'en'], ['zh', 'zh-CN']]) {
      const suffix = `${locale}${theme === 'dark' ? '.dark' : ''}`;
      await openSection('launcher-preview', lang, theme);
      await capture('.lr-client-modes', `app-modes.${suffix}`);

      await openSection('source-preview', lang, theme);
      await run('click', '#source-preview .cp-stage-action button');
      await run('wait', '.lr-source-picker-list img');
      await evaluate(`document.querySelector('#source-preview .lr-tv-screen').style.minHeight = '650px'`);
      await capture('#source-preview .lr-source-picker-panel', `share-source.${suffix}`);

      await openSection('sharing-preview', lang, theme);
      await run('click', '#sharing-preview button[aria-controls="preview-sharing-settings"]');
      await capture('.lr-sharing-panel', `sharing-settings.${suffix}`);

      await run('set', 'viewport', '1280', '420');
      await openSection('interaction-preview', lang, theme);
      await run('click', `#interaction-preview button[aria-label="${lang === 'en' ? 'Interact' : '互动'}"]`);
      await run('wait', '.lr-interaction-panel');
      await run('click', '.lr-interaction-panel [role="tab"][id$="-voice-tab"]');
      await capture('.lr-interaction-panel', `room-voice.${suffix}`);
      await run('set', 'viewport', '1280', '900');

      await openSection('sharing-troubleshooting', lang, theme, '/__status-preview');
      await run('click', '#sharing-troubleshooting article:first-child button');
      await capture('dialog.lr-share-help[open]', `share-failure.${suffix}`);
    }
  }
  if (readmePreview) {
    await run('set', 'viewport', '1160', '1040');
    for (const theme of ['light', 'dark']) {
      await run('set', 'media', theme, 'reduced-motion');
      for (const lang of ['en', 'zh']) {
        const url = new URL(readmePreview);
        url.search = new URLSearchParams({ still: 'viewer', lang, theme });
        await run('open', url.href);
        await run('wait', '.is-still .lr-app');
        await evaluate('document.fonts.ready');
        await capture('.is-still .lr-app', 'room-' + lang + '-' + theme, join(output, '..'));
      }
    }
  }
} finally {
  await run('close');
}
