import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Btn } from "../../components/living/primitives";
import { Tooltip } from "../../components/living/Tooltip";
import { usePlaybackControlsVisibility } from "../../components/living/use-playback-controls-visibility";
import { toggleVideoFullscreen, videoFullscreenState } from "../../components/living/video-fullscreen";
import { ViewerAudio, type ViewerAudioSnapshot } from "../../media/viewer-audio";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import "./channel-media.css";

/** Literal prototype copy, shared production geometry and guidance. */
export function ChannelAction({ icon, label, onClick, disabled, busy, pressed, danger, primary, hint, iconOnly = false, quiet = false, type = "button" }: {
  icon: GlyphName; label: string; onClick?: () => void; disabled?: boolean;
  busy?: boolean; pressed?: boolean; danger?: boolean; primary?: boolean;
  iconOnly?: boolean; quiet?: boolean;
  hint?: ComponentProps<typeof Tooltip>["kind"]; type?: "button" | "submit";
}) {
  const { vis } = useCopy();
  const button = <button type={type} onClick={event => { onClick?.(); if (event.detail !== 0) event.currentTarget.blur(); }} disabled={disabled || busy}
    aria-label={label} aria-pressed={pressed} aria-busy={busy || undefined}
    className={`lr-btn is-compact${quiet ? " is-quiet" : ""}${danger ? " is-danger" : primary ? " is-primary" : pressed ? " is-on" : ""}`}>
    <Glyph name={busy ? "loader" : icon} size={19} className={busy ? "lr-spin" : undefined} />
    {!vis && !iconOnly && <span className="lr-cap">{label}</span>}
  </button>;
  return hint ? <Tooltip kind={hint} text={vis ? undefined : label}>{button}</Tooltip> : button;
}

export function ChannelVideo({ stream, local, label }: { stream: MediaStream; local: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const output = useRef<ViewerAudio | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [audio, setAudio] = useState<ViewerAudioSnapshot>({ level: 1, muted: false, boostAvailable: true });
  const [fullscreen, setFullscreen] = useState({ supported: false, ready: false, active: false });
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const { lang, t } = useCopy();
  const visibility = usePlaybackControlsVisibility(ref, controls, paused || blocked || !ready);
  const play = () => {
    const element = ref.current;
    if (!element) return;
    output.current?.resume();
    void element.play().then(() => setBlocked(false)).catch(error => {
      if (ref.current === element && element.srcObject === stream && error?.name !== "AbortError") setBlocked(true);
    });
  };
  const fullscreenToggle = () => {
    const element = ref.current;
    if (!element) return;
    setFullscreenFailed(false);
    void toggleVideoFullscreen(element).catch(() => {
      if (ref.current === element) setFullscreenFailed(true);
    });
  };
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    element.muted = local || audio.muted;
    const listening = local ? null : new ViewerAudio(element, setAudio, undefined, 1);
    output.current = listening;
    const syncAudio = () => {
      setHasAudio(stream.getAudioTracks().some(track => track.readyState === "live"));
      listening?.bind(stream);
    };
    syncAudio();
    stream.addEventListener("addtrack", syncAudio);
    stream.addEventListener("removetrack", syncAudio);
    let current = true;
    setBlocked(false);
    setReady(false);
    void element.play().catch(error => { if (current && error?.name !== "AbortError") setBlocked(true); });
    return () => {
      current = false;
      stream.removeEventListener("addtrack", syncAudio);
      stream.removeEventListener("removetrack", syncAudio);
      output.current = null;
      listening?.dispose();
      element.pause();
      element.srcObject = null;
    };
  }, [stream, local]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const sync = () => {
      const state = videoFullscreenState(element);
      setFullscreen(state);
      setFullscreenFailed(false);
      if (state.nativeActive) output.current?.useNativeControls();
    };
    const events = ["loadedmetadata", "webkitbeginfullscreen", "webkitendfullscreen", "webkitpresentationmodechanged"];
    sync();
    document.addEventListener("fullscreenchange", sync);
    for (const event of events) element.addEventListener(event, sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      for (const event of events) element.removeEventListener(event, sync);
    };
  }, []);
  return <div className="c3-video c3-mini-player" data-controls-hidden={visibility.hidden}>
    <video ref={ref} playsInline muted={local} aria-label={label} tabIndex={0}
      onLoadedData={() => setReady(true)} onPlay={() => { setPaused(false); setBlocked(false); }}
      onPause={() => setPaused(true)} onEnded={() => setPaused(true)} onDoubleClick={fullscreenToggle}
      onKeyDown={event => { if (event.code === "Space") { event.preventDefault(); if (event.currentTarget.paused) play(); else event.currentTarget.pause(); } }} />
    {!ready && !blocked && <div className="c3-mini-message" role="status">
      <span className="c3-frame-wait"><Glyph name="loader" className="lr-spin" size={22} />
        {lang === "zh" ? "等待画面" : "Waiting for picture"}</span>
    </div>}
    {blocked && <div className="c3-mini-message"><Btn icon="play" title="playback.play" cap="playback.play"
      onClick={play} hint="hint-local-play" /></div>}
    <div ref={controls} className="c3-mini-controls" role="group" aria-label={lang === "zh" ? "本机播放" : "Local playback"}>
      <Btn icon={paused ? "play" : "pause"} title={paused ? "playback.play" : "playback.pause"} size="dense" quiet
        hint={paused ? "hint-local-play" : "hint-local-pause"} onClick={() => { if (ref.current?.paused) play(); else ref.current?.pause(); }} />
      {!local && <>
        <Btn icon={audio.muted || audio.level === 0 ? "speakerOff" : "speaker"} size="dense" quiet
          title={!hasAudio ? "playback.noAudio" : audio.muted ? "playback.unmute" : "playback.mute"}
          hint={!hasAudio ? "hint-no-audio" : audio.muted ? "hint-unmute" : "hint-mute"}
          disabled={!hasAudio} pressed={audio.muted} onClick={() => output.current?.setMuted(!audio.muted)} />
        <input className="c3-mini-volume" type="range" min="0" max="1" step="0.05" value={audio.level}
          disabled={!hasAudio} aria-label={t("playback.volumeBasic")} aria-valuetext={`${Math.round(audio.level * 100)}%`}
          onChange={event => output.current?.setLevel(Number(event.currentTarget.value))} />
      </>}
      <span className="c3-mini-space" />
      <Btn icon={fullscreen.active ? "contract" : "expand"} size="dense" quiet
        title={fullscreenFailed ? "playback.fullscreenFailed" : fullscreen.active ? "playback.exitFullscreen" : "playback.fullscreen"}
        hint={fullscreenFailed || !fullscreen.ready ? "hint-fullscreen-unavailable" : fullscreen.active ? "hint-fullscreen-exit" : "hint-fullscreen"}
        disabled={!fullscreen.ready && !fullscreen.active} onClick={fullscreenToggle} />
    </div>
  </div>;
}

export function ChannelAudio({ stream, muted, label }: { stream: MediaStream; muted: boolean; label: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const { lang } = useCopy();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    let current = true;
    setBlocked(false);
    void element.play().catch(error => { if (current && error?.name !== "AbortError") setBlocked(true); });
    return () => { current = false; element.pause(); element.srcObject = null; };
  }, [stream]);
  return <><audio ref={ref} muted={muted} aria-label={label} onPlay={() => setBlocked(false)} />
    {blocked && <ChannelAction icon="speaker" label={lang === "zh" ? `播放 ${label}` : `Play ${label}`}
      onClick={() => { void ref.current?.play().then(() => setBlocked(false)).catch(() => {}); }} />}</>;
}
