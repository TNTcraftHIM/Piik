import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { REACTION_DURATION_MS, REACTION_GLYPHS, isThrow, type ReactionId } from "../../../shared/room-interactions";
import type { RoomInteraction } from "../../lib/room-interactions";
import { identityHash } from "../../lib/identity-hash";
import { Glyph } from "../../ui/icons";

/** Props use the same small silhouette in the picker and on the couch. */
export function ReactionIcon({ reaction }: { reaction: ReactionId }) {
  if (!isThrow(reaction)) return <span aria-hidden="true">{REACTION_GLYPHS[reaction]}</span>;
  return <svg viewBox="0 0 40 40" width="32" height="32" aria-hidden="true">
    {reaction === "tomato" ? <>
      <path d="M20 11C5 3 0 31 16 34c20 5 26-30 4-23Z" fill="#e96c55" />
      <path d="m20 14-9-6 8 2 3-6 2 6 8-1-7 6Z" fill="#448e6b" />
      <path d="M10 20q-2 5 1 7" fill="none" stroke="#ffb399" strokeWidth="3" strokeLinecap="round" />
    </> : <>
      <path d="M24 5c2 7 10 7 5 13 8 1 9 7 5 10 8 8-22 9-28 3-5-5 1-9 5-10-4-5 2-8 6-9 4-1 5-4 7-7Z" fill="#997554" />
      <path d="M13 21q9 3 17-1M9 29q12 3 22-1" fill="none" stroke="#795b43" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18" cy="23" r="1.5" fill="#fff4dd" /><circle cx="25" cy="23" r="1.5" fill="#fff4dd" />
    </>}
  </svg>;
}

/** Fixed, event-seeded accents: no independent timer or mutable random stream. */
function ReactionAccents({ reaction, seed }: { reaction: ReactionId; seed: number }) {
  return <svg className={`lr-reaction-accents is-${reaction}`} viewBox="-48 -48 96 96" width="96" height="96">
    {reaction === "tomato" && <ellipse className="lr-reaction-impact" rx="18" ry="12" />}
    {Array.from({ length: reaction === "sleep" ? 3 : 5 }, (_, index) => {
      const angle = (-160 + index * 35 + (seed % 13)) * Math.PI / 180;
      const radius = 27 + ((seed >>> (index * 4)) % 12);
      return <g key={index} className="lr-reaction-spark" style={{
        "--spark-x": `${Math.cos(angle) * radius}px`, "--spark-y": `${Math.sin(angle) * radius}px`,
        "--spark-turn": `${index * 23 - 46}deg`,
      } as CSSProperties}>
        {reaction === "heart" ? <path d="M0 3C-8-1-5-7 0-4 5-7 8-1 0 3Z" />
          : reaction === "sleep" ? <text x="0" y="0" textAnchor="middle">z</text>
          : reaction === "poop" ? <circle r={4 + index % 2} />
          : reaction === "tomato" ? <ellipse rx="2.5" ry="4.5" />
          : reaction === "party" ? <rect x="-2" y="-3" width="4" height="6" rx="1" />
          : <path d="M0-4 1-1 4 0 1 1 0 4-1 1-4 0-1-1Z" />}
      </g>;
    })}
  </svg>;
}

