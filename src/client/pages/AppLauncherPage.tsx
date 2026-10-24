import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import { BrandMark } from "../components/living/BrandMark";
import { HintComic } from "../components/living/hints";
import { LoadingStatus } from "../components/living/WaitingStatus";
import { AppReleaseNotice } from "../components/living/AppReleaseNotice";
import { AppHeader } from "../components/living/Header";
import { LauncherForm, type AppMode } from "../components/living/LauncherForm";
import { Btn, Pill } from "../components/living/primitives";
import { hasCopyPreference, isCopyKey, useCopy } from "../ui/copy";
import { consoleLanguage } from "../locales";
import { Glyph } from "../ui/icons";
import { currentThemePreference } from "../ui/theme";
import { clientLaunchURL, type ClientLaunchPresentation } from "../lib/session";
import {
  checkReleaseUpdate,
  type ReleaseUpdateNotice,
} from "../lib/release-update";

const launcherStateSchema = z.object({
  sites: z.array(z.string()),
  startupSite: z.string(),
  localAccessPassword: z.string(),
  defaultMode: z.enum(["local", "link"]),
  modes: z.array(z.enum(["local", "link"])).default(["local", "link"]),
  target: z.string().optional(),
  starting: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  revision: z.string(),
  version: z.string().default("development"),
  packageTarget: z.string().optional(),
  debug: z.boolean().optional(),
  lan: z.object({
    addresses: z.array(z.object({ address: z.string(), name: z.string() })),
    selected: z.string(),
  }).optional(),
});
const launcherResultSchema = z.object({ target: z.string().url() }).strict();
const launcherErrorSchema = z.object({ reason: z.string().optional(), detail: z.string() });

