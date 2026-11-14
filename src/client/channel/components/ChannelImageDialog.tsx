import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { ChannelAction } from "./ChannelAction";
import { useCopy } from "../../ui/copy";
import "./channel-image-dialog.css";

/** The caller keeps the image URL alive; this surface only owns its presentation. */
export function ChannelImageDialog({ src, name, description, original, onClose }: {
  src: string; name: string; description?: string;
  original?: { busy: boolean; onLoad(): void; onCancel(): void };
  onClose(): void;
}) {
  const { t } = useCopy();
  return <ChannelSettingsDialog title={name} className="c3-image-dialog" dismissOnBackdrop onClose={onClose}>
    <img src={src} alt={name} />
    {(description || original) && <div className="c3-image-detail">
      {description && <p role="status">{description}</p>}
      {original && <ChannelAction icon={original.busy ? "x" : "eye"} quiet
        label={original.busy ? t("channel.imageDialog.cancelOriginalImage") : t("channel.imageDialog.viewOriginal")}
        onClick={original.busy ? original.onCancel : original.onLoad} />}
    </div>}
  </ChannelSettingsDialog>;
}
