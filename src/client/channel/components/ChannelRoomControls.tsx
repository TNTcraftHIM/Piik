import { useEffect, useRef, useState } from "react";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { NumberControl } from "../../components/living/NumberControl";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import { downloadBlob } from "../../lib/download";
import { formatChatTranscript } from "../../lib/room-chat-export";
import type { ChannelMessage, ChannelUser, ChannelRoom, RoomInvitationState, RoomSettings } from "../protocol";
import { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY } from "../protocol";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelAction";
import { ChannelIdentityFields } from "./ChannelIdentity";
import "./channel-room-controls.css";
import { BackupControls } from "./BackupControls";
import { ChannelInviteQrCode } from "./ChannelInviteQrCode";

export function RoomChatExport({ messages, users }: { messages: readonly ChannelMessage[]; users: readonly ChannelUser[] }) {
  const { lang, vis } = useCopy(), zh = lang === "zh";
  return <section className="c3-room-transcript" aria-label={zh ? "文字记录" : "Chat text"}>
    {!vis && <p>{zh ? "导出此页面已加载的文字。" : "Exports the text loaded on this page."}</p>}
    <ChannelAction icon="save" quiet hint="hint-chat-export" label={zh ? "导出文字记录（TXT）" : "Export chat text (TXT)"}
      disabled={!messages.some(message => message.text)} onClick={() => {
        const text = formatChatTranscript(messages.filter(message => message.text).map(message => ({
          occurredAt: message.time,
          sender: { displayName: users.find(user => user.id === message.userId)?.name ?? (zh ? "用户" : "User") },
          payload: { kind: "chat" as const, text: message.text },
        })));
        downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }),
          `piik-chat-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
      }} />
  </section>;
}

function RelayLimit({ value, min, label, note, disabled, onChange }: {
  value: number; min: number; label: string; note: string; disabled: boolean; onChange(value: number): void;
}) {
  const { t, vis } = useCopy();
  return <NumberControl value={value} min={min} max={MAX_RELAY_CAPACITY} step={1} unit={t(value === 1 ? "playback.relayPerson" : "playback.relayPeople")}
    showUnit={!vis} name="relay-capacity" label={label} disabled={disabled} onChange={onChange} className="lr-door-group c3-relay-limit">
    {input => <><div className="lr-quality-heading"><span className="lr-door-glyph"><Glyph name="branch" size={18} />
      {!vis && <span>{label}</span>}</span><Tooltip kind="hint-relay-volunteer" text={vis ? undefined : `${label}\n${note}`}>{input}</Tooltip></div>
      {!vis && <p>{note}</p>}</>}
  </NumberControl>;
}

function PersonalRelay({ channel, room, disabled }: { channel: ChannelController; room: ChannelRoom; disabled: boolean }) {
  const { lang } = useCopy(), zh = lang === "zh";
  const host = room.delivery?.hostSessionId === channel.sessionId;
  const following = room.relayOverride === null;
  const busy = channel.pending.has(`relay:${room.id}`);
  const change = (value: number | null) => { void channel.setRelayOverride(room.id, value).catch(() => {}); };
  const label = zh ? "我的转发上限" : "My forwarding limit";
  const note = host ? (zh ? "房主使用房间默认上限。" : "The room host uses the room default.")
    : (zh ? "只调整我在这个房间的转发。0 表示不帮别人转发，仍可发言和分享。" : "Only changes my forwarding in this room. Zero stops forwarding for others; I can still speak and share.");
  return <section className="c3-room-relay" aria-label={label} aria-busy={busy}>
    <SwitchItem checked={host || following} disabled={disabled || busy || host} icon="branch" hint="hint-relay-volunteer"
      label={zh ? "跟随房间默认" : "Follow room default"} note={note}
      onChange={follow => change(follow ? null : room.relayCapacity)} />
    <RelayLimit value={host || following ? room.relayCapacity : room.relayOverride!} min={0} label={label} note={note}
      disabled={disabled || busy || host || following} onChange={change} />
  </section>;
}

function RoomForm({ room, appHosted, disabled, busy, onSave, onCancel }: {
  room?: ChannelRoom; appHosted: boolean; disabled: boolean; busy: boolean;
  onSave: (settings: RoomSettings) => Promise<unknown>; onCancel(): void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const [name, setName] = useState(room?.name ?? "");
  const [icon, setIcon] = useState(room?.icon ?? "couch");
  const [imageBusy, setImageBusy] = useState(false);
  const [access, setAccess] = useState<RoomSettings["access"]>(room?.access ?? "public");
  const [hidden, setHidden] = useState(room?.hidden ?? false);
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [relayCapacity, setRelayCapacity] = useState(room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY);
  return <form className="c3-room-form" onSubmit={event => {
    event.preventDefault();
    if (!name.trim() || disabled || imageBusy) return;
    void onSave({ name: name.trim(), icon, access, relayCapacity, hidden: access === "private" && hidden,
      ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) }).catch(() => {});
  }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
    {!room && <p>{appHosted
      ? (zh ? "由 App 托管，关闭网页后房间继续运行。" : "Hosted by App. The room keeps running when this page closes.")
      : (zh ? "由此网页托管，关闭网页后房间暂停。" : "Hosted by this page. The room pauses when this page closes.")}</p>}
    <ChannelIdentityFields name={name} icon={icon} label={zh ? "房间名称" : "Room name"}
      disabled={disabled} onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
    <fieldset className="lr-toggle c3-room-access" disabled={disabled}>
      <legend className="visually-hidden">{zh ? "谁可以进入" : "Who can enter"}</legend>
      {(["public", "private"] as const).map(value => <label key={value}>
        <input type="radio" name="access" value={value} checked={access === value} onChange={() => setAccess(value)} />
        <span><Glyph name={value === "public" ? "users" : "lock"} size={18} />
          {value === "public" ? (zh ? "公开" : "Public") : (zh ? "私密" : "Private")}</span>
      </label>)}
    </fieldset>
    <p>{access === "public" ? (zh ? "域内的用户都能进入。" : "Anyone in this domain can enter.")
      : (zh ? "凭房间邀请或密码进入。" : "Enter with a room invitation or password.")}</p>
    {access === "private" && <div className="c3-private-options">
      <label><span>{zh ? "密码（可选）" : "Password (optional)"}</span><input className="c3-input" type="password"
        maxLength={128} autoComplete="new-password" value={password} disabled={disabled || removePassword}
        placeholder={room?.hasPassword ? (zh ? "留空保留现有密码" : "Leave blank to keep the password") : undefined}
        onChange={event => setPassword(event.target.value)} /></label>
      {room?.hasPassword && <label className="c3-check"><input type="checkbox" checked={removePassword} disabled={disabled}
        onChange={event => { setRemovePassword(event.target.checked); setPassword(""); }} />{zh ? "移除密码" : "Remove password"}</label>}
      <label className="c3-check"><input type="checkbox" checked={hidden} disabled={disabled} onChange={event => setHidden(event.target.checked)} />
        {zh ? "对未获准的用户隐藏房间" : "Hide from users without access"}</label>
    </div>}
    <details className="c3-settings-details"><summary>{zh ? "房间默认转发" : "Room forwarding default"}</summary>
    <RelayLimit value={relayCapacity} min={1} label={zh ? "房间默认转发上限" : "Room forwarding default"}
      note={zh ? "房间内默认的转发上限，其他人可以单独调整。" : "The default forwarding limit in this room. Others can adjust their own."}
      disabled={disabled} onChange={setRelayCapacity} /></details>
    <div className="c3-form-actions"><ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} onClick={onCancel} />
      <ChannelAction icon={room ? "check" : "plus"} label={room ? (zh ? "保存" : "Save") : (zh ? "创建房间" : "Create room")}
        primary type="submit" disabled={disabled || imageBusy || !name.trim()} busy={busy} /></div>
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
  const [invitation, setInvitation] = useState<RoomInvitationState | { state: "loading" | "failed" }>({ state: "loading" });
  const [inviteRetry, setInviteRetry] = useState(0);
  const invite = invitation.state === "available" ? invitation.url : "";
  const invitationCopy = useClipboardResult(invite);
  const [backupAvailable, setBackupAvailable] = useState(false);
  const id = room ? "c3-room-settings" : "c3-create-room";
  const title = room ? (zh ? "房间设置" : "Room settings") : (zh ? "创建房间" : "Create room");
  const triggerTitle = room ? (zh ? "房间选项" : "Room options") : title;
  useAnchoredPopover(trigger, panel, { side: "below", align: "end" });
  useEffect(() => { panel.current?.hidePopover(); }, [room?.id]);
  useEffect(() => {
    if (!channel.pending.has("room-backup")) panel.current?.hidePopover();
  }, [room?.id, room?.access]);
  const { getRoomInvite } = channel;
  useEffect(() => {
    let current = true;
    setInvitation({ state: "loading" });
    if (open && room?.canManage && room.access === "private" && room.available && channel.connection === "connected") {
      void getRoomInvite(room.id).then(value => { if (current) setInvitation(value); },
        () => { if (current) setInvitation({ state: "failed" }); });
    }
    return () => { current = false; };
  }, [open, room?.id, room?.access, room?.canManage, room?.available, room?.delivery?.bindingId, channel.connection, getRoomInvite, inviteRetry]);
  useEffect(() => {
    let current = true; setBackupAvailable(false);
    if (open && room?.canManage) void channel.roomBackupAvailable(room.id).then(value => { if (current) setBackupAvailable(value); });
    return () => { current = false; };
  }, [open, room?.id, room?.canManage, room?.delivery?.bindingId, channel.sessionId, channel.appConnected, channel.connection, channel.roomBackupAvailable]);
  const connected = channel.connection === "connected";
  const available = connected && (!room || room.available);
  const busy = channel.pending.has(room ? `room:${room.id}` : "create-room");
  const backupBusy = channel.pending.has("room-backup");
  const removing = !!room && channel.pending.has(`delete:${room.id}`);
  const working = busy || backupBusy || removing;
  const members = room?.members?.filter(userId => userId !== room.creatorId && userId !== channel.state?.channel.ownerId) ?? [];
  const run = (work: Promise<unknown>) => { void work.catch(() => {}); };
  const generateInvitation = room && <ChannelAction icon="link" label={zh ? "生成新邀请" : "Generate new invitation"}
    busy={channel.pending.has(`invite:${room.id}`)} disabled={!available || working || invitation.state === "loading"} hint="hint-rotate-invite"
    onClick={() => run(channel.createRoomInvite(room.id).then(url => setInvitation({ state: "available", url })))} />;
  return <>
    <Tooltip kind={room ? "hint-details" : "hint-create-room"} disabled={open} text={vis ? undefined : triggerTitle}>
      <button ref={trigger} type="button" className="lr-btn is-dense is-quiet" popoverTarget={id}
        aria-label={triggerTitle} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={!connected && !room?.authorized}>
        <Glyph name={room ? "chevron" : "plus"} size={18} />
        {!room && !channel.state?.channel.rooms.length && !vis && <span className="lr-cap">{title}</span>}
      </button>
    </Tooltip>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={title}
      className="lr-anchored-card c3-room-panel" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      {open && <><header className="c3-settings-heading"><h3>{title}</h3>
        <ChannelAction icon="x" iconOnly quiet label={zh ? "关闭" : "Close"} onClick={() => panel.current?.hidePopover()} /></header>
      {room && !room.available && <p>{room.canManage ? (zh ? "房间当前未托管，可以从域中移除。" : "This room is offline. You can remove it from the domain.")
        : (zh ? "房间当前未托管，恢复后可调整转发设置。" : "The room is offline. Forwarding settings will be available when hosting resumes.")}</p>}
      {room && <section className="c3-settings-access" aria-label={zh ? "邀请与访问" : "Invitation and access"}>
        <h4>{zh ? "邀请与访问" : "Invitation and access"}</h4>
        <p>{room.access === "public" ? (zh ? "公开房间，域内用户都可进入。" : "Public room. Anyone in this domain can enter.")
          : room.hasPassword ? (zh ? "私密房间，凭邀请或密码进入。" : "Private room. Enter with an invitation or password.")
            : (zh ? "私密房间，凭邀请进入。" : "Private room. Enter with an invitation.")}
          {room.hidden && (zh ? " 对未获准的用户隐藏。" : " Hidden from users without access.")}</p>
        {room.access === "public" && <p>{zh ? "在房间列表复制域地址或域邀请，并告诉朋友房间名称。" : "Copy the domain address or invitation from the room list and tell friends this room's name."}</p>}
      {room.canManage && room.access === "private" && <section className="c3-room-invitation">
        {available && invitation.state === "loading" && <p role="status">{zh ? "正在读取邀请…" : "Loading invitation…"}</p>}
        {invitation.state === "failed" && <><p role="status">{zh ? "未能读取邀请，请重试。" : "Could not load the invitation. Try again."}</p>
          <ChannelAction icon="refresh" quiet label={zh ? "重试" : "Retry"} onClick={() => setInviteRetry(value => value + 1)} /></>}
        {invitation.state === "missing" && generateInvitation}
        {invitation.state === "unrecoverable" && <p>{zh ? "旧邀请仍有效，但无法取回链接。需要新链接时，请主动生成新邀请。" : "The old invitation still works, but its link cannot be recovered. Generate a new invitation when you need a new link."}</p>}
        {invite && <div className="c3-invite-copy"><input className="c3-input" value={invite} readOnly
          aria-label={zh ? "房间邀请链接" : "Room invitation link"} onFocus={event => event.currentTarget.select()} />
          <ChannelAction icon={invitationCopy.status === "copied" ? "check" : "copy"} iconOnly label={invitationCopy.status === "copied" ? (zh ? "已复制" : "Copied") : (zh ? "复制邀请" : "Copy invitation")}
            hint="hint-copy-invite" onClick={invitationCopy.copy} />
          <ChannelInviteQrCode url={invite} disabled={!available || working}
            label={zh ? "房间邀请二维码" : "Room invitation QR code"} /></div>}
        {(invitation.state === "available" || invitation.state === "unrecoverable") && <details className="c3-settings-details">
          <summary>{zh ? "重置房间邀请" : "Reset room invitation"}</summary>
          <p>{zh ? "生成新邀请会使旧链接失效，已获准的用户保留访问。" : "A new invitation invalidates old links. Existing users keep access."}</p>
          {generateInvitation}
        </details>}
        {members.length > 0 && <details className="c3-room-members">
          <summary>{zh ? "已获准的用户" : "Users with access"}</summary>
          {members.map(userId =>
            <div key={userId}><span>{channel.state?.users.find(user => user.id === userId)?.name ?? (zh ? "用户" : "User")}</span>
              <ChannelAction icon="x" quiet iconOnly label={zh ? "移除房间资格" : "Remove room access"} hint="hint-close"
                busy={channel.pending.has(`revoke:${room.id}:${userId}`)} disabled={!available || working}
                onClick={() => run(channel.revokeRoomAccess(room.id, userId))} /></div>)}
        </details>}
      </section>}</section>}
      {(!room || room.canManage) && <details className="c3-settings-details c3-settings-editor" open={!room || undefined} hidden={!!room && !room.available}>
        <summary>{room ? (zh ? "编辑房间设置" : "Edit room settings") : (zh ? "新房间" : "New room")}</summary>
        <RoomForm key={`form:${room?.delivery?.bindingId ?? room?.id ?? "create"}`} room={room} appHosted={channel.appConnected} disabled={!available || working} busy={busy} onCancel={() => panel.current?.hidePopover()} onSave={async settings => {
          const form = panel.current?.querySelector("form");
          if (room) await channel.updateRoom(room.id, settings);
          else onCreated?.(await channel.createRoom(settings));
          if (panel.current?.matches(":popover-open") && panel.current.querySelector("form") === form) panel.current.hidePopover();
        }} />
      </details>}
      {room?.authorized && <details className="c3-settings-details"><summary>{zh ? "我的转发设置" : "My forwarding settings"}</summary>
        <PersonalRelay channel={channel} room={room} disabled={!available || working} />
      </details>}
      {(!room || room.authorized || room.canManage) && <details className="c3-settings-details"><summary>{room ? (zh ? "文字记录与备份" : "Chat text and backups") : (zh ? "从备份导入房间" : "Import a room backup")}</summary>
        {room?.authorized && <RoomChatExport messages={channel.messagesByRoom[room.id] ?? []} users={channel.state?.users ?? []} />}
        {(!room || room.canManage) && <BackupControls key={room?.id ?? "import"} available={!room || backupAvailable} disabled={!available || busy || removing || (!!room && !backupAvailable)}
          busy={backupBusy} replacing={!!room}
          onExport={room ? () => channel.exportRoomBackup(room.id) : undefined}
          onRestore={async file => {
            const result = await channel.restoreRoomBackup(file, room?.id);
            if (!room) onCreated?.(result.roomId);
            return result;
          }} />}
      </details>}
      {room?.canManage && <section className="c3-room-removal">
        <Btn icon="x" size="dense" quiet tone="danger" busy={removing} disabled={!connected || working}
          title={{ text: room.available ? (zh ? "删除房间" : "Delete room") : (zh ? "从域移除" : "Remove from domain") }}
          cap={{ text: room.available ? (zh ? "删除房间" : "Delete room") : (zh ? "从域移除" : "Remove from domain") }}
          onClick={() => {
            const deleteData = room.available;
            const question = deleteData
              ? (zh ? `删除“${room.name}”及其聊天记录？已下载的文件保留。若托管端已离线，则仅从域中移除。`
                : `Delete “${room.name}” and its chat history? Downloaded files are kept. If hosting has gone offline, only its domain entry will be removed.`)
              : (zh ? `从域中移除“${room.name}”？离线托管端的数据保留。`
                : `Remove “${room.name}” from this domain? Data on its offline host is kept.`);
            if (window.confirm(question)) run(channel.deleteRoom(room.id, deleteData).then(() => panel.current?.hidePopover()));
          }} />
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
