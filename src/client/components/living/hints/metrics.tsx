import type { ReactNode } from "react";
import type { HintScene, MetricHintKind } from "../../../ui/visual-kinds";
import { Frame, INK_STAGE, MiniTv, Pawn, SKY, rmBlock } from "../Comic";

const INK = "var(--ink)";
const PAPER = "var(--paper)";
type Metric = MetricHintKind extends `hint-metric-${infer Name}` ? Name : never;

function MetricMotion() {
  return <style>{`
.vls-metric-flow{animation:vlsMetricFlow var(--comic-duration,3.2s) ease-out both}
.vls-metric-loss{animation:vlsMetricLoss var(--comic-duration,3.2s) ease-out both}
.vls-metric-sampling{stroke-dasharray:1;animation:vlsMetricSampling var(--comic-duration,3.2s) ease-out both}
.vls-metric-measure{transform-box:fill-box;transform-origin:center;animation:vlsMetricMeasure var(--comic-duration,3.2s) ease-out both}
.vls-metric-hand{animation:vlsMetricHand var(--comic-duration,3.2s) ease-out both}
.vls-metric-outbound{stroke-dasharray:1;animation:vlsMetricOutbound var(--comic-duration,3.2s) ease-out both}
.vls-metric-return{stroke-dasharray:1;animation:vlsMetricReturn var(--comic-duration,3.2s) ease-out both}
.vls-metric-drop{animation:vlsMetricDrop var(--comic-duration,3.2s) ease-in-out both}
.vls-metric-lag{animation:vlsMetricLag var(--comic-duration,3.2s) ease-out both}
@keyframes vlsMetricFlow{0%,8%{transform:translateX(-12px)}36%,100%{transform:none}}
@keyframes vlsMetricLoss{0%,10%{transform:translateY(-6px);opacity:0}38%,100%{transform:none;opacity:1}}
@keyframes vlsMetricSampling{0%,8%{stroke-dashoffset:1}42%,100%{stroke-dashoffset:0}}
@keyframes vlsMetricMeasure{0%,8%{transform:scale(.78)}38%,100%{transform:none}}
@keyframes vlsMetricHand{0%,8%{transform:rotate(-120deg)}46%,100%{transform:none}}
@keyframes vlsMetricOutbound{0%,8%{stroke-dashoffset:1}24%,100%{stroke-dashoffset:0}}
@keyframes vlsMetricReturn{0%,24%{stroke-dashoffset:1}49%,100%{stroke-dashoffset:0}}
@keyframes vlsMetricDrop{0%,12%{transform:translateY(-14px)}38%,100%{transform:none}}
@keyframes vlsMetricLag{0%,20%{transform:translateX(-57px)}48%,100%{transform:none}}
${rmBlock(["vls-metric-flow", "vls-metric-loss", "vls-metric-sampling", "vls-metric-measure", "vls-metric-hand", "vls-metric-outbound", "vls-metric-return", "vls-metric-drop", "vls-metric-lag"], [
  [".vls-metric-flow,.vls-metric-loss,.vls-metric-measure,.vls-metric-hand,.vls-metric-drop,.vls-metric-lag", "transform:none;opacity:1"],
  [".vls-metric-sampling,.vls-metric-outbound,.vls-metric-return", "stroke-dashoffset:0"],
], false)}
`}</style>;
}

function Clock({ x, y = 26, unit = "ms", moving = true }: { x: number; y?: number; unit?: string; moving?: boolean }) {
  return <g stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round">
    <circle cx={x} cy={y} r={12} /><path className={moving ? "vls-metric-hand" : undefined} style={{ transformOrigin: `${x}px ${y}px` }} d={`M${x} ${y - 7}v7l5 3`} />
    <text x={x + 18} y={y + 4} fill={INK} stroke="none" fontSize={12}>{unit}</text>
  </g>;
}

function Arrow({ x, y = 52, width = 28, className }: { x: number; y?: number; width?: number; className?: string }) {
  return <path className={className} pathLength={1} d={`M${x} ${y}h${width}m-5-4 5 4-5 4`} stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
}

function Screen({ x, y = 30, crossed = false }: { x: number; y?: number; crossed?: boolean }) {
  return <g stroke={INK} strokeWidth={2} fill={PAPER} strokeLinecap="round">
    <rect x={x} y={y} width={30} height={24} rx={3} />
    {crossed ? <path className="vls-metric-loss" d={`m${x + 8} ${y + 6} 14 12m0-12-14 12`} />
      : <path d={`m${x + 4} ${y + 19} 8-9 6 5 5-4 4 8`} fill="none" />}
  </g>;
}

