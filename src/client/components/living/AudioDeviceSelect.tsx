import { useEffect, useId, useState } from "react";
import type { CaptureDevice } from "../../media/capture-devices";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Btn } from "./primitives";

type DeviceList = { status: "loading" | "ready" | "failed"; devices: CaptureDevice[] };

// Shared presentation only: the caller owns capture and device replacement.
export function AudioDevicePicker({ value, load, onChange, label, disabled, revision, browser = true, output = false }: {
  value: string; load: (signal?: AbortSignal) => Promise<CaptureDevice[]>;
  onChange: (id: string) => void; label: CopyKey; disabled?: boolean; revision?: unknown; browser?: boolean; output?: boolean;
}) {
  const [list, setList] = useState<DeviceList>({ status: "loading", devices: [] });
  const [refresh, setRefresh] = useState(0);
  const mediaDevices = browser ? navigator.mediaDevices : undefined;
  const unavailable = browser && (!mediaDevices?.enumerateDevices || !output && !mediaDevices.getUserMedia);
  useEffect(() => {
    if (unavailable) return;
    let pending: AbortController;
    const update = () => {
      pending?.abort();
      pending = new AbortController();
      const { signal } = pending;
      setList(previous => ({ ...previous, status: "loading" }));
      void load(signal).then(devices => {
        if (!signal.aborted) setList({ status: "ready", devices });
      }, () => {
        if (!signal.aborted) setList(previous => ({ ...previous, status: "failed" }));
      });
    };
    update();
    mediaDevices?.addEventListener("devicechange", update);
    return () => {
      pending.abort();
      mediaDevices?.removeEventListener("devicechange", update);
    };
  }, [load, refresh, revision, mediaDevices, unavailable]);

  return <AudioDeviceSelect value={value} list={list} label={label} disabled={disabled} unavailable={unavailable}
    onChange={onChange} onRefresh={() => setRefresh(value => value + 1)} output={output} browser={browser} />;
}

export function AudioDeviceSelect({ value, list, label, disabled, unavailable, onChange, onRefresh, output, browser }: {
  value: string; list: DeviceList; label: CopyKey; disabled?: boolean; unavailable?: boolean;
  onChange: (id: string) => void; onRefresh?: () => void; output?: boolean; browser?: boolean;
}) {
  const { t } = useCopy();
  const id = useId(), messageId = id + "-message";
  const busy = !unavailable && list.status === "loading";
  const devices = list.status === "ready" ? list.devices : [];
  const selected = list.devices.find(device => device.id === value);
  const deviceLabel = output ? "voice.output.device" : "host.device.microphone";
  const selectedFallback = list.status === "ready" ? t("host.device.missing")
    : selected?.label || t(busy ? "common.loading" : deviceLabel);
  const status = unavailable ? t("voice.error.microphoneUnavailable")
    : list.status === "failed" ? t("host.device.listFailed")
    : browser && output && !busy && !devices.length && !("selectAudioOutput" in navigator.mediaDevices) ? t("voice.output.permissionHint")
    : browser && !output && !busy && devices.every(device => !device.label) ? t("host.device.permission.microphone") : undefined;

  return <div className="lr-capture-device">
    <label htmlFor={id}>{t(label)}</label>
    <div className="lr-capture-device-controls">
      <select id={id} value={value} disabled={disabled || unavailable} aria-busy={busy || undefined}
        aria-describedby={status ? messageId : undefined} onChange={event => onChange(event.target.value)}>
        <option value="">{t("host.device.default")}</option>
        {value !== "" && !devices.some(device => device.id === value) &&
          <option value={value} disabled>{selectedFallback}</option>}
        {devices.map((device, index) => <option key={device.id} value={device.id}>
          {device.label || t(deviceLabel) + " " + (index + 1)}
        </option>)}
      </select>
      {onRefresh && <Btn icon="refresh" className="lr-device-refresh" title="host.device.refresh" hint="hint-refresh-sources"
        disabled={busy || disabled || unavailable} busy={busy} onClick={onRefresh} />}
    </div>
    {status && <small id={messageId} role="status">{status}</small>}
  </div>;
}
