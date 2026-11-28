import { useEffect, useRef, useState } from "react";
import type { AppDiscovery } from "../../native/discovery";
import { clientNavigationURL } from "../../channel/client-navigation";
import type { AppConnectionIssue } from "../../ui/diagnosis";
import { Glyph } from "../../ui/icons";
import { Btn, Cap } from "./primitives";

interface NavigationAttempt { controller: AbortController; popup: Window }
export type AppNavigationIssue = "unsupported" | "popup-blocked" | AppConnectionIssue;

/** Navigation asks the local launcher to confirm a destination; it never approves a site. */
export function OpenInClient({ discovery, targetURL, active, disabled, onIssue }: {
  discovery: AppDiscovery; targetURL: string; active: boolean; disabled: boolean;
  onIssue: (issue: AppNavigationIssue | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [managementURL, setManagementURL] = useState<string>();
  const pending = useRef<NavigationAttempt | null>(null);
  useEffect(() => {
    const cancel = () => {
      pending.current?.controller.abort(); pending.current?.popup.close(); pending.current = null;
    };
    if (!active) { cancel(); setBusy(false); }
    return cancel;
  }, [active, discovery]);

  async function open(): Promise<void> {
    if (pending.current) return;
    onIssue(null);
    // Reserve the tab in the click gesture, before local-network discovery awaits.
    const popup = window.open("about:blank", "_blank");
    if (!popup) { onIssue("popup-blocked"); return; }
    popup.opener = null;
    const attempt = { controller: new AbortController(), popup };
    pending.current = attempt;
    setBusy(true);
    try {
      const result = await discovery.navigation?.(attempt.controller.signal);
      if (pending.current !== attempt || attempt.controller.signal.aborted) return;
      if (!result) { onIssue("unavailable"); return; }
      if (!result.windowNavigation) { onIssue("unsupported"); return; }
      setManagementURL(result.url);
      if (!popup.closed) popup.location.replace(clientNavigationURL(result.url, targetURL));
      // After navigation, the local confirmation page owns this tab.
      pending.current = null;
      setBusy(false);
    } catch (error) {
      if (pending.current === attempt && !attempt.controller.signal.aborted)
        onIssue(discovery.compatibilityIssue(error) ?? "unavailable");
    } finally {
      attempt.controller.abort();
      if (pending.current === attempt) {
        popup.close();
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return <div className="lr-app-connect-actions">
    {managementURL && !disabled ? <a className="lr-btn" href={clientNavigationURL(managementURL, targetURL)} target="_blank" rel="noopener noreferrer">
      <Glyph name="window" size={19} /><Cap k="client.connect.openInClient" />
    </a> : <Btn icon="window" title="client.connect.openInClient" cap="client.connect.openInClient"
      disabled={disabled || busy} busy={busy} onClick={() => void open()} />}
  </div>;
}
