import { useId, useLayoutEffect, useRef, useState } from "react";
import { AppHeader } from "../components/living/Header";
import { Btn } from "../components/living/primitives";
import { useAnchoredPopover } from "../components/living/use-anchored-popover";
import { ChannelAction } from "../channel/components/ChannelAction";
import { Glyph, type GlyphName } from "../ui/icons";
import { replaySvgAnimations } from "../ui/animation";
import { useCopy } from "../ui/copy";
import "./glyph-motion-preview.css";

const examples: { icon: GlyphName; zh: string; en: string }[] = [
  { icon: "check", zh: "勾选：左侧起笔，一笔向右完成", en: "Check: one pen stroke from left to right" },
  { icon: "headphones", zh: "耳机：头梁，然后两侧耳罩", en: "Headphones: band, then both ear cups" },
  { icon: "headphonesOff", zh: "停止收听：耳机之后画关闭斜线", en: "Deafened: headphones, then the slash" },
  { icon: "key", zh: "钥匙：钥匙环、杆、齿", en: "Key: ring, shaft, then teeth" },
  { icon: "arrowRight", zh: "前进：先线杆，再指向", en: "Forward: shaft, then arrowhead" },
  { icon: "x", zh: "关闭：先左上向右下，再交叉一笔", en: "Close: first diagonal, then crossing stroke" },
];
const motionTokens = ["press", "feedback", "control", "surface", "emphasis"] as const;

/** Explicit playback of the shared animation, not another runtime icon owner. */
export function GlyphMotionPreview() {
  const { lang } = useCopy(), zh = lang === "zh";
  const board = useRef<HTMLDivElement>(null);
  const surfaceTrigger = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const surfaceId = useId();
  useAnchoredPopover(surfaceTrigger, surface, { align: "start" });
  const [position, setPosition] = useState(100);
  const [disabled, setDisabled] = useState(false);
  const [selected, setSelected] = useState(false);
  const [durations, setDurations] = useState<string[]>([]);
  const readDurations = () => {
    if (!board.current) return;
    const style = getComputedStyle(board.current);
    setDurations(motionTokens.map(token => style.getPropertyValue(`--motion-${token}`).trim()));
  };
  useLayoutEffect(() => {
    readDurations();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    reduced.addEventListener("change", readDurations);
    return () => reduced.removeEventListener("change", readDurations);
  }, []);
  const replay = () => { if (board.current) replaySvgAnimations(board.current); setPosition(100); readDurations(); };
  const seek = (value: number) => {
    setPosition(value);
    for (const animation of board.current?.getAnimations({ subtree: true }) ?? []) {
      const svg = (animation.effect as KeyframeEffect).target?.closest("svg");
      if (!svg) continue;
      animation.pause(); animation.currentTime = parseFloat(getComputedStyle(svg).getPropertyValue("--glyph-duration")) * value / 100;
    }
  };
  return <div className="lr-app"><AppHeader appControl={null} diagnosticControl={null} />
    <main className="lr-room gm-main"><header><h1>{zh ? "控件节奏与图标笔顺" : "Control timing and icon strokes"}</h1>
      <p>{zh ? "相同图形与总时长，比较同时描画和语义笔顺。只在主动作或明确状态反馈时播放，普通图标保持静止。" : "Same shapes and total duration: compare simultaneous drawing with semantic stroke order. Primary actions and explicit state feedback draw; ordinary icons stay still."}</p></header>
      <dl className="gm-tokens" aria-label={zh ? "当前共享时长" : "Current shared durations"}>{motionTokens.map((token, index) =>
        <div key={token}><dt>{token}</dt><dd>{durations[index] || "—"}</dd></div>)}</dl>
      <section className="gm-runtime"><h2>{zh ? "实际控件" : "Actual controls"}</h2>
        <Btn icon="headphones" draw="motion-preview" tone="primary" disabled={disabled} pressed={selected}
          title={{ text: zh ? "切换主动作反馈" : "Toggle primary feedback" }}
          cap={{ text: zh ? "主动作反馈" : "Primary feedback" }} onClick={() => setSelected(value => !value)} />
        <ChannelAction icon="key" quiet label={zh ? "普通动作：图标不重画" : "Ordinary: icon stays visible"} />
        <div ref={surfaceTrigger}><Btn icon="sliders" popoverTarget={surfaceId}
          title={{ text: zh ? "打开共享浮层" : "Open shared surface" }} cap={{ text: zh ? "打开浮层" : "Open surface" }} />
          <div ref={surface} id={surfaceId} popover="auto" className="lr-anchored-card gm-surface">
            <h3>{zh ? "共享浮层节奏" : "Shared surface timing"}</h3>
            <p>{zh ? "使用实际浮层样式。取消、Escape 或点击外部返回，主动作的选择保持不变。" : "Uses the actual surface style. Cancel, Escape or click outside to return; the primary selection stays unchanged."}</p>
            <ChannelAction icon="arrowLeft" label={zh ? "取消并返回" : "Cancel and return"} onClick={() => surface.current?.hidePopover()} />
          </div>
        </div>
        <label><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} />{zh ? "禁用主动作" : "Disable primary action"}</label>
        <p>{zh ? "系统减少动态效果时保留完整图形；此对照不改变该偏好，也不自动循环。" : "Reduced motion keeps the complete shape. This comparison does not override that preference or loop automatically."}</p>
      </section>
      <div className="gm-controls"><ChannelAction icon="refresh" label={zh ? "回放一次" : "Replay once"} onClick={replay} />
        <label>{zh ? "查看过程" : "Inspect progress"}<input type="range" min={0} max={100} value={position} onChange={event => seek(Number(event.target.value))} /><output>{position}%</output></label></div>
      <div ref={board} className="gm-board">{examples.map(example => <section className="gm-example" key={example.icon}>
        <h2>{zh ? example.zh : example.en}</h2><div className="gm-comparison">
          <div className="gm-before"><span>{zh ? "同时描画" : "Simultaneous"}</span><Glyph name={example.icon} size={76} draw="comparison" /></div>
          <div className="gm-after"><span>{zh ? "语义笔顺" : "Semantic order"}</span><Glyph name={example.icon} size={76} draw="comparison" /></div>
        </div></section>)}</div>
    </main>
  </div>;
}
