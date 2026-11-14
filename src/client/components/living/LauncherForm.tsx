import { Fragment, useId, useLayoutEffect, useRef, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { BrandLockup } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import { WelcomeLine } from "./WelcomeLine";
import { SiteAddressEntry } from "./SiteAddressEntry";
import { NumberControl } from "./NumberControl";
import { Btn, Pill } from "./primitives";
import { HintComic, type HintKind } from "./hints";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import type { AppMode } from "../../lib/app-launch";
import { useClipboardResult } from "../../ui/use-clipboard-result";

export interface LocalCertificate { origin: string; sha256Fingerprint: string }

export function LocalConnectionDetails({ certificate }: { certificate: LocalCertificate }) {
  const { t, vis } = useCopy();
  const fingerprint = certificate.sha256Fingerprint.replace(/(..)(?=.)/g, "$1:");
  const bytes = fingerprint.split(":");
  const clipboard = useClipboardResult(`${certificate.origin}\nSHA-256 ${fingerprint}`);
  const label = clipboard.status === "copied" ? "common.copied" : clipboard.status === "failed" ? "common.copyFailed" : "client.launch.copyCertificate";
  return <details className="lr-client-access-options lr-client-certificate">
    <summary className="lr-btn"><Glyph name="lock" size={17} />
      <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.localDetails")}</span><Glyph name="chevron" size={15} /></summary>
    <div><p>{certificate.origin}</p><p className={vis ? "visually-hidden" : undefined}>{t("client.launch.certificateHint")}</p>
      <strong>{vis ? "SHA-256" : t("client.launch.certificate")}</strong>
      <code>{bytes.map((byte, index) => <Fragment key={index}>{byte}{index < bytes.length - 1 && <>:<wbr /></>}</Fragment>)}</code>
      <Btn icon={clipboard.status === "copied" ? "check" : "copy"} title={label} cap={label}
        size="dense" quiet onClick={clipboard.copy} />
    </div>
  </details>;
}

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

export interface DeviceSiteApprovalsProps {
  sites: readonly string[];
  startupSite: string;
  ownedStartup?: AppMode;
  ownedSites?: readonly string[];
  onToggleStartupSite: (site: string) => void;
  onRemoveSite: (site: string) => void;
  onSelectSite?: (site: string) => void;
  siteAddress?: string;
  siteBusy?: boolean;
  siteError?: string;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  entryURL?: (target: string) => string;
}

export function DeviceSiteApprovals({
  sites, startupSite, ownedStartup, ownedSites = [], onToggleStartupSite,
  onRemoveSite, onSelectSite, siteAddress, siteBusy, siteError, onOpen,
  entryURL = target => target,
}: DeviceSiteApprovalsProps) {
  const { vis, t } = useCopy();
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
  return <>
      <section ref={standbyRef} className="lr-client-standby lr-client-device-access" aria-label={t("client.launcher.deviceAccess")}>
        <div className="lr-client-standby-heading">
          <details className="lr-client-connect-guide" open={sites.length === 0 || undefined}>
            <summary>
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
        {siteError && <Pill icon="alert" tone="bad" comic="signal-failed" alert label={siteError} />}
        {sites.length > 0 && <div className="lr-client-approved-sites" role="list">{sites.map((site, index) => <div key={site} className="lr-client-approved-site" role="listitem">
          <a href={entryURL(`${site}/#piik-client=1`)} target="_blank" rel="noopener noreferrer" onClick={onOpen}>{site}<span aria-hidden="true">&nbsp;↗</span></a>
          <div className="lr-client-site-actions">
            <Btn icon="star" title="client.connect.openOnStart" size="dense" pressed={startupSite === site || Boolean(ownedStartup && ownedSites.includes(site))}
              hint="hint-client-site" disabled={siteBusy} onClick={() => onToggleStartupSite(site)} />
            <Btn id={`${accessHintId}-remove-${index}`} icon="linkOff" tone="danger" title="client.connect.remove" size="dense" textTooltip disabled={siteBusy} onClick={() => {
              const button = standbyRef.current?.ownerDocument.activeElement;
              removalFocus.current = button?.id === `${accessHintId}-remove-${index}` ? { site, index } : null;
              onRemoveSite(site);
            }} />
          </div>
        </div>)}</div>}
      </section>

      {ownedStartup && <label className="lr-client-approval-startup">
        <input type="checkbox" checked disabled={siteBusy} onChange={() => onToggleStartupSite("")} />
        <Glyph name="star" size={18} />
        <span className={vis ? "visually-hidden" : undefined}>{t("client.connect.openOwnedOnStart", { mode: t(ownedStartup === "local" ? "client.launch.local" : "client.launch.link") })}</span>
      </label>}
  </>;
}

export interface SiteStartControlsProps {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  port?: { value: number; onChange(value: number): void };
  publicEntry?: {
    existing: boolean;
    origin: string;
    localAddress: string;
    error?: string;
    onChange(next: { existing: boolean; origin: string }): void;
  };
  target?: string;
  localCertificate?: LocalCertificate;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  entryURL?: (target: string) => string;
  lan?: {
    addresses: readonly { address: string; name: string }[];
    selected: string;
    onChange: (address: string) => void;
  };
  roomError?: ReactNode;
}

// The caller owns submission; controls work in the launcher and its startup dialog.
export function SiteStartControls({
  mode, onModeChange, port, publicEntry, target, localCertificate, onOpen,
  entryURL = target => target, lan, roomError,
}: SiteStartControlsProps) {
  const { vis, t } = useCopy();
  const chooseLAN = mode === "local" && lan && (lan.addresses.length !== 1 || !lan.selected);
  const accessHintId = useId();
  const clipboard = useClipboardResult(publicEntry?.localAddress);
  const copyLabel = clipboard.status === "copied" ? "common.copied" : clipboard.status === "failed" ? "common.copyFailed" : "common.copy";
  const AddressLabel = chooseLAN ? "label" : "div";
  return <>
      {roomError}
      {target ? <><a className="lr-btn is-primary" href={entryURL(target)} onClick={onOpen} aria-label={t("client.launch.go")}>
        <Glyph name="arrowRight" size={19} />{vis ? null : <span className="lr-cap">{t("client.launch.go")}</span>}
      </a>{localCertificate && <LocalConnectionDetails certificate={localCertificate} />}</> : <>
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
              disabled={!vis}
            >
              {button}
            </Tooltip>
          );
        })}
      </div>

      {mode === "link" && publicEntry && <div className="lr-client-public-entry">
        <fieldset className="lr-toggle lr-client-public-source">
          <legend className="visually-hidden">{t("client.launch.publicAddress")}</legend>
          {[false, true].map(existing => <label key={String(existing)}>
            <input type="radio" name={`${accessHintId}-public-source`} checked={publicEntry.existing === existing}
              onChange={() => publicEntry.onChange({ existing, origin: publicEntry.origin })} />
            <span><Glyph name={existing ? "link" : "globe"} size={18} /><span className={vis ? "visually-hidden" : undefined}>{t(existing ? "client.launch.existingAddress" : "client.launch.automaticAddress")}</span></span>
          </label>)}
        </fieldset>
        {publicEntry.existing ? <>
          <label className="lr-client-public-origin"><span className={vis ? "visually-hidden" : undefined}>{t("client.launch.publicAddress")}</span>
            <span className="lr-input"><Glyph name="link" size={18} /><input type="url" inputMode="url" required pattern="https://.*" dir="ltr"
              autoComplete="url" autoCapitalize="none" spellCheck={false} placeholder="https://piik.example" value={publicEntry.origin}
              aria-label={t("client.launch.publicAddress")} aria-invalid={Boolean(publicEntry.error)} aria-describedby={publicEntry.error ? `${accessHintId}-public-error` : undefined}
              onChange={event => publicEntry.onChange({ existing: true, origin: event.target.value })} /></span>
          </label>
          {publicEntry.error && <p id={`${accessHintId}-public-error`} role="alert">{publicEntry.error}</p>}
          <div className="lr-client-forward-target"><span className={vis ? "visually-hidden" : undefined}>{t("client.launch.forwardTarget")}</span>
            <div><code dir="ltr">{publicEntry.localAddress}</code><Btn icon={clipboard.status === "copied" ? "check" : "copy"} size="dense" quiet title={copyLabel} cap={copyLabel} onClick={clipboard.copy} /></div>
          </div>
          <p className={vis ? "visually-hidden" : undefined}>{t("client.launch.existingAddressHint")}</p>
        </> : <p className={vis ? "visually-hidden" : undefined}>{t("client.launch.automaticAddressHint")}</p>}
      </div>}

      {mode === "local" && lan && <div className="lr-client-room-settings">
          {lan.addresses.length === 0 ? (
            <Pill icon="wifiOff" tone="warn" comic="signal-offline" label={t("client.launch.lanUnavailable")} />
          ) : <div className="lr-capture-device lr-client-lan">
            <AddressLabel className="lr-client-lan-label" htmlFor={chooseLAN ? `${accessHintId}-address` : undefined}><Glyph name="users" size={17} />
              <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.lanAddress")}</span>
            </AddressLabel>
            {chooseLAN ? <select id={`${accessHintId}-address`} value={lan.selected} aria-label={t("client.launch.lanAddress")}
              aria-describedby={`${accessHintId}-lan`} onChange={event => lan.onChange(event.target.value)}>
              <option value="" disabled>{t("client.launch.chooseAddress")}</option>
              {lan.addresses.map(({ address, name }) => (
                <option key={address} value={address}>{address} · {name}</option>
              ))}
            </select> : <p className="lr-client-lan-value" dir="ltr">{lan.selected}<span>{lan.addresses[0]?.name}</span></p>}
            {chooseLAN && <small id={`${accessHintId}-lan`} className={vis ? "visually-hidden" : undefined}>{t("client.launch.lanHint")}</small>}
          </div>}
      </div>}

      {mode === "local" && <p className={vis ? "visually-hidden" : "lr-client-access-hint"}>
        {t("client.launch.localHTTPS")}
      </p>}
      {port && <details className="lr-client-access-options lr-client-port-options">
        <summary className="lr-btn"><Glyph name="sliders" size={17} />
          <span className={vis ? "visually-hidden" : undefined}>{t("client.launch.sitePort")}</span>
          <span>{port.value}</span><Glyph name="chevron" size={15} /></summary>
        <NumberControl value={port.value} min={1} max={65535} step={1} unit="" showUnit={false}
          name="site-port" label={t("client.launch.sitePort")} disabled={false} onChange={port.onChange} className="lr-client-port">
          {input => <label><span className={vis ? "visually-hidden" : undefined}>{t("client.launch.sitePort")}</span>{input}</label>}
        </NumberControl>
        <p className={vis ? "visually-hidden" : "lr-client-access-hint"}>{t(mode === "link" && publicEntry?.existing ? "client.launch.forwardPortHint" : "client.launch.sitePortHint")}</p>
      </details>}
      <Btn
        icon={roomError ? "refresh" : "arrowRight"}
        title={roomError ? "common.retry" : "client.launch.go"}
        cap={roomError ? "common.retry" : "client.launch.go"}
        tone="primary"
        type="submit"
        hint={vis ? MODES.find((choice) => choice.mode === mode)?.comic : undefined}
        disabled={mode === "local" && lan !== undefined && !lan.selected}
      />
      </>}
  </>;
}

