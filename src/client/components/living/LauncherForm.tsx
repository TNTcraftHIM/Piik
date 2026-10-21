import { useId, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import { WelcomeLine } from "./WelcomeLine";
import { Btn, Pill } from "./primitives";
import { HintComic, type HintKind } from "./hints";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
export type AppMode = "local" | "link";

const MODES: Array<{
  mode: AppMode;
  icon: GlyphName;
  label: CopyKey;
  hint: CopyKey;
  comic: HintKind;
}> = [
  {
    mode: "link",
    icon: "globe",
    label: "client.launch.link",
    hint: "client.launch.linkHint",
    comic: "hint-client-link",
  },
  {
    mode: "local",
    icon: "users",
    label: "client.launch.local",
    hint: "client.launch.localHint",
    comic: "hint-client-local",
  },
];

// The product and film share this form; requests and navigation stay in the page.
export function LauncherForm({
  mode,
  onModeChange,
  site,
  openSiteOnStart,
  onToggleStartupSite,
  onRemoveSite,
  siteBusy,
  siteError,
  target,
  onOpen,
  localAccessPassword,
  onLocalAccessPasswordChange,
  lan,
  onSubmit,
  children,
  roomError,
}: {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  site: string;
  openSiteOnStart: boolean;
  onToggleStartupSite: () => void;
  onRemoveSite: () => void;
  siteBusy?: boolean;
  siteError?: string;
  target?: string;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  localAccessPassword: string;
  onLocalAccessPasswordChange: (password: string) => void;
  lan?: {
    addresses: readonly { address: string; name: string }[];
    selected: string;
    onChange: (address: string) => void;
  };
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children?: ReactNode;
  roomError?: ReactNode;
}) {
  const { vis, t } = useCopy();
  const accessHintId = useId();
  const accessField = (
    <label className="lr-input lr-client-access">
      <Glyph name="key" size={18} />
      <input
        type="password"
        value={localAccessPassword}
        autoComplete="off"
        spellCheck={false}
        placeholder={vis ? "" : t("client.launch.localAccess")}
        aria-label={t("client.launch.localAccess")}
        aria-describedby={accessHintId}
        onChange={(event) => {
          onLocalAccessPasswordChange(event.target.value);
        }}
      />
    </label>
  );
  return (
    <form className="lr-client-launch-panel" onSubmit={onSubmit}>
      <header className="lr-client-launch-heading">
        <div className="lr-client-launch-brand">
          <BrandMark size={52} motion="once" />
          <h1 className="lr-client-launch-title">Piik<span className="lr-client-brand-dot">.</span> <small>App</small></h1>
        </div>
        <WelcomeLine />
      </header>

      {children}

      <section className="lr-client-standby" aria-label={t("client.connect.standby")}>
        <details className="lr-client-connect-guide">
          <summary>
            <span className="lr-client-standby-state">
              <Glyph name="check" size={18} />
              <strong className={vis ? "visually-hidden" : undefined}>{t("client.connect.standby")}</strong>
            </span>
            <span className="lr-client-connect-toggle">
              {vis && <Glyph name="window" size={17} />}
              <span className={vis ? "visually-hidden" : undefined}>{t("client.connect.guide")}</span>
              <Glyph name="chevron" size={14} />
            </span>
          </summary>
          <div className="lr-client-connect-steps">
            {vis && <HintComic kind="hint-client-site" />}
            <p className={vis ? "visually-hidden" : undefined}>{t("client.connect.standbyHint")}</p>
          </div>
        </details>
        {siteError && <p role="alert">{siteError}</p>}
        {site && <div className="lr-client-approved-site">
          <a href={`${site}/#piik-client=1`} target="_blank" rel="noopener noreferrer" onClick={onOpen}>{site}<span aria-hidden="true"> ↗</span></a>
          <div className="lr-client-site-actions">
            <Btn icon="star" title="client.connect.openOnStart" size="dense" pressed={openSiteOnStart}
              hint="hint-client-site" disabled={siteBusy} onClick={onToggleStartupSite} />
            <Btn icon="x" title="client.connect.remove" size="dense" hint="hint-client-site" disabled={siteBusy} onClick={onRemoveSite} />
          </div>
        </div>}
      </section>

      {roomError ?? (target ? <a className="lr-btn is-primary" href={target} onClick={onOpen} aria-label={t("client.launch.go")}>
        <Glyph name="arrowRight" size={19} />{vis ? null : <span className="lr-cap">{t("client.launch.go")}</span>}
      </a> : <>
      <p className={vis ? "visually-hidden" : "lr-client-launch-section"}>{t("client.launch.room")}</p>
      <div
        className="lr-client-modes"
        role="radiogroup"
        aria-label={t("client.launch.title")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
          const index = (MODES.findIndex((choice) => choice.mode === mode) + direction + MODES.length) % MODES.length;
          onModeChange(MODES[index]!.mode);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
        }}
      >
        {MODES.map((choice) => {
          const button = (
            <button
              key={choice.mode}
              type="button"
              role="radio"
              className={`lr-tile lr-client-mode${mode === choice.mode ? " is-selected" : ""}`}
              aria-checked={mode === choice.mode}
              tabIndex={mode === choice.mode ? 0 : -1}
              aria-label={t(choice.label)}
              onClick={() => {
                onModeChange(choice.mode);
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
          );
          return (
            <Tooltip
              key={choice.mode}
              kind={choice.comic}
              text={vis ? undefined : t(choice.hint)}
            >
              {button}
            </Tooltip>
          );
        })}
      </div>

      <div className="lr-client-room-settings">
        <details className="lr-client-access-options">
          <summary className="lr-btn">
            <Glyph name="key" size={17} />
            <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.accessSettings")}</span>
            {localAccessPassword && <span className="lr-client-access-set">
              <Glyph name="check" size={14} />
              <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.accessSet")}</span>
            </span>}
            <Glyph name="chevron" size={15} />
          </summary>
          {accessField}
          <p id={accessHintId} className={vis ? "visually-hidden" : "lr-client-access-hint"}>
            {t("client.launch.localAccessHint")}
          </p>
        </details>
        {mode === "local" && lan && (lan.addresses.length !== 1 || !lan.selected) ? (
          <details className="lr-client-access-options" open={!lan.selected || undefined}>
            <summary className="lr-btn">
              <Glyph name="users" size={17} />
              <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.lanAddress")}</span>
              <Glyph name="chevron" size={15} />
            </summary>
            {lan.addresses.length === 0 ? (
              <Pill icon="wifiOff" tone="warn" comic="signal-offline" label={t("client.launch.lanUnavailable")} />
            ) : <div className="lr-capture-device lr-client-lan">
              <select value={lan.selected} aria-label={t("client.launch.lanAddress")}
                aria-describedby={`${accessHintId}-lan`} onChange={event => lan.onChange(event.target.value)}>
                <option value="" disabled>{t("client.launch.chooseAddress")}</option>
                {lan.addresses.map(({ address, name }) => (
                  <option key={address} value={address}>{address} · {name}</option>
                ))}
              </select>
              <small id={`${accessHintId}-lan`} className={vis ? "visually-hidden" : undefined}>{t("client.launch.lanHint")}</small>
            </div>}
          </details>
        ) : null}
      </div>

      {mode === "local" && <p className={vis ? "visually-hidden" : "lr-client-access-hint"}>
        {t("client.launch.localHTTPS")}
      </p>}
      <Btn
        icon="arrowRight"
        title="client.launch.go"
        cap="client.launch.go"
        tone="primary"
        type="submit"
        hint={MODES.find((choice) => choice.mode === mode)?.comic}
        disabled={mode === "local" && lan !== undefined && !lan.selected}
      />
      </>)}
    </form>
  );
}
