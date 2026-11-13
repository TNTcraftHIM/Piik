import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaptureSourcePicker, type NativeSourceList } from "../../components/living/CaptureSourcePicker";
import { Btn, SwitchItem } from "../../components/living/primitives";
import { LiveAudioExclusion } from "../../components/living/AudioExclusionSelect";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { SharingSettings } from "../../components/living/SharingSettings";
import { AudioBitrateControl, QualityPresets, PicturePreferenceControl, PictureSettingsSummary, ResolutionControl, VideoRateControls, VideoCodecControl } from "../../components/living/QualityPresets";
import { ShareMicrophoneSettings } from "../../components/living/ShareMicrophoneSettings";
import { MAX_AUDIO_SEND_BITRATE, QUALITY_PROFILES, VIDEO_CAPTURE_LIMITS, captureFramerateCeiling, matchingQualityProfileId, type QualityProfile } from "../../media/quality";
import { activateNativePicker } from "../../native/activation";
import type { NativeCaptureSources } from "../app-link";
import type { ChannelController } from "../types";
import { screenTitle } from "../presentation";
import { channelErrorPresentation } from "../error-presentation";
import { useSettingsAction } from "./ChannelSettingsDialog";
import { ChannelExternalInput } from "./ChannelExternalInput";
import { ChannelAction } from "./ChannelAction";
import type { ChannelPublication } from "../protocol";
import "./channel-share-control.css";

