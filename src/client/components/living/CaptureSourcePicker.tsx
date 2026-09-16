import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { NativeCaptureTarget } from "../../native/wire";
import { nativeCaptureTargetKey } from "../../native/capture-selection";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { Tooltip } from "./Tooltip";
import { HintComic } from "./hints";
import { Pill } from "./primitives";
import { WaitingCaption } from "./WaitingStatus";

const SOURCE_TABS = ["browser", "window", "display"] as const;
type SourceTab = (typeof SOURCE_TABS)[number];
const SOURCE_ICONS = {
  browser: "globe",
  window: "window",
  display: "display",
} satisfies Record<SourceTab, GlyphName>;

export type NativeSourceList =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "incompatible" }
  | { kind: "unsupported" }
  | { kind: "failed" }
  | {
      kind: "ready";
      sources: NativeCaptureTarget[];
      processAudio: boolean;
      systemAudio: boolean;
      captureBorderControl?: boolean;
    };

export function CaptureSourcePicker({
  nativeSources,
  onBrowser,
  onNative,
  onPreview,
  onRefresh,
  onCancel,
  browserAvailable = true,
  initialTab = "window",
  initialAudio = true,
  initialShowCaptureBorder = false,
  audioLocked = false,
  selectionDisabled = false,
}: {
  nativeSources: NativeSourceList;
  onBrowser: () => void;
  onNative: (target: NativeCaptureTarget, audio: boolean, showCaptureBorder: boolean) => void;
  onPreview: (
    target: NativeCaptureTarget,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  onRefresh: () => void;
  onCancel: () => void;
  browserAvailable?: boolean;
  initialTab?: SourceTab;
  initialAudio?: boolean;
  initialShowCaptureBorder?: boolean;
  audioLocked?: boolean;
  selectionDisabled?: boolean;
}) {
  const { vis, t } = useCopy();
  const pickerId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<SourceTab>(initialTab);
  const [shareAudio, setShareAudio] = useState(initialAudio);
  const [showCaptureBorder, setShowCaptureBorder] = useState(initialShowCaptureBorder);
  const activeTab = tab === "browser" && !browserAvailable ? "window" : tab;
  const supportsCaptureBorder = nativeSources.kind === "ready" && nativeSources.captureBorderControl === true;
  const issueKey = nativeSources.kind === "incompatible" ? "native.incompatible"
    : activeTab !== "browser" && (nativeSources.kind === "unavailable" ||
      nativeSources.kind === "unsupported" || nativeSources.kind === "failed")
      ? `host.sourcePicker.${nativeSources.kind}` as const
      : null;

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented ||
          !panelRef.current?.contains(event.target as Node | null)) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [onCancel]);

  const sources =
    nativeSources.kind === "ready"
      ? nativeSources.sources.filter(
          (target) => target.kind === activeTab || target.kind === "picker",
        )
      : [];
  const supportsAudio = (target: NativeCaptureTarget): boolean =>
    nativeSources.kind === "ready" &&
    (target.kind === "window"
      ? nativeSources.processAudio
      : nativeSources.systemAudio);
  const anyNativeAudio = sources.some(supportsAudio);
  const refreshLabel = t(nativeSources.kind === "loading" ? "host.sourcePicker.loading" : "host.sourcePicker.refresh");
  const audioAction = t(!anyNativeAudio ? "host.noAudio" : audioLocked
    ? "host.sourcePicker.audioLocked"
    : shareAudio ? "host.sourcePicker.audioOff" : "host.sourcePicker.audioOn");
  const audioLabel = t(
    activeTab === "window" && sources.some((target) => target.kind === "window")
      ? "host.sourcePicker.windowAudio"
      : "host.sourcePicker.systemAudio",
  );
  const refreshButton = (
    <button
      type="button"
      className="lr-source-picker-refresh"
      aria-label={refreshLabel}
      disabled={nativeSources.kind === "loading"}
      onClick={onRefresh}
    >
      <Glyph name="refresh" size={18} className={nativeSources.kind === "loading" ? "lr-spin" : undefined} />
    </button>
  );
  const closeButton = (
    <button
      type="button"
      className="lr-source-picker-close"
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
      aria-checked={shareAudio && anyNativeAudio}
      aria-label={audioLabel}
      disabled={audioLocked || !anyNativeAudio}
      onClick={() => setShareAudio((current) => !current)}
    />
  );

  return (
    <div
      ref={panelRef}
      className={`lr-tv-overlay lr-source-picker${vis ? " is-visual" : ""}`}
      role="dialog"
      aria-label={t("host.sourcePicker.title")}
    >
      <div className="lr-source-picker-panel">
        <header className="lr-source-picker-head">
          <span className="lr-source-picker-mark" aria-hidden="true">
            <Glyph name="share" size={22} draw="capture-source" />
          </span>
          {vis ? null : (
            <span className="lr-source-picker-copy">
              <strong>{t("host.sourcePicker.title")}</strong>
            </span>
          )}
          <Tooltip kind="hint-refresh-sources" text={vis ? undefined : refreshLabel}
            tone={nativeSources.kind === "loading" ? "busy" : undefined}
            motion={nativeSources.kind === "loading" ? "progress" : undefined}
            place="below" align="end">
            {refreshButton}
          </Tooltip>
          <Tooltip kind="hint-close" text={vis ? undefined : t("common.cancel")} place="below" align="end">
            {closeButton}
          </Tooltip>
        </header>

        <div
          className="lr-source-picker-tabs"
          role="tablist"
          aria-label={t("host.sourcePicker.title")}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            const available = SOURCE_TABS.filter(
              (value) => value !== "browser" || browserAvailable,
            );
            const index = available.indexOf(activeTab);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? available.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      available.length) %
                    available.length;
            const nextTab = available[next]!;
            event.preventDefault();
            setTab(nextTab);
            event.currentTarget
              .querySelector<HTMLButtonElement>(
                `[data-source-tab="${nextTab}"]`,
              )
              ?.focus();
          }}
        >
          {SOURCE_TABS.map((value) => {
            const button = (
              <button
                type="button"
                role="tab"
                id={`${pickerId}-${value}`}
                data-source-tab={value}
                aria-controls={`${pickerId}-panel`}
                aria-selected={activeTab === value}
                aria-label={t(`host.sourcePicker.tab.${value}`)}
                tabIndex={activeTab === value ? 0 : -1}
                disabled={value === "browser" && !browserAvailable}
                onClick={() => setTab(value)}
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
                kind={`hint-capture-${value}`}
                text={vis ? undefined : t(`host.sourcePicker.tab.${value}`)}
                place="below"
              >
                {button}
              </Tooltip>
            );
          })}
        </div>

        <div
          className="lr-source-picker-body"
          role="tabpanel"
          id={`${pickerId}-panel`}
          aria-labelledby={`${pickerId}-${activeTab}`}
        >
          <div className="lr-source-picker-list">
            {activeTab === "browser" ? (
              <button
                type="button"
                className="lr-source-option is-browser"
                aria-label={t("host.sourcePicker.browser")}
                disabled={selectionDisabled}
                onClick={onBrowser}
              >
                <span className="lr-source-option-icon" aria-hidden="true">
                  <Glyph name="globe" size={23} />
                </span>
                {vis ? (
                  <span className="visually-hidden">
                    {t("host.sourcePicker.browser")}
                  </span>
                ) : (
                  <span className="lr-source-option-copy">
                    <strong>{t("host.sourcePicker.browser")}</strong>
                    <small>{t("host.sourcePicker.browserHint")}</small>
                  </span>
                )}
              </button>
            ) : null}

            {activeTab !== "browser"
              ? sources.map((target) => (
                  <CaptureSourceOption
                    key={nativeCaptureTargetKey(target)}
                    target={target}
                    disabled={
                      selectionDisabled || (audioLocked && shareAudio && !supportsAudio(target))
                    }
                    onPreview={onPreview}
                    onSelect={() =>
                      onNative(target, shareAudio && supportsAudio(target),
                        supportsCaptureBorder && showCaptureBorder)
                    }
                  />
                ))
              : null}
          </div>

          {activeTab !== "browser" &&
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
                    kind={!anyNativeAudio ? "no-audio" : audioLocked
                      ? (shareAudio ? "hint-share-audio-fixed" : "hint-silent-share-fixed")
                      : shareAudio ? "hint-stop-audio" : "hint-share-audio"}
                    text={vis ? undefined : `${audioAction} · ${t("host.sourcePicker.audioHint")}`}
                    place="below"
                  >
                    {audioSwitch}
                  </Tooltip>
                </div>
              ) : null}
            </div>
          ) : null}

          {issueKey ? (
            <Pill icon="alert" label={t(issueKey)} comic="warning" />
          ) : activeTab === "browser" ? null : nativeSources.kind === "loading" ? (
            <span
              className="lr-source-picker-status"
              role="status"
              aria-label={t("host.sourcePicker.loading")}
            >
              <HintComic kind="hint-refresh-sources" size={240} tone="busy" motion="progress" />
              {vis ? null : <span>{t("host.sourcePicker.loading")}</span>}
              <WaitingCaption context="host.sourcePicker.loading" />
            </span>
          ) : sources.length === 0 ? (
            <span
              className="lr-source-picker-status"
              role="status"
              aria-label={t("host.sourcePicker.empty")}
            >
              <HintComic kind="hint-no-sources" size={240} />
              {vis ? null : t("host.sourcePicker.empty")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CaptureSourceOption({
  target,
  disabled,
  onPreview,
  onSelect,
}: {
  target: NativeCaptureTarget;
  disabled: boolean;
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
  const action =
    target.kind === "picker"
      ? t("host.sourcePicker.systemAction")
      : t(
          target.kind === "display"
            ? "host.sourcePicker.display"
            : "host.sourcePicker.window",
          { title },
        );

  return (
    <Tooltip kind={target.kind === "picker" ? "hint-source-picker" : target.kind === "display" ? "hint-capture-display" : "hint-capture-window"} text={title} className="lr-source-option-hint">
      <button
        ref={buttonRef}
        type="button"
        className="lr-source-option"
        data-native-source={nativeCaptureTargetKey(target)}
        aria-label={action}
        disabled={disabled}
        onMouseEnter={requestPreview}
        onFocus={requestPreview}
        onClick={onSelect}
      >
        <span className="lr-source-option-copy">
          <strong>{title}</strong>
        </span>
        <span className="lr-source-option-preview" aria-hidden="true">
          {preview ? (
            <img src={preview} alt="" />
          ) : (
            <Glyph name={target.kind === "picker" ? "share" : target.kind} size={23} />
          )}
        </span>
      </button>
    </Tooltip>
  );
}
