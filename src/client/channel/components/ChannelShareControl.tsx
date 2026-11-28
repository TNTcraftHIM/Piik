import { createPortal } from "react-dom";
import { WatchEmbedPreview } from "./WatchEmbedPreview";
import { canMoveWatchEmbed, watchEmbed } from "../watch-embed-source";
import { directWatchFormat } from "../../../shared/watch-format";
import { WatchIndexedTrackPicker, WatchMpdSourcePicker } from "./WatchIndexedTrackPicker";
import { indexedMediaSelection } from "../watch-indexed-source";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CaptureSourcePicker, RenderEndpointSelect, type NativeSourceList } from "../../components/living/CaptureSourcePicker";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { LiveAudioExclusion } from "../../components/living/AudioExclusionSelect";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { SharingSettings } from "../../components/living/SharingSettings";
import { AudioBitrateControl, QualityPresets, PicturePreferenceControl, PictureSettingsSummary, ResolutionControl, VideoRateControls, VideoCodecControl, EncodingExecutionControl } from "../../components/living/QualityPresets";
import { ShareMicrophoneSettings } from "../../components/living/ShareMicrophoneSettings";
import { QUALITY_PROFILES, VIDEO_CAPTURE_LIMITS, captureFramerateCeiling, matchingQualityProfileId, type QualityProfile } from "../../media/quality";
import { activateNativePicker } from "../../native/activation";
import type { AppPageMediaSelection, NativeCaptureSources } from "../app-link";
import type { ChannelController } from "../types";
import { directForwardMediaURL, type WatchMediaSources } from "../watch-page-media";
import { screenTitle } from "../presentation";
import { useLayerHistory } from "../../ui/layer-history";
import { channelErrorPresentation } from "../../components/error-presentation";
import { diagnoseChannelFact } from "../../ui/diagnosis";
import { ChannelDiagnosisHelp } from "../../components/ChannelDiagnosisHelp";
import { ChannelSettingsDialog, ChannelSettingsError } from "./ChannelSettingsDialog";
import { useSettingsAction } from "../../ui/use-settings-action";
import { ChannelExternalInput } from "./ChannelExternalInput";
import { ChannelAction } from "./ChannelAction";
import { DEFAULT_RELAY_CAPACITY, MAX_RELAY_CAPACITY, MAX_WATCH_URL_LENGTH, watchSourceSchema, type ChannelPublication } from "../protocol";
import "./channel-share-control.css";
import "./channel-interface-control.css";
import { CaptureSourceCard } from "../../components/living/CaptureSourceCard";
import { BrandLoader } from "../../components/living/BrandMark";

function ScreenDirectLimit({ sharing, channel, roomLimit, disabled }: {
  sharing: Extract<ChannelPublication, { kind: "screen" }>; channel: ChannelController; roomLimit: number; disabled: boolean;
}) {
  const { t } = useCopy();
  const { error, run } = useSettingsAction();
  const pending = channel.pending.has(`direct-limit:${sharing.id}`);
  return <div aria-busy={pending}>
    <label className="c3-interface-choice">
      <span>{t("screen.directLimit")}</span>
      <select className="lr-select" value={sharing.directLimit ?? ""} disabled={disabled || pending}
        onChange={event => {
          const value = event.target.value;
          void run(() => channel.setScreenDirectLimit(sharing.id, value === "" ? null : Number(value)));
        }}>
        <option value="">{t("screen.directLimitDefault", { count: String(roomLimit) })}</option>
        {Array.from({ length: MAX_RELAY_CAPACITY }, (_, index) => index + 1).map(limit =>
          <option key={limit} value={limit}>{limit}</option>)}
      </select>
    </label>
    <p>{t("screen.directLimitHelp")}</p>
    {pending && <p role="status">{t("common.loading")}</p>}
    <ChannelSettingsError error={error} />
  </div>;
}

