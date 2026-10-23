import { useEffect, useId, useRef, useState } from "react";
import { activateClient, isClientActivated, watchClientActivation } from "../../lib/session";
import { useProjectLink } from "../../lib/use-project-link";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { Comic } from "./Comic";
import { HintComic } from "./hints";
import { LoadingStatus } from "./WaitingStatus";
import { useAnchoredPopover } from "./use-anchored-popover";

interface AppConnectionProps {
  sourcePicker?: boolean;
  onConnected?: () => void;
}

interface ConnectionAttempt {
  controller: AbortController;
  popup: Window | null;
  open?: () => void;
  cancel?: () => void;
}

export function AppConnectionButton(props: AppConnectionProps) {
  // This is a desktop-package entry, not a test of Browser capture support.
  // iPad's desktop UA still identifies a touch-capable Mac platform.
  if (typeof navigator !== "undefined" && (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )) return null;
  const button = <AppConnectionControl {...props} />;
  return props.sourcePicker ? <div className="lr-source-app-connection">{button}</div> : button;
}

function AppConnectionControl({ sourcePicker = false, onConnected }: AppConnectionProps) {
  const { t, vis } = useCopy();
  const [state, setState] = useState<"idle" | "busy" | "approval" | "approving" | "ready" | "unavailable" | "incompatible">("idle");
  const [helpOpen, setHelpOpen] = useState(false);
  const downloadURL = useProjectLink("/#download", "https://github.com/TNTcraftHIM/Piik/releases/latest", helpOpen);
  const helpId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const help = useRef<HTMLDivElement>(null);
  useAnchoredPopover(trigger, help);
  const pending = useRef<ConnectionAttempt | null>(null);
  const healthCheck = useRef<AbortController | null>(null);
  useEffect(() => {
    if (sourcePicker) return;
    const refresh = async () => {
      if (pending.current || help.current?.matches(":popover-open") || !isClientActivated()) return;
      healthCheck.current?.abort();
      const current = healthCheck.current = new AbortController();
      const native = await import("../../native/client");
      if (current.signal.aborted) return;
      try {
        const health = await native.discoverNativeHealth({ signal: current.signal, waitForPermission: false });
        if (!current.signal.aborted && !pending.current) setState(health ? "ready" : "idle");
      } catch (error) {
        if (!current.signal.aborted && !pending.current) {
          setState(error instanceof native.NativeCompatibilityError ? "incompatible" : "idle");
        }
      }
    };
    // Launch/remembered activation is intent, not proof of current permission.
    // Recheck on return without keeping a media session or a polling timer alive.
    const onFocus = () => { void refresh().catch(() => undefined); };
    onFocus();
    window.addEventListener("focus", onFocus);
    const unwatch = watchClientActivation(onFocus);
    return () => { healthCheck.current?.abort(); window.removeEventListener("focus", onFocus); unwatch(); };
  }, [sourcePicker]);
  useEffect(() => () => { pending.current?.controller.abort(); pending.current?.popup?.close(); }, []);

  function showHelp(): void {
    if (trigger.current) help.current?.showPopover({ source: trigger.current });
  }

  async function connect(): Promise<void> {
    if (pending.current) { pending.current.open?.(); return; }
    const manage = state === "ready";
    healthCheck.current?.abort();
    // Discovery and its browser permission prompt stay in the current tab.
    // A fresh click opens the real approval page without reserving a blank tab.
    const attempt: ConnectionAttempt = { controller: new AbortController(), popup: null };
    pending.current = attempt;
    setState("busy");
    showHelp();
    const signal = attempt.controller.signal;
    let native: typeof import("../../native/client") | undefined;
    let approving = false;
    const onMessage = async (event: MessageEvent) => {
      if (approving || !attempt.popup || event.source !== attempt.popup || !approvalOrigin || event.origin !== approvalOrigin ||
          event.data?.type !== "piik-app-approved" || event.data.site !== window.location.origin) return;
      approving = true;
      // The approval message only asks us to recheck the App-owned permission.
      const health = await native?.discoverNativeHealth({ signal }).catch(() => null);
      if (signal.aborted) return;
      finish(health ? "ready" : "unavailable");
      if (health) {
        activateClient();
        onConnected?.();
      }
    };
    let approvalOrigin = "";
    const finish = (result: typeof state, keepPage = false) => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      attempt.controller.abort();
      if (!keepPage) attempt.popup?.close();
      if (pending.current === attempt) {
        pending.current = null;
        setState(result);
        if (result === "unavailable" || result === "incompatible") showHelp();
        else help.current?.hidePopover();
      }
    };
    attempt.cancel = () => finish(manage ? "ready" : "idle");
    const onFocus = () => {
      if (attempt.popup?.closed && !approving) finish("idle");
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    signal.addEventListener("abort", () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    }, { once: true });
    try {
      native = await import("../../native/client");
      if (signal.aborted) return;
      const url = await native.discoverNativeConnect(signal);
      if (signal.aborted) return;
      if (!url) { finish("unavailable"); return; }
      approvalOrigin = new URL(url).origin;
      attempt.open = () => {
        if (signal.aborted || attempt.popup) return;
        const destination = new URL(url);
        if (manage) destination.searchParams.delete("site");
        attempt.popup = window.open(destination.href, "_blank");
        if (!attempt.popup) { finish("unavailable"); return; }
        attempt.open = undefined;
        if (manage) finish("ready", true);
        else { setState("approving"); help.current?.hidePopover(); }
      };
      setState("approval");
    } catch (error) {
      if (!signal.aborted) finish(native && error instanceof native.NativeCompatibilityError ? "incompatible" : "unavailable");
    }
  }

  const busy = state === "busy" || state === "approving";
  const label = t(state === "busy" ? "client.connect.discovering" : state === "approving" ? "client.connect.approving" : state === "approval" ? "client.connect.found" :
    state === "ready" ? "client.connect.manage" : state === "incompatible" ? "native.incompatible" :
    state === "unavailable" ? "client.connect.unavailable" : "client.connect.action");
  const failed = state === "unavailable" || state === "incompatible";
  return <><Tooltip kind={state === "ready" ? "hint-app-ready" : state === "unavailable" ? "signal-failed" : state === "incompatible" ? "warning" : "hint-client-site"}
    text={vis ? undefined : state === "idle" && !sourcePicker ? t("client.connect.hint") : label} disabled={helpOpen}
    place={sourcePicker ? "above" : "below"} align="end">
    <button ref={trigger} type="button" className={`${sourcePicker ? "lr-btn is-dense lr-source-picker-refresh lr-source-app-connect" : "lr-btn is-compact lr-app-connect"}${state === "ready" ? " is-ready" : ""}`}
      aria-label={sourcePicker ? t("client.connect.action") : label} aria-busy={busy || undefined}
      popoverTarget={failed || state === "approval" ? helpId : undefined} aria-haspopup="dialog"
      onClick={failed || state === "approval" ? undefined : event => {
        // Failure may attach popoverTarget during this click; do not toggle the
        // recovery card closed immediately after opening it.
        event.preventDefault();
        void connect();
      }} disabled={busy}>
      <Glyph name={state === "ready" ? "check" : busy ? "loader" : state === "unavailable" || state === "incompatible" ? "alert" : "window"}
        size={16} className={busy ? "lr-spin" : undefined} />
      {vis ? null : <span className="lr-cap">App</span>}
    </button>
  </Tooltip>
    <div ref={help} id={helpId} popover="auto" role="dialog" aria-label={t("client.connect.action")} aria-describedby={`${helpId}-message`}
      className="lr-anchored-card lr-app-connect-help" onToggle={event => {
        setHelpOpen(event.newState === "open");
        if (event.newState === "closed" && !pending.current?.popup) pending.current?.cancel?.();
        if (event.newState !== "open" || !trigger.current) return;
        event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
      }}>
      <div className="lr-app-connect-head">
        {state === "busy" ? <LoadingStatus label="client.connect.discovering" /> :
          <div className="lr-app-connect-scene" aria-hidden="true">{helpOpen && (state === "approval" ? <HintComic kind="hint-client-site" /> :
            <Comic kind={state === "incompatible" ? "warning" : "signal-failed"} theme="paper" />)}</div>}
        <button type="button" className="lr-btn is-dense is-quiet lr-app-connect-close" aria-label={t("common.close")}
          popoverTarget={helpId} popoverTargetAction="hide">
          <Glyph name="x" size={16} />
        </button>
      </div>
      <p id={`${helpId}-message`} className={vis ? "visually-hidden" : undefined}>{state === "busy" ? t("client.connect.permissionHint") : label}</p>
      <div className="lr-app-connect-actions">
        {state !== "busy" && <button type="button" className="lr-btn" aria-label={t(state === "approval" ? "client.connect.open" : "common.retry")} onClick={() => void connect()}>
          <Glyph name={state === "approval" ? "arrowRight" : "refresh"} size={16} /><span className={vis ? "visually-hidden" : undefined}>{t(state === "approval" ? "client.connect.open" : "common.retry")}</span>
        </button>}
        {failed && <a className="lr-btn" href={downloadURL} target="_blank" rel="noopener noreferrer" aria-label={t("client.connect.download")}>
          <Glyph name="arrowDown" size={16} /><span className={vis ? "visually-hidden" : undefined}>{t("client.connect.download")}</span>
        </a>}
      </div>
      <p className={vis ? "visually-hidden" : "lr-app-connect-optional"}>{t("client.connect.browserHint")}</p>
    </div>
  </>;
}
