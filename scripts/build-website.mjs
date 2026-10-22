import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve } from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { writeWebLicenseNotices } from "./package-licenses.mjs";
import { meta as filmMeta } from "../site/films/external/films/A/film.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { buildDocumentation } from "../site/docs/build.mjs";
import { buildFilmControls } from "./build-film-controls.mjs";

const source = new URL("../site/", import.meta.url);
const output = new URL("../build/site/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, {
  recursive: true,
  filter: (path) =>
    path !== fileURLToPath(new URL("docs", source)) &&
    path !== fileURLToPath(new URL("films", source)) &&
    !path.endsWith(".js") &&
    !path.endsWith(".css") &&
    !path.endsWith(".ts") &&
    !path.endsWith(".tsx") &&
    !path.endsWith("tsconfig.json") &&
    !path.endsWith("README.md"),
});
await cp(new URL("../LICENSE", import.meta.url), new URL("LICENSE", output));
// App, website and reader guides share the same brand artwork and raster exports.
for (const name of ["favicon.svg", "favicon.png", "favicon.ico"]) {
  await cp(new URL(`../public/${name}`, import.meta.url),
    new URL(name.endsWith(".ico") ? name : `assets/${name}`, output));
}
const [{ locales }, { Glyph }] = await Promise.all([
  "../src/client/locales/index.ts",
  "../src/client/ui/icons.tsx",
].map(path => tsImport(path, {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../src/tsconfig.json", import.meta.url)),
})));
// Independent locale pools stay inert HTML; the first entry is also the no-JS fallback.
const welcomePools = [locales.en, locales.zh].map(locale => locale.playful.welcome.map(({ text }) =>
  renderToStaticMarkup(createElement("span", { lang: locale.tag }, `“${text}”`))));
const homepage = (await readFile(new URL("index.html", source), "utf8"))
  .replace(/<span class="film-length">.*?<\/span>/, `<span class="film-length">${Math.round(filmMeta.duration)}s</span>`)
  .replace(/<p id="welcome-line">.*?<\/p>/, `<p id="welcome-line">${welcomePools.map(pool => pool[0] ?? "").join("")}</p>`)
  // Reuse the product's icon and copy owners without a React runtime on the homepage.
  .replace(/<template id="theme-(light|dark)"><\/template>/g, (_, target) =>
    `<template id="theme-${target}">` +
    renderToStaticMarkup(createElement(Glyph, { name: target === "light" ? "sun" : "moon", size: 16, draw: "theme-toggle" })) +
    [locales.en, locales.zh].map(locale => renderToStaticMarkup(createElement("span", {
      className: "lr-cap", lang: locale.tag, "data-label": locale.copy[`theme.${target}`],
    }, locale.copy[`theme.${target}.short`]))).join("") + '</template>');
