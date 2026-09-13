// App header: brand mark, LED connection state, language selection and theme.
import { useState } from "react";
import { browserDebugEnabled, debugError, downloadBrowserDebug } from "../../lib/debug";
import { VisGlyph } from "./primitives";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import type { ComicKind } from "./Comic";
import { useCopy } from "../../ui/copy";
import { isLang, locales } from "../../locales";
import { useTheme } from "../../ui/theme";
import { Glyph } from "../../ui/icons";

export type LedState = "live" | "busy" | "warn" | "bad" | "off";

export function LedStrip({
  state,
  label,
  comic,
}: {
  state: LedState;
  label: string;
  comic?: ComicKind;
}) {
  const { vis } = useCopy();
  const wrapped = !vis || comic;
  const Trigger = wrapped ? "button" : "span";
  const strip = (
    <Trigger
      type={wrapped ? "button" : undefined}
      className="lr-leds"
      data-state={state}
      aria-label={label}
    >
      <i />
      <i />
      <i />
      {vis ? null : <span className="lr-leds-label">{label}</span>}
    </Trigger>
  );
  return (
    <span role="status">
      {wrapped ? (
        <Tooltip toggleOnClick kind={comic} tone={state} text={vis ? undefined : label} place="below" align="start">
          {strip}
        </Tooltip>
      ) : strip}
    </span>
  );
}

export function HeaderControls() {
  const { lang, vis, t, setLang, setVis } = useCopy();
  const { theme, toggle } = useTheme();
  const [debugExport, setDebugExport] = useState<"idle" | "busy" | "failed">("idle");
  const extraLanguages = Object.entries(locales).filter(([key]) => key !== "zh" && key !== "en");
  const selectedExtra = !vis && extraLanguages.find(([key]) => key === lang);
  const themeTitle = t(theme === "dark" ? "theme.light" : "theme.dark");
  const themeButton = (
    <button
      type="button"
      className="lr-btn"
      style={{ minWidth: 40, height: 40, borderRadius: 999 }}
      aria-label={themeTitle}
      onClick={(event) => {
        // Pointer activation must not pin the hint open; keyboard keeps focus.
        if (event.detail !== 0) event.currentTarget.blur();
        toggle();
      }}
    >
      <VisGlyph name={theme === "dark" ? "sun" : "moon"} size={16} draw="theme-toggle" />
      {vis ? null : (
        <span className="lr-cap">
          {t(theme === "dark" ? "theme.light.short" : "theme.dark.short")}
        </span>
      )}
    </button>
  );
  const debugTitle = t(debugExport === "failed" ? "debug.exportFailed" : "debug.exportHint");
  const debugButton = (
    <button
      type="button" className="lr-btn" disabled={debugExport === "busy"}
      aria-label={debugTitle} aria-busy={debugExport === "busy" || undefined}
      onClick={(event) => {
        if (event.detail !== 0) event.currentTarget.blur();
        setDebugExport("busy");
        void downloadBrowserDebug().then(() => setDebugExport("idle")).catch((error) => {
          debugError("export", "collector-failed", error, { collector: "download" });
          setDebugExport("failed");
        });
      }}
    >
      <Glyph name={debugExport === "busy" ? "loader" : debugExport === "failed" ? "alert" : "arrowDown"}
        size={16} className={debugExport === "busy" ? "lr-spin" : undefined} />
      {vis ? null : <span className="lr-cap">{t(debugExport === "failed" ? "common.retry" : "debug.export")}</span>}
    </button>
  );
  return (
    <span className="lr-top-right lr-header-controls">
      {browserDebugEnabled && (
        <Tooltip kind="hint-debug-export" text={vis ? undefined : debugTitle} place="below" align="end">
          {debugButton}
        </Tooltip>
      )}
      <span className="lr-lang" role="group" aria-label={t("mode.language")}>
        {(["zh", "en"] as const).map((key) => (
          <button
            key={key} type="button" lang={locales[key].tag}
            className={!vis && lang === key ? "is-selected" : ""}
            aria-label={locales[key].name} aria-pressed={!vis && lang === key}
            onClick={() => setLang(key)}
          >
            {locales[key].short}
          </button>
        ))}
        <button
          type="button" className={vis ? "is-selected" : ""}
          aria-label={t("mode.vis")} aria-pressed={vis} onClick={() => setVis(true)}
        >✦</button>
        {extraLanguages.length > 0 && (
          <span className={`lr-lang-more${selectedExtra ? " is-selected" : ""}`}>
            <span aria-hidden="true" lang={selectedExtra ? selectedExtra[1].tag : undefined}>
              {selectedExtra ? selectedExtra[1].short : <Glyph name="globe" size={14} />}<Glyph name="chevron" size={10} />
            </span>
            <select
              aria-label={t("mode.more")}
              value={selectedExtra ? lang : ""}
              onChange={(event) => {
                if (isLang(event.currentTarget.value)) setLang(event.currentTarget.value);
              }}
            >
              <option value="" disabled>{t("mode.more")}</option>
              {extraLanguages.map(([key, locale]) => (
                <option key={key} value={key} lang={locale.tag}>{locale.name}</option>
              ))}
            </select>
          </span>
        )}
      </span>
      <Tooltip kind={theme === "dark" ? "hint-theme-light" : "hint-theme-dark"} text={vis ? undefined : themeTitle} place="below" align="end">
        {themeButton}
      </Tooltip>
    </span>
  );
}

export function AppHeader({
  led,
  homeHref = "/",
}: {
  led?: React.ReactNode;
  homeHref?: string;
}) {
  const { t } = useCopy();
  return (
    <header className="lr-top">
      <a
        className="lr-brand"
        href={homeHref}
        aria-label={t("brand.home")}
      >
        <BrandMark size={34} motion="once" />
      </a>
      <span className="lr-top-right">
        {led}
        <HeaderControls />
      </span>
    </header>
  );
}
