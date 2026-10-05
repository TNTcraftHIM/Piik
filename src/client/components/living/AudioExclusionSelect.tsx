import { useEffect, useId, useState } from "react";
import type { NativeCaptureTarget } from "../../native/wire";
import { audioApplicationKey, audioApplications } from "../../native/capture-selection";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";

export function AudioExclusionSelect({ sources, value, onChange, disabled, busy, failed, onRefresh, showLabel = true }: {
  sources: NativeCaptureTarget[]; value?: NativeCaptureTarget;
  onChange: (target: NativeCaptureTarget | undefined) => void;
  disabled?: boolean; busy?: boolean; failed?: boolean; onRefresh?: () => void; showLabel?: boolean;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const applications = audioApplications(sources);
  const key = value ? audioApplicationKey(value) : "";
  const missing = !!value && !applications.some(target => audioApplicationKey(target) === key);
  return <div className="lr-capture-device lr-audio-exclusion-select">
    {showLabel && <Tooltip kind="hint-exclude-audio" text={vis ? undefined : t("host.sourcePicker.excludeAudioHint")}>
      <label htmlFor={id}>
        <Glyph name="speakerOff" size={16} />
        {vis ? null : t("host.sourcePicker.excludeAudio")}
      </label>
    </Tooltip>}
    <div className="lr-capture-device-controls">
      <select id={id} value={key} disabled={disabled || busy}
        aria-label={t("host.sourcePicker.excludeAudio")} aria-describedby={`${id}-hint`}
        onChange={event => onChange(applications.find(target => audioApplicationKey(target) === event.target.value))}>
        <option value="">{t("host.sourcePicker.excludeNone")}</option>
        {missing && <option value={key} disabled>{value.title} · {t("host.sourcePicker.excludeMissing")}</option>}
        {applications.map(target => <option key={audioApplicationKey(target)} value={audioApplicationKey(target)}>{target.title}</option>)}
      </select>
      {onRefresh && <button type="button" className="lr-btn lr-device-refresh" disabled={disabled || busy}
        aria-label={t("host.sourcePicker.refreshApplications")} onClick={onRefresh}>
        <Glyph name="refresh" size={16} className={busy ? "lr-spin" : undefined} />
      </button>}
    </div>
    <small id={`${id}-hint`} role={failed ? "status" : undefined} className={vis ? "visually-hidden" : undefined}>
      {t(failed ? "host.sourcePicker.excludeListFailed" : value ? "host.sourcePicker.excludeAudioLifetime" : "host.sourcePicker.excludeAudioChoose")}
    </small>
  </div>;
}

// Reuse native source enumeration. The Host owns applying the selected audio input.
export function LiveAudioExclusion({ load, ...selection }: {
  load: () => Promise<NativeCaptureTarget[]>;
  value?: NativeCaptureTarget; onChange: (target: NativeCaptureTarget | undefined) => void; disabled?: boolean;
}) {
  const [sources, setSources] = useState<NativeCaptureTarget[]>([]);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setBusy(true);
    void load().then(sources => {
      if (current) { setSources(sources); setFailed(false); }
    }, () => { if (current) setFailed(true); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [load, revision]);
  return <AudioExclusionSelect {...selection} sources={sources} busy={busy} failed={failed}
    onRefresh={() => setRevision(value => value + 1)} />;
}
