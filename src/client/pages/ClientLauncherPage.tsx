import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

import { BrandLoader, BrandMark } from "../components/living/BrandMark";
import { AppHeader } from "../components/living/Header";
import { Btn, Pill } from "../components/living/primitives";
import { Glyph, type GlyphName } from "../ui/icons";
import { useCopy, type CopyKey } from "../ui/copy";
import {
  checkReleaseUpdate,
  type ReleaseUpdateNotice,
} from "../lib/release-update";

type ClientMode = "local" | "link" | "site";

const launcherStateSchema = z
  .object({
    site: z.string(),
    defaultMode: z.enum(["local", "site"]),
    revision: z.string(),
  })
  .strict();
const launcherResultSchema = z.object({ target: z.string().url() }).strict();

const MODES: Array<{
  mode: ClientMode;
  icon: GlyphName;
  label: CopyKey;
  hint: CopyKey;
}> = [
  {
    mode: "local",
    icon: "users",
    label: "client.launch.local",
    hint: "client.launch.localHint",
  },
  {
    mode: "link",
    icon: "globe",
    label: "client.launch.link",
    hint: "client.launch.linkHint",
  },
  {
    mode: "site",
    icon: "server",
    label: "client.launch.site",
    hint: "client.launch.siteHint",
  },
];

export function ClientLauncherPage() {
  const { vis, t } = useCopy();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<ClientMode>("local");
  const [site, setSite] = useState("");
  const [error, setError] = useState(false);
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
        setLoading(false);
        void checkReleaseUpdate(state.revision).then((notice) => {
          if (current && notice) setUpdate(notice);
        }).catch(() => undefined);
      })
      .catch(() => {
        if (!current) return;
        setError(true);
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
    setError(false);
    try {
      const response = await fetch("/api/client-launcher/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, ...(mode === "site" ? { site } : {}) }),
      });
      if (!response.ok) throw new Error();
      const result = launcherResultSchema.parse(await response.json());
      window.location.replace(result.target);
    } catch {
      setError(true);
      setStarting(false);
    }
  }

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
        ) : (
          <form className="lr-client-launch-panel" onSubmit={launch}>
            <BrandMark size={68} motion="once" />
            {vis ? null : (
              <header className="lr-client-launch-copy">
                <h1>{t("client.launch.title")}</h1>
                <p>{t("client.launch.hint")}</p>
              </header>
            )}

            {update ? (
              <a
                className="lr-client-update"
                href={update.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("client.update.available")}
                title={vis ? undefined : t("client.update.available")}
              >
                <Glyph name="arrowUp" size={17} />
                {vis ? (
                  <span className="visually-hidden">
                    {t("client.update.available")}
                  </span>
                ) : (
                  <span>{t("client.update.available")}</span>
                )}
              </a>
            ) : null}

            <div
              className="lr-client-modes"
              role="radiogroup"
              aria-label={t("client.launch.title")}
            >
              {MODES.map((choice) => (
                <button
                  key={choice.mode}
                  type="button"
                  role="radio"
                  className={`lr-client-mode${mode === choice.mode ? " is-selected" : ""}`}
                  aria-checked={mode === choice.mode}
                  aria-label={t(choice.label)}
                  title={vis ? undefined : t(choice.hint)}
                  onClick={() => {
                    setMode(choice.mode);
                    setError(false);
                  }}
                >
                  <Glyph name={choice.icon} size={27} />
                  {vis ? null : (
                    <span>
                      <strong>{t(choice.label)}</strong>
                      <small>{t(choice.hint)}</small>
                    </span>
                  )}
                </button>
              ))}
            </div>

            {mode === "site" ? (
              <label className="lr-input lr-client-site">
                <Glyph name="link" size={18} />
                <input
                  type="url"
                  value={site}
                  autoFocus
                  spellCheck={false}
                  inputMode="url"
                  placeholder="https://share.example"
                  aria-label={t("client.launch.siteAddress")}
                  onChange={(event) => {
                    setSite(event.target.value);
                    setError(false);
                  }}
                />
              </label>
            ) : null}

            {error ? (
              <Pill
                icon="alert"
                tone="bad"
                label={t("client.launch.error")}
                alert
                comic="warning"
              />
            ) : null}
            <Btn
              icon="arrowRight"
              title="client.launch.go"
              cap="client.launch.go"
              tone="primary"
              type="submit"
              disabled={mode === "site" && !site.trim()}
            />
          </form>
        )}
      </main>
    </div>
  );
}
