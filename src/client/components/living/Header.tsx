// App header: brand mark, LED connection state, language-mode pill
// (中文 / EN / 纯视觉), and theme toggle.
import { VisGlyph } from "./primitives";
import { BrandMark } from "./BrandMark";
import { ComicTooltip } from "./ComicTooltip";
import type { ComicKind } from "./Comic";
import { useCopy, type Lang } from "../../ui/copy";
import { useTheme } from "../../ui/theme";

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
  const wrapped = vis && comic;
  const strip = (
    <span
      className="lr-leds"
      data-state={state}
      role="status"
      title={vis ? undefined : label}
      aria-label={label}
      tabIndex={wrapped ? 0 : undefined}
    >
      <i />
      <i />
      <i />
      {vis ? null : <span className="lr-leds-label">{label}</span>}
    </span>
  );
  return wrapped ? (
    <ComicTooltip kind={wrapped} place="below" align="start">
      {strip}
    </ComicTooltip>
  ) : (
    strip
  );
}

export function HeaderControls() {
  const { lang, vis, t, setLang, setVis } = useCopy();
  const { theme, toggle } = useTheme();
  const option = (mode: Lang | "vis", label: string, tipKey: "mode.zh" | "mode.en" | "mode.vis") => {
    const active = mode === "vis" ? vis : !vis && lang === mode;
    return (
      <button
        type="button"
        className={active ? "is-selected" : ""}
        title={vis ? undefined : t(tipKey)}
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
      title={vis ? undefined : themeTitle}
      aria-label={themeTitle}
      onClick={(event) => {
        // Hint-wrapped in vis: pointer activation must not leave the comic
        // pinned open by focus over the stage (keyboard clicks keep focus).
        if (vis && event.detail !== 0) event.currentTarget.blur();
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
  return (
    <span className="lr-top-right lr-header-controls">
      <span className="lr-lang" role="group" aria-label={t("mode.language")}>
        {option("zh", "中", "mode.zh")}
        {option("en", "EN", "mode.en")}
        {option("vis", "✦", "mode.vis")}
      </span>
      {vis ? (
        <ComicTooltip kind="hint-theme" place="below" align="end">
          {themeButton}
        </ComicTooltip>
      ) : (
        themeButton
      )}
    </span>
  );
}

export function AppHeader({ led }: { led?: React.ReactNode }) {
  const { t, vis } = useCopy();
  return (
    <header className="lr-top">
      <a
        className="lr-brand"
        href="/"
        aria-label={t("brand.home")}
        title={vis ? undefined : t("brand.home")}
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
