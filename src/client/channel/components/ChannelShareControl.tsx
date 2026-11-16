import { WatchEmbedPreview } from "./WatchEmbedPreview";
import { canUseYouTubePlayer, youtubeVideoId } from "../watch-youtube-source";
import { WatchIndexedTrackPicker } from "./WatchIndexedTrackPicker";
import { indexedMediaSelection } from "../watch-indexed-source";
import type { NativePageIndexedSelection } from "../../native/wire";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaptureSourcePicker, type NativeSourceList } from "../../components/living/CaptureSourcePicker";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { LiveAudioExclusion } from "../../components/living/AudioExclusionSelect";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { SharingSettings } from "../../components/living/SharingSettings";
import { AudioBitrateControl, QualityPresets, PicturePreferenceControl, PictureSettingsSummary, ResolutionControl, VideoRateControls, VideoCodecControl, EncodingExecutionControl } from "../../components/living/QualityPresets";
import { ShareMicrophoneSettings } from "../../components/living/ShareMicrophoneSettings";
import { MAX_AUDIO_SEND_BITRATE, QUALITY_PROFILES, VIDEO_CAPTURE_LIMITS, captureFramerateCeiling, matchingQualityProfileId, type QualityProfile } from "../../media/quality";
import { activateNativePicker } from "../../native/activation";
import type { NativeCaptureSources } from "../app-link";
import type { ChannelController, WatchMediaSources } from "../types";
import { screenTitle } from "../presentation";
import { channelErrorPresentation } from "../error-presentation";
import { ChannelSettingsDialog, useSettingsAction } from "./ChannelSettingsDialog";
import { ChannelExternalInput } from "./ChannelExternalInput";
import { ChannelAction } from "./ChannelAction";
import { MAX_WATCH_URL_LENGTH, type ChannelPublication } from "../protocol";
import "./channel-share-control.css";
import { CaptureSourceCard } from "../../components/living/CaptureSourceCard";
import { BrandLoader } from "../../components/living/BrandMark";

