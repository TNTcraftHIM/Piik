import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import { ChannelAction } from "./ChannelAction";
import { ChannelInviteQrCode } from "./ChannelInviteQrCode";
import "./invitation-link.css";

/** The invitation owner supplies the complete link; copy and QR share that value. */
export function InvitationLink({ url, label, copyLabel, disabled = false }: { url: string; label: string; copyLabel?: string; disabled?: boolean }) {
  const { t } = useCopy();
  const clipboard = useClipboardResult(url);
  return <div className="c3-invitation-link">
    <ChannelAction icon={clipboard.status === "copied" ? "check" : "copy"} primary hint="hint-copy-invite"
      label={clipboard.status === "copied" ? t("channel.invitationLink.copied") : copyLabel ?? t("channel.invitationLink.copyInvitation")}
      disabled={disabled} onClick={clipboard.copy} />
    <input className="c3-input" readOnly value={url} aria-label={label} onFocus={event => event.currentTarget.select()} />
    {clipboard.status === "failed" && <p role="status">{t("channel.invitationLink.copyFailed")}</p>}
    <ChannelInviteQrCode url={url} disabled={disabled} label={t("channel.invitationLink.qrCode")} />
  </div>;
}
