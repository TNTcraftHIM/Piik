import { PawnSvg } from "../components/living/Pawn";
import { useState } from "react";
import { AppHeader, LedStrip } from "../components/living/Header";
import { StageOverlay, StageTv } from "../components/living/Stage";
import { Couch } from "../components/living/Couch";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { Pill } from "../components/living/primitives";
import { deriveViewerPresentation } from "../media/viewer-presentation";
import {
  deriveHostStatus, deriveParticipantStatus, deriveViewerStatus, STATUS_CATALOG,
  type StatusDescriptor,
} from "../ui/media-status";
import { Glyph } from "../ui/icons";
import { useCopy } from "../ui/copy";
import { composeDocumentTitle, useDocumentTitle } from "../ui/document-title";
import { HOST_STATUS_SCENARIOS, STATUS_SCENARIOS } from "./status-preview-scenarios";
import "./status-preview.css";

function StatusMark({ status }: { status: StatusDescriptor }) {
  const { t, vis } = useCopy();
  return (
    <span className="sp-status">
      <StatusIndicator status={status} />
      {vis ? null : <span>{t(status.labelKey)}</span>}
    </span>
  );
}

export function StatusPreviewPage() {
  const { t, titleFrames } = useCopy();
  const [selected, setSelected] = useState("playing");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [couchView, setCouchView] = useState<"host" | "viewer">("viewer");
  const scenario = STATUS_SCENARIOS.find((item) => item.id === selected)!;
  const presentation = deriveViewerPresentation(scenario.state);
  const status = deriveViewerStatus(presentation, scenario.state.signal,
    scenario.state.route?.kind === "none" ? null : scenario.state.route?.kind);
  const sourceActive = scenario.state.host === "online" || scenario.state.host === "paused";
  const readyParticipant = deriveParticipantStatus({
    mediaReady: sourceActive, upstream: { kind: "peer", peerId: "preview-host" },
  }, sourceActive);
  const waitingParticipant = deriveParticipantStatus({ upstream: { kind: "none" } }, sourceActive);
  const frame = titleFrames(status.titleFrameKey)[0];
  const titleParts = ["6020", [frame, status.titleMarker].filter(Boolean).join(" ")];
  useDocumentTitle(titleParts);

  function choose(id: string) {
    setSelected(id);
  }

  return (
    <div className="lr-app sp-page" data-comic-reduced-motion={reducedMotion || undefined}>
      <AppHeader homeHref="/__status-preview" />
      <main className="sp-main">
        <header className="sp-heading">
          <div><p className="sp-kicker">Piik · 状态语义</p><h1>同一事实，各有分寸。</h1>
            <p>标题说正在做什么，顶部说明信令，电视下沿图标说明画面；悬停查看图示与文字说明。</p></div>
          <label className="sp-motion"><input type="checkbox" checked={reducedMotion}
            onChange={(event) => setReducedMotion(event.target.checked)} />减少动态效果</label>
        </header>
        <div className="sp-workbench">
          <label className="sp-mobile-scenario">预览场景
            <select value={selected} onChange={(event) => choose(event.target.value)}>
              {STATUS_SCENARIOS.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
          </label>
          <nav className="sp-scenarios" aria-label="选择状态场景">
            {STATUS_SCENARIOS.map((item) => <button key={item.id} type="button"
              aria-pressed={selected === item.id} onClick={() => choose(item.id)}>
              <span>{item.name}</span><Glyph name="arrowRight" size={14} />
            </button>)}
          </nav>
          <section className="sp-stage-panel" aria-label="真实组件组合预览">
            <div className="sp-browser-title"><Glyph name="tv" size={15} />
              <span>{composeDocumentTitle(...titleParts)}</span><span aria-hidden="true">×</span>
            </div>
            <div className="sp-stage-toolbar">
              <span className="sp-room-id">6020</span>
              <span className="sp-connection"><LedStrip state={status.connection.tone}
                label={t(status.connection.labelKey)} comic={status.connection.comic} /></span>
            </div>
            <StageTv label={t(status.television.labelKey)}
              indicator={<StatusIndicator status={status.television} />}>
              <div className={`sp-video${presentation.hasRetainedFrame ? " is-retained" : ""}`} aria-hidden="true">
                {presentation.hasCurrentFrame || presentation.hasRetainedFrame ? <>
                  <span className="sp-moon" /><span className="sp-hill" /><span className="sp-platform" />
                  <span className="sp-player"><PawnSvg color="var(--you)" /></span>
                  <span className="sp-score">✦ 08</span>
                </> : null}
              </div>
              {status.overlay ? <StageOverlay icon={status.overlay.status.icon}
                comic={status.overlay.status.comic} message={t(status.overlay.status.labelKey)}
                tone={status.overlay.status.tone}
                spin={status.overlay.status.pulse} dim={status.overlay.mode === "blocking"}
                transition={status.overlay.status.pulse}
                onActivate={presentation.stage === "needs-play" ? () => choose("playing") : undefined} /> : null}
            </StageTv>
            <div className="lr-stage-notices" role="status" aria-live="polite">
              {status.notice ? <Pill icon={status.notice.icon} label={t(status.notice.labelKey)}
                comic={(status.notice.tooltip ?? status.notice.comic)!} tone={status.notice.tone} /> : null}
            </div>
            <div className="sp-couch-preview">
              <div className="sp-couch-view" role="group" aria-label="沙发观察视角">
                <span>沙发观察视角</span>
                {(["host", "viewer"] as const).map((view) => <button type="button" className="lr-btn"
                  key={view} aria-pressed={couchView === view} onClick={() => setCouchView(view)}>
                  {view === "host" ? "Host" : "Viewer"}
                </button>)}
              </div>
              <Couch view={couchView}
                host={{ key: "preview-host", name: "Host", you: couchView === "host" }}
                entries={[
                  { key: "preview-you", name: "You", status: readyParticipant, you: couchView === "viewer", selectable: false },
                  { key: "preview-friend", name: "Friend", selectable: false,
                    status: couchView === "host" && sourceActive ? STATUS_CATALOG.stuttering : readyParticipant },
                  { key: "preview-waiting", name: "Joining", status: waitingParticipant, selectable: false },
                ]} />
            </div>
            <p className="sp-caption">沙发固定演示已接通、卡顿、等待三种事实；Host 可见卡顿证据，Viewer 只提示等待。并非现场测量。</p>
          </section>
        </div>
        <section className="sp-explanation">
          <div><h2>{scenario.name}</h2><p>{scenario.note}</p>
            <p className="sp-caption">舞台状态：<code>{presentation.stage}</code> · 画面层：<code>{status.overlay?.mode ?? "none"}</code></p>
          </div>
        </section>
        <section className="sp-surfaces" aria-label="各显示位置的含义">
          {([
            ["能否联系服务器", "顶部 · 信令连接", status.connection],
            ["正在播放什么状态", "电视 · 画面状态", status.television],
          ] as const).map(([name, location, item]) => <article key={name}>
            <p className="sp-kicker">{location}</p><h3>{name}</h3><StatusMark status={item} />
            <p className="sp-caption">{t(item.labelKey)}</p>
          </article>)}
          <article><p className="sp-kicker">人物 · 身份与在场</p><h3>各自需要知道的状态</h3>
            <p className="sp-caption">Host 用人物灯查看已有的逐人证据；Viewer 不显示别人的灯，只让尚未接通画面的人物呼吸。</p></article>
          <article><p className="sp-kicker">拓扑 / Host 观众列表</p><h3>按需看线路与数据</h3>
            <p className="sp-caption">沿用服务端已确认的媒体路径和有新鲜度的质量样本，不扩大全房广播。</p></article>
        </section>
        <section className="sp-catalog">
          <header><h2>房主：源状态与控制连接</h2>
            <p>本地预览代表正在分享的源；某个观众的弱网不改变房主的源状态。</p></header>
          <div className="sp-host-grid">
            {HOST_STATUS_SCENARIOS.map(({ name, facts }) => {
              const host = deriveHostStatus(facts);
              const hostTitle = [titleFrames(host.titleFrameKey)[0], host.titleMarker].filter(Boolean).join(" ");
              return <article key={name}>
                <h3>{name}</h3><p className="sp-host-title">{composeDocumentTitle("6020", hostTitle)}</p>
                <div><span>画面</span><StatusMark status={host.television} /></div>
                <div><span>信令</span><StatusMark status={host.connection} /></div>
              </article>;
            })}
          </div>
        </section>
        <section className="sp-catalog">
          <header><h2>图标状态词典</h2><p>一个图标表达一件事。悬停、键盘聚焦或点击查看对应图解；再次点击或点外部关闭。</p></header>
          <div className="sp-catalog-grid">
            {Object.entries(STATUS_CATALOG).map(([key, item]) => <article key={key}>
              <StatusIndicator status={item} /><span>{t(item.labelKey)}</span><code>{key}</code>
            </article>)}
          </div>
        </section>
        <footer className="sp-footnote">
          <p>这是开发预览：说明固定中文，控件和漫画跟随右上角中 / EN / ✦ 与明暗主题。</p>
          <p>Host 人物灯使用已有的新鲜证据，详情仍在观众列表。Viewer 仅使用服务端已确认的媒体就绪事实，不新增全房质量广播。</p>
          <a href="/__tooltip-preview">全部操作漫画与指标</a>
        </footer>
      </main>
    </div>
  );
}