function Speaker({ x, y = 36 }: { x: number; y?: number }) {
  return <g stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d={`M${x} ${y + 8}h8l12-8v32l-12-8h-8Zm26 1q9 7 0 14`} />
  </g>;
}

function Chip({ x, y = 32 }: { x: number; y?: number }) {
  return <g stroke={INK} strokeWidth={2} fill={PAPER}>
    <rect x={x} y={y} width={36} height={32} rx={5} />
    <path d={`M${x + 11} ${y - 5}v5m14-5v5m-14 32v5m14-5v5M${x - 5} ${y + 10}h5m-5 12h5m36-12h5m-5 12h5`} />
  </g>;
}

function Packets({ x, y = 45, loss = false, capacity = false, moving = true }: { x: number; y?: number; loss?: boolean; capacity?: boolean; moving?: boolean }) {
  return <g stroke={INK} strokeWidth={2} fill={PAPER}>
    <g className={moving ? "vls-metric-flow" : undefined}>
      {[0, 1, 2].map(index => <rect key={index} x={x + index * 22} y={y} width={14} height={12} rx={2}
        strokeDasharray={loss && index === 1 ? "2 3" : undefined} opacity={loss && index === 1 ? .4 : 1} />)}
      {loss ? <path className="vls-metric-loss" d={`m${x + 25} ${y + 18} 8 8m0-8-8 8`} strokeLinecap="round" /> : null}
    </g>
    {capacity ? <rect x={x - 5} y={y - 15} width={68} height={38} rx={4} fill="none" strokeDasharray="4 4" /> : null}
  </g>;
}

