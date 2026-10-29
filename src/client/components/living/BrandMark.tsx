import { useEffect, useId, useRef, useState, type AnimationEvent } from "react";
import { bindSvgReplayOnPointerEnter } from "../../ui/animation";

export type BrandMotion = "static" | "once" | "loop";

export function BrandMark({
  size = 32,
  motion = "static",
}: {
  size?: number;
  motion?: BrandMotion;
}) {
  const animated = motion !== "static";
  const [phase, setPhase] = useState<"drawing" | "intro" | "active">("drawing");
  const motionClass =
    motion === "loop"
      ? ` is-animated is-loop-${phase === "active" ? "active" : "intro"}`
      : motion === "once"
        ? " is-once"
        : "";
  const markRef = useRef<SVGSVGElement>(null);
  // Each instance owns its pupil mask; React ids contain characters url() rejects.
  const pupils = `lr-brand-pupils-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    setPhase("drawing");
  }, [motion]);

  useEffect(() => {
    if (motion !== "once" || !markRef.current) return;
    return bindSvgReplayOnPointerEnter(markRef.current, () => setPhase("drawing"));
  }, [motion]);

  const finishLoopIntro = (event: AnimationEvent<SVGPathElement>): void => {
    if (motion === "loop" && event.animationName === "lr-brand-sparkle-alt") {
      setPhase("active");
    }
  };

  return (
    <svg
      ref={markRef}
      className={`lr-brand-mark${motionClass}${animated && phase === "drawing" ? " is-drawing" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <mask id={pupils} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="#fff" />
        <g className="lr-brand-pupils" fill="#000">
          <circle cx="12.4" cy="9.1" r="1.4" />
          <circle cx="22.4" cy="9.1" r="1.4" />
        </g>
      </mask>
      <g className="lr-brand-shell" strokeWidth={4.2}>
        <path className="lr-brand-stem" pathLength={1} d="M11 24.5V16.2" />
        <path className="lr-brand-stem" pathLength={1} d="M21 24.5V16.2"
          onAnimationEnd={event => { if (event.animationName === "lr-brand-draw") setPhase("intro"); }} />
      </g>
      <g className="lr-brand-face" mask={`url(#${pupils})`} fill="currentColor" stroke="none">
        <circle className="lr-brand-eye" cx="11" cy="9" r="3.5" />
        <circle className="lr-brand-eye" cx="21" cy="9" r="3.5" />
      </g>
      <g className="lr-brand-sparkles" strokeWidth={animated ? 1.6 : 1.8}>
        <path pathLength={1} d="m27.6 2.4 .7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7.7-1.6Z" />
        <path
          pathLength={1}
          d="m28.6 8.6 .4 .9 .9 .4-.9 .4-.4 .9-.4-.9-.9-.4 .9-.4.4-.9Z"
          onAnimationEnd={finishLoopIntro}
        />
      </g>
    </svg>
  );
}

/** The "silip" wordmark: its two i-dots are the mark's peeking eyes. */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="16 30 302 220" role="img" aria-label="Silip">
      <g fill="none" stroke="currentColor" strokeWidth={24} strokeLinecap="round" strokeLinejoin="round">
        <path d="M77.5 121.5A26 19 0 1 0 55 150A26 19 0 1 1 32.5 178.5" />
        <path d="M116 112V184M156 44V184M196 112V184M236 112V236" />
        <circle cx="270" cy="150" r="34" />
      </g>
      <path fill="currentColor" fillRule="evenodd"
        d="M96 74a20 20 0 1 0 40 0a20 20 0 1 0-40 0ZM116 75a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM176 74a20 20 0 1 0 40 0a20 20 0 1 0-40 0ZM196 75a8 8 0 1 0 16 0a8 8 0 1 0-16 0Z" />
    </svg>
  );
}

export function BrandLoader({ still = false }: { still?: boolean }) {
  return (
    <span className="lr-brand-loader" aria-hidden="true">
      <BrandMark size={64} motion={still ? "static" : "loop"} />
    </span>
  );
}
