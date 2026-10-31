import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { RemoteControlRequest, RemoteStopShortcut } from "../../native/wire";
import type { RemoteControlMode, RemoteInputPlatform } from "../../remote-control/protocol";
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import { useProjectLink } from "../../lib/use-project-link";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, SwitchItem } from "./primitives";
import { RemoteControlRequestCard } from "./RemoteControlRequestCard";
import { FloatingPanel } from "./FloatingPanel";
import { Tooltip } from "./Tooltip";
import { RemoteShortcutSelect } from "./RemoteShortcutSelect";
import "./remote-control.css";

type HostStopShortcut = RemoteStopShortcut & { stopShortcutLabel?: string | null };

// Form drafts stay here; the App snapshot owns applied authorization.
export function HostRemoteControl({ mode, platform, requests, disabled, iconOnly = false, onPolicy, onDecide, onShortcut, stopShortcutLabel, gamepad, simultaneous, onSimultaneous }: {
  mode: RemoteControlMode;
  platform: RemoteInputPlatform;
  requests: (RemoteControlRequest & { name: string })[];
  disabled?: boolean;
  iconOnly?: boolean;
  onPolicy: (mode: RemoteControlMode, password?: string) => Promise<void>;
  onDecide: (id: string, allow: boolean) => Promise<void>;
  onShortcut?: (key?: number) => Promise<HostStopShortcut>;
  stopShortcutLabel?: string | null;
  gamepad?: boolean;
  simultaneous?: boolean;
  onSimultaneous?: (enabled: boolean) => Promise<void>;
}) {
  const { t, vis, lang } = useCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  const gamepadAnchor = lang === "zh" ? "手柄" : "gamepads";
  const gamepadGuide = useProjectLink(`/docs/${lang === "zh" ? "zh/" : ""}remote-control.html#${gamepadAnchor}`,
    `https://github.com/TNTcraftHIM/Piik/blob/main/docs/guide/remote-control${lang === "zh" ? ".zh-CN" : ""}.md#${gamepadAnchor}`, open && mode !== "off" && gamepad !== undefined);
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
  const policyAction = mode !== "off" ? "remote.apply" : draft === "room" ? "remote.enableRoom" : "remote.enable";
  const [shortcut, setShortcut] = useState<HostStopShortcut | null>(null);
  const shortcutUnavailable = mode === "off" && Boolean(onShortcut) && shortcut?.stopShortcutLabel === undefined && !shortcut?.available;
  useEffect(() => {
    if (!open || !onShortcut) return;
    let current = true;
    setShortcut(null);
    // Restore this Site's choice before allowing a new permission request.
    const key = readRoomPreferences().remoteStopKey;
    const load = onShortcut().then(current => mode === "off" && current.stopShortcutLabel === undefined
      ? onShortcut(key).catch(() => ({ key, available: false })) : current);
    void load.then(value => { if (current) setShortcut(value); }, () => { if (current) setShortcut(null); });
    return () => { current = false; };
  }, [open, mode, onShortcut, stopShortcutLabel]);
  useEffect(() => {
    setDraft(mode === "off" ? readRoomPreferences().remoteControlMode : mode);
    setPassword(""); setPreparing(false);
    if (mode !== "off") saveRoomPreferences({ remoteControlMode: mode });
  }, [mode]);
  const perform = async (id: string, operation: (identity: symbol) => Promise<void>) => {
    const identity = Symbol();
    latestOperation.current = identity;
    setPendingActions(current => new Map(current).set(id, identity)); setFailedId(null);
    try { await operation(identity); if (latestOperation.current === identity) setPassword(""); }
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
    return perform(nextMode !== "off" && mode === "off" ? "enable" : "policy", async identity => {
      try {
        if (nextMode !== "off" && onShortcut && shortcut?.stopShortcutLabel !== undefined && !shortcut.available) {
          const registered = await onShortcut(readRoomPreferences().remoteStopKey);
          if (latestOperation.current !== identity) return;
          setShortcut(registered);
          if (!registered.available) throw new Error("input_shortcut_unavailable");
        }
        await onPolicy(nextMode, password);
      }
      finally {
        if (onShortcut && latestOperation.current === identity) {
          const current = await onShortcut().catch(() => null);
          if (latestOperation.current === identity) setShortcut(current);
        }
      }
    });
  };
  return <>
    <span className="lr-remote-trigger">
      <Btn id={`${id}-trigger`} icon="mouse" cap={iconOnly ? undefined : "remote.title"}
        title={detached ? "floating.focus" : pending ? "remote.requests" : controller?.state === "suspended" ? "remote.hostFocus" : controller ? "remote.controlling" : "remote.title"} hint={detached ? "hint-window-detach" : "hint-remote-control"}
        tone={mode !== "off" || open ? "on" : undefined}
        popoverTarget={detached ? undefined : id} expanded={open} controls={detached ? undefined : id}
        onClick={detached ? () => surfaceDocument?.defaultView?.focus() : undefined} />
      {pending > 0 && <span className="lr-remote-count" role="status" aria-label={`${t("remote.requests")}: ${pending}`}>{pending}</span>}
    </span>
    {createPortal(<FloatingPanel id={id} trigger={`${id}-trigger`} title={t("remote.title")} icon="mouse" compact anchorOnOpen detachable
      className="lr-remote-panel" onOpenChange={(opened, owner) => {
        setOpen(opened);
        setSurfaceDocument(owner);
        if (!opened) {
          setShortcut(null);
          setPassword(""); setPreparing(false);
          setDraft(mode === "off" ? readRoomPreferences().remoteControlMode : mode);
        }
      }}>
      <div className="lr-floating-scroll lr-remote-panel-body">
        <SwitchItem checked={mode !== "off"} label={t("remote.title")} icon="mouse" hint="hint-remote-control"
          disabled={mode === "off" && (busy || disabled || shortcutUnavailable)}
          onChange={enabled => {
            // A remembered automatic grant is not consent for this audience.
            if (enabled && (draft === "room" || draft === "password" && !password)) setPreparing(true);
            else void applyPolicy(enabled ? draft : "off", enabled && draft === "password" ? password : undefined);
          }} />
        {mode !== "off" && onSimultaneous && simultaneous !== undefined && <>
          <SwitchItem checked={simultaneous} label={t("remote.simultaneous")} icon="users" hint="hint-remote-control"
            note={t("remote.simultaneousHelp")} disabled={busy || disabled}
            onChange={enabled => void perform("simultaneous", () => onSimultaneous(enabled))} />
          {failedId === "simultaneous" && <p role="alert"><Glyph name="alert" size={14} />
            <span className={vis ? "visually-hidden" : undefined}>{t("remote.decisionFailed")}</span></p>}
        </>}
        {mode !== "off" && gamepad !== undefined && <p className="lr-remote-note">
            <Glyph name="gamepad" size={14} />{" "}
            {gamepad && <span className={vis ? "visually-hidden" : undefined}>{t("remote.gamepadHostHelp")} </span>}
            <Tooltip kind="hint-remote-control" text={vis ? undefined : t("remote.gamepadSetup")}>
              <a href={gamepadGuide} target="_blank" rel="noopener noreferrer" aria-label={t("remote.gamepadSetup")}>
                {vis ? <Glyph name="help" size={16} /> : t("remote.gamepadSetup")}
              </a>
            </Tooltip>
        </p>}
        {pendingActions.has("enable") && mode === "off" && <div className="lr-remote-enable-pending" role="status">
          <Glyph name="loader" size={18} className="lr-spin" />
          <Btn icon="x" cap="remote.cancel" title="remote.cancel" hint="hint-remote-stop"
            onClick={() => void applyPolicy("off")} />
        </div>}
        {requests.length > 0 && <div className="lr-remote-requests">
          {[...requests].sort((a, b) => Number(a.state === "pending") - Number(b.state === "pending")).map(request =>
            <RemoteControlRequestCard key={request.id} name={request.name} peerId={request.peerId}
              state={request.state} failed={failedId === request.id}
              decisionDisabled={busy || disabled} stopDisabled={pendingActions.has(`stop:${request.id}`)}
              onAllow={() => void perform(request.id, () => onDecide(request.id, true))}
              onDecline={() => void perform(`stop:${request.id}`, () => onDecide(request.id, false))}
              onStop={() => void perform(`stop:${request.id}`, () => onDecide(request.id, false))} />)}
          {!vis && requests.some(request => request.state === "pending") && <p className="lr-remote-note">{t("remote.consent")}</p>}
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
            {preparing && !busy && <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" hint="hint-close" onClick={() => {
              setPreparing(false); setPassword(""); setDraft(readRoomPreferences().remoteControlMode);
              (surfaceDocument ?? document).getElementById(id)?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus();
            }} />}
            <Btn icon="check" title={policyAction} cap={policyAction}
              type="submit" tone="primary" size="compact" hint="hint-remote-control" hintText={`remote.help.${draft}`}
              disabled={busy || disabled || shortcutUnavailable || (draft === "password" && !password)} />
          </div>}
        </form>}
        {failedId === "policy" && <p role="alert"><Glyph name="alert" size={14} />
          <span className={vis ? "visually-hidden" : undefined}>{t(platform === "darwin" && mode === "off" ? "remote.macPermission" : "remote.decisionFailed")}</span></p>}
        {!vis && <p className="lr-remote-note">{t(platform === "linux" && mode === "off" ? "remote.linuxEnable" : "remote.policyLifetime")}</p>}
        {onShortcut && shortcut && <>
          <RemoteShortcutSelect host mac={platform === "darwin"} value={shortcut.key} disabled={busy || disabled}
            actualLabel={shortcut.stopShortcutLabel}
            onChange={key => void perform("shortcut", async () => {
              setShortcut(await onShortcut(key));
              saveRoomPreferences({ remoteStopKey: key });
            })} />
          {((!shortcut.available && shortcut.stopShortcutLabel === undefined) || failedId === "shortcut") && <p role="alert"><Glyph name="alert" size={14} />
            <span className={vis ? "visually-hidden" : undefined}>{t("remote.shortcutFailed")}</span></p>}
        </>}
        {!onShortcut && (mode === "room" || mode === "password" || requests.some(request => request.state !== "pending")) && <p className="lr-remote-note">
          {platform === "linux" ? <><Glyph name="mouse" size={14} /> <span className={vis ? "visually-hidden" : undefined}>{t("remote.linuxStop")}</span></>
            : <>{vis ? <Glyph name="keyboard" size={14} /> : t("remote.shortcut")} <kbd>{platform === "darwin" ? "Ctrl + Option + F10" : "Ctrl + Alt + F10"}</kbd></>}
        </p>}
      </div>
    </FloatingPanel>, document.body)}
  </>;
}
