import { useId, type FormEvent, type ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { Tooltip } from "./Tooltip";
import { WelcomeLine } from "./WelcomeLine";
import { Btn, Pill } from "./primitives";
import type { HintKind } from "./hints";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
export type AppMode = "local" | "link" | "site";

const MODES: Array<{
  mode: AppMode;
  icon: GlyphName;
  label: CopyKey;
  hint: CopyKey;
  comic: HintKind;
}> = [
  {
    mode: "local",
    icon: "users",
    label: "client.launch.local",
    hint: "client.launch.localHint",
    comic: "hint-client-local",
  },
  {
    mode: "link",
    icon: "globe",
    label: "client.launch.link",
    hint: "client.launch.linkHint",
    comic: "hint-client-link",
  },
  {
    mode: "site",
    icon: "server",
    label: "client.launch.site",
    hint: "client.launch.siteHint",
    comic: "hint-client-site",
  },
];

// The product and film share this form; requests and navigation stay in the page.
export function LauncherForm({
  mode,
  onModeChange,
  site,
  onSiteChange,
  localAccessPassword,
  onLocalAccessPasswordChange,
  lan,
  onSubmit,
  children,
}: {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  site: string;
  onSiteChange: (site: string) => void;
  localAccessPassword: string;
  onLocalAccessPasswordChange: (password: string) => void;
  lan?: {
    addresses: readonly { address: string; name: string }[];
    selected: string;
    onChange: (address: string) => void;
  };
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children?: ReactNode;
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
      <BrandMark size={68} motion="once" />
      <WelcomeLine />
      <h1 className={vis ? "visually-hidden" : "lr-client-launch-title"}>
        {t("client.launch.title")}
      </h1>

      {children}

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
              className={`lr-client-mode${mode === choice.mode ? " is-selected" : ""}`}
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

      {mode === "local" && lan && (lan.addresses.length !== 1 || !lan.selected) ? (
        <fieldset className="lr-client-lan">
          <legend className={vis ? "visually-hidden" : undefined}>{t("client.launch.lanAddress")}</legend>
          {lan.addresses.length === 0 ? (
            <Pill icon="wifiOff" tone="warn" comic="signal-offline" label={t("client.launch.lanUnavailable")} />
          ) : <>
            {vis ? null : <p className="lr-client-lan-hint">{t("client.launch.lanHint")}</p>}
            <div className="lr-client-lan-options">
              {lan.addresses.map(({ address, name }) => (
                <label key={address} className={`lr-btn lr-client-lan-option${lan.selected === address ? " is-on" : ""}`}>
                  <input type="radio" name="lan-address" value={address}
                    checked={lan.selected === address} onChange={() => lan.onChange(address)} />
                  <span><strong>{name}</strong><small>{address}</small></span>
                </label>
              ))}
            </div>
          </>}
        </fieldset>
      ) : null}

      {mode === "site" ? (
        <label className="lr-input lr-client-site">
          <Glyph name="link" size={18} />
          <input
            type="url"
            value={site}
            spellCheck={false}
            inputMode="url"
            placeholder="https://piik.example.com"
            aria-label={t("client.launch.siteAddress")}
            onChange={(event) => {
              onSiteChange(event.target.value);
            }}
          />
        </label>
      ) : null}

      {mode !== "site" ? (
        <details className="lr-client-access-options">
          <summary>
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
      ) : null}

      <Btn
        icon="arrowRight"
        title="client.launch.go"
        cap="client.launch.go"
        tone="primary"
        type="submit"
        hint={MODES.find((choice) => choice.mode === mode)?.comic}
        disabled={(mode === "site" && !site.trim()) ||
          (mode === "local" && lan !== undefined && !lan.selected)}
      />
    </form>
  );
}