function ShareTitleEditor({ sharing, channel, disabled }: {
  sharing: Extract<ChannelPublication, { kind: "screen" }>; channel: ChannelController; disabled: boolean;
}) {
  const { t } = useCopy();
  const id = useId(), details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState("");
  const { error, run } = useSettingsAction(open);
  const pending = channel.pending.has(`title:${sharing.id}`);
  const automatic = screenTitle({ ...sharing, title: null }, t);
  const { message } = channelErrorPresentation(error, t);
  const close = () => { if (details.current) details.current.open = false; };
  return <details ref={details} className="c3-share-title" onToggle={event => {
    if (event.target !== event.currentTarget) return;
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setDraft(sharing.title ?? "");
  }}>
    <summary>{t("screen.shareTitle")}</summary>
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

export function ChannelShareControl({ channel, roomId, publicationId, compact = false, disabled, openRequested, onPickerOpened, onWatch }: {
  channel: ChannelController; roomId: string; publicationId?: string; compact?: boolean; disabled: boolean;
  openRequested?: boolean; onPickerOpened?(): void; onWatch(): void;
}) {
  const { t } = useCopy();
  const settingsLabel = t("screen.shareSettings");
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const settingsTrigger = useRef<HTMLSpanElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const request = useRef<object | null>(null);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [sources, setSources] = useState<Exclude<NativeSourceList, { kind: "ready" }> | ({ kind: "ready" } & NativeCaptureSources)>({ kind: "browser" });
  const { appConnected, nativeSources, startNativeScreen, startScreen } = channel;
  const browserSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const cameraSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
  const captureRequest = channel.nativeCaptureRequest(roomId);
  const selectedNative = channel.nativeCaptureSelection(roomId);
  const externalInput = channel.externalInput(roomId);
  const sharing = channel.state?.publications.find(publication => publication.kind === "screen" &&
    (!publicationId || publication.id === publicationId) && publication.roomId === roomId && channel.ownedScreens.has(publication.id));
  const watching = channel.state?.watchActivities.find(activity => activity.roomId === roomId && activity.sessionId === channel.sessionId);
  const pageWatch = watching && !!channel.watchPlayers.get(watching.id)?.media.page;
  const roomName = sharing ? channel.state?.channel.rooms.find(room => room.id === roomId)?.name : undefined;
  const settingsTitle = roomName
    ? t("screen.shareSettingsInRoom", { room: roomName })
    : settingsLabel;
  const currentCamera = sharing ? channel.streams.get(sharing.id)?.getVideoTracks()
    .find(track => track.readyState === "live")?.getSettings().deviceId : undefined;
  const codecMode = (sharing ? channel.screenCodecMode(sharing.id) : undefined) ?? channel.videoCodecMode;
  const encodingExecution = (sharing ? channel.screenEncodingExecution(sharing.id) : undefined) ?? channel.encodingExecution;
  const canChooseExecution = sources.kind === "ready" && sources.softwareEncodingCodecs.includes("h264")
    && (codecMode === "auto" || codecMode === "h264")
    && (sharing ? !!selectedNative?.current && !externalInput : sources.sources.length > 0 && !externalInput);
  const pickerSources: NativeSourceList = sources.kind === "ready" &&
    !(codecMode === "auto" ? sources.codecs.length > 0 : sources.codecs.includes(codecMode))
    ? { kind: "unsupported" } : sources;
  const screenQuality = sharing ? channel.screenQuality(sharing.id) : undefined;
  const quality = screenQuality?.requested ?? channel.quality;
  const setQuality = (profile: QualityProfile) => {
    if (sharing) void channel.setScreenQuality(sharing.id, profile).catch(() => {});
    else channel.setQuality(profile);
  };
  const qualityPending = !!sharing && channel.pending.has(`quality:${sharing.id}`);
  const sourceAudio = sharing ? channel.sourceAudio(sharing.id) : undefined;
  const canChoosePreference = sources.kind === "ready" && sources.videoAdaptation
    || !selectedNative?.current && (!appConnected || !!sharing);
  const microphone = sharing ? channel.sourceMicrophone(sharing.id) : undefined;
  const microphoneSettings = microphone?.requested ?? microphone;
  const microphonePending = !!sharing && channel.pending.has(`source-microphone:${sharing.id}`);
  const { sourceMicrophones } = channel;
  const loadAudioApplications = useCallback(async () => (await nativeSources()).sources, [nativeSources]);
  const sharingId = sharing?.id;
  const loadMicrophones = useCallback(() => sharingId ? sourceMicrophones(sharingId) : Promise.resolve([]), [sharingId, sourceMicrophones]);
  const roomMicrophone = channel.state?.voice.some(voice => voice.sessionId === channel.sessionId && !voice.muted);
  const busy = channel.pending.has(`screen:${roomId}`) || !!sharing && channel.pending.has(`source-audio:${sharing.id}`);
  const cancellable = !!captureRequest || channel.pending.has(`screen:${roomId}`) && !channel.sourceSelectionCommitting(roomId);
  const label = t(sharing || watching ? "host.switchSource" : "host.start");
  const sourceTitle = roomName
    ? t("screen.switchRoomSource", { room: roomName })
    : label;
  // The inner grid scrolls independently, so its clipped outer scrollHeight cannot size placement.
  useAnchoredPopover(trigger, panel, { maxHeight: 560, preferredHeight: 560, minVisibleHeight: 360 });
  useAnchoredPopover(settingsTrigger, settingsPanel, { maxHeight: 640, minVisibleHeight: 240 });
  const close = useCallback(() => { panel.current?.hidePopover(); settingsPanel.current?.hidePopover(); }, []);
  const refresh = useCallback(() => {
    const current = request.current = {};
    if (!appConnected) { setSources({ kind: "browser" }); return; }
    setSources(previous => ({ kind: "loading", appDetected: true,
      ...(previous.kind === "ready" || previous.kind === "loading"
        ? { sources: previous.sources, externalInput: previous.externalInput } : {}) }));
    void nativeSources().then(result => {
      if (request.current === current) setSources({ kind: "ready", ...result });
    }, () => {
      if (request.current === current) setSources({ kind: "failed" });
    });
  }, [appConnected, nativeSources]);
  useEffect(() => {
    if (open || settingsOpen) refresh();
    return () => { request.current = null; };
  }, [open, settingsOpen, refresh]);
  useLayoutEffect(() => { close(); }, [roomId, publicationId, disabled, close]);
  useEffect(() => { setExternalOpen(false); }, [roomId]);
  useEffect(() => {
    if (!openRequested || disabled || !panel.current) return;
    panel.current.showPopover();
    onPickerOpened?.();
  }, [openRequested, disabled, onPickerOpened]);
  const start = (operation: () => Promise<void>) => {
    close();
    void operation().catch(() => {}); // The session owns the operation's error.
  };
  if (publicationId && !sharing) return null;
  return <><span className="c3-share-actions" role="group" aria-label={t("screen.screenSharing")}>
    <span ref={trigger} className="c3-share-control">
      {captureRequest ? <span className="c3-app-confirmation">
          <Btn icon="window" title="native.confirmInApp" cap="native.confirmInApp" size="compact" tone="primary"
            onClick={() => activateNativePicker(captureRequest.activationURL)} />
        </span> : <Btn icon={sharing || watching ? "switchSource" : "cast"} title={{ text: sourceTitle }} cap={compact ? undefined : { text: label }} size="compact" tone={sharing || watching ? undefined : "primary"} quiet={compact}
        hint={sharing || watching ? "hint-switch-source" : "hint-share-start"}
        disabled={disabled || busy || qualityPending || microphonePending} busy={busy || qualityPending} expanded={open}
        controls={id} popoverTarget={id} />}
      {cancellable && <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" quiet
        onClick={() => { void channel.cancelScreenSelection(roomId).catch(() => {}); }} />}
    </span>
    {(!watching || sharing || pageWatch) && <span ref={settingsTrigger} className="c3-share-control">
      <Btn icon="sliders" title={{ text: settingsTitle }} cap={compact ? undefined : { text: settingsLabel }} hint="hint-quality" size="compact" quiet
        disabled={disabled || busy} busy={qualityPending} popoverTarget={`${id}-settings`} controls={`${id}-settings`} expanded={settingsOpen} />
    </span>}
    {externalInput && <ChannelAction icon="cast" label={externalInput.state === "live" ? "OBS" : t("screen.obsWaiting")}
      quiet onClick={() => setExternalOpen(true)} />}
    </span>
    <div ref={settingsPanel} id={`${id}-settings`} popover="auto" role="dialog" aria-label={settingsTitle} className="lr-anchored-card c3-quality-picker"
      onToggle={event => { if (event.target === event.currentTarget) setSettingsOpen(event.newState === "open"); }}>
      {watching ? settingsOpen && <WatchForwardSettings channel={channel} activityId={watching.id} disabled={disabled} /> : <>
      <div className="c3-quality-heading"><h3>{settingsLabel}</h3>
        <p>{sharing ? t("screen.shareSettingsHelp", { room: roomName ?? t("screen.currentRoom") })
          : t("screen.shareSettingsNext")}</p></div>
      {settingsOpen && sharing?.kind === "screen" && <ShareTitleEditor key={sharing.id} sharing={sharing} channel={channel} disabled={disabled || busy} />}
      {externalInput?.state === "live" ? <div className="c3-settings-panels"><p>{t("screen.obsQualityHelp")}</p>
        <ChannelAction icon="cast" label={t("screen.obsSettings")} onClick={() => { close(); setExternalOpen(true); }} /></div>
        : <SharingSettings id={`${id}-quality`} open={settingsOpen} busy={qualityPending || microphonePending}
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
          <VideoCodecControl value={codecMode}
            disabled={disabled || busy || !!sharing || !!captureRequest} onChange={channel.setVideoCodecMode} />
          {canChooseExecution && <EncodingExecutionControl value={encodingExecution}
            disabled={disabled || busy || !!sharing || !!captureRequest} onChange={channel.setEncodingExecution} />}</>}
        audio={<>
          {sharing && selectedNative?.current && selectedNative.target.kind === "display" && sources.kind === "ready" && sources.systemAudio &&
            <div className="lr-door-group lr-source-audio-settings">
              <SwitchItem checked={selectedNative.audio} label={t("host.sourcePicker.systemAudio")}
                hint={selectedNative.audio ? "hint-stop-audio" : "hint-share-audio"}
                disabled={disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={audio => { void startNativeScreen(roomId, selectedNative.target, audio, selectedNative.excludeAudio, selectedNative.showCaptureBorder).catch(() => {}); }} />
              {sources.processAudioExclusion && <LiveAudioExclusion load={loadAudioApplications} value={selectedNative.excludeAudio}
                disabled={!selectedNative.audio || disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={excludeAudio => { void startNativeScreen(roomId, selectedNative.target, true, excludeAudio, selectedNative.showCaptureBorder).catch(() => {}); }} />}
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
          <AudioBitrateControl value={sourceAudio?.bitrate ?? quality.maxAudioBitrate ?? 128_000} max={MAX_AUDIO_SEND_BITRATE}
          disabled={busy || qualityPending}
          onChange={bitrate => {
            if (sharing) void channel.setSourceAudio(sharing.id, { bitrate }).catch(() => {});
            else setQuality({ ...quality, maxAudioBitrate: bitrate });
          }} /></>} />}</>}
    </div>
    <div ref={panel} id={id} popover="auto" className="lr-anchored-card c3-share-picker"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      {open && <CaptureSourcePicker nativeSources={pickerSources} browserSupported={browserSupported} cameraSupported={cameraSupported}
        loadCameras={channel.cameraPreviews} initialCamera={currentCamera}
        initialTab="window" selectionDisabled={disabled || busy || qualityPending || microphonePending}
        initialAudio={selectedNative?.audio} initialExcludeAudio={selectedNative?.excludeAudio} initialShowCaptureBorder={selectedNative?.showCaptureBorder}
        onBrowser={() => start(() => startScreen(roomId))}
        onWatch={() => { close(); trigger.current?.querySelector("button")?.focus({ preventScroll: true }); onWatch(); }}
        onCamera={deviceId => start(() => startScreen(roomId, "camera", deviceId))}
        onExternalInput={(sources.kind === "ready" || sources.kind === "loading") && sources.externalInput ? () => {
          close();
          if (externalInput) setExternalOpen(true);
          else void channel.startExternalScreen(roomId).then(() => setExternalOpen(true)).catch(() => {});
        } : undefined}
        onNative={(target, audio, border, excludeAudio) => start(() => startNativeScreen(roomId, target, audio, excludeAudio, border))}
        onPreview={channel.nativePreview} onRefresh={refresh} onCancel={() => {
          close(); trigger.current?.querySelector("button")?.focus({ preventScroll: true });
        }} />}
    </div>
    {externalOpen && externalInput && <ChannelExternalInput input={externalInput} busy={channel.pending.has(`stop:${externalInput.publicationId}`)}
      onStop={() => { void channel.stopScreen(externalInput.publicationId).then(() => setExternalOpen(false)).catch(() => {}); }} onClose={() => setExternalOpen(false)} />}
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
  const forward = (choice: string | NativePageIndexedSelection) => {
    discovery.current?.abort();
    const controller = discovery.current = new AbortController();
    void run(() => channel.setWatchByteSource(activityId, choice, controller.signal));
  };
  return <div className="c3-watch-forward-settings c3-external-input">
    <h3>{t("watch.forward.title")}</h3><p>{t("watch.forward.upload")}</p>
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
          {sources.choices.map(choice => <CaptureSourceCard key={choice.id} title={choice.name || new URL(choice.displayURL).hostname} action={t("watch.forward.enableNamed", { name: choice.name || new URL(choice.displayURL).hostname })}
            icon="play" hint="hint-source-picker" disabled={disabled || busy} onSelect={() => forward(choice.id)} />)}
        </div></>}
        {sources.indexed.length > 0 && <WatchIndexedTrackPicker choices={sources.indexed} disabled={disabled} busy={busy}
          onConfirm={(videoId, audioId) => {
            const video = sources.indexed.find(value => value.candidate.id === videoId)?.inspection;
            const audio = audioId ? sources.indexed.find(value => value.candidate.id === audioId)?.inspection : undefined;
            if (video) forward(indexedMediaSelection(video, audio));
          }} />}
        {!sources.choices.length && !sources.indexed.length && <p role="status">{t("watch.forward.none")}</p>}
        <Btn icon="x" quiet title="common.cancel" cap="common.cancel" disabled={busy} onClick={cancel} />
      </>}
    {failure && <p className="c3-settings-error" role="alert">{channelErrorPresentation(failure, t).message}</p>}
  </div>;
}

export function WatchSourceDialog({ channel, roomId, activityId, initialURL = "", onClose }: { channel: ChannelController; roomId: string; activityId?: string; initialURL?: string; onClose(): void }) {
  const { t } = useCopy();
  const [url, setURL] = useState(initialURL);
  const { error, run } = useSettingsAction();
  const page = channel.watchPage(roomId, activityId);
  const embed = !activityId ? channel.watchEmbed(roomId) : undefined;
  const youtube = canUseYouTubePlayer() && !!youtubeVideoId(url.trim());
  const pageSources = !activityId ? page?.watchSources : undefined;
  const pageSourcesHeading = useRef<HTMLHeadingElement>(null);
  const pageInstruction = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (pageSources) pageSourcesHeading.current?.focus();
    else if (page) pageInstruction.current?.focus();
  }, [!!page, !!pageSources]);
  const committing = !activityId && channel.sourceSelectionCommitting(roomId);
  const busy = committing || channel.pending.has(activityId ? `watch-video:${activityId}` : `screen:${roomId}`);
  useEffect(() => {
    if (activityId) void run(() => channel.prepareWatchPage(roomId, initialURL, activityId, false));
  }, [roomId, activityId]);
  const close = () => {
    if (!activityId && channel.sourceSelectionCommitting(roomId)) return;
    if (activityId) void channel.leaveWatch(activityId).catch(() => {});
    else if (busy || page || embed) void channel.cancelScreenSelection(roomId).catch(() => {});
    onClose();
  };
  return <ChannelSettingsDialog compact title={t("watch.start")} error={error ?? pageSources?.error ?? null} onClose={close} closeDisabled={committing}>
    {embed ? <WatchEmbedPreview media={embed} busy={busy}
      onConfirm={() => { void run(() => channel.confirmWatchEmbed(roomId, false), onClose); }} onCancel={close}
      onOriginalPage={channel.pagePlayer ? () => { void run(async () => {
        await channel.cancelScreenSelection(roomId); await channel.prepareWatchPage(roomId, url.trim(), undefined, false);
      }); } : undefined} /> : page ? <div className="c3-settings-panels c3-external-input">
      {pageSources ? <><h3 ref={pageSourcesHeading} tabIndex={-1}>{t(pageSources.indexed.length ? "watch.forward.title" : "watch.browserSource.title")}</h3>{pageSources.choices.length > 0 && <p>{t("watch.browserSource.help")}</p>}</>
        : <p ref={pageInstruction} tabIndex={-1}>{t("watch.chooseVideo")}</p>}
      <Btn icon="window" quiet size="compact" title="watch.openedPage" cap="watch.openedPage" onClick={() => { void run(() => channel.focusWatchPage(roomId, activityId)); }} />
      {pageSources ? <>
        {busy && !error && pageSources.choices.length === 0 && pageSources.indexed.length === 0 && <div className="lr-source-picker-status" role="status">
          <BrandLoader /><span>{t("common.loading")}</span>
        </div>}
        {!busy && !pageSources.error && pageSources.choices.length === 0 && pageSources.indexed.length === 0 && <p role="status">{t("watch.waitForVideo")}</p>}
        {pageSources.choices.length > 0 && <div className="lr-source-picker-list" data-text-list>
          {pageSources.choices.map(choice => {
            const source = new URL(choice.displayURL), name = choice.name || source.host;
            return <div key={choice.id} className="c3-external-input" role="group" aria-label={name}><CaptureSourceCard title={name} description={source.host + source.pathname}
              action={t("watch.browserSource.selectNamed", { name })} icon="play" hint="hint-source-picker" disabled={busy}
              onSelect={() => { void run(() => channel.selectWatchBrowserSource(roomId, choice.id, false), onClose); }} />
              <Btn icon="share" quiet title={{ text: t("watch.forward.enableNamed", { name }) }} cap="watch.forward.fromApp" disabled={busy}
                onClick={() => { void run(() => channel.selectWatchForwardSource(roomId, choice.id, false), onClose); }} /></div>;
          })}
        </div>}
        {pageSources.indexed.length > 0 && <WatchIndexedTrackPicker choices={pageSources.indexed} busy={busy} mainPlayback
          onConfirm={(videoId, audioId) => { void run(() => channel.selectWatchIndexedSource(roomId, videoId, audioId, false), onClose); }} />}
        <Btn icon="globe" quiet title="watch.browserSource.skip" cap="watch.browserSource.skip" disabled={busy}
          onClick={() => { void run(() => channel.selectWatchBrowserSource(roomId, null, false), onClose); }} />
      </> : page.candidates.length ? <div className="lr-source-picker-list">
        {page.candidates.map((candidate, index) => <CaptureSourceCard key={candidate.id} title={candidate.title || t("watch.videoNumber", { number: String(index + 1) })}
          action={t("watch.selectVideoNamed", { name: candidate.title || String(index + 1) })} icon="play" hint="hint-source-picker" disabled={busy}
          onSelect={() => { void run(() => channel.selectWatchPage(roomId, candidate.id, activityId, false), committed => { if (committed) onClose(); }); }} />)}
      </div> : <div className="lr-source-picker-status" role="status"><BrandLoader /><span>{t("watch.waitForVideo")}</span></div>}
      <Btn icon="x" quiet title="common.cancel" cap="common.cancel" disabled={committing} onClick={close} />
    </div> : activityId ? <div className="c3-settings-panels c3-external-input"><p role="status">{busy ? t("watch.openingPage") : t("watch.pageUnavailable")}</p>
      {busy && <BrandLoader />}<Btn icon="x" quiet title="common.cancel" cap="common.cancel" onClick={close} /></div> : <form className="c3-settings-panels c3-external-input" onSubmit={event => {
      event.preventDefault();
      if (!busy) void run(() => youtube ? channel.prepareWatchEmbed(roomId, url.trim(), false)
        : channel.pagePlayer ? channel.prepareWatchPage(roomId, url.trim(), undefined, false) : channel.startWatch(roomId, url.trim(), false), youtube || channel.pagePlayer ? undefined : onClose);
    }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <p>{t(youtube ? "watch.embedHelp" : channel.pagePlayer ? "watch.pageHelp" : "watch.urlHelp")}</p>
      <label className="c3-external-input-field">{t("watch.url")}<span className="lr-input">
        <input type="url" required maxLength={MAX_WATCH_URL_LENGTH} value={url} placeholder="https://example.com/video.mp4" disabled={busy}
          onChange={event => setURL(event.target.value)} autoComplete="off" />
      </span></label>
      {!channel.appConnected && !channel.pagePlayer && !youtube && <p>{t("watch.connectApp")}</p>}
      <div className="c3-share-title-actions"><Btn type="submit" icon={youtube ? "play" : channel.pagePlayer ? "globe" : "play"} tone="primary" title={youtube ? "watch.start" : channel.pagePlayer ? "watch.openPage" : "watch.directStart"} cap={youtube ? "watch.start" : channel.pagePlayer ? "watch.openPage" : "watch.directStart"} busy={busy} disabled={busy || !url.trim()} />
        {channel.pagePlayer && !youtube && <Btn icon="play" quiet title="watch.directStart" cap="watch.directStart" disabled={busy || !url.trim()}
          onClick={() => { void run(() => channel.startWatch(roomId, url.trim(), false), onClose); }} />}
        <Btn icon="x" quiet title="common.cancel" cap="common.cancel" disabled={committing} onClick={close} /></div>
    </form>}
  </ChannelSettingsDialog>;
}
