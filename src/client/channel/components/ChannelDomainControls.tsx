import { useEffect, useId, useRef, useState, type ToggleEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { Tooltip } from "../../components/living/Tooltip";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { useClipboardResult } from "../../ui/use-clipboard-result";
import type { ChannelController } from "../types";
import type { DomainSettings } from "../protocol";
import { ChannelAction } from "./ChannelAction";
import { ChannelIdentityFields } from "./ChannelIdentity";
import { BackupControls } from "./BackupControls";
import { ChannelInviteQrCode } from "./ChannelInviteQrCode";
import "./channel-name-editor.css";
import "./channel-room-controls.css";

export function ChannelDomainControls({ channel, triggerSlot }: { channel: ChannelController; triggerSlot: HTMLElement | null }) {
  const { lang, vis } = useCopy();
  const zh = lang === "zh";
  const current = channel.state?.channel ?? null;
  const owner = !!channel.self && current?.ownerId === channel.self.id;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(current?.name ?? "");
  const [icon, setIcon] = useState(current?.icon ?? "couch");
  const [open, setOpen] = useState(false);
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
  const revealTask = (event: ToggleEvent<HTMLDetailsElement>) => {
    if (event.target === event.currentTarget && event.newState === "open" && panel.current?.matches(":popover-open"))
      event.currentTarget.querySelector("summary")?.scrollIntoView({ block: "nearest" });
  };
  useAnchoredPopover(trigger, panel, { side: "below", align: "end" });
  useEffect(() => { if (!owner) setPassword(""); }, [owner]);
  return <>
    {owner && triggerSlot && createPortal(<span className="c3-edit-action"><Tooltip kind="hint-rename" disabled={open} text={vis ? undefined : title}>
      <button ref={trigger} type="button" className="lr-btn is-dense is-quiet" aria-label={title}
        aria-expanded={open} aria-controls={id} aria-haspopup="dialog" disabled={disabled} popoverTarget={id}
        onClick={() => resetDraft(current)}><Glyph name="pencil" size={18} /></button>
    </Tooltip></span>, triggerSlot)}
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={title} className="lr-anchored-card c3-room-panel"
      onToggle={event => {
        if (event.target !== event.currentTarget) return;
        setOpen(event.newState === "open");
        if (event.newState === "closed") { setImageBusy(false); setPassword(""); }
      }}>
      {open && <><header className="c3-settings-heading"><h3>{title}</h3>
        <ChannelAction icon="x" iconOnly quiet hint="hint-close" label={zh ? "关闭" : "Close"} onClick={() => panel.current?.hidePopover()} /></header>
      <details className="c3-settings-details c3-settings-access" name={`${id}-task`} onToggle={revealTask} open>
        <summary>{zh ? "邀请与访问" : "Invitation and access"}</summary>
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
              void channel.resetDomainInvite().then(() => setInviteReset(true)).catch(() => {});
            }} />
          {inviteReset && <p role="status">{zh ? "域邀请已更新，请复制新的邀请。" : "Domain invitation updated. Copy the new invitation."}</p>}
        </details>}
      </details>
      <details className="c3-settings-details c3-settings-editor" name={`${id}-task`} onToggle={revealTask}><summary>{zh ? "编辑域设置" : "Edit domain settings"}</summary>
      <form className="c3-room-form" onKeyDown={event => {
        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
      }} onSubmit={event => {
        event.preventDefault();
        if (disabled || imageBusy || !name.trim()) return;
        void channel.updateDomain({ name: name.trim(), icon, access,
          ...(access === "private" && password ? { password } : removePassword ? { password: null } : {}),
        }).then(() => panel.current?.hidePopover()).catch(() => {});
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
          <ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} onClick={() => panel.current?.hidePopover()} />
          <ChannelAction icon="check" primary type="submit" label={zh ? "保存" : "Save"} busy={busy} disabled={disabled || imageBusy || !name.trim()} />
        </div>
      </form></details>
      <details className="c3-settings-details" name={`${id}-task`} onToggle={revealTask}><summary>{zh ? "域备份" : "Domain backup"}</summary>
      <BackupControls kind="domain" busy={backupBusy} disabled={unavailable || busy || inviteBusy}
        onExport={channel.exportDomainBackup} onRestore={async file => {
          setPassword("");
          try {
            resetDraft(await channel.restoreDomainBackup(file));
          } catch (error) {
            if (error instanceof Error && error.message === "domain_restored_connection_failed") resetDraft(null);
            throw error;
          }
        }} /></details>
      </>}
    </div>
  </>;
}
