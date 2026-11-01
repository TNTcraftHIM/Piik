// App header: brand mark, LED connection state, language selection and theme.
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { createPortal } from "react-dom";
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
import { useProjectLink } from "../../lib/use-project-link";
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
  const { vis } = useCopy();
  const tone = state === "busy" ? "warn" : state;
  const strip = (
    <button
      type="button"
      className="lr-leds"
      data-state={state}
      aria-label={label}
    >
      <span className="lr-connection-dots" aria-hidden="true"><i /><i /><i /></span>
      {vis ? null : <span className="lr-leds-label">{label}</span>}
    </button>
  );
  return (
    <span role="status">
      <Tooltip toggleOnClick kind={comic} tone={tone} motion={state === "busy" || state === "warn" ? "progress" : "still"} text={vis ? undefined : label} place="below" align="start">
        {strip}
      </Tooltip>
    </span>
  );
}

/** Shared explicit opt-in/export action; starting diagnostics reloads the page. */
export function BrowserDiagnosticsButton({ quiet, size }: Pick<ComponentProps<typeof Btn>, "quiet" | "size"> = {}) {
  const { vis, t } = useCopy();
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
    text={vis ? undefined : debugTitle} place="below" align="end">{debugButton}</Tooltip>;
}

const webVersion = import.meta.env.VITE_PIIK_VERSION ?? "development";
const webRelease = /^v\d+\.\d+\.\d+$/.test(webVersion)
  ? `https://github.com/TNTcraftHIM/Piik/releases/tag/${webVersion}` : null;

function BrowserHelpContent({ active }: { active: boolean }) {
  const { lang, vis, t } = useCopy();
  const guide = useProjectLink(`/docs/${lang === "zh" ? "zh/" : ""}troubleshooting.html`,
    `https://github.com/TNTcraftHIM/Piik/blob/main/docs/guide/troubleshooting${lang === "zh" ? ".zh-CN" : ""}.md`, active);
  return <div className={`lr-help-content${vis ? " is-visual" : ""}`}>
    <header><strong>Piik Web</strong>
      {webRelease ? <a href={webRelease} target="_blank" rel="noopener noreferrer"
        aria-label={`Piik Web ${webVersion}`}>{webVersion}</a> : <span>{webVersion}</span>}
    </header>
    <nav aria-label={t("help.title")}>
      {active && <>
        <Tooltip kind="hint-help" text={vis ? undefined : t("shareHelp.guide")} place="below" align="end">
          <a className="lr-btn is-compact is-quiet" href={guide} target="_blank" rel="noopener noreferrer" aria-label={t("shareHelp.guide")}>
            <Glyph name="book" size={16} />{!vis && <span className="lr-cap">{t("help.troubleshooting")}</span>}
          </a>
        </Tooltip>
        <BrowserDiagnosticsButton size="compact" quiet />
      </>}
    </nav>
  </div>;
}

function BrowserHelpMenu() {
  const { vis, t } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, panel);
  return <>
    <Tooltip kind="hint-help" text={vis ? undefined : t("help.hint")} disabled={open} place="below" align="end">
      <button ref={trigger} type="button" className="lr-btn is-compact is-quiet"
        popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-label={t("help.title")}>
        <Glyph name="help" />
      </button>
    </Tooltip>
    {createPortal(<div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("help.title")}
      className="lr-anchored-card lr-help-menu" onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      }}>
      <BrowserHelpContent active={open} />
    </div>, document.body)}
  </>;
}

export function HeaderControls({ diagnosticControl, appControl }: { diagnosticControl?: React.ReactNode; appControl?: React.ReactNode } = {}) {
  const { vis, t } = useCopy();
  const controls = useRef<HTMLDivElement>(null), trigger = useRef<HTMLSpanElement>(null), options = useRef<HTMLDivElement>(null);
  const focusInline = useRef(false);
  const id = useId();
  const [compact, setCompact] = useState(false), [open, setOpen] = useState(false);
  useAnchoredPopover(trigger, options, { enabled: compact });
  useLayoutEffect(() => {
    const header = controls.current?.closest(".lr-top") ?? controls.current;
    if (!header) return;
    const resize = () => {
      const narrow = header.clientWidth <= 600;
      if (!narrow && options.current?.hasAttribute("popover")) {
        const focused = header.ownerDocument.activeElement;
        focusInline.current = options.current.contains(focused) || Boolean(trigger.current?.contains(focused));
        if (options.current.matches(":popover-open")) options.current.hidePopover();
      }
      if (!narrow) options.current?.removeAttribute("style");
      setCompact(narrow);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(header); resize();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!compact && focusInline.current) {
      focusInline.current = false;
      (options.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? options.current?.querySelector<HTMLElement>("button, a"))?.focus();
    }
  }, [compact]);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const themeTitle = t(theme === "dark" ? "theme.light" : "theme.dark");
  const themeButton = (
    <button
      type="button"
      className="lr-btn is-compact lr-theme-toggle"
      aria-label={themeTitle}
      onClick={(event) => {
        // Pointer activation must not pin the hint open; keyboard keeps focus.
        if (event.detail !== 0) event.currentTarget.blur();
        applyTheme(theme === "dark" ? "light" : "dark");
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
  return (
    <div ref={controls} className={`lr-top-right lr-header-controls${compact ? " is-overflow" : ""}`}>
      {appControl}
      {compact && <span ref={trigger} className="lr-header-more">
        <Btn icon="sliders" title="header.more" hint="hint-advanced" size="compact" popoverTarget={id} controls={id} expanded={open} />
      </span>}
      <div ref={options} id={id} popover={compact ? "auto" : undefined} role={compact ? "dialog" : undefined}
        aria-label={compact ? t("header.more") : undefined}
        className={`lr-header-options${compact ? " lr-anchored-card" : ""}`} onToggle={event => {
          if (event.target === event.currentTarget) setOpen(event.newState === "open");
        }}>
        <div className="lr-header-settings">
          <LanguageControl />
          <Tooltip kind={theme === "dark" ? "hint-theme-light" : "hint-theme-dark"} text={vis ? undefined : themeTitle} place="below" align="end">
            {themeButton}
          </Tooltip>
        </div>
        {diagnosticControl === undefined ? compact ? <BrowserHelpContent active={open} /> : <BrowserHelpMenu /> : diagnosticControl}
      </div>
    </div>
  );
}

export function AppHeader({
  led,
  homeHref = "/",
  diagnosticControl,
  onAppConnected,
  atHome = false,
}: {
  led?: React.ReactNode;
  homeHref?: string;
  diagnosticControl?: React.ReactNode;
  onAppConnected?: () => void;
  atHome?: boolean;
}) {
  const { t } = useCopy();
  return (
    <header className="lr-top">
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
          appControl={homeHref !== "/client" ? <AppConnectionButton onConnected={onAppConnected} /> : undefined} />
      </div>
    </header>
  );
}
