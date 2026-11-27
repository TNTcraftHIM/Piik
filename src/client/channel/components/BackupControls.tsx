import { useRef, useState } from "react";
import { downloadBlob } from "../../lib/download";
import { useCopy } from "../../ui/copy";
import { channelErrorPresentation } from "../../components/error-presentation";
import { roomRestoreRecovery, type RoomRestoreRecovery } from "../hosting-api";
import { ChannelAction } from "./ChannelAction";
import { ChannelSettingsError } from "./ChannelSettingsDialog";
import { useSettingsAction } from "../../ui/use-settings-action";

export function RoomRestoreResult({ message, unconfirmed = false, onClose }: {
  message: string; unconfirmed?: boolean; onClose?: () => void;
}) {
  const { t } = useCopy();
  return <div className="c3-backup-confirm">
    <p role="status">{message}</p>
    {onClose && <ChannelAction icon={unconfirmed ? "x" : "check"} primary label={t(unconfirmed ? "room.action.close" : "room.action.done")} onClick={onClose} />}
  </div>;
}

type RestoreResult = { roomId: string; cached: boolean };

/** File selection and confirmation are shared by backup consumers; the caller owns storage. */
export function BackupControls({ disabled, busy, onExport, onRestore, replacing = true, available = true, kind = "room", onClose, onRecovery, onRestored, onRestoreCommitted }: {
  onRecovery?: (recovery: RoomRestoreRecovery) => void; onClose?: () => void; disabled?: boolean; busy: boolean; available?: boolean; onExport?: (signal: AbortSignal) => Promise<Blob>;
  onRestore(file: File): Promise<RestoreResult | void>; onRestored?: (result: RestoreResult | void) => void; onRestoreCommitted?: () => void; replacing?: boolean; kind?: "room" | "domain";
}) {
  const { t } = useCopy();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [recovery, setRecovery] = useState<RoomRestoreRecovery | null>(null);
  const [message, setMessage] = useState("");
  const { error, run, clearError } = useSettingsAction();
  const [active, setActive] = useState<"export" | "restore" | null>(null);
  const perform = <T,>(operation: "export" | "restore", work: (signal: AbortSignal) => Promise<T>, onSuccess?: (result: T) => void) => {
    setMessage(""); setActive(operation);
    void run(async signal => {
      try { return { result: await work(signal) }; }
      catch (error) {
        if (operation !== "restore") throw error;
        const recovery = roomRestoreRecovery(error);
        if (recovery) return { recovery };
        if (error instanceof Error && error.message === "domain_restored_connection_failed") return { committedError: error };
        throw error;
      }
    }, outcome => {
      if (outcome.recovery) {
        if (outcome.recovery === "room_restored_connection_failed") onRestoreCommitted?.();
        if (onRecovery) onRecovery(outcome.recovery);
        else setRecovery(outcome.recovery);
      } else if (outcome.committedError) {
        onRestoreCommitted?.();
        setFile(null);
        throw outcome.committedError;
      } else onSuccess?.(outcome.result);
    }).finally(() => setActive(null));
  };
  if (recovery) return <RoomRestoreResult
    message={channelErrorPresentation(recovery, t).message ?? ""}
    unconfirmed={recovery === "room_restore_unconfirmed"} onClose={onClose} />;
  if (!available && !file && !message && !error) return null;
  return <section className="c3-backup-controls" aria-label={kind === "domain" ? t("channel.backupControls.siteBackup") : t("channel.backupControls.roomBackup")}>
    <p>{t(kind === "domain" ? "channel.backupControls.siteScopeNote" : "channel.backupControls.roomScopeNote")}</p>
    {available && !file && <div className="c3-backup-actions">
      {onExport && <ChannelAction icon="save" quiet label={kind === "room" ? t("channel.backupControls.exportFullBackup") : t("channel.backupControls.exportBackup")} busy={active === "export"} disabled={disabled || busy || !!active}
        onClick={() => { perform("export", onExport, blob => {
          downloadBlob(blob, `piik-${kind === "domain" ? "site" : "room"}-backup.zip`);
        }); }} />}
      <ChannelAction icon="refresh" quiet label={kind === "room" ? t("channel.backupControls.restoreFullBackup") : t("channel.backupControls.restoreBackup")}
        disabled={disabled || busy || !!active} onClick={() => input.current?.click()} />
    </div>}
    <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => {
      setFile(event.target.files?.[0] ?? null); clearError(); setMessage(""); event.target.value = "";
    }} />
    {file && <div className="c3-backup-confirm"><p>{file.name}</p><p>{kind === "domain"
      ? t("channel.backupControls.confirmSiteRestore") : replacing
      ? t("channel.backupControls.confirmRoomReplace")
      : t("channel.backupControls.confirmRoomRestore")}</p>
      <div className="c3-form-actions"><ChannelAction icon="x" quiet label={t("channel.backupControls.cancel")} disabled={busy || !!active} onClick={() => { setFile(null); clearError(); }} />
        <ChannelAction icon="check" primary label={t("channel.backupControls.confirm")} disabled={disabled || busy || !!active} busy={active === "restore"} onClick={() => { perform("restore", () => onRestore(file), result => {
          onRestoreCommitted?.();
          onRestored?.(result);
          setFile(null);
          setMessage(kind === "domain" ? t("channel.backupControls.siteRestored") : result?.cached ? t("channel.backupControls.roomRestored")
            : t("channel.backupControls.roomRestoredWithoutFiles"));
        }); }} /></div>
    </div>}
    {message && <p role="status">{message}</p>}
    <ChannelSettingsError error={error} />
  </section>;
}
