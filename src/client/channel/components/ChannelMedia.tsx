import { useWatchPageSlot } from "./use-watch-page-slot";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Btn } from "../../components/living/primitives";
import { BrandMark } from "../../components/living/BrandMark";
import { PlaybackControlsReveal } from "../../components/living/PlaybackControlsReveal";
import { PlaybackWindowControls } from "../../components/living/PlaybackWindowControls";
import { PlaybackSettings, type PlaybackSettingsProps } from "../../components/living/PlaybackSettings";
import { RoomChatOverlay, RoomChatOverlaySettings, RoomChatToggle } from "../../components/living/RoomChatOverlay";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { debugEvent } from "../../lib/debug";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useVideoRotation } from "../../components/living/use-video-rotation";
import { usePlaybackControlsVisibility } from "../../components/living/use-playback-controls-visibility";
import { useHostPreviewPlayback } from "../../components/living/use-host-preview-playback";
import { usePictureInPicture } from "../../components/living/use-picture-in-picture";
import { toggleVideoFullscreen, videoFullscreenState } from "../../components/living/video-fullscreen";
import { ViewerAudio, type ViewerAudioSnapshot } from "../../media/viewer-audio";
import { observeDebugPlayback } from "../../lib/debug-webrtc";
import { observeCompositedVideoFrame } from "../../media/video-frame-proof";
import { playbackFailure } from "../../media/viewer-playback";
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import type { VideoFit, VideoRotation } from "../../media/video-geometry";
import type { ChannelScreenInput, ScreenPresentation } from "../types";
import { watchSeekPosition } from "../watch-media";
import { useCopy } from "../../ui/copy";
import { RemoteControl } from "../../components/living/RemoteControl";
import type { InputTransport } from "../../remote-control/input-route";
import { ChannelAction } from "./ChannelAction";
import "./channel-media.css";
import type { WatchPlayer } from "../watch-playback";
import type { WatchPlayback } from "../protocol";
import { channelErrorPresentation } from "../error-presentation";
import { formatMediaTime } from "../../media/media-time";
import { mediaLanguageLabel } from "../../media/media-language";

export interface WatchReceiving {
  peerAvailable: boolean; peerSupported: boolean; mode: "direct" | "peer"; browserSource: boolean;
  failed?: boolean;
  pending?: boolean; disabled?: boolean; onPeer(): void; onDirect(): void;
}

export function WatchPeerAction({ receiving }: { receiving: WatchReceiving }) {
  const { t } = useCopy();
  if (!receiving.peerAvailable && receiving.mode !== "peer" || receiving.mode === "peer" && !receiving.failed) return null;
  const retry = receiving.mode === "peer";
  const label = retry ? "common.retry" : "watch.forward.peer";
  return receiving.peerSupported ? <Btn icon={retry ? "refresh" : "share"} title={label} cap={label} size="compact"
    disabled={!receiving.peerAvailable || receiving.disabled || receiving.pending} busy={receiving.pending} onClick={receiving.onPeer} />
    : <small>{t("watch.forward.secure")}</small>;
}

