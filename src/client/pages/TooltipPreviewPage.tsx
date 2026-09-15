import { useState } from "react";
import { AppHeader } from "../components/living/Header";
import { Tooltip } from "../components/living/Tooltip";
import { ControlsPreview } from "./ControlsPreview";
import { WelcomeLine, WelcomeCipher } from "../components/living/WelcomeLine";
import { locales } from "../locales";
import { HINT_KINDS, HintComic, isHintKind, type HintKind } from "../components/living/hints";
import { Comic, type ComicKind } from "../components/living/Comic";
import { COMIC_KINDS, getComicPresentation, type ComicTone, type ComicMotion } from "../components/living/comic-presentation";
import { useCopy, type CopyKey } from "../ui/copy";
import { replaySvgAnimations } from "../ui/animation";
import { MetricCells } from "../components/living/Metrics";
import { EMPTY_METRICS } from "../types";

const EXAMPLES: { label: string; kind: HintKind | ComicKind; tone: ComicTone; motion: ComicMotion; text: CopyKey }[] = [
  { label: "说明 / Neutral", kind: "hint-volume", tone: "off", motion: "demo", text: "playback.volume" },
  { label: "成功 / Success", kind: "hint-copy-code", tone: "live", motion: "still", text: "common.copied" },
  { label: "受限 / Limited", kind: "hint-nat-unavailable", tone: "warn", motion: "still", text: "host.advanced.route.natPredictionUnavailable" },
  { label: "App incompatible", kind: "warning", tone: "warn", motion: "still", text: "native.incompatible" },
  { label: "Fullscreen waiting", kind: "hint-fullscreen-unavailable", tone: "warn", motion: "still", text: "playback.fullscreenWaiting" },
  { label: "Fullscreen failed", kind: "hint-fullscreen-unavailable", tone: "bad", motion: "still", text: "playback.fullscreenFailed" },
  { label: "失败 / Failed", kind: "warning", tone: "bad", motion: "still", text: "common.copyFailed" },
  { label: "连接中 / Connecting", kind: "signal-connecting", tone: "busy", motion: "progress", text: "state.signal.connecting" },
  { label: "恢复中 / Recovering", kind: "recovering", tone: "warn", motion: "progress", text: "state.peer.reconnecting" },
];

function PreviewCard({ kind, tone, motion, label, text }: {
  kind: ComicKind | HintKind; tone?: ComicTone; motion?: ComicMotion; label?: string; text?: string;
}) {
  const defaults = getComicPresentation(kind);
  const replay = (card: HTMLElement) => {
    const scene = card.querySelector(".lr-tooltip-preview-art > svg");
    if (scene) replaySvgAnimations(scene);
  };
  return <section id={label ? undefined : kind} className="lr-tooltip-preview-card"
    onPointerEnter={(event) => { if (event.pointerType !== "touch") replay(event.currentTarget); }}
    onPointerDown={(event) => { if (event.pointerType === "touch") replay(event.currentTarget); }}
    onFocusCapture={(event) => replay(event.currentTarget)}>
    <header>
      <code>{label ?? kind}</code>
      <span className="lr-tooltip-preview-actions">
        {text ? <Tooltip toggleOnClick kind={kind} tone={tone} motion={motion} text={text} place="below">
          <button type="button" aria-label={`Text ${label ?? kind}`} className="lr-tooltip-preview-trigger">Aa</button>
        </Tooltip> : null}
        <Tooltip toggleOnClick kind={kind} tone={tone} motion={motion} place="below">
          <button type="button" aria-label={`Preview ${label ?? kind}`} className="lr-tooltip-preview-trigger">✦</button>
        </Tooltip>
      </span>
    </header>
    <div className="lr-tooltip-preview-art">
      {isHintKind(kind) ? <HintComic kind={kind} size={320} tone={tone} motion={motion} />
        : <Comic kind={kind} size={320} theme="paper" tone={tone} motion={motion} />}
    </div>
    <small>{tone ?? defaults.tone} · {motion ?? defaults.motion}</small>
  </section>;
}

