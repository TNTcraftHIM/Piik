import { useEffect, useRef, useState } from "react";
import type { AppDiscovery } from "../../native/discovery";
import { clientNavigationURL } from "../../channel/client-navigation";
import { ChannelDiagnosisHelp } from "../../channel/components/ChannelDiagnosisHelp";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

interface NavigationAttempt { controller: AbortController; popup: Window }

/** Navigation asks the local launcher to confirm a destination; it never approves a site. */
export function OpenInClient({ discovery, targetURL, active, disabled }: {
  discovery: AppDiscovery; targetURL: string; active: boolean; disabled: boolean;
}) {
  const { t } = useCopy();
  const [state, setState] = useState<"idle" | "busy" | "unsupported" | "unavailable" | "incompatible">("idle");
  const [managementURL, setManagementURL] = useState<string>();
  const pending = useRef<NavigationAttempt | null>(null);
  useEffect(() => {
    const cancel = () => {
      pending.current?.controller.abort(); pending.current?.popup.close(); pending.current = null;
    };
    if (!active) { cancel(); setState("idle"); }
    return cancel;
  }, [active, discovery]);

  async function open(): Promise<void> {
    if (pending.current) return;
    // Reserve the tab in the click gesture, before local-network discovery awaits.
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setState("unavailable"); return; }
    popup.opener = null;
    const attempt = { controller: new AbortController(), popup };
    pending.current = attempt;
    setState("busy");
    try {
      const result = await discovery.navigation?.(attempt.controller.signal);
      if (pending.current !== attempt || attempt.controller.signal.aborted) return;
      if (!result) { setState("unavailable"); return; }
      if (!result.windowNavigation) { setState("unsupported"); return; }
      setManagementURL(result.url);
      if (!popup.closed) popup.location.replace(clientNavigationURL(result.url, targetURL));
      // After navigation, the local confirmation page owns this tab.
      pending.current = null;
      setState("idle");
    } catch (error) {
      if (pending.current === attempt && !attempt.controller.signal.aborted)
        setState(discovery.isIncompatible(error) ? "incompatible" : "unavailable");
    } finally {
      attempt.controller.abort();
      if (pending.current === attempt) { popup.close(); pending.current = null; }
    }
  }

  const content = <><Glyph name={state === "busy" ? "loader" : "window"} size={16} className={state === "busy" ? "lr-spin" : undefined} />
    <span>{t("client.connect.openInClient")}</span></>;
  const failed = state === "unsupported" || state === "unavailable" || state === "incompatible";
  return <>
    <div className="lr-app-connect-actions">
      {managementURL && !disabled ? <a className="lr-btn" href={clientNavigationURL(managementURL, targetURL)} target="_blank" rel="noopener noreferrer">{content}</a>
        : <button type="button" className="lr-btn" disabled={disabled || state === "busy"} aria-busy={state === "busy" || undefined} onClick={() => void open()}>{content}</button>}
    </div>
    {failed && <p role="status">{t(state === "unsupported" ? "client.connect.navigationUnsupported" : state === "incompatible" ? "native.incompatible" : "client.connect.unavailable")}</p>}
    {failed && <ChannelDiagnosisHelp diagnosis={{ topic: "appVersion" }} />}
  </>;
}