await writeFile(new URL("index.html", output), homepage.replace(
  '</body>', `<template id="welcome-lines">${welcomePools.flat().join('')}</template></body>`,
));
// Publish only the selected film's runtime. A content identity covers its relative
// script, font and audio tree so HTML never mixes generations across caches.
const external = new URL('films/external/', source);
const runtimeFiles = [];
async function collect(directory) {
  for (const entry of (await readdir(new URL(directory, external), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const path = directory + entry.name;
    if (entry.isDirectory()) await collect(path + '/');
    else runtimeFiles.push(path);
  }
}
for (const directory of ['films/A/', 'assets/fonts/subset/A-en/', 'assets/fonts/subset/A-zh/', 'out/A/']) await collect(directory);
for (const file of ['art.js', 'brand-mark.css', 'cast.js', 'core.js', 'film.css', 'fonts.js', 'icons.js', 'player.js', 'playback-controls.js', 'tex.js', 'type.js']) runtimeFiles.push('engine/' + file);
for (const file of await readdir(new URL('assets/fonts/', external))) if (file.endsWith('-OFL.txt')) runtimeFiles.push('assets/fonts/' + file);
runtimeFiles.push('licenses/Piik-MIT.txt');
const contents = new Map();
const hash = createHash('sha256');
const controls = await buildFilmControls();
for (const file of runtimeFiles.sort()) {
  let bytes = file === 'engine/playback-controls.js' ? controls : await readFile(file === 'engine/brand-mark.css'
    ? new URL('../src/client/components/living/brand-mark.css', import.meta.url)
    : new URL(file, external));
  if (file === 'engine/player.js') {
    const registry = /export const FILMS = \{[\s\S]*?\n\};/;
    const player = bytes.toString();
    if (!registry.test(player)) throw new Error('Selected-film build requires the external player registry.');
    bytes = Buffer.from(player.replace(registry, "export const FILMS = { A: () => import('../films/A/film.js') };"));
  }
  contents.set(file, bytes);
  hash.update(file).update(bytes);
}
const runtime = 'runtime-' + hash.digest('hex').slice(0, 16);
for (const [file, bytes] of contents) {
  const location = new URL('film/' + runtime + '/' + file, output);
  await mkdir(new URL('./', location), { recursive: true });
  await writeFile(location, bytes);
}
const sharedBuild = {
  outdir: fileURLToPath(output),
  entryNames: "[dir]/[name]-[hash]",
  bundle: true,
  minify: true,
  metafile: true,
};
const pageEntries = {
  main: fileURLToPath(new URL("main.js", source)),
  styles: fileURLToPath(new URL("styles.css", source)),
  "assets/brand": fileURLToPath(new URL("assets/brand.css", source)),
  "film/player": fileURLToPath(new URL("film/player.js", source)),
  "film/film": fileURLToPath(new URL("film/film.css", source)),
};
const pageAssets = await build({
  ...sharedBuild,
  entryPoints: pageEntries,
  format: "esm",
  plugins: [{ name: "selected-film", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/films\/external\/engine\/player\.js$/ }, () => ({ path: `./${runtime}/engine/player.js`, external: true }));
  } }],
});
// This inert fixture is still the README screenshot source; the homepage never loads it.
const demoEntries = { 'film/ui/ui': fileURLToPath(new URL('film/ui/main.tsx', source)) };
const demoAssets = await build({
  ...sharedBuild, entryPoints: demoEntries, format: 'iife', jsx: 'automatic', legalComments: 'linked',
  define: { 'import.meta': 'piikFilmBuild', 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'const piikFilmBuild = { url: document.currentScript.src, env: { DEV: false } };' },
});
writeWebLicenseNotices(fileURLToPath(new URL('../', import.meta.url)), fileURLToPath(new URL('film/ui/third-party-licenses.txt', output)));
// HTML and its scripts/styles must share a content identity across CDN caches.
// Bundle imports too, so a fresh entry cannot load a stale fixed-name dependency.
const assets = new Map();
const entries = new Map(Object.entries({ ...pageEntries, ...demoEntries }).map(([name, path]) => [path, name]));
const outputPath = path => relative(fileURLToPath(output), resolve(path)).replaceAll("\\", "/");
for (const [path, metadata] of Object.entries({ ...pageAssets.metafile.outputs, ...demoAssets.metafile.outputs })) {
  if (!metadata.entryPoint) continue;
  const name = entries.get(resolve(metadata.entryPoint));
  if (!name) throw new Error(`Unknown website entry: ${metadata.entryPoint}`);
  assets.set(name + extname(path), outputPath(path));
  if (metadata.cssBundle) assets.set(name + ".css", outputPath(metadata.cssBundle));
}
for (const [page, base] of [
  ["index.html", ""], ["film/index.html", "film/"], ["film/ui/index.html", "film/ui/"],
]) {
  const location = new URL(page, output);
  const html = (await readFile(location, "utf8")).replace(
    /\b(src|href)="([^"?#]+\.(?:js|css))"/g,
    (_, attribute, href) => {
      const key = new URL(href, `https://piik.invalid/${base}`).pathname.slice(1);
      const asset = assets.get(key);
      if (!asset) throw new Error(`Unbundled website asset: ${page}: ${href}`);
      return `${attribute}="./${relative(base || ".", asset).replaceAll("\\", "/")}"`;
    },
  );
  await writeFile(location, html);
}
await buildDocumentation();
console.log(
  "Website built in build/site (selected film A and the isolated README fixture).",
);
