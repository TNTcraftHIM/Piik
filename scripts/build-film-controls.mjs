import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tsImport } from 'tsx/esm/api';

// The film's shadow root needs the actual control styles, not only inherited
// tokens. Render the product's icons at build time; no React runtime is shipped.
export async function buildFilmControls() {
  const [{ Glyph }, css] = await Promise.all([
    tsImport('../src/client/ui/icons.tsx', {
      parentURL: import.meta.url,
      tsconfig: fileURLToPath(new URL('../src/tsconfig.json', import.meta.url)),
    }),
    build({
      stdin: {
        contents: '@import "./button.css"; @import "./media-controls.css";',
        resolveDir: fileURLToPath(new URL('../src/client/components/living/', import.meta.url)),
        loader: 'css',
      },
      bundle: true, minify: true, write: false,
    }),
  ]);
  const icons = Object.fromEntries(['play', 'pause', 'speaker', 'speakerOff', 'expand', 'contract', 'refresh'].map(name =>
    [name, renderToStaticMarkup(createElement(Glyph, { name }))]));
  return Buffer.from(`export const CONTROL_CSS = ${JSON.stringify(css.outputFiles[0].text)};\nexport const ICON = ${JSON.stringify(icons)};\n`);
}
