import { useEffect, useRef, useState } from "react";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelRoom, RoomSettings } from "../protocol";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelMedia";
import "./channel-room-controls.css";

function RoomForm({ room, appHosted, busy, onSave }: {
  room?: ChannelRoom; appHosted: boolean; busy: boolean; onSave: (settings: RoomSettings) => Promise<unknown>;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [name, setName] = useState(room?.name ?? "");
  const [access, setAccess] = useState<RoomSettings["access"]>(room?.access ?? "public");
  const [hidden, setHidden] = useState(room?.hidden ?? false);
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  return <form className="c3-room-form" onSubmit={event => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    void onSave({ name: name.trim(), access, hidden: access === "private" && hidden,
      ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) }).catch(() => {});
  }}>
    {!room && <p>{appHosted
      ? (zh ? "由 App 托管，关闭网页后房间继续运行。" : "Hosted by App. The room keeps running when this page closes.")
      : (zh ? "由此网页托管，关闭网页后房间暂停。" : "Hosted by this page. The room pauses when this page closes.")}</p>}
    <label><span>{zh ? "房间名称" : "Room name"}</span><input className="c3-input" required maxLength={64}
      value={name} disabled={busy} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
    <fieldset className="lr-toggle c3-room-access" disabled={busy}>
      <legend className="visually-hidden">{zh ? "谁可以进入" : "Who can enter"}</legend>
      {(["public", "private"] as const).map(value => <label key={value}>
        <input type="radio" name="access" value={value} checked={access === value} onChange={() => setAccess(value)} />
        <span><Glyph name={value === "public" ? "users" : "lock"} size={18} />
          {value === "public" ? (zh ? "公开" : "Public") : (zh ? "私密" : "Private")}</span>
      </label>)}
    </fieldset>
    <p>{access === "public" ? (zh ? "频道内的用户都能进入。" : "Anyone in this channel can enter.")
      : (zh ? "凭房间邀请或密码进入。" : "Enter with a room invitation or password.")}</p>
    {access === "private" && <div className="c3-private-options">
      <label><span>{zh ? "密码（可选）" : "Password (optional)"}</span><input className="c3-input" type="password"
        maxLength={128} autoComplete="new-password" value={password} disabled={busy || removePassword}
        placeholder={room?.hasPassword ? (zh ? "留空保留现有密码" : "Leave blank to keep the password") : undefined}
        onChange={event => setPassword(event.target.value)} /></label>
      {room?.hasPassword && <label className="c3-check"><input type="checkbox" checked={removePassword} disabled={busy}
        onChange={event => { setRemovePassword(event.target.checked); setPassword(""); }} />{zh ? "移除密码" : "Remove password"}</label>}
      <label className="c3-check"><input type="checkbox" checked={hidden} disabled={busy} onChange={event => setHidden(event.target.checked)} />
        {zh ? "对未获准的用户隐藏房间" : "Hide from users without access"}</label>
    </div>}
    <ChannelAction icon={room ? "check" : "plus"} label={room ? (zh ? "保存" : "Save") : (zh ? "创建房间" : "Create room")}
      primary type="submit" disabled={!name.trim()} busy={busy} />
  </form>;
}

