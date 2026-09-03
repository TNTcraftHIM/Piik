import { useEffect } from "react";

import type { NativeWindowTarget } from "../../native/wire";
import { nativeWindowKey } from "../../native/capture-selection";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

export type NativeSourceList =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; windows: NativeWindowTarget[] };

export function CaptureSourcePicker({
  nativeSources,
  onBrowser,
  onNative,
  onCancel,
}: {
  nativeSources: NativeSourceList;
  onBrowser: () => void;
  onNative: (target: NativeWindowTarget) => void;
  onCancel: () => void;
}) {
  const { vis, t } = useCopy();

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [onCancel]);

  const noNativeWindows =
    nativeSources.kind === "unavailable" ||
    (nativeSources.kind === "ready" && nativeSources.windows.length === 0);

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
            ? nativeSources.windows.map((target) => (
                <button
                  key={nativeWindowKey(target)}
                  type="button"
                  className="lr-source-option"
                  data-native-window={nativeWindowKey(target)}
                  title={target.title}
                  aria-label={t("host.sourcePicker.window", {
                    title: target.title,
                  })}
                  onClick={() => onNative(target)}
                >
                  <span className="lr-source-option-icon" aria-hidden="true">
                    <Glyph name="tv" size={23} />
                  </span>
                  <span className="lr-source-option-copy">
                    <strong>{target.title}</strong>
                    {vis ? null : (
                      <small>{t("host.sourcePicker.native")}</small>
                    )}
                  </span>
                </button>
              ))
            : null}
        </div>

        {nativeSources.kind === "loading" ? (
          <span
            className="lr-source-picker-status"
            role="status"
            aria-label={t("host.sourcePicker.loading")}
          >
            <Glyph name="loader" size={18} className="lr-spin" />
            {vis ? null : <span>{t("host.sourcePicker.loading")}</span>}
          </span>
        ) : noNativeWindows && !vis ? (
          <span className="lr-source-picker-status">
            {t("host.sourcePicker.unavailable")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
