import { AppHeader } from "../components/living/Header";
import { Tooltip } from "../components/living/Tooltip";
import { Btn, SwitchItem } from "../components/living/primitives";
import { HINT_KINDS, HintComic, isHintKind, type HintKind } from "../components/living/hints";
import { Comic, type ComicKind } from "../components/living/Comic";
import { COMIC_KINDS, getComicPresentation, type ComicTone, type ComicMotion } from "../components/living/comic-presentation";
import { useCopy, type CopyKey } from "../ui/copy";

const EXAMPLES: { label: string; kind: HintKind | ComicKind; tone: ComicTone; motion: ComicMotion; text: CopyKey }[] = [
  { label: "说明 / Neutral", kind: "hint-volume", tone: "off", motion: "demo", text: "playback.volume" },
  { label: "成功 / Success", kind: "hint-copy-code", tone: "live", motion: "still", text: "common.copied" },
  { label: "受限 / Limited", kind: "hint-nat-unavailable", tone: "warn", motion: "still", text: "host.advanced.route.natPredictionUnavailable" },
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
  const { vis, t } = useCopy();
  return (
    <div className="lr-app">
      <AppHeader />
      <main className="lr-room lr-tooltip-preview">
        <header className="lr-tooltip-preview-head">
          <h1>Tooltip preview</h1>
          <p>{vis ? "统一语义 · 操作与状态漫画" : "Shared grammar · control and status comics"}</p>
        </header>
        <div className="lr-row-group" style={{ flexWrap: "wrap", marginBottom: 24 }}>
          <Btn icon="gauge" title="host.details" cap="host.details" hint="hint-details" />
          <Btn icon="refresh" title="viewer.reconnect" cap="viewer.reconnect" hint="hint-reconnect" disabled />
          <SwitchItem checked disabled locked onChange={() => undefined}
            label={t("host.advanced.route.peerOnly")}
            note={t("host.advanced.route.peerOnlyRequired")}
            hint="hint-route-p2p-required" />
        </div>
        <h2>语义规则 / Semantic grammar</h2>
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
