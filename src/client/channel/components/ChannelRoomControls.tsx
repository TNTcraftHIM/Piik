import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SwitchItem } from "../../components/living/primitives";
import { NumberControl } from "../../components/living/NumberControl";
import { AudioBitrateControl } from "../../components/living/QualityPresets";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { downloadBlob } from "../../lib/download";
import { formatChatTranscript } from "../../lib/room-chat-export";
import type { ChannelMessage, ChannelUser, ChannelRoom, RoomCreationPolicy } from "../protocol";
import { MAX_RELAY_CAPACITY } from "../protocol";
import { RoomCreationInterrupted, roomCreationPolicyFor, roomDraft, roomSettings, roomSettingsPatch, type RoomDraft } from "../room-creation";
import { diagnoseChannelFact } from "../../ui/diagnosis";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelAction";
import { ChannelInlineConfirm } from "./ChannelInlineConfirm";
import { ChannelSettingsDialog, ChannelSettingsError, ChannelSettingsTabs } from "./ChannelSettingsDialog";
import { useSettingsAction } from "../../ui/use-settings-action";
import { ChannelIdentityFields } from "./ChannelIdentity";
import { ChannelDiagnosisHelp } from "../../components/ChannelDiagnosisHelp";
import "./channel-room-controls.css";
import { BackupControls, RoomRestoreResult } from "./BackupControls";
import { roomRestoreRecovery, type RoomRestoreRecovery, type NativeRoomOpenReason } from "../hosting-api";
import { messageAuthorName, userProfile } from "../presentation";
import { fileSize, type AttachmentLimits } from "../attachments";
import { protectRoomComposition, useRoomFormFocus } from "./room-form-interaction";
import { readBrowserRoomPersistence } from "../browser-room-persistence";

