import { useEffect, useId, useState } from "react";
import type { CaptureDevice } from "../../media/capture-devices";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";

// Shared presentation only: the caller owns capture and device replacement.
export function MicrophoneDeviceSelect({ value, load, onChange, disabled, revision, browser = true }: {
  value: string; load: () => Promise<CaptureDevice[]>;
  onChange: (id: string) => void; disabled?: boolean; revision?: unknown; browser?: boolean;
}) {
  const { t } = useCopy();
  const id = useId();
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const unavailable = browser && !navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    let current = true;
    let request = 0;
    const update = () => {
      const token = ++request;
      setBusy(true);
      void load().then(result => {
        if (!current || request !== token) return;
        setDevices(result); setFailed(false);
      }, () => {
        if (current && request === token) setFailed(true);
      }).finally(() => { if (current && request === token) setBusy(false); });
    };
    update();
    if (browser) navigator.mediaDevices?.addEventListener("devicechange", update);
    return () => {
      current = false;
      if (browser) navigator.mediaDevices?.removeEventListener("devicechange", update);
    };
  }, [load, refresh, revision, browser]);
  const missing = value !== "" && !devices.some(device => device.id === value);
  return <div className="lr-capture-device">
    <label htmlFor={id}>{t("host.device.microphone")}</label>
    <div className="lr-capture-device-controls">
      <select id={id} value={value} disabled={disabled || busy || unavailable} aria-label={t("host.device.microphone")}
        onChange={event => onChange(event.target.value)}>
        <option value="">{t("host.device.default")}</option>
        {missing && <option value={value} disabled>{t("host.device.missing")}</option>}
        {devices.map((device, index) => <option key={device.id} value={device.id}>
          {device.label || `${t("host.device.microphone")} ${index + 1}`}
        </option>)}
      </select>
      <Btn icon="refresh" className="lr-device-refresh" title="host.device.refresh" hint="hint-refresh-sources"
        disabled={busy || disabled || unavailable} busy={busy} onClick={() => setRefresh(value => value + 1)} />
    </div>
    {unavailable ? <small role="status">{t("voice.error.microphoneUnavailable")}</small>
      : failed ? <small role="status">{t("host.device.listFailed")}</small>
      : browser && !busy && devices.every(device => !device.label) ? <small>{t("host.device.permission.microphone")}</small> : null}
  </div>;
}
