// App header: brand mark, LED connection state, language selection and theme.
import { useState } from "react";
import { browserDebugEnabled, debugError, downloadBrowserDebug, withBrowserDebug } from "../../lib/debug";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import type { ComicKind } from "./Comic";
import { useCopy } from "../../ui/copy";
import { LanguageControl } from "./LanguageControl";
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
  comic: ComicKind;
}) {
  const { vis } = useCopy();
  const strip = (
    <button
      type="button"
      className="lr-leds"
      data-state={state}
      aria-label={label}
    >
      <i />
      <i />
      <i />
      {vis ? null : <span className="lr-leds-label">{label}</span>}
    </button>
  );
  return (
    <span role="status">
      <Tooltip toggleOnClick kind={comic} tone={state} motion={state === "busy" || state === "warn" ? "progress" : "still"} text={vis ? undefined : label} place="below" align="start">
        {strip}
      </Tooltip>
    </span>
  );
}

export function HeaderControls({ diagnosticControl }: { diagnosticControl?: React.ReactNode } = {}) {
  const { vis, t } = useCopy();
  const { theme, toggle } = useTheme();
  const [debugExport, setDebugExport] = useState<"idle" | "busy" | "failed">("idle");
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
      <Glyph name={theme === "dark" ? "sun" : "moon"} size={16} draw="theme-toggle" />
      {vis ? null : (
        <span className="lr-cap">
          {t(theme === "dark" ? "theme.light.short" : "theme.dark.short")}
        </span>
      )}
    </button>
  );
  const debugTitle = t(!browserDebugEnabled ? "debug.startHint" :
    debugExport === "failed" ? "debug.exportFailed" : "debug.exportHint");
  const debugButton = (
    <button
      type="button" className={`lr-btn${browserDebugEnabled ? " is-on" : ""}`} disabled={debugExport === "busy"}
      aria-label={debugTitle} aria-busy={debugExport === "busy" || undefined}
      onClick={(event) => {
        if (event.detail !== 0) event.currentTarget.blur();
        if (!browserDebugEnabled) {
          // Start collection before connection owners attach their observers.
          // Preserve the current route, access parameters and invitation fragment.
          if (!window.confirm(t("debug.startConfirm"))) return;
          window.location.assign(withBrowserDebug(window.location.href, true));
          return;
        }
        setDebugExport("busy");
        void downloadBrowserDebug().then(() => setDebugExport("idle")).catch((error) => {
          debugError("export", "collector-failed", error, { collector: "download" });
          setDebugExport("failed");
        });
      }}
    >
      <Glyph name={!browserDebugEnabled ? "cpu" :
        debugExport === "busy" ? "loader" : debugExport === "failed" ? "alert" : "arrowDown"}
        size={16} className={debugExport === "busy" ? "lr-spin" : undefined} />
      {vis ? null : <span className="lr-cap">{t(!browserDebugEnabled ? "debug.start" :
        debugExport === "failed" ? "common.retry" : "debug.export")}</span>}
    </button>
  );
  return (
    <span className="lr-top-right lr-header-controls">
      <LanguageControl />
      <Tooltip kind={theme === "dark" ? "hint-theme-light" : "hint-theme-dark"} text={vis ? undefined : themeTitle} place="below" align="end">
        {themeButton}
      </Tooltip>
      {diagnosticControl !== null && <span className="lr-header-diagnostic">
        {diagnosticControl === undefined ? <Tooltip kind={!browserDebugEnabled ? "debug-start" : debugExport === "failed" ? "debug-export-failed" : "hint-debug-export"}
          tone={debugExport === "failed" ? "bad" : debugExport === "busy" ? "busy" : "off"}
          motion={debugExport === "failed" ? "still" : debugExport === "busy" ? "progress" : "demo"}
          text={vis ? undefined : debugTitle} place="below" align="end">
          {debugButton}
        </Tooltip> : diagnosticControl}
      </span>}
    </span>
  );
}

export function AppHeader({
  led,
  homeHref = "/",
  diagnosticControl,
}: {
  led?: React.ReactNode;
  homeHref?: string;
  diagnosticControl?: React.ReactNode;
}) {
  const { t } = useCopy();
  return (
    <header className="lr-top">
      <a
        className="lr-brand"
        href={withBrowserDebug(homeHref)}
        aria-label={t("brand.home")}
      >
        <BrandMark size={34} motion="once" />
      </a>
      <span className="lr-top-right">
        {led}
        <HeaderControls diagnosticControl={diagnosticControl} />
      </span>
    </header>
  );
}
