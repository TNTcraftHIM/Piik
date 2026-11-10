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
  const available = channel.connection === "connected" && room.available;
  const busy = channel.pending.has(`invite:${room.id}`);
  const { getRoomInvite } = channel;
  useEffect(() => {
    let current = true;
    setInvitation({ state: "loading" });
    if (room.canManage && available) {
      void getRoomInvite(room.id).then(value => { if (current) setInvitation(value); },
        () => { if (current) setInvitation({ state: "failed" }); });
    }
    return () => { current = false; };
  }, [room.id, room.access, room.canManage, available, room.delivery?.bindingId, getRoomInvite, retry]);
  const invite = room.canManage && available && invitation.state === "available" ? invitation.url : "";
  const { message } = channelErrorPresentation(error, (cn, en) => zh ? cn : en);
  const generate = <ChannelAction icon="link" label={zh ? "生成新邀请" : "Generate new invitation"} hint="hint-rotate-invite"
    busy={busy} disabled={!available || busy || invitation.state === "loading"}
    onClick={() => { void run(() => channel.createRoomInvite(room.id, false), url => setInvitation({ state: "available", url })); }} />;
  return <>
    <header><strong>{room.name}</strong><ChannelAction icon="x" iconOnly quiet label={zh ? "关闭" : "Close"} onClick={onClose} /></header>
    <p>{room.access === "public" ? (zh ? "公开房间，域内用户都可进入。" : "Public room. Anyone in this domain can enter.")
      : room.hasPassword ? (zh ? "私密房间，凭邀请或密码进入。" : "Private room. Enter with an invitation or password.")
        : (zh ? "私密房间，凭邀请进入。" : "Private room. Enter with an invitation.")}
      {room.hidden && (zh ? " 对未获准的用户隐藏。" : " Hidden from users without access.")}</p>
    <p>{zh ? "凭此邀请可加入域并进入此房间，也可进入域内其他公开房间。" : "This invitation joins the domain and this room, including access to the domain’s other public rooms."}</p>
    {!room.canManage ? <p>{zh ? "请向房主索取邀请链接。" : "Ask the room owner for an invitation."}</p>
      : !available ? <p role="status">{zh ? "房间连接暂不可用，恢复后可读取邀请。" : "The room connection is unavailable. Its invitation can be read when it returns."}</p>
        : <>
          {invitation.state === "loading" && <p role="status">{zh ? "正在读取邀请…" : "Loading invitation…"}</p>}
          {invitation.state === "failed" && <><p role="status">{zh ? "未能读取邀请，请重试。" : "Could not load the invitation. Try again."}</p>
            <ChannelAction icon="refresh" quiet label={zh ? "重试" : "Retry"} onClick={() => setRetry(value => value + 1)} /></>}
          {invitation.state === "missing" && generate}
          {invitation.state === "unrecoverable" && <p>{zh ? "旧邀请仍有效，但无法取回链接。需要新链接时，请主动生成新邀请。" : "The old invitation still works, but its link cannot be recovered. Generate a new invitation when you need a new link."}</p>}
        </>}
    {invite && <InvitationLink url={invite} label={zh ? "房间邀请链接" : "Room invitation link"} />}
    {room.canManage && available && (invitation.state === "available" || invitation.state === "unrecoverable") &&
      <details className="c3-settings-details"><summary>{zh ? "重置房间邀请" : "Reset room invitation"}</summary>
        <p>{zh ? "生成新邀请会使旧链接失效，已获准的用户保留访问。" : "A new invitation invalidates old links. Existing users keep access."}</p>{generate}
      </details>}
    {message && <p className="c3-settings-error" role="alert">{message}</p>}
  </>;
}
