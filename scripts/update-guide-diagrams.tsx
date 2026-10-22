import { readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Glyph, type GlyphName } from "../src/client/ui/icons";

// Diagrams explain relationships; controls and colour still come from the UI.
// Embed the palette so GitHub's image renderer needs no external stylesheet.
const palette = readFileSync(new URL("../src/client/ui/palette.css", import.meta.url), "utf8")
  .replace(/:root\[data-theme="dark"\], :root\.dark \{([^}]+)\}/, "@media (prefers-color-scheme: dark) { :root {$1} }");
const style = `${palette}
  text { fill: var(--ink); font: 600 26px system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; text-anchor: middle; }
  .node { fill: var(--paper); stroke: var(--control-edge); stroke-width: 2; }
  .input { fill: var(--control-selected); }
  .glyph { color: var(--ink); }
  .source .glyph { color: var(--control-selected-ink); }
  .source text { fill: var(--control-selected-ink); }
  .path { fill: none; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
`;

function AudioPaths({ english }: { english: boolean }) {
  const rows: { source: GlyphName; output: GlyphName; from: string; to: string }[] = [
    { source: "window", output: "speaker", from: english ? "Source audio" : "来源声音", to: english ? "Playback volume" : "播放音量" },
    { source: "microphone", output: "headphones", from: english ? "Microphone" : "麦克风", to: english ? "Voice volume" : "语音收听" },
  ];
  return <svg xmlns="http://www.w3.org/2000/svg" width="600" height="332" viewBox="0 0 600 332" role="img" aria-labelledby="title desc">
    <title id="title">{english ? "Two sounds, separate controls" : "两种声音，分别控制"}</title>
    <desc id="desc">{english ? "Source audio follows the shared picture and its playback volume. Microphones use room voice and its listening controls." : "来源声音跟随分享画面，由播放音量控制。麦克风通过房间语音传输，由语音收听控件控制。"}</desc>
    <style>{style}</style>
    {rows.map((row, i) => <g key={row.source} transform={`translate(0 ${i * 170})`}>
      <g className="source">
        <rect className="node input" x="12" y="4" width="220" height="146" rx="22" />
        <g className="glyph" transform="translate(95 21)"><Glyph name={row.source} size={54} /></g>
        <text x="122" y="118">{row.from}</text>
      </g>
      <rect className="node" x="368" y="4" width="220" height="146" rx="22" />
      <g className="glyph" transform="translate(451 21)"><Glyph name={row.output} size={54} /></g>
      <path className="path" d="M250 77h96m-9-9 9 9-9 9" />
      <text x="478" y="118">{row.to}</text>
    </g>)}
  </svg>;
}

function publish(path: URL, image: string) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== image) throw new Error("Refresh guide diagrams: npx tsx --tsconfig scripts/tsconfig.json scripts/update-guide-diagrams.tsx");
  } else writeFileSync(path, image);
}

for (const language of ["en", "zh-CN"]) {
  publish(new URL(`../docs/assets/guide/audio-paths.${language}.svg`, import.meta.url),
    renderToStaticMarkup(<AudioPaths english={language === "en"} />) + "\n");
}

// Keep authored scene geometry and motion; only the surrounding UI uses the palette.
const quickstartPath = new URL("../docs/assets/quickstart.svg", import.meta.url);
const quickstart = readFileSync(quickstartPath, "utf8");
const paletteBlock = /<style data-guide-palette="true">[\s\S]*?<\/style>/;
if (!paletteBlock.test(quickstart)) throw new Error("Missing quickstart palette block");
publish(quickstartPath, quickstart.replace(paletteBlock,
  `<style data-guide-palette="true">\n${palette}\n</style>`));
