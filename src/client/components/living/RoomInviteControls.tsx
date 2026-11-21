import { InviteQrCode } from "./InviteQrCode";
import { Btn, SwitchItem } from "./primitives";
import { Tooltip } from "./Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";

type InviteState = {
  roomLink: string | null | undefined;
  roomLinkBlocked: boolean;
  roomMutating: boolean;
  includeInviteCredential: boolean;
};

export function CopyRoomInvite({ roomLink, roomLinkBlocked, roomMutating,
  includeInviteCredential, copied, onCopy }: InviteState & { copied: boolean; onCopy: () => void }) {
  return (
    <Btn
      icon={copied ? "check" : "link"}
      cap="common.copy"
      title={copied ? "common.copied" : roomLinkBlocked ? "host.invite.credentialRequired"
        : includeInviteCredential ? "host.invite.copy" : "host.invite.copyAddress"}
      hint={roomLinkBlocked ? "hint-policy-private" : "hint-copy-invite"}
      hintTone={copied ? "live" : roomLinkBlocked ? "warn" : undefined}
      hintMotion={copied ? "still" : undefined}
      disabled={!roomLink || roomMutating || roomLinkBlocked}
      onClick={onCopy}
    />
  );
}

export function RoomInviteField({ roomLink, roomLinkBlocked, roomMutating,
  includeInviteCredential, onCredentialChange }: InviteState & { onCredentialChange: (checked: boolean) => void }) {
  const { t } = useCopy();
  return (
    <div className="lr-invite-field">
      <InviteQrCode url={roomLinkBlocked ? null : roomLink} disabled={roomMutating} />
      {roomLink ? (
        <Tooltip kind="hint-invite-link" text={roomLink} className="lr-invite-hint">
          <input
            className="lr-invite-url"
            type="text"
            dir="ltr"
            value={roomLink}
            readOnly
            spellCheck={false}
            aria-label={t(includeInviteCredential ? "host.invite" : "host.invite.address")}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Tooltip>
      ) : null}
      <span className="lr-row-group">
        <Glyph name="key" size={17} />
        <SwitchItem checked={includeInviteCredential} disabled={roomMutating}
          label={t("host.invite.includeCredential")} hint="hint-invite-link"
          note={t("host.invite.credentialHint")}
          onChange={onCredentialChange} />
      </span>
    </div>
  );
}
