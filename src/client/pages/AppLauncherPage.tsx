import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { z } from "zod";

import { BrandMark } from "../components/living/BrandMark";
import { HintComic } from "../components/living/hints";
import { LoadingStatus } from "../components/living/WaitingStatus";
import { AppReleaseNotice, AppUpdateStatus } from "../components/living/AppReleaseNotice";
import { useAppUpdate } from "../lib/use-app-update";
import { AppHeader } from "../components/living/Header";
import { LauncherForm, type LocalCertificate } from "../components/living/LauncherForm";
import { Btn, Pill } from "../components/living/primitives";
import { hasCopyPreference, isCopyKey, useCopy } from "../ui/copy";
import { consoleLanguage } from "../locales";
import { Glyph } from "../ui/icons";
import { currentThemePreference, subscribeTheme } from "../ui/theme";
import { clientLaunchURL, readPreferredAppMode, savePreferredAppMode, type AppMode, type ClientLaunchPresentation } from "../lib/app-launch";
import type { AppReleaseIdentity } from "../lib/release-update";
import { useReleaseUpdate } from "../lib/use-release-update";
import { downloadBlob } from "../lib/download";

const localCertificateSchema = z.object({ origin: z.string().url(), sha256Fingerprint: z.string().regex(/^[A-Fa-f0-9]{64}$/) });
const launcherStateSchema = z.object({
  sites: z.array(z.string()),
  startupSite: z.string(),
  ownedSites: z.array(z.string()).default([]),
  startupMode: z.enum(["local", "link", ""]).nullish(),
  target: z.string().optional(),
  localCertificate: localCertificateSchema.optional(),
  starting: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  revision: z.string(),
  version: z.string().default("development"),
  packageTarget: z.string().optional(),
  controlPort: z.number().int().optional(),
  debug: z.boolean().optional(),
  lan: z.object({
    addresses: z.array(z.object({ address: z.string(), name: z.string() })),
    selected: z.string(),
  }).optional(),
});
const launcherResultSchema = z.object({ target: z.string().url(), localCertificate: localCertificateSchema.optional() }).strict();
const launcherErrorSchema = z.object({ reason: z.string().optional(), detail: z.string() });

