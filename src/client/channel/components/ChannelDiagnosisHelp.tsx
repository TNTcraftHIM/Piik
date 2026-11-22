import { Glyph } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { diagnosisGuide, type ChannelDiagnosis } from "../diagnosis";
import "./channel-diagnosis-help.css";

export function ChannelDiagnosisHelp({ diagnosis, details }: {
  diagnosis: ChannelDiagnosis;
  details?: readonly CopyKey[];
}) {
  const { lang, t } = useCopy();
  const guide = diagnosisGuide(diagnosis.topic, lang);
  return <div className="c3-diagnosis-help">
    <a href={guide.fallback} target="_blank" rel="noopener noreferrer">
      <Glyph name="book" size={16} />{t("diagnosis.guide")}
    </a>
    {!!details?.length && <details>
      <summary>{t("diagnosis.details")}</summary>
      <ul>{details.map(key => <li key={key}>{t(key)}</li>)}</ul>
    </details>}
  </div>;
}
