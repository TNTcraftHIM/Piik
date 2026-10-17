import type { ReactNode } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap } from "./primitives";

// Presentation only. Capture, preferences and pending operations stay with the Host.
export function SharingSettings({ id, open, busy, presets, picture, pictureSummary, audio, technical }: {
  id: string; open: boolean; busy?: boolean;
  presets: ReactNode; picture?: ReactNode; pictureSummary?: ReactNode; audio: ReactNode; technical?: ReactNode;
}) {
  const { t } = useCopy();
  return <div id={id} className={`lr-sharing-settings lr-door-reveal${open ? " is-open" : ""}`}>
    <div>{open ? <section className="lr-sharing-panel" aria-label={t("host.advanced")} aria-busy={busy}>
      <section className="lr-sharing-section" aria-label={t("host.settings.picture")}>
        <h2 aria-label={t("host.settings.picture")}><Glyph name="tv" size={20} /><Cap k="host.settings.picture" /></h2>
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
      <section className="lr-sharing-section" aria-label={t("host.settings.sound")}>
        <h2 aria-label={t("host.settings.sound")}><Glyph name="speaker" size={20} /><Cap k="host.settings.sound" /></h2>
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
