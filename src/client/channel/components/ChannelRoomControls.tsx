import { useEffect, useId, useRef, useState } from "react";
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
import { messageAuthorName, userProfile } from "../presentation";

export function RoomChatExport({ messages, users }: { messages: readonly ChannelMessage[]; users: readonly Pick<ChannelUser, "id" | "name">[] }) {
  const { t } = useCopy();
  return <section className="c3-room-transcript" aria-label={t("room.chat.title")}>
    <p>{t("room.chat.exportNote")}</p>
    <ChannelAction icon="save" quiet hint="hint-chat-export" label={t("room.chat.export")}
      disabled={!messages.some(message => message.text)} onClick={() => {
        const text = formatChatTranscript(messages.filter(message => message.text).map(message => ({
          occurredAt: message.time,
          sender: { displayName: messageAuthorName(message, users, t("room.common.user")) },
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
  const { t } = useCopy();
  return <NumberControl value={value} min={min} max={MAX_RELAY_CAPACITY} step={1} unit={t(value === 1 ? "playback.relayPerson" : "playback.relayPeople")}
    name="relay-capacity" label={label} disabled={disabled} onChange={onChange} className="lr-door-group c3-relay-limit">
    {input => <><div className="lr-quality-heading"><span className="lr-door-glyph"><Glyph name="branch" size={18} />
      <span>{label}</span></span><Tooltip kind="hint-relay-volunteer" text={`${label}\n${note}`}>{input}</Tooltip></div>
      <p>{note}</p></>}
  </NumberControl>;
}

export function PersonalRelay({ channel, room, disabled, run }: { channel: ChannelController; room: ChannelRoom; disabled: boolean; run: SettingsAction }) {
  const { t } = useCopy();
  const host = room.delivery?.hostSessionId === channel.sessionId;
  const following = room.relayOverride === null;
  const busy = channel.pending.has(`relay:${room.id}`);
  const change = (value: number | null) => { void run(() => channel.setRelayOverride(room.id, value, false)); };
  const label = t("room.relay.personalLimit");
  const note = host ? t("room.relay.hostNote")
    : t("room.relay.personalNote");
  return <section className="c3-room-relay" aria-label={label} aria-busy={busy}>
    <SwitchItem checked={host || following} disabled={disabled || busy || host} hint="hint-relay-volunteer"
      label={t("room.relay.followDefault")} note={note}
      onChange={follow => change(follow ? null : room.relayCapacity)} />
    <RelayLimit value={host || following ? room.relayCapacity : room.relayOverride!} min={0} label={label} note={note}
      disabled={disabled || busy || host || following} onChange={change} />
  </section>;
}

export type RoomDraft = Pick<RoomSettings, "name" | "icon" | "access" | "hidden" | "voiceBitrate"> & { password: string; removePassword: boolean; relayCapacity: number };
export function roomDraft(room?: ChannelRoom): RoomDraft {
  return { name: room?.name ?? "", icon: room?.icon ?? "couch", access: room?.access ?? "public", hidden: room?.hidden ?? false,
    password: "", removePassword: false, relayCapacity: room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY };
}

export function roomSettings(value: RoomDraft): RoomSettings {
  const { name, icon, access, hidden, password, removePassword, relayCapacity, voiceBitrate } = value;
  return { name: name.trim(), icon, access, relayCapacity, ...(voiceBitrate === undefined ? {} : { voiceBitrate }), hidden: access === "private" && hidden,
    ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}) };
}

export function RoomForm({ room, value, onChange, appHosted, disabled, busy, onSave, onCancel, createLabel }: {
  room?: ChannelRoom; value: RoomDraft; onChange(value: Partial<RoomDraft>): void; appHosted: boolean; disabled: boolean; busy: boolean;
  onSave: (settings: RoomSettings) => Promise<unknown>; onCancel(): void; createLabel?: string;
}) {
  const { t } = useCopy();
  const { name, icon, access, hidden, password, removePassword, relayCapacity } = value;
  const change = onChange;
  const [imageBusy, setImageBusy] = useState(false);
  return <form className="c3-room-form" onSubmit={event => {
    event.preventDefault();
    if (!name.trim() || disabled || imageBusy) return;
    void onSave(roomSettings(value));
  }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
    {!room && <p>{appHosted
      ? t("room.create.appHostedNote")
      : t("room.create.browserHostedNote")}</p>}
    <ChannelIdentityFields name={name} icon={icon} label={t("room.settings.name")}
      disabled={disabled} onName={name => change({ name })} onIcon={icon => change({ icon })} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
    <fieldset className="lr-toggle c3-room-access" disabled={disabled}>
      <legend className="visually-hidden">{t("room.settings.admission")}</legend>
      {(["public", "private"] as const).map(value => <label key={value}>
        <input type="radio" name="access" value={value} checked={access === value}
          onChange={() => change({ access: value, password: "", removePassword: false })} />
        <span><Glyph name={value === "public" ? "users" : "lock"} size={18} />
          {value === "public" ? t("room.settings.public") : t("room.settings.private")}</span>
      </label>)}
    </fieldset>
    <p>{access === "public" ? t("room.settings.publicNote")
      : t("room.settings.privateNote")}</p>
    {access === "private" && <div className="c3-private-options">
      <label><span>{t("room.settings.optionalPassword")}</span><input className="c3-input" type="password"
        maxLength={128} autoComplete="new-password" value={password} disabled={disabled || removePassword}
        placeholder={room?.hasPassword ? t("room.settings.keepPassword") : undefined}
        onChange={event => change({ password: event.target.value })} /></label>
      {room?.hasPassword && <label className="c3-check"><input type="checkbox" checked={removePassword} disabled={disabled}
        onChange={event => { change({ removePassword: event.target.checked, password: "" }); }} />{t("room.settings.removePassword")}</label>}
      <label className="c3-check"><input type="checkbox" checked={hidden} disabled={disabled} onChange={event => change({ hidden: event.target.checked })} />
        {t("room.settings.hidden")}</label>
    </div>}
    <details className="c3-settings-details"><summary>{t("room.relay.default")}</summary>
    <RelayLimit value={relayCapacity} min={1} label={t("room.relay.defaultLimit")}
      note={t("room.relay.defaultNote")}
      disabled={disabled} onChange={relayCapacity => change({ relayCapacity })} /></details>
    <div className="c3-form-actions"><ChannelAction icon="x" quiet label={t("room.action.cancel")} onClick={onCancel} />
      <ChannelAction icon={room ? "check" : "plus"} label={room ? t("room.action.save") : createLabel ?? t("room.action.create")}
        primary type="submit" disabled={disabled || imageBusy || !name.trim()} busy={busy} /></div>
  </form>;
}

/** Creation and management share the same form and modal surface. */
export function ChannelRoomCreateDialog({ channel, initialName = "", onCreated, onClose }: {
  channel: ChannelController; initialName?: string; onCreated(id: string): void; onClose(): void;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const [draft, setDraft] = useState<RoomDraft>(() => ({ ...roomDraft(), name: initialName }));
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<File | null>(null), [inspecting, setInspecting] = useState(false);
  const [completed, setCompleted] = useState<"uncached" | "restored-uncached" | "reconnect" | null>(null);
  const [creating, setCreating] = useState(false);
  const connected = channel.connection === "connected";
  const busy = channel.pending.has("create-room");
  const backupBusy = channel.pending.has("room-backup");
  const title = t("room.action.create");
  return <ChannelSettingsDialog title={title} compact error={error} onClose={onClose}>
      <div className="c3-settings-panels">
        {completed ? <div className="c3-backup-confirm"><p role="status">{completed === "reconnect"
          ? t("room.create.reconnect")
          : completed === "restored-uncached"
          ? t("room.create.restoredUncached")
          : t("room.create.createdUncached")}</p>
          <ChannelAction icon="check" primary label={t("room.action.done")} onClick={onClose} /></div> : <>
        <section className="c3-room-copy-load">
          <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (!file) return;
            setInspecting(true);
            void run(() => channel.inspectRoomCopy(file), info => {
              setCopy(file); setDraft({ ...roomDraft(), ...info, name: info.name ?? initialName, icon: info.icon ?? "couch", access: "private", password: "", hidden: false });
            }).finally(() => setInspecting(false));
          }} />
          <ChannelAction icon="arrowUp" quiet label={t("room.copy.load")}
            disabled={!connected || busy || backupBusy || inspecting} busy={inspecting} onClick={() => input.current?.click()} />
          {copy && <><p>{copy.name}</p><p>{t("room.copy.loadNote")}</p>
            <ChannelAction icon="x" quiet label={t("room.copy.remove")} disabled={busy || backupBusy} onClick={() => setCopy(null)} /></>}
        </section>
        <RoomForm value={draft} onChange={fields => setDraft(previous => ({ ...previous, ...fields }))} appHosted={channel.appConnected} disabled={!connected || busy || backupBusy || inspecting} busy={creating}
          createLabel={copy ? t("room.copy.create") : undefined}
          onCancel={onClose} onSave={settings => { setCreating(true); return run(async () => {
            if (copy) {
              try { return await channel.importRoomCopy(copy, settings); }
              catch (error) {
                if (error instanceof Error && error.message === "room_restored_connection_failed") { setCompleted("reconnect"); return null; }
                throw error;
              }
            }
            return { roomId: await channel.createRoom(settings, false), cached: true };
          }, result => { if (result) { onCreated(result.roomId); if (result.cached) onClose(); else setCompleted("uncached"); } }).finally(() => setCreating(false)); }} />
        <details className="c3-settings-details"><summary>{t("room.backup.restore")}</summary>
          <BackupControls run={run} disabled={!connected || busy} busy={backupBusy} replacing={false}
            onRestore={async file => {
              const result = await channel.restoreRoomBackup(file);
              onCreated(result.roomId);
              if (result.cached) onClose(); else setCompleted("restored-uncached");
              return result;
            }} />
        </details>
        </>}
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

function RoomCopyExport({ channel, roomId, disabled, busy, run }: {
  channel: ChannelController; roomId: string; disabled: boolean; busy: boolean; run: SettingsAction;
}) {
  const { t } = useCopy();
  const [includeRoomInfo, setIncludeRoomInfo] = useState(true);
  const [exporting, setExporting] = useState(false);
  return <section className="c3-backup-controls">
    <h3>{t("room.copy.title")}</h3>
    <p>{t("room.copy.exportNote")}</p>
    <label className="c3-check"><input type="checkbox" checked={includeRoomInfo} disabled={disabled || busy}
      onChange={event => setIncludeRoomInfo(event.target.checked)} />
      {t("room.copy.includeSettings")}</label>
    <ChannelAction icon="save" quiet label={t("room.copy.export")} disabled={disabled || busy} busy={exporting}
      onClick={() => { setExporting(true); void run(async () => downloadBlob(await channel.exportRoomCopy(roomId, includeRoomInfo), "piik-room-copy.zip"))
        .finally(() => setExporting(false)); }} />
  </section>;
}

function RoomSettings({ channel, room, onClose }: {
  channel: ChannelController; room: ChannelRoom; onClose(): void;
}) {
  const { t } = useCopy();
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
  const members = room.members?.filter(userId => userId !== room.creatorId) ?? [];
  const [membersError, setMembersError] = useState(false);
  useEffect(() => {
    let current = true; setMembersError(false);
    if (room.canManage && room.members?.length) void channel.loadProfiles(room.members).catch(() => { if (current) setMembersError(true); });
    return () => { current = false; };
  }, [room.id, room.members, room.canManage, channel.loadProfiles, channel.connection]);
  const tasks = [
    ...(room.canManage ? [{ value: "room", label: t("room.settings.roomTab"), icon: "couch", hint: "hint-advanced" } as const] : []),
    ...(room.authorized ? [{ value: "relay", label: t("room.settings.connectionTab"), icon: "branch", hint: "hint-relay-volunteer" } as const] : []),
    ...(room.authorized || room.canManage ? [{ value: "data", label: t("room.settings.recordsTab"), icon: "save", hint: "hint-chat-export" } as const] : []),
  ];
  const selected = tasks.some(value => value.value === task) ? task : tasks[0]?.value;
  return <ChannelSettingsDialog title={room.name} caption={t("room.settings.title")} error={error} onClose={onClose}>
    <div className="c3-settings-body">
      <ChannelSettingsTabs<RoomSettingsTask> id={id} label={t("room.settings.title")} tasks={tasks} selected={selected ?? "room"} onSelect={setTask} />
      <div className="c3-settings-panels">
        {!room.available && <p className="c3-settings-offline">{room.canManage ? t("room.settings.offlineManager")
          : t("room.settings.offlineRelay")}</p>}
        {room.canManage && <section id={`${id}-room`} role="tabpanel" aria-labelledby={`${id}-room-tab`} hidden={selected !== "room"}>
          <RoomForm room={room} value={draft ?? roomDraft(room)} onChange={fields => setDraft(previous => ({ ...(previous ?? roomDraft(room)), ...fields }))} appHosted={channel.appConnected} disabled={!available || working} busy={busy}
            onCancel={onClose} onSave={settings => run(() => channel.updateRoom(room.id, settings, false), onClose)} />
          {members.length > 0 && <details className="c3-room-members">
            <summary>{t("room.settings.members")}</summary>
            {members.map(userId =>
              <div key={userId}><span>{userProfile(channel.state, channel.profiles, userId)?.name ?? t("room.common.user")}</span>
                <ChannelAction icon="x" quiet iconOnly danger label={t("room.settings.revokeAccess")} hint="hint-close"
                  busy={channel.pending.has(`revoke:${room.id}:${userId}`)} disabled={!available || working}
                  onClick={() => { void run(() => channel.revokeRoomAccess(room.id, userId, false)); }} /></div>)}
            {membersError && <p role="status">{t("room.settings.profilesFailed")}</p>}
          </details>}
          <section className="c3-room-removal">
            <Btn icon="x" size="dense" quiet tone="danger" busy={removing} disabled={!connected || working}
              title={{ text: room.available ? t("room.action.delete") : t("room.action.remove") }}
              cap={{ text: room.available ? t("room.action.delete") : t("room.action.remove") }}
              onClick={() => {
                const deleteData = room.available;
                const question = deleteData
                  ? t("room.settings.confirmDelete", { name: room.name })
                  : t("room.settings.confirmRemove", { name: room.name });
                if (window.confirm(question)) void run(() => channel.deleteRoom(room.id, deleteData, false), onClose);
              }} />
          </section>
        </section>}
        {room.authorized && <section id={`${id}-relay`} role="tabpanel" aria-labelledby={`${id}-relay-tab`} hidden={selected !== "relay"}>
          <h3>{t("room.settings.device")}</h3>
          <PersonalRelay channel={channel} room={room} disabled={!available || working} run={run} />
        </section>}
        {(room.authorized || room.canManage) && <section id={`${id}-data`} role="tabpanel" aria-labelledby={`${id}-data-tab`} hidden={selected !== "data"}>
          <h3>{t("room.settings.recordsTitle")}</h3>
          {room.authorized && <RoomChatExport messages={channel.messagesByRoom[room.id] ?? []} users={[...(channel.state?.users ?? []), ...channel.profiles.values()]} />}
          {room.canManage && backupAvailable && <RoomCopyExport channel={channel} roomId={room.id} run={run}
            disabled={!available || busy || removing} busy={backupBusy} />}
          {room.canManage && backupAvailable && <h3>{t("room.backup.title")}</h3>}
          {room.canManage && <BackupControls run={run} available={backupAvailable} disabled={!available || busy || removing || !backupAvailable}
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
        </section>}
      </div>
    </div>
  </ChannelSettingsDialog>;
}