export function AppLauncherPage() {
  const { lang, vis, t } = useCopy();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<AppMode>("link");
  const [modes, setModes] = useState<readonly AppMode[]>(["local", "link"]);
  const [sites, setSites] = useState<string[]>([]);
  const [startupSite, setStartupSite] = useState("");
  const [openOnApproval, setOpenOnApproval] = useState(false);
  const [localAccessPassword, setLocalAccessPassword] = useState("");
  const [error, setError] = useState<{ kind: "load" | "launch"; reason?: string; detail?: string } | null>(null);
  const [appDebug, setAppDebug] = useState<boolean | undefined>();
  const [debug, setDebug] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugError, setDebugError] = useState(false);
  const [reload, setReload] = useState(0);
  const [lan, setLan] = useState<z.infer<typeof launcherStateSchema>["lan"]>();
  const [update, setUpdate] = useState<ReleaseUpdateNotice | null>(null);
  const [version, setVersion] = useState<string>();
  const [target, setTarget] = useState<string>();
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState<string>();
  // Background reads cannot replace a newer command's result or optimistic state.
  const stateChanges = useRef({ revision: 0, pending: 0 });
  const requestedSite = new URLSearchParams(window.location.search).get("site");
  const validSite = requestedSite && (() => {
    try {
      const url = new URL(requestedSite);
      return ["http:", "https:"].includes(url.protocol) && url.origin === requestedSite;
    } catch { return false; }
  })();
  const approvalCurrent = validSite && sites.includes(requestedSite);
  const openSiteOnStart = Boolean(approvalCurrent && startupSite === requestedSite);

  useEffect(() => {
    // The App's saved exact origin owns permission, including repeat connections.
    // The requesting page still verifies authorized health before using App.
    // The opener closes this page. Finish an explicitly selected startup
    // preference first, and leave a failed save visible for correction.
    if (approvalCurrent && !siteBusy && !siteError) window.opener?.postMessage({ type: "piik-app-approved", site: requestedSite }, requestedSite);
  }, [approvalCurrent, requestedSite, siteBusy, siteError]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checkedRelease = false;
    let restoredSettings = false;
    let reading = false;
    const readState = () => {
      if (reading || !current) return;
      clearTimeout(timer);
      if (stateChanges.current.pending) {
        timer = setTimeout(readState, 750);
        return;
      }
      reading = true;
      const revision = stateChanges.current.revision;
      const fresh = () => current && revision === stateChanges.current.revision && !stateChanges.current.pending;
      void fetch("/api/client-launcher", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return launcherStateSchema.parse(await response.json());
      })
      .then((state) => {
        if (!fresh()) return;
        if (!restoredSettings) {
          setMode(state.defaultMode);
          setModes(state.modes);
          setLocalAccessPassword(state.localAccessPassword);
          setLan(state.lan);
          restoredSettings = true;
        }
        setVersion(state.version);
        setTarget(state.target);
        setStarting(state.starting === true);
        setSites(state.sites);
        setStartupSite(state.startupSite);
        setAppDebug(state.debug);
        setDebug(state.debug === true);
        setError(previous => state.detail ? { kind: "launch", reason: state.reason, detail: state.detail }
          : previous?.kind === "load" ? null : previous);
        setLoading(false);
        if (state.starting) timer = setTimeout(() => void readState(), 750);
        if (checkedRelease) return;
        checkedRelease = true;
        void checkReleaseUpdate({
          version: state.version,
          revision: state.revision,
        }, { packageTarget: state.packageTarget })
          .then((notice) => {
            if (current && notice) setUpdate(notice);
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (!fresh()) return;
        setError({ kind: "load" });
        setStarting(false);
        setLoading(false);
      }).finally(() => {
        reading = false;
        if (current && !fresh()) timer = setTimeout(readState, 750);
      });
    };
    void readState();
    const refresh = () => { void readState(); };
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);

  function beginStateChange(): () => void {
    stateChanges.current.revision++;
    stateChanges.current.pending++;
    return () => { stateChanges.current.pending--; };
  }

  async function enableDebug(): Promise<void> {
    if (debugBusy) return;
    const finish = beginStateChange();
    setDebugBusy(true);
    setDebugError(false);
    try {
      const response = await fetch("/api/client-launcher/debug", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error();
      setAppDebug(true);
      setDebug(true);
    } catch { setDebugError(true); }
    finally { finish(); setDebugBusy(false); }
  }

  function launchURL(target: string): string {
    const theme = currentThemePreference();
    const presentation: ClientLaunchPresentation = {
      lang, vis, theme,
      explicit: [
        ...(hasCopyPreference() ? ["copy" as const] : []),
        ...(theme !== null ? ["theme" as const] : []),
      ],
    };
    return clientLaunchURL(target, presentation, debug);
  }

  async function launch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (starting ||
      (mode === "local" && lan !== undefined && !lan.selected)) return;
    const finish = beginStateChange();
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/client-launcher/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          language: consoleLanguage(lang, vis),
          ...(appDebug !== undefined && debug ? { debug: true } : {}),
          ...(mode === "local" && lan ? { lanAddress: lan.selected } : {}),
          localAccessPassword,
        }),
      });
      if (response.status === 409) {
        setLoading(true);
        setReload(value => value + 1);
        return;
      }
      if (!response.ok) {
        const failure = launcherErrorSchema.safeParse(await response.json().catch(() => null));
        setError({ kind: "launch", ...(failure.success ? failure.data : {}) });
        setStarting(false);
        return;
      }
      const result = launcherResultSchema.parse(await response.json());
      window.location.replace(launchURL(result.target));
    } catch {
      setError({ kind: "launch" });
      setStarting(false);
    } finally { finish(); }
  }

  async function changeSite(nextSite: string, setting: "site" | "startup-site" = "site", starAfterApproval = false, allowed = true): Promise<void> {
    if (siteBusy) return;
    const finish = beginStateChange();
    setSiteBusy(true);
    setSiteError(undefined);
    async function save(setting: "site" | "startup-site"): Promise<boolean> {
      const response = await fetch(`/api/client-launcher/${setting}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: nextSite, ...(setting === "site" ? { allowed } : {}) }),
      });
      const result = launcherStateSchema.pick({ sites: true, startupSite: true }).safeParse(await response.json().catch(() => null));
      if (result.success) {
        setSites(result.data.sites);
        setStartupSite(result.data.startupSite);
      }
      if (response.status === 409 && result.success) {
        setSiteError(t("client.connect.changed"));
        return false;
      }
      if (!response.ok || !result.success) throw new Error("Could not save App settings");
      return true;
    }
    try {
      if (await save(setting) && starAfterApproval) await save("startup-site");
    } catch {
      setSiteError(t("client.connect.saveFailed"));
    } finally { finish(); setSiteBusy(false); }
  }

  const errorKey = `client.launch.failure.${error?.reason}`;
  return (
    <div className="lr-app">
      <AppHeader homeHref="/client" diagnosticControl={appDebug === undefined ? null : (
        <Btn icon="cpu" title="client.launch.debugHint" size="compact"
          pressed={debug} tone={debug ? "on" : undefined} hint="debug-start"
          disabled={appDebug || debugBusy || loading || starting || !!target || error?.kind === "load"}
          onClick={() => void enableDebug()} />
      )} />
      <main className="lr-client-launch">
        {debugError && <Pill icon="alert" tone="bad" comic="warning" alert label={t("client.launch.debugFailed")} />}
        {loading || (starting && !requestedSite) ? (
          <LoadingStatus label={starting ? "client.launch.starting" : "common.loading"} waitingCaption={starting} />
        ) : error?.kind === "load" ? (
          <div className="lr-client-launch-panel">
            <Pill
              icon="alert"
              tone="bad"
              label={t("client.launch.loadFailed")}
              alert
              comic="signal-failed"
            />
            <Btn
              icon="refresh"
              title="common.refresh"
              cap="common.refresh"
              hint="page-refresh"
              onClick={() => window.location.reload()}
            />
          </div>
        ) : requestedSite ? (
          <section className="lr-client-approval" aria-labelledby="site-approval-title">
            <header className="lr-client-approval-heading">
              {approvalCurrent ? <BrandMark size={48} motion="once" /> : <HintComic kind="hint-client-site" size={230} />}
              <h1 id="site-approval-title" className={vis ? "visually-hidden" : undefined}>{t(approvalCurrent ? "client.connect.approved" : "client.connect.approveTitle")}</h1>
            </header>
            <div className="lr-client-approval-site">
              <div className="lr-client-approval-origin">
                <Glyph name="globe" size={20} />
                <strong>{requestedSite}</strong>
                {approvalCurrent && <Glyph name="check" size={20} className="lr-client-approval-check" />}
              </div>
              <p className={vis ? "visually-hidden" : undefined}>{t(approvalCurrent ? "client.connect.return" : "client.connect.approveHint")}</p>
            </div>
            {!validSite && <Pill icon="alert" tone="bad" label={t("client.connect.invalid")} comic="signal-failed" />}
            {siteError && <p role="alert">{siteError}</p>}
            {validSite && <label className="lr-client-approval-startup">
              <input type="checkbox" disabled={siteBusy}
                checked={approvalCurrent ? openSiteOnStart : openOnApproval}
                onChange={event => approvalCurrent
                  ? void changeSite(event.target.checked ? requestedSite : "", "startup-site")
                  : setOpenOnApproval(event.target.checked)} />
              <Glyph name="star" size={18} />
              <span className={vis ? "visually-hidden" : undefined}>{t("client.connect.openOnStart")}</span>
            </label>}
            <div className="lr-client-approval-actions">
              <Btn icon="x" title={approvalCurrent ? "client.connect.close" : "common.cancel"} cap={approvalCurrent ? "client.connect.close" : "common.cancel"} hint="hint-close"
                onClick={() => window.close()} />
              {!approvalCurrent && <Btn icon="check" title="client.connect.approve" cap="client.connect.approve" tone="primary"
                hint="hint-client-site" busy={siteBusy} disabled={!validSite || siteBusy} onClick={() => void changeSite(requestedSite, "site", openOnApproval)} />}
            </div>
          </section>
        ) : (
          <LauncherForm
            roomError={error?.kind === "launch" ? <>
              <Pill icon="alert" tone="bad" label={t("client.launch.error")} alert comic="signal-failed" />
              {isCopyKey(errorKey) && <p className={vis ? "visually-hidden" : "lr-client-launch-status"}>{t(errorKey)}</p>}
              <p className={vis ? "visually-hidden" : "lr-client-launch-status"}>{t("client.launch.retryHint")}</p>
              {error.detail && <details className="lr-client-launch-technical">
                <summary>{t("client.launch.errorDetails")}</summary>
                <p className="lr-client-launch-detail">{error.detail}</p>
              </details>}
            </> : undefined}
            mode={mode}
            modes={modes}
            sites={sites}
            startupSite={startupSite}
            onToggleStartupSite={site => void changeSite(startupSite === site ? "" : site, "startup-site")}
            localAccessPassword={localAccessPassword}
            onModeChange={setMode}
            onRemoveSite={site => void changeSite(site, "site", false, false)}
            siteBusy={siteBusy}
            siteError={siteError}
            target={target}
            onOpen={(event) => { event.currentTarget.href = launchURL(event.currentTarget.href); }}
            onLocalAccessPasswordChange={setLocalAccessPassword}
            lan={lan && { ...lan, onChange: (selected) => setLan({ ...lan, selected }) }}
            onSubmit={launch}
          >
            {update && <AppReleaseNotice update={update} />}
          </LauncherForm>
        )}
      </main>
      <footer className="lr-client-footer">
        <a className="lr-btn is-dense is-quiet" href="https://github.com/TNTcraftHIM/Piik" target="_blank" rel="noopener noreferrer">GitHub<span aria-hidden="true"> ↗</span></a>
        {version && <p className="lr-client-version">
          <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.version", { version })}</span>
          {vis && <span aria-hidden="true">{version}</span>}
        </p>}
      </footer>
    </div>
  );
}
