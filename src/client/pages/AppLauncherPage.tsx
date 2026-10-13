import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

import { HintComic } from "../components/living/hints";
import { LoadingStatus } from "../components/living/WaitingStatus";
import { AppReleaseNotice } from "../components/living/AppReleaseNotice";
import { AppHeader } from "../components/living/Header";
import { LauncherForm, type AppMode } from "../components/living/LauncherForm";
import { Btn, Pill } from "../components/living/primitives";
import { hasCopyPreference, useCopy } from "../ui/copy";
import { consoleLanguage } from "../locales";
import { currentThemePreference } from "../ui/theme";
import { clientLaunchURL, type ClientLaunchPresentation } from "../lib/session";
import {
  checkReleaseUpdate,
  type ReleaseUpdateNotice,
} from "../lib/release-update";

const launcherStateSchema = z.object({
  site: z.string(),
  localAccessPassword: z.string(),
  defaultMode: z.enum(["local", "link"]),
  target: z.string().optional(),
  starting: z.boolean().optional(),
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
const launcherErrorSchema = z.object({ detail: z.string() });

export function AppLauncherPage() {
  const { lang, vis, t } = useCopy();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<AppMode>("link");
  const [site, setSite] = useState("");
  const [localAccessPassword, setLocalAccessPassword] = useState("");
  const [error, setError] = useState<{ kind: "load" | "launch"; detail?: string } | null>(null);
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
  const requestedSite = new URLSearchParams(window.location.search).get("site");
  const validSite = requestedSite && (() => {
    try {
      const url = new URL(requestedSite);
      return ["http:", "https:"].includes(url.protocol) && url.origin === requestedSite;
    } catch { return false; }
  })();
  const approvalCurrent = validSite && site === requestedSite;

  useEffect(() => {
    // The App's saved exact origin owns permission, including repeat connections.
    // The requesting page still verifies authorized health before using App.
    if (approvalCurrent) window.opener?.postMessage({ type: "piik-app-approved", site: requestedSite }, requestedSite);
  }, [approvalCurrent, requestedSite]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checkedRelease = false;
    let restoredSettings = false;
    let reading = false;
    const readState = () => {
      if (reading || !current) return;
      reading = true;
      clearTimeout(timer);
      void fetch("/api/client-launcher", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return launcherStateSchema.parse(await response.json());
      })
      .then((state) => {
        if (!current) return;
        if (!restoredSettings) {
          setMode(state.defaultMode);
          setLocalAccessPassword(state.localAccessPassword);
          setLan(state.lan);
          restoredSettings = true;
        }
        setVersion(state.version);
        setTarget(state.target);
        setStarting(state.starting === true);
        setSite(state.site);
        setAppDebug(state.debug);
        setDebug(state.debug === true);
        setError(previous => state.detail ? { kind: "launch", detail: state.detail }
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
        if (!current) return;
        setError({ kind: "load" });
        setStarting(false);
        setLoading(false);
      }).finally(() => { reading = false; });
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

  async function enableDebug(): Promise<void> {
    if (debugBusy) return;
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
    finally { setDebugBusy(false); }
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
        setError({ kind: "launch", detail: failure.success ? failure.data.detail : undefined });
        setStarting(false);
        return;
      }
      const result = launcherResultSchema.parse(await response.json());
      window.location.replace(launchURL(result.target));
    } catch {
      setError({ kind: "launch" });
      setStarting(false);
    }
  }

  async function changeSite(nextSite: string): Promise<void> {
    if (siteBusy) return;
    setSiteBusy(true);
    setSiteError(undefined);
    try {
      const response = await fetch("/api/client-launcher/site", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: nextSite, expectedSite: site }),
      });
      const result = z.object({ site: z.string() }).safeParse(await response.json().catch(() => null));
      if (result.success) setSite(result.data.site);
      if (response.status === 409 && result.success) {
        setSiteError(t("client.connect.changed"));
        return;
      }
      if (!response.ok || !result.success) throw new Error("App approval failed");
      setSite(result.data.site);
    } catch {
      setSiteError(t("client.connect.saveFailed"));
    } finally { setSiteBusy(false); }
  }

  return (
    <div className="lr-app">
      <AppHeader homeHref="/client" diagnosticControl={appDebug === undefined ? null : (
        <Btn icon="cpu" title="client.launch.debugHint" cap="client.launch.debug"
          pressed={debug} tone={debug ? "on" : undefined} hint="debug-start"
          disabled={appDebug || debugBusy || loading || starting || !!target || error !== null}
          onClick={() => void enableDebug()} />
      )} />
      <main className="lr-client-launch">
        {debugError && <Pill icon="alert" tone="bad" comic="warning" alert label={t("client.launch.debugFailed")} />}
        {loading || (starting && !requestedSite) ? (
          <LoadingStatus label={starting ? "client.launch.starting" : "common.loading"} />
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
          <section className="lr-client-approval">
            <HintComic kind="hint-client-site" />
            <h1 className={vis ? "visually-hidden" : undefined}>{t(approvalCurrent ? "client.connect.approved" : "client.connect.approveTitle")}</h1>
            <div className="lr-client-approval-origin">{requestedSite}</div>
            <p className={vis ? "visually-hidden" : undefined}>{t(approvalCurrent ? "client.connect.return" : "client.connect.approveHint")}</p>
            {!approvalCurrent && site && site !== requestedSite && <p>{t("client.connect.replace", { site })}</p>}
            {!validSite && <Pill icon="alert" tone="bad" label={t("client.connect.invalid")} comic="signal-failed" />}
            {siteError && <p role="alert">{siteError}</p>}
            <div className="lr-client-approval-actions">
              <Btn icon="x" title={approvalCurrent ? "client.connect.close" : "common.cancel"} cap={approvalCurrent ? "client.connect.close" : "common.cancel"}
                onClick={() => window.close()} />
              {!approvalCurrent && <Btn icon="check" title="client.connect.approve" cap="client.connect.approve" tone="primary"
                hint="hint-client-site" disabled={!validSite || siteBusy} onClick={() => void changeSite(requestedSite)} />}
            </div>
          </section>
        ) : (
          <LauncherForm
            version={version}
            roomError={error?.kind === "launch" ? <>
              <Pill icon="alert" tone="bad" label={t("client.launch.error")} alert comic="signal-failed" />
              {error.detail && <p className="lr-client-launch-detail">{error.detail}</p>}
              <p className={vis ? "visually-hidden" : "lr-client-launch-status"}>{t("client.launch.reopen")}</p>
            </> : undefined}
            mode={mode}
            site={site}
            localAccessPassword={localAccessPassword}
            onModeChange={setMode}
            onRemoveSite={() => void changeSite("")}
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
    </div>
  );
}