/** Room policy has one editor for creation and management; navigation grants no access. */
export function ChannelRoomControls({ channel, room, onCreated }: {
  channel: ChannelController; room?: ChannelRoom; onCreated?: (id: string) => void;
}) {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState("");
  const [copied, setCopied] = useState(false);
  const id = room ? "c3-room-settings" : "c3-create-room";
  const title = room ? (zh ? "房间设置" : "Room settings") : (zh ? "创建房间" : "Create room");
  useAnchoredPopover(trigger, panel, { side: "below", align: "end" });
  useEffect(() => { setInvite(""); setCopied(false); panel.current?.hidePopover(); }, [room?.id, room?.access]);
  const available = channel.connection === "connected" && (!room || room.available);
  const busy = !available || channel.pending.has(room ? `room:${room.id}` : "create-room");
  const members = room?.members?.filter(userId => userId !== room.creatorId && userId !== channel.state?.channel.ownerId) ?? [];
  const run = (work: Promise<unknown>) => { void work.catch(() => {}); };
  return <>
    <Tooltip kind={room ? "hint-details" : "hint-create-room"} text={vis ? undefined : title}>
      <button ref={trigger} type="button" className="lr-btn is-dense is-quiet" popoverTarget={id}
        aria-label={title} aria-haspopup="dialog" disabled={!available}>
        <Glyph name={room ? "sliders" : "plus"} size={18} />
        {!room && !channel.state?.channel.rooms.length && !vis && <span className="lr-cap">{title}</span>}
      </button>
    </Tooltip>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={title}
      className="lr-anchored-card c3-room-panel" onToggle={event => setOpen(event.newState === "open")}>
      {open && <><h3>{title}</h3><RoomForm key={room?.id ?? "create"} room={room} appHosted={channel.appConnected} busy={busy} onSave={async settings => {
        if (room) await channel.updateRoom(room.id, settings);
        else onCreated?.(await channel.createRoom(settings));
        panel.current?.hidePopover();
      }} />
      {room?.access === "private" && <section className="c3-room-invitation">
        <ChannelAction icon="link" label={invite ? (zh ? "更换邀请链接" : "Replace invitation") : (zh ? "创建房间邀请" : "Create room invitation")}
          busy={channel.pending.has(`invite:${room.id}`)} disabled={!available} hint="hint-copy-invite"
          onClick={() => run(channel.createRoomInvite(room.id).then(value => { setInvite(value); setCopied(false); }))} />
        {invite && <div className="c3-invite-copy"><input className="c3-input" value={invite} readOnly
          aria-label={zh ? "房间邀请链接" : "Room invitation link"} onFocus={event => event.currentTarget.select()} />
          <ChannelAction icon={copied ? "check" : "copy"} iconOnly label={copied ? (zh ? "已复制" : "Copied") : (zh ? "复制邀请" : "Copy invitation")}
            hint="hint-copy-invite" onClick={() => run(navigator.clipboard.writeText(invite).then(() => setCopied(true)))} /></div>}
        <p>{zh ? "更换邀请或密码不会移除已获准的用户。" : "Replacing an invitation or password keeps existing access."}</p>
        {members.length > 0 && <details className="c3-room-members">
          <summary>{zh ? "已获准的用户" : "Users with access"}</summary>
          {members.map(userId =>
            <div key={userId}><span>{channel.state?.users.find(user => user.id === userId)?.name ?? (zh ? "用户" : "User")}</span>
              <ChannelAction icon="x" quiet iconOnly label={zh ? "移除房间资格" : "Remove room access"} hint="hint-close"
                busy={channel.pending.has(`revoke:${room.id}:${userId}`)} disabled={!available}
                onClick={() => run(channel.revokeRoomAccess(room.id, userId))} /></div>)}
        </details>}
      </section>}</>}
    </div>
  </>;
}

export function ChannelRoomEntry({ channel, room }: { channel: ChannelController; room: ChannelRoom }) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [password, setPassword] = useState("");
  const available = channel.connection === "connected" && room.available;
  return <section className="c3-locked-room"><Glyph name="lock" size={46} />
    <h3>{zh ? "这是一间私密房间" : "This room is private"}</h3>
    <p>{room.hasPassword ? (zh ? "输入房间密码，或使用房间邀请链接。" : "Enter its password or open a room invitation.")
      : (zh ? "请向房主索取邀请链接。" : "Ask the room owner for an invitation.")}</p>
    {room.hasPassword && <form onSubmit={event => {
      event.preventDefault();
      if (!available) return;
      void channel.enterRoom(room.id, password).then(() => setPassword("")).catch(() => {});
    }}><input className="c3-input" type="password" maxLength={128} value={password} autoComplete="current-password"
      aria-label={zh ? "房间密码" : "Room password"} onChange={event => setPassword(event.target.value)} />
      <ChannelAction icon="door" type="submit" primary label={zh ? "进入房间" : "Enter room"}
        busy={channel.pending.has(`enter:${room.id}`)} disabled={!password || !available} /></form>}
  </section>;
}
