import { playbackOutput } from "../../media/playback-output";
import { PlaybackDeviceSelect } from "./PlaybackDeviceSelect";
import { useWatchPageSlot } from "./use-watch-page-slot";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Btn } from "../../components/living/primitives";
import { BrandMark } from "../../components/living/BrandMark";
import { PlaybackControlsReveal } from "../../components/living/PlaybackControlsReveal";
import { PlaybackWindowControls } from "../../components/living/PlaybackWindowControls";
import { AudioVolumeControl } from "../../components/living/AudioVolumeControl";
import { PlaybackSettings, type PlaybackSettingsProps } from "../../components/living/PlaybackSettings";
import { RoomChatOverlay, RoomChatOverlaySettings, RoomChatToggle } from "../../components/living/RoomChatOverlay";
import type { RoomInteractionSession } from "../../lib/room-interactions";
import { debugEvent } from "../../lib/debug";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useVideoRotation } from "../../components/living/use-video-rotation";
import { PlaybackControlsAttention, usePlaybackControlsVisibility } from "../../components/living/use-playback-controls-visibility";
import { useHostPreviewPlayback } from "../../components/living/use-host-preview-playback";
import { usePictureInPicture } from "../../components/living/use-picture-in-picture";
import { toggleVideoFullscreen, videoFullscreenState } from "../../components/living/video-fullscreen";
import { ViewerAudio, type ViewerAudioSnapshot, type VoicePlaybackContext } from "../../media/viewer-audio";
import { observeDebugPlayback } from "../../lib/debug-webrtc";
import { observeCompositedVideoFrame } from "../../media/video-frame-proof";
import { elementPlaybackError, playbackFailure, type ScreenPlaybackError } from "../../media/viewer-playback";
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import type { VideoFit, VideoRotation } from "../../media/video-geometry";
import type { ChannelActions, ChannelScreenInput } from "../types";
import { watchSeekPosition } from "../watch-media";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { RemoteControl } from "../../components/living/RemoteControl";
import type { InputTransport } from "../../remote-control/input-route";
import { ChannelAction } from "./ChannelAction";
import "./channel-media.css";
import type { WatchPlayer } from "../watch-playback";
import type { WatchPlayback } from "../protocol";
import { channelErrorPresentation } from "../error-presentation";
import { diagnoseChannelFact } from "../diagnosis";
import { ChannelDiagnosisHelp } from "./ChannelDiagnosisHelp";
import type { VoiceRendering } from "../use-voice-playback";
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

