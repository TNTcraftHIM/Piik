// App header: brand mark, LED connection state, language-mode pill
// (中文 / EN / 纯视觉), and theme toggle.
import { useState } from "react";
import { browserDebugEnabled, debugError, downloadBrowserDebug } from "../../lib/debug";
import { VisGlyph } from "./primitives";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import type { ComicKind } from "./Comic";
import { useCopy, type Lang } from "../../ui/copy";
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
  const option = (mode: Lang | "vis", label: string, tipKey: "mode.zh" | "mode.en" | "mode.vis") => {
    const active = mode === "vis" ? vis : !vis && lang === mode;
    return (
      <button
        type="button"
        className={active ? "is-selected" : ""}
        aria-label={t(tipKey)}
        aria-pressed={active}
        onClick={() => (mode === "vis" ? setVis(true) : setLang(mode))}
      >
        {label}
      </button>
    );
  };
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
        {option("zh", "中", "mode.zh")}
        {option("en", "EN", "mode.en")}
        {option("vis", "✦", "mode.vis")}
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