function WatchPlaybackSettings({ receiving, originalPage, playback, children, audioAvailable = true }: { receiving?: WatchReceiving; originalPage: boolean; children?: ReactNode; audioAvailable?: boolean; playback?: {
  rate: number; rates: readonly number[]; disabled: boolean; onRate(rate: number): void;
} }) {
  const { t } = useCopy();
  const directSelected = receiving?.mode === "direct" && !originalPage;
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(trigger, panel, { side: "above", align: "end" });
  return <span ref={trigger}><Btn icon="sliders" quiet title="playback.more" popoverTarget={id} />
    <div ref={panel} id={id} popover="auto" role="dialog" className="lr-floating-surface lr-playback-menu c3-watch-receiving" aria-label={t("playback.more")}>
      {playback ? <label className="c3-watch-rate"><span>{t("watch.rate")}</span>
        <select className="lr-select" aria-label={t("watch.rate")} value={playback.rate} disabled={playback.disabled}
          onChange={event => playback.onRate(Number(event.target.value))}>
          {playback.rates.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
        </select></label> : audioAvailable && <p>{t("watch.following")}</p>}
      {!audioAvailable && <p>{t("playback.noAudio")}</p>}
      {receiving && <><b>{t("watch.forward.viewing")}</b><p>{t("watch.forward.receiveHelp")}</p>
      {(receiving.peerAvailable || receiving.mode === "peer") && (receiving.peerSupported ? <Btn icon="share" title="watch.forward.peer" cap="watch.forward.peer" size="compact"
        pressed={receiving.mode === "peer"} disabled={!receiving.peerAvailable || receiving.disabled || receiving.pending
          || receiving.mode === "peer"} busy={receiving.pending} onClick={receiving.onPeer} />
        : <small>{t("watch.forward.secure")}</small>)}
      {receiving.browserSource && <Btn icon="globe" quiet title="watch.forward.direct" cap="watch.forward.direct" pressed={directSelected}
        disabled={receiving.disabled || receiving.pending || directSelected && !receiving.failed} onClick={receiving.onDirect} />}</>}
      {children}
    </div>
  </span>;
}

/** The session owns loading and playback; presentation only mounts its existing element. */
export function ChannelWatchVideo({ player, owned, paused, label, presentation, theaterMode, onToggleTheater, onPlayback, onResume, disabled, website, originalPageAvailable, originalPageUnavailable, onAppWatch, onFocusWindow, receiving, automaticPlayback = true, nativeStage = false }: {
  player: WatchPlayer; owned: boolean; paused: boolean; label: string; presentation: "full" | "thumbnail" | "background";
  theaterMode: boolean; onToggleTheater(): void; disabled: boolean;
  onPlayback(patch: Partial<Pick<WatchPlayback, "paused" | "position" | "rate">>): void; onResume(): void;
  website: boolean; originalPageAvailable: boolean; originalPageUnavailable?: string; onAppWatch?: () => void; onFocusWindow(): void;
  receiving?: WatchReceiving;
  automaticPlayback?: boolean;
  nativeStage?: boolean;
}) {
  const { lang, t } = useCopy();
  const slot = useRef<HTMLDivElement>(null), controls = useRef<HTMLDivElement>(null);
  const videoRef = useMemo(() => ({ current: player.video }), [player]);
  const controlsId = useId();
  const surface = player.presentation, embedded = surface.kind === "embed";
  const pageId = surface.kind === "external" && nativeStage && presentation === "full" && !player.error &&
    typeof window !== "undefined" && window.piikMountWatchPage && player.media.page?.selectedCandidateId ? player.media.page.id : undefined;
  const native = useWatchPageSlot(pageId);
  const audioTracks = player.media.audioTracks?.() ?? [];
  const audioOptions = audioTracks.map(track => ({ ...track, label: [mediaLanguageLabel(track.language, lang) || track.name,
    track.channels ? t("watch.forward.channels", { count: track.channels }) : undefined].filter(Boolean).join(" · ") }));
  const preparing = player.waitingForPicture;
  const ownerPaused = player.video?.paused ?? player.mediaState?.paused ?? paused;
  const audioAvailable = player.media.audioAvailable?.() !== false;
  const [htmlMedia, setMedia] = useState({ position: 0, duration: 0, volume: 1, muted: false, rate: 1 });
  const live = player.mediaState?.live;
  const media = player.video && !live ? htmlMedia : { position: player.mediaState?.position ?? 0, duration: player.mediaState?.duration ?? 0,
    rate: player.mediaState?.rate ?? 1, volume: htmlMedia.volume, muted: htmlMedia.muted };
  const seekStart = live?.seekable[0]?.[0] ?? 0, seekEnd = live?.seekable.at(-1)?.[1] ?? media.duration;
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const draggingSeek = useRef(false);
  const position = Math.max(seekStart, Math.min(seekPreview ?? media.position, seekEnd || 1));
  const timeLabel = live ? t(live.active ? "watch.liveDelay" : "watch.liveRemaining", { seconds: String(Math.max(0, Math.round(seekEnd - position))) })
    : `${formatMediaTime(position)} / ${formatMediaTime(media.duration || Number.NaN)}`;
  const [fullscreen, setFullscreen] = useState(() => player.video ? videoFullscreenState(player.video)
    : { supported: false, ready: false, active: false, nativeActive: false });
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const receivingSettings = receiving && (receiving.peerAvailable || receiving.mode === "peer" || surface.kind === "external" && receiving.browserSource) ? receiving : undefined;
  const openOriginal = !owned && website && originalPageAvailable && surface.kind !== "external" ? onAppWatch : undefined;
  const settingsOriginal = !player.error && openOriginal;
  const localControls = !!player.video || !!receivingSettings || !!settingsOriginal || owned && !embedded;
  const hasControls = owned && !embedded || localControls;
  const failure = channelErrorPresentation(player.error, t,
    receiving?.mode === "peer" ? "watch.forward.failed" : website && player.video ? "watch.browserFailed" : "watch.failed").message;
  const picture = usePictureInPicture(videoRef);
  const windowControls = player.video && <PlaybackWindowControls picture={picture} canPlay={player.video.readyState >= 2} quiet theaterMode={theaterMode} onToggleTheater={onToggleTheater}
    fullscreen={fullscreen} fullscreenFailed={fullscreenFailed} toggleFullscreen={() => {
      if (player.video) { setFullscreenFailed(false); void toggleVideoFullscreen(player.video).catch(() => setFullscreenFailed(true)); }
    }} />;
  const visibility = usePlaybackControlsVisibility(videoRef, controls, player.blocked || !!player.error);
  useLayoutEffect(() => {
    if (surface.kind === "external") return;
    const element = surface.element, target = slot.current;
    let stopFrame: (() => void) | undefined;
    let stopDebug: (() => void) | undefined;
    element.dataset.watchSurface = "true";
    if (target && element.parentNode !== target) {
      if (surface.kind === "embed" && element.isConnected) target.moveBefore(element, null);
      else target.prepend(element);
    }
    if (surface.kind === "embed" && element.parentNode === target) surface.mounted();
    if (surface.kind === "embed") surface.setVisible(presentation !== "background" && element.ownerDocument.visibilityState === "visible", automaticPlayback);
    if (surface.kind === "video") {
      element.setAttribute("aria-label", label); element.dataset.selected = "true"; element.tabIndex = -1;
      stopDebug = observeDebugPlayback(surface.element, () => ({
        source: "watch", selected: !element.closest("[inert]"), presentedFrame: player.hasPresentedFrame,
      }));
      if (!player.hasPresentedFrame) stopFrame = observeCompositedVideoFrame(surface.element, null, () => player.presentFrame());
    }
    return () => {
      stopFrame?.();
      stopDebug?.();
      if (element.parentNode === target) {
        if (surface.kind === "embed") surface.setVisible(false);
        else element.remove();
      }
    };
  }, [player]);
  useEffect(() => {
    if (surface.kind !== "embed") return;
    const ownerDocument = surface.element.ownerDocument;
    let visible = false;
    const sync = () => surface.setVisible(presentation !== "background" && ownerDocument.visibilityState === "visible", automaticPlayback && visible);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && entry.intersectionRatio > 0.5;
      sync();
    }, { threshold: [0, 0.5, 1] });
    observer.observe(surface.element);
    ownerDocument.addEventListener("visibilitychange", sync);
    sync();
    return () => { observer.disconnect(); ownerDocument.removeEventListener("visibilitychange", sync); if (surface.element.parentNode === slot.current) surface.setVisible(false); };
  }, [player, presentation, automaticPlayback]);
  useEffect(() => { player.video?.setAttribute("aria-label", label); }, [player, label]);
  useEffect(() => {
    const video = player.video;
    if (!video) return;
    const sync = () => {
      setMedia({ position: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0,
        volume: video.volume, muted: video.muted, rate: video.playbackRate });
      setFullscreen(videoFullscreenState(video));
    };
    const events = ["timeupdate", "durationchange", "volumechange", "ratechange", "loadedmetadata", "loadeddata", "waiting", "webkitbeginfullscreen", "webkitendfullscreen"];
    for (const name of events) video.addEventListener(name, sync);
    document.addEventListener("fullscreenchange", sync); sync();
    return () => { for (const name of events) video.removeEventListener(name, sync); document.removeEventListener("fullscreenchange", sync); };
  }, [player]);
  return <div ref={slot} className="c3-video c3-mini-player c3-watch-player" data-native-page={pageId ? true : undefined} data-external={surface.kind === "external" || undefined} data-embed={embedded || undefined} data-failed={!!player.error || undefined}
    data-standalone={!embedded && (!player.video || !!player.error && player.error !== "watch_update_failed") || undefined} data-thumbnail={!embedded && presentation === "thumbnail" || undefined}
    data-controls-hidden={!embedded && visibility.hidden} inert={presentation === "background"}>
    {surface.kind !== "external" && preparing && !player.error && !player.blocked && <div className="c3-mini-message" role="status">
      <span className="c3-frame-wait"><BrandMark size={32} motion="loop" />{t("watch.waiting")}</span>
    </div>}
    {pageId && <div ref={native.slot} className="c3-watch-native-slot" />}
    {surface.kind === "external" && !player.error && !native.mounted && <div className="c3-mini-message"><div className="c3-frame-wait c3-watch-result">
      {preparing && <BrandMark size={32} motion="loop" />}<span>{t(preparing ? "watch.waiting" : "watch.inWindow")}</span>
      <Btn icon="window" title="watch.focusWindow" cap="watch.focusWindow" onClick={onFocusWindow} />
    </div></div>}
    {player.error ? <div className="c3-mini-message" role="alert"><div className="c3-frame-wait c3-watch-result"><span>{failure}</span>
      {!owned && receiving?.mode === "direct" && receiving.browserSource && surface.kind !== "external" &&
        <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact" disabled={disabled || receiving.disabled || receiving.pending}
          busy={receiving.pending} onClick={receiving.onDirect} />}
      {owned && player.media.page && <Btn icon="window" title="watch.focusWindow" cap="watch.focusWindow" onClick={onFocusWindow} />}
      {!owned && website && surface.kind !== "external" && (openOriginal
        ? <Btn icon="window" title="watch.openPage" cap="watch.openPage" disabled={disabled || receiving?.pending} onClick={openOriginal} />
        : !(receiving?.peerAvailable && receiving.peerSupported) && (originalPageUnavailable
          ? <small>{originalPageUnavailable}</small> : originalPageAvailable && <small>{t("watch.connectApp")}</small>))}
      {receiving && <WatchPeerAction receiving={{ ...receiving, failed: true, disabled: disabled || receiving.disabled }} />}
    </div></div>
      : player.blocked && <div className="c3-mini-message"><Btn icon="play" title="watch.resume" cap="watch.resume" onClick={onResume} /></div>}
    {hasControls && <div ref={controls} id={controlsId} className="c3-mini-controls lr-media-toolbar lr-media-overlay lr-media-controls" role="group" aria-label={t("playback.controls")}>
      {!embedded && <div className="c3-watch-shared" role="group" aria-label={t(owned ? "watch.sharedControls" : "watch.following")}>
        {owned && <Btn icon={ownerPaused ? "play" : "pause"} quiet size="dense"
          title={ownerPaused ? "watch.play" : "watch.pause"} disabled={disabled} onClick={() => onPlayback({ paused: !ownerPaused })} />}
        {live && <span className="c3-watch-status">{t(live.active ? "watch.live" : "watch.liveEnded")}</span>}
        <div className="c3-watch-timeline" data-seeking={seekPreview !== null || undefined}>
        {owned ? <input type="range" min={seekStart} max={seekEnd || 1} step="0.1" value={position}
          aria-label={t("watch.seek")} disabled={disabled || seekEnd <= seekStart}
          aria-valuetext={timeLabel} onPointerDown={() => { draggingSeek.current = true; }}
          onInput={event => {
            const requested = Number(event.currentTarget.value);
            if (draggingSeek.current) setSeekPreview(requested);
            else onPlayback({ position: live ? watchSeekPosition(requested, live.seekable, requested - position) : requested });
          }}
          onPointerUp={event => { draggingSeek.current = false; onPlayback({ position: Number(event.currentTarget.value) }); setSeekPreview(null); }}
          onPointerCancel={() => { draggingSeek.current = false; setSeekPreview(null); }} />
          : <progress max={seekEnd - seekStart || 1} value={Math.max(0, media.position - seekStart)}
            aria-label={t("watch.following")} title={t("watch.following")} />}
          <output className="c3-watch-time" aria-label={owned ? undefined : t("watch.following")}>{timeLabel}</output>
        </div>
        {owned && live?.active && <Btn icon="arrowRight" quiet size="dense" title="watch.goLive" cap="watch.goLive" textTooltip
          disabled={disabled || live.syncPosition === null} onClick={() => { if (live.syncPosition !== null) onPlayback({ position: live.syncPosition, paused: false }); }} />}
      </div>}
      {!embedded && localControls && <span className="lr-viewer-action-separator" aria-hidden="true" />}
      {localControls && <div className="c3-watch-local">
        {player.video && audioAvailable ? <>
          <Btn icon={media.muted || !media.volume ? "speakerOff" : "speaker"} quiet size="dense" title={media.muted ? "playback.unmute" : "playback.mute"}
            onClick={() => { const video = player.video; if (!video) return; const silent = video.muted || !video.volume; if (silent && !video.volume) video.volume = 1; video.muted = !silent; }} />
        <input className="c3-mini-volume" type="range" min={0} max={100} step={1} value={media.muted ? 0 : Math.round(media.volume * 100)}
          aria-label={t("playback.volumeBasic")} aria-valuetext={`${media.muted ? 0 : Math.round(media.volume * 100)}%`}
          onChange={event => { if (player.video) { player.video.volume = Number(event.target.value) / 100; player.video.muted = false; } }} />
        </> : null}
        <WatchPlaybackSettings originalPage={surface.kind === "external"} receiving={receivingSettings} audioAvailable={audioAvailable}
          playback={owned && !embedded ? { rate: media.rate, rates: player.media.playbackRates?.() ?? [0.5, 0.75, 1, 1.25, 1.5, 2], disabled,
            onRate: rate => onPlayback({ rate }) } : undefined}>
          {settingsOriginal && <Btn icon="window" quiet title="watch.openPage" cap="watch.openPage" size="compact"
            disabled={disabled || receiving?.disabled || receiving?.pending} onClick={settingsOriginal} />}
          {audioTracks.length > 0 && <label className="c3-watch-audio"><span>{t("watch.audioTrack")}</span>
            <select className="lr-select" aria-label={t("watch.audioTrack")} value={audioTracks.find(track => track.selected)?.id ?? ""} disabled={audioTracks.length === 1}
              onChange={event => player.media.selectAudioTrack?.(Number(event.target.value))}>
              {audioOptions.map(track => <option key={track.id} value={track.id}>{audioOptions.some(other => other.id !== track.id && other.label === track.label)
                ? `${track.label} — ${track.name}` : track.label}</option>)}
            </select></label>}
          {owned && player.media.page && <Btn icon="window" quiet title="watch.focusWindow" cap="watch.focusWindow" onClick={onFocusWindow} />}
          {windowControls && <div className="c3-watch-settings-window">{windowControls}</div>}
        </WatchPlaybackSettings>
        {owned && player.video && player.media.page && !player.error && <Btn icon="window" quiet size="dense"
          title="watch.focusWindow" onClick={onFocusWindow} />}
        {windowControls}
      </div>}
    </div>}
    {hasControls && !embedded && <PlaybackControlsReveal controls={controls} controlsId={controlsId} hidden={visibility.hidden} />}
  </div>;
}

