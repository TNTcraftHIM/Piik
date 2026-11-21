import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import { Btn } from "../../components/living/primitives";
import { ChannelInviteQrCode } from "./ChannelInviteQrCode";
import "./invitation-link.css";

/** The invitation owner supplies the complete link; copy and QR share that value. */
export function InvitationLink({ url, label, copyLabel, disabled = false }: { url: string; label: string; copyLabel?: string; disabled?: boolean }) {
  const { t } = useCopy();
  const clipboard = useClipboardResult(url);
  const copied = clipboard.status === "copied", failed = clipboard.status === "failed";
  const action = copied ? t("channel.invitationLink.copied") : copyLabel ?? t("channel.invitationLink.copyInvitation");
  return <div className="c3-invitation-link">
    <Btn icon={copied ? "check" : failed ? "alert" : "copy"} tone="primary" size="compact"
      title={{ text: action }} cap={{ text: action }} hint={failed ? "copy-failed" : "hint-copy-invite"}
      hintText={failed ? "channel.invitationLink.copyFailed" : undefined} hintTone={copied ? "live" : undefined}
      hintMotion={copied ? "still" : undefined}
      disabled={disabled} onClick={clipboard.copy} />
    <input className="c3-input" readOnly value={url} aria-label={label} onFocus={event => event.currentTarget.select()} />
    {failed && <p role="status">{t("channel.invitationLink.copyFailed")}</p>}
    <ChannelInviteQrCode url={url} disabled={disabled} label={t("channel.invitationLink.qrCode")} />
  </div>;
}
