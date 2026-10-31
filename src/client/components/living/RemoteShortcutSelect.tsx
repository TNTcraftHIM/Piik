import { useId } from "react";
import { REMOTE_SHORTCUT_KEYS } from "../../remote-control/protocol";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";

export function RemoteShortcutSelect({ value, onChange, host = false, mac = false, disabled, actualLabel }: {
  value: number; onChange: (value: number) => void; host?: boolean; mac?: boolean; disabled?: boolean;
  actualLabel?: string | null;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const label = t(actualLabel !== undefined ? "remote.preferredStopKey" : host ? "remote.hostStopKey" : "remote.releaseKey");
  return <><div className="lr-capture-device lr-remote-shortcut">
    <Tooltip kind="hint-remote-stop" text={vis ? undefined : t(actualLabel !== undefined ? "remote.preferredStopKeyHelp" : host ? "remote.hostStopKeyHelp" : "remote.releaseKeyHelp")}>
      <label htmlFor={id}><Glyph name="keyboard" size={16} />{vis ? null : label}</label>
    </Tooltip>
    <div className="lr-capture-device-controls">
      <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
        {REMOTE_SHORTCUT_KEYS.map(key => <option key={key} value={key}>Ctrl + {mac ? "Option" : "Alt"} + F{key}</option>)}
      </select>
    </div>
  </div>
    {actualLabel !== undefined && <p className="lr-remote-note lr-remote-shortcut-actual" aria-live="polite">
      <Glyph name="keyboard" size={14} /> <span className={vis ? "visually-hidden" : undefined}>{t("remote.hostStopKey")}</span>{" "}
      {actualLabel ? <kbd>{actualLabel}</kbd> : <span>{t("remote.shortcutUnbound")}</span>}
    </p>}
  </>;
}
