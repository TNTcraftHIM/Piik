import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { ChannelAction } from "./ChannelAction";
import { useCopy } from "../../ui/copy";
import { useEffect, useState } from "react";
import "./channel-image-dialog.css";

/** The caller keeps the image URL alive; this surface only owns its presentation. */
export function ChannelImageDialog({ src, name, description, original, onClose }: {
  src: string; name: string; description?: string;
  original?: { busy: boolean; onLoad(): void; onCancel(): void };
  onClose(): void;
}) {
  const { t } = useCopy();
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [src]);
  const zoomLabel = t(zoomed ? "channel.imageDialog.fit" : "channel.imageDialog.actualSize");
  return <ChannelSettingsDialog title={name} className="c3-image-dialog" material="image" dismissOnBackdrop onClose={onClose}>
    <div className="c3-image-viewport" data-zoomed={zoomed || undefined}>
      <button type="button" className="c3-image-view" aria-label={`${zoomLabel}: ${name}`} onClick={() => setZoomed(value => !value)}>
        <img src={src} alt={name} draggable={false} />
      </button>
    </div>
    <div className="c3-image-detail">
      <ChannelAction icon="expand" quiet label={zoomLabel} onClick={() => setZoomed(value => !value)} />
      {description && <p role="status">{description}</p>}
      {original && <ChannelAction icon={original.busy ? "x" : "eye"} quiet
        label={original.busy ? t("channel.imageDialog.cancelOriginalImage") : t("channel.imageDialog.viewOriginal")}
        onClick={original.busy ? original.onCancel : original.onLoad} />}
    </div>
  </ChannelSettingsDialog>;
}
