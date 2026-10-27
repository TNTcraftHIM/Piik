import { useId, useLayoutEffect, useRef, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { BrandLockup } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import { WelcomeLine } from "./WelcomeLine";
import { SiteAddressEntry } from "./SiteAddressEntry";
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
  modes,
  onModeChange,
  sites,
  startupSite,
  onToggleStartupSite,
  onRemoveSite,
  onSelectSite,
  siteAddress,
  siteBusy,
  siteError,
  target,
  onOpen,
  entryURL = target => target,
  localAccessPassword,
  onLocalAccessPasswordChange,
  lan,
  onSubmit,
  children,
  roomError,
}: {
  mode: AppMode;
  modes?: readonly AppMode[];
  onModeChange: (mode: AppMode) => void;
  sites: readonly string[];
  startupSite: string;
  onToggleStartupSite: (site: string) => void;
  onRemoveSite: (site: string) => void;
  onSelectSite?: (site: string) => void;
  siteAddress?: string;
  siteBusy?: boolean;
  siteError?: string;
  target?: string;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  entryURL?: (target: string) => string;
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
  const choices = modes ? MODES.filter(choice => modes.includes(choice.mode)) : MODES;
  const accessHintId = useId();
  const standbyRef = useRef<HTMLElement>(null);
  const removalFocus = useRef<{ site: string; index: number } | null>(null);
  useLayoutEffect(() => {
    const pending = removalFocus.current;
    if (!pending) return;
    if (sites.includes(pending.site)) {
      if (!siteBusy) removalFocus.current = null;
      return;
    }
    removalFocus.current = null;
    const section = standbyRef.current;
    if (!section || section.ownerDocument.activeElement !== section.ownerDocument.body) return;
    // Wait for confirmed removal, then keep keyboard users beside the next action.
    const next = section.ownerDocument.getElementById(`${accessHintId}-remove-${Math.min(pending.index, sites.length - 1)}`);
    (next ?? section.querySelector("summary"))?.focus();
  }, [sites, siteBusy, accessHintId]);
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
        <BrandLockup size={52} motion="once" className="lr-client-launch-brand"
          heading titleClassName="lr-client-launch-title" suffix={<> <small>App</small></>} />
        <WelcomeLine />
      </header>

      {children}

      <section ref={standbyRef} className="lr-client-standby" aria-label={t("client.connect.standby")}>
        <div className="lr-client-standby-heading">
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
        {onSelectSite && <SiteAddressEntry initialAddress={siteAddress} onSelect={onSelectSite} />}
        </div>
        {siteError && <p role="alert">{siteError}</p>}
        {sites.length > 0 && <div className="lr-client-approved-sites" role="list">{sites.map((site, index) => <div key={site} className="lr-client-approved-site" role="listitem">
          <a href={entryURL(`${site}/#piik-client=1`)} target="_blank" rel="noopener noreferrer" onClick={onOpen}>{site}<span aria-hidden="true">&nbsp;↗</span></a>
          <div className="lr-client-site-actions">
            <Btn icon="star" title="client.connect.openOnStart" size="dense" pressed={startupSite === site}
              hint="hint-client-site" disabled={siteBusy} onClick={() => onToggleStartupSite(site)} />
            <Btn id={`${accessHintId}-remove-${index}`} icon="x" title="client.connect.remove" size="dense" hint="hint-close" disabled={siteBusy} onClick={() => {
              const button = standbyRef.current?.ownerDocument.activeElement;
              removalFocus.current = button?.id === `${accessHintId}-remove-${index}` ? { site, index } : null;
              onRemoveSite(site);
            }} />
          </div>
        </div>)}</div>}
      </section>

      {roomError}
      {target ? <a className="lr-btn is-primary" href={entryURL(target)} onClick={onOpen} aria-label={t("client.launch.go")}>
        <Glyph name="arrowRight" size={19} />{vis ? null : <span className="lr-cap">{t("client.launch.go")}</span>}
      </a> : <>
      <p className={vis ? "visually-hidden" : "lr-client-launch-section"}>{t("client.launch.room")}</p>
      <div
        className="lr-client-modes"
        style={{ "--launcher-columns": choices.length } as CSSProperties}
        role="radiogroup"
        aria-label={t("client.launch.title")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
          const index = (choices.findIndex((choice) => choice.mode === mode) + direction + choices.length) % choices.length;
          onModeChange(choices[index]!.mode);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
        }}
      >
        {choices.map((choice) => {
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
        icon={roomError ? "refresh" : "arrowRight"}
        title={roomError ? "common.retry" : "client.launch.go"}
        cap={roomError ? "common.retry" : "client.launch.go"}
        tone="primary"
        type="submit"
        hint={MODES.find((choice) => choice.mode === mode)?.comic}
        disabled={mode === "local" && lan !== undefined && !lan.selected}
      />
      </>}
    </form>
  );
}
