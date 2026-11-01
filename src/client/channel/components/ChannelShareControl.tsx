import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaptureSourcePicker, type NativeSourceList } from "../../components/living/CaptureSourcePicker";
import { Btn } from "../../components/living/primitives";
import { useAnchoredPopover } from "../../components/living/use-anchored-popover";
import { useCopy } from "../../ui/copy";
import { SharingSettings } from "../../components/living/SharingSettings";
import { QualityPresets, PictureSettingsSummary, ResolutionControl, VideoRateControls } from "../../components/living/QualityPresets";
import { QUALITY_PROFILES, VIDEO_CAPTURE_LIMITS, captureFramerateCeiling, matchingQualityProfileId } from "../../media/quality";
import { activateNativePicker } from "../../native/activation";
import type { ChannelController } from "../types";
import "./channel-share-control.css";

export function ChannelShareControl({ channel, roomId, disabled }: {
  channel: ChannelController; roomId: string; disabled: boolean;
}) {
  const { lang, t, vis } = useCopy();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const settingsTrigger = useRef<HTMLSpanElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const request = useRef<object | null>(null);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sources, setSources] = useState<NativeSourceList>({ kind: "browser" });
  const { appConnected, nativeSources, startNativeScreen, startScreen, quality, setQuality } = channel;
  const browserSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const cameraSupported = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
  const busy = channel.pending.has(`screen:${roomId}`);
  const captureRequest = channel.nativeCaptureRequest(roomId);
  const selectedNative = channel.nativeCaptureSelection(roomId);
  const available = browserSupported || cameraSupported || appConnected;
  const pickerAvailable = appConnected || cameraSupported;
  const sharing = channel.state?.publications.some(publication => publication.roomId === roomId && channel.ownedScreens.has(publication.id));
  const label = t(sharing ? "host.switchSource" : "host.start");
  useAnchoredPopover(trigger, panel, { maxHeight: 560, minVisibleHeight: 240 });
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
    if (open) refresh();
    return () => { request.current = null; };
  }, [open, refresh]);
  useLayoutEffect(() => { close(); }, [roomId, disabled, close]);
  const start = (operation: () => Promise<void>) => {
    close();
    void operation().catch(() => {}); // The session owns the operation's error.
  };
  return <>
    <span ref={trigger} className="c3-share-control">
      {captureRequest ? <>
        <span className="c3-app-confirmation">
          <Btn icon="window" title="native.confirmInApp" cap="native.confirmInApp" size="compact" tone="primary"
            onClick={() => activateNativePicker(captureRequest.activationURL)} />
        </span>
        <Btn icon="x" title="common.cancel" cap="common.cancel" size="compact" quiet
          onClick={() => { void channel.cancelScreenSelection(roomId).catch(() => {}); }} />
      </> : <Btn icon={sharing ? "switchSource" : "cast"} title={{ text: label }} cap={{ text: label }} size="compact" tone="primary"
        hint={available ? "hint-share-start" : "hint-no-sources"} hintText={available ? undefined : "host.capture.noSource"}
        disabled={disabled || busy || !available} busy={busy} expanded={pickerAvailable || open ? open : undefined}
        controls={pickerAvailable || open ? id : undefined} popoverTarget={pickerAvailable ? id : undefined}
        onClick={() => { if (!pickerAvailable) start(() => startScreen(roomId)); }} />}
    </span>
    <span ref={settingsTrigger} className="c3-share-control">
      <Btn icon="sliders" title="host.advanced" hint="hint-quality" size="compact" quiet
        disabled={disabled || busy} popoverTarget={`${id}-settings`} controls={`${id}-settings`} expanded={settingsOpen} />
    </span>
    <div ref={settingsPanel} id={`${id}-settings`} popover="auto" className="lr-anchored-card c3-quality-picker"
      onToggle={event => setSettingsOpen(event.newState === "open")}>
      <SharingSettings id={`${id}-quality`} open={settingsOpen}
        presets={<>{!vis && <div className="c3-quality-heading"><h3>{t("host.advanced")}</h3>
          <p>{lang === "zh" ? "用于新分享，正在分享的画面保持当前设置。" : "Applies to new shares. Current shares keep their settings."}</p></div>}
          <QualityPresets selected={matchingQualityProfileId(quality)} disabled={busy}
            onSelect={preset => setQuality({ ...QUALITY_PROFILES[preset], maxAudioBitrate: quality.maxAudioBitrate })} /></>}
        pictureSummary={<PictureSettingsSummary value={quality} />}
        picture={<><ResolutionControl value={quality.resolution} limits={VIDEO_CAPTURE_LIMITS} disabled={busy}
          onChange={resolution => setQuality({ ...quality, resolution,
            maxFramerate: Math.min(quality.maxFramerate, captureFramerateCeiling(resolution, VIDEO_CAPTURE_LIMITS)) })} />
          <VideoRateControls value={quality} limits={VIDEO_CAPTURE_LIMITS} disabled={busy}
            onChange={next => setQuality({ ...quality, ...next })} /></>} />
    </div>
    <div ref={panel} id={id} popover="auto" className="lr-anchored-card c3-share-picker"
      onToggle={event => setOpen(event.newState === "open")}>
      {open && <CaptureSourcePicker nativeSources={sources} browserSupported={browserSupported} cameraSupported={cameraSupported}
        loadCameras={channel.cameraPreviews}
        initialTab="window" selectionDisabled={disabled || busy}
        initialAudio={selectedNative?.audio} initialExcludeAudio={selectedNative?.excludeAudio}
        onBrowser={() => start(() => startScreen(roomId))}
        onCamera={deviceId => start(() => startScreen(roomId, "camera", deviceId))}
        onNative={(target, audio, _border, excludeAudio) => start(() => startNativeScreen(roomId, target, audio, excludeAudio))}
        onPreview={channel.nativePreview} onRefresh={refresh} onCancel={() => {
          close(); trigger.current?.querySelector("button")?.focus({ preventScroll: true });
        }} />}
    </div>
  </>;
}
