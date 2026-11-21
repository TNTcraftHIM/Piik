import { useId, type ReactNode } from "react";
import type { ViewerRoutePreference } from "../../../shared/protocol";
import type { VideoFit, VideoRotation } from "../../media/video-geometry";
import type { RoomPreferences } from "../../lib/room-preferences";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn, Cap, Chip, FieldCap, Pill, RowGroup, SegmentedChoice, SwitchItem } from "./primitives";
import { NumberControl } from "./NumberControl";
import { MAX_PLAYBACK_BUFFER_TARGET_MS } from "../../webrtc/receiver-buffer-target";
import { RelayVolunteerSettings, type RelayCapacitySettings } from "./RelayVolunteerSettings";
import "./playback-controls.css";

const INITIAL_MANUAL_BUFFER_TARGET_MS = 300;

export interface PlaybackSettingsProps {
  pictureFit: VideoFit;
  setPictureFit: (fit: VideoFit) => void;
  pictureRotation: VideoRotation;
  setPictureRotation: (rotation: VideoRotation) => void;
  buffering?: {
    target: number | null;
    status: "supported" | "unsupported" | "failed" | null;
    onChange(target: number | null): void;
  };
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
  relayVolunteer?: RelayCapacitySettings;
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
    <SegmentedChoice label="remote.touchMode" describedBy={vis ? undefined : `${id}-hint`}
      value={mode} onChange={onChange} options={[
        { value: "direct", label: "remote.touchMode.direct", icon: "tv" },
        { value: "trackpad", label: "remote.touchMode.trackpad", icon: "mouse" },
      ]} />
    {!vis && <p id={`${id}-hint`}>{t(hint)}</p>}
  </section>;
}

// Local display and connection intent; media and routing keep their owners.
export function PlaybackSettings({ picture, preview, remoteTouch, route, relayVolunteer, buffering, overlaySettings, reconnect }: Pick<PlaybackSettingsProps, "preview" | "remoteTouch" | "route" | "relayVolunteer" | "buffering"> & {
  picture?: PlaybackSettingsProps;
  overlaySettings?: ReactNode; reconnect: ReactNode;
}) {
  const { t, vis } = useCopy();
  const routeHint = route?.rejected ? "playback.routeRejected" : route?.sfuOnly ? "playback.routeSfuOnly"
    : route?.peerOnly ? "playback.routePeerOnly" : !route?.sfuAvailable ? "playback.routeNoSfu"
    : `playback.routeHint.${route.preference}` as const;
  const detailedSections = [preview, buffering, remoteTouch, overlaySettings, route || relayVolunteer || reconnect].filter(Boolean).length;
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
    {buffering && <section aria-label={t("playback.buffering")}>
      <div className="lr-viewer-settings-heading"><h3><Glyph name="clock" size={17} /><span className={vis ? "visually-hidden" : undefined}>{t("playback.buffering")}</span></h3></div>
      <RowGroup><SwitchItem checked={buffering.target !== null} onChange={enabled => buffering.onChange(enabled ? INITIAL_MANUAL_BUFFER_TARGET_MS : null)}
        disabled={buffering.status === "unsupported" && buffering.target === null}
        label={t("playback.increaseBuffer")} icon="clock" /></RowGroup>
      {buffering.target !== null && <NumberControl value={buffering.target} min={0} max={MAX_PLAYBACK_BUFFER_TARGET_MS} step={1} unit="ms"
        name="screen-buffer-target" label={t("playback.bufferTarget")} disabled={buffering.status === "unsupported"}
        onChange={buffering.onChange} className="lr-door-group">{input => <div className="lr-quality-heading">
          <FieldCap k="playback.bufferTarget" />{input}
        </div>}</NumberControl>}
      {!vis && <p>{t("playback.bufferHint")}</p>}
      {buffering.status === "unsupported" && <Pill icon="alert" label={t("playback.bufferUnsupported")} comic="warning" />}
      {buffering.status === "failed" && <Pill icon="alert" tone="bad" label={t("playback.bufferFailed")} comic="settings-failed" />}
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
      {relayVolunteer && <RelayVolunteerSettings settings={relayVolunteer} />}
    </section>}
  </div>;
}
