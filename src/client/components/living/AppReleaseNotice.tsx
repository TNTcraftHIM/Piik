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
  const { vis, t } = useCopy();
  const warningId = useId();
  const major = update.kind === "major-update";
  const label = `${t(labels[update.kind])} ${update.version}${update.extractAPK ? " (ZIP)" : ""}`;
  const updateHint = major ? t("client.update.majorHint") : vis ? update.version : label;
  const hint = update.extractAPK ? `${updateHint} ${t("client.update.extractAPK")}` : updateHint;
  return <div className="lr-client-release">
    <Tooltip kind="update-available" text={hint}>
      <a className="lr-btn lr-client-update" href={update.url} target="_blank" rel="noopener noreferrer"
        aria-label={label} aria-describedby={major ? warningId : undefined}>
        <Glyph name={major ? "alert" : "arrowUp"} size={17} />
        <span className={vis ? "visually-hidden" : undefined}>{label}</span>
        {vis && <span aria-hidden="true">{update.version}</span>}
      </a>
    </Tooltip>
    <a className="lr-client-release-mirror" href="https://gitee.com/TNTcraftHIM/Piik/releases"
      target="_blank" rel="noopener noreferrer" aria-label={t("client.update.downloads")}>
      {vis ? <>Gitee <Glyph name="arrowDown" size={14} /></> : t("client.update.downloads")}
      <span aria-hidden="true"> ↗</span>
    </a>
    {major && <a id={warningId} className="lr-client-release-warning" href={update.releaseURL}
      target="_blank" rel="noopener noreferrer" aria-label={t("client.update.majorHint")}>
      {vis ? <Glyph name="alert" size={17} /> : t("client.update.majorHint")}<span aria-hidden="true"> ↗</span>
    </a>}
  </div>;
}
