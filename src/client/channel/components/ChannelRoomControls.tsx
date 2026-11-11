import { useEffect, useId, useState } from "react";
import { Tooltip } from "../../components/living/Tooltip";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { NumberControl } from "../../components/living/NumberControl";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { downloadBlob } from "../../lib/download";
import { formatChatTranscript } from "../../lib/room-chat-export";
import type { ChannelMessage, ChannelUser, ChannelRoom, RoomSettings } from "../protocol";
import { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY } from "../protocol";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog, ChannelSettingsTabs, useSettingsAction, type SettingsAction } from "./ChannelSettingsDialog";
import { ChannelIdentityFields } from "./ChannelIdentity";
import "./channel-room-controls.css";
import { BackupControls } from "./BackupControls";

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

export function PersonalRelay({ channel, room, disabled, run }: { channel: ChannelController; room: ChannelRoom; disabled: boolean; run: SettingsAction }) {
  const { lang } = useCopy(), zh = lang === "zh";
  const host = room.delivery?.hostSessionId === channel.sessionId;
  const following = room.relayOverride === null;
  const busy = channel.pending.has(`relay:${room.id}`);
  const change = (value: number | null) => { void run(() => channel.setRelayOverride(room.id, value, false)); };
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

export type RoomDraft = Pick<RoomSettings, "name" | "icon" | "access" | "hidden"> & { password: string; removePassword: boolean; relayCapacity: number };
export function roomDraft(room?: ChannelRoom): RoomDraft {
  return { name: room?.name ?? "", icon: room?.icon ?? "couch", access: room?.access ?? "public", hidden: room?.hidden ?? false,
    password: "", removePassword: false, relayCapacity: room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY };
}

export function RoomForm({ room, value, onChange, appHosted, disabled, busy, onSave, onCancel }: {
  room?: ChannelRoom; value: RoomDraft; onChange(value: Partial<RoomDraft>): void; appHosted: boolean; disabled: boolean; busy: boolean;
  onSave: (settings: RoomSettings) => Promise<unknown>; onCancel(): void;
}) {
  const { lang } = useCopy();
  const zh = lang === "zh";
  const { name, icon, access, hidden, password, removePassword, relayCapacity } = value;
  const change = onChange;
  const [imageBusy, setImageBusy] = useState(false);
  return <form className="c3-room-form" onSubmit={event => {
    event.preventDefault();
    if (!name.trim() || disabled || imageBusy) return;
    void onSave({ name: name.trim(), icon, access, relayCapacity, hidden: access === "private" && hidden,
      ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) });
  }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
    {!room && <p>{appHosted
      ? (zh ? "由 App 托管，关闭网页后房间继续运行。" : "Hosted by App. The room keeps running when this page closes.")
      : (zh ? "由此网页托管，关闭网页后房间暂停。" : "Hosted by this page. The room pauses when this page closes.")}</p>}
    <ChannelIdentityFields name={name} icon={icon} label={zh ? "房间名称" : "Room name"}
      disabled={disabled} onName={name => change({ name })} onIcon={icon => change({ icon })} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
    <fieldset className="lr-toggle c3-room-access" disabled={disabled}>
      <legend className="visually-hidden">{zh ? "谁可以进入" : "Who can enter"}</legend>
      {(["public", "private"] as const).map(value => <label key={value}>
        <input type="radio" name="access" value={value} checked={access === value}
          onChange={() => change({ access: value, password: "", removePassword: false })} />
        <span><Glyph name={value === "public" ? "users" : "lock"} size={18} />
          {value === "public" ? (zh ? "公开" : "Public") : (zh ? "私密" : "Private")}</span>
      </label>)}
    </fieldset>
    <p>{access === "public" ? (zh ? "所有人都能进入。" : "Anyone can enter.")
      : (zh ? "凭房间邀请或密码进入。" : "Enter with a room invitation or password.")}</p>
    {access === "private" && <div className="c3-private-options">
      <label><span>{zh ? "密码（可选）" : "Password (optional)"}</span><input className="c3-input" type="password"
        maxLength={128} autoComplete="new-password" value={password} disabled={disabled || removePassword}
        placeholder={room?.hasPassword ? (zh ? "留空保留现有密码" : "Leave blank to keep the password") : undefined}
        onChange={event => change({ password: event.target.value })} /></label>
      {room?.hasPassword && <label className="c3-check"><input type="checkbox" checked={removePassword} disabled={disabled}
        onChange={event => { change({ removePassword: event.target.checked, password: "" }); }} />{zh ? "移除密码" : "Remove password"}</label>}
      <label className="c3-check"><input type="checkbox" checked={hidden} disabled={disabled} onChange={event => change({ hidden: event.target.checked })} />
        {zh ? "对未获准的用户隐藏房间" : "Hide from users without access"}</label>
    </div>}
    <details className="c3-settings-details"><summary>{zh ? "房间默认转发" : "Room forwarding default"}</summary>
    <RelayLimit value={relayCapacity} min={1} label={zh ? "房间默认转发上限" : "Room forwarding default"}
      note={zh ? "房间内默认的转发上限，其他人可以单独调整。" : "The default forwarding limit in this room. Others can adjust their own."}
      disabled={disabled} onChange={relayCapacity => change({ relayCapacity })} /></details>
    <div className="c3-form-actions"><ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} onClick={onCancel} />
      <ChannelAction icon={room ? "check" : "plus"} label={room ? (zh ? "保存" : "Save") : (zh ? "创建房间" : "Create room")}
        primary type="submit" disabled={disabled || imageBusy || !name.trim()} busy={busy} /></div>
  </form>;
}

