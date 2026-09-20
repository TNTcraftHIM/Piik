import { useId } from "react";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { CaptureDevice } from "../../media/capture-devices";
import { MicrophoneDeviceSelect } from "./MicrophoneDeviceSelect";

export function HostMicrophone({ enabled, pending, disabled, paused, unavailable, volume, onToggle }: {
  enabled: boolean; pending?: boolean; disabled?: boolean;
  paused?: boolean;
  volume: number;
  unavailable?: boolean; onToggle: () => void;
}) {
  return <Btn icon={enabled ? "microphone" : "microphoneOff"}
      cap="host.microphone.label"
      title={unavailable ? "host.microphone.browserOnly" : pending ? "host.microphone.pending"
        : paused ? "host.microphone.paused" : disabled ? "host.microphone.busy"
        : enabled && volume === 0 ? "host.microphone.zeroVolume"
        : enabled ? "host.microphone.mute" : "host.microphone.enable"}
      hint={unavailable ? "hint-capture-browser" : paused ? "host-paused" : enabled ? "hint-microphone-off" : "hint-microphone-on"}
      hintTone={unavailable ? "warn" : pending || disabled ? "busy" : undefined}
      hintMotion={pending || disabled ? "progress" : undefined}
      pressed={enabled} busy={pending}
      disabled={unavailable || pending || disabled || paused} onClick={onToggle} />;
}

export function HostMicrophoneSettings({ enabled, disabled, volume, onVolume, deviceId, onDevice, loadDevices, native }: {
  enabled: boolean; disabled?: boolean; native?: boolean;
  volume: number; onVolume: (volume: number) => void;
  deviceId: string; onDevice: (id: string) => void; loadDevices: () => Promise<CaptureDevice[]>;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const percent = Math.round(volume * 100);
  return <div className="lr-door-group lr-microphone-settings" role="group" aria-label={t("host.microphone.settings")}>
      <MicrophoneDeviceSelect value={deviceId} load={loadDevices}
        onChange={onDevice} disabled={disabled} revision={enabled} browser={!native} />
      <label htmlFor={id}>
        <span>{vis ? <Glyph name="microphone" size={18} /> : t("host.microphone.volume")}</span>
        <output htmlFor={id}>{percent}%</output>
      </label>
      <Tooltip kind="hint-microphone-volume" text={vis ? undefined : t("host.microphone.settings")}>
        <input id={id} type="range" min={0} max={200} step={1} value={percent} disabled={disabled}
          aria-label={t("host.microphone.volume")} aria-valuetext={`${percent}%`}
          onChange={event => onVolume(Number(event.target.value) / 100)} />
      </Tooltip>
  </div>;
}
