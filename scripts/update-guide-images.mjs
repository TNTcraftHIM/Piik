import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Capture the real controls with the catalogue's sample data, never a live room.
// Start the product dev preview first; pass its URL as the sole argument.
const preview = new URL('/__tooltip-preview', process.argv[2] || 'http://127.0.0.1:5173');
const output = fileURLToPath(new URL('../docs/assets/guide/', import.meta.url));
const browser = process.env.AGENT_BROWSER_PATH || (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe')
  : 'agent-browser');
const execute = promisify(execFile);
const run = async (...args) => {
  const { stdout } = await execute(browser, ['--session', 'piik-guide-images', ...args], { timeout: 30000 });
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

async function capture(selector, name) {
  await run('wait', selector);
  await run('mouse', 'move', '1', '1');
  await evaluate(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    await Promise.all(Array.from(target.querySelectorAll('img')).map(img => img.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  await run('screenshot', selector, join(output, `${name}.png`));
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
      await capture('#source-preview .cp-stage', `share-source.${suffix}`);

      await openSection('sharing-preview', lang, theme);
      await run('click', '#sharing-preview button[aria-controls="preview-sharing-settings"]');
      await capture('.lr-sharing-panel', `sharing-settings.${suffix}`);

      await openSection('interaction-preview', lang, theme);
      await run('click', `#interaction-preview button[aria-label="${lang === 'en' ? 'Interact' : '互动'}"]`);
      await run('wait', '.lr-interaction-panel');
      await run('click', '.lr-interaction-panel [role="tab"][id$="-voice-tab"]');
      await capture('.lr-interaction-panel', `room-voice.${suffix}`);

      await openSection('sharing-troubleshooting', lang, theme, '/__status-preview');
      await run('click', '#sharing-troubleshooting article:first-child button');
      await capture('dialog.lr-share-help[open]', `share-failure.${suffix}`);
    }
  }
} finally {
  await run('close');
}