/** Creation and management share the same form and modal surface. */
export function ChannelRoomCreateDialog({ channel, initialName = "", onCreated, onClose }: {
  channel: ChannelController; initialName?: string; onCreated(id: string): void; onClose(): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const { error, run } = useSettingsAction();
  const [draft, setDraft] = useState<RoomDraft>(() => ({ ...roomDraft(), name: initialName }));
  const connected = channel.connection === "connected";
  const busy = channel.pending.has("create-room");
  const backupBusy = channel.pending.has("room-backup");
  const title = zh ? "创建房间" : "Create room";
  return <ChannelSettingsDialog title={title} compact error={error} onClose={onClose}>
      <div className="c3-settings-panels">
        <RoomForm value={draft} onChange={fields => setDraft(previous => ({ ...previous, ...fields }))} appHosted={channel.appConnected} disabled={!connected || busy || backupBusy} busy={busy}
          onCancel={onClose} onSave={settings => run(() => channel.createRoom(settings, false), roomId => {
            onCreated(roomId); onClose();
          })} />
        <details className="c3-settings-details"><summary>{zh ? "从备份导入房间" : "Import a room backup"}</summary>
          <BackupControls disabled={!connected || busy} busy={backupBusy} replacing={false}
            onRestore={async file => {
              const result = await channel.restoreRoomBackup(file);
              onCreated(result.roomId); onClose();
              return result;
            }} />
        </details>
      </div>
    </ChannelSettingsDialog>;
}

/** One dialog instance manages the requested room independently of room navigation. */
export function ChannelRoomSettingsDialog({ channel, room, onClose }: {
  channel: ChannelController; room: ChannelRoom; onClose(): void;
}) {
  return <RoomSettings key={room.id} channel={channel} room={room} onClose={onClose} />;
}
type RoomSettingsTask = "room" | "relay" | "data";

function RoomSettings({ channel, room, onClose }: {
  channel: ChannelController; room: ChannelRoom; onClose(): void;
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const id = useId();
  const { error, run } = useSettingsAction();
  const [draft, setDraft] = useState<RoomDraft | null>(null);
  const [task, setTask] = useState<RoomSettingsTask>(room.canManage ? "room" : "relay");
  const [backupAvailable, setBackupAvailable] = useState(false);
  useEffect(() => {
    let current = true; setBackupAvailable(false);
    if (room.canManage) void channel.roomBackupAvailable(room.id).then(value => { if (current) setBackupAvailable(value); });
    return () => { current = false; };
  }, [room.id, room.canManage, room.delivery?.bindingId, channel.sessionId, channel.appConnected, channel.connection, channel.roomBackupAvailable]);
  const connected = channel.connection === "connected";
  const available = connected && room.available;
  const busy = channel.pending.has(`room:${room.id}`);
  const backupBusy = channel.pending.has("room-backup");
  const removing = channel.pending.has(`delete:${room.id}`);
  const working = busy || backupBusy || removing;
  const members = room.members?.filter(userId => userId !== room.creatorId && userId !== channel.state?.channel.ownerId) ?? [];
  const tasks = [
    ...(room.canManage ? [{ value: "room", label: zh ? "房间" : "Room", icon: "couch", hint: "hint-advanced" } as const] : []),
    ...(room.authorized ? [{ value: "relay", label: zh ? "连接设置" : "Connection settings", icon: "branch", hint: "hint-relay-volunteer" } as const] : []),
    ...(room.authorized || room.canManage ? [{ value: "data", label: zh ? "记录与备份" : "Records and backups", icon: "save", hint: "hint-chat-export" } as const] : []),
  ];
  const selected = tasks.some(value => value.value === task) ? task : tasks[0]?.value;
  return <ChannelSettingsDialog title={room.name} caption={zh ? "房间设置" : "Room settings"} error={error} onClose={onClose}>
    <div className="c3-settings-body">
      <ChannelSettingsTabs<RoomSettingsTask> id={id} label={zh ? "房间设置" : "Room settings"} tasks={tasks} selected={selected ?? "room"} onSelect={setTask} />
      <div className="c3-settings-panels">
        {!room.available && <p className="c3-settings-offline">{room.canManage ? (zh ? "房间当前未托管，可以从列表中移除。" : "This room is offline. You can remove it from the list.")
          : (zh ? "房间当前未托管，恢复后可调整转发设置。" : "The room is offline. Forwarding settings will be available when hosting resumes.")}</p>}
        {room.canManage && <section id={`${id}-room`} role="tabpanel" aria-labelledby={`${id}-room-tab`} hidden={selected !== "room"}>
          <RoomForm room={room} value={draft ?? roomDraft(room)} onChange={fields => setDraft(previous => ({ ...(previous ?? roomDraft(room)), ...fields }))} appHosted={channel.appConnected} disabled={!available || working} busy={busy}
            onCancel={onClose} onSave={settings => run(() => channel.updateRoom(room.id, settings, false), onClose)} />
          {members.length > 0 && <details className="c3-room-members">
            <summary>{zh ? "已获准的用户" : "Users with access"}</summary>
            {members.map(userId =>
              <div key={userId}><span>{channel.state?.users.find(user => user.id === userId)?.name ?? (zh ? "用户" : "User")}</span>
                <ChannelAction icon="x" quiet iconOnly label={zh ? "移除房间资格" : "Remove room access"} hint="hint-close"
                  busy={channel.pending.has(`revoke:${room.id}:${userId}`)} disabled={!available || working}
                  onClick={() => { void run(() => channel.revokeRoomAccess(room.id, userId, false)); }} /></div>)}
          </details>}
        </section>}
        {room.authorized && <section id={`${id}-relay`} role="tabpanel" aria-labelledby={`${id}-relay-tab`} hidden={selected !== "relay"}>
          <h3>{zh ? "连接设置" : "Connection settings"}</h3>
          <PersonalRelay channel={channel} room={room} disabled={!available || working} run={run} />
        </section>}
        {(room.authorized || room.canManage) && <section id={`${id}-data`} role="tabpanel" aria-labelledby={`${id}-data-tab`} hidden={selected !== "data"}>
          <h3>{zh ? "记录与备份" : "Records and backups"}</h3>
          {room.authorized && <RoomChatExport messages={channel.messagesByRoom[room.id] ?? []} users={channel.state?.users ?? []} />}
          {room.canManage && <BackupControls available={backupAvailable} disabled={!available || busy || removing || !backupAvailable}
            busy={backupBusy} onExport={() => channel.exportRoomBackup(room.id)} onRestore={async file => {
              try {
                const result = await channel.restoreRoomBackup(file, room.id);
                setDraft(null);
                return result;
              } catch (error) {
                if (error instanceof Error && error.message === "room_restored_connection_failed") setDraft(null);
                throw error;
              }
            }} />}
          {room.canManage && <section className="c3-room-removal">
            <Btn icon="x" size="dense" quiet tone="danger" busy={removing} disabled={!connected || working}
              title={{ text: room.available ? (zh ? "删除房间" : "Delete room") : (zh ? "从列表移除" : "Remove from list") }}
              cap={{ text: room.available ? (zh ? "删除房间" : "Delete room") : (zh ? "从列表移除" : "Remove from list") }}
              onClick={() => {
                const deleteData = room.available;
                const question = deleteData
                  ? (zh ? `删除“${room.name}”及其聊天记录？已下载的文件保留。若托管端已离线，则仅从列表中移除。`
                    : `Delete “${room.name}” and its chat history? Downloaded files are kept. If hosting has gone offline, only its list entry will be removed.`)
                  : (zh ? `从列表中移除“${room.name}”？离线托管端的数据保留。`
                    : `Remove “${room.name}” from this list? Data on its offline host is kept.`);
                if (window.confirm(question)) void run(() => channel.deleteRoom(room.id, deleteData, false), onClose);
              }} />
          </section>}
        </section>}
      </div>
    </div>
  </ChannelSettingsDialog>;
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
