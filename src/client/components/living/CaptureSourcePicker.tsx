import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";

import type { NativeCaptureTarget } from "../../native/wire";
import { audioApplicationKey, audioApplications, nativeCaptureTargetKey } from "../../native/capture-selection";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { navigateTabs } from "../../ui/tab-navigation";
import { Tooltip } from "./Tooltip";
import { HintComic } from "./hints";
import { Btn, Pill } from "./primitives";
import { CameraSources, useCameraSources } from "./CameraSources";
import { CaptureSourceCard } from "./CaptureSourceCard";
import { AudioExclusionSelect } from "./AudioExclusionSelect";
import type { loadCameraPreviews } from "../../media/camera-previews";

const SOURCE_TABS = ["browser", "camera", "window", "display", "picker"] as const;
type SourceTab = (typeof SOURCE_TABS)[number];
const SOURCE_ICONS = {
  browser: "globe",
  window: "window",
  display: "display",
  camera: "camera",
  picker: "share",
} satisfies Record<SourceTab, GlyphName>;

export type NativeSourceList =
  | { kind: "browser" }
  | { kind: "loading"; appDetected?: boolean; sources?: NativeCaptureTarget[] }
  | { kind: "unavailable" }
  | { kind: "incompatible" }
  | { kind: "unsupported" }
  | { kind: "failed" }
  | {
      kind: "ready";
      sources: NativeCaptureTarget[];
      processAudio: boolean;
      systemAudio: boolean;
      processAudioExclusion?: boolean;
      captureBorderControl?: boolean;
    };

export function nativeAppDetected(sources: NativeSourceList | null): boolean {
  return sources?.kind === "loading" ? sources.appDetected === true
    : sources !== null && sources.kind !== "browser" && sources.kind !== "unavailable";
}

