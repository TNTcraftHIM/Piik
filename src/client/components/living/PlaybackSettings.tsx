import { useId, type ReactNode } from "react";
import type { ViewerRoutePreference } from "../../../shared/protocol";
import type { VideoFit, VideoRotation } from "../../media/video-geometry";
import type { RoomPreferences } from "../../lib/room-preferences";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, Cap, Chip, FieldCap, Pill, RowGroup, SwitchItem } from "./primitives";
import { NumberControl } from "./NumberControl";
import { Tooltip } from "./Tooltip";
import "./playback-controls.css";

export interface PlaybackSettingsProps {
  pictureFit: VideoFit;
  setPictureFit: (fit: VideoFit) => void;
  pictureRotation: VideoRotation;
  setPictureRotation: (rotation: VideoRotation) => void;
  preview?: {
    autoPause: boolean;
    onChange: (enabled: boolean) => void;
  };
  remoteTouch?: {
    mode: RoomPreferences["remoteTouchMode"];
    onChange: (mode: RoomPreferences["remoteTouchMode"]) => void;
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
    capacity: number;
    minimum: number;
    maximum: number;
    available: boolean;
    onChange: (enabled: boolean) => void;
    onCapacityChange: (capacity: number) => void;
  };
}

export function PlaybackPictureControls({ settings, captions = false }: {
  settings: Pick<PlaybackSettingsProps, "pictureFit" | "setPictureFit" | "pictureRotation" | "setPictureRotation">;
  captions?: boolean;
}) {
  const { t } = useCopy();
  const nextFit = settings.pictureFit === "contain" ? "cover" : settings.pictureFit === "cover" ? "fill" : "contain";
  return <>
    <Btn icon={settings.pictureFit === "contain" ? "fitContain" : settings.pictureFit === "cover" ? "fitCover" : "fitStretch"}
      title="playback.changeFit" cap={captions ? `playback.fit.${settings.pictureFit}` : undefined}
      hint={`hint-fit-${settings.pictureFit}`} hintText="playback.fitCycle"
      hintVars={{ current: t(`playback.fit.${settings.pictureFit}`), next: t(`playback.fit.${nextFit}`) }}
      onClick={() => settings.setPictureFit(nextFit)} />
    <Btn icon="rotatePicture" title="playback.rotation" cap={captions ? "playback.rotation" : undefined}
      hint="hint-picture-rotation" hintText="playback.rotationHint"
      onClick={() => settings.setPictureRotation((settings.pictureRotation + 90) % 360 as VideoRotation)} />
  </>;
}

export function RemoteTouchSettings({ mode, onChange }: NonNullable<PlaybackSettingsProps["remoteTouch"]>) {
  const { t, vis } = useCopy();
  const id = useId();
  const hint = mode === "direct" ? "remote.touchMode.directHint" : "remote.touchMode.trackpadHint";
  return <section aria-label={t("remote.touchMode")}>
    <div className="lr-viewer-settings-heading">
      <h3><Glyph name="mouse" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("remote.touchMode")}</span></h3>
    </div>
    <div className="lr-toggle" role="radiogroup" aria-label={t("remote.touchMode")} aria-describedby={vis ? undefined : `${id}-hint`}>
      {(["direct", "trackpad"] as const).map(value => <label key={value}>
        <input type="radio" name={id} value={value} checked={mode === value}
          aria-label={t(`remote.touchMode.${value}`)} onChange={() => onChange(value)} />
        <span><Glyph name={value === "direct" ? "tv" : "mouse"} size={17} /><Cap k={`remote.touchMode.${value}`} /></span>
      </label>)}
    </div>
    {!vis && <p id={`${id}-hint`}>{t(hint)}</p>}
  </section>;
}

// Local display and connection intent; media and routing keep their owners.
export function PlaybackSettings({ picture, preview, remoteTouch, route, relayVolunteer, overlaySettings, reconnect }: Pick<PlaybackSettingsProps, "preview" | "remoteTouch" | "route" | "relayVolunteer"> & {
  picture?: PlaybackSettingsProps;
  overlaySettings?: ReactNode; reconnect: ReactNode;
}) {
  const { t, vis } = useCopy();
  const routeHint = route?.rejected ? "playback.routeRejected" : route?.sfuOnly ? "playback.routeSfuOnly"
    : route?.peerOnly ? "playback.routePeerOnly" : !route?.sfuAvailable ? "playback.routeNoSfu"
    : `playback.routeHint.${route.preference}` as const;
  const detailedSections = [preview, remoteTouch, overlaySettings, route || relayVolunteer || reconnect].filter(Boolean).length;
  return <div className={`lr-viewer-settings${detailedSections <= 1 ? " is-single" : ""}`}>
    {picture && <section className="lr-playback-compact-picture" aria-label={t("playback.viewControls")}>
      <div className="lr-viewer-settings-heading">
        <h3><Glyph name="tv" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("playback.viewControls")}</span></h3>
      </div>
      <div className="lr-playback-picture-options"><PlaybackPictureControls settings={picture} captions /></div>
    </section>}
    {preview && <section aria-label={t("host.preview")}>
      <div className="lr-viewer-settings-heading">
        <h3><Glyph name="tv" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("host.preview")}</span></h3>
      </div>
      <RowGroup><SwitchItem checked={preview.autoPause} onChange={preview.onChange} icon="pause"
        label={t("host.previewAutoPause")} note={t("host.previewAutoPauseHint")} hint="hint-local-pause" /></RowGroup>
      {!vis && <p>{t("host.previewAutoPauseHint")}</p>}
    </section>}
    {remoteTouch && <RemoteTouchSettings {...remoteTouch} />}
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
        <div className="lr-door-group">
        <RowGroup>
          {vis && <Glyph name="branch" size={18} />}
          <SwitchItem checked={relayVolunteer.enabled} disabled={relayVolunteer.disabled}
            onChange={relayVolunteer.onChange} label={t("playback.relayVolunteer")}
            note={t(relayVolunteer.available ? "playback.relayVolunteerHint" : "playback.relayUnavailable")} hint="hint-relay-volunteer" />
        </RowGroup>
        {relayVolunteer.enabled && <NumberControl value={relayVolunteer.capacity} min={relayVolunteer.minimum} max={relayVolunteer.maximum}
          step={1} unit={t("playback.relayPeople")} showUnit={!vis} name="relay-capacity" label={t("playback.relayLimit")}
          disabled={relayVolunteer.disabled || !relayVolunteer.available} onChange={relayVolunteer.onCapacityChange}
          className="lr-door-group">{input => <div className="lr-quality-heading">
            {vis ? <Glyph name="branch" size={16} /> : <FieldCap k="playback.relayLimit" />}
            <Tooltip kind="hint-relay-volunteer" text={`${t("playback.relayLimit")}\n${t("playback.relayVolunteerHint")}`}>{input}</Tooltip>
          </div>}</NumberControl>}
        </div>
        {!vis && <p>{t(relayVolunteer.available ? "playback.relayVolunteerHint" : "playback.relayUnavailable")}</p>}
      </div>}
    </section>}
  </div>;
}
