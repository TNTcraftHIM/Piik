import { useEffect, useRef, useState, type AnimationEvent } from "react";
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
  const [loopPhase, setLoopPhase] = useState<"intro" | "active">("intro");
  const motionClass =
    motion === "loop"
      ? ` is-animated is-loop-${loopPhase}`
      : motion === "once"
        ? " is-once"
        : "";
  const markRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (motion === "loop") setLoopPhase("intro");
  }, [motion]);

  useEffect(() => {
    if (motion !== "once" || !markRef.current) return;
    return bindSvgReplayOnPointerEnter(markRef.current);
  }, [motion]);

  const finishLoopIntro = (event: AnimationEvent<SVGPathElement>): void => {
    if (motion === "loop" && event.animationName === "lr-brand-sparkle-alt") {
      setLoopPhase("active");
    }
  };

  return (
    <svg
      ref={markRef}
      className={`lr-brand-mark${motionClass}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={animated ? 2 : 2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <g className="lr-brand-shell">
        <rect className="lr-brand-frame" pathLength={1} x="4" y="8" width="24" height="18" rx="4" />
        <path className="lr-brand-antenna" pathLength={1} d="m11 4 5 4 5-4" />
        <path className="lr-brand-feet" pathLength={1} d="M10 29l2-3m10 3-2-3" />
      </g>
      <g className="lr-brand-face">
        <circle
          className="lr-brand-eye-left"
          cx="11.5"
          cy="16.5"
          r="1.25"
          fill="currentColor"
          stroke="none"
        />
        <circle
          className="lr-brand-eye-open"
          cx="21.35"
          cy="16.5"
          r="1.25"
          fill="currentColor"
          stroke="none"
        />
        <path
          className="lr-brand-eye-wink"
          pathLength={1}
          d="M19 17c1.5-1.8 3.2-1.8 4.7 0"
        />
      </g>
      <g className="lr-brand-sparkles">
        <path pathLength={1} d="m25 11.5 .8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z" />
        <path
          pathLength={1}
          d="m25 17.2 .45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45.45-1.1Z"
          onAnimationEnd={finishLoopIntro}
        />
      </g>
    </svg>
  );
}

export function BrandLoader() {
  return (
    <span className="lr-brand-loader" aria-hidden="true">
      <BrandMark size={64} motion="loop" />
    </span>
  );
}

export function BrandSwitcher() {
  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [showWordmark, setShowWordmark] = useState(!reducedMotion);
  const [introDone, setIntroDone] = useState(reducedMotion);
  const [entering, setEntering] = useState<"wordmark" | "mascot" | null>(null);

  const switchTo = (next: "wordmark" | "mascot"): void => {
    if (!introDone || (next === "wordmark") === showWordmark) return;
    setEntering(next);
    setShowWordmark(next === "wordmark");
    window.setTimeout(() => setEntering(null), 560);
  };

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(() => {
      setEntering("mascot");
      setShowWordmark(false);
      setIntroDone(true);
      window.setTimeout(() => setEntering(null), 560);
    }, 950);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);

  return (
    <span
      className={`lr-brand-switcher${showWordmark ? " is-wordmark" : " is-mascot"}${entering ? ` is-entering-${entering}` : ""}`}
      onPointerEnter={() => switchTo(showWordmark ? "mascot" : "wordmark")}
      aria-hidden="true"
    >
      <span className="lr-brand-wordmark">
        <span>P</span><span>i</span><span>i</span><span>k</span>
      </span>
      <span className="lr-brand-switcher-mascot">
        <BrandMark size={34} motion={reducedMotion || showWordmark ? "static" : "once"} />
      </span>
    </span>
  );
}