/** Event expiry owns lifetime. This component owns only placement and its own impact. */
export function RoomReaction({ reaction, area, now }: {
  reaction: RoomInteraction & { expiresAt: number }; area: RefObject<HTMLDivElement | null>; now: () => number;
}) {
  const flight = useRef<HTMLDivElement>(null);
  const payload = reaction.payload;
  useLayoutEffect(() => {
    const root = area.current;
    const element = flight.current;
    if (!root || !element || payload.kind !== "reaction") return;
    const pawn = (peer: string) => root.querySelector<SVGSVGElement>(`[data-room-peer="${CSS.escape(peer)}"] .lr-person`);
    const sender = pawn(reaction.sender.peerId);
    const recipient = pawn(payload.targetPeerId ?? reaction.sender.peerId);
    if (!sender || !recipient) return;
    let frame = 0;
    let impact: Animation | undefined;
    const place = () => {
      if (now() >= reaction.expiresAt || !sender.isConnected || !recipient.isConnected) {
        element.style.visibility = "hidden";
        return;
      }
      frame = requestAnimationFrame(place);
      if (document.hidden || !sender.getClientRects().length || !recipient.getClientRects().length) {
        element.style.visibility = "hidden";
        impact?.cancel();
        return;
      }
      const rect = element.getBoundingClientRect();
      // Transforms do not trigger ResizeObserver. Follow the actual head for
      // this event's remaining lifetime, including hover, lean and impact.
      const from = sender.querySelector(".lr-person-head")?.getBoundingClientRect();
      const to = recipient.querySelector(".lr-person-head")?.getBoundingClientRect();
      if (!from || !to) { element.style.visibility = "hidden"; return; }
      element.style.setProperty("--from-x", `${from.x - rect.x + from.width / 2}px`);
      element.style.setProperty("--from-y", `${from.y - rect.y + from.height / 2}px`);
      element.style.setProperty("--to-x", `${to.x - rect.x + to.width / 2}px`);
      element.style.setProperty("--to-y", `${to.y - rect.y + to.height / 2}px`);
      element.style.setProperty("--throw-direction", from.x > to.x ? "-1" : "1");
      element.style.visibility = "visible";
    };
    place();
    const body = recipient.querySelector<SVGGElement>(".lr-reaction-body");
    if (isThrow(payload.reaction) && payload.targetPeerId && body &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches && !root.closest("[data-comic-reduced-motion]")) {
      const elapsed = Math.max(0, REACTION_DURATION_MS - (reaction.expiresAt - now()));
      const delay = REACTION_DURATION_MS * .32 - elapsed;
      if (delay > -560) {
        const direction = sender.getBoundingClientRect().x > recipient.getBoundingClientRect().x ? -1 : 1;
        impact = body.animate([
          { transform: "none" },
          { transform: payload.reaction === "tomato" ? `rotate(${direction * 6}deg) scale(1.05,.95)` : `translateX(${direction * 4}px) rotate(${direction * 8}deg)` },
          { transform: `rotate(${-direction * 3}deg)` },
          { transform: "none" },
        ], { duration: 560, delay, easing: "ease-out" });
      }
    }
    return () => { cancelAnimationFrame(frame); impact?.cancel(); };
  }, [area, reaction, payload, now]);
  if (payload.kind !== "reaction") return null;
  const gift = Boolean(payload.targetPeerId && !isThrow(payload.reaction));
  return <div ref={flight} className={`lr-reaction-flight ${payload.targetPeerId ? gift ? "is-gift" : "is-throw" : "is-expression"}`}
    style={{ visibility: "hidden", "--reaction-duration": `${REACTION_DURATION_MS}ms` } as CSSProperties} aria-hidden="true">
    <span className={`lr-reaction-projectile is-${payload.reaction}`} onAnimationStart={event => {
      // CSS restarts after display:none or reduced motion. Event expiry still
      // owns time, including a late mount when effects are shown again.
      for (const animation of (event.target as Element).getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName.startsWith("lr-reaction-")) {
          animation.currentTime = Math.min(REACTION_DURATION_MS, Math.max(0, REACTION_DURATION_MS - (reaction.expiresAt - now())));
        }
      }
    }}>{gift && <span className="lr-reaction-from"><span>{reaction.sender.displayName}</span><Glyph name="arrowDown" size={12} /></span>}
      <ReactionAccents reaction={payload.reaction} seed={identityHash(`${reaction.sender.peerId}:${reaction.id}`)} />
      <span className="lr-reaction-glyph"><ReactionIcon reaction={payload.reaction} /></span></span>
  </div>;
}
