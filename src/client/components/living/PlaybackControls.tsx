import { useEffect, useId, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ViewerAudio, type ViewerAudioSnapshot } from "../../media/viewer-audio";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { debugError } from "../../lib/debug";
import { Btn } from "./primitives";
import { ViewerPlaybackSettings, type ViewerPlaybackSettingsProps } from "./ViewerPlaybackSettings";
import { Tooltip } from "./Tooltip";
import { useAnchoredPopover } from "./use-anchored-popover";
import { usePlaybackControlsVisibility } from "./use-playback-controls-visibility";
import { usePictureInPicture } from "./use-picture-in-picture";
import { bindPlaybackGestures } from "./playback-gestures";
import { useVideoRotation } from "./use-video-rotation";
import { toggleVideoFullscreen, videoFullscreenState, type FullscreenVideo } from "./video-fullscreen";
import "./playback-controls.css";
import "./floating-panel.css";

type PlaybackVisibility = ReturnType<typeof usePlaybackControlsVisibility>;

// Reflect the existing media element; binding, autoplay recovery and room
// presentation retain their existing owners.
export function PlaybackControls({
  videoRef, stream, audioTrackKey, audioAvailable, canPlay, theaterMode, onPlay, onPause,
  onToggleTheater, onReconnect, reconnectAvailable,
  overlayAction, overlaySettings, remoteActions, settings,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  audioTrackKey?: string;
  audioAvailable?: boolean | null;
  canPlay: boolean;
  theaterMode: boolean;
  onPlay: () => void;
  onPause?: () => void;
  onToggleTheater: () => void;
  onReconnect?: () => void;
  reconnectAvailable?: boolean;
  overlayAction?: ReactNode;
  overlaySettings?: ReactNode;
  remoteActions?: ReactNode;
  settings?: ViewerPlaybackSettingsProps;
}) {
  const audioRef = useRef<ViewerAudio | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [audio, setAudio] = useState<ViewerAudioSnapshot>({
    level: 1, muted: false, boostAvailable: true,
  });
  const [paused, setPaused] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [fullscreen, setFullscreen] = useState({ supported: false, ready: false, active: false });
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const visibility = usePlaybackControlsVisibility(videoRef, controlsRef, paused || !canPlay);
  const picture = usePictureInPicture(videoRef);
  useVideoRotation(videoRef, settings?.pictureFit, settings?.pictureRotation ?? 0);

  const togglePlayback = () => {
    if (!canPlay) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      audioRef.current?.resume();
      onPlay();
    } else {
      video.pause();
      onPause?.();
    }
  };
  const toggleFullscreen = () => {
    if (theaterMode) return;
    const video = videoRef.current as FullscreenVideo | null;
    if (!video) return;
    setFullscreenFailed(false);
    void toggleVideoFullscreen(video).catch((error: unknown) => {
      debugError("playback", "fullscreen-failed", error);
      if (videoRef.current === video) setFullscreenFailed(true);
    });
  };
  const actionsRef = useRef({ togglePlayback, toggleFullscreen });
  actionsRef.current = { togglePlayback, toggleFullscreen };

  useEffect(() => {
    const video = videoRef.current as FullscreenVideo | null;
    if (!video) return;
    const output = new ViewerAudio(video, setAudio);
    audioRef.current = output;
    const syncPlayback = () => setPaused(video.paused);
    const syncFullscreen = () => {
      const state = videoFullscreenState(video);
      setFullscreen(state);
      setFullscreenFailed(false);
      if (state.nativeActive) output.useNativeControls();
    };
    const fullscreenEvents = ["loadedmetadata", "loadeddata", "emptied", "webkitbeginfullscreen", "webkitendfullscreen", "webkitpresentationmodechanged"];
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.target !== video) return;
      event.preventDefault();
      actionsRef.current.togglePlayback();
    };
    syncPlayback();
    syncFullscreen();
    for (const event of ["play", "pause", "ended", "emptied"]) video.addEventListener(event, syncPlayback);
    for (const event of fullscreenEvents) video.addEventListener(event, syncFullscreen);
    video.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", syncFullscreen);
    const unbindGestures = bindPlaybackGestures(video,
      () => actionsRef.current.toggleFullscreen());
    return () => {
      unbindGestures();
      output.dispose();
      audioRef.current = null;
      for (const event of ["play", "pause", "ended", "emptied"]) video.removeEventListener(event, syncPlayback);
      for (const event of fullscreenEvents) video.removeEventListener(event, syncFullscreen);
      video.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", syncFullscreen);
    };
  }, [videoRef]);

  useEffect(() => {
    audioRef.current?.bind(stream);
    const track = stream?.getAudioTracks()[0];
    const syncAudio = () => setHasAudio(Boolean(track && track.readyState !== "ended"));
    syncAudio();
    track?.addEventListener("ended", syncAudio);
    return () => track?.removeEventListener("ended", syncAudio);
  }, [stream, audioTrackKey]);

  const silent = audio.muted || audio.level === 0;

  return <PlaybackControlsView controlsRef={controlsRef} visibility={visibility} audio={audio}
    paused={paused} hasAudio={hasAudio && audioAvailable !== false} canPlay={canPlay} theaterMode={theaterMode}
    fullscreen={fullscreen} fullscreenFailed={fullscreenFailed} picture={picture}
    togglePlayback={togglePlayback} toggleFullscreen={toggleFullscreen}
    toggleMute={() => {
      if (audio.level === 0) audioRef.current?.setLevel(1);
      audioRef.current?.setMuted(!silent);
    }} setLevel={level => {
      audioRef.current?.setLevel(level);
      audioRef.current?.setMuted(false);
    }} onToggleTheater={onToggleTheater} onReconnect={onReconnect}
    reconnectAvailable={reconnectAvailable} overlayAction={overlayAction} overlaySettings={overlaySettings} remoteActions={remoteActions} settings={settings} />;
}