export function observeChannelInputFrame(element: HTMLVideoElement, stream: MediaStream, negotiatedFlowId: string | undefined, frame: () => void) {
  return observeCompositedVideoFrame(element, stream, () => {
    if (negotiatedFlowId) debugEvent("channel", "first-composited-frame", { flowId: negotiatedFlowId });
    frame();
  });
}

function ChannelVideoInput({ input, negotiatedFlowId, visible, interactive, label, fit, register, frame, issue, playing, fullscreen }: {
  input: ChannelScreenInput; negotiatedFlowId?: string; visible: boolean; interactive: boolean; label: string; fit: VideoFit;
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
    const stop = observeChannelInputFrame(element, input.stream, negotiatedFlowId, () => {
      setComposited(true); frame(input, element);
    });
    const stopDebug = observeDebugPlayback(element, () => ({
      source: "screen", flowId: negotiatedFlowId, selected: element.dataset.selected === "true",
      presentedFrame: element.dataset.composited === "true",
    }));
    let active = true;
    void element.play().catch(error => { if (active) issue(input, element, error); });
    return () => { active = false; stop(); stopDebug(); element.muted = true; element.pause(); element.srcObject = null; };
  }, [input.flowId, input.stream, negotiatedFlowId, frame, issue]);
  return <video ref={attach} playsInline muted inert={!interactive} style={{ objectFit: fit }} aria-label={visible ? label : undefined} aria-hidden={!visible}
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

