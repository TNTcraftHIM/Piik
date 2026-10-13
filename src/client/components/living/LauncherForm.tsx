import { useId, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import { WelcomeLine } from "./WelcomeLine";
import { Btn, Pill } from "./primitives";
import type { HintKind } from "./hints";
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
  version,
}: {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  site: string;
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
  version?: string;
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
        <span className="lr-client-standby-icon" aria-hidden="true"><Glyph name="check" size={24} /></span>
        <div className="lr-client-standby-copy">
          <strong className={vis ? "visually-hidden" : undefined}>{t("client.connect.standby")}</strong>
          <p className={vis ? "visually-hidden" : undefined}>{t("client.connect.standbyHint")}</p>
          {site && <div className="lr-client-approved-site">
            <a href={`${site}/#piik-client=1`} target="_blank" rel="noopener noreferrer" onClick={onOpen}>{site}<span aria-hidden="true"> ↗</span></a>
            <Btn icon="x" title="client.connect.remove" hint="hint-client-site" disabled={siteBusy} onClick={onRemoveSite} />
          </div>}
          {siteError && <p role="alert">{siteError}</p>}
        </div>
      </section>

      {target ? <a className="lr-btn is-primary" href={target} onClick={onOpen} aria-label={t("client.launch.go")}>
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

      <Btn
        icon="arrowRight"
        title="client.launch.go"
        cap="client.launch.go"
        tone="primary"
        type="submit"
        hint={MODES.find((choice) => choice.mode === mode)?.comic}
        disabled={mode === "local" && lan !== undefined && !lan.selected}
      />
      </>}
      <div className="lr-client-about">
        {version && <p className="lr-client-version">
          <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.version", { version })}</span>
          {vis && <span aria-hidden="true">{version}</span>}
        </p>}
        <p>
          <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.credit")}</span>
          {vis && <span aria-hidden="true">TNTcraft & contributors</span>}
        </p>
        <div className="lr-client-project-links">
          <a href="https://piik.tv/" target="_blank" rel="noopener noreferrer" aria-label={t("client.launch.website")}>
            {vis ? "piik.tv" : t("client.launch.website")}<span aria-hidden="true"> ↗</span>
          </a>
          <a href="https://github.com/TNTcraftHIM/Piik" target="_blank" rel="noopener noreferrer" aria-label={t("client.launch.source")}>
            {vis ? "GitHub" : t("client.launch.source")}<span aria-hidden="true"> ↗</span>
          </a>
        </div>
      </div>
    </form>
  );
}