// The film shares the rendered controls; the component above alone owns media effects.
export function PlaybackControlsView({
  controlsRef, visibility, audio, paused, hasAudio, canPlay, theaterMode,
  fullscreen, fullscreenFailed, picture, togglePlayback, toggleFullscreen,
  toggleMute, setLevel, onToggleTheater, onReconnect, reconnectAvailable, overlayAction, overlaySettings, remoteActions, settings,
}: {
  controlsRef?: RefObject<HTMLDivElement | null>; visibility?: PlaybackVisibility;
  audio: ViewerAudioSnapshot; paused: boolean; hasAudio: boolean; canPlay: boolean;
  theaterMode: boolean; fullscreen: { supported: boolean; ready: boolean; active: boolean };
  fullscreenFailed?: boolean;
  picture: Pick<ReturnType<typeof usePictureInPicture>, "active" | "supported" | "failed" | "toggle">;
  togglePlayback: () => void; toggleFullscreen: () => void; toggleMute: () => void;
  setLevel: (level: number) => void; onToggleTheater: () => void; onReconnect?: () => void;
  reconnectAvailable?: boolean; overlayAction?: ReactNode; overlaySettings?: ReactNode; remoteActions?: ReactNode;
  settings?: ViewerPlaybackSettingsProps;
}) {
  const { t, vis } = useCopy();
  const controlsId = useId();
  const localControlsRef = useRef<HTMLDivElement>(null);
  const barRef = controlsRef ?? localControlsRef;
  const [chin, setChin] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setChin(barRef.current?.closest(".lr-tv")?.querySelector<HTMLElement>(".lr-tv-chin") ?? null);
  }, [barRef]);
  const silent = audio.muted || audio.level === 0;
  const percent = Math.round(audio.level * 100);
  const pipTitle = picture.failed ? "playback.pipFailed" : !picture.supported ? "playback.pipUnavailable"
    : picture.active ? "playback.exitPip" : !canPlay ? "playback.pipWaiting" : "playback.pip";
  const theaterTitle = theaterMode ? "viewer.theater.exit" : "viewer.theater";
  const nextFit = settings?.pictureFit === "contain" ? "cover" : settings?.pictureFit === "cover" ? "fill" : "contain";
  const displayActions = <>
    <Btn icon={picture.active ? "pipExit" : "pip"} draw="playback-pip" title={pipTitle}
      hintTone={picture.failed ? "bad" : undefined}
      hint={!picture.supported || picture.failed || (!picture.active && !canPlay) ? "hint-pip-unavailable" : picture.active ? "hint-pip-exit" : "hint-pip"}
      pressed={picture.active} disabled={!picture.supported || (!picture.active && !canPlay)}
      onClick={() => { void picture.toggle(); }} />
    {!fullscreen.active && <Btn icon={theaterMode ? "theaterExit" : "theater"} draw="playback-theater" title={theaterTitle}
      hint={theaterMode ? "hint-theater-exit" : "hint-theater"}
      pressed={theaterMode} onClick={onToggleTheater} />}
  </>;
  const reveal = <button type="button" className="lr-playback-reveal" aria-label={t("playback.showControls")}
    aria-controls={controlsId} aria-expanded={!visibility?.hidden}
    onClick={() => barRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true })}>
    <Glyph name="chevron" size={18} className="lr-playback-reveal-arrow" />
  </button>;

  return <>
    <div id={controlsId} ref={barRef} className={`lr-playback lr-host-share-controls lr-media-controls${visibility?.hidden ? " is-hidden" : ""}`}
      role="group" aria-label={t("playback.controls")}>
      <div className="lr-playback-main">
        <span className="lr-playback-watch">
          <Btn icon={paused ? "play" : "pause"}
            draw="playback-state"
            title={paused ? "playback.play" : "playback.pause"}
            hint={paused ? "hint-local-play" : "hint-local-pause"}
            disabled={!canPlay} onClick={togglePlayback} />
          <Btn icon={!hasAudio || silent ? "speakerOff" : "speaker"}
            draw="playback-sound"
            title={!hasAudio ? "playback.noAudio" : silent ? "playback.unmute" : "playback.mute"}
            hint={!hasAudio ? "hint-no-audio" : silent ? "hint-unmute" : "hint-mute"} disabled={!hasAudio}
            onClick={toggleMute} />
          <Tooltip kind={!hasAudio ? "hint-no-audio" : audio.boostAvailable ? "hint-volume" : "hint-volume-basic"}
            text={vis ? undefined : t(!hasAudio ? "playback.noAudio" : audio.boostAvailable ? "playback.volume" : "playback.volumeBasic")}
            className="lr-playback-volume">
            <input type="range" min={0} max={audio.boostAvailable ? 200 : 100} step={1}
              value={hasAudio ? percent : 0} disabled={!hasAudio}
              aria-label={t(audio.boostAvailable ? "playback.volume" : "playback.volumeBasic")}
              aria-valuetext={hasAudio ? `${percent}%` : t("playback.noAudio")}
              onChange={(event) => setLevel(Number(event.target.value) / 100)} />
          </Tooltip>
          <span className={`lr-playback-level${hasAudio && percent > 100 ? " is-boosted" : ""}`} aria-hidden="true">
            {hasAudio ? `${percent}%` : null}
          </span>
        </span>
        {remoteActions}
        <span className="lr-playback-view" role="group" aria-label={t("playback.viewControls")}>
          {overlayAction}
          {settings && <>
            <span className="lr-playback-fit"><Btn
              icon={settings.pictureFit === "contain" ? "fitContain" : settings.pictureFit === "cover" ? "fitCover" : "fitStretch"}
              title="playback.changeFit" hint={`hint-fit-${settings.pictureFit}`} hintText="playback.fitCycle"
              hintVars={{ current: t(`playback.fit.${settings.pictureFit}`), next: t(`playback.fit.${nextFit}`) }}
              onClick={() => settings.setPictureFit(nextFit)} /></span>
            <Btn icon="rotatePicture" title="playback.rotation" hint="hint-picture-rotation" hintText="playback.rotationHint"
              pressed={settings.pictureRotation !== 0}
              onClick={() => settings.setPictureRotation(settings.pictureRotation === 0 ? 90 : 0)} />
          </>}
          <PlaybackMore anchor={barRef} settings={settings} overlaySettings={overlaySettings}
            onReconnect={onReconnect} reconnectAvailable={reconnectAvailable} />
        </span>
      </div>
      <span className="lr-playback-window" role="group" aria-label={t("playback.windowControls")}>
        {displayActions}
        {fullscreen.supported && !theaterMode ? (
          <Btn icon={fullscreen.active ? "contract" : "expand"}
            draw="playback-fullscreen"
            title={fullscreenFailed ? "playback.fullscreenFailed" : fullscreen.active ? "playback.exitFullscreen"
              : !fullscreen.ready ? "playback.fullscreenWaiting" : "playback.fullscreen"}
            hint={fullscreenFailed || (!fullscreen.active && !fullscreen.ready) ? "hint-fullscreen-unavailable"
              : fullscreen.active ? "hint-fullscreen-exit" : "hint-fullscreen"}
            hintTone={fullscreenFailed ? "bad" : !fullscreen.ready ? "warn" : undefined}
            disabled={!fullscreen.active && !fullscreen.ready}
            pressed={fullscreen.active}
            onClick={toggleFullscreen} />
        ) : null}
      </span>
    </div>
    {chin && !theaterMode && !fullscreen.active ? createPortal(reveal, chin) : reveal}
  </>;
}

