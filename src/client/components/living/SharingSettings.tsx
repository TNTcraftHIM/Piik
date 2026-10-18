import { useState, type ReactNode } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { navigateTabs } from "../../ui/tab-navigation";
import { Cap } from "./primitives";

// Presentation only. Capture, preferences and pending operations stay with the Host.
export function SharingSettings({ id, open, busy, presets, picture, pictureSummary, audio, connection }: {
  id: string; open: boolean; busy?: boolean;
  presets: ReactNode; picture?: ReactNode; pictureSummary?: ReactNode; audio: ReactNode; connection?: ReactNode;
}) {
  const { t } = useCopy();
  const [tab, setTab] = useState<"picture" | "sound">("picture");
  return <div id={id} className={`lr-sharing-settings lr-door-reveal${open ? " is-open" : ""}`}>
    <div>{open ? <section className="lr-sharing-panel" aria-label={t("host.advanced")} aria-busy={busy}>
      <div className="lr-toggle lr-sharing-tabs" role="tablist" aria-label={t("host.advanced")} onKeyDown={navigateTabs}>
        {(["picture", "sound"] as const).map(value => <button key={value} type="button" role="tab"
          id={`${id}-${value}-tab`} className={tab === value ? "is-selected" : undefined}
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
      {connection ? <details className="lr-sharing-connection">
        <summary aria-label={t("host.settings.connection")}>
          <span><Glyph name="branch" size={17} /><Cap k="host.settings.connection" /></span>
          <Glyph name="chevron" size={17} className="lr-sharing-chevron" />
        </summary>
        <div>{connection}</div>
      </details> : null}
    </section> : null}</div>
  </div>;
}
