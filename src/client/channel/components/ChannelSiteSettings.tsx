import { useId, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { DomainSettings } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog, ChannelSettingsTabs, useSettingsAction } from "./ChannelSettingsDialog";
import { ChannelIdentityFields, ChannelIdentityMark } from "./ChannelIdentity";
import { BackupControls } from "./BackupControls";
import "./channel-room-controls.css";

/** The actual site owner maintains its identity and hosted metadata. */
export function ChannelSiteSettings({ channel }: { channel: ChannelController }) {
  const { t } = useCopy();
  const current = channel.state?.channel ?? null;
  const owner = !!channel.self && current?.ownerId === channel.self.id;
  const id = useId();
  const [name, setName] = useState(current?.name ?? "");
  const [icon, setIcon] = useState(current?.icon ?? "couch");
  const [open, setOpen] = useState(false), [imageBusy, setImageBusy] = useState(false);
  const [task, setTask] = useState<"site" | "backup">("site");
  const { error, run } = useSettingsAction(open);
  const busy = channel.pending.has("domain"), backupBusy = channel.pending.has("domain-backup");
  const unavailable = !owner || channel.connection !== "connected";
  const disabled = unavailable || busy || backupBusy;
  const resetDraft = (value: DomainSettings | null) => {
    setName(value?.name ?? ""); setIcon(value?.icon ?? "couch");
  };
  const title = t("channel.siteSettings.siteSettings");
  const close = () => { setOpen(false); setImageBusy(false); };
  const tasks = [
    { value: "site", label: t("channel.siteSettings.site"), icon: "globe", hint: "hint-advanced" },
    { value: "backup", label: t("channel.siteSettings.backup"), icon: "save", hint: "hint-advanced" },
  ] as const;
  if (!owner) return null;
  return <>
    <Tooltip overflow={{ text: current?.name ?? title, selector: ".lr-cap" }} disabled={open}>
      <Btn icon="chevron" size="dense" quiet title={{ text: title }} cap={{ text: current?.name ?? title }} expanded={open} disabled={disabled}
        iconOverlay={<ChannelIdentityMark icon={current?.icon ?? "couch"} size={22} />}
        onClick={() => { resetDraft(current); setTask("site"); setOpen(true); }} />
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
              if (!disabled && !imageBusy && name.trim()) void run(() => channel.updateDomain({ name: name.trim(), icon }, false), close);
            }}>
              <ChannelIdentityFields name={name} icon={icon} label={t("channel.siteSettings.siteName")} disabled={disabled}
                onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
              <div className="c3-form-actions">
                <ChannelAction icon="x" quiet label={t("channel.siteSettings.cancel")} onClick={close} />
                <ChannelAction icon="check" primary type="submit" label={t("channel.siteSettings.save")} busy={busy} disabled={disabled || imageBusy || !name.trim()} />
              </div>
            </form>
          </section>
          <section id={`${id}-backup`} role="tabpanel" aria-labelledby={`${id}-backup-tab`} hidden={task !== "backup"}>
            <h3>{t("channel.siteSettings.siteBackup")}</h3>
            <BackupControls run={run} kind="domain" busy={backupBusy} disabled={unavailable || busy}
              onExport={channel.exportDomainBackup} onRestore={async file => {
                try { resetDraft(await channel.restoreDomainBackup(file)); }
                catch (error) {
                  if (error instanceof Error && error.message === "domain_restored_connection_failed") resetDraft(null);
                  throw error;
                }
              }} />
          </section>
        </div>
      </div>
    </ChannelSettingsDialog>}
  </>;
}
