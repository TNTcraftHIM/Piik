import type { FormEvent, ReactNode } from "react";
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
  error,
  onSubmit,
  children,
}: {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  site: string;
  onSiteChange: (site: string) => void;
  localAccessPassword: string;
  onLocalAccessPasswordChange: (password: string) => void;
  error: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children?: ReactNode;
}) {
  const { vis, t } = useCopy();
  const accessField = (
    <label className="lr-input lr-client-access">
      <Glyph name="lock" size={18} />
      <input
        type="text"
        value={localAccessPassword}
        autoComplete="off"
        spellCheck={false}
        placeholder={vis ? "" : t("client.launch.localAccess")}
        aria-label={t("client.launch.localAccess")}
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
      >
        {MODES.map((choice) => {
          const button = (
            <button
              key={choice.mode}
              type="button"
              role="radio"
              className={`lr-client-mode${mode === choice.mode ? " is-selected" : ""}`}
              aria-checked={mode === choice.mode}
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

      {mode === "site" ? (
        <label className="lr-input lr-client-site">
          <Glyph name="link" size={18} />
          <input
            type="url"
            value={site}
            autoFocus
            spellCheck={false}
            inputMode="url"
            placeholder="https://share.example"
            aria-label={t("client.launch.siteAddress")}
            onChange={(event) => {
              onSiteChange(event.target.value);
            }}
          />
        </label>
      ) : null}

      {mode !== "site" ? (
        <Tooltip
          kind="hint-password"
          text={vis ? undefined : t("client.launch.localAccessHint")}
        >
          {accessField}
        </Tooltip>
      ) : null}

      {error ? (
        <Pill
          icon="alert"
          tone="bad"
          label={t("client.launch.error")}
          alert
          comic="warning"
        />
      ) : null}
      <Btn
        icon="arrowRight"
        title="client.launch.go"
        cap="client.launch.go"
        tone="primary"
        type="submit"
        disabled={mode === "site" && !site.trim()}
      />
    </form>
  );
}
