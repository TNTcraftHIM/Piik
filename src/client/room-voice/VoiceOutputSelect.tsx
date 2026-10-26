import { useEffect, useId, useState } from "react";
import type { CaptureDevice } from "../media/capture-devices";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import { Btn } from "../components/living/primitives";
import type { RoomVoiceSnapshot } from "./session";

export function VoiceOutputSelect({ state, load, configure }: {
  state: RoomVoiceSnapshot; load: () => Promise<CaptureDevice[]>;
  configure: (deviceId?: string) => Promise<void>;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!state.outputSupported) return;
    let current = true, request = 0;
    const update = () => {
      const token = ++request;
      void load().then(result => {
        if (current && token === request) { setDevices(result); setFailed(false); }
      }, () => { if (current && token === request) setFailed(true); });
    };
    update();
    navigator.mediaDevices?.addEventListener("devicechange", update);
    return () => { current = false; navigator.mediaDevices?.removeEventListener("devicechange", update); };
  }, [load, state.outputSupported, state.microphone, revision]);
  const missing = state.outputDeviceId !== "" && !devices.some(device => device.id === state.outputDeviceId);
  return <div className="lr-capture-device">
    <label htmlFor={id}>{vis ? <Glyph name="headphones" size={18} /> : t("voice.outputDevice")}</label>
    <div className="lr-capture-device-controls">
      <select id={id} aria-label={t("voice.outputDevice")} value={state.outputDeviceId}
        disabled={!state.outputSupported || state.outputPending}
        onChange={event => void configure(event.target.value)}>
        <option value="">{t("host.device.default")}</option>
        {missing && <option value={state.outputDeviceId} disabled>{t("host.device.missing")}</option>}
        {devices.map((device, index) => <option key={device.id} value={device.id}>
          {device.label || `${t("voice.outputDevice")} ${index + 1}`}
        </option>)}
      </select>
    </div>
    {state.outputSupported ? <>
      {(failed || devices.every(device => !device.label)) && <Btn icon="headphones" title="voice.outputAccess" cap="voice.outputAccess" size="dense"
        busy={state.outputPending} disabled={state.outputPending}
        onClick={() => { void configure().then(() => setRevision(value => value + 1)); }} />}
      {!vis && <small>{t("voice.outputHint")}</small>}
    </> : <small role="status">{t("voice.outputUnsupported")}</small>}
    {failed && <small role="status">{t("host.device.listFailed")}</small>}
  </div>;
}
