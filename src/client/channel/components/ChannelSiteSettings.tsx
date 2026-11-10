import { useId, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import type { DomainSettings } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog, ChannelSettingsTabs, useSettingsAction } from "./ChannelSettingsDialog";
import { ChannelIdentityFields } from "./ChannelIdentity";
import { BackupControls } from "./BackupControls";
import "./channel-room-controls.css";

/** The actual site owner maintains its identity and hosted metadata. */
export function ChannelSiteSettings({ channel }: { channel: ChannelController }) {
  const { lang } = useCopy(), zh = lang === "zh";
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
  const title = zh ? "站点设置" : "Site settings";
  const close = () => { setOpen(false); setImageBusy(false); };
  const tasks = [
    { value: "site", label: zh ? "站点" : "Site", icon: "globe", hint: "hint-advanced" },
    { value: "backup", label: zh ? "备份" : "Backup", icon: "save", hint: "hint-advanced" },
  ] as const;
  if (!owner) return null;
  return <>
    <Tooltip overflow={{ text: current?.name ?? title, selector: ".lr-cap" }} disabled={open}>
      <Btn icon="chevron" size="dense" quiet title={{ text: title }} cap={{ text: current?.name ?? title }} expanded={open} disabled={disabled}
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
              <ChannelIdentityFields name={name} icon={icon} label={zh ? "站点名称" : "Site name"} disabled={disabled}
                onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
              <div className="c3-form-actions">
                <ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} onClick={close} />
                <ChannelAction icon="check" primary type="submit" label={zh ? "保存" : "Save"} busy={busy} disabled={disabled || imageBusy || !name.trim()} />
              </div>
            </form>
          </section>
          <section id={`${id}-backup`} role="tabpanel" aria-labelledby={`${id}-backup-tab`} hidden={task !== "backup"}>
            <h3>{zh ? "站点备份" : "Site backup"}</h3>
            <BackupControls kind="domain" busy={backupBusy} disabled={unavailable || busy}
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
