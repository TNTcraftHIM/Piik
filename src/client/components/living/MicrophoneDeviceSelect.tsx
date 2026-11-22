import { useEffect, useId, useState } from "react";
import type { CaptureDevice } from "../../media/capture-devices";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Btn } from "./primitives";

type DeviceList = { status: "loading" | "ready" | "failed"; devices: CaptureDevice[] };

// Shared presentation only: the caller owns capture and device replacement.
export function MicrophoneDeviceSelect({ value, load, onChange, label, disabled, revision, browser = true }: {
  value: string; load: () => Promise<CaptureDevice[]>;
  onChange: (id: string) => void; label: CopyKey; disabled?: boolean; revision?: unknown; browser?: boolean;
}) {
  const { t } = useCopy();
  const id = useId(), messageId = id + "-message";
  const [list, setList] = useState<DeviceList>({ status: "loading", devices: [] });
  const [refresh, setRefresh] = useState(0);
  const mediaDevices = browser ? navigator.mediaDevices : undefined;
  const unavailable = browser && (!mediaDevices?.getUserMedia || !mediaDevices.enumerateDevices);
  useEffect(() => {
    if (unavailable) return;
    let current = true;
    let request = 0;
    const update = () => {
      const token = ++request;
      setList(previous => ({ ...previous, status: "loading" }));
      void load().then(devices => {
        if (current && request === token) setList({ status: "ready", devices });
      }, () => {
        if (current && request === token) setList(previous => ({ ...previous, status: "failed" }));
      });
    };
    update();
    mediaDevices?.addEventListener("devicechange", update);
    return () => {
      current = false;
      mediaDevices?.removeEventListener("devicechange", update);
    };
  }, [load, refresh, revision, mediaDevices, unavailable]);

  const busy = !unavailable && list.status === "loading";
  const devices = list.status === "ready" ? list.devices : [];
  const selected = list.devices.find(device => device.id === value);
  const selectedFallback = list.status === "ready" ? t("host.device.missing")
    : selected?.label || t(busy ? "common.loading" : "host.device.microphone");
  const status = unavailable ? t("voice.error.microphoneUnavailable")
    : list.status === "failed" ? t("host.device.listFailed")
    : browser && !busy && devices.every(device => !device.label) ? t("host.device.permission.microphone") : undefined;

  return <div className="lr-capture-device">
    <label htmlFor={id}>{t(label)}</label>
    <div className="lr-capture-device-controls">
      <select id={id} value={value} disabled={disabled || unavailable} aria-busy={busy || undefined}
        aria-describedby={status ? messageId : undefined} onChange={event => onChange(event.target.value)}>
        <option value="">{t("host.device.default")}</option>
        {value !== "" && !devices.some(device => device.id === value) &&
          <option value={value} disabled>{selectedFallback}</option>}
        {devices.map((device, index) => <option key={device.id} value={device.id}>
          {device.label || t("host.device.microphone") + " " + (index + 1)}
        </option>)}
      </select>
      <Btn icon="refresh" className="lr-device-refresh" title="host.device.refresh" hint="hint-refresh-sources"
        disabled={busy || disabled || unavailable} busy={busy} onClick={() => setRefresh(value => value + 1)} />
    </div>
    {status && <small id={messageId} role="status">{status}</small>}
  </div>;
}
