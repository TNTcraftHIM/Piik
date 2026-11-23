import { useEffect, useRef, useState } from "react";
import type { AppDiscovery } from "../../native/discovery";
import { clientNavigationURL } from "../../channel/client-navigation";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

interface NavigationAttempt { controller: AbortController; popup: Window }
export type AppNavigationIssue = "unsupported" | "popup-blocked" | "unavailable" | "incompatible";

/** Navigation asks the local launcher to confirm a destination; it never approves a site. */
export function OpenInClient({ discovery, targetURL, active, disabled, onIssue }: {
  discovery: AppDiscovery; targetURL: string; active: boolean; disabled: boolean;
  onIssue: (issue: AppNavigationIssue | null) => void;
}) {
  const { t } = useCopy();
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
        onIssue(discovery.isIncompatible(error) ? "incompatible" : "unavailable");
    } finally {
      attempt.controller.abort();
      if (pending.current === attempt) {
        popup.close();
        pending.current = null;
        setBusy(false);
      }
    }
  }

  const content = <><Glyph name={busy ? "loader" : "window"} size={16} className={busy ? "lr-spin" : undefined} />
    <span>{t("client.connect.openInClient")}</span></>;
  return <div className="lr-app-connect-actions">
    {managementURL && !disabled ? <a className="lr-btn" href={clientNavigationURL(managementURL, targetURL)} target="_blank" rel="noopener noreferrer">{content}</a>
      : <button type="button" className="lr-btn" disabled={disabled || busy} aria-busy={busy || undefined} onClick={() => void open()}>{content}</button>}
  </div>;
}
