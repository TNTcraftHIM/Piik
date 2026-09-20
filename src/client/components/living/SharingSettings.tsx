import type { ReactNode } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap } from "./primitives";

// Presentation only. Capture, preferences and pending operations stay with the Host.
export function SharingSettings({ id, open, busy, presets, picture, audio, technical }: {
  id: string; open: boolean; busy?: boolean;
  presets: ReactNode; picture?: ReactNode; audio: ReactNode; technical?: ReactNode;
}) {
  const { t } = useCopy();
  return <div id={id} className={`lr-sharing-settings lr-door-reveal${open ? " is-open" : ""}`}>
    <div>{open ? <section className="lr-sharing-panel" aria-label={t("host.advanced")} aria-busy={busy}>
      <div className="lr-sharing-columns">
        <section className="lr-sharing-section" aria-label={t("host.settings.picture")}>
          <h2 aria-label={t("host.settings.picture")}><Glyph name="tv" size={20} /><Cap k="host.settings.picture" /></h2>
          {presets}
          {picture}
        </section>
        <section className="lr-sharing-section" aria-label={t("host.settings.sound")}>
          <h2 aria-label={t("host.settings.sound")}><Glyph name="speaker" size={20} /><Cap k="host.settings.sound" /></h2>
          {audio}
        </section>
      </div>
      {technical ? <details className="lr-sharing-technical">
        <summary aria-label={t("host.settings.technical")}><Glyph name="sliders" size={17} /><Cap k="host.settings.technical" /></summary>
        <div>{technical}</div>
      </details> : null}
    </section> : null}</div>
  </div>;
}