export function RoomChatExport({ messages, users }: { messages: readonly ChannelMessage[]; users: readonly Pick<ChannelUser, "id" | "name">[] }) {
  const { t } = useCopy();
  const hasText = messages.some(message => message.text);
  return <section className="c3-room-transcript" aria-label={t("room.chat.title")}>
    <p>{t("room.chat.exportNote")}</p>
    {messages.length === 0 && <p role="status">{t("room.chat.nothingLoaded")}</p>}
    <ChannelAction icon="save" quiet label={t("room.chat.export")}
      disabled={!hasText} onClick={() => {
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

function RoomForwardingDefault({ value, disabled, onChange }: { value: number; disabled: boolean; onChange(value: number): void }) {
  const { t } = useCopy();
  const label = t("room.relay.defaultLimit");
  return <NumberControl value={value} min={1} max={MAX_RELAY_CAPACITY} step={1} unit={t(value === 1 ? "room.relay.route" : "room.relay.routes")}
    name="relay-capacity" label={label} disabled={disabled} onChange={onChange} className="lr-door-group c3-relay-limit">
    {input => <><div className="lr-quality-heading"><span className="lr-door-glyph"><Glyph name="branch" size={18} />
      <span>{label}</span></span>{input}</div>
      <p>{t("room.relay.defaultNote")}</p></>}
  </NumberControl>;
}

export function ServiceTransit({ room, enabled, disabled, onChange }: {
  room: ChannelRoom; enabled?: boolean; disabled: boolean; onChange(value: boolean): void;
}) {
  const { t } = useCopy();
  const relay = room.serviceRelay;
  if (!room.canManage || !room.authorized || !room.available || !relay) return null;
  return <section className="c3-room-relay">
    <h4>{t("room.transit.title")}</h4>
    <SwitchItem checked={enabled ?? relay.enabled} disabled={disabled} label={t("room.transit.allow")} onChange={onChange} />
    <p>{t("room.transit.note")}</p>
    {!relay.available && <p role="status">{t("room.transit.unavailable")}</p>}
  </section>;
}

function RoomForm({ value, disabled, busy, imageBusy, onSave, onCancel, createLabel, children }: {
  value: RoomDraft; disabled: boolean; busy: boolean; imageBusy: boolean; onSave(): Promise<unknown>; onCancel(): void;
  createLabel?: string; children: ReactNode;
}) {
  const { t } = useCopy();
  const restoreField = useRoomFormFocus(disabled || busy);
  const canSave = !!value.name.trim() && !disabled && !busy && !imageBusy;
  return <form className="c3-room-form" onKeyDownCapture={protectRoomComposition} onSubmit={event => {
    event.preventDefault();
    if (!canSave) return;
    const restore = restoreField(event.currentTarget);
    // A successful save closes or replaces this form.
    void onSave().then(restore);
  }}>
    {children}
    <div className="c3-form-actions"><ChannelAction icon="x" quiet label={t("room.action.cancel")} onClick={onCancel} />
      <ChannelAction icon={createLabel ? "plus" : "check"} label={createLabel ?? t("room.action.save")}
        primary type="submit" disabled={!canSave} busy={busy} /></div>
  </form>;
}

export function RoomHostingNote({ channel, room }: { channel: ChannelController; room?: ChannelRoom }) {
  const { t } = useCopy();
  const serverHosted = channel.state?.channel.hostingMode === "hosted";
  if (room) {
    if (serverHosted) return t("room.hosting.server");
    if (room.available && room.delivery?.hostSessionId === channel.sessionId && channel.sessionId) {
      return t("room.create.browserHostedNote");
    }
    return t("room.hosting.creatorDevice");
  }
  if (serverHosted) return t("room.create.serverHostedNote");
  return t(channel.appConnected ? "room.create.appHostedNote" : "room.create.browserHostedNote");
}

export function RoomAccessNote({ access }: { access: "public" | "private" | "invite_only" }) {
  const { t } = useCopy();
  if (access === "invite_only") return t("room.settings.inviteOnlyNote");
  return t(access === "public" ? "room.settings.publicNote" : "room.settings.privateNote");
}

function RoomIdentityAndAccess({ room, value, onChange: change, inviteOnly, disabled, imageBusy, onImageBusyChange }: {
  room?: ChannelRoom; value: RoomDraft; onChange(value: Partial<RoomDraft>): void; inviteOnly: boolean;
  disabled: boolean; imageBusy: boolean; onImageBusyChange(value: boolean): void;
}) {
  const { t } = useCopy();
  const { name, icon, access, hidden, password, removePassword } = value;
  return <>
    <ChannelIdentityFields name={name} icon={icon} label={t("room.settings.name")}
      roomPicture={{ value: value.picture === undefined ? room?.picture ?? null : value.picture, onChange: picture => change({ picture }) }}
      disabled={disabled} onName={name => change({ name })} onIcon={icon => change({ icon })} imageBusy={imageBusy} onImageBusyChange={onImageBusyChange} />
    {inviteOnly ? <p><RoomAccessNote access="invite_only" /></p> : <>
      <fieldset className="lr-toggle c3-room-access" disabled={disabled}>
        <legend className="visually-hidden">{t("room.settings.admission")}</legend>
        {(["public", "private"] as const).map(value => <label key={value}>
          <input type="radio" name="access" value={value} checked={access === value}
            onChange={() => change({ access: value, password: "", removePassword: false })} />
          <span><Glyph name={value === "public" ? "users" : "lock"} size={18} />
            {value === "public" ? t("room.settings.public") : t("room.settings.private")}</span>
        </label>)}
      </fieldset>
      <p><RoomAccessNote access={access} /></p>
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
    </>}
  </>;
}

/** Creation and management share the same form and modal surface. */
export function ChannelRoomCreateDialog({ channel, initialName = "", initialInterruption = null, creationPolicy, onCreated, onClose }: {
  channel: ChannelController; initialName?: string; initialInterruption?: RoomCreationInterrupted | null; creationPolicy: RoomCreationPolicy; onCreated(id: string): void; onClose(): void;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const [draft, setDraft] = useState<RoomDraft>(() => ({ ...roomDraft(), name: initialName }));
  const input = useRef<HTMLInputElement>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [copy, setCopy] = useState<{ file: File; retainedFileCount: number } | null>(null), [inspecting, setInspecting] = useState(false);
  const [completed, setCompleted] = useState<"uncached" | "restored-uncached" | RoomRestoreRecovery | RoomCreationInterrupted | null>(initialInterruption);
  const interrupted = completed instanceof RoomCreationInterrupted ? completed : null;
  const [creating, setCreating] = useState(false);
  const connected = channel.connection === "connected";
  const inviteOnly = creationPolicy === "invite_only";
  const serverHosted = channel.state?.channel.hostingMode === "hosted";
  const busy = channel.pending.has("create-room");
  const backupBusy = channel.pending.has("room-backup");
  const canLoadCopy = connected && !busy && !backupBusy && !inspecting && !imageBusy;
  const title = t("room.action.create");
  const interruptedRoomId = interrupted?.roomId;
  const recovered = interruptedRoomId && connected && channel.state?.channel.rooms.some(room =>
    room.id === interruptedRoomId && room.authorized && room.available);
  const disabled = !connected || busy || inspecting || (copy !== null && backupBusy);
  const change = (fields: Partial<RoomDraft>) => setDraft(previous => ({ ...previous, ...fields }));
  return <ChannelSettingsDialog title={title} compact error={error} onClose={onClose}>
      <div className="c3-settings-panels">
        {interrupted ? <div className="c3-backup-confirm">
          <p role="status">{t(recovered ? "room.create.recovered" : interrupted.committed
            ? "room.create.committedReconnect" : "room.create.unconfirmed")}</p>
          {recovered && <ChannelAction icon="couch" primary label={t("room.create.openRecovered")} onClick={() => {
            onCreated(interruptedRoomId);
            onClose();
          }} />}
        </div> : completed ? <RoomRestoreResult onClose={onClose} unconfirmed={completed === "room_restore_unconfirmed"}
          message={t(completed === "room_restore_unconfirmed" ? "channel.error.roomRestoreUnconfirmed"
            : completed === "room_restored_connection_failed" ? "room.create.reconnect"
            : completed === "restored-uncached" ? "room.create.restoredUncached" : "room.create.createdUncached")} />
        : creationPolicy === "owner_only" ? <div className="c3-backup-confirm">
          <p role="status">{t("channel.previewPage.ownerCreatesRooms")}</p>
          <ChannelAction icon="x" quiet label={t("room.action.cancel")} onClick={onClose} />
        </div> : <>
        <section className="c3-room-copy-load">
          <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (!file || !canLoadCopy) return;
            setInspecting(true);
            void run(() => channel.inspectRoomCopy(file), ({ settings: info, retainedFileCount }) => {
              setCopy({ file, retainedFileCount }); setDraft({ ...roomDraft(), ...info, name: info.name ?? initialName, icon: info.icon ?? "couch", access: "private", password: "", hidden: false });
            }).finally(() => setInspecting(false));
          }} />
          <ChannelAction icon="arrowUp" quiet label={t("room.copy.load")}
            disabled={!canLoadCopy} busy={inspecting} onClick={() => input.current?.click()} />
          {copy && <><p>{copy.file.name}</p><p>{t("room.copy.retainedFileCount", { count: String(copy.retainedFileCount) })}</p><p>{t("room.copy.loadNote")}</p>
            <ChannelAction icon="x" quiet label={t("room.copy.remove")} disabled={busy || backupBusy || inspecting} onClick={() => setCopy(null)} /></>}
        </section>
        <RoomForm value={draft} disabled={disabled} busy={creating} imageBusy={imageBusy}
          createLabel={t(copy ? "room.copy.create" : "room.action.create")}
          onCancel={onClose} onSave={() => { const settings = roomSettings(draft, inviteOnly); setCreating(true); return run(async () => {
            try {
              if (copy) return await channel.importRoomCopy(copy.file, settings);
              return { roomId: await channel.createRoom(settings, false), cached: true };
            }
            catch (error) {
              const recovery = error instanceof RoomCreationInterrupted ? error : copy && roomRestoreRecovery(error);
              if (!recovery) throw error;
              setCompleted(recovery);
              return null;
            }
          }, result => { if (result) { onCreated(result.roomId); if (result.cached) onClose(); else setCompleted("uncached"); } }).finally(() => setCreating(false)); }}>
          <p><RoomHostingNote channel={channel} /></p>
          <RoomIdentityAndAccess value={draft} onChange={change} inviteOnly={inviteOnly} disabled={disabled}
            imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
          <details className="c3-settings-details"><summary>{t("room.relay.default")}</summary>
            <RoomForwardingDefault value={draft.relayCapacity} disabled={disabled} onChange={relayCapacity => change({ relayCapacity })} />
          </details>
        </RoomForm>
        {!serverHosted && <details className="c3-settings-details"><summary>{t("room.backup.restore")}</summary>
          {inviteOnly && <p>{t("room.backup.inviteOnlyNote")}</p>}
          <BackupControls onClose={onClose} disabled={!connected || busy} busy={backupBusy} replacing={false}
            onRecovery={setCompleted} onRestore={file => channel.restoreRoomBackup(file)} onRestored={result => {
              if (!result) return;
              onCreated(result.roomId);
              if (result.cached) onClose(); else setCompleted("restored-uncached");
            }} />
        </details>}
        </>}
      </div>
    </ChannelSettingsDialog>;
}

interface RoomSettingsProps {
  channel: ChannelController; room: ChannelRoom; onClose(): void;
  onDelete(deleteData: boolean): Promise<void>; deleteError?: string | null; deleting?: boolean;
}
/** One dialog instance manages the requested room independently of room navigation. */
export function ChannelRoomSettingsDialog({ channel, room, onClose, onDelete, deleteError, deleting }: RoomSettingsProps) {
  return <RoomSettings key={room.id} channel={channel} room={room} onClose={onClose}
    onDelete={onDelete} deleteError={deleteError} deleting={deleting} />;
}
type RoomSettingsTask = "room" | "relay" | "data";

function RoomCopyExport({ channel, roomId, includeFiles, disabled, busy }: {
  channel: ChannelController; roomId: string; includeFiles: boolean; disabled: boolean; busy: boolean;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const [includeRoomInfo, setIncludeRoomInfo] = useState(true);
  const [exporting, setExporting] = useState(false);
  return <section className="c3-backup-controls">
    <h3>{t("room.copy.title")}</h3>
    <p>{t("room.copy.exportNote")}</p>
    <label className="c3-check"><input type="checkbox" checked={includeRoomInfo} disabled={disabled || busy}
      onChange={event => setIncludeRoomInfo(event.target.checked)} />
      {t("room.copy.includeSettings")}</label>
    <ChannelAction icon="save" quiet label={t("room.copy.export")} disabled={disabled || busy} busy={exporting}
      onClick={() => { setExporting(true); void run(signal => channel.exportRoomCopy(roomId, includeRoomInfo, includeFiles, signal), blob => downloadBlob(blob, "piik-room-copy.zip"))
        .finally(() => setExporting(false)); }} />
    <ChannelSettingsError error={error} />
  </section>;
}

function RoomMemberAccess({ channel, roomId, userId, disabled }: {
  channel: ChannelController; roomId: string; userId: string; disabled: boolean;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  return <div className="c3-room-member">
    <div className="c3-room-member-action">
      <span>{userProfile(channel.state, channel.profiles, userId)?.name ?? t("room.common.user")}</span>
      <ChannelAction icon="x" quiet iconOnly danger label={t("room.settings.revokeAccess")} hint="hint-close"
        busy={channel.pending.has(`revoke:${roomId}:${userId}`)} disabled={disabled}
        onClick={() => { void run(() => channel.revokeRoomAccess(roomId, userId, false)); }} />
    </div>
    <ChannelSettingsError error={error} />
    {error && <ChannelDiagnosisHelp diagnosis={{ topic: "manageRoom" }} />}
  </div>;
}

function BrowserRoomPersistence() {
  const { t } = useCopy();
  const [persisted, setPersisted] = useState<boolean | null>();
  useEffect(() => {
    let current = true;
    void readBrowserRoomPersistence().then(value => { if (current) setPersisted(value); });
    return () => { current = false; };
  }, []);
  if (persisted === undefined) return null;
  return <p role="status">{t(persisted === null ? "room.settings.browserStorageUnknown"
    : persisted ? "room.settings.browserStoragePersistent" : "room.settings.browserStorageBestEffort")}</p>;
}

function NativeRoomOpenNotice({ channel, roomId, operator, serverHosted = false }: {
  channel: ChannelController; roomId: string; operator: "app" | "domain"; serverHosted?: boolean;
}) {
  const { t } = useCopy();
  const read = channel.nativeRoomOpenFailure;
  const [reason, setReason] = useState<NativeRoomOpenReason>();
  useEffect(() => {
    const controller = new AbortController();
    void read(roomId, operator, controller.signal).then(value => {
      if (!controller.signal.aborted) setReason(value);
    }).catch(() => {});
    return () => controller.abort();
  }, [read, roomId, operator]);
  const diagnosis = reason && diagnoseChannelFact({ area: "roomOpen", failure: reason });
  if (!diagnosis) return null;
  return <div className="c3-settings-offline" role="status">
    <strong>{t(operator === "app" ? "room.unopened.localOperator" : serverHosted ? "room.unopened.siteServer" : "room.unopened.domainOperator")}</strong>
    <p>{t(diagnosis.message)} {diagnosis.next && t(diagnosis.next)}</p>
  </div>;
}

function RoomSettings({ channel, room, onClose, onDelete, deleteError, deleting }: RoomSettingsProps) {
  const { t } = useCopy();
  const id = useId();
  const { error, run } = useSettingsAction();
  const cacheAction = useSettingsAction();
  const historyAction = useSettingsAction();
  const [draft, setDraft] = useState<Partial<RoomDraft>>({});
  const networkPanel = useRef<HTMLElement>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [task, setTask] = useState<RoomSettingsTask>(room.canManage ? "room" : "relay");
  const [backupAvailable, setBackupAvailable] = useState(false);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [fileLimits, setFileLimits] = useState<AttachmentLimits | null>(null);
  useEffect(() => {
    let current = true; setBackupAvailable(false); setFileLimits(null);
    if (room.canManage) void channel.roomBackupAvailable(room.id).then(value => {
      if (!current) return;
      setBackupAvailable(value);
      if (value) void channel.attachments.limits().then(limits => { if (current) setFileLimits(limits); }).catch(() => {});
    });
    return () => { current = false; };
  }, [room.id, room.canManage, room.delivery?.bindingId, channel.sessionId, channel.appConnected, channel.connection, channel.roomBackupAvailable, channel.attachments]);
  const connected = channel.connection === "connected";
  const site = channel.state?.channel;
  const serverHosted = site?.hostingMode === "hosted";
  const browserHostsRoom = room.canManage && !!channel.sessionId && room.delivery?.hostSessionId === channel.sessionId;
  const deleteData = serverHosted || room.available;
  const deleteQuestion = serverHosted ? "room.settings.confirmHostedDelete" :
    deleteData ? "room.settings.confirmDelete" : "room.settings.confirmRemove";
  const canPurge = room.authorized && (room.canManage || (!!channel.self && channel.self.id === site?.ownerId));
  const inviteOnly = !!site && roomCreationPolicyFor(site, room.creatorId) === "invite_only";
  const openFailure = channel.roomOpenFailures.get(room.id);
  const diagnosis = openFailure && diagnoseChannelFact({ area: "roomOpen", failure: openFailure });
  const inspectNative = connected && room.authorized && !room.available && !!channel.self;
  const available = connected && room.available;
  const busy = channel.pending.has(`room:${room.id}`);
  const backupBusy = channel.pending.has("room-backup");
  const removing = channel.pending.has(`delete:${room.id}`);
  const purging = channel.pending.has(`clear-history:${room.id}`);
  const clearingCache = channel.pending.has(`clear-local-cache:${room.id}`);
  const working = busy || removing;
  const members = room.members?.filter(userId => userId !== room.creatorId) ?? [];
  const [membersError, setMembersError] = useState(false);
  useEffect(() => {
    let current = true; setMembersError(false);
    if (room.canManage && room.members?.length) void channel.loadProfiles(room.members).catch(() => { if (current) setMembersError(true); });
    return () => { current = false; };
  }, [room.id, room.members, room.canManage, channel.loadProfiles, channel.connection]);
  const value = { ...roomDraft(room), ...draft };
  const disabled = !available || working;
  const change = (fields: Partial<RoomDraft>) => setDraft(previous => ({ ...previous, ...fields }));
  const form = { value, disabled, busy, imageBusy, onCancel: onClose, onSave: () => {
    const invalid = networkPanel.current?.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) {
      setTask("relay");
      requestAnimationFrame(() => invalid.reportValidity());
      return Promise.resolve();
    }
    const changes = roomSettingsPatch(draft, room, inviteOnly);
    return Object.keys(changes).length ? run(() => channel.updateRoom(room.id, changes, false), onClose) : Promise.resolve(onClose());
  } };
  const tasks = [
    ...(room.canManage ? [{ value: "room", label: t("room.settings.roomTab"), icon: "couch" } as const] : []),
    ...(room.authorized && room.canManage ? [{ value: "relay", label: t("room.settings.connectionTab"), icon: "branch" } as const] : []),
    ...(room.authorized || room.canManage ? [{ value: "data", label: t("room.settings.recordsTab"), icon: "save" } as const] : []),
  ];
  const selected = tasks.some(value => value.value === task) ? task : tasks[0]?.value;
  return <ChannelSettingsDialog title={room.name} caption={t("room.settings.title")} error={error} onClose={onClose}>
    <div className="c3-settings-body">
      <ChannelSettingsTabs<RoomSettingsTask> id={id} label={t("room.settings.title")} tasks={tasks} selected={selected ?? "room"} onSelect={setTask} />
      <div className="c3-settings-panels">
        {!room.available && (diagnosis ? <div className="c3-settings-offline" role="status">
          {t(diagnosis.message)} <RoomHostingNote channel={channel} room={room} /> <ChannelDiagnosisHelp diagnosis={diagnosis} />
        </div> : <p className="c3-settings-offline">{room.canManage ? t(serverHosted ? "room.settings.offlineHostedManager" : "room.settings.offlineManager")
          : t("room.settings.offlineRelay")} <RoomHostingNote channel={channel} room={room} /></p>)}
        {inspectNative && !serverHosted && channel.self?.id === room.creatorId && channel.appConnected &&
          <NativeRoomOpenNotice key={JSON.stringify(["app", site?.id, channel.self?.id, channel.sessionId, channel.appPort])}
            channel={channel} roomId={room.id} operator="app" />}
        {inspectNative && channel.self?.id === site?.ownerId &&
          <NativeRoomOpenNotice key={JSON.stringify(["domain", site?.id, channel.self?.id, channel.sessionId, serverHosted])}
            channel={channel} roomId={room.id} operator="domain" serverHosted={serverHosted} />}
        {room.canManage && <section id={`${id}-room`} role="tabpanel" aria-labelledby={`${id}-room-tab`} hidden={selected !== "room"}>
          <RoomForm {...form}>
            {room.available && <p><RoomHostingNote channel={channel} room={room} /></p>}
            <RoomIdentityAndAccess room={room} value={value} onChange={change} inviteOnly={inviteOnly} disabled={disabled}
              imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
          </RoomForm>
          {room.access === "private" && members.length > 0 && <details className="c3-room-members">
            <summary>{t("room.settings.members")}</summary>
            {members.map(userId => <RoomMemberAccess key={userId}
              channel={channel} roomId={room.id} userId={userId} disabled={!available || working} />)}
            {membersError && <p role="status">{t("room.settings.profilesFailed")}</p>}
          </details>}
          <section className="c3-room-removal">
            {selected === "room" && <ChannelInlineConfirm key={deleteQuestion} size="dense"
              label={t(deleteData ? "room.action.delete" : "room.action.remove")}
              question={t(deleteQuestion, { name: room.name })}
              busy={removing} disabled={!connected || working || deleting}
              onConfirm={() => { void onDelete(deleteData); }} />}
            <ChannelSettingsError error={deleteError ?? null} />
          </section>
        </section>}
        {room.authorized && room.canManage && <section ref={networkPanel} id={`${id}-relay`} role="tabpanel" aria-labelledby={`${id}-relay-tab`} hidden={selected !== "relay"}>
          <RoomForm {...form}>
            <RoomForwardingDefault value={value.relayCapacity} disabled={disabled} onChange={relayCapacity => change({ relayCapacity })} />
            <AudioBitrateControl purpose="voice" value={value.voiceBitrate ?? room.voiceBitrate}
              disabled={disabled} onChange={voiceBitrate => change({ voiceBitrate })} />
            <ServiceTransit room={room} enabled={draft.allowServiceRelay} disabled={disabled} onChange={allowServiceRelay => change({ allowServiceRelay })} />
          </RoomForm>
        </section>}
        {(room.authorized || room.canManage) && <section id={`${id}-data`} role="tabpanel" aria-labelledby={`${id}-data-tab`} hidden={selected !== "data"}>
          <h3>{t("room.settings.recordsTitle")}</h3>
          {selected === "data" && browserHostsRoom && <BrowserRoomPersistence />}
          {room.authorized && <RoomChatExport messages={channel.messagesByRoom[room.id] ?? []} users={[...(channel.state?.users ?? []), ...channel.profiles.values()]} />}
          {room.authorized && <section className="c3-backup-controls">
            <p>{t("room.settings.localCacheScope")}</p>
            {selected === "data" && <ChannelInlineConfirm label={t("room.settings.clearLocalCache")} danger={false}
              question={t("room.settings.confirmClearLocalCache", { name: room.name })}
              busy={clearingCache} disabled={working || purging}
              onConfirm={() => { void cacheAction.run(() => channel.clearLocalRoomCache(room.id)); }} />}
            <ChannelSettingsError error={cacheAction.error} />
          </section>}
          {canPurge && <div>
            {selected === "data" && <ChannelInlineConfirm label={t("room.chat.purgeHistory")}
              question={t("room.chat.confirmPurgeHistory", { name: room.name })}
              busy={purging} disabled={!available || working}
              onConfirm={() => { void historyAction.run(() => channel.purgeRoomHistory(room.id)); }} />}
            <ChannelSettingsError error={historyAction.error} />
          </div>}
          {room.canManage && backupAvailable && <section className="c3-backup-controls">
            <label className="c3-check"><input type="checkbox" checked={includeFiles} disabled={!available || working}
              onChange={event => setIncludeFiles(event.target.checked)} />{t("room.backup.includeFiles")}</label>
            <p>{t("room.backup.fileScope")}</p>
            {fileLimits && <p>{t("room.backup.fileLimits", { count: String(fileLimits.maxRetainedFiles), size: fileSize(fileLimits.maxRetainedBytes) })}</p>}
          </section>}
          {room.canManage && backupAvailable && <RoomCopyExport channel={channel} roomId={room.id} includeFiles={includeFiles}
            disabled={!available || busy || removing} busy={backupBusy} />}
          {room.canManage && backupAvailable && <h3>{t("room.backup.title")}</h3>}
          {room.canManage && backupAvailable && inviteOnly && <p>{t("room.backup.inviteOnlyNote")}</p>}
          {room.canManage && <BackupControls onClose={onClose} available={backupAvailable} disabled={!available || busy || removing || !backupAvailable}
            busy={backupBusy} onExport={signal => channel.exportRoomBackup(room.id, includeFiles, signal)}
            onRestore={file => channel.restoreRoomBackup(file, room.id)} onRestoreCommitted={() => setDraft({})} />}
        </section>}
      </div>
    </div>
  </ChannelSettingsDialog>;
}
