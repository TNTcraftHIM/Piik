import { SwitchItem } from "./primitives";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { CaptureDevice } from "../../media/capture-devices";
import { MicrophoneDeviceSelect } from "./MicrophoneDeviceSelect";
import { AudioVolumeControl } from "./AudioVolumeControl";

export function MicrophoneSettings({ enabled, disabled, volume, onVolume, deviceId, onDevice, loadDevices, voiceProcessing, onVoiceProcessing, host }: {
  enabled: boolean; disabled?: boolean; host: boolean;
  volume: number; onVolume: (volume: number) => void;
  deviceId: string; onDevice: (id: string) => void; loadDevices: () => Promise<CaptureDevice[]>;
  voiceProcessing: boolean; onVoiceProcessing: (enabled: boolean) => void;
}) {
  const { t, vis } = useCopy();
  return <div className="lr-door-group lr-audio-settings" role="group" aria-label={t("host.microphone.settings")}>
      <MicrophoneDeviceSelect value={deviceId} load={loadDevices}
        onChange={onDevice} disabled={disabled} revision={enabled} />
      <AudioVolumeControl volume={volume} onVolume={onVolume} disabled={disabled}
        label="host.microphone.volume" icon="microphone"
        hint={host ? "hint-microphone-volume" : "hint-voice-microphone-volume"} />
        <div className="lr-row-group">
          {vis ? <Glyph name="microphone" size={18} /> : null}
          <SwitchItem checked={voiceProcessing} onChange={onVoiceProcessing} disabled={disabled}
            label={t("host.microphone.voiceProcessing")} note={t("host.microphone.voiceProcessingHint")}
            hint={host ? "hint-microphone-processing" : "hint-voice-microphone-processing"} />
        </div>
  </div>;
}
