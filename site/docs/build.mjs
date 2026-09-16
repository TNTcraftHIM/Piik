import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vitepress';
import { pages } from './pages.mjs';
import { writeWebLicenseNotices } from '../../scripts/package-licenses.mjs';

export async function buildDocumentation() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const source = resolve(root, 'build/docs-source');
  await rm(source, { recursive: true, force: true });
  for (const page of pages) {
    const target = resolve(source, page.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(resolve(root, page.source), 'utf8'));
  }
  await build(resolve(root, 'site/docs'));
  const notices = resolve(root, 'build/site/docs/third-party-licenses.txt');
  // The default theme with local search ships these runtimes; the Vite build tool stays local.
  writeWebLicenseNotices(resolve(root, 'site/docs'), notices,
    ['vue', '@vueuse/core', '@vueuse/integrations', 'focus-trap', 'mark.js', 'minisearch']);
  await appendFile(notices, '\nVitePress (MIT)\n\n' + await readFile(resolve(root, 'site/docs/node_modules/vitepress/LICENSE'), 'utf8'));
}
