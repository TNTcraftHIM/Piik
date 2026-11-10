import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import type { ChannelController } from "../types";
import type { DomainSettings } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsDialog, ChannelSettingsTabs, useSettingsAction } from "./ChannelSettingsDialog";
import { ChannelIdentityFields } from "./ChannelIdentity";
import { BackupControls } from "./BackupControls";
import { ChannelInviteQrCode } from "./ChannelInviteQrCode";
import "./channel-name-editor.css";
import "./channel-room-controls.css";

export function ChannelDomainControls({ channel, triggerSlot, onOpen }: { channel: ChannelController; triggerSlot: HTMLElement | null; onOpen?(): void }) {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const current = channel.state?.channel ?? null;
  const owner = !!channel.self && current?.ownerId === channel.self.id;
  const id = useId();
  const [name, setName] = useState(current?.name ?? "");
  const [icon, setIcon] = useState(current?.icon ?? "couch");
  const [open, setOpen] = useState(false);
  const { error, run } = useSettingsAction(open);
  const [task, setTask] = useState<"domain" | "invitation" | "backup">("domain");
  const [imageBusy, setImageBusy] = useState(false);
  const [access, setAccess] = useState<"public" | "private">(current?.access ?? "private");
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [inviteReset, setInviteReset] = useState(false);
  const invitationCopy = useClipboardResult(channel.inviteURL ?? "");
  const busy = channel.pending.has("domain");
  const inviteBusy = channel.pending.has("domain-invite");
  const backupBusy = channel.pending.has("domain-backup");
  const unavailable = !owner || channel.connection !== "connected";
  const disabled = unavailable || busy || inviteBusy || backupBusy;
  const resetDraft = (value: DomainSettings | null) => {
    setName(value?.name ?? ""); setIcon(value?.icon ?? "couch"); setAccess(value?.access ?? "private");
    setPassword(""); setRemovePassword(false); setInviteReset(false);
  };
  const title = zh ? "域设置" : "Domain settings";
  useEffect(() => { if (!owner) setPassword(""); }, [owner]);
  const close = () => { setOpen(false); setImageBusy(false); setPassword(""); };
  const tasks = [
    { value: "domain", label: zh ? "域" : "Domain", icon: "globe", hint: "hint-advanced" },
    { value: "invitation", label: zh ? "邀请" : "Invitation", icon: "link", hint: "hint-copy-invite" },
    { value: "backup", label: zh ? "备份" : "Backup", icon: "save", hint: "hint-advanced" },
  ] as const;
  return <>
    {owner && triggerSlot && createPortal(<span className="c3-edit-action"><Tooltip kind="hint-advanced" disabled={open} text={vis ? undefined : title}>
      <button type="button" className="lr-btn is-dense is-quiet" aria-label={title}
        aria-expanded={open} aria-haspopup="dialog" disabled={disabled}
        onClick={() => { onOpen?.(); resetDraft(current); setTask("domain"); setOpen(true); }}><Glyph name="sliders" size={18} />{!vis && <span className="lr-cap">{title}</span>}</button>
    </Tooltip></span>, triggerSlot)}
    {open && <ChannelSettingsDialog title={current?.name ?? title} caption={current ? title : undefined} error={error} onClose={close}>
      <div className="c3-settings-body">
        <ChannelSettingsTabs<typeof task> id={id} label={title} tasks={tasks} selected={task} onSelect={setTask} />
        <div className="c3-settings-panels">
          <section id={`${id}-domain`} role="tabpanel" aria-labelledby={`${id}-domain-tab`} hidden={task !== "domain"}>
            <form className="c3-room-form" onKeyDown={event => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
            }} onSubmit={event => {
              event.preventDefault();
              if (disabled || imageBusy || !name.trim()) return;
              void run(() => channel.updateDomain({ name: name.trim(), icon, access,
                ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}),
              }, false), close);
            }}>
              <ChannelIdentityFields name={name} icon={icon} label={zh ? "域名称" : "Domain name"} disabled={disabled}
                onName={setName} onIcon={setIcon} imageBusy={imageBusy} onImageBusyChange={setImageBusy} />
              <fieldset className="lr-toggle c3-room-access" disabled={disabled}>
                <legend className="visually-hidden">{zh ? "谁可以进入域" : "Who can enter this domain"}</legend>
                {(["public", "private"] as const).map(value => <label key={value}>
                  <input type="radio" name="domain-access" value={value} checked={access === value} onChange={() => { setAccess(value); setPassword(""); setRemovePassword(false); }} />
                  <span><Glyph name={value === "public" ? "users" : "lock"} size={18} />
                    {value === "public" ? (zh ? "公开" : "Public") : (zh ? "私密" : "Private")}</span>
                </label>)}
              </fieldset>
              <p>{access === "public" ? (zh ? "任何人都能通过域地址进入。公开时不使用口令。" : "Anyone with the domain address can enter. Public domains do not use a passphrase.")
                : (zh ? "凭域邀请或口令进入。已加入的用户保留访问。" : "Enter with a domain invitation or passphrase. Existing users keep access.")}</p>
              {access === "private" && <div className="c3-private-options">
                <label><span>{zh ? "域口令（可选）" : "Domain passphrase (optional)"}</span>
                  <input className="c3-input" type="password" maxLength={128} autoComplete="new-password" value={password}
                    disabled={disabled || removePassword} placeholder={current?.hasPassword ? (zh ? "留空保留现有口令" : "Leave blank to keep the passphrase") : undefined}
                    onChange={event => setPassword(event.target.value)} /></label>
                {current?.hasPassword && <label className="c3-check"><input type="checkbox" checked={removePassword} disabled={disabled}
                  onChange={event => { setRemovePassword(event.target.checked); setPassword(""); }} />{zh ? "移除域口令" : "Remove domain passphrase"}</label>}
              </div>}
              <div className="c3-form-actions">
                <ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} onClick={close} />
                <ChannelAction icon="check" primary type="submit" label={zh ? "保存" : "Save"} busy={busy} disabled={disabled || imageBusy || !name.trim()} />
              </div>
            </form>
          </section>
          <section id={`${id}-invitation`} role="tabpanel" aria-labelledby={`${id}-invitation-tab`} hidden={task !== "invitation"}>
            <h3>{zh ? "邀请与访问" : "Invitation and access"}</h3>
            <p>{!current ? (zh ? "域连接暂不可用。" : "The domain connection is unavailable.")
              : current.access === "public" ? (zh ? "公开域，任何人可通过域地址进入。" : "Public domain. Anyone with its address can enter.")
                : current.hasPassword ? (zh ? "私密域，凭邀请或口令进入。" : "Private domain. Enter with an invitation or passphrase.")
                  : (zh ? "私密域，凭邀请进入。" : "Private domain. Enter with an invitation.")}</p>
            {channel.inviteURL && <div className="c3-invite-actions">
              <ChannelAction icon={invitationCopy.status === "copied" ? "check" : "copy"}
                label={invitationCopy.status === "copied" ? (zh ? "已复制" : "Copied") : current?.access === "public" ? (zh ? "复制域地址" : "Copy domain address") : (zh ? "复制域邀请" : "Copy domain invitation")}
                disabled={disabled} hint="hint-copy-invite" onClick={invitationCopy.copy} />
              <ChannelInviteQrCode url={channel.inviteURL} disabled={disabled}
                label={current?.access === "public" ? (zh ? "域地址二维码" : "Domain address QR code") : (zh ? "域邀请二维码" : "Domain invitation QR code")} />
            </div>}
            {invitationCopy.status === "failed" && <label className="c3-copy-fallback">{zh ? "请手动复制链接" : "Copy the link manually"}
              <input className="c3-input" readOnly value={channel.inviteURL ?? ""} onFocus={event => event.currentTarget.select()} /></label>}
            {current?.access === "private" && <details className="c3-settings-details">
              <summary>{zh ? "重置域邀请" : "Reset domain invitation"}</summary>
              <p>{zh ? "旧邀请将失效，已加入的用户保留访问。房间邀请不受影响。" : "Old invitations stop working. Existing users keep access. Room invitations are unchanged."}</p>
              <ChannelAction icon="refresh" label={zh ? "生成新域邀请" : "Generate new domain invitation"} hint="hint-rotate-invite"
                disabled={disabled} busy={inviteBusy} onClick={() => {
                  void run(() => channel.resetDomainInvite(false), () => setInviteReset(true));
                }} />
              {inviteReset && <p role="status">{zh ? "域邀请已更新，请复制新的邀请。" : "Domain invitation updated. Copy the new invitation."}</p>}
            </details>}
          </section>
          <section id={`${id}-backup`} role="tabpanel" aria-labelledby={`${id}-backup-tab`} hidden={task !== "backup"}>
            <h3>{zh ? "域备份" : "Domain backup"}</h3>
            <BackupControls kind="domain" busy={backupBusy} disabled={unavailable || busy || inviteBusy}
              onExport={channel.exportDomainBackup} onRestore={async file => {
                setPassword("");
                try {
                  resetDraft(await channel.restoreDomainBackup(file));
                } catch (error) {
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
