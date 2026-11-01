import { useEffect, useId, useRef, useState } from "react";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import type { ChannelController } from "../types";
import { ChannelAction } from "./ChannelMedia";
import { ChannelIdentityFields } from "./ChannelIdentity";
import { BackupControls } from "./BackupControls";
import "./channel-name-editor.css";
import "./channel-room-controls.css";

export function ChannelDomainControls({ channel }: { channel: ChannelController }) {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const current = channel.state!.channel;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(current.name);
  const [icon, setIcon] = useState(current.icon);
  const [open, setOpen] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const busy = channel.pending.has("domain");
  const backupBusy = channel.pending.has("domain-backup");
  const disabled = channel.connection !== "connected" || busy || backupBusy;
  const title = zh ? "域设置" : "Domain settings";
  useAnchoredPopover(trigger, panel, { side: "below", align: "end" });
  useEffect(() => {
    if (open) { const input = panel.current?.querySelector("input"); input?.focus({ preventScroll: true }); input?.select(); }
  }, [open]);
  return <>
    <span className="c3-edit-action"><Tooltip kind="hint-rename" disabled={open} text={vis ? undefined : title}>
      <button ref={trigger} type="button" className="lr-btn is-dense is-quiet" aria-label={title}
        aria-expanded={open} aria-controls={id} aria-haspopup="dialog" disabled={disabled} popoverTarget={id}
        onClick={() => { setName(current.name); setIcon(current.icon); }}><Glyph name="pencil" size={18} /></button>
    </Tooltip></span>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={title} className="lr-anchored-card c3-room-panel"
      onToggle={event => {
        setOpen(event.newState === "open");
        if (event.newState === "closed") setImageBusy(false);
      }}>
      {open && <><h3>{title}</h3><form className="c3-identity-form" onKeyDown={event => {
        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
      }} onSubmit={event => {
        event.preventDefault();
        if (disabled || imageBusy || !name.trim()) return;
        void channel.updateDomain({ name: name.trim(), icon }).then(() => panel.current?.hidePopover()).catch(() => {});
      }}>
        <ChannelIdentityFields name={name} icon={icon} label={zh ? "域名称" : "Domain name"} disabled={disabled}
          onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
        <div className="c3-form-actions">
          <ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} onClick={() => panel.current?.hidePopover()} />
          <ChannelAction icon="check" primary type="submit" label={zh ? "保存" : "Save"} busy={busy} disabled={disabled || imageBusy || !name.trim()} />
        </div>
      </form>
      <BackupControls kind="domain" busy={backupBusy} disabled={channel.connection !== "connected" || busy}
        onExport={channel.exportDomainBackup} onRestore={channel.restoreDomainBackup} />
      </>}
    </div>
  </>;
}
