import { useRef, useState } from "react";
import { downloadBlob } from "../../lib/download";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelMedia";

/** File selection and confirmation are shared by backup consumers; the caller owns storage. */
export function BackupControls({ disabled, busy, onExport, onRestore, replacing = true, available = true, kind = "room" }: {
  disabled?: boolean; busy: boolean; available?: boolean; onExport?: () => Promise<Blob>;
  onRestore(file: File): Promise<{ cached: boolean } | void>; replacing?: boolean; kind?: "room" | "domain";
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setMessage(""); setFailed(false);
    try { await work(); }
    catch (error) {
      setFailed(true);
      const code = error instanceof Error ? error.message : "";
      setMessage(code === "room_host_conflict" || code === "room_host_unavailable" || code === "stale_backup"
        ? (zh ? "房间的托管者已改变，请重新打开房间设置。" : "The room host changed. Reopen room settings.")
        : code === "backup_identity_required" ? (zh ? "无法使用备份中的账号，请确认这是你在此域的备份。" : "The backup account could not be verified in this domain.")
        : code === "backup_room_mismatch" ? (zh ? "请选择此域、此房间的备份。" : "Choose a backup for this domain and room.")
        : (zh ? "备份操作未完成，请检查文件后重试。" : "The backup operation could not finish. Check the file and try again."));
    }
  };
  if (!available && !file && !message) return null;
  return <section className="c3-backup-controls" aria-label={kind === "domain" ? (zh ? "域备份" : "Domain backup") : (zh ? "房间备份" : "Room backup")}>
    {kind === "domain" && <p>{zh ? "备份包含域配置、权限与房间目录，不包含房间消息或文件。" : "Includes domain settings, access and the room directory, without room messages or files."}</p>}
    {available && !file && <div className="c3-backup-actions">
      {onExport && <ChannelAction icon="save" quiet label={zh ? "导出备份" : "Export backup"} busy={busy} disabled={disabled}
        onClick={() => { void run(async () => {
          downloadBlob(await onExport(), `piik-${kind}-backup.zip`);
        }); }} />}
      <ChannelAction icon="refresh" quiet label={replacing ? (zh ? "从备份恢复" : "Restore backup") : (zh ? "导入房间" : "Import room")}
        disabled={disabled || busy} onClick={() => input.current?.click()} />
    </div>}
    <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => {
      setFile(event.target.files?.[0] ?? null); setMessage(""); setFailed(false); event.target.value = "";
    }} />
    {file && <div className="c3-backup-confirm"><p>{file.name}</p><p>{kind === "domain"
      ? (zh ? "恢复会替换当前域的配置、权限与房间目录，并重新接入恢复的域。房间消息与文件不会随之恢复。" : "Restoring replaces this domain’s settings, access and room directory, then reconnects to the restored domain. Room messages and files are restored separately.") : replacing
      ? (zh ? "恢复会替换房间设置与消息。" : "Restoring replaces this room’s settings and messages.")
      : (zh ? "将导入房间，并使用备份中的房间身份。" : "Import this room using the account saved in its backup.")}</p>
      <div className="c3-form-actions"><ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} disabled={busy} onClick={() => setFile(null)} />
        <ChannelAction icon="check" primary label={zh ? "确认" : "Confirm"} disabled={disabled} busy={busy} onClick={() => { void run(async () => {
          const result = await onRestore(file); setFile(null);
          setMessage(kind === "domain" ? (zh ? "域已恢复。" : "Domain restored.") : result?.cached ? (zh ? "房间已恢复。" : "Room restored.")
            : (zh ? "房间已恢复，文件未能缓存。" : "Room restored. Files could not be cached."));
        }); }} /></div>
    </div>}
    {message && <p className={failed ? "c3-backup-error" : undefined} role={failed ? "alert" : "status"}>{message}</p>}
  </section>;
}
