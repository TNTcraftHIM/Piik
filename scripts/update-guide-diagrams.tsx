import { readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Glyph, type GlyphName } from "../src/client/ui/icons";
import { locales } from "../src/client/locales";

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
    { source: "microphone", output: "speaker", from: english ? "Share microphone" : "分享麦克风", to: english ? "Playback volume" : "播放音量" },
    { source: "microphone", output: "headphones", from: english ? "Room voice" : "房间语音", to: english ? "Voice volume" : "语音收听" },
  ];
  return <svg xmlns="http://www.w3.org/2000/svg" width="600" height="502" viewBox="0 0 600 502" role="img" aria-labelledby="title desc">
    <title id="title">{english ? "Shared sound and room voice" : "分享声音与房间语音"}</title>
    <desc id="desc">{english ? "Source audio and the optional share microphone follow the picture and playback volume. Room voice uses its separate listening controls." : "来源声音与可选的分享麦克风跟随画面，由播放音量控制。房间语音使用独立的收听音量。"}</desc>
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

function NetworkPaths({ english }: { english: boolean }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340" role="img" aria-labelledby="title desc">
    <title id="title">{english ? "Chat and media use separate connections" : "聊天与媒体使用不同的连接"}</title>
    <desc id="desc">{english ? "Messages and history reach the room host through the domain. Voice, pictures and file content use peer connections, directly or through other participants." : "消息与历史通过域到达房间托管端。语音、画面和文件内容使用设备间连接，可直连或由其他参与者转发。"}</desc>
    <style>{style}</style>
    <path className="path" d="M164 174h28V64h32m152 0h28v110h28" />
    <rect className="node" x="224" y="8" width="152" height="112" rx="20" />
    <g className="glyph" transform="translate(274 18)"><Glyph name="server" size={52} /></g>
    <text x="300" y="101">{english ? "Domain" : "域"}</text>
    {[{ x: 12, label: english ? "Room host" : "房主" }, { x: 436, label: english ? "Friend" : "朋友" }].map(node => <g key={node.x}>
      <rect className="node" x={node.x} y="136" width="152" height="160" rx="20" />
      <g className="glyph" transform={`translate(${node.x + 46} 164)`}><Glyph name="window" size={60} /></g>
      <text x={node.x + 76} y="268">{node.label}</text>
    </g>)}
    <text x="300" y="173" style={{ fontSize: 24 }}>{english ? "Messages & history" : "消息与历史"}</text>
    <text x="300" y="232" style={{ fontSize: 24 }}>{english ? "Media & files" : "语音、画面与文件"}</text>
    <path className="path" d="M164 252h272m-262-8-10 8 10 8m252-16 10 8-10 8" />
    <text x="300" y="326" style={{ fontSize: 22, fill: "var(--muted)" }}>{english ? "Chat works before a peer connection is ready" : "聊天无需等待设备间连接"}</text>
  </svg>;
}

function VirtualLanSteps({ english }: { english: boolean }) {
  const steps: { icon: GlyphName; title: string; detail: string }[] = english ? [
    { icon: "network", title: "Join the same virtual LAN", detail: "Keep the tool running on both sides." },
    { icon: "window", title: "Choose the virtual address", detail: `${locales.en.copy["client.launch.local"]} → select the virtual IP` },
    { icon: "link", title: "Send the complete invitation", detail: "Confirm the certificate and join." },
  ] : [
    { icon: "network", title: "加入同一虚拟网络", detail: "房主和朋友都保持组网工具运行" },
    { icon: "window", title: "选择虚拟地址", detail: `${locales.zh.copy["client.launch.local"]} → ${locales.zh.copy["client.launch.lanAddress"]}` },
    { icon: "link", title: "发送完整邀请链接", detail: "朋友核对本地证书，进入房间" },
  ];
  return <svg xmlns="http://www.w3.org/2000/svg" width="600" height="380" viewBox="0 0 600 380" role="img" aria-labelledby="title desc">
    <title id="title">{english ? "Use Piik over a virtual LAN" : "通过虚拟局域网使用 Piik"}</title>
    <desc id="desc">{steps.map(step => `${step.title}: ${step.detail}`).join(". ")}</desc>
    <style>{style}</style>
    {steps.map((step, i) => <g key={step.icon} transform={`translate(0 ${i * 128})`}>
      <rect className="node" x="8" y="4" width="584" height="116" rx="20" />
      <text x="35" y="70" style={{ fontSize: 20, fill: "var(--muted)" }}>0{i + 1}</text>
      <g className="glyph" transform="translate(68 34)"><Glyph name={step.icon} size={52} /></g>
      <text x="144" y="51" style={{ fontSize: 28, textAnchor: "start" }}>{step.title}</text>
      <text x="144" y="88" style={{ fontSize: 23, textAnchor: "start", fill: "var(--muted)" }}>{step.detail}</text>
    </g>)}
  </svg>;
}

function publish(path: URL, image: string) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== image) throw new Error("Refresh guide diagrams: npx tsx --tsconfig scripts/tsconfig.json scripts/update-guide-diagrams.tsx");
  } else writeFileSync(path, image);
}

for (const language of ["en", "zh-CN"]) {
  for (const [name, Diagram] of [["audio-paths", AudioPaths], ["network-paths", NetworkPaths], ["virtual-lan", VirtualLanSteps]] as const) {
    publish(new URL(`../docs/assets/guide/${name}.${language}.svg`, import.meta.url),
      renderToStaticMarkup(<Diagram english={language === "en"} />) + "\n");
  }
}

// Keep authored scene geometry and motion; only the surrounding UI uses the palette.
const quickstartPath = new URL("../docs/assets/quickstart.svg", import.meta.url);
const quickstart = readFileSync(quickstartPath, "utf8");
const paletteBlock = /<style data-guide-palette="true">[\s\S]*?<\/style>/;
if (!paletteBlock.test(quickstart)) throw new Error("Missing quickstart palette block");
publish(quickstartPath, quickstart.replace(paletteBlock,
  `<style data-guide-palette="true">\n${palette}\n</style>`));
