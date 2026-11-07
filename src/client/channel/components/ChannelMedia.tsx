import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Btn } from "../../components/living/primitives";
import { PlaybackControlsReveal } from "../../components/living/PlaybackControlsReveal";
import { PlaybackWindowControls } from "../../components/living/PlaybackWindowControls";
import { PlaybackSettings } from "../../components/living/PlaybackSettings";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useVideoRotation } from "../../components/living/use-video-rotation";
import { usePlaybackControlsVisibility } from "../../components/living/use-playback-controls-visibility";
import { useHostPreviewPlayback } from "../../components/living/use-host-preview-playback";
import { usePictureInPicture } from "../../components/living/use-picture-in-picture";
import { toggleVideoFullscreen, videoFullscreenState } from "../../components/living/video-fullscreen";
import { ViewerAudio, type ViewerAudioSnapshot } from "../../media/viewer-audio";
import { observeCompositedVideoFrame } from "../../media/video-frame-proof";
import { playbackFailure } from "../../media/viewer-playback";
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import type { VideoFit, VideoRotation } from "../../media/video-geometry";
import type { ChannelScreenInput, ScreenPresentation } from "../types";
import { Glyph } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { RemoteControl } from "../../components/living/RemoteControl";
import type { InputTransport } from "../../remote-control/input-route";
import { ChannelAction } from "./ChannelAction";
import "./channel-media.css";

