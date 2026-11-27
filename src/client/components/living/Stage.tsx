// The TV stage: frame, screen, status slot. Pages render their own <video>
// (stream binding stays with the page); shared overlays are provided here.
import type { ReactNode } from "react";
import { Glyph, type GlyphName } from "../../ui/icons";
import { Comic, type ComicKind } from "./Comic";
import type { ComicTone } from "./comic-presentation";
import { WaitingCaption } from "./WaitingStatus";

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
        data-tooltip-player
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
  waiting = false,
  comic,
  tone,
  onActivate,
  still,
}: {
  icon: GlyphName;
  message: string;
  dim?: boolean;
  waiting?: boolean;
  comic?: ComicKind;
  tone?: ComicTone;
  onActivate?: () => void;
  still?: boolean;
}) {
  const isWaiting = waiting && !onActivate;
  const content = (
    <>
      {comic ? <Comic kind={comic} theme="stage" tone={tone}
        motion={isWaiting ? "progress" : undefined} /> : null}
      <span className="lr-tv-status-content">
        {(!comic || onActivate) && (
          <span className={`lr-tv-big${isWaiting ? " lr-spin" : ""}${onActivate ? " is-action is-ripple" : ""}`}>
            <Glyph name={icon} size={30} draw="stage-overlay" />
          </span>
        )}
        <span className="lr-tv-msg">{message}</span>
      </span>
      {isWaiting && <WaitingCaption still={still} />}
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
