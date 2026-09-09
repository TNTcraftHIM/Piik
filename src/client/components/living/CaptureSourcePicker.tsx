import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { NativeCaptureTarget } from "../../native/wire";
import { nativeCaptureTargetKey } from "../../native/capture-selection";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { ComicTooltip } from "./ComicTooltip";

const SOURCE_TABS = ["browser", "window", "display"] as const;
type SourceTab = (typeof SOURCE_TABS)[number];
const SOURCE_ICONS = {
  browser: "globe",
  window: "switchSource",
  display: "tv",
};

export type NativeSourceList =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      sources: NativeCaptureTarget[];
      processAudio: boolean;
      systemAudio: boolean;
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
  audioLocked = false,
}: {
  nativeSources: NativeSourceList;
  onBrowser: () => void;
  onNative: (target: NativeCaptureTarget, audio: boolean) => void;
  onPreview: (
    target: NativeCaptureTarget,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  onRefresh: () => void;
  onCancel: () => void;
  browserAvailable?: boolean;
  initialTab?: SourceTab;
  initialAudio?: boolean;
  audioLocked?: boolean;
}) {
  const { vis, t } = useCopy();
  const pickerId = useId();
  const [tab, setTab] = useState<SourceTab>(initialTab);
  const [shareAudio, setShareAudio] = useState(initialAudio);
  const activeTab = tab === "browser" && !browserAvailable ? "window" : tab;

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
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
  const audioLabel = t(
    activeTab === "window" && sources.some((target) => target.kind === "window")
      ? "host.sourcePicker.windowAudio"
      : "host.sourcePicker.systemAudio",
  );

  return (
    <div
      className={`lr-tv-overlay lr-source-picker${vis ? " is-visual" : ""}`}
      role="dialog"
      aria-modal="true"
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
          <button
            type="button"
            className="lr-source-picker-refresh"
            title={vis ? undefined : t("host.sourcePicker.refresh")}
            aria-label={t("host.sourcePicker.refresh")}
            disabled={nativeSources.kind === "loading"}
            onClick={onRefresh}
          >
            <Glyph
              name="refresh"
              size={18}
              className={
                nativeSources.kind === "loading" ? "lr-spin" : undefined
              }
            />
          </button>
          <button
            type="button"
            className="lr-source-picker-close"
            title={vis ? undefined : t("common.cancel")}
            aria-label={t("common.cancel")}
            onClick={onCancel}
            autoFocus
          >
            <Glyph name="x" size={18} />
          </button>
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
            return vis ? (
              <ComicTooltip key={value} kind={`hint-capture-${value}`} place="below">
                {button}
              </ComicTooltip>
            ) : (
              <span key={value}>{button}</span>
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
                    audio={shareAudio && supportsAudio(target)}
                    disabled={
                      audioLocked && shareAudio && !supportsAudio(target)
                    }
                    onPreview={onPreview}
                    onSelect={() =>
                      onNative(target, shareAudio && supportsAudio(target))
                    }
                  />
                ))
              : null}
          </div>

          {activeTab !== "browser" &&
          nativeSources.kind === "ready" &&
          sources.length > 0 ? (
            <div className="lr-source-picker-audio">
              <span aria-hidden="true">
                <Glyph name="speaker" size={19} />
              </span>
              {vis ? null : <span>{audioLabel}</span>}
              <button
                type="button"
                className="lr-switch"
                role="switch"
                aria-checked={shareAudio && anyNativeAudio}
                aria-label={audioLabel}
                title={vis ? undefined : t("host.sourcePicker.audioHint")}
                disabled={audioLocked || !anyNativeAudio}
                onClick={() => setShareAudio((current) => !current)}
              />
            </div>
          ) : null}

          {activeTab === "browser" ? null : nativeSources.kind === "loading" ? (
            <span
              className="lr-source-picker-status"
              role="status"
              aria-label={t("host.sourcePicker.loading")}
            >
              <Glyph name="loader" size={18} className="lr-spin" />
              {vis ? null : <span>{t("host.sourcePicker.loading")}</span>}
            </span>
          ) : sources.length === 0 ? (
            <span
              className="lr-source-picker-status"
              role="status"
              aria-label={t("host.sourcePicker.empty")}
            >
              <Glyph name="eyeOff" size={22} />
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
  audio,
  disabled,
  onPreview,
  onSelect,
}: {
  target: NativeCaptureTarget;
  audio: boolean;
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
    <button
      ref={buttonRef}
      type="button"
      className="lr-source-option"
      data-native-source={nativeCaptureTargetKey(target)}
      title={title}
      aria-label={action}
      disabled={disabled}
      onMouseEnter={requestPreview}
      onFocus={requestPreview}
      onClick={onSelect}
    >
      <span className="lr-source-option-copy">
        <strong>{title}</strong>
        {audio ? (
          <span>
            <Glyph name="speaker" size={16} />
            <span className="visually-hidden">
              {t("host.sourcePicker.nativeAudio")}
            </span>
          </span>
        ) : null}
      </span>
      <span className="lr-source-option-preview" aria-hidden="true">
        {preview ? (
          <img src={preview} alt="" />
        ) : (
          <Glyph name={target.kind === "window" ? "share" : "tv"} size={23} />
        )}
      </span>
    </button>
  );
}
