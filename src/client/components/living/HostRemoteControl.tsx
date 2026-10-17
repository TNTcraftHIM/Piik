import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RemoteControlRequest } from "../../native/wire";
import type { RemoteControlMode, RemoteInputPlatform } from "../../remote-control/protocol";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, Chip, NameTag, SwitchItem } from "./primitives";
import "./floating-panel.css";
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
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(mode === "off" ? "ask" : mode);
  const [password, setPassword] = useState("");
  const [failedId, setFailedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = requests.filter(request => request.state === "pending").length;
  const controller = requests.find(request => request.state !== "pending");
  useEffect(() => { setDraft(mode === "off" ? "ask" : mode); setPassword(""); }, [mode]);
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const menu = panel.current;
    const anchor = trigger.current;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const bottom = top + (viewport?.height ?? innerHeight) - 16;
      if (rect.bottom <= top || rect.top >= bottom) { menu.hidePopover(); return; }
      const below = bottom - rect.bottom - 8;
      const above = rect.top - top - 8;
      const openAbove = below < menu.scrollHeight && above > below;
      menu.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
      menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(top, openAbove ? rect.top - menu.offsetHeight - 8 : rect.bottom + 8)}px`;
      menu.classList.toggle("is-above", openAbove);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);
  const perform = async (id: string, operation: () => Promise<void>) => {
    setBusy(true); setFailedId(null);
    try { await operation(); setPassword(""); }
    catch { setFailedId(id); }
    finally { setBusy(false); }
  };
  return <>
    <span className="lr-remote-trigger" ref={trigger}>
      <Btn icon="mouse" cap="remote.title"
        title={pending ? "remote.requests" : controller?.state === "suspended" ? "remote.hostFocus" : controller ? "remote.controlling" : "remote.title"} hint="hint-remote-control"
        tone={mode !== "off" || open ? "on" : undefined} busy={busy}
        popoverTarget={id} expanded={open} controls={id} />
      {pending > 0 && <span className="lr-remote-count" role="status" aria-label={`${t("remote.requests")} · ${pending}`}>{pending}</span>}
    </span>
    {createPortal(<div id={id} ref={panel} popover="auto" role="dialog" aria-label={t("remote.title")}
      className="lr-floating-surface lr-remote-panel" onToggle={event => {
        if (event.target !== event.currentTarget) return;
        setOpen(event.newState === "open");
        if (event.newState === "closed") { setPassword(""); setDraft(mode === "off" ? "ask" : mode); }
      }}>
      <div className="lr-remote-panel-header">
        <strong><Glyph name="mouse" size={18} />{vis ? null : t("remote.title")}</strong>
        <SwitchItem checked={mode !== "off"} label={t("remote.title")} hint="hint-remote-control"
          disabled={busy || (disabled && mode === "off")}
          onChange={enabled => void perform("policy", () => onPolicy(enabled ? "ask" : "off"))} />
        <button type="button" className="lr-popover-close" aria-label={t("common.close")} popoverTarget={id} popoverTargetAction="hide">
          <Glyph name="x" size={17} />
        </button>
      </div>
      {requests.length > 0 && <div className="lr-remote-requests">
        {requests.map(request => <div className="lr-remote-request" key={request.id} role="group" aria-label={request.name}>
          <div><NameTag name={request.name} identity={request.peerId} />
            <p><Glyph name={request.state === "suspended" ? "pause" : request.state === "active" ? "mouse" : "clock"} size={14} />
              <span className={vis ? "visually-hidden" : undefined}>{t(request.state === "suspended" ? "remote.hostFocus" : request.state === "active" ? "remote.controlling" : "remote.waiting")}</span></p>
            {failedId === request.id && <p role="alert"><Glyph name="alert" size={14} />
              <span className={vis ? "visually-hidden" : undefined}>{t("remote.decisionFailed")}</span></p>}</div>
          <div className="lr-remote-request-actions">
            <Btn icon="x" title={request.state !== "pending" ? "remote.stop" : "remote.decline"} cap={request.state !== "pending" ? "remote.stop" : "remote.decline"}
              hint="hint-remote-stop" disabled={busy} onClick={() => void perform(request.id, () => onDecide(request.id, false))} />
            {request.state === "pending" && <Btn icon="check" tone="primary" title="remote.allow" cap="remote.allow" hint="hint-remote-control"
              disabled={busy || disabled} onClick={() => void perform(request.id, () => onDecide(request.id, true))} />}
          </div>
        </div>)}
        {!vis && pending > 0 && <p className="lr-remote-note">{t("remote.consent")}</p>}
      </div>}
      {mode !== "off" && <form className="lr-remote-settings" onSubmit={event => {
          event.preventDefault();
          void perform("policy", () => onPolicy(draft, draft === "password" ? password : undefined));
        }}>
        <div className="lr-remote-modes" role="group" aria-label={t("remote.authorization")}>
          {(["ask", "room", "password"] as const).map((value, index) => <Chip key={value} selected={draft === value}
            title={t(`remote.mode.${value}`)} hint="hint-remote-control" disabled={busy || disabled}
            onClick={() => { setDraft(value); setPassword(""); }}>
            <Glyph name={(["check", "users", "key"] as const)[index]} size={18} />
            {vis ? null : <span>{t(`remote.mode.${value}`)}</span>}
          </Chip>)}
        </div>
        {!vis && <p className="lr-remote-note">{t(`remote.help.${draft}`)}</p>}
        {(draft !== mode || draft === "password") && <div className="lr-remote-policy-actions">
          {draft === "password" && <label className="lr-input">
            <Glyph name="key" size={18} />
            <input type="password" autoComplete="new-password" required maxLength={128} value={password}
              aria-label={t("remote.password")} placeholder={vis ? "" : t("remote.password")}
              disabled={busy || disabled} onChange={event => setPassword(event.target.value)} />
          </label>}
          <Btn icon="check" title="remote.apply" cap="remote.apply" type="submit" tone="primary"
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
    </div>, document.body)}
  </>;
}
