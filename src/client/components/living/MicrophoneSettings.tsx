import { useId, type CSSProperties } from "react";
import { SwitchItem } from "./primitives";
import { Tooltip } from "./Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { CaptureDevice } from "../../media/capture-devices";
import { MicrophoneDeviceSelect } from "./MicrophoneDeviceSelect";

export function MicrophoneSettings({ enabled, disabled, volume, onVolume, deviceId, onDevice, loadDevices, voiceProcessing, onVoiceProcessing, host }: {
  enabled: boolean; disabled?: boolean; host: boolean;
  volume: number; onVolume: (volume: number) => void;
  deviceId: string; onDevice: (id: string) => void; loadDevices: () => Promise<CaptureDevice[]>;
  voiceProcessing: boolean; onVoiceProcessing: (enabled: boolean) => void;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const percent = Math.round(volume * 100);
  return <div className="lr-door-group lr-microphone-settings" role="group" aria-label={t("host.microphone.settings")}>
      <MicrophoneDeviceSelect value={deviceId} load={loadDevices}
        onChange={onDevice} disabled={disabled} revision={enabled} />
      <label htmlFor={id}>
        <span>{vis ? <Glyph name="microphone" size={18} /> : t("host.microphone.volume")}</span>
        <output htmlFor={id}>{percent}%</output>
      </label>
      <Tooltip kind={host ? "hint-microphone-volume" : "hint-voice-microphone-volume"} text={vis ? undefined : t("host.microphone.volume")}>
        <input id={id} type="range" min={0} max={200} step={1} value={percent} disabled={disabled}
          style={{ "--range-fill": `${percent / 2}%` } as CSSProperties}
          aria-label={t("host.microphone.volume")} aria-valuetext={`${percent}%`}
          onChange={event => onVolume(Number(event.target.value) / 100)} />
      </Tooltip>
        <div className="lr-row-group">
          {vis ? <Glyph name="microphone" size={18} /> : null}
          <SwitchItem checked={voiceProcessing} onChange={onVoiceProcessing} disabled={disabled}
            label={t("host.microphone.voiceProcessing")} note={t("host.microphone.voiceProcessingHint")}
            hint={host ? "hint-microphone-processing" : "hint-voice-microphone-processing"} />
        </div>
        {!vis && <small>{t("host.microphone.voiceProcessingUsage")}</small>}
  </div>;
}
