import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

import { BrandMark } from "../components/living/BrandMark";
import { LoadingStatus } from "../components/living/WaitingStatus";
import { Tooltip } from "../components/living/Tooltip";
import { AppHeader } from "../components/living/Header";
import { LauncherForm, type AppMode } from "../components/living/LauncherForm";
import { Btn, Pill } from "../components/living/primitives";
import { Glyph } from "../ui/icons";
import { hasCopyPreference, useCopy, type CopyKey } from "../ui/copy";
import { consoleLanguage } from "../locales";
import { currentThemePreference } from "../ui/theme";
import { clientLaunchURL, type ClientLaunchPresentation } from "../lib/session";
import { browserDebugEnabled } from "../lib/debug";
import {
  checkReleaseUpdate,
  type ReleaseUpdateNotice,
} from "../lib/release-update";

const launcherStateSchema = z.object({
  site: z.string(),
  localAccessPassword: z.string(),
  defaultMode: z.enum(["local", "link", "site"]),
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
  const [lan, setLan] = useState<z.infer<typeof launcherStateSchema>["lan"]>();
  const [update, setUpdate] = useState<ReleaseUpdateNotice | null>(null);

  useEffect(() => {
    let current = true;
    void fetch("/api/client-launcher", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return launcherStateSchema.parse(await response.json());
      })
      .then((state) => {
        if (!current) return;
        setMode(state.defaultMode);
        setSite(state.site);
        setLocalAccessPassword(state.localAccessPassword);
        setAppDebug(state.debug);
        setDebug(state.debug === true || browserDebugEnabled);
        setLan(state.lan);
        setLoading(false);
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
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  async function launch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (starting || (mode === "site" && !site.trim()) ||
      (mode === "local" && lan !== undefined && !lan.selected)) return;
    setStarting(true);
    setError(null);
    const theme = currentThemePreference();
    const presentation: ClientLaunchPresentation = {
      lang, vis, theme,
      explicit: [
        ...(hasCopyPreference() ? ["copy" as const] : []),
        ...(theme !== null ? ["theme" as const] : []),
      ],
    };
    try {
      const response = await fetch("/api/client-launcher/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          language: consoleLanguage(lang, vis),
          ...(appDebug !== undefined && debug ? { debug: true } : {}),
          ...(mode === "local" && lan ? { lanAddress: lan.selected } : {}),
          ...(mode === "site" ? { site } : { localAccessPassword }),
        }),
      });
      if (!response.ok) {
        const failure = launcherErrorSchema.safeParse(await response.json().catch(() => null));
        setError({ kind: "launch", detail: failure.success ? failure.data.detail : undefined });
        setStarting(false);
        return;
      }
      const result = launcherResultSchema.parse(await response.json());
      window.location.replace(clientLaunchURL(result.target, presentation, debug));
    } catch {
      setError({ kind: "launch" });
      setStarting(false);
    }
  }

  const updateKey: CopyKey =
    update?.kind === "different-build"
      ? "client.update.differentBuild"
      : update?.kind === "official-release"
        ? "client.update.official"
        : "client.update.available";
  const updateText = update ? `${t(updateKey)} · ${update.version}` : "";
  const updateLink = update ? (
    <a
      className="lr-client-update"
      href={update.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={updateText}
    >
      <Glyph name="arrowUp" size={17} />
      <span className={vis ? "visually-hidden" : undefined}>{updateText}</span>
      {vis && <span aria-hidden="true">{update.version}</span>}
    </a>
  ) : null;

  return (
    <div className="lr-app">
      <AppHeader homeHref="/client" diagnosticControl={appDebug === undefined ? null : (
        <Btn icon="cpu" title="client.launch.debugHint" cap="client.launch.debug"
          pressed={debug} tone={debug ? "on" : undefined} hint="debug-start"
          disabled={appDebug || loading || starting || error !== null}
          onClick={() => setDebug((value) => !value)} />
      )} />
      <main className="lr-client-launch">
        {loading || starting ? (
          <LoadingStatus label={starting ? "client.launch.starting" : "common.loading"} />
        ) : error ? (
          <div className="lr-client-launch-panel">
            <BrandMark size={68} motion="once" />
            <Pill
              icon="alert"
              tone="bad"
              label={t(error.kind === "load" ? "client.launch.loadFailed" : "client.launch.error")}
              alert
              comic="signal-failed"
            />
            {error.kind === "launch" ? <>
              {error.detail && <p className="lr-client-launch-detail">{error.detail}</p>}
              <p className={vis ? "visually-hidden" : "lr-client-launch-status"}>{t("client.launch.reopen")}</p>
            </> : <Btn
              icon="refresh"
              title="common.refresh"
              cap="common.refresh"
              hint="page-refresh"
              onClick={() => window.location.reload()}
            />}
          </div>
        ) : (
          <LauncherForm
            mode={mode}
            site={site}
            localAccessPassword={localAccessPassword}
            onModeChange={setMode}
            onSiteChange={setSite}
            onLocalAccessPasswordChange={setLocalAccessPassword}
            lan={lan && { ...lan, onChange: (selected) => setLan({ ...lan, selected }) }}
            onSubmit={launch}
          >
            {update && updateLink && <Tooltip kind="update-available" text={vis ? update.version : updateText}>{updateLink}</Tooltip>}
          </LauncherForm>
        )}
      </main>
    </div>
  );
}
