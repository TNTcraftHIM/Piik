import { useEffect, useState } from "react";
import { loadCameraPreviews, type CameraPreview } from "../../media/camera-previews";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { CaptureSourceCard } from "./CaptureSourceCard";
import { HintComic } from "./hints";
import { Pill } from "./primitives";

export function useCameraSources(active: boolean, activeVideo?: HTMLVideoElement | null,
  load = loadCameraPreviews) {
  const [sources, setSources] = useState<CameraPreview[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<"host.camera.denied" | "host.camera.unavailable" | null>(null);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    const request = new AbortController();
    setBusy(true); setError(null); setSources([]);
    void load(request.signal, result => { if (!request.signal.aborted) setSources(result); }, activeVideo).catch(error => {
      if (!request.signal.aborted) setError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "host.camera.denied" : "host.camera.unavailable");
    }).finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => request.abort();
  }, [active, revision, activeVideo, load]);
  return { sources, busy, error, refresh: () => refresh(value => value + 1) };
}

export function CameraSources({ sources, busy, error, selected, disabled, onSelect }:
  Pick<ReturnType<typeof useCameraSources>, "sources" | "busy" | "error"> & {
    selected: string; disabled: boolean; onSelect: (deviceId: string) => void;
  }) {
  const { t, vis } = useCopy();
  return <>
    <div className="lr-source-picker-list" aria-busy={busy}>
      {sources.map((source, index) => <CaptureSourceCard key={source.id} cameraKey={source.id}
        title={source.label || `${t("host.device.camera")} ${index + 1}`}
        action={t("host.sourcePicker.camera", { title: source.label || `${t("host.device.camera")} ${index + 1}` })}
        icon="camera" hint="hint-capture-camera" preview={source.preview}
        selected={source.id === selected} disabled={disabled || busy} onSelect={() => onSelect(source.id)} />)}
    </div>
    {busy && <span className="lr-source-picker-status" role="status" aria-label={t("host.sourcePicker.loading")}>
      <Glyph name="refresh" className="lr-spin" size={18} />{!vis && t("host.sourcePicker.loading")}
    </span>}
    {error ? <Pill icon="camera" label={t(error)} comic="source-failed" tone="bad" />
      : !busy && !sources.length ? <span className="lr-source-picker-status" role="status" aria-label={t("host.sourcePicker.empty")}>
        <HintComic kind="hint-no-sources" size={160} />{!vis && t("host.sourcePicker.empty")}
      </span> : null}
  </>;
}
