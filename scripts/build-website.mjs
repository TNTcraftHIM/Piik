import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeWebLicenseNotices } from "./package-licenses.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";

const source = new URL("../site/", import.meta.url);
const output = new URL("../build/site/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, {
  recursive: true,
  filter: (path) =>
    !path.endsWith(".ts") &&
    !path.endsWith(".tsx") &&
    !path.endsWith("tsconfig.json") &&
    !path.endsWith("README.md"),
});
await cp(new URL("../LICENSE", import.meta.url), new URL("LICENSE", output));
const [{ WELCOME_LINES }, { catalogs }, { Glyph }] = await Promise.all([
  "../src/client/components/living/WelcomeLine.tsx",
  "../src/client/locales/index.ts",
  "../src/client/ui/icons.tsx",
].map(path => tsImport(path, {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../src/tsconfig.json", import.meta.url)),
})));
// Reuse the product's paired lines as inert HTML, without a runtime catalog.
const welcomeLines = WELCOME_LINES.map(({ key }) => renderToStaticMarkup(
  createElement("span", { "data-welcome-key": key },
    createElement("span", { lang: "en" }, `“${catalogs.en[key]}”`),
    createElement("span", { lang: "zh-CN" }, `“${catalogs.zh[key]}”`),
  ),
));
let homepage = (await readFile(new URL("index.html", source), "utf8"))
  .replace(/<p id="welcome-line">.*?<\/p>/, `<p id="welcome-line">${welcomeLines[0]}</p>`);
if (process.env.PIIK_WEBSITE_RELEASE_DATA) {
  const { websiteDownloads } = await tsImport("../site/downloads.ts", { parentURL: import.meta.url });
  const release = websiteDownloads(JSON.parse(await readFile(process.env.PIIK_WEBSITE_RELEASE_DATA, "utf8")));
  homepage = homepage.replace(/<p class="release-note" id="download-status">[\s\S]*?<\/p>/,
    `<p class="release-note" id="download-status"><span class="release-label">${release.version}</span>` +
    `<span lang="en">Download the ZIP for your system, then extract it.</span>` +
    `<span lang="zh-CN">选择对应系统，下载 ZIP 后解压。</span>` +
    `<a href="${release.notes}"><span lang="en">Release notes</span><span lang="zh-CN">版本说明</span></a></p>`);
  homepage = homepage.replace(/<a\b([^>]*data-download="([^"]+)"[^>]*data-provider="([^"]+)"[^>]*)>([\s\S]*?)<\/a\s*>/g,
    (original, attributes, target, provider, content) => {
      const item = release.packages.find(item => item.target === target);
      const href = provider === 'github' ? item?.url : item?.mirrorURL;
      if (!href) return original;
      const label = provider === 'github'
        ? { en: 'Download ZIP · GitHub', zh: '下载 ZIP · GitHub' }
        : { en: 'Gitee alternative (ZIP)', zh: 'Gitee 备用下载（ZIP）' };
      return `<a${attributes.replace(/href="[^"]*"/, `href="${href}"`)}>` + content
        .replace(/<span lang="en">[\s\S]*?<\/span\s*>/, `<span lang="en">${label.en}</span>`)
        .replace(/<span lang="zh-CN">[\s\S]*?<\/span\s*>/, `<span lang="zh-CN">${label.zh}</span>`) + '</a>';
    });
}
await writeFile(new URL("index.html", output), homepage.replace(
  '</body>', `<template id="welcome-lines">${welcomeLines.join('')}</template></body>`,
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
await cp(
  new URL("../src/client/components/living/playback-controls.css", import.meta.url),
  new URL("film/playback-controls.css", output),
);
await cp(
  new URL("../src/client/components/living/brand-mark.css", import.meta.url),
  new URL("film/brand-mark.css", output),
);
writeWebLicenseNotices(
  fileURLToPath(new URL("../", import.meta.url)),
  fileURLToPath(new URL("film/ui/third-party-licenses.txt", output)),
);
await build({
  entryPoints: {
    ui: fileURLToPath(new URL("../site/film/ui/main.tsx", import.meta.url)),
    website: fileURLToPath(new URL("../site/film/ui/website.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("film/ui/", output)),
  bundle: true,
  format: "iife",
  jsx: "automatic",
  minify: true,
  legalComments: "linked",
  define: {
    "import.meta": "piikFilmBuild",
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: "const piikFilmBuild = { url: document.currentScript.src, env: { DEV: false } };",
  },
});
console.log(
  "Website built in build/site (static files, including the shared product UI).",
);
