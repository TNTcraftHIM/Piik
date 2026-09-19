import { useId, useRef, useState } from "react";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

export function HostMicrophone({ enabled, pending, disabled, paused, unavailable, volume, onVolume, onToggle }: {
  enabled: boolean; pending?: boolean; disabled?: boolean;
  paused?: boolean;
  volume: number; onVolume: (volume: number) => void;
  unavailable?: boolean; onToggle: () => void;
}) {
  const { t, vis } = useCopy();
  const actionsRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const percent = Math.round(volume * 100);
  return <div className="lr-host-microphone">
    <div className="lr-host-microphone-actions" ref={actionsRef}>
    <Btn icon={enabled ? "microphone" : "microphoneOff"}
      cap="host.microphone.label"
      title={unavailable ? "host.microphone.browserOnly" : pending ? "host.microphone.pending"
        : paused ? "host.microphone.paused" : disabled ? "host.microphone.busy"
        : enabled && volume === 0 ? "host.microphone.zeroVolume"
        : enabled ? "host.microphone.mute" : "host.microphone.enable"}
      hint={paused ? "host-paused" : enabled ? "hint-microphone-off" : "hint-microphone-on"}
      pressed={enabled} busy={pending} tone={enabled ? "on" : undefined}
      disabled={unavailable || pending || disabled || paused} onClick={onToggle} />
    <Btn icon="chevron" title={unavailable ? "host.microphone.browserOnly" : "host.microphone.settings"}
      hint="hint-microphone-volume" expanded={expanded && !unavailable} controls={id}
      disabled={unavailable} onClick={() => setExpanded(!expanded)} />
    </div>
    <div id={id} hidden={!expanded || unavailable} role="group" aria-label={t("host.microphone.volume")}
      className="lr-host-microphone-volume"
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setExpanded(false);
        actionsRef.current?.querySelector<HTMLButtonElement>("[aria-controls]")?.focus();
      }}>
      <label htmlFor={`${id}-level`}>
        <span>{vis ? <Glyph name="microphone" size={18} /> : t("host.microphone.volume")}</span>
        <output htmlFor={`${id}-level`}>{percent}%</output>
      </label>
      {expanded && !unavailable && <Tooltip kind="hint-microphone-volume" text={vis ? undefined : t("host.microphone.settings")}>
        <input id={`${id}-level`} type="range" min={0} max={200} step={1} value={percent}
          aria-label={t("host.microphone.volume")} aria-valuetext={`${percent}%`}
          onChange={event => onVolume(Number(event.target.value) / 100)} />
      </Tooltip>}
    </div>
  </div>;
}
