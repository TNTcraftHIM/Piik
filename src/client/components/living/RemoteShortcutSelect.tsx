import { useId } from "react";
import { REMOTE_SHORTCUT_KEYS } from "../../remote-control/protocol";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";

export function RemoteShortcutSelect({ value, onChange, host = false, mac = false, disabled }: {
  value: number; onChange: (value: number) => void; host?: boolean; mac?: boolean; disabled?: boolean;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const label = t(host ? "remote.hostStopKey" : "remote.releaseKey");
  return <div className="lr-capture-device lr-remote-shortcut">
    <Tooltip kind="hint-remote-stop" text={vis ? undefined : t(host ? "remote.hostStopKeyHelp" : "remote.releaseKeyHelp")}>
      <label htmlFor={id}><Glyph name="keyboard" size={16} />{vis ? null : label}</label>
    </Tooltip>
    <div className="lr-capture-device-controls">
      <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
        {REMOTE_SHORTCUT_KEYS.map(key => <option key={key} value={key}>Ctrl + {mac ? "Option" : "Alt"} + F{key}</option>)}
      </select>
    </div>
  </div>;
}
