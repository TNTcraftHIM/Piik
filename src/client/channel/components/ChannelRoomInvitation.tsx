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
export function ChannelRoomInvitation({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { lang, vis } = useCopy(), zh = lang === "zh";
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const label = zh ? `邀请进入 ${room.name}` : `Invite to ${room.name}`;
  useAnchoredPopover(trigger, panel, { maxHeight: 560 });
  return <span className="c3-room-invitation-entry" ref={trigger}>
    <Tooltip kind="hint-copy-invite" text={vis ? undefined : label} disabled={open}>
      <Btn icon="link" title={{ text: label }} quiet size="dense" expanded={open} controls={id} popoverTarget={id} />
    </Tooltip>
    <div id={id} ref={panel} popover="auto" role="dialog" aria-label={label}
      className="lr-anchored-card c3-room-invitation" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      {open && <RoomInvitation key={room.id} channel={channel} room={room} onClose={() => panel.current?.hidePopover()} />}
    </div>
  </span>;
}

function RoomInvitation({ channel, room, onClose }: { channel: ChannelController; room: ChannelRoom; onClose(): void }) {
  const { lang } = useCopy(), zh = lang === "zh";
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
  const { message } = channelErrorPresentation(error, (cn, en) => zh ? cn : en);
  const generate = (reset = false) => <ChannelAction icon="link" label={reset ? (zh ? "确认重置邀请" : "Confirm invitation reset")
    : (zh ? "生成免密邀请" : "Generate password-free invitation")} hint="hint-rotate-invite"
    busy={busy} disabled={!available || busy || invitation.state === "loading"}
    onClick={() => { void run(() => channel.createRoomInvite(room.id, false), url => setInvitation({ state: "available", url })); }} />;
  return <>
    <header><strong>{room.name}</strong><ChannelAction icon="x" iconOnly quiet label={zh ? "关闭" : "Close"} onClick={onClose} /></header>
    <p>{room.access === "public" ? (zh ? "公开房间，打开链接即可进入。" : "Public room. Open the link to enter.")
      : room.hasPassword ? (zh ? "私密房间，凭邀请或密码进入。" : "Private room. Enter with an invitation or password.")
        : (zh ? "私密房间，凭邀请进入。" : "Private room. Enter with an invitation.")}
      {room.hidden && (zh ? " 对未获准的用户隐藏。" : " Hidden from users without access.")}</p>
    {room.access === "private" && room.hasPassword && room.canManage && <div className="lr-toggle c3-room-invitation-mode" role="group" aria-label={zh ? "链接类型" : "Link type"}>
      <button type="button" className={includeInvite ? "is-selected" : undefined} aria-pressed={includeInvite}
        onClick={() => setIncludeInvite(true)}>{zh ? "免密邀请" : "Password-free invitation"}</button>
      <button type="button" className={!includeInvite ? "is-selected" : undefined} aria-pressed={!includeInvite}
        onClick={() => setIncludeInvite(false)}>{zh ? "需密码链接" : "Password-required link"}</button>
    </div>}
    {passwordLink && <p>{zh ? "此链接不含邀请凭据。新用户需要房间密码；已获准的用户可直接进入。" : "This link contains no invitation key. New users need the room password; users who already have access can enter directly."}</p>}
    {room.access === "private" && !passwordLink && (!room.canManage ? <p>{zh ? "请向房主索取免密邀请链接。" : "Ask the room owner for a password-free invitation."}</p>
      : !available ? <p role="status">{zh ? "房间连接暂不可用，恢复后可读取邀请。" : "The room connection is unavailable. Its invitation can be read when it returns."}</p>
        : <>
          {invitation.state === "loading" && <p role="status">{zh ? "正在读取邀请…" : "Loading invitation…"}</p>}
          {invitation.state === "failed" && <><p role="status">{zh ? "未能读取邀请，请重试。" : "Could not load the invitation. Try again."}</p>
            <ChannelAction icon="refresh" quiet label={zh ? "重试" : "Retry"} onClick={() => setRetry(value => value + 1)} /></>}
          {invitation.state === "missing" && generate()}
          {invitation.state === "unrecoverable" && <p>{zh ? "旧邀请仍有效，但无法取回链接。需要新链接时，请主动生成新邀请。" : "The old invitation still works, but its link cannot be recovered. Generate a new invitation when you need a new link."}</p>}
        </>)}
    {invite && <InvitationLink url={invite} label={passwordLink ? (zh ? "需密码的房间链接" : "Password-required room link")
      : room.access === "private" ? (zh ? "免密邀请链接" : "Password-free invitation link") : (zh ? "房间链接" : "Room link")}
      copyLabel={passwordLink || room.access === "public" ? (zh ? "复制房间链接" : "Copy room link") : (zh ? "复制免密邀请" : "Copy password-free invitation")} />}
    {room.access === "private" && !passwordLink && room.canManage && available && (invitation.state === "available" || invitation.state === "unrecoverable") &&
      <details className="c3-settings-details"><summary>{zh ? "重置房间邀请" : "Reset room invitation"}</summary>
        <p>{zh ? "重置后，所有旧免密邀请链接将失效。已获准的用户保留访问，房间密码不变。" : "Resetting invalidates all old password-free invitation links. Users who already have access keep it, and the room password stays unchanged."}</p>{generate(true)}
      </details>}
    {message && <p className="c3-settings-error" role="alert">{message}</p>}
  </>;
}