export function CaptureSourcePicker({
  nativeSources,
  onBrowser,
  onCamera,
  onNative,
  onPreview,
  onRefresh,
  onCancel,
  browserSupported = true,
  cameraSupported = true,
  initialTab = "window",
  initialCamera = "",
  activeCameraVideo,
  loadCameras,
  initialAudio = true,
  initialShowCaptureBorder = false,
  initialExcludeAudio,
  audioLocked = false,
  selectionDisabled = false,
  changingSource = false,
}: {
  nativeSources: NativeSourceList;
  onBrowser: () => void;
  onCamera?: (deviceId: string) => void;
  initialCamera?: string;
  activeCameraVideo?: HTMLVideoElement | null;
  loadCameras?: typeof loadCameraPreviews;
  onNative: (target: NativeCaptureTarget, audio: boolean, showCaptureBorder: boolean, excludeAudio?: NativeCaptureTarget) => void;
  onPreview: (
    target: NativeCaptureTarget,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  onRefresh: () => void;
  onCancel: () => void;
  browserSupported?: boolean;
  cameraSupported?: boolean;
  initialTab?: SourceTab;
  initialAudio?: boolean;
  initialShowCaptureBorder?: boolean;
  initialExcludeAudio?: NativeCaptureTarget;
  audioLocked?: boolean;
  selectionDisabled?: boolean;
  changingSource?: boolean;
}) {
  const { vis, t } = useCopy();
  const pickerId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<SourceTab | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [shareAudio, setShareAudio] = useState(initialAudio);
  const [showCaptureBorder, setShowCaptureBorder] = useState(initialShowCaptureBorder);
  const [excludeAudio, setExcludeAudio] = useState(initialExcludeAudio);
  const appDetected = nativeAppDetected(nativeSources);
  // Retained targets classify tabs during refresh; only ready targets are selectable.
  const pickerOnly = (nativeSources.kind === "ready" || nativeSources.kind === "loading") && !!nativeSources.sources?.length &&
    nativeSources.sources.every(target => target.kind === "picker");
  const tabs = SOURCE_TABS.filter(value => value === "browser" ? browserSupported
    : value === "camera" ? cameraSupported
    : value === "picker" ? pickerOnly
    : !pickerOnly && (appDetected || nativeSources.kind === "loading"));
  const requestedTab = tab ?? initialTab;
  const preferredTab = pickerOnly && (requestedTab === "window" || requestedTab === "display") ? "picker" : requestedTab;
  const tabAvailable = (value: SourceTab) => value !== "camera" || !!onCamera;
  const activeTab = tabs.includes(preferredTab) && tabAvailable(preferredTab)
    ? preferredTab : tabs.find(tabAvailable) ?? tabs[0];
  const nativeTab = activeTab === "window" || activeTab === "display" || activeTab === "picker";
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [activeTab]);
  const browserCapture = activeTab === "browser";
  const cameraSources = useCameraSources(activeTab === "camera" && !!onCamera, activeCameraVideo, loadCameras);
  const supportsCaptureBorder = nativeTab && nativeSources.kind === "ready" && nativeSources.captureBorderControl === true;
  const issueKey = !nativeTab ? null : nativeSources.kind === "incompatible" ? "native.incompatible"
    : (nativeSources.kind === "unsupported" || nativeSources.kind === "failed")
      ? `host.sourcePicker.${nativeSources.kind}` as const
      : null;

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
          panelRef.current?.querySelector('[popover="auto"]:popover-open') ||
          !panelRef.current?.contains(event.target as Node | null)) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [onCancel]);

  const sources =
    nativeTab && nativeSources.kind === "ready"
      ? nativeSources.sources.filter(
          (target) => target.kind === activeTab || target.kind === "picker",
        )
      : [];
  const selectedTarget = activeTab === "window" || activeTab === "display"
    ? sources.find(target => nativeCaptureTargetKey(target) === selectedKey) : undefined;
  useEffect(() => {
    if (nativeSources.kind !== "loading" && !selectedTarget) setSelectedKey(null);
  }, [nativeSources.kind, selectedTarget]);
  const supportsAudio = (target: NativeCaptureTarget): boolean =>
    nativeSources.kind === "ready" &&
    (target.kind === "window"
      ? nativeSources.processAudio
      : nativeSources.systemAudio);
  const audioTarget = selectedTarget ?? sources.find(target => target.kind === "picker");
  const canShareAudio = !!audioTarget && supportsAudio(audioTarget);
  // Source enumeration already owns process identity; do not create a second app scanner.
  const applications = nativeSources.kind === "ready" ? audioApplications(nativeSources.sources) : [];
  const exclusionKey = excludeAudio ? audioApplicationKey(excludeAudio) : "";
  const canExcludeAudio = activeTab === "display" && nativeSources.kind === "ready" && nativeSources.processAudioExclusion;
  const missingExclusion = !!excludeAudio && !applications.some(target => audioApplicationKey(target) === exclusionKey);
  const exclusionUnavailable = selectedTarget?.kind === "display" && canShareAudio && shareAudio && !!excludeAudio && (!canExcludeAudio || missingExclusion);
  const refreshing = activeTab === "camera" ? cameraSources.busy : nativeSources.kind === "loading";
  const refreshLabel = t(refreshing ? "host.sourcePicker.loading" : "host.sourcePicker.refresh");
  const audioAction = t(!audioTarget ? "host.sourcePicker.audioHint" : !canShareAudio ? "host.sourcePicker.audioUnavailable" : audioLocked
    ? "host.sourcePicker.audioLocked"
    : shareAudio ? "host.sourcePicker.audioOff" : "host.sourcePicker.audioOn");
  const audioLabel = t(
    activeTab === "window"
      ? "host.sourcePicker.windowAudio"
      : "host.sourcePicker.systemAudio",
  );
  const refreshButton = (
    <button
      type="button"
      className="lr-btn is-dense lr-source-picker-refresh"
      aria-label={refreshLabel}
      disabled={refreshing || selectionDisabled}
      onClick={activeTab === "camera" ? cameraSources.refresh : onRefresh}
    >
      <Glyph name="refresh" size={18} className={refreshing ? "lr-spin" : undefined} />
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className="lr-btn is-dense is-quiet lr-source-picker-close"
      aria-label={t("common.cancel")}
      onClick={onCancel}
      autoFocus
    >
      <Glyph name="x" size={18} />
    </button>
  );
  const audioSwitch = (
    <button
      type="button"
      className="lr-switch"
      role="switch"
      aria-checked={shareAudio && canShareAudio}
      aria-label={audioLabel}
      aria-description={!canShareAudio ? audioAction : undefined}
      disabled={selectionDisabled || audioLocked || !canShareAudio}
      onClick={() => setShareAudio((current) => !current)}
    />
  );

  const confirmLabel = changingSource ? "host.switchSource" : "host.start";
  function submitNative(target: NativeCaptureTarget) {
    if (selectionDisabled || exclusionUnavailable || (audioLocked && shareAudio && !supportsAudio(target))) return;
    const audio = shareAudio && supportsAudio(target);
    onNative(target, audio, supportsCaptureBorder && showCaptureBorder,
      audio && target.kind === "display" ? excludeAudio : undefined);
  }

  return (
    <div
      ref={panelRef}
      className={`lr-tv-overlay lr-source-picker${vis ? " is-visual" : ""}`}
      role="dialog"
      aria-label={t("host.sourcePicker.title")}
      onKeyDown={event => {
        if (event.key !== "Tab" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        // This TV-local task keeps its keyboard loop without making the room
        // modal; pointer users can still reach the surrounding room controls.
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], summary, [tabindex]',
        )].filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length);
        const next = event.shiftKey && event.target === controls[0] ? controls.at(-1)
          : !event.shiftKey && event.target === controls.at(-1) ? controls[0] : undefined;
        if (next) { event.preventDefault(); next.focus(); }
      }}
    >
      <div className="lr-source-picker-panel">
        <header className="lr-source-picker-head">
          <span className="lr-source-picker-mark" aria-hidden="true">
            <Glyph name="window" size={22} draw="capture-source" />
          </span>
          {vis ? null : (
            <span className="lr-source-picker-copy">
              <strong>{t("host.sourcePicker.title")}</strong>
            </span>
          )}
          {activeTab === "camera" || nativeSources.kind !== "browser" ? <Tooltip kind="hint-refresh-sources" text={vis ? undefined : refreshLabel}
            tone={refreshing ? "busy" : undefined}
            motion={refreshing ? "progress" : undefined}
            place="below" align="end">
            {refreshButton}
          </Tooltip> : null}
          <Tooltip kind="hint-close" text={vis ? undefined : t("common.cancel")} place="below" align="end">
            {closeButton}
          </Tooltip>
        </header>

        {tabs.length > 0 && <div
          className="lr-toggle lr-source-picker-tabs"
          style={{ "--lr-segments": tabs.length, "--lr-selected-index": tabs.indexOf(activeTab) } as CSSProperties}
          role="tablist"
          aria-label={t("host.sourcePicker.title")}
          onKeyDown={navigateTabs}
        >
          {tabs.map((value) => {
            const button = (
              <button
                type="button"
                role="tab"
                id={`${pickerId}-${value}`}
                className={activeTab === value ? "is-selected" : undefined}
                data-source-tab={value}
                aria-controls={`${pickerId}-panel`}
                aria-selected={activeTab === value}
                aria-label={t(`host.sourcePicker.tab.${value}`)}
                tabIndex={activeTab === value ? 0 : -1}
                disabled={!tabAvailable(value)}
                onClick={() => {
                  if (value !== activeTab) setSelectedKey(null);
                  setTab(value);
                }}
              >
                <Glyph
                  name={SOURCE_ICONS[value]}
                  size={20}
                  draw={`source-tab-${value}`}
                />
                {vis ? null : (
                  <span>{t(`host.sourcePicker.tab.${value}`)}</span>
                )}
              </button>
            );
            return (
              <Tooltip
                key={value}
                kind={value === "picker" ? "hint-source-picker" : `hint-capture-${value}`}
                text={vis ? undefined : t(value === "browser" ? "host.sourcePicker.browserHint" : `host.sourcePicker.tab.${value}`)}
                place="below"
              >
                {button}
              </Tooltip>
            );
          })}
        </div>}

        <div
          ref={bodyRef}
          className="lr-source-picker-body"
          role={activeTab ? "tabpanel" : undefined}
          id={`${pickerId}-panel`}
          aria-labelledby={activeTab ? `${pickerId}-${activeTab}` : undefined}
        >
          {nativeTab &&
          nativeSources.kind === "ready" &&
          (supportsCaptureBorder || sources.length > 0) ? (
            <div className="lr-source-picker-options">
              {supportsCaptureBorder ? (
                <div className="lr-source-picker-option">
                  <span aria-hidden="true"><Glyph name="window" size={19} /></span>
                  {vis ? null : <span>{t("host.sourcePicker.showCaptureBorder")}</span>}
                  <Tooltip kind={showCaptureBorder ? "hint-hide-capture-border" : "hint-show-capture-border"}
                    text={vis ? undefined : t("host.sourcePicker.showCaptureBorderHint")} place="below">
                    <button
                      type="button"
                      className="lr-switch"
                      role="switch"
                      aria-checked={showCaptureBorder}
                      aria-label={t("host.sourcePicker.showCaptureBorder")}
                      aria-description={t("host.sourcePicker.showCaptureBorderHint")}
                      disabled={selectionDisabled}
                      onClick={() => setShowCaptureBorder((current) => !current)}
                    />
                  </Tooltip>
                </div>
              ) : null}
              {sources.length > 0 ? (
                <div className="lr-source-picker-option">
                  <span aria-hidden="true">
                    <Glyph name="speaker" size={19} />
                  </span>
                  {vis ? null : <span>{audioLabel}</span>}
                  <Tooltip
                    kind={!audioTarget ? "hint-share-audio" : !canShareAudio ? "no-audio" : audioLocked
                      ? (shareAudio ? "hint-share-audio-fixed" : "hint-silent-share-fixed")
                      : shareAudio ? "hint-stop-audio" : "hint-share-audio"}
                    text={vis ? undefined : !canShareAudio ? audioAction : `${audioAction}\n${t("host.sourcePicker.audioHint")}`}
                    place="below"
                  >
                    {audioSwitch}
                  </Tooltip>
                </div>
              ) : null}
              {activeTab === "display" && shareAudio && canShareAudio && (canExcludeAudio || excludeAudio) ? (
                <details className="lr-source-exclusion" onToggle={event => {
                  if (event.currentTarget.open) event.currentTarget.scrollIntoView({ block: "nearest" });
                }}>
                  <summary aria-label={vis ? t("host.sourcePicker.excludeAudio") : undefined}>
                    <Glyph name="speakerOff" size={18} />
                    {!vis && <span>{t("host.sourcePicker.excludeAudio")}{excludeAudio ? `: ${excludeAudio.title}` : ""}</span>}
                    <Glyph name="chevron" size={14} />
                  </summary>
                  <AudioExclusionSelect sources={canExcludeAudio ? applications : []} value={excludeAudio}
                    showLabel={false} disabled={selectionDisabled} onChange={setExcludeAudio} />
                </details>
              ) : null}
            </div>
          ) : null}

          {activeTab === "camera" ? <CameraSources {...cameraSources} selected={initialCamera}
            disabled={selectionDisabled || !onCamera} onSelect={id => {
              cameraSources.cancel();
              onCamera?.(id);
            }} /> : <>
          <div className="lr-source-picker-list">
            {browserCapture ? (
              <button
                type="button"
                className="lr-source-option is-action"
                aria-label={t("host.sourcePicker.browser")}
                disabled={selectionDisabled}
                onClick={onBrowser}
              >
                <span className="lr-source-option-icon" aria-hidden="true">
                  <Glyph name={SOURCE_ICONS.browser} size={23} />
                </span>
                {vis ? (
                  <span className="visually-hidden">
                    {t("host.sourcePicker.tab.browser")}
                  </span>
                ) : (
                  <span className="lr-source-option-copy">
                    <strong>{t("host.sourcePicker.browser")}</strong>
                    <small>{t("host.sourcePicker.browserHint")}</small>
                  </span>
                )}
              </button>
            ) : null}

            {nativeTab && !browserCapture
              ? sources.map((target) => (
                  <CaptureSourceOption
                    key={nativeCaptureTargetKey(target)}
                    target={target}
                    disabled={selectionDisabled || (target.kind === "picker" && audioLocked && shareAudio && !supportsAudio(target))}
                    selected={target.kind === "picker" ? undefined : target === selectedTarget}
                    onPreview={onPreview}
                    onSelect={() => target.kind === "picker" ? submitNative(target) : setSelectedKey(nativeCaptureTargetKey(target))}
                  />
                ))
              : null}
          </div>
          </>}

          {nativeTab && nativeSources.kind === "loading" ? (
            <span className="lr-source-picker-status" role="status" aria-label={t("host.sourcePicker.loading")}>
              <Glyph name="refresh" className="lr-spin" size={18} />{!vis && t("host.sourcePicker.loading")}
            </span>
          ) : issueKey ? (
            <Pill icon="alert" label={t(issueKey)} comic="warning" />
          ) : browserCapture || activeTab === "camera" ? null : sources.length === 0 ? (
            <span
              className="lr-source-picker-status"
              role="status"
              aria-label={t(activeTab ? "host.sourcePicker.empty" : "host.capture.noSource")}
            >
              <HintComic kind="hint-no-sources" size={240} />
              {vis ? null : t(activeTab ? "host.sourcePicker.empty" : "host.capture.noSource")}
            </span>
          ) : null}
        </div>
        {(activeTab === "window" || activeTab === "display") && sources.some(target => target.kind !== "picker") && (
          <footer className="lr-source-picker-footer">
            <Btn icon="cast" tone="primary" title={confirmLabel} cap={confirmLabel}
              disabled={!selectedTarget || selectionDisabled || exclusionUnavailable || (audioLocked && shareAudio && !canShareAudio)}
              onClick={() => { if (selectedTarget) submitNative(selectedTarget); }} />
          </footer>
        )}
      </div>
    </div>
  );
}

