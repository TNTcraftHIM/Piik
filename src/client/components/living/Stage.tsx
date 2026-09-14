// The TV stage: frame, screen, status slot. Pages render their own <video>
// (stream binding stays with the page); shared overlays are provided here.
import type { ReactNode } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { useCopy } from "../../ui/copy";
import { Comic, type ComicKind } from "./Comic";
import type { ComicTone } from "./comic-presentation";
import { BrandLoader } from "./BrandMark";

export function StageTv({
  hasEntry,
  live,
  children,
  label,
  indicator,
}: {
  hasEntry?: boolean;
  live?: boolean;
  children: ReactNode;
  label: string;
  indicator?: ReactNode;
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
      <div className="lr-tv-chin">{indicator}</div>
    </div>
  );
}

export function StaticNoise() {
  return <div className="lr-tv-static" aria-hidden="true" />;
}

export function StageOverlay({
  icon,
  message,
  dim,
  transition,
  spin,
  comic,
  tone,
  progress,
  onActivate,
}: {
  icon: GlyphName;
  message: string;
  dim?: boolean;
  transition?: boolean;
  spin?: boolean;
  comic?: ComicKind;
  tone?: ComicTone;
  progress?: string;
  onActivate?: () => void;
}) {
  const { vis } = useCopy();
  const showMascot =
    transition ||
    (Boolean(comic) &&
      (Boolean(spin) || comic === "waiting-for-host" || comic === "recovering"));
  const content = (
    <>
      {comic ? <Comic kind={comic} theme="stage" tone={tone}
        motion={transition || spin ? "progress" : undefined} /> : null}
      <span className="lr-tv-status-content">
        {(showMascot || vis || !comic || onActivate) && (showMascot ? (
          <BrandLoader />
        ) : (
          <span className={`lr-tv-big${spin ? " lr-spin" : ""}${onActivate ? " is-action is-ripple" : ""}`}>
            <Glyph name={icon} size={30} draw="stage-overlay" />
          </span>
        ))}
        {vis ? progress && (
          <span className="lr-tv-progress" aria-label={progress}>
            <Glyph name="refresh" size={17} className="lr-spin" />
            <span className="lr-tv-msg">{progress}</span>
          </span>
        ) : <span className="lr-tv-msg">{message}</span>}
      </span>
    </>
  );
  if (onActivate) {
    return (
      <button type="button" className={`lr-tv-overlay${dim ? " is-dim" : ""}${comic ? " has-comic" : ""}`} onClick={onActivate} aria-label={message}>
        {content}
      </button>
    );
  }
  return (
    <div
      // Passive state layer: it must not intercept clicks meant for the
      // playback controls it covers (it owns no controls itself).
      className={`lr-tv-overlay is-passive${dim ? " is-dim" : ""}${comic ? " has-comic" : ""}`}
      role="status"
      aria-label={message}
    >
      {content}
    </div>
  );
}