// Only detailed preferences belong here; direct playback actions stay outside.
function PlaybackMore({ anchor, settings, overlaySettings, onReconnect, reconnectAvailable }: {
  anchor: RefObject<HTMLDivElement | null>; settings?: ViewerPlaybackSettingsProps; overlaySettings?: ReactNode;
  onReconnect?: () => void; reconnectAvailable?: boolean;
}) {
  const { t } = useCopy();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const available = Boolean(overlaySettings || settings?.route || settings?.relayVolunteer || onReconnect);
  useAnchoredPopover(anchor, panel, { align: "center", minVisibleHeight: 160, enabled: available });
  const reconnect = onReconnect ? <Btn icon="refresh" title="viewer.reconnect" size="dense" hint="hint-reconnect" draw="playback-reconnect"
    cap="viewer.reconnect" disabled={!reconnectAvailable} onClick={() => {
      panel.current?.hidePopover();
      onReconnect();
    }} /> : null;
  if (!available) return null;
  return <span className="lr-playback-more">
    <Btn icon="sliders" title="playback.more" hint="hint-advanced" popoverTarget={id} expanded={open} controls={id} />
    <div id={id} ref={panel} className="lr-floating-surface lr-playback-menu lr-playback-settings" popover="auto" aria-label={t("playback.more")}
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      <ViewerPlaybackSettings {...settings} overlaySettings={overlaySettings} reconnect={reconnect} />
    </div>
  </span>;
}
