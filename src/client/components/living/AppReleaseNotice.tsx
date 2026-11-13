import { useId, useMemo, useState } from "react";
import type { ReleaseUpdateNotice } from "../../lib/release-update";
import { renderReleaseNotes } from "../../lib/release-notes";
import { ChannelSettingsDialog } from "../../channel/components/ChannelSettingsDialog";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { Btn } from "./primitives";
import { LoadingStatus } from "./WaitingStatus";
import type { AppUpdateAction, AppUpdateView } from "../../lib/use-app-update";

export interface AppUpdateControls {
  view: AppUpdateView;
  busy: boolean;
  error: boolean;
  act(command: AppUpdateAction): void;
}

const labels: Record<ReleaseUpdateNotice["kind"], CopyKey> = {
  "update-available": "client.update.available",
  "major-update": "client.update.major",
  "different-build": "client.update.differentBuild",
  "official-release": "client.update.official",
};

export function AppReleaseNotice({ update, native, managementURL }: {
  update: ReleaseUpdateNotice; native?: AppUpdateControls; managementURL?: string;
}) {
  const { lang, vis, t } = useCopy();
  const warningId = useId();
  const [viewedRelease, setViewedRelease] = useState<ReleaseUpdateNotice | null>(null);
  const major = update.kind === "major-update";
  const headline = update.headline?.[lang === "zh" ? "zh-CN" : "en"];
  const label = `${t(labels[update.kind])} ${update.version}`;
  const caption = major || update.kind === "update-available" ? t("client.update.download", { version: update.version }) : label;
  const automatic = native && native.view.state !== "unavailable";
  const active = automatic && native.view.operationId && native.view.state !== "idle";
  const canDownload = automatic && !active && update.revision && (update.kind === "update-available" || major);
  return <><div className="lr-client-release">
    {major && <button id={warningId} className="lr-client-release-warning" type="button"
      onClick={() => setViewedRelease(update)} aria-haspopup="dialog" aria-label={t("client.update.majorHint")}>
      {vis ? <Glyph name="alert" size={17} /> : t("client.update.majorHint")}
    </button>}
    {headline && !vis && <div className="lr-client-release-headline">
      <strong>{headline.title}</strong>
      {headline.description && <p>{headline.description}</p>}
    </div>}
    <div className="lr-client-release-actions">
      <Btn icon="book" title="client.update.notes" cap="client.update.notes" size="compact" quiet textTooltip
        onClick={() => setViewedRelease(update)} />
      {canDownload ? <Btn icon="arrowDown" title={{ text: caption }} cap={{ text: caption }}
        busy={native.busy} disabled={native.busy} tone="primary"
        onClick={() => native.act({ action: "download", version: update.version, revision: update.revision! })} />
        : managementURL ? <a className="lr-btn" href={managementURL} target="_blank" rel="noopener noreferrer" aria-label={t("client.update.manage")}>
          <Glyph name="window" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("client.update.manage")}</span>
        </a>
        : !active && <Tooltip kind="update-available" text={major ? t("client.update.majorHint") : vis ? update.version : label}>
        <a className="lr-btn lr-client-update" href={update.url} target="_blank" rel="noopener noreferrer"
          aria-label={label} aria-describedby={major ? warningId : undefined}>
          <Glyph name={major ? "alert" : "arrowUp"} size={17} />
          <span className={vis ? "visually-hidden" : undefined}>{caption}</span>
          {vis && <span aria-hidden="true">{update.version}</span>}
        </a>
      </Tooltip>}
    </div>
    {native && <AppUpdateStatus {...native} />}
    {native?.view.state === "unavailable" && <p className={vis ? "visually-hidden" : "lr-app-update-manual"}>{t("client.update.manualHint")}</p>}
    <a className="lr-client-release-mirror" href="https://atomgit.com/TNTcraftHIM/Piik/releases"
      target="_blank" rel="noopener noreferrer" aria-label={t("client.update.downloads")}>
      {vis ? <>AtomGit <Glyph name="arrowDown" size={14} /></> : t("client.update.downloads")}
      <span aria-hidden="true"> ↗</span>
    </a>
  </div>
    {viewedRelease && <AppReleaseNotes update={viewedRelease} onClose={() => setViewedRelease(null)} />}
  </>;
}

export function AppUpdateStatus({ view, busy, error, act }: AppUpdateControls) {
  const { t, vis } = useCopy();
  const active = view.operationId && view.state !== "idle" && view.state !== "unavailable";
  const downloading = view.state === "downloading";
  const ready = view.state === "ready";
  const failed = view.state === "failed";
  const status = downloading ? "client.update.downloading" : ready ? "client.update.ready"
    : view.state === "installing" ? "client.update.installing" : "client.update.failed";
  const received = view.receivedBytes ?? 0;
  return <div className="lr-app-update-status">
    {active && <>
      {(downloading || view.state === "installing") ? <LoadingStatus label={status} />
        : <p role="status"><Glyph name={failed ? "alert" : "check"} size={18} /> <span className={vis ? "visually-hidden" : undefined}>{t(status)}</span></p>}
      <strong>{view.version}</strong>
      {downloading && <>
        <progress aria-label={t(status)} max={view.totalBytes} value={view.totalBytes ? Math.min(received, view.totalBytes) : undefined} />
        <span className="lr-app-update-bytes">{(received / 1048576).toFixed(1)}{view.totalBytes ? ` / ${(view.totalBytes / 1048576).toFixed(1)}` : ""} MiB</span>
      </>}
      {ready && <p className={vis ? "visually-hidden" : undefined}>{t("client.update.restartHint")}</p>}
      {downloading && <p className={vis ? "visually-hidden" : undefined}>{t("client.update.continueHint")}</p>}
      <div className="lr-client-release-actions">
        {ready && <Btn icon="refresh" title="client.update.install" cap="client.update.install" tone="primary" busy={busy} disabled={busy}
          hint="warning" hintText="client.update.restartHint"
          onClick={() => act({ action: "install", operationId: view.operationId! })} />}
        {(downloading || ready || failed) && <Btn icon="x" title={failed ? "common.close" : "common.cancel"} cap={failed ? "common.close" : "common.cancel"}
          disabled={busy} onClick={() => act({ action: "cancel", operationId: view.operationId! })} />}
      </div>
    </>}
    {error && <p role="alert">{t("client.update.commandFailed")}</p>}
  </div>;
}

function AppReleaseNotes({ update, onClose }: { update: ReleaseUpdateNotice; onClose(): void }) {
  const { t } = useCopy();
  const html = useMemo(() => renderReleaseNotes(update.body ?? ""), [update.body]);
  return <ChannelSettingsDialog title={t("client.update.notes")} caption={`Piik ${update.version}`}
    dismissOnBackdrop onClose={onClose}>
    <div className="c3-settings-panels">
      {html ? <article className="lr-release-notes" dangerouslySetInnerHTML={{ __html: html }} />
        : <p>{t("client.update.notesEmpty")}</p>}
      <p className="lr-release-original"><a href={update.releaseURL} target="_blank" rel="noopener noreferrer">
        {t("client.update.releasePage")}<span aria-hidden="true"> ↗</span>
      </a></p>
    </div>
  </ChannelSettingsDialog>;
}
