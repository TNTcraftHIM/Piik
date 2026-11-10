import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import { ChannelAction } from "./ChannelAction";
import { ChannelInviteQrCode } from "./ChannelInviteQrCode";
import "./invitation-link.css";

/** The invitation owner supplies the complete link; copy and QR share that value. */
export function InvitationLink({ url, label, copyLabel, disabled = false }: { url: string; label: string; copyLabel?: string; disabled?: boolean }) {
  const { lang } = useCopy(), zh = lang === "zh";
  const clipboard = useClipboardResult(url);
  return <div className="c3-invitation-link">
    <ChannelAction icon={clipboard.status === "copied" ? "check" : "copy"} primary hint="hint-copy-invite"
      label={clipboard.status === "copied" ? (zh ? "已复制" : "Copied") : copyLabel ?? (zh ? "复制邀请" : "Copy invitation")}
      disabled={disabled} onClick={clipboard.copy} />
    <input className="c3-input" readOnly value={url} aria-label={label} onFocus={event => event.currentTarget.select()} />
    {clipboard.status === "failed" && <p role="status">{zh ? "请手动复制上方链接。" : "Copy the link above manually."}</p>}
    <ChannelInviteQrCode url={url} disabled={disabled} label={zh ? "二维码" : "QR code"} presentation="inline" />
  </div>;
}
