// The complete studio stays independent of the website's selected A runtime.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeWebLicenseNotices } from './package-licenses.mjs';

const source = new URL('../site/films/', import.meta.url);
const output = new URL('../build/film-preview/', import.meta.url);
const website = new URL('../build/site/', import.meta.url);
if (!existsSync(new URL('film/index.html', website))) throw new Error('Run npm run build:films to prepare the website and film previews.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(website, new URL('website/', output), { recursive: true });
for (const file of ['index.html', 'embed.html', 'embed.js']) await cp(new URL(file, source), new URL(file, output));
await cp(new URL('external/', source), new URL('external/', output), {
  recursive: true,
  filter: path => path !== fileURLToPath(new URL('external/authoring', source)) &&
    path !== fileURLToPath(new URL('external/README.md', source)),
});
await cp(new URL('../src/client/components/living/brand-mark.css', import.meta.url), new URL('external/engine/brand-mark.css', output));
await build({ entryPoints: ['gallery.js', 'gallery.css', 'player-theme.css'].map(file => fileURLToPath(new URL(file, source))),
  outdir: fileURLToPath(output), bundle: true, format: 'esm', minify: true, logLevel: 'warning' });

const story = new URL('story/', source), storyOutput = new URL('story/', output);
await mkdir(new URL('ui/', storyOutput), { recursive: true });
for (const file of ['index.html', 'studies.css', 'NOTICE.txt', 'pixel-platformer-NOTICE.txt']) {
  await cp(new URL(file, story), new URL(file, storyOutput));
}
await cp(new URL('assets/', story), new URL('assets/', storyOutput), { recursive: true });
await cp(new URL('ui/index.html', story), new URL('ui/index.html', storyOutput));
await build({ entryPoints: [fileURLToPath(new URL('player.js', story))], outfile: fileURLToPath(new URL('player.js', storyOutput)),
  bundle: true, format: 'esm', minify: true, logLevel: 'warning' });
await build({ entryPoints: [fileURLToPath(new URL('ui/main.tsx', story))], outfile: fileURLToPath(new URL('ui/ui.js', storyOutput)),
  bundle: true, minify: true, format: 'iife', jsx: 'automatic', legalComments: 'linked', logLevel: 'warning',
  define: { 'import.meta': 'piikFilmBuild', 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'const piikFilmBuild = { url: document.currentScript.src, env: { DEV: false } };' },
});
writeWebLicenseNotices(fileURLToPath(new URL('../', import.meta.url)), fileURLToPath(new URL('ui/third-party-licenses.txt', storyOutput)));
console.log('Seven films ready in build/film-preview. Run npm run preview:films.');
