import { useCallback, useEffect, useRef, useState } from "react";

import type { NativeCaptureTarget } from "../../native/wire";
import { nativeCaptureTargetKey } from "../../native/capture-selection";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

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
  onCancel,
}: {
  nativeSources: NativeSourceList;
  onBrowser: () => void;
  onNative: (target: NativeCaptureTarget, audio: boolean) => void;
  onPreview: (target: NativeCaptureTarget) => Promise<string | null>;
  onCancel: () => void;
}) {
  const { vis, t } = useCopy();
  const [shareAudio, setShareAudio] = useState(true);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [onCancel]);

  const noNativeSources =
    nativeSources.kind === "unavailable" ||
    (nativeSources.kind === "ready" && nativeSources.sources.length === 0);
  const anyNativeAudio =
    nativeSources.kind === "ready" &&
    (nativeSources.processAudio || nativeSources.systemAudio);
  const supportsAudio = (target: NativeCaptureTarget): boolean =>
    nativeSources.kind === "ready" &&
    (target.kind === "window"
      ? nativeSources.processAudio
      : nativeSources.systemAudio);

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
              <small>{t("host.sourcePicker.hint")}</small>
            </span>
          )}
          <button
            type="button"
            className="lr-source-picker-close"
            title={vis ? undefined : t("common.cancel")}
            aria-label={t("common.cancel")}
            onClick={onCancel}
          >
            <Glyph name="x" size={18} />
          </button>
        </header>

        {vis ? (
          <div className="lr-source-picker-visual-guide" aria-hidden="true">
            <span className="lr-source-picker-guide-icon">
              <Glyph name="globe" size={18} />
            </span>
            <span className="lr-source-picker-guide-flow">
              <i />
              <i />
              <i />
            </span>
            <span className="lr-source-picker-guide-icon is-target">
              <Glyph name="tv" size={18} />
            </span>
          </div>
        ) : null}

        <div className="lr-source-picker-list">
          <button
            type="button"
            className="lr-source-option is-browser"
            aria-label={t("host.sourcePicker.browser")}
            onClick={onBrowser}
            autoFocus
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

          {nativeSources.kind === "ready"
            ? nativeSources.sources.map((target) => (
                <CaptureSourceOption
                  key={nativeCaptureTargetKey(target)}
                  target={target}
                  audio={shareAudio && supportsAudio(target)}
                  onPreview={onPreview}
                  onSelect={() =>
                    onNative(target, shareAudio && supportsAudio(target))
                  }
                />
              ))
            : null}
        </div>

        {nativeSources.kind === "ready" ? (
          <div className="lr-source-picker-audio">
            <span aria-hidden="true">
              <Glyph name="speaker" size={19} />
            </span>
            {vis ? null : <span>{t("host.sourcePicker.audio")}</span>}
            <button
              type="button"
              className="lr-switch"
              role="switch"
              aria-checked={shareAudio && anyNativeAudio}
              aria-label={t("host.sourcePicker.audio")}
              title={vis ? undefined : t("host.sourcePicker.audioHint")}
              disabled={!anyNativeAudio}
              onClick={() => setShareAudio((current) => !current)}
            />
          </div>
        ) : null}

        {nativeSources.kind === "loading" ? (
          <span
            className="lr-source-picker-status"
            role="status"
            aria-label={t("host.sourcePicker.loading")}
          >
            <Glyph name="loader" size={18} className="lr-spin" />
            {vis ? null : <span>{t("host.sourcePicker.loading")}</span>}
          </span>
        ) : noNativeSources && !vis ? (
          <span className="lr-source-picker-status">
            {t("host.sourcePicker.unavailable")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CaptureSourceOption({
  target,
  audio,
  onPreview,
  onSelect,
}: {
  target: NativeCaptureTarget;
  audio: boolean;
  onPreview: (target: NativeCaptureTarget) => Promise<string | null>;
  onSelect: () => void;
}) {
  const { vis, t } = useCopy();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const requestedRef = useRef(false);
  const mountedRef = useRef(true);
  const [preview, setPreview] = useState<string | null>(null);
  const requestPreview = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void onPreview(target).then((value) => {
      if (mountedRef.current && value) setPreview(value);
    });
  }, [onPreview, target]);

  useEffect(
    () => () => {
      mountedRef.current = false;
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

  return (
    <button
      ref={buttonRef}
      type="button"
      className="lr-source-option"
      data-native-source={nativeCaptureTargetKey(target)}
      title={target.title}
      aria-label={t(
        target.kind === "display"
          ? "host.sourcePicker.display"
          : "host.sourcePicker.window",
        { title: target.title },
      )}
      onMouseEnter={requestPreview}
      onFocus={requestPreview}
      onClick={onSelect}
    >
      <span className="lr-source-option-preview" aria-hidden="true">
        {preview ? (
          <img src={preview} alt="" />
        ) : (
          <Glyph name={target.kind === "display" ? "tv" : "share"} size={23} />
        )}
      </span>
      <span className="lr-source-option-copy">
        <strong>{target.title}</strong>
        {vis ? null : (
          <small>
            {t(
              audio
                ? "host.sourcePicker.nativeAudio"
                : "host.sourcePicker.nativeVideo",
            )}
          </small>
        )}
      </span>
    </button>
  );
}
