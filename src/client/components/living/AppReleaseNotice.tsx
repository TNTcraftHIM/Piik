import { useId, useMemo, useState } from "react";
import type { ReleaseUpdateNotice } from "../../lib/release-update";
import { renderReleaseNotes } from "../../lib/release-notes";
import { ChannelSettingsDialog } from "../../channel/components/ChannelSettingsDialog";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { Btn } from "./primitives";

const labels: Record<ReleaseUpdateNotice["kind"], CopyKey> = {
  "update-available": "client.update.available",
  "major-update": "client.update.major",
  "different-build": "client.update.differentBuild",
  "official-release": "client.update.official",
};

export function AppReleaseNotice({ update }: { update: ReleaseUpdateNotice }) {
  const { lang, vis, t } = useCopy();
  const warningId = useId();
  const [viewedRelease, setViewedRelease] = useState<ReleaseUpdateNotice | null>(null);
  const major = update.kind === "major-update";
  const headline = update.headline?.[lang === "zh" ? "zh-CN" : "en"];
  const label = `${t(labels[update.kind])} ${update.version}`;
  const caption = major || update.kind === "update-available" ? t("client.update.download", { version: update.version }) : label;
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
      <Tooltip kind="update-available" text={major ? t("client.update.majorHint") : vis ? update.version : label}>
        <a className="lr-btn lr-client-update" href={update.url} target="_blank" rel="noopener noreferrer"
          aria-label={label} aria-describedby={major ? warningId : undefined}>
          <Glyph name={major ? "alert" : "arrowUp"} size={17} />
          <span className={vis ? "visually-hidden" : undefined}>{caption}</span>
          {vis && <span aria-hidden="true">{update.version}</span>}
        </a>
      </Tooltip>
    </div>
    <a className="lr-client-release-mirror" href="https://atomgit.com/TNTcraftHIM/Piik/releases"
      target="_blank" rel="noopener noreferrer" aria-label={t("client.update.downloads")}>
      {vis ? <>AtomGit <Glyph name="arrowDown" size={14} /></> : t("client.update.downloads")}
      <span aria-hidden="true"> ↗</span>
    </a>
  </div>
    {viewedRelease && <AppReleaseNotes update={viewedRelease} onClose={() => setViewedRelease(null)} />}
  </>;
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
