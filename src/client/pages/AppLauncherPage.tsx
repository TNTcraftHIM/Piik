import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { z } from "zod";

import { BrandMark } from "../components/living/BrandMark";
import { HintComic } from "../components/living/hints";
import { LoadingStatus } from "../components/living/WaitingStatus";
import { AppReleaseNotice, AppUpdateStatus } from "../components/living/AppReleaseNotice";
import { useAppUpdate } from "../lib/use-app-update";
import { AppHeader } from "../components/living/Header";
import { LocalConnectionDetails, SiteStartControls } from "../components/living/LauncherForm";
import { LauncherWorkspace } from "../components/living/LauncherWorkspace";
import { ChannelSettingsDialog } from "../channel/components/ChannelSettingsDialog";
import { Btn, Pill } from "../components/living/primitives";
import { hasCopyPreference, isCopyKey, useCopy } from "../ui/copy";
import { consoleLanguage } from "../locales";
import { Glyph } from "../ui/icons";
import { currentThemePreference, subscribeTheme } from "../ui/theme";
import { clientLaunchURL, readPreferredAppMode, savePreferredAppMode, type AppMode, type ClientLaunchPresentation } from "../lib/app-launch";
import { useReleaseUpdate } from "../lib/use-release-update";
import { AppSiteBookmarks } from "./AppSiteBookmarks";
import { downloadBlob } from "../lib/download";
import { publicSiteOrigin } from "../lib/site-address";

