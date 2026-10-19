import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { RemoteControlRequest } from "../../native/wire";
import type { RemoteControlMode, RemoteInputPlatform } from "../../remote-control/protocol";
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, NameTag, SwitchItem } from "./primitives";
import { FloatingPanel } from "./FloatingPanel";
import { Tooltip } from "./Tooltip";
import "./remote-control.css";

// Form drafts stay here; the App snapshot owns applied authorization.
export function HostRemoteControl({ mode, platform, requests, disabled, onPolicy, onDecide }: {
  mode: RemoteControlMode;
  platform: RemoteInputPlatform;
  requests: (RemoteControlRequest & { name: string })[];
  disabled?: boolean;
  onPolicy: (mode: RemoteControlMode, password?: string) => Promise<void>;
  onDecide: (id: string, allow: boolean) => Promise<void>;
}) {
  const { t, vis } = useCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [surfaceDocument, setSurfaceDocument] = useState<Document | null>(null);
  const detached = Boolean(surfaceDocument && surfaceDocument !== document);
  const [draft, setDraft] = useState(() => mode === "off" ? readRoomPreferences().remoteControlMode : mode);
  const [preparing, setPreparing] = useState(false);
  const [password, setPassword] = useState("");
  const [failedId, setFailedId] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Map<string, symbol>>(() => new Map());
  const latestOperation = useRef<symbol | null>(null);
  const busy = pendingActions.size > 0;
  const pending = requests.filter(request => request.state === "pending").length;
  const controller = requests.find(request => request.state !== "pending");
  useEffect(() => {
    setDraft(mode === "off" ? readRoomPreferences().remoteControlMode : mode);
    setPassword(""); setPreparing(false);
    if (mode !== "off") saveRoomPreferences({ remoteControlMode: mode });
  }, [mode]);
  const perform = async (id: string, operation: () => Promise<void>) => {
    const identity = Symbol();
    latestOperation.current = identity;
    setPendingActions(current => new Map(current).set(id, identity)); setFailedId(null);
    try { await operation(); if (latestOperation.current === identity) setPassword(""); }
    catch { if (latestOperation.current === identity) setFailedId(id === "enable" ? "policy" : id.replace(/^stop:/, "")); }
    finally {
      setPendingActions(current => {
        if (current.get(id) !== identity) return current;
        const next = new Map(current); next.delete(id); return next;
      });
    }
  };
  const applyPolicy = (nextMode: RemoteControlMode, password?: string) => {
    // Cancel the local enable submission without asserting an applied grant.
    if (nextMode === "off") setPendingActions(current => {
      const next = new Map(current); next.delete("enable"); return next;
    });
    return perform(nextMode !== "off" && mode === "off" ? "enable" : "policy", () => onPolicy(nextMode, password));
  };
  return <>
    <span className="lr-remote-trigger">
      <Btn id={`${id}-trigger`} icon="mouse" cap="remote.title"
        title={detached ? "floating.focus" : pending ? "remote.requests" : controller?.state === "suspended" ? "remote.hostFocus" : controller ? "remote.controlling" : "remote.title"} hint={detached ? "hint-window-detach" : "hint-remote-control"}
        tone={mode !== "off" || open ? "on" : undefined}
        popoverTarget={detached ? undefined : id} expanded={open} controls={detached ? undefined : id}
        onClick={detached ? () => surfaceDocument?.defaultView?.focus() : undefined} />
      {pending > 0 && <span className="lr-remote-count" role="status" aria-label={`${t("remote.requests")} · ${pending}`}>{pending}</span>}
    </span>
    {createPortal(<FloatingPanel id={id} trigger={`${id}-trigger`} title={t("remote.title")} icon="mouse" compact anchorOnOpen detachable
      className="lr-remote-panel" onOpenChange={(opened, owner) => {
        setOpen(opened);
        setSurfaceDocument(owner);
        if (!opened) {
          setPassword(""); setPreparing(false);
          setDraft(mode === "off" ? readRoomPreferences().remoteControlMode : mode);
        }
      }}>
      <div className="lr-floating-scroll lr-remote-panel-body">
        <SwitchItem checked={mode !== "off"} label={t("remote.title")} hint="hint-remote-control"
          disabled={mode === "off" && (busy || disabled)}
          onChange={enabled => {
            if (enabled && draft === "password" && !password) setPreparing(true);
            else void applyPolicy(enabled ? draft : "off", enabled && draft === "password" ? password : undefined);
          }} />
        {pendingActions.has("enable") && mode === "off" && <div className="lr-remote-enable-pending" role="status">
          <Glyph name="loader" size={18} className="lr-spin" />
          <Btn icon="x" cap="remote.cancel" title="remote.cancel" hint="hint-remote-stop"
            onClick={() => void applyPolicy("off")} />
        </div>}
        {requests.length > 0 && <div className="lr-remote-requests">
          {[...requests].sort((a, b) => Number(a.state === "pending") - Number(b.state === "pending")).map(request => <div className="lr-remote-request" key={request.id} role="group" aria-label={request.name}>
            <div><NameTag name={request.name} identity={request.peerId} />
              <p><Glyph name={request.state === "suspended" ? "pause" : request.state === "active" ? "mouse" : "clock"} size={14} />
                <span className={vis ? "visually-hidden" : undefined}>{t(request.state === "suspended" ? "remote.hostFocus" : request.state === "active" ? "remote.controlling" : "remote.waiting")}</span></p>
              {failedId === request.id && <p role="alert"><Glyph name="alert" size={14} />
                <span className={vis ? "visually-hidden" : undefined}>{t("remote.decisionFailed")}</span></p>}</div>
            <div className="lr-remote-request-actions">
              <Btn icon="x" title={request.state !== "pending" ? "remote.stop" : "remote.decline"} cap={request.state !== "pending" ? "remote.stop" : "remote.decline"}
                hint="hint-remote-stop" disabled={pendingActions.has(`stop:${request.id}`)} onClick={() => void perform(`stop:${request.id}`, () => onDecide(request.id, false))} />
              {request.state === "pending" && <Btn icon="check" tone="primary" title="remote.allow" cap="remote.allow" hint="hint-remote-control"
                disabled={busy || disabled} onClick={() => void perform(request.id, () => onDecide(request.id, true))} />}
            </div>
          </div>)}
          {!vis && pending > 0 && <p className="lr-remote-note">{t("remote.consent")}</p>}
        </div>}
        {(mode !== "off" || preparing) && <form className="lr-remote-settings" onSubmit={event => {
            event.preventDefault();
            void applyPolicy(draft, draft === "password" ? password : undefined);
          }}>
          {!vis && <span className="lr-remote-field-label">{t("remote.authorization")}</span>}
          <div className="lr-toggle lr-remote-modes" role="group" aria-label={t("remote.authorization")}
            style={{ "--lr-segments": 3, "--lr-selected-index": ["ask", "room", "password"].indexOf(draft) } as CSSProperties}>
            {(["ask", "room", "password"] as const).map((value, index) => <Tooltip key={value}
              kind="hint-remote-control" text={vis ? undefined : t(`remote.help.${value}`)}>
              <button type="button" className={draft === value ? "is-selected" : undefined} aria-pressed={draft === value}
                aria-label={t(`remote.mode.${value}`)} disabled={busy || disabled}
                onClick={() => { setDraft(value); setPassword(""); }}>
                {vis ? <Glyph name={(["check", "users", "key"] as const)[index]} size={18} /> : t(`remote.mode.${value}`)}
              </button>
            </Tooltip>)}
          </div>
          {!vis && <p className="lr-remote-note">{t(`remote.help.${draft}`)}</p>}
          {draft === "password" && <label className="lr-input">
            <Glyph name="key" size={18} />
            <input type="password" autoComplete="new-password" required maxLength={128} value={password} autoFocus={preparing}
              aria-label={t("remote.password")} placeholder={vis ? "" : t("remote.password")}
              disabled={busy || disabled} onChange={event => setPassword(event.target.value)} />
          </label>}
          {(draft !== mode || draft === "password") && <div className="lr-remote-policy-actions">
            {preparing && !busy && <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" onClick={() => {
              setPreparing(false); setPassword(""); setDraft(readRoomPreferences().remoteControlMode);
              (surfaceDocument ?? document).getElementById(id)?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus();
            }} />}
            <Btn icon="check" title="remote.apply" cap="remote.apply" type="submit" tone="primary" size="compact"
              hint="hint-remote-control" disabled={busy || disabled || (draft === "password" && !password)} />
          </div>}
        </form>}
        {failedId === "policy" && <p role="alert"><Glyph name="alert" size={14} />
          <span className={vis ? "visually-hidden" : undefined}>{t(platform === "darwin" && mode === "off" ? "remote.macPermission" : "remote.decisionFailed")}</span></p>}
        {!vis && <p className="lr-remote-note">{t(platform === "linux" && mode === "off" ? "remote.linuxEnable" : "remote.policyLifetime")}</p>}
        {(mode === "room" || mode === "password" || requests.some(request => request.state !== "pending")) && <p className="lr-remote-note">
          {platform === "linux" ? <><Glyph name="mouse" size={14} /> <span className={vis ? "visually-hidden" : undefined}>{t("remote.linuxStop")}</span></>
            : <>{vis ? <Glyph name="keyboard" size={14} /> : t("remote.shortcut")} <kbd>{platform === "darwin" ? "Ctrl + Option + F10" : "Ctrl + Alt + F10"}</kbd></>}
        </p>}
      </div>
    </FloatingPanel>, document.body)}
  </>;
}
