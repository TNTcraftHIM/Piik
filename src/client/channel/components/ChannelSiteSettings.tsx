import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import { roomCreationPolicySchema, type RoomCreationPolicy } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelInlineConfirm } from "./ChannelInlineConfirm";
import { ChannelSettingsDialog, ChannelSettingsError, ChannelSettingsTabs } from "./ChannelSettingsDialog";
import { useSettingsAction } from "../../ui/use-settings-action";
import { ChannelIdentityFields, ChannelIdentityMark } from "./ChannelIdentity";
import { BackupControls } from "./BackupControls";
import "./channel-room-controls.css";

/** The actual site owner maintains its identity and hosted metadata. */
export function ChannelSiteSettings({ channel }: { channel: ChannelController }) {
  const { t } = useCopy();
  const current = channel.state?.channel ?? null;
  const owner = !!channel.self && current?.ownerId === channel.self.id;
  const id = useId();
  const [nameDraft, setName] = useState<string>();
  const [iconDraft, setIcon] = useState<string>();
  const name = nameDraft ?? current?.name ?? "";
  const icon = iconDraft ?? current?.icon ?? "couch";
  const [open, setOpen] = useState(false), [imageBusy, setImageBusy] = useState(false);
  const [task, setTask] = useState<"site" | "rooms" | "backup">("site");
  const [submittedForm, setSubmittedForm] = useState<"site" | "rooms">();
  const [policyDraft, setPolicyDraft] = useState<RoomCreationPolicy | null>(null);
  const { error: siteError, run: runSiteSave } = useSettingsAction(open);
  const { error: roomsError, run: runRoomsSave } = useSettingsAction(open);
  const busy = channel.pending.has("domain"), backupBusy = channel.pending.has("domain-backup");
  const unavailable = !owner || channel.connection !== "connected";
  const disabled = unavailable || busy || backupBusy;
  const resetSiteDraft = () => {
    setName(undefined);
    setIcon(undefined);
  };
  const resetDraft = () => {
    resetSiteDraft();
    setPolicyDraft(null);
  };
  const title = t("channel.siteSettings.siteSettings");
  const policy = policyDraft ?? current?.roomCreationPolicy ?? "ordinary";
  const policyChanged = policy !== current?.roomCreationPolicy;
  const trimmedName = nameDraft?.trim();
  const changedName = trimmedName === current?.name ? undefined : trimmedName;
  const changedIcon = iconDraft === current?.icon ? undefined : iconDraft;
  const canSaveSite = !disabled && !imageBusy && !!name.trim() &&
    (changedName !== undefined || changedIcon !== undefined);
  const canSaveRooms = !disabled && policyChanged;
  const close = () => { setOpen(false); setPolicyDraft(null); };
  const tasks = [
    { value: "site", label: t("channel.siteSettings.site"), icon: "globe", hint: "hint-advanced" },
    { value: "rooms", label: t("channel.siteSettings.rooms"), icon: "couch" },
    { value: "backup", label: t("channel.siteSettings.backup"), icon: "save", hint: "hint-advanced" },
  ] as const;
  if (!owner) return null;
  return <>
    <Tooltip overflow={{ text: current?.name ?? title, selector: ".lr-cap" }} disabled={open}>
      <Btn icon="chevron" size="dense" quiet title={{ text: title }} cap={{ text: current?.name ?? title }} expanded={open}
        iconOverlay={<ChannelIdentityMark icon={current?.icon ?? "couch"} size={22} />}
        onClick={() => { resetDraft(); setTask("site"); setOpen(true); }} />
    </Tooltip>
    {open && <ChannelSettingsDialog title={current?.name ?? title} caption={current ? title : undefined} error={task === "site" ? siteError : task === "rooms" ? roomsError : null} onClose={close}>
      <div className="c3-settings-body">
        <ChannelSettingsTabs<typeof task> id={id} label={title} tasks={tasks} selected={task} onSelect={setTask} />
        <div className="c3-settings-panels">
          <section id={`${id}-site`} role="tabpanel" aria-labelledby={`${id}-site-tab`} hidden={task !== "site"}>
            <form className="c3-room-form" onKeyDown={event => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
            }} onSubmit={event => {
              event.preventDefault();
              if (!canSaveSite) return;
              setSubmittedForm("site");
              void runSiteSave(() => channel.updateDomain({ name: changedName, icon: changedIcon }, false), resetSiteDraft);
            }}>
              <ChannelIdentityFields name={name} icon={icon} label={t("channel.siteSettings.siteName")} disabled={disabled}
                onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
              <div className="c3-form-actions">
                <ChannelAction icon="x" quiet label={t("channel.siteSettings.cancel")} onClick={close} />
                <ChannelAction icon="check" primary type="submit" label={t("channel.siteSettings.save")} busy={busy && submittedForm === "site"} disabled={!canSaveSite} />
              </div>
            </form>
          </section>
          <section id={`${id}-rooms`} role="tabpanel" aria-labelledby={`${id}-rooms-tab`} hidden={task !== "rooms"}>
            <form className="c3-room-form" onSubmit={event => {
              event.preventDefault();
              if (!canSaveRooms) return;
              setSubmittedForm("rooms");
              void runRoomsSave(() => channel.setRoomCreationPolicy(policy, false), () => setPolicyDraft(null));
            }}>
              <fieldset className="c3-site-creation-options" disabled={disabled}>
                <legend>{t("channel.siteSettings.guestCreation")}</legend>
                {roomCreationPolicySchema.options.map(option => <label className="c3-check" key={option}>
                  <input type="radio" name="roomCreation" checked={policy === option} onChange={() => setPolicyDraft(option)} />
                  {t(`channel.siteSettings.creation.${option}`)}
                </label>)}
              </fieldset>
              <p>{t(`channel.siteSettings.creationNote.${policy}`)}</p>
              <div className="c3-form-actions">
                <ChannelAction icon="x" quiet label={t("channel.siteSettings.cancel")} onClick={close} />
                <ChannelAction icon="check" primary type="submit" label={t("channel.siteSettings.save")} busy={busy && submittedForm === "rooms"}
                  disabled={!canSaveRooms} />
              </div>
            </form>
            {task === "rooms" && <ChannelRoomDirectory channel={channel} disabled={disabled} />}
          </section>
          <section id={`${id}-backup`} role="tabpanel" aria-labelledby={`${id}-backup-tab`} hidden={task !== "backup"}>
            <h3>{t("channel.siteSettings.siteBackup")}</h3>
            <BackupControls kind="domain" busy={backupBusy} disabled={unavailable || busy}
              onExport={channel.exportDomainBackup} onRestore={async file => { await channel.restoreDomainBackup(file); }}
              onRestoreCommitted={resetDraft} />
          </section>
        </div>
      </div>
    </ChannelSettingsDialog>}
  </>;
}

