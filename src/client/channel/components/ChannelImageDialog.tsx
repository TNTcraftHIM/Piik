import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import "./channel-image-dialog.css";

/** The caller keeps the image URL alive; this surface only owns its presentation. */
export function ChannelImageDialog({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  return <ChannelSettingsDialog title={name} className="c3-image-dialog" dismissOnBackdrop onClose={onClose}>
    <img src={src} alt={name} />
  </ChannelSettingsDialog>;
}
