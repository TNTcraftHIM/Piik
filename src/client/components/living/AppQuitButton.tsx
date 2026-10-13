import { useEffect, useState } from "react";
import type { NativeHealth } from "../../native/wire";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

export function AppQuitButton() {
  const { t, vis } = useCopy();
  const [health, setHealth] = useState<NativeHealth | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "stopped" | "failed">("idle");
  const local = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const launcher = local && /^\/client\/?$/.test(window.location.pathname);
  useEffect(() => {
    if (!local || launcher) return;
    let current = true;
    void import("../../native/client").then(({ discoverNativeHealth }) => discoverNativeHealth()).then((value) => { if (current && value?.appQuit) setHealth(value); }).catch(() => {});
    return () => { current = false; };
  }, [local, launcher]);
  if (!launcher && !health) return null;
  const label = t(state === "stopped" ? "client.app.stopped" : state === "failed" ? "client.app.quitFailed" : "client.app.quit");
  return <button type="button" className="lr-btn" aria-label={label}
    disabled={state === "busy" || state === "stopped"} aria-busy={state === "busy" || undefined}
    onClick={() => {
      if (!window.confirm(t("client.app.quitConfirm"))) return;
      setState("busy");
      const request = launcher
        ? fetch("/api/client-launcher/quit", { method: "POST", signal: AbortSignal.timeout(3000) })
        : fetch(`http://127.0.0.1:${health!.port}/quit`, {
          method: "POST", signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer ${health!.instanceToken}` },
          targetAddressSpace: "loopback",
        } as RequestInit);
      void request.then((response) => {
        if (!response.ok) throw new Error("App quit failed");
        setState("stopped");
      }).catch(() => setState("failed"));
    }}>
    <Glyph name={state === "failed" ? "alert" : "x"} size={16} />
    {!vis && <span className="lr-cap">{label}</span>}
  </button>;
}