function WatchPlaybackSettings({ receiving, originalPage, playback, children, audio, audioAvailable }: {
  receiving?: WatchReceiving; originalPage: boolean; children?: ReactNode;
  audio?: ComponentProps<typeof AudioVolumeControl>; audioAvailable: boolean;
  playback?: { rate: number; rates: readonly number[]; disabled: boolean; onRate(rate: number): void };
}) {
  const { t } = useCopy();
  const directSelected = receiving?.mode === "direct" && !originalPage;
  const id = useId(), trigger = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(trigger, panel, { side: "above", align: "end" });
  return <span ref={trigger} className="c3-watch-settings"><Btn icon="sliders" quiet title="playback.more" popoverTarget={id} />
    <div ref={panel} id={id} popover="auto" role="dialog" className="lr-floating-surface lr-playback-menu c3-watch-receiving" aria-label={t("playback.more")}>
      {audio && <div className="c3-watch-volume lr-audio-settings"><AudioVolumeControl {...audio} /></div>}
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
export function ChannelWatchVideo({ player, owned, paused, label, presentation, theaterMode, onToggleTheater, onPlayback, onResume, disabled, website, originalPageAvailable, originalPageUnavailable, onAppWatch, onFocusWindow, receiving, retryPending, automaticPlayback = true, nativeStage = false }: {
  player: WatchPlayer; owned: boolean; paused: boolean; label: string; presentation: "full" | "thumbnail" | "background";
  theaterMode: boolean; onToggleTheater(): void; disabled: boolean;
  onPlayback(patch: Partial<Pick<WatchPlayback, "paused" | "position" | "rate">>): void; onResume(): void;
  website: boolean; originalPageAvailable: boolean; originalPageUnavailable?: string; onAppWatch?: () => void; onFocusWindow(): void;
  receiving?: WatchReceiving;
  retryPending?: boolean;
  automaticPlayback?: boolean;
  nativeStage?: boolean;
}) {
  const { lang, t } = useCopy();
  const slot = useRef<HTMLDivElement>(null), controls = useRef<HTMLDivElement>(null);
  const videoRef = useMemo(() => ({ current: player.video }), [player]);
  const snapshot = () => player.mediaState;
  const mediaState = useSyncExternalStore(player.subscribeMedia, snapshot, snapshot);
  const surface = player.presentation, embedded = surface.kind === "embed";
  const pageId = surface.kind === "external" && nativeStage && presentation === "full" && !player.error &&
    typeof window !== "undefined" && window.piikMountWatchPage && player.media.page?.selectedCandidateId ? player.media.page.id : undefined;
  const native = useWatchPageSlot(pageId);
  const audioTracks = player.media.audioTracks?.() ?? [];
  const audioOptions = audioTracks.map(track => ({ ...track, label: [mediaLanguageLabel(track.language, lang) || track.name,
    track.channels ? t("watch.forward.channels", { count: track.channels }) : undefined].filter(Boolean).join(" · ") }));
  const localSeek = player.blockedReason === "local-seek";
  const resumeLabel = localSeek ? "watch.resync" : "watch.resume";
  const outputFailed = useSyncExternalStore(playbackOutput.subscribe, () => playbackOutput.failedFor(player.video), () => false);
  const showOutputRecovery = outputFailed && !player.error && !player.blocked;
  const waiting = player.waitingForPicture && !player.error && !player.blocked;
  const ownerPaused = player.video?.paused ?? mediaState?.paused ?? paused;
  const audioAvailable = player.media.audioAvailable?.() !== false;
  const [htmlMedia, setMedia] = useState({ position: 0, duration: 0, volume: 1, muted: false, rate: 1 });
  const live = mediaState?.live;
  const ended = live ? !live.active : player.video?.ended ?? mediaState?.ended;
  const media = player.video && !live ? htmlMedia : { position: mediaState?.position ?? 0, duration: mediaState?.duration ?? 0,
    rate: mediaState?.rate ?? 1, volume: htmlMedia.volume, muted: htmlMedia.muted };
  const silent = media.muted || media.volume === 0;
  const seekStart = live?.seekable[0]?.[0] ?? 0, seekEnd = live?.seekable.at(-1)?.[1] ?? media.duration;
  const seekAvailable = seekEnd > seekStart && (!live || live.seekable.length > 0);
  const livePosition = live?.active ? live.syncPosition : null;
  const thumbnail = presentation === "thumbnail";
  const showTimeline = !embedded && !thumbnail && seekAvailable;
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const draggingSeek = useRef(false);
  const position = Math.max(seekStart, Math.min(seekPreview ?? media.position, seekEnd || 1));
  const liveOffset = Math.max(0, Math.round(seekEnd - position));
  const timeLabel = live ? t(live.active ? "watch.liveDelay" : "watch.liveRemaining", { seconds: String(liveOffset) })
    : `${formatMediaTime(position)} / ${formatMediaTime(media.duration || Number.NaN)}`;
  const timeReadout = live?.active ? `${t("watch.live")} −${formatMediaTime(liveOffset)}` : timeLabel;
  const [fullscreen, setFullscreen] = useState(() => player.video ? videoFullscreenState(player.video)
    : { supported: false, ready: false, active: false, nativeActive: false });
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const receivingSettings = receiving && (receiving.peerAvailable || receiving.mode === "peer" || surface.kind === "external" && receiving.browserSource) ? receiving : undefined;
  const openOriginal = !owned && website && originalPageAvailable && surface.kind !== "external" ? onAppWatch : undefined;
  const settingsOriginal = !player.error && openOriginal;
  const localControls = !!player.video || !!receivingSettings || !!settingsOriginal || owned && !embedded;
  const hasControls = localControls || !embedded && !thumbnail && !!mediaState;
  const failure = channelErrorPresentation(player.error, t,
    receiving?.mode === "peer" ? "watch.forward.failed" : website && player.video ? "watch.browserFailed" : "watch.failed").message;
  const diagnosis = player.error ? diagnoseChannelFact({ area: "error", code: player.error }) : null;
  const showDiagnosis = presentation === "full" && !retryPending && !receiving?.pending ? diagnosis : null;
  const returnToSource = showDiagnosis && player.error === "watch_media_access_denied" && (owned && !!player.media.page || !!openOriginal);
  const picture = usePictureInPicture(videoRef);
  const windowControls = player.video && {
    picture, canPlay: player.video.readyState >= 2, quiet: true, theaterMode, onToggleTheater, fullscreen, fullscreenFailed,
    toggleFullscreen: () => {
      if (player.video) { setFullscreenFailed(false); void toggleVideoFullscreen(player.video).catch(() => setFullscreenFailed(true)); }
    },
  };
  const localVolume = player.video && audioAvailable ? {
    volume: media.muted ? 0 : media.volume, label: "playback.volumeBasic" as const, max: 1,
    onVolume: (volume: number) => {
      if (player.video) { player.video.volume = volume; player.video.muted = false; }
    },
  } : undefined;
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
    data-diagnosis={showDiagnosis || showOutputRecovery && !thumbnail ? true : undefined}
    data-standalone={!embedded && (!player.video || !!player.error && player.error !== "watch_update_failed") || undefined} data-thumbnail={!embedded && presentation === "thumbnail" || undefined}
    data-controls-hidden={!embedded && visibility.hidden} inert={presentation === "background"}>
    {surface.kind !== "external" && (waiting || showOutputRecovery) && <div className="c3-mini-message">
      {showOutputRecovery ? <div className="c3-frame-wait c3-watch-result c3-watch-output">
        {thumbnail ? <span role="status">{t("voice.output.failed")}</span> : <PlaybackDeviceSelect />}
      </div> : <span className="c3-frame-wait" role="status"><BrandMark size={thumbnail ? 24 : 32} motion="loop" />{t("watch.waiting")}</span>}
    </div>}
    {pageId && <div ref={native.slot} className="c3-watch-native-slot" />}
    {surface.kind === "external" && thumbnail && !player.error && !player.blocked && <div className="c3-watch-page-thumbnail">
      {waiting ? <><BrandMark size={24} motion="loop" /><span role="status">{t("watch.waiting")}</span></>
        : <><Glyph name="globe" size={24} /><span>{t("watch.originalPage")}</span></>}
    </div>}
    {surface.kind === "external" && !thumbnail && !player.error && !player.blocked && !native.mounted &&
      <div className="c3-mini-message"><div className="c3-frame-wait c3-watch-result">
        {waiting && <BrandMark size={32} motion="loop" />}
        <span role={waiting ? "status" : undefined}>{t(waiting ? "watch.waiting" : "watch.inWindow")}</span>
        <Btn icon="window" title="watch.focusWindow" cap="watch.focusWindow" onClick={onFocusWindow} />
      </div></div>}
    {player.error ? <div className="c3-mini-message"><div className="c3-frame-wait c3-watch-result">
      <span role="alert">{!thumbnail && diagnosis ? t(diagnosis.message) : failure}</span>
      {!thumbnail && <>
        {returnToSource && <Btn icon="window" title={owned ? "watch.openedPage" : "watch.openPage"}
          cap={owned ? "watch.openedPage" : "watch.openPage"} tone="primary" disabled={disabled || receiving?.pending}
          onClick={owned ? onFocusWindow : openOriginal} />}
        {!owned && receiving?.mode === "direct" && receiving.browserSource && surface.kind !== "external" &&
          <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact" disabled={disabled || receiving.disabled || receiving.pending}
            busy={receiving.pending} onClick={receiving.onDirect} />}
        {owned && player.media.retainedByteSource && <Btn icon="refresh" title="common.retry" cap="common.retry" size="compact"
          disabled={disabled || retryPending} busy={retryPending} onClick={onResume} />}
        {owned && player.media.page && !returnToSource && <Btn icon="window" title={player.media.retainedByteSource ? "watch.openedPage" : "watch.focusWindow"}
          cap={player.media.retainedByteSource ? "watch.openedPage" : "watch.focusWindow"} onClick={onFocusWindow} />}
        {!owned && website && surface.kind !== "external" && !returnToSource && (openOriginal
          ? <Btn icon="window" title="watch.openPage" cap="watch.openPage" disabled={disabled || receiving?.pending} onClick={openOriginal} />
          : !(receiving?.peerAvailable && receiving.peerSupported) && (originalPageUnavailable
            ? <small>{originalPageUnavailable}</small> : originalPageAvailable && <small>{t("watch.connectApp")}</small>))}
        {receiving && <WatchPeerAction receiving={{ ...receiving, failed: true, disabled: disabled || receiving.disabled }} />}
        {showDiagnosis && <ChannelDiagnosisHelp key={`${player.error}:${player.media.page?.id ?? ""}`} diagnosis={showDiagnosis}
          details={owned && player.media.page && player.error === "watch_media_access_denied" ? ["diagnosis.sourcePageOpen"] : undefined} />}
      </>}
    </div></div>
      : player.blocked && <div className="c3-mini-message"><Btn icon={localSeek ? "refresh" : "play"} title={resumeLabel} cap={resumeLabel} onClick={onResume} /></div>}
    {hasControls && <div ref={controls} className={`c3-mini-controls c3-watch-controls lr-media-toolbar lr-media-controls lr-media-overlay`} role="group" aria-label={t("playback.controls")}>
      {showTimeline && <div className="c3-watch-timeline">
        {owned ? <input className="lr-range" type="range" min={seekStart} max={seekEnd} step="0.1" value={position}
          style={{ "--range-fill": `${100 * (position - seekStart) / (seekEnd - seekStart)}%` } as CSSProperties}
          aria-label={t("watch.seek")} disabled={disabled}
          aria-valuetext={timeLabel} onPointerDown={() => { draggingSeek.current = true; }}
          onInput={event => {
            const requested = Number(event.currentTarget.value);
            if (draggingSeek.current) setSeekPreview(requested);
            else onPlayback({ position: live ? watchSeekPosition(requested, live.seekable, requested - position) : requested });
          }}
          onPointerUp={event => { draggingSeek.current = false; onPlayback({ position: Number(event.currentTarget.value) }); setSeekPreview(null); }}
          onPointerCancel={() => { draggingSeek.current = false; setSeekPreview(null); }} />
          : <progress className="lr-range" max={seekEnd - seekStart} value={position - seekStart}
            aria-label={t("watch.following")} aria-valuetext={timeLabel} />}
      </div>}
      <div className="c3-watch-actions">
        {!embedded && <div className="c3-watch-shared" role="group" aria-label={t(owned ? "watch.sharedControls" : "watch.following")}>
          {owned && <Btn icon={ownerPaused ? "play" : "pause"} quiet size="dense"
            title={ownerPaused ? "watch.play" : "watch.pause"} disabled={disabled} onClick={() => onPlayback({ paused: !ownerPaused })} />}
          {!thumbnail && <div className="c3-watch-position" data-seeking={seekPreview !== null || undefined}>
            {ended && <span className="c3-watch-status" role="status">{t("watch.ended")}</span>}
            {live?.active && !seekAvailable && <span className="c3-watch-status">{t("watch.live")}</span>}
            {(!live || seekAvailable) && <span className="c3-watch-time" data-live={!!live || undefined} title={timeLabel}>{live ? timeReadout : <><strong>{formatMediaTime(position)}</strong>{` / ${formatMediaTime(media.duration || Number.NaN)}`}</>}</span>}
          </div>}
          {owned && livePosition !== null && <Btn icon="arrowRight" quiet size="dense" title="watch.goLive" textTooltip
            disabled={disabled} onClick={() => onPlayback({ position: livePosition, paused: false })} />}
        </div>}
        {localControls && <div className="c3-watch-local">
          {localVolume &&
            <Btn icon={silent ? "speakerOff" : "speaker"} quiet size="dense" title={silent ? "playback.unmute" : "playback.mute"}
              onClick={() => { const video = player.video; if (!video) return; if (video.volume === 0) video.volume = 1; video.muted = !silent; }} />}
          {localVolume && !thumbnail && <span className="c3-watch-inline-volume">
            <AudioVolumeControl {...localVolume} compact />
          </span>}
          <WatchPlaybackSettings originalPage={surface.kind === "external"} receiving={receivingSettings} audio={localVolume} audioAvailable={audioAvailable}
            playback={owned && !embedded ? { rate: media.rate, rates: player.media.playbackRates?.() ?? [0.5, 0.75, 1, 1.25, 1.5, 2], disabled,
              onRate: rate => onPlayback({ rate }) } : undefined}>
            {settingsOriginal && <Btn icon="window" quiet title="watch.openPage" cap="watch.openPage" size="compact"
              disabled={disabled || receiving?.disabled || receiving?.pending} onClick={settingsOriginal} />}
            {(surface.kind === "embed" || surface.kind === "external") && <small>{t("voice.output.external")}</small>}
            {audioTracks.length > 0 && <label className="c3-watch-audio"><span>{t("watch.audioTrack")}</span>
              <select className="lr-select" aria-label={t("watch.audioTrack")} value={audioTracks.find(track => track.selected)?.id ?? ""} disabled={audioTracks.length === 1}
                onChange={event => player.media.selectAudioTrack?.(Number(event.target.value))}>
                {audioOptions.map(track => <option key={track.id} value={track.id}>{audioOptions.some(other => other.id !== track.id && other.label === track.label)
                  ? `${track.label} — ${track.name}` : track.label}</option>)}
              </select></label>}
            {owned && player.media.page && <Btn icon="window" quiet title={player.video ? "watch.openedPage" : "watch.focusWindow"}
              cap={player.video ? "watch.openedPage" : "watch.focusWindow"} onClick={onFocusWindow} />}
            {windowControls && <div className="c3-watch-settings-window">
              <b>{t("playback.viewControls")}</b>
              <PlaybackWindowControls {...windowControls} group={thumbnail ? "all" : "display"} />
            </div>}
          </WatchPlaybackSettings>
          {!thumbnail && windowControls && <span className="c3-watch-wide-windows">
            <PlaybackWindowControls {...windowControls} group="display" />
          </span>}
          {!thumbnail && windowControls && fullscreen.supported && <PlaybackWindowControls {...windowControls} group="fullscreen" />}
        </div>}
      </div>
    </div>}
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
  issue(input: ChannelScreenInput, element: HTMLVideoElement, error: unknown, playbackError?: ScreenPlaybackError): void;
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
    onEnded={() => playing(input, true)} onError={event => {
      const element = event.currentTarget;
      issue(input, element, element.error, elementPlaybackError(element.error));
    }}
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

export function ChannelVideo({ stream, owned, localSource, sourcePaused = false, label, presentation = "full", inputs, onPresentation, input, interaction = null, buffering, onRetryPicture, retryAvailable = true, theaterMode, onToggleTheater }: {
  stream: MediaStream; owned: boolean; localSource: boolean; label: string; inputs?: readonly ChannelScreenInput[];
  presentation?: "full" | "thumbnail" | "background"; sourcePaused?: boolean;
  input?: InputTransport;
  buffering?: PlaybackSettingsProps["buffering"];
  onRetryPicture?(): void; retryAvailable?: boolean;
  interaction?: RoomInteractionSession | null;
  theaterMode: boolean; onToggleTheater(): void;
  onPresentation?: ChannelActions["screenPresentation"];
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
  const issue = useCallback((input: ChannelScreenInput, element: HTMLVideoElement, error: unknown, playbackError?: ScreenPlaybackError) => {
    const failure = playbackFailure(error);
    if (!failure || consumers.current.get(input.stream)?.element !== element) return;
    const state = current.current;
    const displayed = state.displayed.flowId === input.flowId && state.displayed.stream === input.stream;
    if (displayed) setBlocked(true);
    if (failure === "playback-failed" && state.inputs?.some(value => value.flowId === input.flowId && value.stream === input.stream)) {
      state.onPresentation?.(input.flowId, input.stream, "failed", displayed ? playbackError : undefined);
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
    <RoomChatOverlay session={interaction} visible={interactive && ready && !blocked && !paused && !sourcePaused} />
    {(sourcePaused || !ready && !blocked) && <div className="c3-mini-message" data-source-paused={sourcePaused || undefined} role="status">
      <span className="c3-frame-wait">{sourcePaused ? <Glyph name="pause" size={24} /> : <BrandMark size={32} motion="loop" />}
        {t(sourcePaused ? "host.pauseNotice" : "screen.waitingPicture")}</span>
    </div>}
    {blocked && !sourcePaused && <div className="c3-mini-message"><Btn icon="play" title="playback.play" cap="playback.play"
      onClick={play} hint="hint-local-play" /></div>}
    <div id={controlsId} ref={controls} className="c3-mini-controls lr-media-toolbar lr-media-overlay lr-media-controls" role="group" aria-label={t("playback.controls")}>
      <Btn icon={paused ? "play" : "pause"} title={paused ? "playback.play" : "playback.pause"} quiet
        hint={paused ? "hint-local-play" : "hint-local-pause"} onClick={() => { if (ref.current?.paused) play(); else ref.current?.pause(); }} />
      {!localSource && <>
        <Btn icon={!hasAudio || silent ? "speakerOff" : "speaker"} quiet
          title={!hasAudio ? "playback.noAudio" : silent ? "playback.unmute" : "playback.mute"}
          hint={!hasAudio ? "hint-no-audio" : silent ? "hint-unmute" : "hint-mute"}
          disabled={!hasAudio} tone={silent ? "on" : undefined}
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
      {!owned && <PlaybackControlsAttention.Provider value={visibility.setAttention}>
        <RemoteControl channel={input ?? null} videoRef={playbackRef} available={interactive && ready && !sourcePaused && displayed.flowId === target.flowId}
        pictureFit={pictureFit} pictureRotation={pictureRotation} touchMode={remoteTouchMode}
        readStickPositions={readStickPositions} onStickPositionChange={(side, position) => {
          saveRoomPreferences({ stickPositions: { ...readStickPositions(), [side]: position } });
        }} />
      </PlaybackControlsAttention.Provider>}
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

export function ChannelAudio({ publicationId, stream, muted, volume, voiceContext, label, onRendering }: {
  publicationId: string; stream: MediaStream; muted: boolean; volume: number; voiceContext: VoicePlaybackContext; label: string;
  onRendering(publicationId: string, stream: MediaStream, state: VoiceRendering | undefined): void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const output = useRef<ViewerAudio | null>(null);
  const playing = useRef(false);
  const outputReady = useRef(false);
  const [blocked, setBlocked] = useState(false);
  const { t } = useCopy();
  const track = stream.getAudioTracks()[0];
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    // Room and person levels each range from 0 to 2, as in the shared voice sink.
    playing.current = false;
    const playback = output.current = new ViewerAudio(element, () => {}, voiceContext, 4, ready => {
      outputReady.current = ready;
      if (playing.current && !element.paused) onRendering(publicationId, stream, ready ? "playing" : "blocked");
    });
    playback.bind(stream);
    let current = true;
    setBlocked(false);
    void element.play().catch(error => {
      if (!current || error?.name === "AbortError") return;
      setBlocked(true);
      onRendering(publicationId, stream, "blocked");
    });
    return () => {
      current = false;
      playing.current = false;
      onRendering(publicationId, stream, undefined);
      playback.dispose();
      output.current = null;
      element.pause();
      element.srcObject = null;
    };
  }, [publicationId, stream, track, voiceContext, onRendering]);
  useEffect(() => { output.current?.setLevel(volume); output.current?.setMuted(muted); }, [stream, track, volume, muted]);
  const stopRendering = () => {
    playing.current = false;
    onRendering(publicationId, stream, undefined);
  };
  return <><audio ref={ref} aria-label={label}
    onPlaying={() => {
      playing.current = true;
      setBlocked(false);
      onRendering(publicationId, stream, outputReady.current ? "playing" : "blocked");
    }} onWaiting={stopRendering}
    onPause={({ currentTarget }) => {
      if (!currentTarget.paused || currentTarget.srcObject !== stream || currentTarget.ended) return;
      playing.current = false;
      setBlocked(true);
      onRendering(publicationId, stream, "blocked");
    }} onEnded={stopRendering} onEmptied={stopRendering} />
    {blocked && <ChannelAction icon="speaker" label={t("screen.playNamed", { label })}
      onClick={() => { void ref.current?.play().catch(() => {}); }} />}</>;
}
