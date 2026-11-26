// App header: brand mark, LED connection state, language selection and theme.
import { useId, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { browserDebugEnabled, debugError, downloadBrowserDebug, withBrowserDebug } from "../../lib/debug";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import type { ComicKind } from "./Comic";
import { useCopy } from "../../ui/copy";
import { LanguageControl } from "./LanguageControl";
import { applyTheme, currentTheme, subscribeTheme } from "../../ui/theme";
import { Glyph } from "../../ui/icons";
import { AppConnectionButton } from "./AppConnectionButton";
import { useAnchoredPopover } from "./use-anchored-popover";
import { diagnosisGuide } from "../../channel/diagnosis";
import { Btn } from "./primitives";

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
  const tone = state === "busy" ? "warn" : state;
  const strip = (
    <button
      type="button"
      className="lr-leds"
      data-state={state}
      aria-label={label}
    >
      <span className="lr-connection-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="lr-leds-label">{label}</span>
    </button>
  );
  return (
    <span role="status">
      <Tooltip toggleOnClick kind={comic} tone={tone} motion={state === "busy" || state === "warn" ? "progress" : "still"} text={label} place="below" align="start">
        {strip}
      </Tooltip>
    </span>
  );
}

/** Shared explicit opt-in/export action; starting diagnostics reloads the page. */
export function BrowserDiagnosticsButton({ quiet, size }: Pick<ComponentProps<typeof Btn>, "quiet" | "size"> = {}) {
  const { t } = useCopy();
  const [debugExport, setDebugExport] = useState<"idle" | "busy" | "failed">("idle");
  const title = !browserDebugEnabled ? "debug.startHint" :
    debugExport === "failed" ? "debug.exportFailed" : "debug.exportHint";
  const debugTitle = t(title);
  const debugButton = (
    <Btn
      size={size} quiet={quiet} tone={browserDebugEnabled ? "on" : undefined}
      title={title} disabled={debugExport === "busy"} busy={debugExport === "busy"}
      icon={!browserDebugEnabled ? "cpu" : debugExport === "failed" ? "alert" : "arrowDown"}
      cap={!browserDebugEnabled ? "debug.start" : debugExport === "failed" ? "common.retry" : "debug.export"}
      onClick={() => {
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
      }} />
  );
  return <Tooltip kind={!browserDebugEnabled ? "debug-start" : debugExport === "failed" ? "debug-export-failed" : "hint-debug-export"}
    tone={debugExport === "failed" ? "bad" : debugExport === "busy" ? "busy" : "off"}
    motion={debugExport === "failed" ? "still" : debugExport === "busy" ? "progress" : "demo"}
    text={debugTitle} place="below" align="end">{debugButton}</Tooltip>;
}

const webVersion = import.meta.env.VITE_PIIK_VERSION ?? "development";
const webRelease = /^v\d+\.\d+\.\d+$/.test(webVersion)
  ? `https://github.com/TNTcraftHIM/Piik/releases/tag/${webVersion}` : null;

function BrowserHelpContent({ active, diagnosticControl }: { active: boolean; diagnosticControl?: React.ReactNode }) {
  const { lang, t } = useCopy();
  const guide = diagnosisGuide("troubleshooting", lang).fallback;
  return <div className="lr-help-content">
    <header><strong>Piik Web</strong>
      {webRelease ? <a href={webRelease} target="_blank" rel="noopener noreferrer"
        aria-label={`Piik Web ${webVersion}`}>{webVersion}</a> : <span>{webVersion}</span>}
    </header>
    <nav aria-label={t("help.title")}>
      {active && <>
        <Tooltip kind="hint-help" text={t("shareHelp.guide")} place="below" align="end">
          <a className="lr-btn is-compact is-quiet" href={guide} target="_blank" rel="noopener noreferrer" aria-label={t("shareHelp.guide")}>
            <Glyph name="book" size={16} /><span className="lr-cap">{t("help.troubleshooting")}</span>
          </a>
        </Tooltip>
        {diagnosticControl === undefined ? <BrowserDiagnosticsButton size="compact" quiet /> : diagnosticControl}
      </>}
    </nav>
  </div>;
}

export function HeaderControls({ diagnosticControl, appControl, personalControls }: { diagnosticControl?: React.ReactNode; appControl?: React.ReactNode; personalControls?: React.ReactNode } = {}) {
  const { t } = useCopy();
  const trigger = useRef<HTMLSpanElement>(null), options = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, options);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const dark = theme === "dark";
  return (
    <div className="lr-top-right lr-header-controls">
      {appControl}
      <span ref={trigger} className="lr-header-more">
        <Btn icon="more" title="header.more" textTooltip size="compact" quiet popoverTarget={id} controls={id} expanded={open} />
      </span>
      <div ref={options} id={id} popover="auto" role="dialog" aria-label={t("header.more")}
        className="lr-header-options lr-anchored-card" onToggle={event => {
          if (event.target === event.currentTarget) setOpen(event.newState === "open");
        }}>
        <div className="lr-header-settings">
          <LanguageControl />
          <Btn icon={dark ? "sun" : "moon"} title={dark ? "theme.light" : "theme.dark"} cap={dark ? "theme.light.short" : "theme.dark.short"}
            size="compact" draw="theme-toggle" hint={dark ? "hint-theme-light" : "hint-theme-dark"} hintPlace="below" hintAlign="end"
            onClick={() => applyTheme(dark ? "light" : "dark")} />
        </div>
        {personalControls}
        <BrowserHelpContent active={open} diagnosticControl={diagnosticControl} />
      </div>
    </div>
  );
}

export function AppHeader({
  led,
  appIdentity,
  homeHref = "/",
  diagnosticControl,
  appControl,
  onAppConnected,
  atHome = false,
}: {
  led?: React.ReactNode;
  appIdentity?: React.ReactNode;
  homeHref?: string;
  diagnosticControl?: React.ReactNode;
  appControl?: React.ReactNode;
  onAppConnected?: ComponentProps<typeof AppConnectionButton>["onConnected"];
  atHome?: boolean;
}) {
  const { t } = useCopy();
  return (
    <header className="lr-top">
      {appIdentity && <span className="lr-top-app-identity">{appIdentity}</span>}
      {homeHref !== "/client" && <a
        className="lr-brand"
        href={withBrowserDebug(homeHref)}
        aria-label={t("brand.home")}
        aria-current={atHome ? "page" : undefined}
      >
        {!atHome && <Glyph name="chevron" size={14} className="lr-home-arrow" />}
        <BrandMark size={34} motion="once" />
      </a>}
      <div className="lr-top-right">
        {led}
        <HeaderControls diagnosticControl={diagnosticControl}
          appControl={appControl === undefined
            ? homeHref !== "/client" ? <AppConnectionButton onConnected={onAppConnected} /> : undefined
            : appControl} />
      </div>
    </header>
  );
}
