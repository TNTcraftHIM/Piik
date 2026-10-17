import { useEffect, useState } from "react";
import type { RemoteControlRequest } from "../../native/wire";
import type { RemoteControlMode } from "../../remote-control/protocol";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";
import "./remote-control.css";

// Form drafts stay here; the App snapshot owns applied authorization.
export function HostRemoteControl({ mode, requests, disabled, onPolicy, onDecide }: {
  mode: RemoteControlMode;
  requests: (RemoteControlRequest & { name: string })[];
  disabled?: boolean;
  onPolicy: (mode: RemoteControlMode, password?: string) => Promise<void>;
  onDecide: (id: string, allow: boolean) => Promise<void>;
}) {
  const { t, vis } = useCopy();
  const [draft, setDraft] = useState(mode);
  const [password, setPassword] = useState("");
  const [failedId, setFailedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(mode); setPassword(""); }, [mode]);
  const perform = async (id: string, operation: () => Promise<void>) => {
    setBusy(true); setFailedId(null);
    try { await operation(); setPassword(""); }
    catch { setFailedId(id); }
    finally { setBusy(false); }
  };
  return <section className="lr-remote-approval" aria-label={t("remote.title")}>
    <details className="lr-remote-settings" onToggle={event => {
      if (!event.currentTarget.open) { setPassword(""); setDraft(mode); }
    }}>
      <summary><span><Glyph name="mouse" size={18} />{vis ? null : t("remote.title")}</span>
        <span>{t(`remote.mode.${mode}`)}<Glyph name="chevron" size={16} /></span></summary>
      <form onSubmit={event => {
        event.preventDefault();
        void perform("policy", () => onPolicy(draft, draft === "password" ? password : undefined));
      }}>
        <div className="lr-capture-device">
          <label className="lr-capture-device-controls">
            <select value={draft} aria-label={t("remote.authorization")} disabled={busy || disabled}
              onChange={event => { setDraft(event.target.value as RemoteControlMode); setPassword(""); }}>
              {(["ask", "room", "password"] as const).map(value => <option key={value} value={value}>{t(`remote.mode.${value}`)}</option>)}
            </select>
          </label>
          <small>{t(`remote.help.${draft}`)}</small>
        </div>
        <div className="lr-remote-policy-actions">
          {draft === "password" && <label className="lr-input">
            <Glyph name="key" size={18} />
            <input type="password" autoComplete="new-password" required maxLength={128} value={password}
              aria-label={t("remote.password")} placeholder={vis ? "" : t("remote.password")}
              disabled={busy || disabled} onChange={event => setPassword(event.target.value)} />
          </label>}
          <Btn icon="check" title="remote.apply" cap="remote.apply" type="submit" tone="primary"
            hint="hint-remote-control" disabled={busy || disabled || (draft === "password" && !password)} />
        </div>
        {failedId === "policy" && <p role="alert">{t("remote.decisionFailed")}</p>}
        <p className="lr-remote-note">{t("remote.policyLifetime")}</p>
      </form>
    </details>
    {requests.map(request => <div className="lr-remote-request" key={request.id} role="group" aria-label={request.name}>
      <div><strong>{request.name}</strong>
        <p>{t(request.state === "suspended" ? "remote.hostFocus" : request.state === "active" ? "remote.approved" : "remote.waiting")}</p>
        {failedId === request.id && <p role="alert">{t("remote.decisionFailed")}</p>}</div>
      <div className="lr-remote-request-actions">
        <Btn icon="x" title={request.state !== "pending" ? "remote.stop" : "remote.decline"} cap={request.state !== "pending" ? "remote.stop" : "remote.decline"}
          hint="hint-remote-stop" disabled={busy} onClick={() => void perform(request.id, () => onDecide(request.id, false))} />
        {request.state === "pending" && <Btn icon="check" tone="primary" title="remote.allow" cap="remote.allow" hint="hint-remote-control"
          disabled={busy || disabled} onClick={() => void perform(request.id, () => onDecide(request.id, true))} />}
      </div>
    </div>)}
    {requests.some(request => request.state === "pending") && <p className="lr-remote-note">{t("remote.consent")}</p>}
    {(mode !== "ask" || requests.some(request => request.state !== "pending")) && <p className="lr-remote-note">{t("remote.shortcut")} <kbd>Ctrl + Alt + F10</kbd></p>}
  </section>;
}