function readStickPositions() {
  return readRoomPreferences().stickPositions;
}

export function ChannelVideo({ stream, owned, localSource, label, presentation = "full", inputs, onPresentation, input, interaction = null, buffering, onRetryPicture, retryAvailable = true, theaterMode, onToggleTheater }: {
  stream: MediaStream; owned: boolean; localSource: boolean; label: string; inputs?: readonly ChannelScreenInput[];
  presentation?: "full" | "thumbnail" | "background";
  input?: InputTransport;
  buffering?: PlaybackSettingsProps["buffering"];
  onRetryPicture?(): void; retryAvailable?: boolean;
  interaction?: RoomInteractionSession | null;
  theaterMode: boolean; onToggleTheater(): void;
  onPresentation?: (flowId: string, stream: MediaStream, state: ScreenPresentation) => void;
}) {
  const thumbnail = presentation === "thumbnail", interactive = presentation === "full";
  const target = inputs?.find(input => input.selected) ?? { flowId: stream.id, stream, selected: true, switchReady: false, localDisplayKey: true };
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
  const { t } = useCopy();
  const hasAudio = !localSource && streamHasAudio;
  const silent = audio.muted || audio.level === 0;
  const volumeTitle = !hasAudio ? "playback.noAudio" : audio.boostAvailable ? "playback.volume" : "playback.volumeBasic";
  const playbackRef = useMemo(() => ({ current: activeVideo }), [activeVideo]);
  const picture = usePictureInPicture(playbackRef);
  const previewPlayback = useHostPreviewPlayback(playbackRef, owned ? displayed.stream : null, previewAutoPause, localSource);
  useVideoRotation(playbackRef, pictureFit, pictureRotation);
  useAnchoredPopover(pictureTrigger, picturePanel, { side: "above", align: "center" });
  useLayoutEffect(() => { if (presentation === "background") picturePanel.current?.hidePopover(); }, [presentation]);
  const visibility = usePlaybackControlsVisibility(playbackRef, controls, blocked || !ready);
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
    // Only remote playback owns a listening output, even when the video stays.
    if (ref.current !== binding.element || Boolean(output.current) !== !localSource) {
      const previous = ref.current, listening = output.current;
      const saved = listening?.snapshot ?? audio;
      const keepPaused = previous?.paused ?? false;
      listening?.setMuted(true);
      listening?.dispose();
      if (previous) previous.muted = true;
      const element = binding.element;
      if (owned && keepPaused) previewPlayback.onPause();
      if (keepPaused && !owned) element.pause();
      element.volume = Math.min(saved.level, 1); element.muted = true;
      const nextAudio = localSource ? null : new ViewerAudio(element, setAudio);
      nextAudio?.bind(target.stream); nextAudio?.setLevel(saved.level); nextAudio?.setMuted(saved.muted);
      if (localSource) setAudio(saved);
      output.current = nextAudio; ref.current = element;
      setActiveVideo(element); setPaused(owned ? element.paused : keepPaused); setBlocked(false);
      if (previous !== element) previous?.pause();
    }
    setReady(binding.composited);
    if (swapping) setDisplayed(target);
  }, [target.flowId, target.stream, displayed.flowId, displayed.stream, consumerVersion, owned, localSource]);
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
  return <div className="c3-video c3-mini-player" data-controls-hidden={visibility.hidden} data-thumbnail={thumbnail || undefined} inert={presentation === "background"}>
    {rendered.map(input => <ChannelVideoInput key={`${input.flowId}:${input.stream.id}`} input={input} visible={input.flowId === displayed.flowId && input.stream === displayed.stream}
      negotiatedFlowId={"localDisplayKey" in input ? undefined : input.flowId}
      interactive={interactive} label={label} fit={pictureFit} register={register} frame={frame} issue={issue} playing={playing} fullscreen={fullscreenToggle} />)}
    <RoomChatOverlay session={interaction} visible={interactive && ready && !blocked && !paused} />
    {!ready && !blocked && <div className="c3-mini-message" role="status">
      <span className="c3-frame-wait"><BrandMark size={32} motion="loop" />
        {t("screen.waitingPicture")}</span>
    </div>}
    {blocked && <div className="c3-mini-message"><Btn icon="play" title="playback.play" cap="playback.play"
      onClick={play} hint="hint-local-play" /></div>}
    <div id={controlsId} ref={controls} className="c3-mini-controls lr-media-toolbar lr-media-overlay lr-media-controls" role="group" aria-label={t("playback.controls")}>
      <Btn icon={paused ? "play" : "pause"} title={paused ? "playback.play" : "playback.pause"} quiet
        hint={paused ? "hint-local-play" : "hint-local-pause"} onClick={() => { if (ref.current?.paused) play(); else ref.current?.pause(); }} />
      {!localSource && <>
        <Btn icon={!hasAudio || silent ? "speakerOff" : "speaker"} quiet
          title={!hasAudio ? "playback.noAudio" : silent ? "playback.unmute" : "playback.mute"}
          hint={!hasAudio ? "hint-no-audio" : silent ? "hint-unmute" : "hint-mute"}
          disabled={!hasAudio} pressed={silent}
          onClick={() => {
            if (audio.level === 0) output.current?.setLevel(1);
            output.current?.setMuted(!silent);
          }} />
        <input className="c3-mini-volume" type="range" min="0" max={audio.boostAvailable ? 2 : 1} step="0.05" value={hasAudio ? audio.level : 0}
          disabled={!hasAudio} aria-label={t(volumeTitle)} aria-valuetext={hasAudio ? `${Math.round(audio.level * 100)}%` : t("playback.noAudio")}
          onChange={event => {
            const level = Number(event.currentTarget.value);
            output.current?.setLevel(level); output.current?.setMuted(false);
          }} />
      </>}
      <span className="c3-mini-space" />
      <RoomChatToggle session={interaction} quiet />
      {!owned && <RemoteControl channel={input ?? null} videoRef={playbackRef} available={interactive && ready && displayed.flowId === target.flowId}
        pictureFit={pictureFit} pictureRotation={pictureRotation} touchMode={remoteTouchMode}
        readStickPositions={readStickPositions} onStickPositionChange={(side, position) => {
          saveRoomPreferences({ stickPositions: { ...readStickPositions(), [side]: position } });
        }} />}
      <span ref={pictureTrigger} className="lr-playback-more"><Btn icon="sliders" quiet title="playback.more" hint="hint-advanced"
        popoverTarget={pictureId} controls={pictureId} expanded={pictureOpen} /></span>
      <div ref={panel => {
        picturePanel.current = panel;
        // Native popover focus runs before the settings content mounts.
        panel?.setAttribute("autofocus", "");
      }} id={pictureId} popover="auto" role="dialog" tabIndex={-1} aria-label={t("playback.more")}
        className="lr-floating-surface lr-playback-menu lr-playback-settings" onToggle={event => {
          if (event.target === event.currentTarget) setPictureOpen(event.newState === "open");
        }}>
        {pictureOpen && <PlaybackSettings buffering={!owned && !localSource ? buffering : undefined} picture={{ pictureFit, pictureRotation,
          setPictureFit: (fit: VideoFit) => { setPictureFit(fit); saveRoomPreferences({ pictureFit: fit }); },
          setPictureRotation: (rotation: VideoRotation) => { setPictureRotation(rotation); saveRoomPreferences({ pictureRotation: rotation }); },
        }} preview={owned ? { autoPause: previewAutoPause, onChange: autoPause => {
          setPreviewAutoPause(autoPause); saveRoomPreferences({ previewAutoPause: autoPause });
        } } : undefined} remoteTouch={!owned && input ? { mode: remoteTouchMode, onChange: mode => {
          setRemoteTouchMode(mode); saveRoomPreferences({ remoteTouchMode: mode });
        } } : undefined} overlaySettings={interaction && <RoomChatOverlaySettings session={interaction} />} reconnect={!owned && !localSource && onRetryPicture ? <Btn icon="refresh" quiet size="dense"
          title="screen.retryPicture" cap="screen.retryPicture" disabled={!retryAvailable} onClick={() => {
            picturePanel.current?.hidePopover(); pictureTrigger.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }); onRetryPicture();
          }} /> : null} />}
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
  const { t } = useCopy();
  const track = stream.getAudioTracks()[0];
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
  }, [stream, track, createContext]);
  useEffect(() => { output.current?.setLevel(volume); output.current?.setMuted(muted); }, [stream, track, volume, muted]);
  return <><audio ref={ref} aria-label={label} onPlay={() => setBlocked(false)} />
    {blocked && <ChannelAction icon="speaker" label={t("screen.playNamed", { label })}
      onClick={() => { void ref.current?.play().then(() => setBlocked(false)).catch(() => {}); }} />}</>;
}