function ShareTitleEditor({ sharing, channel, disabled }: {
  sharing: Extract<ChannelPublication, { kind: "screen" }>; channel: ChannelController; disabled: boolean;
}) {
  const { t, lang } = useCopy(), zh = lang === "zh";
  const id = useId(), details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState("");
  const { error, run } = useSettingsAction(open);
  const pending = channel.pending.has(`title:${sharing.id}`);
  const automatic = screenTitle({ ...sharing, title: null }, lang);
  const { message } = channelErrorPresentation(error, t);
  const close = () => { if (details.current) details.current.open = false; };
  return <details ref={details} className="c3-share-title" onToggle={event => {
    if (event.target !== event.currentTarget) return;
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setDraft(sharing.title ?? "");
  }}>
    <summary>{zh ? "分享标题" : "Share title"}</summary>
    {open && <form onSubmit={event => {
      event.preventDefault();
      if (!disabled && !pending) void run(() => channel.setScreenTitle(sharing.id, draft.trim() || null), close);
    }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <label htmlFor={id}>{zh ? "分享标题" : "Share title"}</label>
      <span className="lr-input"><input id={id} value={draft} maxLength={64} placeholder={automatic}
        autoComplete="off" disabled={disabled || pending} onChange={event => setDraft(event.target.value)} aria-describedby={`${id}-help`} /></span>
      <p id={`${id}-help`}>{zh ? "留空并保存，使用来源名称。更换来源会保留自定义标题。" : "Save an empty title to use the source name. Custom titles stay when you switch sources."}</p>
      <div className="c3-share-title-actions">
        <Btn icon="check" type="submit" cap={{ text: zh ? "保存" : "Save" }} title={{ text: zh ? "保存标题" : "Save title" }}
          tone="primary" size="compact" busy={pending} disabled={disabled || pending} />
        <Btn icon="x" cap="common.cancel" title="common.cancel" quiet size="compact" disabled={pending} onClick={close} />
      </div>
      {message && <p className="c3-settings-error" role="alert">{message}</p>}
    </form>}
  </details>;
}

export function ChannelShareControl({ channel, roomId, publicationId, compact = false, disabled, openRequested, onPickerOpened }: {
  channel: ChannelController; roomId: string; publicationId?: string; compact?: boolean; disabled: boolean;
  openRequested?: boolean; onPickerOpened?(): void;
}) {
  const { t, vis, lang } = useCopy();
  const settingsLabel = lang === "zh" ? "分享设置" : "Share settings";
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
  const available = browserSupported || cameraSupported || appConnected;
  const pickerAvailable = appConnected || cameraSupported;
  const sharing = publicationId ? channel.state?.publications.find(publication =>
    publication.id === publicationId && publication.roomId === roomId && channel.ownedScreens.has(publication.id)) : undefined;
  const roomName = sharing ? channel.state?.channel.rooms.find(room => room.id === roomId)?.name : undefined;
  const settingsTitle = roomName
    ? lang === "zh" ? `${roomName}的分享设置` : `Share settings in ${roomName}`
    : settingsLabel;
  const currentCamera = sharing ? channel.streams.get(sharing.id)?.getVideoTracks()
    .find(track => track.readyState === "live")?.getSettings().deviceId : undefined;
  const codecMode = (sharing ? channel.screenCodecMode(sharing.id) : undefined) ?? channel.videoCodecMode;
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
  const loadMicrophones = useCallback(() => publicationId ? sourceMicrophones(publicationId) : Promise.resolve([]), [publicationId, sourceMicrophones]);
  const roomMicrophone = channel.state?.voice.some(voice => voice.sessionId === channel.sessionId && !voice.muted);
  const busy = channel.pending.has(`screen:${roomId}`) || !!sharing && channel.pending.has(`source-audio:${sharing.id}`);
  const label = t(sharing ? "host.switchSource" : "host.start");
  const sourceTitle = roomName
    ? lang === "zh" ? `切换${roomName}的分享源` : `Switch source in ${roomName}`
    : label;
  // The inner grid scrolls independently, so its clipped outer scrollHeight cannot size placement.
  useAnchoredPopover(trigger, panel, { maxHeight: 560, preferredHeight: 560, minVisibleHeight: 360 });
  useAnchoredPopover(settingsTrigger, settingsPanel, { maxHeight: 640, minVisibleHeight: 240 });
  const close = useCallback(() => { panel.current?.hidePopover(); settingsPanel.current?.hidePopover(); }, []);
  const refresh = useCallback(() => {
    const current = request.current = {};
    if (!appConnected) { setSources({ kind: "browser" }); return; }
    setSources(previous => ({ kind: "loading", appDetected: true,
      sources: previous.kind === "ready" ? previous.sources : undefined }));
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
    if (!openRequested || disabled || !available || !panel.current) return;
    panel.current.showPopover();
    onPickerOpened?.();
  }, [openRequested, disabled, available, onPickerOpened]);
  const start = (operation: () => Promise<void>) => {
    close();
    void operation().catch(() => {}); // The session owns the operation's error.
  };
  if (publicationId && !sharing) return null;
  return <><span className="c3-share-actions" role="group" aria-label={lang === "zh" ? "分享画面" : "Screen sharing"}>
    <span ref={trigger} className="c3-share-control">
      {captureRequest ? <>
        <span className="c3-app-confirmation">
          <Btn icon="window" title="native.confirmInApp" cap="native.confirmInApp" size="compact" tone="primary"
            onClick={() => activateNativePicker(captureRequest.activationURL)} />
        </span>
        <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" quiet
          onClick={() => { if (channel.nativeCaptureRequest(roomId)) void channel.cancelScreenSelection(roomId).catch(() => {}); }} />
      </> : <Btn icon={sharing ? "switchSource" : "cast"} title={{ text: sourceTitle }} cap={compact ? undefined : { text: label }} size="compact" tone={sharing ? undefined : "primary"} quiet={compact}
        hint={available ? sharing ? "hint-switch-source" : "hint-share-start" : "hint-no-sources"} hintText={available ? undefined : "host.capture.noSource"}
        disabled={disabled || busy || qualityPending || microphonePending || !available} busy={busy || qualityPending} expanded={pickerAvailable || open ? open : undefined}
        controls={pickerAvailable || open ? id : undefined} popoverTarget={pickerAvailable ? id : undefined}
        onClick={() => { if (!pickerAvailable) start(() => startScreen(roomId)); }} />}
    </span>
    <span ref={settingsTrigger} className="c3-share-control">
      <Btn icon="sliders" title={{ text: settingsTitle }} cap={vis || compact ? undefined : { text: settingsLabel }} hint="hint-quality" size="compact" quiet
        disabled={disabled || busy} busy={qualityPending} popoverTarget={`${id}-settings`} controls={`${id}-settings`} expanded={settingsOpen} />
    </span>
    {externalInput && <ChannelAction icon="cast" label={externalInput.state === "live" ? "OBS" : (lang === "zh" ? "等待 OBS" : "Waiting for OBS")}
      quiet onClick={() => setExternalOpen(true)} />}
    </span>
    <div ref={settingsPanel} id={`${id}-settings`} popover="auto" role="dialog" aria-label={settingsTitle} className="lr-anchored-card c3-quality-picker"
      onToggle={event => { if (event.target === event.currentTarget) setSettingsOpen(event.newState === "open"); }}>
      {(!vis || roomName) && <div className="c3-quality-heading"><h3>{vis ? roomName : settingsLabel}</h3>
        {!vis && <p>{sharing ? (lang === "zh" ? `调整你在${roomName ?? "当前房间"}中的分享。` : `Changes apply to your share in ${roomName ?? "this room"}.`)
          : (lang === "zh" ? "用于你接下来开始的分享。" : "Used when you start your next share.")}</p>}</div>}
      {settingsOpen && sharing?.kind === "screen" && <ShareTitleEditor key={sharing.id} sharing={sharing} channel={channel} disabled={disabled || busy} />}
      {externalInput?.state === "live" ? <div className="c3-settings-panels"><p>{lang === "zh" ? "画质和声音在 OBS 中设置，观众的接收画质仍会自动适配。" : "Configure picture and sound in OBS. Delivery still adapts to each viewer."}</p>
        <ChannelAction icon="cast" label={lang === "zh" ? "OBS 连接设置" : "OBS connection settings"} onClick={() => { close(); setExternalOpen(true); }} /></div>
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
            disabled={disabled || busy || !!sharing || !!captureRequest} onChange={channel.setVideoCodecMode} /></>}
        audio={<>
          {sharing && selectedNative?.current && selectedNative.target.kind === "display" && sources.kind === "ready" && sources.systemAudio && sources.processAudioExclusion &&
            <div className="lr-door-group lr-source-audio-settings">
              <SwitchItem checked={selectedNative.audio} label={t("host.sourcePicker.systemAudio")}
                hint={selectedNative.audio ? "hint-stop-audio" : "hint-share-audio"}
                disabled={disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={audio => { void startNativeScreen(roomId, selectedNative.target, audio, selectedNative.excludeAudio, selectedNative.showCaptureBorder).catch(() => {}); }} />
              <LiveAudioExclusion load={loadAudioApplications} value={selectedNative.excludeAudio}
                disabled={!selectedNative.audio || disabled || busy || qualityPending || microphonePending || sharing.paused}
                onChange={excludeAudio => { void startNativeScreen(roomId, selectedNative.target, true, excludeAudio, selectedNative.showCaptureBorder).catch(() => {}); }} />
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
          }} /></>} />}
    </div>
    <div ref={panel} id={id} popover="auto" className="lr-anchored-card c3-share-picker"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.newState === "open"); }}>
      {open && <CaptureSourcePicker nativeSources={pickerSources} browserSupported={browserSupported} cameraSupported={cameraSupported}
        loadCameras={channel.cameraPreviews} initialCamera={currentCamera}
        initialTab="window" selectionDisabled={disabled || busy || qualityPending || microphonePending}
        initialAudio={selectedNative?.audio} initialExcludeAudio={selectedNative?.excludeAudio} initialShowCaptureBorder={selectedNative?.showCaptureBorder}
        onBrowser={() => start(() => startScreen(roomId))}
        onCamera={deviceId => start(() => startScreen(roomId, "camera", deviceId))}
        onExternalInput={sources.kind === "ready" && sources.externalInput ? () => {
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
