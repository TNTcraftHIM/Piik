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
  const label = `${t(labels[update.kind])} · ${update.version}`;
  return <div className="lr-client-release">
    <div className="lr-client-project-links">
      <Tooltip kind="update-available" text={major ? t("client.update.majorHint") : vis ? update.version : label}>
        <a className="lr-btn lr-client-update" href={update.url} target="_blank" rel="noopener noreferrer"
          aria-label={label} aria-describedby={major ? warningId : undefined}>
          <Glyph name={major ? "alert" : "arrowUp"} size={17} />
          <span className={vis ? "visually-hidden" : undefined}>{label}</span>
          {vis && <span aria-hidden="true">{update.version}</span>}
        </a>
      </Tooltip>
      <a href={update.releaseURL} target="_blank" rel="noopener noreferrer" aria-label={t("client.update.notes")}>
        {vis ? <Glyph name="window" size={17} /> : t("client.update.notes")}<span aria-hidden="true"> ↗</span>
      </a>
    </div>
    {major && <p id={warningId} className={vis ? "visually-hidden" : "lr-client-release-warning"}>
      {t("client.update.majorHint")}
    </p>}
  </div>;
}
