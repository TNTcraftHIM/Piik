import { AppHeader } from "../components/living/Header";
import { Tooltip } from "../components/living/Tooltip";
import { ControlsPreview } from "./ControlsPreview";
import { WelcomeLine, WelcomeCipher, WELCOME_LINES } from "../components/living/WelcomeLine";
import { HINT_KINDS, HintComic, isHintKind, type HintKind } from "../components/living/hints";
import { Comic, type ComicKind } from "../components/living/Comic";
import { COMIC_KINDS, getComicPresentation, type ComicTone, type ComicMotion } from "../components/living/comic-presentation";
import { useCopy, type CopyKey } from "../ui/copy";

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
  return <section className="lr-tooltip-preview-card">
    <header>
      <code>{label ?? kind}</code>
      <span className="lr-tooltip-preview-actions">
        {text ? <Tooltip kind={kind} tone={tone} motion={motion} text={text} place="below">
          <button type="button" aria-label={`Text ${label ?? kind}`} className="lr-tooltip-preview-trigger">Aa</button>
        </Tooltip> : null}
        <Tooltip kind={kind} tone={tone} motion={motion} place="below">
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
  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-room lr-tooltip-preview">
        <header className="lr-tooltip-preview-head">
          <h1>{en ? "Piik · UI catalogue" : "Piik · UI 控件大全"}</h1>
          <p>{en ? "Actual components, sample data. Try mouse, keyboard and touch." : "正式组件，示例数据。鼠标、键盘、触屏都可以试。"}</p>
        </header>
        <nav className="cp-nav" aria-label={en ? "Preview sections" : "预览目录"}>
          <a href="#button-preview">{en ? "Buttons" : "按钮"}</a><a href="#option-preview">{en ? "Options" : "选择与开关"}</a>
          <a href="#input-preview">{en ? "Inputs" : "输入与房间号"}</a><a href="#feedback-preview">{en ? "Feedback" : "反馈"}</a>
          <a href="#people-preview">{en ? "People & connections" : "人物、沙发与连接图"}</a><a href="#source-preview">{en ? "Source picker" : "画面选择"}</a>
          <a href="#playback-preview">{en ? "Playback" : "播放栏"}</a><a href="#comic-preview">{en ? "Tooltips & comics" : "提示与漫画"}</a>
          <a href="#welcome-preview">{en ? "20 opening lines" : "20 句开场白"}</a>
          <a href="/__status-preview">{en ? "Status gallery" : "完整状态预览"}</a>
        </nav>
        <ControlsPreview />
        <WelcomeLine />
        <details id="welcome-preview" className="lr-welcome-catalog" open>
          <summary>20 句开场白 / 20 opening lines</summary>
          <p>{en ? "One line per visit to the App launcher or the browser's sharing screen. Pure visual mode uses matching pictograms and pixel lettering; switching modes keeps the same line." : "进入 App 启动页或网页版的分享准备画面时，随机选一句。纯视觉模式显示对应的图形与像素暗号；切换模式还是同一句。"}</p>
          <ol>{WELCOME_LINES.map(({ key }, index) => <li key={key}><span>{t(key)}</span><WelcomeCipher line={index} /></li>)}</ol>
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
