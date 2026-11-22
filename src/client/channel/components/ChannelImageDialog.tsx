import { DRAG_ACTIVATION_DISTANCE_PX } from "../../ui/control-timing";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { ChannelAction } from "./ChannelAction";
import { useCopy } from "../../ui/copy";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./channel-image-dialog.css";

/** The caller keeps the image URL alive; this surface only owns its presentation. */
export function ChannelImageDialog({ src, name, description, progress, original, onClose }: {
  src: string; name: string; description?: string;
  progress?: ReactNode;
  original?: { busy: boolean; disabled?: boolean; onLoad(): void; onCancel(): void };
  onClose(): void;
}) {
  const { t } = useCopy();
  const [zoomed, setZoomed] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const moved = useRef(false);
  useEffect(() => { setZoomed(false); drag.current = null; moved.current = false; }, [src]);
  const zoomLabel = t(zoomed ? "channel.imageDialog.fit" : "channel.imageDialog.actualSize");
  return <ChannelSettingsDialog title={name} className="c3-image-dialog" material="image" dismissOnBackdrop onClose={onClose}>
    <div className="c3-image-viewport" data-zoomed={zoomed || undefined}>
      <button type="button" className="c3-image-view" aria-label={`${zoomLabel}: ${name}`} onPointerDown={event => {
          moved.current = false;
          if (!zoomed || event.pointerType !== "mouse" || event.button !== 0) return;
          const viewport = event.currentTarget.parentElement!;
          drag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || event.pointerType !== "mouse") return;
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          if (!moved.current && Math.hypot(dx, dy) < DRAG_ACTIVATION_DISTANCE_PX) return;
          moved.current = true;
          event.currentTarget.parentElement!.scrollTo(start.left - dx, start.top - dy);
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onClick={event => {
          if (!event.detail || !moved.current) setZoomed(value => !value);
        }}>
        <img src={src} alt={name} draggable={false} />
      </button>
    </div>
    <div className="c3-image-detail">
      <ChannelAction icon="expand" quiet label={zoomLabel} onClick={() => setZoomed(value => !value)} />
      {description && <p role="status">{description}</p>}
      {original && <ChannelAction icon={original.busy ? "x" : "eye"} quiet
        disabled={original.disabled && !original.busy}
        label={original.busy ? t("channel.imageDialog.cancelOriginalImage") : t("channel.imageDialog.viewOriginal")}
        onClick={original.busy ? original.onCancel : original.onLoad} />}
      {progress}
    </div>
  </ChannelSettingsDialog>;
}