function ShareTitleEditor({ sharing, channel, disabled }: {
  sharing: Extract<ChannelPublication, { kind: "screen" }>; channel: ChannelController; disabled: boolean;
}) {
  const { t } = useCopy();
  const id = useId(), details = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState("");
  const { error, run } = useSettingsAction(open);
  const pending = channel.pending.has(`title:${sharing.id}`);
  const automatic = screenTitle({ ...sharing, title: null }, t);
  const { message } = channelErrorPresentation(error, t);
  const close = () => {
    const disclosure = details.current;
    if (!disclosure) return;
    if (disclosure.contains(disclosure.ownerDocument.activeElement)) summary.current?.focus({ preventScroll: true });
    disclosure.open = false;
  };
  return <details ref={details} className="c3-share-title" onToggle={event => {
    if (event.target !== event.currentTarget) return;
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setDraft(sharing.title ?? "");
  }}>
    <summary ref={summary}>{t("screen.shareTitle")}</summary>
    {open && <form onSubmit={event => {
      event.preventDefault();
      if (!disabled && !pending) void run(() => channel.setScreenTitle(sharing.id, draft.trim() || null), close);
    }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <label htmlFor={id}>{t("screen.shareTitle")}</label>
      <span className="lr-input"><input id={id} value={draft} maxLength={64} placeholder={automatic}
        autoComplete="off" disabled={disabled || pending} onChange={event => setDraft(event.target.value)} aria-describedby={`${id}-help`} /></span>
      <p id={`${id}-help`}>{t("screen.shareTitleHelp")}</p>
      <div className="c3-share-title-actions">
        <Btn icon="check" type="submit" cap={{ text: t("screen.save") }} title={{ text: t("screen.saveTitle") }}
          tone="primary" size="compact" busy={pending} disabled={disabled || pending} />
        <Btn icon="x" cap="common.cancel" title="common.cancel" quiet size="compact" disabled={pending} onClick={close} />
      </div>
      {message && <p className="c3-settings-error" role="alert">{message}</p>}
    </form>}
  </details>;
}

export type WatchReplacement = { activityId: string; onOtherSources(): void };

/** The picker closes before a start runs and this control can unmount with it, so a mounted owner supplies startAction. */
export function ChannelShareControl({ channel, roomId, publicationId, watchActivityId, compact = false, variant, publicationActions, compactCaption, disabled, openRequested, onPickerRequestHandled, onWatch, startAction, onStopScreen }: {
  channel: ChannelController; roomId: string; publicationId?: string; watchActivityId?: string; compact?: boolean; variant?: "split"; publicationActions?: ReactNode; compactCaption?: boolean; disabled: boolean;
  openRequested?: boolean; onPickerRequestHandled?(): void; onWatch(replacement?: WatchReplacement): void;
  onStopScreen(roomId: string, publicationId: string): Promise<void>;
  startAction: ReturnType<typeof useSettingsAction>;
}) {
  const { t } = useCopy();
  const settingsLabel = t("screen.shareSettings");
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const settingsTrigger = useRef<HTMLSpanElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [otherSourcesRequested, setOtherSourcesRequested] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useLayerHistory(panel, open);
  useLayerHistory(settingsPanel, settingsOpen);
  const [externalOpen, setExternalOpen] = useState(false);
  const [sources, setSources] = useState<Exclude<NativeSourceList, { kind: "ready" }> | ({ kind: "ready" } & NativeCaptureSources)>({ kind: "browser" });
  const { appConnected, nativeSources, startNativeScreen, startScreen } = channel;
  const browserSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const cameraSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
  const captureRequest = channel.nativeCaptureRequest(roomId);
  const selectedNative = channel.nativeCaptureSelection(roomId);
  const externalInput = channel.externalInput(roomId);
  const sharing = watchActivityId ? undefined : channel.state?.publications.find(publication => publication.kind === "screen" &&
    (!publicationId || publication.id === publicationId) && publication.roomId === roomId && channel.ownedScreens.has(publication.id));
  const watching = watchActivityId ? channel.state?.watchActivities.find(activity =>
    activity.id === watchActivityId && activity.roomId === roomId && activity.sessionId === channel.sessionId) : undefined;
  const pageWatch = watching && !!channel.watchPlayers.get(watching.id)?.media.page;
  const room = channel.state?.channel.rooms.find(room => room.id === roomId);
  const roomName = room?.name;
  const settingsTitle = sharing && roomName
    ? t("screen.shareSettingsInRoom", { room: roomName })
    : settingsLabel;
  const currentCamera = sharing ? channel.streams.get(sharing.id)?.getVideoTracks()
    .find(track => track.readyState === "live")?.getSettings().deviceId : undefined;
  const activeCodec = sharing ? channel.screenCodec(sharing.id) : undefined;
  const codecMode = activeCodec?.mode ?? channel.videoCodecMode;
  const sourceCodec = activeCodec?.primary ?? codecMode;
  const encoderLocked = sharing ? t("host.advanced.lockedWhileSharing") : undefined;
  const encodingExecution = (sharing ? channel.screenEncodingExecution(sharing.id) : undefined) ?? channel.encodingExecution;
  const canChooseExecution = sources.kind === "ready" && sources.softwareEncodingCodecs.includes("h264")
    && (sourceCodec === "auto" || sourceCodec === "h264")
    && (sharing ? !!selectedNative?.current && !externalInput : sources.sources.length > 0 && !externalInput);
  const pickerSources: NativeSourceList = !appConnected && sources.kind === "ready" ? { kind: "unavailable" } : sources.kind === "ready" &&
    !(sourceCodec === "auto" ? sources.codecs.length > 0 : sources.codecs.includes(sourceCodec))
    ? { kind: "unsupported" } : sources;
  const screenQuality = sharing ? channel.screenQuality(sharing.id) : undefined;
  const quality = screenQuality?.requested ?? channel.quality;
  const qualityAction = useSettingsAction(settingsOpen, sharing?.id);
  const setQuality = (profile: QualityProfile) => {
    if (sharing) void qualityAction.run(() => channel.setScreenQuality(sharing.id, profile));
    else channel.setQuality(profile);
  };
  const qualityPending = !!sharing && channel.pending.has(`quality:${sharing.id}`);
  const sourceAudio = sharing ? channel.sourceAudio(sharing.id) : undefined;
  const systemAudioActive = sourceAudio?.sourceAudioAvailable === true;
  const canChoosePreference = sources.kind === "ready" && sources.videoAdaptation
    || !selectedNative?.current && (!appConnected || !!sharing);
  const microphone = sharing ? channel.sourceMicrophone(sharing.id) : undefined;
  const microphoneSettings = microphone?.requested ?? microphone;
  const microphonePending = !!sharing && channel.pending.has(`source-microphone:${sharing.id}`);
  const { sourceMicrophones } = channel;
  const loadAudioApplications = useCallback(async (signal: AbortSignal) => (await nativeSources(signal)).sources, [nativeSources]);
  const sharingId = sharing?.id;
  const loadMicrophones = useCallback((signal?: AbortSignal) => sharingId ? sourceMicrophones(sharingId, signal) : Promise.resolve([]), [sharingId, sourceMicrophones]);
  const roomMicrophone = channel.state?.voice.some(voice => voice.sessionId === channel.sessionId && !voice.muted);
  const sourcePending = channel.pending.has(`screen:${roomId}`);
  const busy = sourcePending || !!sharing && channel.pending.has(`source-audio:${sharing.id}`);
  const canOpenSourcePicker = !captureRequest && !disabled && !busy && !qualityPending && !microphonePending;
  const cancellable = !!captureRequest || sourcePending && !channel.sourceSelectionCommitting(roomId);
  const preparation = channel.browserCapturePreparation(roomId);
  const directLimit = settingsOpen && sharing?.kind === "screen" ? <ScreenDirectLimit key={sharing.id} sharing={sharing} channel={channel}
    roomLimit={room?.relayCapacity ?? DEFAULT_RELAY_CAPACITY} disabled={disabled || busy} /> : undefined;
  const label = t(sharing || watching ? "host.switchSource" : "host.start");
  const sourceTitle = sharing && roomName
    ? t("screen.switchRoomSource", { room: roomName })
    : label;
  // The inner grid scrolls independently, so its clipped outer scrollHeight cannot size placement.
  const sourceButton = useCallback(() => trigger.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]'), []);
  useAnchoredPopover(trigger, panel, { maxHeight: 560, preferredHeight: 560, minVisibleHeight: 360, returnFocus: sourceButton });
  useAnchoredPopover(settingsTrigger, settingsPanel, { maxHeight: 640, preferredHeight: 640, minVisibleHeight: 240 });
  const closePicker = useCallback(() => panel.current?.hidePopover(), []);
  const close = useCallback(() => { closePicker(); settingsPanel.current?.hidePopover(); }, [closePicker]);
  const refresh = useCallback(() => {
    request.current?.abort();
    const current = request.current = new AbortController();
    setSources(previous => ({ kind: "loading", appDetected: true,
      sources: "sources" in previous ? previous.sources : undefined }));
    void nativeSources(current.signal).then(result => {
      if (!current.signal.aborted) setSources({ kind: "ready", ...result });
    }, error => {
      if (current.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        setSources({ kind: "unavailable" });
        return;
      }
      const code = error instanceof Error ? error.message : "";
      setSources(previous => code === "app_disconnected" || code === "app_context_changed"
        ? { kind: "unavailable" }
        : { kind: "failed", error: code, sources: "sources" in previous ? previous.sources : undefined });
    }).finally(() => {
      if (request.current === current) request.current = null;
    });
  }, [nativeSources]);
  const settingsNeedSources = settingsOpen && !watching && externalInput?.state !== "live"
    && (!sharing || selectedNative?.current === true);
  useEffect(() => {
    return () => { request.current?.abort(); request.current = null; };
  }, [open, settingsNeedSources, refresh]);
  useEffect(() => {
    if (appConnected && (open || settingsNeedSources) && !request.current) refresh();
    if (!appConnected && !request.current) {
      setSources(previous => {
        if (previous.kind === "browser" || (open && previous.kind === "unavailable")) return previous;
        return open ? { kind: "unavailable" } : { kind: "browser" };
      });
    }
  }, [open, settingsNeedSources, appConnected, refresh]);
  useLayoutEffect(() => { close(); }, [roomId, publicationId, watchActivityId, disabled, close]);
  useEffect(() => { setExternalOpen(false); }, [roomId]);
  useEffect(() => {
    if ((!openRequested && !otherSourcesRequested) || !panel.current) return;
    const source = sourceButton();
    if (canOpenSourcePicker && source) {
      source.scrollIntoView({ block: "nearest" });
      panel.current.showPopover({ source });
    }
    if (openRequested) onPickerRequestHandled?.();
    if (otherSourcesRequested) setOtherSourcesRequested(false);
  }, [openRequested, otherSourcesRequested, canOpenSourcePicker, onPickerRequestHandled, sourceButton]);
  const openWatchSource = () => {
    close();
    sourceButton()?.focus({ preventScroll: true });
    onWatch(watching ? { activityId: watching.id, onOtherSources: () => setOtherSourcesRequested(true) } : undefined);
  };
  // A result its owner can no longer receive, after a room change, still reaches the banner.
  const start = (operation: (reportError: () => boolean) => Promise<void>, onSuccess?: () => void) => {
    close();
    void startAction.run(signal => operation(() => signal.aborted), onSuccess);
  };
  const inlineActions = useRef<HTMLSpanElement>(null), panelActions = useRef<HTMLDivElement>(null);
  const [actionsHost, setActionsHost] = useState<HTMLSpanElement | null>(null);
  const hasPublicationActions = !!publicationActions;
  useLayoutEffect(() => {
    if (!hasPublicationActions || !inlineActions.current) return;
    const host = inlineActions.current.ownerDocument.createElement("span");
    host.className = "c3-share-live-actions";
    inlineActions.current.append(host);
    setActionsHost(host);
    return () => host.remove();
  }, [hasPublicationActions, sharing?.id]);
  useLayoutEffect(() => {
    const target = compactCaption && !captureRequest && !cancellable ? panelActions.current : inlineActions.current;
    if (!actionsHost || !target || actionsHost.parentElement === target) return;
    // Finish the open settings or picker at its original anchor. The portal keeps
    // the controls and any remote-input draft mounted when their home changes.
    if (settingsOpen || open) return;
    const place = () => {
      if (actionsHost.parentElement === target || actionsHost.querySelector(":popover-open:not([role=tooltip])")) return;
      if ("moveBefore" in target) target.moveBefore(actionsHost, null);
      else {
        const focused = actionsHost.ownerDocument.activeElement;
        (target as HTMLElement).append(actionsHost);
        if (focused instanceof HTMLElement && actionsHost.contains(focused)) {
          (focused.checkVisibility() ? focused : settingsTrigger.current?.querySelector("button"))?.focus({ preventScroll: true });
        }
      }
    };
    place();
    actionsHost.addEventListener("toggle", place, true);
    return () => actionsHost.removeEventListener("toggle", place, true);
  }, [actionsHost, compactCaption, captureRequest, cancellable, settingsOpen, open]);
  if ((publicationId && !sharing) || (watchActivityId && !watching)) return null;
  const hasSettings = !watching || !!sharing || pageWatch;
  const split = variant === "split" && hasSettings && !captureRequest && !cancellable;
  const actionTone = sharing || watching ? undefined : "primary";
  const tonal = split && !actionTone ? " is-tonal" : "";
  const cancelId = `${id}-cancel`;
  const sourceControl = <span ref={trigger} className="c3-share-control">
    {captureRequest ? <span className="c3-app-confirmation">
        <Btn icon="window" title="native.confirmInApp" cap="native.confirmInApp" size="compact" tone="primary"
          onClick={() => activateNativePicker(captureRequest.activationURL)} />
      </span> : <Btn icon={sharing || watching ? "switchSource" : "cast"} title={{ text: sourceTitle }} cap={compact ? undefined : { text: label }}
      className={split ? "is-split-main" + tonal : undefined} size="compact" tone={actionTone} quiet={!split && compact}
      hint={sharing || watching ? "hint-switch-source" : "hint-share-start"}
      disabled={!canOpenSourcePicker} busy={sourcePending} expanded={watching ? undefined : open}
      hasPopup="dialog" controls={watching ? undefined : id} popoverTarget={watching ? undefined : id}
      onClick={watching ? openWatchSource : undefined} />}
    {cancellable && <Btn id={cancelId} icon="x" title={preparation ? "host.capture.cancelPreparation" : "common.cancel"}
      cap={preparation ? "host.capture.cancelPreparation" : "common.cancel"} size="compact" quiet
      onClick={() => {
        const ownerDocument = trigger.current?.ownerDocument;
        const cancelButton = ownerDocument?.getElementById(cancelId);
        void channel.cancelScreenSelection(roomId).catch(() => {}).finally(() => {
          ownerDocument?.defaultView?.requestAnimationFrame(() => {
            const { activeElement, body } = ownerDocument;
            if (activeElement === body || activeElement === cancelButton) sourceButton()?.focus({ preventScroll: true });
          });
        });
      }} />}
  </span>;
  const panelHasActions = compactCaption && hasPublicationActions && !captureRequest && !cancellable;
  const settingsUnavailable = !!(disabled || busy || qualityPending);
  const settingsControl = hasSettings && <span ref={settingsTrigger} className="c3-share-control">
    <Btn icon={split ? "chevron" : "sliders"} title={{ text: settingsTitle }} cap={compact || split ? undefined : { text: settingsLabel }}
      className={split ? "is-split-more" + tonal : undefined} hint="hint-quality" size="compact" quiet={!split} tone={split ? actionTone : undefined}
      disabled={!panelHasActions && settingsUnavailable} busy={!panelHasActions && qualityPending} hasPopup="dialog" popoverTarget={`${id}-settings`} controls={`${id}-settings`} expanded={settingsOpen} />
  </span>;
  return <>{actionsHost && createPortal(<>{sourceControl}{publicationActions}</>, actionsHost)}
    <span className="c3-share-feedback" data-publication-actions={hasPublicationActions || undefined}><span className="c3-share-actions" role="group" aria-label={t("screen.screenSharing")}>
    {variant === "split" ? <span className={split ? "lr-btn-split" : "c3-share-unpaired"}>{sourceControl}{settingsControl}</span>
      : <>{hasPublicationActions ? <span ref={inlineActions} className="c3-share-inline-actions" /> : sourceControl}{settingsControl}</>}
    {externalInput && <ChannelAction icon="cast" label={externalInput.state === "live" ? "OBS" : t("screen.obsWaiting")}
      quiet onClick={() => setExternalOpen(true)} />}
    </span>
    {preparation ? <span className="c3-share-wait" role="status" aria-live="polite">
      <span>{t(preparation === "picker" ? "host.capture.chooseInSystem" : "host.capture.preparingPicture")} {t("host.capture.cancelPreparationHint")}</span>
    </span> : startAction.error && <span className="c3-share-wait c3-share-failure">
      <ChannelSettingsError error={startAction.error} />
      <Btn icon="x" title="notice.dismiss" hint="hint-close" size="dense" quiet onClick={startAction.clearError} />
    </span>}</span>
    <div ref={settingsPanel} id={`${id}-settings`} popover="auto" role="dialog" aria-label={settingsTitle} className="lr-anchored-card c3-quality-picker"
      onToggle={event => { if (event.target === event.currentTarget) setSettingsOpen(event.newState === "open"); }}>
      <header className="c3-quality-heading"><h3>{watching ? t("watch.forward.title") : settingsLabel}</h3>
        <ChannelAction icon="x" iconOnly quiet textTooltip label={t("room.action.close")}
          onClick={() => settingsPanel.current?.hidePopover()} /></header>
      <div className="c3-quality-body">
      {hasPublicationActions && <div ref={panelActions} className="c3-share-publication-actions" role="group" aria-label={t("host.shareControls")} />}
      <div className="c3-share-settings-content" inert={!!hasPublicationActions && settingsUnavailable}>
      {watching ? settingsOpen && <WatchForwardSettings channel={channel} activityId={watching.id} disabled={disabled} /> : <>
      <div className="c3-quality-description">{sharing ? t("screen.shareSettingsHelp", { room: roomName ?? t("screen.currentRoom") })
        : t("screen.shareSettingsNext")}<ChannelSettingsError error={qualityAction.error} /></div>
      {settingsOpen && sharing?.kind === "screen" && <ShareTitleEditor key={sharing.id} sharing={sharing} channel={channel} disabled={disabled || busy} />}
      {externalInput?.state === "live" ? <div className="c3-settings-panels"><p>{t("screen.obsQualityHelp")}</p>
        <ChannelAction icon="cast" label={t("screen.obsSettings")} onClick={() => { close(); setExternalOpen(true); }} />
        {directLimit && <details className="lr-sharing-connection"><summary>{t("host.settings.connection")}</summary>{directLimit}</details>}
      </div>
        : <SharingSettings id={`${id}-quality`} open={settingsOpen} busy={qualityPending || microphonePending} connection={directLimit}
        presets={<QualityPresets selected={matchingQualityProfileId(quality)} disabled={busy} busy={qualityPending}
          onSelect={preset => setQuality({ ...QUALITY_PROFILES[preset], maxAudioBitrate: quality.maxAudioBitrate })} />}
        pictureSummary={<PictureSettingsSummary value={screenQuality?.applied ?? quality} />}
        picture={<>{canChoosePreference && <PicturePreferenceControl value={quality.degradationPreference} disabled={busy || qualityPending}
          onChange={degradationPreference => setQuality({ ...quality, degradationPreference })} />}
          <ResolutionControl value={quality.resolution} limits={VIDEO_CAPTURE_LIMITS} disabled={busy}
          onChange={resolution => setQuality({ ...quality, resolution,
            maxFramerate: Math.min(quality.maxFramerate, captureFramerateCeiling(resolution, VIDEO_CAPTURE_LIMITS)) })} />
          <VideoRateControls value={quality} limits={VIDEO_CAPTURE_LIMITS} disabled={busy}
            onChange={next => setQuality({ ...quality, ...next })} />
          <VideoCodecControl value={codecMode} lockedReason={encoderLocked}
            disabled={disabled || busy || !!captureRequest} onChange={channel.setVideoCodecMode} />
          {canChooseExecution && <EncodingExecutionControl value={encodingExecution} lockedReason={encoderLocked}
            disabled={disabled || busy || !!captureRequest} onChange={channel.setEncodingExecution} />}</>}
        audio={<>
          {sharing && selectedNative?.current && selectedNative.target.kind === "display" && sources.kind === "ready" && sources.systemAudio &&
            <div className="lr-door-group lr-source-audio-settings">
              <SwitchItem checked={systemAudioActive} label={t("host.sourcePicker.systemAudio")}
                hint={systemAudioActive ? "hint-stop-audio" : "hint-share-audio"}
                disabled={disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={audio => { void startNativeScreen(roomId, { ...selectedNative, audio }).catch(() => {}); }} />
              {!selectedNative.excludeAudio && sources.renderEndpoints !== undefined && <RenderEndpointSelect onRefresh={refresh} devices={sources.renderEndpoints} value={selectedNative.renderEndpointId}
                disabled={!selectedNative.audio || disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={id => { void startNativeScreen(roomId, { ...selectedNative, audio: true, excludeAudio: undefined, renderEndpointId: id }).catch(() => {}); }} />}
              {!selectedNative.renderEndpointId && sources.processAudioExclusion && <LiveAudioExclusion initialSources={sources.sources} load={loadAudioApplications} value={selectedNative.excludeAudio}
                disabled={!selectedNative.audio || disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={excludeAudio => { void startNativeScreen(roomId, { ...selectedNative, audio: true, excludeAudio, renderEndpointId: undefined }).catch(() => {}); }} />}
            </div>}
          {sharing && microphone && microphoneSettings && <ShareMicrophoneSettings available={microphone.available}
            canDisable={microphone.canDisable}
            enabled={microphone.enabled} disabled={disabled || busy} busy={microphonePending} browser={microphone.browser}
            roomMicrophone={roomMicrophone} volume={microphoneSettings.volume} deviceId={microphoneSettings.deviceId}
            voiceProcessing={microphoneSettings.voiceProcessing} loadDevices={loadMicrophones}
            onEnabled={enabled => { void channel.setSourceMicrophone(sharing.id, { enabled }).catch(() => {}); }}
            onVolume={volume => { void channel.setSourceMicrophone(sharing.id, { volume }).catch(() => {}); }}
            onDevice={deviceId => { void channel.setSourceMicrophone(sharing.id, { deviceId }).catch(() => {}); }}
            onVoiceProcessing={voiceProcessing => { void channel.setSourceMicrophone(sharing.id, { voiceProcessing }).catch(() => {}); }} />}
          <AudioBitrateControl value={sourceAudio?.bitrate ?? quality.maxAudioBitrate ?? 128_000}
          disabled={busy || qualityPending}
          onChange={bitrate => {
            if (sharing) void channel.setSourceAudio(sharing.id, { bitrate }).catch(() => {});
            else setQuality({ ...quality, maxAudioBitrate: bitrate });
          }} /></>} />}</>}
      </div>
      </div>
    </div>
    <div ref={panel} id={id} popover="auto" className="lr-anchored-card c3-share-picker"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      {open && <CaptureSourcePicker roomName={roomName} nativeSources={pickerSources} browserSupported={browserSupported} cameraSupported={cameraSupported}
        loadCameras={channel.cameraPreviews} initialCamera={currentCamera}
        initialTab="window" selectionDisabled={disabled || busy || qualityPending || microphonePending}
        initialAudio={selectedNative?.audio} initialRenderEndpointId={selectedNative?.renderEndpointId} initialExcludeAudio={selectedNative?.excludeAudio} initialShowCaptureBorder={selectedNative?.showCaptureBorder}
        onBrowser={() => start(reportError => startScreen(roomId, "browser", "", reportError))}
        onWatch={openWatchSource}
        onCamera={deviceId => start(reportError => startScreen(roomId, "camera", deviceId, reportError))}
        onExternalInput={channel.externalScreenInputAvailable ? () => {
          close();
          if (externalInput) setExternalOpen(true);
          else start(reportError => channel.startExternalScreen(roomId, reportError), () => setExternalOpen(true));
        } : undefined}
        onNative={selection => start(reportError => startNativeScreen(roomId, selection, reportError))}
        onPreview={channel.nativePreview} onRefresh={refresh} onCancel={closePicker} />}
    </div>
    {externalOpen && externalInput && <ChannelExternalInput input={externalInput} busy={channel.pending.has(`stop:${externalInput.publicationId}`) || channel.sourceSelectionCommitting(roomId)}
      onStop={() => {
        const close = () => setExternalOpen(false);
        if (externalInput.state === "live") { close(); void onStopScreen(roomId, externalInput.publicationId); }
        else void channel.cancelExternalScreen(roomId).then(close).catch(() => {});
      }} onClose={() => setExternalOpen(false)} />}
  </>;
}

function WatchForwardSettings({ channel, activityId, disabled }: { channel: ChannelController; activityId: string; disabled: boolean }) {
  const { t } = useCopy();
  const [sources, setSources] = useState<WatchMediaSources | null>(null);
  const discovery = useRef<AbortController | null>(null);
  useEffect(() => () => discovery.current?.abort(), [activityId]);
  const cancel = () => { discovery.current?.abort(); discovery.current = null; setSources(null); };
  const { error, run } = useSettingsAction();
  const activity = channel.state?.watchActivities.find(value => value.id === activityId);
  const busy = channel.pending.has(`watch-source:${activityId}`);
  const retained = channel.watchPlayers.get(activityId)?.media.retainedByteSource;
  const failure = error ?? sources?.error;
  const forward = (choice: AppPageMediaSelection) => {
    discovery.current?.abort();
    const controller = discovery.current = new AbortController();
    void run(() => channel.setWatchByteSource(activityId, choice, controller.signal));
  };
  return <div className="c3-watch-forward-settings c3-external-input">
    <p>{t("watch.forward.upload")}</p>
    {activity?.byteSource ? <><p role="status">{t("watch.forward.active")}</p>
      <Btn icon="stop" title="watch.forward.stop" cap="watch.forward.stop" disabled={disabled || busy} busy={busy}
        onClick={() => { void run(() => channel.setWatchByteSource(activityId, null), cancel); }} /></>
      : retained ? <Btn icon="share" title="watch.forward.resume" cap="watch.forward.resume" disabled={disabled || busy} busy={busy}
        onClick={() => forward(retained.resourceId)} />
      : sources === null ? <>
        {busy ? <div className="lr-source-picker-status" role="status"><BrandLoader /><span>{t("common.loading")}</span></div>
          : <Btn icon="share" title="watch.forward.prepare" cap="watch.forward.prepare" disabled={disabled}
            onClick={() => { discovery.current?.abort(); const controller = discovery.current = new AbortController();
              const publish = (value: WatchMediaSources) => { if (!controller.signal.aborted) setSources(value); };
              void run(() => channel.watchMediaChoices(activityId, controller.signal, publish), publish); }} />}
        {busy && <Btn icon="x" quiet title="common.cancel" cap="common.cancel" onClick={cancel} />}
      </> : <>
        {sources.choices.length > 0 && <><p>{t("watch.forward.choose")}</p><div className="lr-source-picker-list" data-text-list>
          {sources.choices.map(choice => {
            const source = new URL(choice.displayURL), name = choice.name || source.host;
            return <CaptureSourceCard key={choice.id} title={name} description={source.host + source.pathname}
              action={t("watch.forward.enableNamed", { name })} icon="play" hint="hint-source-picker"
              disabled={disabled || busy} onSelect={() => forward(choice.id)} />;
          })}
        </div></>}
        <WatchIndexedTrackPicker choices={sources.indexed} onRetry={sources.retryIndexed} disabled={disabled} busy={busy}
          onConfirm={(videoId, audioId) => {
            const video = sources.indexed.find(value => value.candidate.id === videoId)?.inspection;
            const audio = audioId ? sources.indexed.find(value => value.candidate.id === audioId)?.inspection : undefined;
            if (video) forward(indexedMediaSelection(video, audio));
          }} />
        {sources.mpd.length > 0 && <WatchMpdSourcePicker choices={sources.mpd} disabled={disabled} busy={busy} onConfirm={forward}
          onInspect={(choiceId, signal) => run(async () => {
            const catalog = await channel.inspectWatchMpdSource(activity!.roomId, choiceId, signal, activityId);
            if (!signal.aborted) setSources(previous => {
              if (!previous) return previous;
              for (const value of previous.mpd) { delete value.catalog; delete value.error; }
              const choice = previous.mpd.find(value => value.candidate.id === choiceId);
              if (choice) choice.catalog = catalog;
              return { ...previous };
            });
          })} />}
        {!sources.choices.length && !sources.indexed.length && !sources.mpd.length && <p role="status">{t("watch.forward.none")}</p>}
        <Btn icon="x" quiet title="common.cancel" cap="common.cancel" disabled={busy} onClick={cancel} />
      </>}
    {failure && <p className="c3-settings-error" role="alert">{channelErrorPresentation(failure, t).message}</p>}
  </div>;
}

export function WatchSourceDialog({ channel, roomId, activityId, replacing = false, initialURL = "", onOtherSources, onClose }: {
  channel: ChannelController; roomId: string; activityId?: string; replacing?: boolean; initialURL?: string;
  onOtherSources?(): void; onClose(): void;
}) {
  const { t } = useCopy();
  const [url, setURL] = useState(initialURL);
  const { error, run } = useSettingsAction();
  const page = channel.watchPage(roomId, activityId);
  const confirmLabel = activityId ? "watch.start" : replacing ? "watch.switchVideo" : "watch.startVideo";
  const windowAction = useSettingsAction(!!page, page?.pageId);
  const embed = !activityId ? channel.watchEmbed(roomId) : undefined;
  const portableEmbed = canMoveWatchEmbed() && !!watchEmbed(url.trim());
  const mediaURL = URL.canParse(url.trim()) ? new URL(url.trim()) : null;
  const validURL = mediaURL !== null && watchSourceSchema.safeParse({ kind: "media", url: mediaURL.href }).success;
  const directFile = validURL && directWatchFormat(mediaURL) !== undefined;
  const appPageAvailable = channel.appConnected && channel.pagePlayer;
  const openPage = appPageAvailable && !portableEmbed && !directFile;
  const pageSources = !activityId ? page?.watchSources : undefined;
  const sourceCandidate = page?.candidates.find(candidate => candidate.id === pageSources?.candidateId);
  type SourceChoice =
    | { kind: "direct" | "forward"; id: string }
    | { kind: "website" }
    | { kind: "indexed"; videoId: string; audioId?: string }
    | { kind: "mpd"; selection: Parameters<ChannelController["selectWatchMpdSource"]>[1] };
  const [sourceDraft, setSourceDraft] = useState<{ pageId: string; candidateId: string; choice: SourceChoice }>();
  const [videoDraft, setVideoDraft] = useState<{ pageId: string; id: string }>();
  const videos = page?.candidates ?? [];
  const picked = videoDraft?.pageId === page?.pageId ? videoDraft : undefined;
  const candidate = picked ? videos.find(video => video.id === picked.id) : videos.length === 1 ? videos[0] : undefined;
  const videoName = (video: typeof videos[number], index: number) => video.title || t("watch.videoNumber", { number: String(index + 1) });
  const describeChoice = (choice: SourceChoice) => {
    switch (choice.kind) {
      case "direct":
      case "forward": {
        const entry = pageSources?.choices.find(entry => entry.id === choice.id);
        if (entry) return { name: entry.name || new URL(entry.displayURL).hostname,
          capability: t(choice.kind === "direct" ? "watch.forward.direct" : directForwardMediaURL(entry) ? "watch.forward.originFallback" : "watch.forward.upload") };
        return;
      }
      case "website":
        if (sourceCandidate?.pageURL) return { name: sourceCandidate.title || t("watch.video"), capability: t("watch.browserSource.skip") };
        return;
      case "indexed": {
        const video = pageSources?.indexed.find(entry => entry.candidate.id === choice.videoId && entry.inspection?.metadata.kind === "video");
        if (video && (!choice.audioId || pageSources?.indexed.some(entry => entry.candidate.id === choice.audioId && entry.inspection?.metadata.kind === "audio"))) {
          return { name: video.candidate.name || t("watch.video"), capability: t("watch.forward.upload") };
        }
        return;
      }
      case "mpd": {
        const { sourceId, videoId, audioId } = choice.selection;
        const entry = pageSources?.mpd.find(entry => entry.catalog?.sourceId === sourceId);
        const tracks = entry?.catalog?.tracks;
        if (tracks?.some(track => track.id === videoId && track.kind === "video")
          && (!audioId || tracks.some(track => track.id === audioId && track.kind === "audio"))) {
          return { name: entry?.candidate.name || t("watch.video"), capability: t("watch.forward.upload") };
        }
        return;
      }
    }
  };
  const sourceOptions = (pageSources?.choices ?? []).map(entry => {
    const direct = { kind: "direct", id: entry.id } as const;
    const forward = { kind: "forward", id: entry.id } as const;
    return directForwardMediaURL(entry) ? { preferred: forward, alternate: direct } : { preferred: direct, alternate: forward };
  });
  const website = { kind: "website" } as const;
  const staged = sourceDraft && sourceDraft.pageId === page?.pageId && sourceDraft.candidateId === pageSources?.candidateId
    ? sourceDraft.choice : undefined;
  const hasTrackChoices = !!(pageSources?.indexed.length || pageSources?.mpd.length);
  const choice = staged ?? (!hasTrackChoices && sourceOptions.length === 1 ? sourceOptions[0].preferred
    : !hasTrackChoices && sourceOptions.length === 0 && sourceCandidate?.pageURL ? website : undefined);
  const source = choice && describeChoice(choice);
  const selectedOption = choice?.kind === "direct" || choice?.kind === "forward"
    ? sourceOptions.find(option => option.preferred.id === choice.id) : undefined;
  const sourceTitle = sourceCandidate?.title || t("watch.video");
  const stageSource = (choice: SourceChoice) => {
    if (page && pageSources) setSourceDraft({ pageId: page.pageId, candidateId: pageSources.candidateId, choice });
  };
  const commitSource = (choice: SourceChoice) => {
    switch (choice.kind) {
      case "website": return channel.selectWatchBrowserSource(roomId, null, false);
      case "direct": return channel.selectWatchBrowserSource(roomId, choice.id, false);
      case "forward": return channel.selectWatchForwardSource(roomId, choice.id, false);
      case "indexed": return channel.selectWatchIndexedSource(roomId, choice.videoId, choice.audioId, false);
      case "mpd": return channel.selectWatchMpdSource(roomId, choice.selection, false);
    }
  };
  const pageSourcesHeading = useRef<HTMLHeadingElement>(null);
  const pageInstruction = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (pageSources) pageSourcesHeading.current?.focus();
    else if (page) pageInstruction.current?.focus();
  }, [!!page, !!pageSources]);
  const committing = !activityId && channel.sourceSelectionCommitting(roomId);
  const busy = committing || channel.pending.has(activityId ? `watch-video:${activityId}` : `screen:${roomId}`);
  const prepareExistingWatch = () => { void run(() => channel.prepareWatchPage(roomId, initialURL, activityId, false)); };
  useEffect(() => {
    if (activityId) prepareExistingWatch();
  }, [roomId, activityId]);
  const singleVideoId = !activityId && !pageSources && videos.length === 1 ? videos[0].id : undefined;
  const prepareVideo = (id: string) => run(() => channel.selectWatchPage(roomId, id, undefined, false, "choose-source"));
  const automaticPreparation = useRef<{ pageId: string; videoId: string } | null>(null);
  useEffect(() => {
    if (!page || !singleVideoId || busy) return;
    const previous = automaticPreparation.current;
    if (previous?.pageId === page.pageId && previous.videoId === singleVideoId) return;
    automaticPreparation.current = { pageId: page.pageId, videoId: singleVideoId };
    void prepareVideo(singleVideoId);
  }, [page?.pageId, singleVideoId, busy]);
  const failure = error ?? pageSources?.error ?? null;
  const help = diagnoseChannelFact({ area: "error", code: failure });
  const close = () => {
    if (!activityId && channel.sourceSelectionCommitting(roomId)) return;
    if (activityId) channel.cancelWatchPage(activityId);
    else if (busy || page || embed) void channel.cancelScreenSelection(roomId).catch(() => {});
    onClose();
  };
  return <ChannelSettingsDialog compact className="c3-watch-source-dialog" title={t(replacing ? "watch.switchVideo" : "watch.start")} caption={channel.state?.channel.rooms.find(room => room.id === roomId && room.authorized)?.name} error={failure} onClose={close} closeDisabled={committing}>
    {embed ? <WatchEmbedPreview media={embed} busy={busy}
      confirmLabel={confirmLabel} onConfirm={() => { void run(() => channel.confirmWatchEmbed(roomId, false), onClose); }} onCancel={close}
      onOriginalPage={appPageAvailable ? () => { void run(async () => {
        await channel.cancelScreenSelection(roomId); await channel.prepareWatchPage(roomId, url.trim(), undefined, false);
      }); } : undefined} /> : page ? <div className="c3-settings-panels c3-external-input">
      <p className="lr-source-option-copy"><small>{t("watch.url")}</small><span>{url}</span></p>
      {pageSources ? <>
        <h3 ref={pageSourcesHeading} tabIndex={-1}>{sourceTitle}</h3>
        {source ? <p className="lr-source-option-copy">{source.name !== sourceTitle && <strong>{source.name}</strong>}<small>{source.capability}</small></p>
          : <p role="status">{t(sourceOptions.length || sourceCandidate?.pageURL || hasTrackChoices ? "watch.browserSource.title" : "watch.waitForVideo")}</p>}
        <Btn icon="play" tone="primary" title={confirmLabel} cap={confirmLabel} busy={busy} disabled={busy || !source}
          onClick={() => { if (choice && source) void run(() => commitSource(choice), onClose); }} />
        {sourceOptions.length > 0 && <div className="lr-source-picker-list c3-watch-source-list" data-text-list>
          {sourceOptions.map(option => {
            const detail = describeChoice(option.preferred);
            if (!detail) return null;
            return <CaptureSourceCard key={option.preferred.id} title={detail.name}
              action={detail.name} icon="play" selected={selectedOption === option}
              disabled={busy} onSelect={() => stageSource(option.preferred)} />;
          })}
        </div>}
        {selectedOption && <details className="c3-settings-details">
          <summary>{t("watch.playbackMethod")}</summary>
          <select className="lr-select" aria-label={t("watch.playbackMethod")} value={choice?.kind} disabled={busy}
            onChange={event => stageSource(event.target.value === selectedOption.preferred.kind ? selectedOption.preferred : selectedOption.alternate)}>
            {[selectedOption.preferred, selectedOption.alternate].map(option =>
              <option key={option.kind} value={option.kind}>{describeChoice(option)?.capability}</option>)}
          </select>
        </details>}
        {sourceCandidate?.pageURL && <CaptureSourceCard title={t("watch.browserSource.skip")} description={t("watch.browserSource.originalHelp")}
          action={t("watch.browserSource.skip")} icon="globe" selected={choice?.kind === "website"}
          disabled={busy} onSelect={() => stageSource(website)} />}
        {hasTrackChoices && <details className="c3-settings-details" open={source ? undefined : true}>
          <summary>{t("watch.forward.trackOptions")}</summary>
          <WatchIndexedTrackPicker choices={pageSources.indexed} onRetry={pageSources.retryIndexed} busy={busy} mainPlayback confirmLabel="watch.useTracks"
            onConfirm={(videoId, audioId) => stageSource({ kind: "indexed", videoId, audioId })} />
          {pageSources.mpd.length > 0 && <WatchMpdSourcePicker choices={pageSources.mpd} busy={busy} mainPlayback confirmLabel="watch.useTracks"
            onInspect={(choiceId, signal) => run(() => channel.inspectWatchMpdSource(roomId, choiceId, signal))}
            onConfirm={selection => stageSource({ kind: "mpd", selection })} />}
        </details>}
        {videos.length > 1 && <details className="c3-settings-details">
          <summary>{t("watch.chooseAnotherVideo")}</summary>
          <div className="lr-source-picker-list c3-watch-source-list" data-text-list>
            {videos.filter(video => video.id !== sourceCandidate?.id).map(video => {
              const index = videos.indexOf(video);
              const name = videoName(video, index);
              return <CaptureSourceCard key={video.id} title={name} action={t("watch.selectVideoNamed", { name: video.title || String(index + 1) })}
                icon="play" disabled={busy} onSelect={() => {
                  void run(() => channel.selectWatchPage(roomId, video.id, undefined, false, "choose-source"));
                }} />;
            })}
          </div>
        </details>}
      </> : <>
        <p ref={pageInstruction} tabIndex={-1}>{t(busy && singleVideoId ? "common.loading" : videos.length ? "watch.chooseVideo" : "watch.waitForVideo")}</p>
        {videos.length > 0 && <div className="lr-source-picker-list c3-watch-source-list" data-text-list>
          {videos.map((video, index) => {
            const name = videoName(video, index);
            return <CaptureSourceCard key={video.id} title={name} action={t("watch.selectVideoNamed", { name: video.title || String(index + 1) })}
              icon="play" selected={candidate?.id === video.id} disabled={busy}
              onSelect={() => {
                if (activityId) setVideoDraft({ pageId: page.pageId, id: video.id });
                else void prepareVideo(video.id);
              }} />;
          })}
        </div>}
        {activityId && <Btn icon="play" tone="primary" title={confirmLabel} cap={confirmLabel}
          busy={busy} disabled={busy || !candidate}
          onClick={() => {
            if (candidate) void run(() => channel.selectWatchPage(roomId, candidate.id, activityId, false), committed => {
              if (committed) onClose();
            });
          }} />}

      </>}
      <div className="c3-share-title-actions">
        <Btn icon="window" quiet size="compact" title="watch.openedPage" cap="watch.openedPage" onClick={() => { void windowAction.run(() => channel.focusWatchPage(roomId, activityId)); }} />
        <Btn icon="x" quiet size="compact" title="common.cancel" cap="common.cancel" disabled={committing} onClick={close} />
      </div>
      <ChannelSettingsError error={windowAction.error} />
    </div> : activityId ? <div className="c3-settings-panels c3-external-input"><p role="status">{busy ? t("watch.openingPage") : t("watch.pageUnavailable")}</p>
      <div className="c3-share-title-actions">
        {busy ? <BrandLoader /> : <Btn icon="refresh" title="common.retry" cap="common.retry" onClick={prepareExistingWatch} />}
        <Btn icon="x" quiet title="common.cancel" cap="common.cancel" onClick={close} />
      </div></div> : <form className="c3-settings-panels c3-external-input" onSubmit={event => {
      event.preventDefault();
      if (!busy && validURL) void run(() => portableEmbed ? channel.prepareWatchEmbed(roomId, url.trim(), false)
        : openPage ? channel.prepareWatchPage(roomId, url.trim(), undefined, false) : channel.startWatch(roomId, url.trim(), false), portableEmbed || openPage ? undefined : onClose);
    }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <p>{t(portableEmbed ? "watch.embedHelp" : openPage ? "watch.pageHelp" : "watch.urlHelp")}</p>
      <label className="c3-external-input-field">{t("watch.url")}<span className="lr-input">
        <input type="url" required maxLength={MAX_WATCH_URL_LENGTH} value={url} placeholder="https://example.com/video.mp4" disabled={busy}
          onChange={event => setURL(event.target.value)} autoComplete="off" />
      </span></label>
      {!channel.pagePlayer && !portableEmbed && !directFile && <p>{t(channel.appConnected ? "watch.pageUnsupported" : "watch.connectApp")}</p>}
      <div className="c3-share-title-actions"><Btn type="submit" icon={openPage ? "globe" : "play"} tone="primary" title={portableEmbed ? "watch.selectVideo" : openPage ? "watch.openPage" : confirmLabel} cap={portableEmbed ? "watch.selectVideo" : openPage ? "watch.openPage" : confirmLabel} busy={busy} disabled={busy || !validURL} />
        {appPageAvailable && !portableEmbed && <Btn icon={openPage ? "play" : "globe"} quiet
          title={openPage ? "watch.directStart" : "watch.openPage"} cap={openPage ? "watch.directStart" : "watch.openPage"} disabled={busy || !validURL}
          onClick={() => { if (openPage) void run(() => channel.startWatch(roomId, url.trim(), false), onClose);
            else void run(() => channel.prepareWatchPage(roomId, url.trim(), undefined, false)); }} />}
        {onOtherSources && <Btn icon="cast" quiet title="watch.otherSources" cap="watch.otherSources" disabled={busy} onClick={() => {
          close();
          onOtherSources();
        }} />}
        <Btn icon="x" quiet title="common.cancel" cap="common.cancel" disabled={committing} onClick={close} /></div>
    </form>}
    {help && <ChannelDiagnosisHelp diagnosis={help} />}
  </ChannelSettingsDialog>;
}
