import { useState, useSyncExternalStore } from "react";
import { Btn } from "../../components/living/primitives";
import { AudioDevicePicker } from "../../components/living/AudioDeviceSelect";
import { playbackOutput } from "../../media/playback-output";
import { useCopy } from "../../ui/copy";

type OutputDevices = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
async function loadOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default")
    .map(device => ({ id: device.deviceId, label: device.label }));
}
export function PlaybackDeviceSelect() {
  const { t } = useCopy();
  const media = navigator.mediaDevices as OutputDevices | undefined;
  const selected = useSyncExternalStore(playbackOutput.subscribe, () => playbackOutput.selected);
  const failed = useSyncExternalStore(playbackOutput.subscribe, () => playbackOutput.failed);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pickerFailed, setPickerFailed] = useState(false);
  if (!media?.enumerateDevices || !HTMLMediaElement.prototype.setSinkId || typeof AudioContext === "undefined" || !("setSinkId" in AudioContext.prototype)) {
    return <small>{t("voice.output.system")}</small>;
  }
  async function change(id?: string) {
    setBusy(true);
    setPickerFailed(false);
    try {
      const value = id ?? (await media!.selectAudioOutput!()).deviceId;
      await playbackOutput.choose(value);
      setRevision(v => v + 1);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) setPickerFailed(true);
    } finally { setBusy(false); }
  }
  return <>
    <AudioDevicePicker output value={selected} label="voice.output.device" load={loadOutputs} revision={revision}
      disabled={busy} onChange={id => void change(id)} />
    {media.selectAudioOutput && <Btn icon="speaker" size="compact" title="voice.output.choose" cap="voice.output.choose" disabled={busy} onClick={() => void change()} />}
    {(failed || pickerFailed) && <small role="status">{t("voice.output.failed")}</small>}
  </>;
}
