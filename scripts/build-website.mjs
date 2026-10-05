import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve } from "node:path";
import { build } from "esbuild";
import { writeWebLicenseNotices } from "./package-licenses.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { buildDocumentation } from "../site/docs/build.mjs";

const source = new URL("../site/", import.meta.url);
const output = new URL("../build/site/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, {
  recursive: true,
  filter: (path) =>
    path !== fileURLToPath(new URL("docs", source)) &&
    !path.endsWith(".js") &&
    !path.endsWith(".css") &&
    !path.endsWith(".ts") &&
    !path.endsWith(".tsx") &&
    !path.endsWith("tsconfig.json") &&
    !path.endsWith("README.md"),
});
await cp(new URL("../LICENSE", import.meta.url), new URL("LICENSE", output));
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
  .replace(/<p id="welcome-line">.*?<\/p>/, `<p id="welcome-line">${welcomePools.map(pool => pool[0] ?? "").join("")}</p>`);
await writeFile(new URL("index.html", output), homepage.replace(
  '</body>', `<template id="welcome-lines">${welcomePools.flat().join('')}</template></body>`,
));
// The opening shot uses the current homepage, with only its film clock adapter
// substituted for the ordinary page script. Keep its layout and copy in one place.
await writeFile(new URL("film/ui/website.html", output),
  homepage
    .replace('<head>', '<head><base href="../../" />')
    .replace('<script type="module" src="./main.js"></script>', '<script src="./film/ui/website.js" defer></script>')
    .replace('</body>', (await readFile(new URL("film/ui/index.html", source), "utf8")).match(/<svg id="cursor"[\s\S]*?<\/svg>/)[0] + '</body>'),
);
// Static controls use the product icon owner without shipping another React
// runtime to the film page. The live demonstration remains its isolated bundle.
const filmPage = new URL("film/index.html", output);
await writeFile(filmPage, (await readFile(filmPage, "utf8")).replace(
  /<span data-glyph="([a-zA-Z]+)"><\/span>/g,
  (_, name) => renderToStaticMarkup(createElement(Glyph, { name, size: 21 })),
));
writeWebLicenseNotices(
  fileURLToPath(new URL("../", import.meta.url)),
  fileURLToPath(new URL("film/ui/third-party-licenses.txt", output)),
);
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
  "film/playback-controls": fileURLToPath(new URL("../src/client/components/living/playback-controls.css", import.meta.url)),
  "film/brand-mark": fileURLToPath(new URL("../src/client/components/living/brand-mark.css", import.meta.url)),
};
const demoEntries = {
  "film/ui/ui": fileURLToPath(new URL("film/ui/main.tsx", source)),
  "film/ui/website": fileURLToPath(new URL("film/ui/website.ts", source)),
};
const pageAssets = await build({
  ...sharedBuild,
  entryPoints: pageEntries,
  format: "esm",
});
const demoAssets = await build({
  ...sharedBuild,
  entryPoints: demoEntries,
  format: "iife",
  jsx: "automatic",
  legalComments: "linked",
  define: {
    "import.meta": "piikFilmBuild",
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: "const piikFilmBuild = { url: document.currentScript.src, env: { DEV: false } };",
  },
});
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
  ["index.html", ""], ["film/index.html", "film/"],
  ["film/ui/index.html", "film/ui/"], ["film/ui/website.html", ""],
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
  "Website built in build/site (static files, including the shared product UI).",
);
