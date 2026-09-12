import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

import { BrandLoader, BrandMark } from "../components/living/BrandMark";
import { Tooltip } from "../components/living/Tooltip";
import { AppHeader } from "../components/living/Header";
import { LauncherForm, type AppMode } from "../components/living/LauncherForm";
import { Btn, Pill } from "../components/living/primitives";
import { Glyph } from "../ui/icons";
import { useCopy, type CopyKey } from "../ui/copy";
import { currentThemePreference } from "../ui/theme";
import { clientLaunchURL } from "../lib/session";
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
});
const launcherResultSchema = z.object({ target: z.string().url() }).strict();

export function AppLauncherPage() {
  const { lang, vis, t } = useCopy();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<AppMode>("link");
  const [site, setSite] = useState("");
  const [localAccessPassword, setLocalAccessPassword] = useState("");
  const [error, setError] = useState<null | "load" | "launch">(null);
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
        setError("load");
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  async function launch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (starting || (mode === "site" && !site.trim())) return;
    setStarting(true);
    setError(null);
    const presentation = { lang, vis, theme: currentThemePreference() };
    try {
      const response = await fetch("/api/client-launcher/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          language: vis ? "vis" : lang,
          ...(mode === "site" ? { site } : { localAccessPassword }),
        }),
      });
      if (!response.ok) throw new Error();
      const result = launcherResultSchema.parse(await response.json());
      window.location.replace(clientLaunchURL(result.target, presentation));
    } catch {
      setError("launch");
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
      <AppHeader homeHref="/client" />
      <main className="lr-client-launch">
        {loading || starting ? (
          <div
            className="lr-loading"
            role="status"
            aria-label={t(
              starting ? "client.launch.starting" : "gate.checking",
            )}
          >
            <BrandLoader />
            {vis ? null : (
              <span className="lr-client-launch-status">
                {t(starting ? "client.launch.starting" : "gate.checking")}
              </span>
            )}
          </div>
        ) : error === "load" ? (
          <div className="lr-client-launch-panel">
            <BrandMark size={68} motion="once" />
            <Pill
              icon="alert"
              tone="bad"
              label={t("client.launch.loadFailed")}
              alert
              comic="warning"
            />
            <Btn
              icon="refresh"
              title="common.refresh"
              cap="common.refresh"
              onClick={() => window.location.reload()}
            />
          </div>
        ) : (
          <LauncherForm
            mode={mode}
            site={site}
            localAccessPassword={localAccessPassword}
            onModeChange={(value) => {
              setMode(value);
              setError(null);
            }}
            onSiteChange={(value) => {
              setSite(value);
              setError(null);
            }}
            onLocalAccessPasswordChange={(value) => {
              setLocalAccessPassword(value);
              setError(null);
            }}
            error={error === "launch"}
            onSubmit={launch}
          >
            {updateLink &&
              (vis ? (
                updateLink
              ) : (
                <Tooltip text={updateText}>{updateLink}</Tooltip>
              ))}
          </LauncherForm>
        )}
      </main>
    </div>
  );
}