function ChannelVideoInput({ input, visible, label, fit, register, frame, issue, playing, fullscreen }: {
  input: ChannelScreenInput; visible: boolean; label: string; fit: VideoFit;
  register(input: ChannelScreenInput, element: HTMLVideoElement | null): void;
  frame(input: ChannelScreenInput, element: HTMLVideoElement): void;
  issue(input: ChannelScreenInput, element: HTMLVideoElement, error: unknown): void;
  playing(input: ChannelScreenInput, paused: boolean): void;
  fullscreen(): void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [composited, setComposited] = useState(false);
  const attach = useCallback((element: HTMLVideoElement | null) => {
    ref.current = element; register(input, element);
  }, [input.flowId, input.stream, register]);
  useLayoutEffect(() => {
    const element = ref.current!;
    element.muted = true;
    element.srcObject = input.stream;
    setComposited(false);
    const stop = observeCompositedVideoFrame(element, input.stream, () => {
      setComposited(true); frame(input, element);
    });
    let active = true;
    void element.play().catch(error => { if (active) issue(input, element, error); });
    return () => { active = false; stop(); element.muted = true; element.pause(); element.srcObject = null; };
  }, [input.flowId, input.stream, frame, issue]);
  return <video ref={attach} playsInline muted style={{ objectFit: fit }} aria-label={visible ? label : undefined} aria-hidden={!visible}
    data-flow-id={input.flowId} data-selected={visible} data-composited={composited} data-switch-ready={input.switchReady}
    tabIndex={visible ? 0 : -1} onPlay={() => playing(input, false)} onPause={() => playing(input, true)}
    onEnded={() => playing(input, true)} onError={event => issue(input, event.currentTarget, event.currentTarget.error)}
    onDoubleClick={visible ? fullscreen : undefined} onKeyDown={event => {
      if (visible && event.code === "Space") {
        event.preventDefault();
        const element = event.currentTarget;
        if (element.paused) void element.play().catch(error => issue(input, element, error));
        else element.pause();
      }
    }} />;
}

export interface SourceAudioControl {
  level: number; muted: boolean; hasAudio: boolean; available: boolean; busy: boolean;
  onChange(settings: { level?: number; muted?: boolean }): void;
}

export function ChannelVideo({ stream, local, label, inputs, onPresentation, input, sourceAudio, theaterMode, onToggleTheater }: {
  stream: MediaStream; local: boolean; label: string; inputs?: readonly ChannelScreenInput[];
  input?: InputTransport;
  sourceAudio?: SourceAudioControl;
  theaterMode: boolean; onToggleTheater(): void;
  onPresentation?: (flowId: string, stream: MediaStream, state: ScreenPresentation) => void;
}) {
  const target = inputs?.find(input => input.selected) ?? { flowId: stream.id, stream, selected: true, switchReady: false };
  const [displayed, setDisplayed] = useState(target);
  const next = target.flowId !== displayed.flowId || target.stream !== displayed.stream ? target : inputs?.find(input => !input.selected);
  const rendered = next ? [displayed, next] : [displayed];
  const consumers = useRef(new Map<MediaStream, { element: HTMLVideoElement; composited: boolean }>());
  const [consumerVersion, changeConsumer] = useState(0);
  const [activeVideo, setActiveVideo] = useState<HTMLVideoElement | null>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const controlsId = useId();
  const pictureId = useId();
  const pictureTrigger = useRef<HTMLSpanElement>(null), picturePanel = useRef<HTMLDivElement>(null);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [pictureFit, setPictureFit] = useState(() => readRoomPreferences().pictureFit);
  const [pictureRotation, setPictureRotation] = useState(() => readRoomPreferences().pictureRotation);
  const [previewAutoPause, setPreviewAutoPause] = useState(() => readRoomPreferences().previewAutoPause);
  const [remoteTouchMode, setRemoteTouchMode] = useState(() => readRoomPreferences().remoteTouchMode);
  const output = useRef<ViewerAudio | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [streamHasAudio, setStreamHasAudio] = useState(false);
  const [audio, setAudio] = useState<ViewerAudioSnapshot>({ level: 1, muted: false, boostAvailable: true });
  const [fullscreen, setFullscreen] = useState({ supported: false, ready: false, active: false, nativeActive: false });
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const nativeRequested = useRef(false);
  const current = useRef({ displayed, inputs, onPresentation });
  current.current = { displayed, inputs, onPresentation };
  const { lang, t } = useCopy();
  const sound = local && sourceAudio ? sourceAudio : audio;
  const hasAudio = local ? !!sourceAudio?.hasAudio : streamHasAudio;
  const silent = sound.muted || sound.level === 0;
  const soundAvailable = hasAudio && (!local || !!sourceAudio?.available);
  const soundDisabled = !soundAvailable || local && !!sourceAudio?.busy;
  const volumeTitle = !hasAudio ? "playback.noAudio" : local
    ? !sourceAudio?.available ? "host.shareVolume.unavailable" : "host.shareVolume"
    : audio.boostAvailable ? "playback.volume" : "playback.volumeBasic";
  const playbackRef = useMemo(() => ({ current: activeVideo }), [activeVideo]);
  const picture = usePictureInPicture(playbackRef);
  useHostPreviewPlayback(playbackRef, local ? displayed.stream : null, previewAutoPause);
  useVideoRotation(playbackRef, pictureFit, pictureRotation);
  useAnchoredPopover(pictureTrigger, picturePanel, { side: "above", align: "center" });
  const visibility = usePlaybackControlsVisibility(playbackRef, controls, paused || blocked || !ready);
  const register = useCallback((input: ChannelScreenInput, element: HTMLVideoElement | null) => {
    if (element) consumers.current.set(input.stream, { element, composited: false });
    else consumers.current.delete(input.stream);
  }, []);
  const frame = useCallback((input: ChannelScreenInput, element: HTMLVideoElement) => {
    const consumer = consumers.current.get(input.stream);
    if (consumer?.element !== element) return;
    consumer.composited = true;
    changeConsumer(value => value + 1);
  }, []);
  const issue = useCallback((input: ChannelScreenInput, element: HTMLVideoElement, error: unknown) => {
    const failure = playbackFailure(error);
    if (!failure || consumers.current.get(input.stream)?.element !== element) return;
    const state = current.current;
    if (state.displayed.flowId === input.flowId && state.displayed.stream === input.stream) setBlocked(true);
    if (failure === "playback-failed" && state.inputs?.some(value => value.flowId === input.flowId && value.stream === input.stream)) {
      state.onPresentation?.(input.flowId, input.stream, "failed");
    }
  }, []);
  const playing = useCallback((input: ChannelScreenInput, value: boolean) => {
    if (current.current.displayed.flowId !== input.flowId || current.current.displayed.stream !== input.stream) return;
    setPaused(value); if (!value) setBlocked(false);
  }, []);
  const play = () => {
    const element = ref.current;
    if (!element) return;
    const displayed = current.current.displayed;
    output.current?.resume();
    void element.play().then(() => {
      if (ref.current === element && consumers.current.get(displayed.stream)?.element === element) setBlocked(false);
    }).catch(error => issue(displayed, element, error));
  };
  const fullscreenToggle = () => {
    const element = ref.current;
    if (!element) return;
    const state = videoFullscreenState(element);
    if (!state.active && !state.ready) return;
    const container = Boolean(document.fullscreenEnabled && element.parentElement?.requestFullscreen);
    const candidate = inputs?.find(input => !input.selected);
    if (!state.active && !container) {
      if (candidate?.switchReady) return;
      nativeRequested.current = true;
      if (candidate) onPresentation?.(candidate.flowId, candidate.stream, "waiting");
    }
    setFullscreenFailed(false);
    void toggleVideoFullscreen(element).catch(() => {
      nativeRequested.current = false;
      if (ref.current === element) { setFullscreenFailed(true); changeConsumer(value => value + 1); }
    });
  };
  const pictureToggle = async () => {
    const candidate = inputs?.find(input => !input.selected);
    if (!picture.active) {
      if (candidate?.switchReady) return;
      nativeRequested.current = true;
      if (candidate) onPresentation?.(candidate.flowId, candidate.stream, "waiting");
    }
    try { await picture.toggle(); }
    finally { nativeRequested.current = false; changeConsumer(value => value + 1); }
  };
  useLayoutEffect(() => {
    const binding = consumers.current.get(target.stream);
    if (!binding) return;
    const swapping = target.flowId !== displayed.flowId || target.stream !== displayed.stream;
    if (swapping && !binding.composited) return;
    if (ref.current !== binding.element) {
      const previous = ref.current, listening = output.current;
      const saved = listening?.snapshot ?? audio;
      const keepPaused = previous?.paused ?? false;
      listening?.setMuted(true);
      if (previous) previous.muted = true;
      const element = binding.element;
      if (keepPaused && !local) element.pause();
      element.volume = Math.min(saved.level, 1); element.muted = true;
      const nextAudio = local ? null : new ViewerAudio(element, setAudio);
      nextAudio?.bind(target.stream); nextAudio?.setLevel(saved.level); nextAudio?.setMuted(saved.muted);
      output.current = nextAudio; ref.current = element;
      setActiveVideo(element); setPaused(local ? element.paused : keepPaused); setBlocked(false);
      listening?.dispose(); previous?.pause();
    }
    setReady(binding.composited);
    if (swapping) setDisplayed(target);
  }, [target.flowId, target.stream, displayed.flowId, displayed.stream, consumerVersion, local]);
  useEffect(() => {
    if (!activeVideo) return;
    const selectedStream = displayed.stream;
    const syncAudio = () => {
      if (ref.current !== activeVideo) return;
      setStreamHasAudio(selectedStream.getAudioTracks().some(track => track.readyState === "live"));
      output.current?.bind(selectedStream);
    };
    syncAudio();
    selectedStream.addEventListener("addtrack", syncAudio);
    selectedStream.addEventListener("removetrack", syncAudio);
    return () => {
      selectedStream.removeEventListener("addtrack", syncAudio);
      selectedStream.removeEventListener("removetrack", syncAudio);
    };
  }, [activeVideo, displayed.stream]);
  useEffect(() => () => { output.current?.dispose(); output.current = null; ref.current = null; }, []);
  useEffect(() => {
    const element = activeVideo;
    if (!element) return;
    const sync = (event?: Event) => {
      const state = videoFullscreenState(element);
      if (state.nativeActive || event?.type.startsWith("webkit")) nativeRequested.current = false;
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
  }, [activeVideo]);
  useLayoutEffect(() => {
    for (const input of inputs ?? []) if (!input.selected && !input.switchReady) {
      const consumer = consumers.current.get(input.stream);
      if (!consumer) continue;
      const state = nativeRequested.current || fullscreen.nativeActive || picture.active ? "waiting" : consumer.composited ? "prepared" : "waiting";
      onPresentation?.(input.flowId, input.stream, state);
    }
  }, [inputs, onPresentation, consumerVersion, fullscreen.nativeActive, picture.active]);
  const nativeEntryBlocked = inputs?.some(input => !input.selected && input.switchReady)
    && !fullscreen.active && !(document.fullscreenEnabled && activeVideo?.parentElement?.requestFullscreen);
  return <div className="c3-video c3-mini-player" data-controls-hidden={visibility.hidden}>
    {rendered.map(input => <ChannelVideoInput key={`${input.flowId}:${input.stream.id}`} input={input} visible={input.flowId === displayed.flowId && input.stream === displayed.stream}
      label={label} fit={pictureFit} register={register} frame={frame} issue={issue} playing={playing} fullscreen={fullscreenToggle} />)}
    {!ready && !blocked && <div className="c3-mini-message" role="status">
      <span className="c3-frame-wait"><Glyph name="loader" className="lr-spin" size={22} />
        {lang === "zh" ? "等待画面" : "Waiting for picture"}</span>
    </div>}
    {blocked && <div className="c3-mini-message"><Btn icon="play" title="playback.play" cap="playback.play"
      onClick={play} hint="hint-local-play" /></div>}
    <div id={controlsId} ref={controls} className="c3-mini-controls lr-media-toolbar lr-media-controls" role="group" aria-label={t("playback.controls")}>
      <Btn icon={paused ? "play" : "pause"} title={paused ? "playback.play" : "playback.pause"} quiet
        hint={paused ? "hint-local-play" : "hint-local-pause"} onClick={() => { if (ref.current?.paused) play(); else ref.current?.pause(); }} />
      {(!local || sourceAudio) && <>
        <Btn icon={!hasAudio || silent ? "speakerOff" : "speaker"} quiet
          title={!hasAudio ? "playback.noAudio" : local
            ? !sourceAudio?.available ? "host.shareVolume.unavailable" : silent ? "host.shareVolume.unmute" : "host.shareVolume.mute"
            : silent ? "playback.unmute" : "playback.mute"}
          hint={!hasAudio ? "hint-no-audio" : silent ? "hint-unmute" : "hint-mute"}
          disabled={soundDisabled} pressed={silent}
          onClick={() => {
            if (local) sourceAudio?.onChange({ level: sound.level || 1, muted: !silent });
            else {
              if (sound.level === 0) output.current?.setLevel(1);
              output.current?.setMuted(!silent);
            }
          }} />
        <input className="c3-mini-volume" type="range" min="0" max={local || audio.boostAvailable ? 2 : 1} step="0.05" value={hasAudio ? sound.level : 0}
          disabled={soundDisabled} aria-label={t(volumeTitle)} aria-valuetext={hasAudio ? `${Math.round(sound.level * 100)}%` : t("playback.noAudio")}
          onChange={event => {
            const level = Number(event.currentTarget.value);
            if (local) sourceAudio?.onChange({ level, muted: false });
            else { output.current?.setLevel(level); output.current?.setMuted(false); }
          }} />
      </>}
      <span className="c3-mini-space" />
      {!local && <RemoteControl channel={input ?? null} videoRef={playbackRef} available={ready && displayed.flowId === target.flowId}
        pictureFit={pictureFit} pictureRotation={pictureRotation} touchMode={remoteTouchMode} />}
      <span ref={pictureTrigger} className="lr-playback-more"><Btn icon="sliders" quiet title="playback.more" hint="hint-advanced"
        popoverTarget={pictureId} controls={pictureId} expanded={pictureOpen} /></span>
      <div ref={picturePanel} id={pictureId} popover="auto" role="dialog" aria-label={t("playback.more")}
        className="lr-floating-surface lr-playback-menu lr-playback-settings" onToggle={event => {
          if (event.target === event.currentTarget) setPictureOpen(event.newState === "open");
        }}>
        <PlaybackSettings picture={{ pictureFit, pictureRotation,
          setPictureFit: (fit: VideoFit) => { setPictureFit(fit); saveRoomPreferences({ pictureFit: fit }); },
          setPictureRotation: (rotation: VideoRotation) => { setPictureRotation(rotation); saveRoomPreferences({ pictureRotation: rotation }); },
        }} preview={local ? { autoPause: previewAutoPause, onChange: autoPause => {
          setPreviewAutoPause(autoPause); saveRoomPreferences({ previewAutoPause: autoPause });
        } } : undefined} remoteTouch={!local && input ? { mode: remoteTouchMode, onChange: mode => {
          setRemoteTouchMode(mode); saveRoomPreferences({ remoteTouchMode: mode });
        } } : undefined} reconnect={null} />
      </div>
      <PlaybackWindowControls picture={{ ...picture, toggle: pictureToggle }} quiet
        canPlay={ready && !inputs?.some(input => !input.selected && input.switchReady)}
        theaterMode={theaterMode} onToggleTheater={onToggleTheater}
        fullscreen={{ ...fullscreen, ready: fullscreen.ready && !nativeEntryBlocked }} fullscreenFailed={fullscreenFailed}
        toggleFullscreen={fullscreenToggle} />
    </div>
    <PlaybackControlsReveal controls={controls} controlsId={controlsId} hidden={visibility.hidden} />
  </div>;
}

export function ChannelAudio({ stream, muted, volume, createContext, label }: {
  stream: MediaStream; muted: boolean; volume: number; createContext(): AudioContext; label: string;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const output = useRef<ViewerAudio | null>(null);
  const [blocked, setBlocked] = useState(false);
  const { lang } = useCopy();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    // Room and person levels each range from 0 to 2, as in the shared voice sink.
    const playback = output.current = new ViewerAudio(element, () => {}, createContext, 4);
    playback.bind(stream);
    let current = true;
    setBlocked(false);
    void element.play().catch(error => { if (current && error?.name !== "AbortError") setBlocked(true); });
    return () => { current = false; playback.dispose(); output.current = null; element.pause(); element.srcObject = null; };
  }, [stream, createContext]);
  useEffect(() => { output.current?.setLevel(volume); output.current?.setMuted(muted); }, [stream, volume, muted]);
  return <><audio ref={ref} aria-label={label} onPlay={() => setBlocked(false)} />
    {blocked && <ChannelAction icon="speaker" label={lang === "zh" ? `播放 ${label}` : `Play ${label}`}
      onClick={() => { void ref.current?.play().then(() => setBlocked(false)).catch(() => {}); }} />}</>;
}
