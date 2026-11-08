import { useId } from "react";
import type { ReleaseUpdateNotice } from "../../lib/release-update";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";

const labels: Record<ReleaseUpdateNotice["kind"], CopyKey> = {
  "update-available": "client.update.available",
  "major-update": "client.update.major",
  "different-build": "client.update.differentBuild",
  "official-release": "client.update.official",
};

export function AppReleaseNotice({ update }: { update: ReleaseUpdateNotice }) {
  const { lang, vis, t } = useCopy();
  const warningId = useId();
  const major = update.kind === "major-update";
  const headline = update.headline?.[lang === "zh" ? "zh-CN" : "en"];
  const label = `${t(labels[update.kind])} ${update.version}`;
  const caption = major || update.kind === "update-available" ? t("client.update.download", { version: update.version }) : label;
  return <div className="lr-client-release">
    {major && <a id={warningId} className="lr-client-release-warning" href={update.releaseURL}
      target="_blank" rel="noopener noreferrer" aria-label={t("client.update.majorHint")}>
      {vis ? <Glyph name="alert" size={17} /> : t("client.update.majorHint")}<span aria-hidden="true"> ↗</span>
    </a>}
    {headline && !vis && <div className="lr-client-release-headline">
      <strong>{headline.title}</strong>
      {headline.description && <p>{headline.description}</p>}
    </div>}
    <Tooltip kind="update-available" text={major ? t("client.update.majorHint") : vis ? update.version : label}>
      <a className="lr-btn lr-client-update" href={update.url} target="_blank" rel="noopener noreferrer"
        aria-label={label} aria-describedby={major ? warningId : undefined}>
        <Glyph name={major ? "alert" : "arrowUp"} size={17} />
        <span className={vis ? "visually-hidden" : undefined}>{caption}</span>
        {vis && <span aria-hidden="true">{update.version}</span>}
      </a>
    </Tooltip>
    <a className="lr-client-release-mirror" href="https://atomgit.com/TNTcraftHIM/Piik/releases"
      target="_blank" rel="noopener noreferrer" aria-label={t("client.update.downloads")}>
      {vis ? <>AtomGit <Glyph name="arrowDown" size={14} /></> : t("client.update.downloads")}
      <span aria-hidden="true"> ↗</span>
    </a>
  </div>;
}