function MetricPicture({ metric }: { metric: Metric }): ReactNode {
  if (metric === "resolution" || metric === "capture") return <>
    <MiniTv x={56} y={19} w={108} h={54} />
    <path className="vls-metric-measure" d="M56 79h108m-108-4v8m108-8v8M182 19v54m-4-54h8m-8 54h8" stroke={INK} strokeWidth={2} fill="none" />
    <text x={109} y={90} textAnchor="middle" fill={INK} fontSize={11}>px</text>
    <text x={193} y={50} fill={INK} fontSize={12}>px</text>
    {metric === "capture" ? <><Arrow x={222} /><g className="vls-metric-flow"><Screen x={265} /></g></> : <Pawn x={268} yb={78} s={13} color={SKY} eyes />}
  </>;
  if (metric === "fps" || metric === "input-fps") return <>
    <g className="vls-metric-flow">{[0, 1, 2].map(index => <Screen key={index} x={32 + index * 40} y={39} />)}</g>
    <path d="M32 76h110m-110-4v8m110-8v8" stroke={INK} strokeWidth={2} />
    <text x={88} y={28} fill={INK} textAnchor="middle" fontSize={14}>1 s</text>
    <Arrow x={165} width={35} />
    {metric === "input-fps" ? <Chip x={238} /> : <MiniTv x={226} y={29} w={60} h={39} />}
  </>;
  if (["bitrate", "outgoing", "audio-bitrate", "loss", "audio-loss"].includes(metric)) return <>
    {metric.startsWith("audio") ? <Speaker x={28} /> : <Screen x={28} y={39} />}
    <Arrow x={78} /><Packets x={123} loss={metric.endsWith("loss")} capacity={metric === "outgoing"} />
    <Arrow x={201} /><Pawn x={272} yb={75} s={13} color={SKY} eyes />
    {!metric.endsWith("loss") ? <text x={153} y={82} textAnchor="middle" fill={INK} fontSize={13}>kb/s</text> : null}
  </>;
  if (metric === "jitter" || metric === "audio-jitter") return <>
    {metric === "audio-jitter" ? <Speaker x={28} /> : <Screen x={28} y={39} />}
    <Arrow x={80} />
    <path className="vls-metric-sampling" pathLength={1} d="M126 70h162m-154-24v20m19-20v20m46-20v20m19-20v20m54-20v20" stroke={INK} strokeWidth={2.5} strokeLinecap="round" />
    <Clock x={202} y={24} />
  </>;
  if (metric === "dropped") return <>
    <Screen x={30} y={38} /><g className="vls-metric-drop"><Screen x={72} y={52} crossed /></g><Screen x={114} y={38} />
    <Arrow x={165} /><MiniTv x={225} y={29} w={65} h={40} />
  </>;
  if (metric === "rtt") return <>
    <Pawn x={55} yb={79} s={16} eyes /><Pawn x={265} yb={79} s={16} color={SKY} eyes />
    <Arrow x={87} y={40} width={145} className="vls-metric-outbound" /><g transform="translate(320 105) rotate(180)"><Arrow x={87} y={40} width={145} className="vls-metric-return" /></g>
    <Clock x={160} y={21} moving={false} />
  </>;
  if (["encoder", "encode-time", "decode-time", "quality"].includes(metric)) return <>
    {metric === "decode-time" ? <Packets x={21} /> : <Screen x={37} y={39} />}
    <Arrow x={94} /><Chip x={144} y={40} /><Arrow x={202} />
    {metric === "decode-time" ? <MiniTv x={244} y={33} w={50} h={34} /> : <Packets x={241} />}
    {metric.endsWith("time") ? <Clock x={162} y={19} /> : <path d="M147 49h30m-30 8h30m-20-10v5m10 2v6" stroke={INK} strokeWidth={2} />}
  </>;
  if (metric === "freezes" || metric === "freeze-time") return <>
    <MiniTv x={25} y={27} w={68} h={44} /><MiniTv x={134} y={27} w={68} h={44} />
    <path d="M42 58l14-17 18 17Z" fill={SKY} /><path className="vls-metric-flow" d="M151 58l14-17 18 17Z" fill={SKY} />
    <Arrow x={99} width={25} /><path d="M164 36v11m7-11v11" stroke={INK_STAGE} strokeWidth={3} />
    {metric === "freeze-time" ? <Clock x={264} y={43} /> : <text x={264} y={58} textAnchor="middle" fill={INK} fontSize={23}>#</text>}
  </>;
  if (metric === "playout") return <>
    <Screen x={24} y={16} /><Speaker x={24} y={49} />
    <path d="M89 29h193M89 73h193M165 45h57m-57-4v8m57-8v8" stroke={INK} strokeWidth={2} />
    <path className="vls-metric-flow" d="M165 22v14" stroke={INK} strokeWidth={2} />
    <path className="vls-metric-lag" d="M222 66v14" stroke={INK} strokeWidth={2} />
    <text x={194} y={61} fill={INK} textAnchor="middle" fontSize={12}>Δ ms</text>
  </>;
  if (metric === "video-buffer" || metric === "audio-buffer") return <>
    <Packets x={23} moving={false} /><Arrow x={96} />
    <path d="M133 37v36h69V37" stroke={INK} strokeWidth={2} fill="none" /><Packets x={140} y={53} />
    <Clock x={166} y={20} /><Arrow x={211} />
    {metric === "audio-buffer" ? <Speaker x={264} /> : <MiniTv x={255} y={35} w={48} h={31} />}
  </>;
  return <>
    <Speaker x={24} />
    <path d="M76 53h12l6-16 9 31 8-15h18m55 0h13l6-16 9 31 8-15h69" stroke={INK} strokeWidth={2} fill="none" />
    <rect x={135} y={35} width={44} height={35} rx={4} stroke={INK} strokeDasharray="3 3" fill="none" />
    <path className="vls-metric-loss" d="M139 53h8l5-12 7 23 6-11h8" stroke={INK} strokeWidth={2} fill="none" />
    <path d="M138 77h38m-38-4v8m38-8v8" stroke={INK} strokeWidth={2} />
    <text x={158} y={29} fill={INK} fontSize={18} textAnchor="middle">{metric === "concealment-rate" ? "%" : "#"}</text>
  </>;
}

const scene = (metric: Metric): HintScene => ({ theme }) => <>
  <MetricMotion /><Frame x={4} w={312} theme={theme} result /><MetricPicture metric={metric} />
</>;

export const METRIC_SCENES: Record<MetricHintKind, HintScene> = {
  "hint-metric-resolution": scene("resolution"), "hint-metric-fps": scene("fps"),
  "hint-metric-bitrate": scene("bitrate"), "hint-metric-loss": scene("loss"),
  "hint-metric-rtt": scene("rtt"), "hint-metric-outgoing": scene("outgoing"),
  "hint-metric-quality": scene("quality"), "hint-metric-capture": scene("capture"),
  "hint-metric-input-fps": scene("input-fps"), "hint-metric-encoder": scene("encoder"),
  "hint-metric-encode-time": scene("encode-time"), "hint-metric-jitter": scene("jitter"),
  "hint-metric-dropped": scene("dropped"), "hint-metric-decode-time": scene("decode-time"),
  "hint-metric-freezes": scene("freezes"), "hint-metric-freeze-time": scene("freeze-time"),
  "hint-metric-audio-bitrate": scene("audio-bitrate"), "hint-metric-audio-loss": scene("audio-loss"),
  "hint-metric-audio-jitter": scene("audio-jitter"), "hint-metric-playout": scene("playout"),
  "hint-metric-video-buffer": scene("video-buffer"), "hint-metric-audio-buffer": scene("audio-buffer"),
  "hint-metric-concealment-rate": scene("concealment-rate"), "hint-metric-concealments": scene("concealments"),
};