export function TooltipPreviewPage() {
  const { t, lang } = useCopy();
  const en = lang === "en";
  const [reducedMotion, setReducedMotion] = useState(false);
  return (
    <div className="lr-app" data-comic-reduced-motion={reducedMotion || undefined}>
      <AppHeader />
      <main className="lr-room lr-tooltip-preview">
        <header className="lr-tooltip-preview-head">
          <h1>{en ? "Piik · UI catalogue" : "Piik · UI 控件大全"}</h1>
          <p>{en ? "Actual components, sample data. Comics loop while displayed. Use the corner buttons to open the same tooltip on hover, focus or tap." : "正式组件，示例数据。漫画在展示期间循环；悬停、聚焦或点击角上的按钮，可查看实际提示。"}</p>
          <label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} />
            {en ? "Reduced motion" : "减少动态效果"}</label>
        </header>
        <nav className="cp-nav" aria-label={en ? "Preview sections" : "预览目录"}>
          <a href="#button-preview">{en ? "Buttons" : "按钮"}</a><a href="#option-preview">{en ? "Options" : "选择与开关"}</a>
          <a href="#input-preview">{en ? "Inputs" : "输入与房间号"}</a><a href="#feedback-preview">{en ? "Feedback" : "反馈"}</a>
          <a href="#people-preview">{en ? "People & connections" : "人物、沙发与连接图"}</a><a href="#source-preview">{en ? "Source picker" : "画面选择"}</a>
          <a href="#playback-preview">{en ? "Playback" : "播放栏"}</a><a href="#comic-preview">{en ? "Tooltips & comics" : "提示与漫画"}</a>
          <a href="#hint-admission-code">{en ? "Room entry" : "房间准入"}</a>
          <a href="#metrics-preview">{en ? "Metrics" : "连接数据"}</a>
          <a href="#welcome-preview">{en ? "Opening lines" : "开场白"}</a>
          <a href="/__status-preview">{en ? "Status gallery" : "完整状态预览"}</a>
        </nav>
        <ControlsPreview />
        <MetricPreview />
        <WelcomeLine still={reducedMotion} />
        <details id="welcome-preview" className="lr-welcome-catalog" open>
          <summary>{locales[lang].playful.welcome.length} {en ? "opening lines" : "句开场白"}</summary>
          <p>{en ? "A line appears immediately, then changes every eight seconds while visible. Each language has its own pool. Pure visual mode uses that entry's pictograms and pixel lettering; switching modes keeps the same entry." : "短句立即出现，可见时每 8 秒换一条。各语言独立维护词库；纯视觉模式显示当前语句对应的图形与像素暗号，切换模式仍是同一句。"}</p>
          <ol>{locales[lang].playful.welcome.map(({ text, symbols }) => <li key={text}><span>{text}</span><WelcomeCipher symbols={symbols} /></li>)}</ol>
        </details>
        <h2 id="comic-preview">语义规则 / Semantic grammar</h2>
        <p>{en ? "Aa pairs the scene with a caption; ✦ shows the pure-visual version." : "Aa 查看图示与文字说明，✦ 查看纯视觉版本。"}</p>
        <div className="lr-tooltip-preview-grid">
          {EXAMPLES.map((example) => <PreviewCard key={example.label} {...example} text={t(example.text)} />)}
        </div>
        <h2>操作说明 / Controls</h2>
        <div className="lr-tooltip-preview-grid">
          {HINT_KINDS.map((kind) => <PreviewCard key={kind} kind={kind} />)}
        </div>
        <h2>状态说明 / States</h2>
        <div className="lr-tooltip-preview-grid">
          {COMIC_KINDS.map((kind) => <PreviewCard key={kind} kind={kind} />)}
        </div>
      </main>
    </div>
  );
}

function MetricPreview() {
  const { t, lang } = useCopy();
  const en = lang === "en";
  const [reason, setReason] = useState("other");
  const [sendExpanded, setSendExpanded] = useState(true);
  const [receiveExpanded, setReceiveExpanded] = useState(true);
  const metrics = {
    ...EMPTY_METRICS,
    resolution: "1920x1080", framesPerSecond: 59.8, bitrateKbps: 7200,
    packetLossPercent: .2, rttMs: 24, codec: "video/H264",
    availableOutgoingKbps: 12000, qualityLimitationReason: reason,
    captureWidth: 2560, captureHeight: 1440, captureFramesPerSecond: 60,
    mediaSourceFramesPerSecond: 60, encoderImplementation: "Sample encoder",
    powerEfficientEncoder: true, intervalEncodeMs: 2.4,
    jitterMs: 1.2, intervalFramesDropped: 2, intervalDecodeMs: 1.4,
    intervalFreezeCount: 1, intervalFreezeDurationMs: 120,
    audioBitrateKbps: 96, audioPacketLossPercent: .1, audioJitterMs: .8,
    audioVideoPlayoutDeltaMs: 3, videoJitterBufferDelayMs: 12,
    audioJitterBufferDelayMs: 15, audioConcealedSamplesPercent: .2,
    intervalAudioConcealmentEvents: 1,
  };
  return <section id="metrics-preview" className="cp-section">
    <h2>{en ? "Connection metrics" : "连接数据"}</h2>
    <p>{en ? "Sample observations in the actual detail cells. Sender limits do not describe the receiver's playback."
      : "用正式详情控件展示示例观测。发送端的限制不代表观众的播放状态。"}</p>
    <label>{t("stats.qualityState")} <select value={reason} onChange={event => setReason(event.target.value)}>
      {(["none", "bandwidth", "cpu", "other", "unclassified"] as const).map(value => <option key={value} value={value}>
        {t(value === "none" ? "stats.quality.normal" : `stats.quality.${value}`)}
      </option>)}
    </select></label>
    <h3>{en ? "Sending" : "发送"}</h3>
    <MetricCells metrics={metrics} direction="send" expanded={sendExpanded} onToggle={setSendExpanded} />
    <h3>{en ? "Receiving" : "接收"}</h3>
    <MetricCells metrics={metrics} direction="receive" expanded={receiveExpanded} onToggle={setReceiveExpanded} />
  </section>;
}