function ChannelRoomDirectory({ channel, disabled }: { channel: ChannelController; disabled: boolean }) {
  const { t, lang } = useCopy();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const directory = channel.state?.channel;
  const deleteData = directory?.hostingMode === "hosted";
  const titledRooms = new Map(directory?.rooms.map(room => [room.id, room.name]));
  const rooms = (directory?.managedRoomIds ?? []).map(id => ({ id, name: titledRooms.get(id) }));
  rooms.sort((a, b) => Number(!a.name) - Number(!b.name) ||
    (a.name ?? a.id).localeCompare(b.name ?? b.id, lang) || a.id.localeCompare(b.id));
  return <section className="c3-site-room-directory" aria-labelledby={headingId}>
    <h3 ref={heading} id={headingId} tabIndex={-1}>{t("channel.siteSettings.roomDirectory")}</h3>
    {rooms.length === 0 ? <p>{t("channel.siteSettings.roomDirectoryEmpty")}</p> :
      <ul>
        {rooms.map(({ id, name }) => {
          const idLabel = t("channel.siteSettings.roomId", { id });
          const duplicateName = name && rooms.some(room => room.id !== id && room.name === name);
          const label = duplicateName ? `${name} · ${idLabel}` : name ?? idLabel;
          return <DirectoryRoom key={id} id={id} label={label} channel={channel} directoryHeading={heading} deleteData={deleteData} disabled={disabled} />;
        })}
      </ul>}
    {channel.errorRoomId && !rooms.some(room => room.id === channel.errorRoomId) && <div>
      <span>{t("channel.siteSettings.roomId", { id: channel.errorRoomId })}</span>
      <ChannelSettingsError error={channel.error} />
    </div>}
  </section>;
}

function DirectoryRoom({ id, label, channel, directoryHeading, deleteData, disabled }: {
  id: string; label: string; channel: ChannelController; directoryHeading: RefObject<HTMLHeadingElement | null>;
  deleteData: boolean; disabled: boolean;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const removing = channel.pending.has(`delete:${id}`);
  const row = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const element = row.current;
    return () => {
      if (element?.contains(element.ownerDocument.activeElement)) directoryHeading.current?.focus();
    };
  }, [directoryHeading]);
  return <li ref={row}>
    <span>{label}</span>
    <ChannelInlineConfirm key={String(deleteData)} label={t(deleteData ? "room.action.delete" : "room.action.remove")}
      accessibleLabel={t(deleteData ? "channel.siteSettings.deleteNamedRoom" : "channel.siteSettings.removeNamedRoom", { name: label })}
      question={t(deleteData ? "room.settings.confirmHostedDelete" : "room.settings.confirmRemove", { name: label })}
      busy={removing} disabled={disabled}
      onConfirm={() => {
        void run(async signal => {
          const result = await channel.deleteRoom(id, deleteData, signal);
          if (deleteData && !result.dataRemoved) throw new Error("room_data_removal_unconfirmed");
        });
      }} />
    <ChannelSettingsError error={error ?? (channel.errorRoomId === id ? channel.error : null)} />
  </li>;
}
