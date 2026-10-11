import { useEffect, useRef, useState } from "react";
import { activateClient } from "../../lib/session";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Tooltip } from "./Tooltip";

export function AppConnectionButton({ sourcePicker = false, onConnected }: {
  sourcePicker?: boolean;
  onConnected?: () => void;
} = {}) {
  const { t, vis } = useCopy();
  const [state, setState] = useState<"idle" | "busy" | "unavailable" | "incompatible">("idle");
  const pending = useRef<{ controller: AbortController; popup: Window | null } | null>(null);
  useEffect(() => () => { pending.current?.controller.abort(); pending.current?.popup?.close(); }, []);

  async function connect(): Promise<void> {
    if (pending.current) return;
    // Reserve the window during the click, before local-network discovery waits.
    const attempt = { controller: new AbortController(), popup: window.open("about:blank", "_blank") };
    if (!attempt.popup) { setState("unavailable"); return; }
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
      finish(health ? "idle" : "unavailable");
      if (health) {
        activateClient();
        onConnected?.();
      }
    };
    let approvalOrigin = "";
    const finish = (result: typeof state) => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      attempt.controller.abort();
      attempt.popup?.close();
      if (pending.current === attempt) { pending.current = null; setState(result); }
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
      approvalOrigin = new URL(url).origin;
      attempt.popup.location.replace(url);
    } catch (error) {
      if (!signal.aborted) finish(native && error instanceof native.NativeCompatibilityError ? "incompatible" : "unavailable");
    }
  }

  const label = t(state === "incompatible" ? "native.incompatible" :
    state === "unavailable" ? "client.connect.unavailable" : sourcePicker ? "client.connect.captureHint" : "client.connect.action");
  return <Tooltip kind="hint-client-site"
    text={vis ? undefined : label} place={sourcePicker ? "above" : "below"} align={sourcePicker ? "center" : "end"}>
    <button type="button" className={sourcePicker ? "lr-source-picker-refresh lr-source-app-connect" : "lr-btn"}
      aria-label={sourcePicker ? t("client.connect.action") : label} aria-busy={state === "busy" || undefined}
      onClick={() => void connect()} disabled={state === "busy"}>
      <Glyph name={state === "busy" ? "loader" : state === "unavailable" || state === "incompatible" ? "alert" : "window"}
        size={16} className={state === "busy" ? "lr-spin" : undefined} />
      {vis ? null : <span className="lr-cap">{sourcePicker ? t("client.connect.action") : "App"}</span>}
    </button>
  </Tooltip>;
}
