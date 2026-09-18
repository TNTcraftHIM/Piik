import { useId, useState } from "react";
import { Btn } from "./primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

export function HostMicrophone({ enabled, pending, disabled, nativeCapture, volume, onVolume, onToggle }: {
  enabled: boolean; pending?: boolean; disabled?: boolean;
  volume: number; onVolume: (volume: number) => void;
  nativeCapture?: boolean; onToggle: () => void;
}) {
  const { t, vis } = useCopy();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const percent = Math.round(volume * 100);
  return <div className="lr-host-microphone">
    <div className="lr-host-microphone-actions">
    <Btn icon={enabled ? "microphone" : "microphoneOff"}
      cap="host.microphone.label"
      title={nativeCapture ? "host.microphone.browserOnly" : pending ? "host.microphone.pending"
        : enabled ? "host.microphone.mute" : "host.microphone.enable"}
      hint={enabled ? "hint-microphone-off" : "hint-microphone-on"}
      pressed={enabled} busy={pending} tone={enabled ? "on" : undefined}
      disabled={nativeCapture || pending || disabled} onClick={onToggle} />
    <Btn icon="sliders" title="host.microphone.settings" expanded={expanded} controls={id}
      tone={expanded ? "on" : undefined} disabled={nativeCapture}
      onClick={() => setExpanded(value => !value)} />
    </div>
    {expanded && <label id={id} className="lr-host-microphone-volume">
      <span>{vis ? <Glyph name="microphone" size={18} /> : t("host.microphone.volume")}</span>
      <input type="range" min={0} max={200} step={1} value={percent}
        aria-label={t("host.microphone.volume")} aria-valuetext={`${percent}%`}
        onChange={event => onVolume(Number(event.target.value) / 100)} />
      <output>{percent}%</output>
    </label>}
  </div>;
}
