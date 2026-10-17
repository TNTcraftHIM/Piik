import type { ViewerRoutePreference } from "../../../shared/protocol";
import type { VideoFit } from "../../media/video-geometry";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap, Chip, RowGroup } from "./primitives";

export interface ViewerPlaybackSettingsProps {
  pictureFit: VideoFit;
  setPictureFit: (fit: VideoFit) => void;
  route?: {
    preference: ViewerRoutePreference;
    sfuAvailable: boolean;
    sfuOnly: boolean;
    peerOnly: boolean;
    disabled: boolean;
    rejected: boolean;
    onChange: (preference: ViewerRoutePreference) => void;
  };
}

// Local display and incoming-route intent only; media and routing keep their owners.
export function ViewerPlaybackSettings({ pictureFit, setPictureFit, route }: ViewerPlaybackSettingsProps) {
  const { t, vis } = useCopy();
  const routeHint = route?.rejected ? "playback.routeRejected" : route?.sfuOnly ? "playback.routeSfuOnly"
    : route?.peerOnly ? "playback.routePeerOnly" : !route?.sfuAvailable ? "playback.routeNoSfu"
    : `playback.routeHint.${route.preference}` as const;
  return <div className="lr-viewer-settings">
    <section aria-label={t("playback.pictureFit")}>
      <h3><Glyph name="tv" size={17} /><Cap k="playback.pictureFit" /></h3>
      <RowGroup>{(["contain", "cover", "fill"] as const).map(fit => <Chip key={fit}
        selected={pictureFit === fit} title={t(`playback.fit.${fit}`)} onClick={() => setPictureFit(fit)}>
        {vis && <Glyph name={fit === "contain" ? "fitContain" : fit === "cover" ? "fitCover" : "fitStretch"} size={20} />}
        <Cap k={`playback.fit.${fit}`} />
      </Chip>)}</RowGroup>
      {!vis && <p>{t(pictureFit === "cover" ? "playback.fitCrop" : pictureFit === "fill" ? "playback.fitStretch" : "playback.fitFull")}</p>}
    </section>
    {route ? <section aria-label={t("host.settings.connection")}>
      <h3><Glyph name="branch" size={17} /><Cap k="host.settings.connection" /></h3>
      <RowGroup>{(["auto", "p2p", "sfu"] as const).map(preference => <Chip key={preference}
        selected={route.preference === preference} title={t(`playback.route.${preference}`)}
        disabled={route.disabled || (preference === "p2p" && route.sfuOnly) || (preference === "sfu" && !route.sfuAvailable)}
        hint={preference === "auto" ? undefined : preference === "p2p" ? "hint-route-p2p" : "hint-route-sfu"}
        onClick={() => { if (route.preference !== preference) route.onChange(preference); }}>
        {vis && <Glyph name={preference === "auto" ? "branch" : preference === "p2p" ? "link" : "server"} size={17} />}
        <Cap k={`playback.route.${preference}`} />
      </Chip>)}</RowGroup>
      {!vis && <p className={route.rejected ? "is-error" : undefined} role={route.rejected ? "status" : undefined}>{t(routeHint)}</p>}
    </section> : null}
  </div>;
}