const localCertificateSchema = z.object({ origin: z.string().url(), sha256Fingerprint: z.string().regex(/^[A-Fa-f0-9]{64}$/) });
const launcherStateSchema = z.object({
  sites: z.array(z.string()),
  startupSite: z.string(),
  ownedSites: z.array(z.string()).default([]),
  startupMode: z.enum(["local", "link", "external", ""]).nullish(),
  publicOrigin: z.string().url().optional(),
  target: z.string().optional(),
  localCertificate: localCertificateSchema.optional(),
  starting: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  revision: z.string(),
  version: z.string().default("development"),
  packageTarget: z.string().optional(),
  controlPort: z.number().int().optional(),
  sitePort: z.number().int().min(1).max(65535),
  siteAddress: z.string().url(),
  windowNavigation: z.boolean().default(false),
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
  const [launching, setLaunching] = useState(false);
  const [mode, setMode] = useState<AppMode>(readPreferredAppMode);
  const [serverState, setServerState] = useState<z.infer<typeof launcherStateSchema>>();
  const { sites = [], startupSite = "", ownedSites = [], target, localCertificate,
    controlPort, windowNavigation = false, debug: appDebug } = serverState ?? {};
  const startupMode = serverState?.startupMode === "external" ? "link" : serverState?.startupMode || undefined;
  const [openOnApproval, setOpenOnApproval] = useState(false);
  const [error, setError] = useState<{ kind: "load" | "launch"; reason?: string; detail?: string } | null>(null);
  const starting = error?.kind !== "load" && (launching || serverState?.starting === true);
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugError, setDebugError] = useState(false);
  const [reload, setReload] = useState(0);
  const [lanAddress, setLanAddress] = useState<string>();
  const lan = serverState?.lan && { ...serverState.lan, selected: lanAddress ?? serverState.lan.selected };
  const [portDraft, setPortDraft] = useState<number>();
  const sitePort = portDraft ?? serverState?.sitePort;
  const [publicEntry, setPublicEntry] = useState({ existing: false, origin: "" });
  const [publicEntryError, setPublicEntryError] = useState(false);
  const localAddress = serverState && (() => {
    const address = new URL(serverState.siteAddress);
    address.port = String(sitePort);
    return address.origin;
  })();
  const build = serverState;
  const appUpdate = useAppUpdate();
  const operation = appUpdate.view?.operationId && appUpdate.view.version && appUpdate.view.revision
    ? { version: appUpdate.view.version, revision: appUpdate.view.revision } : undefined;
  const { update } = useReleaseUpdate(build, operation);
  const version = build?.version === "development" && /^[a-f0-9]{40}$/i.test(build.revision)
    ? `${build.version} (${build.revision.slice(0, 7)})` : build?.version;
  const [bookmarksOnly] = useState(() => new URLSearchParams(location.search).has("bookmarks") || new URLSearchParams(location.hash.slice(1)).has("open"));
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState<string>();
  const [panel, setPanel] = useState<"launch">();
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
  const openSiteOnStart = Boolean(approvalCurrent && (startupSite === requestedSite || startupMode && ownedSites.includes(requestedSite)));

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
          setLanAddress(state.lan?.selected);
          if (state.startupMode) setMode(state.startupMode === "external" ? "link" : state.startupMode);
          setPublicEntry({ existing: !!state.publicOrigin, origin: state.publicOrigin ?? "" });
          restoredSettings = true;
        }
        setServerState(state);
        setLaunching(false);
        setError(previous => state.detail ? { kind: "launch", reason: state.reason, detail: state.detail }
          : state.target || previous?.kind === "load" ? null : previous);
        setLoading(false);
        if (enterOnReady && (state.target || state.detail)) {
          enterOnReady = false;
          if (state.target) window.location.replace(launchURL(state.target, { debug: state.debug === true, controlPort: state.controlPort }));
        }
        if (state.starting) timer = setTimeout(() => void readState(), 750);
      })
      .catch(() => {
        if (!fresh()) return;
        setError({ kind: "load" });
        setLaunching(false);
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
      setServerState(previous => previous && { ...previous, debug: true });
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
    const external = mode === "link" && publicEntry.existing;
    const publicOrigin = external ? publicSiteOrigin(publicEntry.origin) : null;
    if (external && !publicOrigin) { setPublicEntryError(true); return; }
    const finish = beginStateChange();
    setLaunching(true);
    setError(null);
    try {
      const response = await fetch("/api/client-launcher/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: external ? "external" : mode,
          ...(external ? { publicOrigin } : {}),
          port: sitePort,
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
        setLaunching(false);
        return;
      }
      const result = launcherResultSchema.parse(await response.json());
      window.location.replace(launchURL(result.target));
    } catch {
      setError({ kind: "launch" });
      setLaunching(false);
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
        setServerState(previous => previous && { ...previous, ...result.data, startupMode: result.data.startupMode });
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
    await changeSite(site, "site", openOnApproval);
  }

  async function manageSite(site: string, setting: "site" | "startup-site", allowed = true): Promise<void> {
    if (!await changeSite(site, setting, false, allowed)) throw new Error("Could not save App settings");
  }
  const siteManagement = {
    sites, startupSite, ownedStartup: startupMode, ownedSites, busy: siteBusy, accessError: siteError,
    onApprove: (site: string) => manageSite(site, "site"),
    onRevoke: (site: string) => manageSite(site, "site", false),
    onStartup: (site: string) => manageSite(site, "startup-site"),
  };

  const errorKey = `client.launch.failure.${error?.reason}`;
  const home = !requestedSite && !bookmarksOnly;
  const homeReady = home && !loading && error?.kind !== "load";
  const roomError = error?.kind === "launch" ? <>
    <Pill icon="alert" tone="bad" label={t("client.launch.error")} alert comic="signal-failed" />
    {isCopyKey(errorKey) && <p className={vis ? "visually-hidden" : "lr-client-launch-status"}>{t(errorKey)}</p>}
    <p className={vis ? "visually-hidden" : "lr-client-launch-status"}>{t("client.launch.retryHint")}</p>
    {error.detail && <details className="lr-client-launch-technical">
      <summary>{t("client.launch.errorDetails")}</summary>
      <p className="lr-client-launch-detail">{error.detail}</p>
    </details>}
  </> : undefined;
  const footer = <>
    <a className="lr-btn is-dense is-quiet" href="https://github.com/TNTcraftHIM/Piik" target="_blank" rel="noopener noreferrer">GitHub<span aria-hidden="true"> ↗</span></a>
    {version && <p className="lr-client-version">
      <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.version", { version })}</span>
      {vis && <span aria-hidden="true">{version}</span>}
    </p>}
  </>;
  return (
    <div className={`lr-app${homeReady ? " lr-launcher-page" : ""}`}>
      <AppHeader homeHref="/client" diagnosticControl={appDebug === undefined ? null : (
        <Btn icon={appDebug ? "arrowDown" : "cpu"} size="compact" quiet
          title={appDebug ? "client.launch.debugExportHint" : "client.launch.debugHint"}
          cap={appDebug ? "client.launch.debugExport" : "debug.start"}
          pressed={appDebug ? undefined : false} tone={appDebug ? "on" : undefined}
          hint={appDebug ? "hint-debug-export" : "debug-start"} busy={debugBusy}
          disabled={debugBusy || (!appDebug && (loading || error?.kind === "load"))}
          onClick={() => void (appDebug ? exportDebug() : enableDebug())} />
      )} />
      <main className={homeReady ? undefined : "lr-client-launch"}>
        {debugError && <Pill icon="alert" tone="bad" comic="warning" alert label={t(appDebug ? "client.launch.debugExportFailed" : "client.launch.debugFailed")} />}
        {loading ? (
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
        ) : bookmarksOnly ? (
          <AppSiteBookmarks windowNavigation={windowNavigation} closeOnOpen {...siteManagement} />
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
              <Btn icon="x" title={approvalCurrent ? "client.connect.close" : "common.cancel"} cap={approvalCurrent ? "client.connect.close" : "common.cancel"} hint="hint-close"
                disabled={siteBusy} onClick={() => window.close()} />
              {!approvalCurrent && <Btn icon="check" title="client.connect.approve" cap="client.connect.approve" tone="primary"
                hint="hint-client-site" busy={siteBusy} disabled={!validSite || siteBusy} onClick={() => void approveSite(requestedSite)} />}
            </div>
          </section>
        ) : <AppSiteBookmarks windowNavigation={windowNavigation} {...siteManagement} render={navigation => <LauncherWorkspace
          bookmarks={navigation.bookmarks} bookmarksError={navigation.loadError} onRetryBookmarks={navigation.retry}
          onOpenBookmark={navigation.open} onManageBookmarks={navigation.manage}
          ready={!!target} starting={starting} invitationForm={navigation.invitationForm} footer={footer}
          localSiteAction={target ? <a className="lr-btn is-primary" href={launchURL(target)}>
            <Glyph name="arrowRight" size={19} /><span className={vis ? "visually-hidden" : "lr-cap"}>{t("client.connect.continue")}</span>
          </a> : <Btn icon="arrowRight" title="client.launch.go" cap="client.launch.go" busy={starting} disabled={starting}
            onClick={() => setPanel("launch")} />}
        >
            {panel !== "launch" && roomError}
            {localCertificate && <LocalConnectionDetails certificate={localCertificate} />}
            {serverState?.publicOrigin && <p className="lr-launcher-public-address">
              <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.publicAddress")}</span>{" "}
              <a href={serverState.publicOrigin} target="_blank" rel="noopener noreferrer">{serverState.publicOrigin}</a>
            </p>}
            {update ? <AppReleaseNotice update={update} native={appUpdate.view ? { ...appUpdate, view: appUpdate.view } : undefined} />
              : appUpdate.view && (appUpdate.view.operationId || appUpdate.error) && <AppUpdateStatus {...appUpdate} view={appUpdate.view} />}
        </LauncherWorkspace>} />}
      </main>
      {!homeReady && <footer className="lr-client-footer">{footer}</footer>}
      {homeReady && panel === "launch" && <ChannelSettingsDialog title={t("client.launch.room")} closeDisabled={starting} onClose={() => setPanel(undefined)}>
        {starting ? <LoadingStatus label="client.launch.starting" waitingCaption /> : <form className="c3-settings-panels lr-client-launch-panel" onSubmit={launch}>
          <SiteStartControls mode={mode} onModeChange={changeMode} roomError={roomError}
            target={target} localCertificate={localCertificate} entryURL={launchURL}
            port={sitePort === undefined ? undefined : { value: sitePort, onChange: setPortDraft }}
            publicEntry={localAddress ? { ...publicEntry, localAddress,
              error: publicEntryError ? t("client.launch.invalidPublicAddress") : undefined,
              onChange: value => { setPublicEntry(value); setPublicEntryError(false); } } : undefined}
            lan={lan && { ...lan, onChange: setLanAddress }} />
        </form>}
      </ChannelSettingsDialog>}
    </div>
  );
}
