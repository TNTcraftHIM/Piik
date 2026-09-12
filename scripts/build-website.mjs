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
    !path.endsWith(".tsx") &&
    !path.endsWith("tsconfig.json") &&
    !path.endsWith("README.md"),
});
await cp(new URL("../LICENSE", import.meta.url), new URL("LICENSE", output));
// Static controls use the product icon owner without shipping another React
// runtime to the film page. The live demonstration remains its isolated bundle.
const filmPage = new URL("film/index.html", output);
const { Glyph } = await tsImport("../src/client/ui/icons.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../src/tsconfig.json", import.meta.url)),
});
await writeFile(filmPage, (await readFile(filmPage, "utf8")).replace(
  /<span data-glyph="([a-zA-Z]+)"><\/span>/g,
  (_, name) => renderToStaticMarkup(createElement(Glyph, { name, size: 21 })),
));
await cp(
  new URL("../src/client/components/living/playback-controls.css", import.meta.url),
  new URL("film/playback-controls.css", output),
);
writeWebLicenseNotices(
  fileURLToPath(new URL("../", import.meta.url)),
  fileURLToPath(new URL("film/ui/third-party-licenses.txt", output)),
);
await build({
  entryPoints: [
    fileURLToPath(new URL("../site/film/ui/main.tsx", import.meta.url)),
  ],
  outdir: fileURLToPath(new URL("film/ui/", output)),
  entryNames: "ui",
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
