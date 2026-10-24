import type { ReactNode } from "react";
import type { ViewerRoutePreference } from "../../../shared/protocol";
import type { VideoFit, VideoRotation } from "../../media/video-geometry";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Cap, Chip, Pill, RowGroup, SwitchItem } from "./primitives";

export interface PlaybackSettingsProps {
  pictureFit: VideoFit;
  setPictureFit: (fit: VideoFit) => void;
  pictureRotation: VideoRotation;
  setPictureRotation: (rotation: VideoRotation) => void;
  preview?: {
    autoPause: boolean;
    onChange: (enabled: boolean) => void;
  };
  route?: {
    preference: ViewerRoutePreference;
    sfuAvailable: boolean;
    sfuOnly: boolean;
    peerOnly: boolean;
    disabled: boolean;
    rejected: boolean;
    onChange: (preference: ViewerRoutePreference) => void;
  };
  relayVolunteer?: {
    enabled: boolean;
    pending: boolean;
    disabled: boolean;
    onChange: (enabled: boolean) => void;
  };
}

// Local display and connection intent; media and routing keep their owners.
export function PlaybackSettings({ preview, route, relayVolunteer, overlaySettings, reconnect }: Pick<PlaybackSettingsProps, "preview" | "route" | "relayVolunteer"> & {
  overlaySettings?: ReactNode; reconnect: ReactNode;
}) {
  const { t, vis } = useCopy();
  const routeHint = route?.rejected ? "playback.routeRejected" : route?.sfuOnly ? "playback.routeSfuOnly"
    : route?.peerOnly ? "playback.routePeerOnly" : !route?.sfuAvailable ? "playback.routeNoSfu"
    : `playback.routeHint.${route.preference}` as const;
  return <div className="lr-viewer-settings">
    {preview && <section aria-label={t("host.preview")}>
      <div className="lr-viewer-settings-heading">
        <h3><Glyph name="tv" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("host.preview")}</span></h3>
      </div>
      <RowGroup><SwitchItem checked={preview.autoPause} onChange={preview.onChange} icon="pause"
        label={t("host.previewAutoPause")} note={t("host.previewAutoPauseHint")} hint="hint-local-pause" /></RowGroup>
      {!vis && <p>{t("host.previewAutoPauseHint")}</p>}
    </section>}
    {overlaySettings && <section aria-label={t("playback.overlay")}>
      <div className="lr-viewer-settings-heading">
        <h3><Glyph name="danmaku" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("playback.overlay")}</span></h3>
      </div>
      {overlaySettings}
    </section>}
    {(route || relayVolunteer || reconnect) && <section aria-label={t("playback.connection")}>
      <div className="lr-viewer-settings-heading">
        <h3><Glyph name="branch" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("playback.connection")}</span></h3>
        {reconnect}
      </div>
      {route && <>
        <RowGroup>{(["auto", "p2p", "sfu"] as const).map(preference => {
          const locked = preference === "p2p" && route.sfuOnly ? "playback.routeSfuOnly"
            : preference === "sfu" && !route.sfuAvailable ? route.peerOnly ? "playback.routePeerOnly" : "playback.routeNoSfu" : undefined;
          return <Chip key={preference}
            selected={route.preference === preference} title={t(`playback.route.${preference}`)}
            disabled={route.disabled || Boolean(locked)}
            hint={locked ? preference === "p2p" ? "hint-route-sfu-required" : "hint-route-p2p-required"
              : preference === "auto" ? "hint-route-auto" : preference === "p2p" ? "hint-route-p2p" : "hint-route-sfu"}
            hintText={t(locked ?? `playback.routeHint.${preference}`)}
            onClick={() => { if (route.preference !== preference) route.onChange(preference); }}>
            {vis && <Glyph name={preference === "auto" ? "branch" : preference === "p2p" ? "network" : "server"} size={17} />}
            <Cap k={`playback.route.${preference}`} />
          </Chip>;
        })}</RowGroup>
        {!vis && <p className={route.rejected ? "is-error" : undefined} role={route.rejected ? "status" : undefined}>{t(routeHint)}</p>}
        {vis && route.rejected && <Pill icon="alert" tone="bad" label={t(routeHint)} comic="settings-failed" />}
      </>}
      {relayVolunteer && <div className="lr-viewer-relay-setting" aria-busy={relayVolunteer.pending}>
        <RowGroup>
          {vis && <Glyph name="branch" size={18} />}
          <SwitchItem checked={relayVolunteer.enabled} disabled={relayVolunteer.disabled}
            onChange={relayVolunteer.onChange} label={t("playback.relayVolunteer")}
            note={t("playback.relayVolunteerHint")} hint="hint-relay-volunteer" />
        </RowGroup>
        {!vis && <p>{t("playback.relayVolunteerHint")}</p>}
      </div>}
    </section>}
  </div>;
}