interface LauncherFormProps extends SiteStartControlsProps, DeviceSiteApprovalsProps {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children?: ReactNode;
}

// The product preview and film compose the same controls as the App launcher.
export function LauncherForm({ children, onSubmit, ...props }: LauncherFormProps) {
  const { vis, t } = useCopy();
  return (
    <form className="lr-client-launch-panel" onSubmit={onSubmit}>
      <header className="lr-client-launch-heading">
        <BrandLockup size={52} motion="once" className="lr-client-launch-brand"
          heading titleClassName="lr-client-launch-title" suffix={<> <small>App</small></>} />
        <WelcomeLine />
      </header>
      {children}
      <DeviceSiteApprovals
        sites={props.sites} startupSite={props.startupSite} ownedStartup={props.ownedStartup}
        ownedSites={props.ownedSites} onToggleStartupSite={props.onToggleStartupSite}
        onRemoveSite={props.onRemoveSite} onSelectSite={props.onSelectSite}
        siteAddress={props.siteAddress} siteBusy={props.siteBusy} siteError={props.siteError}
        onOpen={props.onOpen} entryURL={props.entryURL} />
      {!props.target && <p className={vis ? "visually-hidden" : "lr-client-launch-section"}>{t("client.launch.room")}</p>}
      <SiteStartControls
        mode={props.mode} onModeChange={props.onModeChange} port={props.port} publicEntry={props.publicEntry} target={props.target}
        localCertificate={props.localCertificate} onOpen={props.onOpen} entryURL={props.entryURL}
        lan={props.lan} roomError={props.roomError} />
    </form>
  );
}
