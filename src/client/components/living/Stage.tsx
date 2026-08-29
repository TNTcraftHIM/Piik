// The TV stage: frame, screen, chin LED. Pages render their own <video>
// (stream binding stays with the page); overlays and the connecting
// storyboard are provided here.
import type { ReactNode } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Comic, type ComicKind } from "./Comic";
import { BrandLoader, BrandMark } from "./BrandMark";

export type ChinState = "off" | "on" | "warn" | "bad" | "busy";

export function StageTv({
  chin,
  hasEntry,
  live,
  children,
  label,
}: {
  chin: ChinState;
  hasEntry?: boolean;
  live?: boolean;
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="lr-tv">
      <div
        className={`lr-tv-screen${hasEntry ? " has-entry" : ""}${live ? " is-on" : ""}`}
        role="group"
        aria-label={label}
      >
        {children}
      </div>
      <div className="lr-tv-chin">
        <i className={chin === "off" ? "" : `is-${chin}`} />
      </div>
    </div>
  );
}

export function StaticNoise() {
  return <div className="lr-tv-static" aria-hidden="true" />;
}

export function StoryBoard({
  step,
  showBrand = false,
}: {
  step: 0 | 1 | 2;
  showBrand?: boolean;
}) {
  const { vis, t } = useCopy();
  const panels: [GlyphName, CopyKey][] = [
    ["door", "story.room"],
    ["plug", "story.link"],
    ["tv", "story.show"],
  ];
  return (
    <div className="lr-storyboard" role="status" aria-label={t("host.starting")}>
      {showBrand ? <BrandMark size={40} motion="loop" /> : null}
      <div className="lr-story" aria-hidden="true">
        {panels.map(([icon, key], index) => (
          <span key={key} style={{ display: "contents" }}>
            {index > 0 ? (
              <span className={`lr-story-link${step > index - 1 ? " is-done" : ""}`} />
            ) : null}
            <span
              className={`lr-story-item${step > index ? " is-done" : step === index ? " is-now" : ""}`}
            >
              <span
                className={`lr-story-panel${step > index ? " is-done" : step === index ? " is-now" : ""}`}
              >
                <Glyph name={step > index ? "check" : icon} size={22} />
              </span>
              {vis ? null : <span className="lr-story-cap">{t(key)}</span>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function StageOverlay({
  icon,
  message,
  dim,
  transition,
  spin,
  comic,
  onActivate,
}: {
  icon: GlyphName;
  message: string;
  dim?: boolean;
  transition?: boolean;
  spin?: boolean;
  comic?: ComicKind;
  onActivate?: () => void;
}) {
  const { vis } = useCopy();
  const content = (
    <>
      {vis && comic ? <Comic kind={comic} theme="stage" /> : null}
      {transition ? (
        <BrandLoader />
      ) : (
        <span className={`lr-tv-big${spin ? " lr-spin" : ""}${onActivate ? " is-action is-ripple" : ""}`}>
          <Glyph name={icon} size={30} draw="stage-overlay" />
        </span>
      )}
      {vis ? null : <span className="lr-tv-msg">{message}</span>}
    </>
  );
  if (onActivate) {
    return (
      <button type="button" className={`lr-tv-overlay${dim ? " is-dim" : ""}`} onClick={onActivate} aria-label={message}>
        {content}
      </button>
    );
  }
  return (
    <div
      className={`lr-tv-overlay${dim ? " is-dim" : ""}`}
      role="status"
      aria-label={message}
    >
      {content}
    </div>
  );
}
