import { useId, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import { roomCreationPolicySchema, type RoomCreationPolicy } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog, ChannelSettingsError, ChannelSettingsTabs, useSettingsAction } from "./ChannelSettingsDialog";
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
  const { error, run } = useSettingsAction(open);
  const busy = channel.pending.has("domain"), backupBusy = channel.pending.has("domain-backup");
  const unavailable = !owner || channel.connection !== "connected";
  const disabled = unavailable || busy || backupBusy;
  const resetDraft = () => {
    setName(undefined);
    setIcon(undefined);
    setPolicyDraft(null);
  };
  const title = t("channel.siteSettings.siteSettings");
  const policy = policyDraft ?? current?.roomCreationPolicy ?? "ordinary";
  const close = () => { setOpen(false); setImageBusy(false); setPolicyDraft(null); };
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
    {open && <ChannelSettingsDialog title={current?.name ?? title} caption={current ? title : undefined} error={error} onClose={close}>
      <div className="c3-settings-body">
        <ChannelSettingsTabs<typeof task> id={id} label={title} tasks={tasks} selected={task} onSelect={setTask} />
        <div className="c3-settings-panels">
          <section id={`${id}-site`} role="tabpanel" aria-labelledby={`${id}-site-tab`} hidden={task !== "site"}>
            <form className="c3-room-form" onKeyDown={event => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
            }} onSubmit={event => {
              event.preventDefault();
              if (disabled || imageBusy || !name.trim()) return;
              if (nameDraft === undefined && iconDraft === undefined) { close(); return; }
              setSubmittedForm("site");
              void run(() => channel.updateDomain({ name: nameDraft?.trim(), icon: iconDraft }, false), close);
            }}>
              <ChannelIdentityFields name={name} icon={icon} label={t("channel.siteSettings.siteName")} disabled={disabled}
                onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
              <div className="c3-form-actions">
                <ChannelAction icon="x" quiet label={t("channel.siteSettings.cancel")} onClick={close} />
                <ChannelAction icon="check" primary type="submit" label={t("channel.siteSettings.save")} busy={busy && submittedForm === "site"} disabled={disabled || imageBusy || !name.trim()} />
              </div>
            </form>
          </section>
          <section id={`${id}-rooms`} role="tabpanel" aria-labelledby={`${id}-rooms-tab`} hidden={task !== "rooms"}>
            <form className="c3-room-form" onSubmit={event => {
              event.preventDefault();
              if (disabled || policy === current?.roomCreationPolicy) return;
              setSubmittedForm("rooms");
              void run(() => channel.setRoomCreationPolicy(policy, false), close);
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
                  disabled={disabled || policy === current?.roomCreationPolicy} />
              </div>
            </form>
            {task === "rooms" && <ChannelRoomDirectory channel={channel} disabled={disabled} />}
          </section>
          <section id={`${id}-backup`} role="tabpanel" aria-labelledby={`${id}-backup-tab`} hidden={task !== "backup"}>
            <h3>{t("channel.siteSettings.siteBackup")}</h3>
            <BackupControls run={run} kind="domain" busy={backupBusy} disabled={unavailable || busy}
              onExport={channel.exportDomainBackup} onRestore={async file => {
                try { await channel.restoreDomainBackup(file); resetDraft(); }
                catch (error) {
                  if (error instanceof Error && error.message === "domain_restored_connection_failed") resetDraft();
                  throw error;
                }
              }} />
          </section>
        </div>
      </div>
    </ChannelSettingsDialog>}
  </>;
}

function ChannelRoomDirectory({ channel, disabled }: { channel: ChannelController; disabled: boolean }) {
  const { t, lang } = useCopy();
  const heading = useId();
  const { error, run } = useSettingsAction();
  const directory = channel.state?.channel;
  const deleteData = directory?.hostingMode === "hosted";
  const deletionError = channel.error === "room_data_removal_unconfirmed" || channel.error === "hosted_room_deletion_failed"
    ? channel.error : null;
  const titledRooms = new Map(directory?.rooms.map(room => [room.id, room.name]));
  const rooms = (directory?.managedRoomIds ?? []).map(id => ({ id, name: titledRooms.get(id) }));
  rooms.sort((a, b) => Number(!a.name) - Number(!b.name) ||
    (a.name ?? a.id).localeCompare(b.name ?? b.id, lang) || a.id.localeCompare(b.id));
  return <section className="c3-site-room-directory" aria-labelledby={heading}>
    <h3 id={heading}>{t("channel.siteSettings.roomDirectory")}</h3>
    {rooms.length === 0 ? <p>{t("channel.siteSettings.roomDirectoryEmpty")}</p> :
      <ul>
        {rooms.map(({ id, name }) => {
          const idLabel = t("channel.siteSettings.roomId", { id });
          const duplicateName = name && rooms.some(room => room.id !== id && room.name === name);
          const label = duplicateName ? `${name} · ${idLabel}` : name ?? idLabel;
          const removing = channel.pending.has(`delete:${id}`);
          return <li key={id}>
            <span>{label}</span>
            <Btn icon="x" quiet tone="danger" size="compact" busy={removing} disabled={disabled || removing}
              title={{ text: t(deleteData ? "channel.siteSettings.deleteNamedRoom" : "channel.siteSettings.removeNamedRoom", { name: label }) }}
              cap={{ text: t(deleteData ? "room.action.delete" : "room.action.remove") }} onClick={() => {
                if (window.confirm(t(deleteData ? "room.settings.confirmHostedDelete" : "room.settings.confirmRemove", { name: label })))
                  void run(() => channel.deleteRoom(id, deleteData, false));
              }} />
          </li>;
        })}
      </ul>}
    <ChannelSettingsError error={error ?? deletionError} />
  </section>;
}
