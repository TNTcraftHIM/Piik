import { useRef, useState } from "react";
import { downloadBlob } from "../../lib/download";
import { useCopy } from "../../ui/copy";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsError, useSettingsAction, type SettingsAction } from "./ChannelSettingsDialog";

/** File selection and confirmation are shared by backup consumers; the caller owns storage. */
export function BackupControls({ disabled, busy, onExport, onRestore, replacing = true, available = true, kind = "room", run: dialogRun }: {
  run?: SettingsAction; disabled?: boolean; busy: boolean; available?: boolean; onExport?: () => Promise<Blob>;
  onRestore(file: File): Promise<{ cached: boolean } | void>; replacing?: boolean; kind?: "room" | "domain";
}) {
  const { lang } = useCopy(), zh = lang === "zh";
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const local = useSettingsAction(!dialogRun);
  const run = dialogRun ?? local.run;
  const [active, setActive] = useState<"export" | "restore" | null>(null);
  const perform = <T,>(operation: "export" | "restore", work: () => Promise<T>, onSuccess?: (result: T) => void) => {
    setMessage(""); setActive(operation);
    void run(async () => {
      try { return await work(); }
      catch (error) {
        if (error instanceof Error && (error.message === "domain_restored_connection_failed" || error.message === "room_restored_connection_failed")) setFile(null);
        throw error;
      }
    }, onSuccess).finally(() => setActive(null));
  };
  if (!available && !file && !message && !local.error) return null;
  return <section className="c3-backup-controls" aria-label={kind === "domain" ? (zh ? "站点备份" : "Site backup") : (zh ? "房间备份" : "Room backup")}>
    {kind === "domain" && <p>{zh ? "站点资料与房间目录。房间记录请分别备份。" : "Site data and the room directory. Back up room records separately."}</p>}
    {available && !file && <div className="c3-backup-actions">
      {onExport && <ChannelAction icon="save" quiet label={kind === "room" ? (zh ? "导出完整备份" : "Export full backup") : (zh ? "导出备份" : "Export backup")} busy={active === "export"} disabled={disabled || busy || !!active}
        onClick={() => { perform("export", async () => {
          downloadBlob(await onExport(), `piik-${kind === "domain" ? "site" : "room"}-backup.zip`);
        }); }} />}
      <ChannelAction icon="refresh" quiet label={kind === "room" ? (zh ? "恢复完整备份" : "Restore full backup") : (zh ? "从备份恢复" : "Restore backup")}
        disabled={disabled || busy || !!active} onClick={() => input.current?.click()} />
    </div>}
    <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => {
      setFile(event.target.files?.[0] ?? null); setMessage(""); event.target.value = "";
    }} />
    {file && <div className="c3-backup-confirm"><p>{file.name}</p><p>{kind === "domain"
      ? (zh ? "恢复会替换当前站点的设置、用户信息和房间目录，并重新连接恢复的站点。房间消息与文件不会随之恢复。" : "Restoring replaces this site’s settings, users and room directory, then reconnects to the restored site. Room messages and files are restored separately.") : replacing
      ? (zh ? "恢复会替换房间设置与消息。" : "Restoring replaces this room’s settings and messages.")
      : (zh ? "恢复原房间及其备份账号。若要使用自己的身份创建新房间，请改为载入房间副本。" : "Restore the original room and its saved account. To create a new room with your own identity, load a room copy instead.")}</p>
      <div className="c3-form-actions"><ChannelAction icon="x" quiet label={zh ? "取消" : "Cancel"} disabled={busy || !!active} onClick={() => setFile(null)} />
        <ChannelAction icon="check" primary label={zh ? "确认" : "Confirm"} disabled={disabled || busy || !!active} busy={active === "restore"} onClick={() => { perform("restore", () => onRestore(file), result => {
          setFile(null);
          setMessage(kind === "domain" ? (zh ? "站点已恢复。" : "Site restored.") : result?.cached ? (zh ? "房间已恢复。" : "Room restored.")
            : (zh ? "房间已恢复，文件未能缓存。" : "Room restored. Files could not be cached."));
        }); }} /></div>
    </div>}
    {message && <p role="status">{message}</p>}
    {!dialogRun && <ChannelSettingsError error={local.error} />}
  </section>;
}
