import { useEffect, useId, useRef, useState } from "react";
import { activateClient, isClientActivated, watchClientActivation } from "../../lib/session";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { Comic } from "./Comic";
import { useAnchoredPopover } from "./use-anchored-popover";

interface AppConnectionProps {
  sourcePicker?: boolean;
  onConnected?: () => void;
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
  const [state, setState] = useState<"idle" | "busy" | "ready" | "unavailable" | "incompatible">("idle");
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const help = useRef<HTMLDivElement>(null);
  useAnchoredPopover(trigger, help);
  const pending = useRef<{ controller: AbortController; popup: Window | null } | null>(null);
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
    if (pending.current) return;
    const manage = state === "ready";
    help.current?.hidePopover();
    healthCheck.current?.abort();
    // Reserve the window during the click, before local-network discovery waits.
    const attempt = { controller: new AbortController(), popup: window.open("about:blank", "_blank") };
    if (!attempt.popup) { setState("unavailable"); showHelp(); return; }
    pending.current = attempt;
    setState("busy");
    const signal = attempt.controller.signal;
    let native: typeof import("../../native/client") | undefined;
    let approving = false;
    const onMessage = async (event: MessageEvent) => {
      if (approving || event.source !== attempt.popup || !approvalOrigin || event.origin !== approvalOrigin ||
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
      }
    };
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
      if (manage) {
        const launcher = new URL(url);
        launcher.searchParams.delete("site");
        attempt.popup.location.replace(launcher.href);
        finish("ready", true);
        return;
      }
      approvalOrigin = new URL(url).origin;
      attempt.popup.location.replace(url);
    } catch (error) {
      if (!signal.aborted) finish(native && error instanceof native.NativeCompatibilityError ? "incompatible" : "unavailable");
    }
  }

  const label = t(state === "ready" ? "client.connect.manage" : state === "incompatible" ? "native.incompatible" :
    state === "unavailable" ? "client.connect.unavailable" : "client.connect.action");
  const failed = state === "unavailable" || state === "incompatible";
  return <><Tooltip kind={state === "ready" ? "hint-app-ready" : state === "unavailable" ? "signal-failed" : state === "incompatible" ? "warning" : "hint-client-site"}
    text={vis ? undefined : label} disabled={helpOpen}
    place={sourcePicker ? "above" : "below"} align="end">
    <button ref={trigger} type="button" className={`${sourcePicker ? "lr-source-picker-refresh lr-source-app-connect" : "lr-btn lr-app-connect"}${state === "ready" ? " is-ready" : ""}`}
      aria-label={sourcePicker ? t("client.connect.action") : label} aria-busy={state === "busy" || undefined}
      popoverTarget={failed ? helpId : undefined} aria-haspopup={failed ? "dialog" : undefined}
      onClick={failed ? undefined : event => {
        // Failure may attach popoverTarget during this click; do not toggle the
        // recovery card closed immediately after opening it.
        event.preventDefault();
        void connect();
      }} disabled={state === "busy"}>
      <Glyph name={state === "ready" ? "check" : state === "busy" ? "loader" : state === "unavailable" || state === "incompatible" ? "alert" : "window"}
        size={16} className={state === "busy" ? "lr-spin" : undefined} />
      {vis ? null : <span className="lr-cap">App</span>}
    </button>
  </Tooltip>
    <div ref={help} id={helpId} popover="auto" role="dialog" aria-label={t("client.connect.action")} aria-describedby={`${helpId}-message`}
      className="lr-app-connect-help" onToggle={event => {
        setHelpOpen(event.newState === "open");
        if (event.newState !== "open" || !trigger.current) return;
        event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
      }}>
      <div className="lr-app-connect-head">
        <div className="lr-app-connect-scene" aria-hidden="true">{helpOpen && <Comic kind={state === "incompatible" ? "warning" : "signal-failed"} theme="paper" />}</div>
        <button type="button" className="lr-btn lr-app-connect-close" aria-label={t("common.close")}
          popoverTarget={helpId} popoverTargetAction="hide">
          <Glyph name="x" size={16} />
        </button>
      </div>
      <p id={`${helpId}-message`} className={vis ? "visually-hidden" : undefined}>{label}</p>
      <div className="lr-app-connect-actions">
        <button type="button" className="lr-btn" aria-label={t("common.retry")} onClick={() => void connect()}>
          <Glyph name="refresh" size={16} /><span className={vis ? "visually-hidden" : undefined}>{t("common.retry")}</span>
        </button>
        <a className="lr-btn" href="https://piik.tv/#download" target="_blank" rel="noopener noreferrer" aria-label={t("client.connect.download")}>
          <Glyph name="arrowDown" size={16} /><span className={vis ? "visually-hidden" : undefined}>{t("client.connect.download")}</span>
        </a>
      </div>
      <p className={vis ? "visually-hidden" : "lr-app-connect-optional"}>{t("client.connect.browserHint")}</p>
    </div>
  </>;
}
