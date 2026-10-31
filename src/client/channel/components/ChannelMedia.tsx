import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Btn } from "../../components/living/primitives";
import { PlaybackControlsReveal } from "../../components/living/PlaybackControlsReveal";
import { usePlaybackControlsVisibility } from "../../components/living/use-playback-controls-visibility";
import { toggleVideoFullscreen, videoFullscreenState } from "../../components/living/video-fullscreen";
import { ViewerAudio, type ViewerAudioSnapshot } from "../../media/viewer-audio";
import { observeCompositedVideoFrame } from "../../media/video-frame-proof";
import { playbackFailure } from "../../media/viewer-playback";
import type { ChannelScreenInput, ScreenPresentation } from "../types";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { RemoteControl } from "../../components/living/RemoteControl";
import type { InputTransport } from "../../remote-control/input-route";
import "./channel-media.css";

/** Literal prototype copy, shared production geometry and guidance. */
export function ChannelAction({ icon, label, onClick, disabled, busy, pressed, danger, primary, hint, iconOnly = false, quiet = false, type = "button" }: {
  icon: GlyphName; label: string; onClick?: () => void; disabled?: boolean;
  busy?: boolean; pressed?: boolean; danger?: boolean; primary?: boolean;
  iconOnly?: boolean; quiet?: boolean;
  hint?: ComponentProps<typeof Btn>["hint"]; type?: "button" | "submit";
}) {
  return <Btn icon={icon} title={{ text: label }} cap={iconOnly ? undefined : { text: label }}
    size="compact" quiet={quiet} tone={danger ? "danger" : primary ? "primary" : undefined}
    type={type} onClick={onClick} disabled={disabled || busy} busy={busy} pressed={pressed} hint={hint} />;
}

function ChannelVideoInput({ input, visible, label, register, frame, issue, playing, fullscreen }: {
  input: ChannelScreenInput; visible: boolean; label: string;
  register(input: ChannelScreenInput, element: HTMLVideoElement | null): void;
  frame(input: ChannelScreenInput, element: HTMLVideoElement): void;
  issue(input: ChannelScreenInput, error: unknown): void;
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
    void element.play().catch(error => { if (active && playbackFailure(error)) issue(input, error); });
    return () => { active = false; stop(); element.muted = true; element.pause(); element.srcObject = null; };
  }, [input.flowId, input.stream, frame, issue]);
  return <video ref={attach} playsInline muted aria-label={visible ? label : undefined} aria-hidden={!visible}
    data-flow-id={input.flowId} data-selected={visible} data-composited={composited} data-switch-ready={input.switchReady}
    tabIndex={visible ? 0 : -1} onPlay={() => playing(input, false)} onPause={() => playing(input, true)}
    onEnded={() => playing(input, true)} onError={event => issue(input, event.currentTarget.error)}
    onDoubleClick={visible ? fullscreen : undefined} onKeyDown={event => {
      if (visible && event.code === "Space") { event.preventDefault(); if (event.currentTarget.paused) void event.currentTarget.play().catch(error => issue(input, error)); else event.currentTarget.pause(); }
    }} />;
}

export function ChannelVideo({ stream, local, label, inputs, onPresentation, input }: {
  stream: MediaStream; local: boolean; label: string; inputs?: readonly ChannelScreenInput[];
  input?: InputTransport;
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
  const output = useRef<ViewerAudio | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [audio, setAudio] = useState<ViewerAudioSnapshot>({ level: 1, muted: false, boostAvailable: true });
  const [fullscreen, setFullscreen] = useState({ supported: false, ready: false, active: false, nativeActive: false });
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const nativeRequested = useRef(false);
  const current = useRef({ displayed, inputs, onPresentation });
  current.current = { displayed, inputs, onPresentation };
  const { lang, t } = useCopy();
  const playbackRef = useMemo(() => ({ current: activeVideo }), [activeVideo]);
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
  const issue = useCallback((input: ChannelScreenInput, error: unknown) => {
    if (!playbackFailure(error) || !consumers.current.has(input.stream)) return;
    const state = current.current;
    if (state.displayed.flowId === input.flowId && state.displayed.stream === input.stream) setBlocked(true);
    else if (state.inputs?.some(value => value.flowId === input.flowId && !value.selected)) state.onPresentation?.(input.flowId, input.stream, "failed");
  }, []);
  const playing = useCallback((input: ChannelScreenInput, value: boolean) => {
    if (current.current.displayed.flowId !== input.flowId || current.current.displayed.stream !== input.stream) return;
    setPaused(value); if (!value) setBlocked(false);
  }, []);
  const play = () => {
    const element = ref.current;
    if (!element) return;
    output.current?.resume();
    void element.play().then(() => setBlocked(false)).catch(error => {
      if (ref.current === element && playbackFailure(error)) setBlocked(true);
    });
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
      if (keepPaused) element.pause();
      element.volume = Math.min(saved.level, 1); element.muted = true;
      const nextAudio = local ? null : new ViewerAudio(element, setAudio, undefined, 1);
      nextAudio?.bind(target.stream); nextAudio?.setLevel(saved.level); nextAudio?.setMuted(saved.muted);
      output.current = nextAudio; ref.current = element;
      setActiveVideo(element); setPaused(keepPaused); setBlocked(false);
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
      setHasAudio(selectedStream.getAudioTracks().some(track => track.readyState === "live"));
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
      const state = nativeRequested.current || fullscreen.nativeActive ? "waiting" : consumer.composited ? "prepared" : "waiting";
      onPresentation?.(input.flowId, input.stream, state);
    }
  }, [inputs, onPresentation, consumerVersion, fullscreen.nativeActive]);
  const nativeEntryBlocked = inputs?.some(input => !input.selected && input.switchReady)
    && !fullscreen.active && !(document.fullscreenEnabled && activeVideo?.parentElement?.requestFullscreen);
  return <div className="c3-video c3-mini-player" data-controls-hidden={visibility.hidden}>
    {rendered.map(input => <ChannelVideoInput key={`${input.flowId}:${input.stream.id}`} input={input} visible={input.flowId === displayed.flowId && input.stream === displayed.stream}
      label={label} register={register} frame={frame} issue={issue} playing={playing} fullscreen={fullscreenToggle} />)}
    {!ready && !blocked && <div className="c3-mini-message" role="status">
      <span className="c3-frame-wait"><Glyph name="loader" className="lr-spin" size={22} />
        {lang === "zh" ? "等待画面" : "Waiting for picture"}</span>
    </div>}
    {blocked && <div className="c3-mini-message"><Btn icon="play" title="playback.play" cap="playback.play"
      onClick={play} hint="hint-local-play" /></div>}
    <div id={controlsId} ref={controls} className="c3-mini-controls" role="group" aria-label={lang === "zh" ? "本机播放" : "Local playback"}>
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
      {!local && <RemoteControl channel={input ?? null} videoRef={playbackRef} available={ready && displayed.flowId === target.flowId} />}
      <Btn icon={fullscreen.active ? "contract" : "expand"} size="dense" quiet
        title={fullscreenFailed ? "playback.fullscreenFailed" : fullscreen.active ? "playback.exitFullscreen" : "playback.fullscreen"}
        hint={fullscreenFailed || !fullscreen.ready ? "hint-fullscreen-unavailable" : fullscreen.active ? "hint-fullscreen-exit" : "hint-fullscreen"}
        disabled={(!fullscreen.ready && !fullscreen.active) || !!nativeEntryBlocked} onClick={fullscreenToggle} />
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
