import { useState, type ReactNode, type KeyboardEvent } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap } from "./primitives";

// Presentation only. Capture, preferences and pending operations stay with the Host.
export function SharingSettings({ id, open, busy, presets, picture, pictureSummary, audio, technical }: {
  id: string; open: boolean; busy?: boolean;
  presets: ReactNode; picture?: ReactNode; pictureSummary?: ReactNode; audio: ReactNode; technical?: ReactNode;
}) {
  const { t } = useCopy();
  const [tab, setTab] = useState<"picture" | "sound">("picture");
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (current + 1) % tabs.length
      : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  }
  return <div id={id} className={`lr-sharing-settings lr-door-reveal${open ? " is-open" : ""}`}>
    <div>{open ? <section className="lr-sharing-panel" aria-label={t("host.advanced")} aria-busy={busy}>
      <div className="lr-sharing-tabs" role="tablist" aria-label={t("host.advanced")} onKeyDown={navigate}>
        {(["picture", "sound"] as const).map(value => <button key={value} type="button" role="tab"
          id={`${id}-${value}-tab`} className={`lr-chip${tab === value ? " is-selected" : ""}`}
          aria-label={t(`host.settings.${value}`)} aria-selected={tab === value}
          aria-controls={`${id}-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>
          <Glyph name={value === "picture" ? "tv" : "speaker"} size={18} /><Cap k={`host.settings.${value}`} />
        </button>)}
      </div>
      <section id={`${id}-picture`} className="lr-sharing-section" role="tabpanel" tabIndex={0}
        aria-labelledby={`${id}-picture-tab`} hidden={tab !== "picture"}>
        {presets}
        {picture ? <details className="lr-sharing-picture-details">
          <summary aria-label={t("host.settings.pictureDetails")}>
            <span><Glyph name="sliders" size={17} /><Cap k="host.settings.pictureDetails" /></span>
            {pictureSummary}
            <Glyph name="chevron" size={17} className="lr-sharing-chevron" />
          </summary>
          <div>{picture}</div>
        </details> : null}
      </section>
      <section id={`${id}-sound`} className="lr-sharing-section" role="tabpanel" tabIndex={0}
        aria-labelledby={`${id}-sound-tab`} hidden={tab !== "sound"}>
        <div className="lr-sharing-audio-controls">{audio}</div>
      </section>
      {technical ? <details className="lr-sharing-technical">
        <summary aria-label={t("host.settings.technical")}>
          <span><Glyph name="branch" size={17} /><Cap k="host.settings.technical" /></span>
          <Glyph name="chevron" size={17} className="lr-sharing-chevron" />
        </summary>
        <div>{technical}</div>
      </details> : null}
    </section> : null}</div>
  </div>;
}