function CaptureSourceOption({
  target,
  disabled,
  selected,
  onPreview,
  onSelect,
}: {
  target: NativeCaptureTarget;
  disabled: boolean;
  selected?: boolean;
  onPreview: (
    target: NativeCaptureTarget,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  onSelect: () => void;
}) {
  const { t } = useCopy();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const previewRequestRef = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const requestPreview = useCallback(() => {
    if (target.kind === "picker" || previewRequestRef.current) return;
    const request = new AbortController();
    previewRequestRef.current = request;
    void onPreview(target, request.signal).then((value) => {
      if (!request.signal.aborted && value) setPreview(value);
    });
  }, [onPreview, target]);

  useEffect(
    () => () => {
      previewRequestRef.current?.abort();
      previewRequestRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        requestPreview();
        observer.disconnect();
      }
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [requestPreview]);

  const title =
    target.kind === "picker" ? t("host.sourcePicker.system") : target.title;
  const action = target.kind === "picker" ? t("host.sourcePicker.systemAction") : title;

  return <CaptureSourceCard title={title} action={action}
    icon={target.kind === "picker" ? "share" : target.kind}
    hint={target.kind === "picker" ? "hint-source-picker" : target.kind === "display" ? "hint-capture-display" : "hint-capture-window"}
    preview={target.kind === "picker" ? undefined : preview} nativeKey={nativeCaptureTargetKey(target)} buttonRef={buttonRef}
    disabled={disabled} pressed={selected} onPreview={requestPreview} onSelect={onSelect} />;
}