export function AppLauncherPage() {
  const { lang, vis, t } = useCopy();
  // Rendered entry URLs follow theme changes before any browser link action.
  useSyncExternalStore(subscribeTheme, currentThemePreference);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<AppMode>(readPreferredAppMode);
  const [sites, setSites] = useState<string[]>([]);
  const [startupSite, setStartupSite] = useState("");
  const [ownedSites, setOwnedSites] = useState<string[]>([]);
  const [startupMode, setStartupMode] = useState<AppMode | undefined>();
  const [openOnApproval, setOpenOnApproval] = useState(false);
  const [error, setError] = useState<{ kind: "load" | "launch"; reason?: string; detail?: string } | null>(null);
  const [appDebug, setAppDebug] = useState<boolean | undefined>();
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugError, setDebugError] = useState(false);
  const [reload, setReload] = useState(0);
  const [lan, setLan] = useState<z.infer<typeof launcherStateSchema>["lan"]>();
  const [build, setBuild] = useState<AppReleaseIdentity>();
  const appUpdate = useAppUpdate();
  const operation = appUpdate.view?.operationId && appUpdate.view.version && appUpdate.view.revision
    ? { version: appUpdate.view.version, revision: appUpdate.view.revision } : undefined;
  const { update } = useReleaseUpdate(build, operation);
  const version = build?.version === "development" && /^[a-f0-9]{40}$/i.test(build.revision)
    ? `${build.version} (${build.revision.slice(0, 7)})` : build?.version;
  const [target, setTarget] = useState<string>();
  const [localCertificate, setLocalCertificate] = useState<LocalCertificate>();
  const [controlPort, setControlPort] = useState<number>();
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState<string>();
  const [siteEntry, setSiteEntry] = useState({ origin: "", confirming: false });
  // Background reads cannot replace a newer command's result or optimistic state.
  const stateChanges = useRef({ revision: 0, pending: 0 });
  const externalSite = new URLSearchParams(window.location.search).get("site");
  const manualSite = externalSite === null && siteEntry.confirming;
  const requestedSite = externalSite ?? (manualSite ? siteEntry.origin : null);
  const validSite = requestedSite && (() => {
    try {
      const url = new URL(requestedSite);
      return ["http:", "https:"].includes(url.protocol) && url.origin === requestedSite;
    } catch { return false; }
  })();
  const approvalCurrent = validSite && sites.includes(requestedSite);
  const openSiteOnStart = Boolean(approvalCurrent && (startupSite === requestedSite || startupMode && ownedSites.includes(requestedSite)));

  useEffect(() => {
    // The App's saved exact origin owns permission, including repeat connections.
    // The requesting page still verifies authorized health before using App.
    // The opener closes this page. Finish an explicitly selected startup
    // preference first, and leave a failed save visible for correction.
    if (!manualSite && approvalCurrent && !siteBusy && !siteError) window.opener?.postMessage({ type: "piik-app-approved", site: requestedSite }, requestedSite);
  }, [manualSite, approvalCurrent, requestedSite, siteBusy, siteError]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let restoredSettings = false;
    let enterOnReady = new URLSearchParams(window.location.search).get("start") === "1";
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
          setLan(state.lan);
          if (state.startupMode) setMode(state.startupMode);
          restoredSettings = true;
        }
        setControlPort(state.controlPort);
        setTarget(state.target);
        setLocalCertificate(state.localCertificate);
        setStarting(state.starting === true);
        setSites(state.sites);
        setStartupSite(state.startupSite);
        setStartupMode(state.startupMode || undefined);
        setOwnedSites(state.ownedSites);
        setAppDebug(state.debug);
        setError(previous => state.detail ? { kind: "launch", reason: state.reason, detail: state.detail }
          : state.target || previous?.kind === "load" ? null : previous);
        setLoading(false);
        if (enterOnReady && (state.target || state.detail)) {
          enterOnReady = false;
          if (state.target) window.location.replace(launchURL(state.target, { debug: state.debug === true, controlPort: state.controlPort }));
        }
        if (state.starting) timer = setTimeout(() => void readState(), 750);
        setBuild({ version: state.version, revision: state.revision, packageTarget: state.packageTarget });
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
    } catch { setDebugError(true); }
    finally { finish(); setDebugBusy(false); }
  }

  async function exportDebug(): Promise<void> {
    if (debugBusy) return;
    setDebugBusy(true);
    setDebugError(false);
    try {
      const response = await fetch("/api/client-launcher/debug/export", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error();
      downloadBlob(await response.blob(), `piik-app-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
    } catch { setDebugError(true); }
    finally { setDebugBusy(false); }
  }

  function launchURL(target: string, settings = { debug: appDebug === true, controlPort }): string {
    const theme = currentThemePreference();
    const presentation: ClientLaunchPresentation = {
      lang, vis, theme,
      explicit: [
        ...(hasCopyPreference() ? ["copy" as const] : []),
        ...(theme !== null ? ["theme" as const] : []),
      ],
    };
    return clientLaunchURL(target, presentation, settings.debug, settings.controlPort);
  }

  function changeMode(next: AppMode): void {
    setMode(next);
    savePreferredAppMode(next);
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
          ...(mode === "local" && lan ? { lanAddress: lan.selected } : {}),
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

  async function changeSite(nextSite: string, setting: "site" | "startup-site" = "site", starAfterApproval = false, allowed = true): Promise<boolean> {
    if (siteBusy) return false;
    const finish = beginStateChange();
    setSiteBusy(true);
    setSiteError(undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    async function save(setting: "site" | "startup-site"): Promise<boolean> {
      const response = await fetch(`/api/client-launcher/${setting}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: nextSite, ...(setting === "site" ? { allowed } : {}) }),
        signal: controller.signal,
      });
      const result = launcherStateSchema.pick({ sites: true, startupSite: true, startupMode: true, ownedSites: true }).safeParse(await response.json().catch(() => null));
      if (result.success) {
        setSites(result.data.sites);
        setStartupSite(result.data.startupSite);
        setStartupMode(result.data.startupMode || undefined);
        setOwnedSites(result.data.ownedSites);
      }
      if (response.status === 409 && result.success) {
        setSiteError(t("client.connect.changed"));
        return false;
      }
      if (!response.ok || !result.success) throw new Error("Could not save App settings");
      return true;
    }
    try {
      return await save(setting) && (!starAfterApproval || await save("startup-site"));
    } catch {
      setSiteError(t("client.connect.saveFailed"));
      return false;
    } finally { clearTimeout(timer); finish(); setSiteBusy(false); }
  }

  async function approveSite(site: string): Promise<void> {
    if (await changeSite(site, "site", openOnApproval) && manualSite) {
      window.location.replace(launchURL(`${site}/#piik-client=1`));
    }
  }

  const errorKey = `client.launch.failure.${error?.reason}`;
  return (
    <div className="lr-app">
      <AppHeader homeHref="/client" diagnosticControl={appDebug === undefined ? null : (
        <Btn icon={appDebug ? "arrowDown" : "cpu"} size="compact" quiet
          title={appDebug ? "client.launch.debugExportHint" : "client.launch.debugHint"}
          cap={appDebug ? "client.launch.debugExport" : "debug.start"}
          pressed={appDebug ? undefined : false} tone={appDebug ? "on" : undefined}
          hint={appDebug ? "hint-debug-export" : "debug-start"} busy={debugBusy}
          disabled={debugBusy || (!appDebug && (loading || error?.kind === "load"))}
          onClick={() => void (appDebug ? exportDebug() : enableDebug())} />
      )} />
      <main className="lr-client-launch">
        {debugError && <Pill icon="alert" tone="bad" comic="warning" alert label={t(appDebug ? "client.launch.debugExportFailed" : "client.launch.debugFailed")} />}
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
              <p className={vis ? "visually-hidden" : undefined}>{t(approvalCurrent ? "client.connect.return"
                : "client.connect.approveChannelHint")}</p>
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
              <Btn icon="x" title={!manualSite && approvalCurrent ? "client.connect.close" : "common.cancel"} cap={!manualSite && approvalCurrent ? "client.connect.close" : "common.cancel"} hint="hint-close"
                disabled={manualSite && siteBusy} onClick={() => {
                  if (manualSite) {
                    setSiteEntry(entry => ({ ...entry, confirming: false }));
                    setSiteError(undefined);
                    setOpenOnApproval(false);
                  } else window.close();
                }} />
              {(!approvalCurrent || (manualSite && siteBusy)) && <Btn icon="check" title={manualSite ? "client.connect.approveAndOpen" : "client.connect.approve"}
                cap={manualSite ? "client.connect.approveAndOpen" : "client.connect.approve"} tone="primary"
                hint="hint-client-site" busy={siteBusy} disabled={!validSite || siteBusy} onClick={() => void approveSite(requestedSite)} />}
              {manualSite && approvalCurrent && !siteBusy && <a className="lr-btn is-primary" href={launchURL(`${requestedSite}/#piik-client=1`)}>
                <Glyph name="arrowRight" size={19} />
                <span className={vis ? "visually-hidden" : "lr-cap"}>{t("client.connect.openSite")}</span>
              </a>}
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
            sites={sites}
            siteAddress={siteEntry.origin}
            onSelectSite={origin => {
              setSiteEntry({ origin, confirming: true });
              setSiteError(undefined);
            }}
            startupSite={startupSite}
            ownedStartup={startupMode}
            ownedSites={ownedSites}
            onToggleStartupSite={site => void changeSite(startupSite === site || startupMode && ownedSites.includes(site) ? "" : site, "startup-site")}
            onModeChange={changeMode}
            onRemoveSite={site => void changeSite(site, "site", false, false)}
            siteBusy={siteBusy}
            siteError={siteError}
            target={target}
            localCertificate={localCertificate}
            entryURL={launchURL}
            lan={lan && { ...lan, onChange: (selected) => setLan({ ...lan, selected }) }}
            onSubmit={launch}
          >
            {update ? <AppReleaseNotice update={update} native={appUpdate.view ? { ...appUpdate, view: appUpdate.view } : undefined} />
              : appUpdate.view && (appUpdate.view.operationId || appUpdate.error) && <AppUpdateStatus {...appUpdate} view={appUpdate.view} />}
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
