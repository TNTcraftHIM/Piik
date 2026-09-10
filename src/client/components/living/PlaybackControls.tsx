import { useEffect, useRef, useState, type RefObject } from "react";
import { ViewerAudio, type ViewerAudioSnapshot } from "../../media/viewer-audio";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import { Tooltip } from "./Tooltip";
import { usePlaybackControlsVisibility } from "./use-playback-controls-visibility";
import { leavePictureInPicture, usePictureInPicture } from "./use-picture-in-picture";
import "./playback-controls.css";

type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

// Reflect the existing media element; binding, autoplay recovery and room
// presentation retain their existing owners.
export function PlaybackControls({
  videoRef, stream, audioTrackKey, canPlay, theaterMode, onPlay,
  onToggleTheater, onReconnect, reconnectAvailable,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  audioTrackKey?: string;
  canPlay: boolean;
  theaterMode: boolean;
  onPlay: () => void;
  onToggleTheater: () => void;
  onReconnect: () => void;
  reconnectAvailable: boolean;
}) {
  const { t, vis } = useCopy();
  const audioRef = useRef<ViewerAudio | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [audio, setAudio] = useState<ViewerAudioSnapshot>({
    level: 1, muted: false, boostAvailable: true,
  });
  const [paused, setPaused] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const hidden = usePlaybackControlsVisibility(videoRef, controlsRef, paused || !canPlay);
  const picture = usePictureInPicture(videoRef);

  const togglePlayback = () => {
    if (!canPlay) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      audioRef.current?.resume();
      onPlay();
    } else {
      video.pause();
    }
  };
  const togglePlaybackRef = useRef(togglePlayback);
  togglePlaybackRef.current = togglePlayback;

  useEffect(() => {
    const video = videoRef.current as FullscreenVideo | null;
    if (!video) return;
    const output = new ViewerAudio(video, setAudio);
    audioRef.current = output;
    const syncPlayback = () => setPaused(video.paused);
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === video.parentElement);
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.target !== video) return;
      event.preventDefault();
      togglePlaybackRef.current();
    };
    syncPlayback();
    syncFullscreen();
    setCanFullscreen(Boolean(document.fullscreenEnabled || video.webkitEnterFullscreen));
    for (const event of ["play", "pause", "ended", "emptied"]) video.addEventListener(event, syncPlayback);
    video.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      output.dispose();
      audioRef.current = null;
      for (const event of ["play", "pause", "ended", "emptied"]) video.removeEventListener(event, syncPlayback);
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

  const toggleFullscreen = () => {
    const video = videoRef.current as FullscreenVideo | null;
    if (fullscreen) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (document.fullscreenEnabled && video?.parentElement) {
      void video.parentElement.requestFullscreen()
        .then(() => leavePictureInPicture(video))
        .catch(() => undefined);
    } else {
      audioRef.current?.useNativeControls();
      video?.webkitEnterFullscreen?.();
    }
  };
  const silent = audio.muted || audio.level === 0;
  const percent = Math.round(audio.level * 100);

  return (
    <div ref={controlsRef} className={`lr-playback${hidden ? " is-hidden" : ""}`} role="group" aria-label={t("playback.controls")}>
      <span className="lr-playback-audio">
        <Btn icon={paused ? "play" : "pause"}
          draw="playback-state"
          title={paused ? "playback.play" : "playback.pause"}
          hint={paused ? "hint-local-play" : "hint-local-pause"}
          disabled={!canPlay} onClick={togglePlayback} />
        <span className="lr-playback-separator" aria-hidden="true" />
        <Btn icon={!hasAudio || silent ? "speakerOff" : "speaker"}
          draw="playback-sound"
          title={!hasAudio ? "playback.noAudio" : silent ? "playback.unmute" : "playback.mute"}
          hint={!hasAudio ? "hint-no-audio" : silent ? "hint-unmute" : "hint-mute"} disabled={!hasAudio}
          onClick={() => {
            if (audio.level === 0) audioRef.current?.setLevel(1);
            audioRef.current?.setMuted(!silent);
          }} />
        <Tooltip kind={!hasAudio ? "hint-no-audio" : audio.boostAvailable ? "hint-volume" : "hint-volume-basic"}
          text={vis ? undefined : t(!hasAudio ? "playback.noAudio" : audio.boostAvailable ? "playback.volume" : "playback.volumeBasic")}
          className="lr-playback-volume">
          <input type="range" min={0} max={audio.boostAvailable ? 200 : 100} step={1}
            value={percent} disabled={!hasAudio}
            aria-label={t(audio.boostAvailable ? "playback.volume" : "playback.volumeBasic")} aria-valuetext={`${percent}%`}
            onChange={(event) => {
              audioRef.current?.setLevel(Number(event.target.value) / 100);
              audioRef.current?.setMuted(false);
            }} />
        </Tooltip>
        <span className={`lr-playback-level${percent > 100 ? " is-boosted" : ""}`} aria-hidden="true">
          {hasAudio ? `${percent}%` : "—"}
        </span>
      </span>
      <span className="lr-playback-view">
        <Btn icon="refresh" title="viewer.reconnect" hint="hint-reconnect" draw="playback-reconnect"
          disabled={!reconnectAvailable} onClick={onReconnect} />
        <Btn icon={picture.active ? "pipExit" : "pip"} draw="playback-pip"
          hintTone={picture.failed ? "bad" : undefined}
          title={picture.failed ? "playback.pipFailed" : !picture.supported ? "playback.pipUnavailable"
            : picture.active ? "playback.exitPip" : !canPlay ? "playback.pipWaiting" : "playback.pip"}
          hint={!picture.supported || picture.failed ? "hint-pip-unavailable" : picture.active ? "hint-pip-exit" : "hint-pip"}
          pressed={picture.active} disabled={!picture.supported || (!picture.active && !canPlay)}
          onClick={() => { void picture.toggle(); }} />
        {!fullscreen ? <Btn icon={theaterMode ? "theaterExit" : "theater"}
          draw="playback-theater"
          title={theaterMode ? "viewer.theater.exit" : "viewer.theater"}
          hint={theaterMode ? "hint-theater-exit" : "hint-theater"}
          pressed={theaterMode} onClick={onToggleTheater} /> : null}
        {canFullscreen && !theaterMode ? (
          <Btn icon={fullscreen ? "contract" : "expand"}
            draw="playback-fullscreen"
            title={fullscreen ? "playback.exitFullscreen" : "playback.fullscreen"}
            hint={fullscreen ? "hint-fullscreen-exit" : "hint-fullscreen"}
            onClick={toggleFullscreen} />
        ) : null}
      </span>
    </div>
  );
}
