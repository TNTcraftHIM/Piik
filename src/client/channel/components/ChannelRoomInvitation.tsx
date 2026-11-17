import { useEffect, useId, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { channelErrorPresentation } from "../error-presentation";
import type { ChannelRoom, RoomInvitationState } from "../protocol";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelAction";
import { InvitationLink } from "./InvitationLink";
import { useSettingsAction } from "./ChannelSettingsDialog";
import "./channel-room-invitation.css";

/** The title's invitation entry owns one open read, independently of room settings. */
export function ChannelRoomInvitation({ channel, room, onManageAccess }: {
  channel: ChannelController; room: ChannelRoom; onManageAccess?(): void;
}) {
  const { t } = useCopy();
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const label = t("invite.room.title", { name: room.name });
  useAnchoredPopover(trigger, panel, { maxHeight: 560 });
  return <span className="c3-room-invitation-entry" ref={trigger}>
    <Tooltip kind="hint-copy-invite" text={label} disabled={open}>
      <Btn icon="link" title={{ text: label }} quiet size="dense" expanded={open} controls={id} popoverTarget={id} />
    </Tooltip>
    <div id={id} ref={panel} popover="auto" role="dialog" aria-label={label}
      className="lr-anchored-card c3-room-invitation" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      {open && <RoomInvitation key={room.id} channel={channel} room={room} onClose={() => panel.current?.hidePopover()}
        onManageAccess={onManageAccess} />}
    </div>
  </span>;
}

function RoomInvitation({ channel, room, onClose, onManageAccess }: {
  channel: ChannelController; room: ChannelRoom; onClose(): void; onManageAccess?(): void;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const [invitation, setInvitation] = useState<RoomInvitationState | { state: "loading" | "failed" }>({ state: "loading" });
  const [retry, setRetry] = useState(0);
  const [includeInvite, setIncludeInvite] = useState(room.canManage);
  const available = channel.connection === "connected" && room.available;
  const busy = channel.pending.has(`invite:${room.id}`);
  const { getRoomInvite } = channel;
  useEffect(() => {
    let current = true;
    setInvitation({ state: "loading" });
    if (room.access === "private" && room.canManage && available) {
      void getRoomInvite(room.id).then(value => { if (current) setInvitation(value); },
        () => { if (current) setInvitation({ state: "failed" }); });
    }
    return () => { current = false; };
  }, [room.id, room.access, room.canManage, available, room.delivery?.bindingId, getRoomInvite, retry]);
  const roomURL = channel.siteURL ? new URL(channel.siteURL) : null;
  if (roomURL) roomURL.hash = new URLSearchParams({ room: room.id }).toString();
  const passwordLink = room.access === "private" && room.hasPassword && !includeInvite;
  const invite = room.access === "public" || passwordLink ? roomURL?.href ?? ""
    : room.canManage && available && invitation.state === "available" ? invitation.url : "";
  const { message } = channelErrorPresentation(error, t);
  const generate = (reset = false) => <ChannelAction icon="link" label={reset ? t("invite.room.confirmReset")
    : t("invite.room.generate")} hint="hint-rotate-invite" danger={reset}
    busy={busy} disabled={!available || busy || invitation.state === "loading"}
    onClick={() => { void run(() => channel.createRoomInvite(room.id, false), url => setInvitation({ state: "available", url })); }} />;
  return <>
    <header><strong>{room.name}</strong><ChannelAction icon="x" iconOnly quiet label={t("room.action.close")} onClick={onClose} /></header>
    <p>{room.access === "public" ? t("invite.room.publicNote")
      : room.hasPassword ? t("invite.room.passwordNote")
        : t("invite.room.privateNote")}
      {room.hidden && t("invite.room.hiddenNote")}</p>
    {room.access === "private" && room.hasPassword && room.canManage && <div className="lr-toggle c3-room-invitation-mode" role="group" aria-label={t("invite.room.linkType")}>
      <button type="button" className={includeInvite ? "is-selected" : undefined} aria-pressed={includeInvite}
        onClick={() => setIncludeInvite(true)}>{t("invite.room.passwordFree")}</button>
      <button type="button" className={!includeInvite ? "is-selected" : undefined} aria-pressed={!includeInvite}
        onClick={() => setIncludeInvite(false)}>{t("invite.room.passwordRequired")}</button>
    </div>}
    {passwordLink && <p>{t("invite.room.passwordLinkNote")}</p>}
    {room.access === "private" && !passwordLink && (!room.canManage ? <p>{t("invite.room.askOwner")}</p>
      : !available ? <p role="status">{t("invite.room.unavailable")}</p>
        : <>
          {invitation.state === "loading" && <p role="status">{t("invite.room.loading")}</p>}
          {invitation.state === "failed" && <><p role="status">{t("invite.room.failed")}</p>
            <ChannelAction icon="refresh" quiet label={t("room.action.retry")} onClick={() => setRetry(value => value + 1)} /></>}
          {invitation.state === "missing" && generate()}
        </>)}
    {invite && <InvitationLink url={invite} label={passwordLink ? t("invite.room.passwordLink")
      : room.access === "private" ? t("invite.room.invitationLink") : t("invite.room.publicLink")}
      copyLabel={passwordLink || room.access === "public" ? t("invite.room.copyLink") : t("invite.room.copyInvitation")} />}
    {room.access === "private" && !passwordLink && room.canManage && available && invitation.state === "available" &&
      <details className="c3-settings-details"><summary>{t("invite.room.reset")}</summary>
        <p>{t("invite.room.resetNote")}</p>{generate(true)}
      </details>}
    {room.canManage && onManageAccess && <ChannelAction icon="lock" quiet
      label={t("invite.room.accessSettings")} disabled={!available || busy}
      onClick={() => { onClose(); onManageAccess(); }} />}
    {message && <p className="c3-settings-error" role="alert">{message}</p>}
  </>;
}
