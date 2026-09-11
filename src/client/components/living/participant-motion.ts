/** UUID selects a quiet cadence; wall time keeps independently mounted views in phase. */
export function participantMotion(identity: string) {
  let seed = 2166136261;
  for (const char of identity) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  seed >>>= 0;
  return {
    duration: 42_000 + (seed % 17_003),
    offset: (seed >>> 8) % 59_003,
    lean: seed & 1 ? 3 : -3,
    gaze: seed & 2 ? 1.5 : -1.5,
  };
}

export function participantMotionPhase(identity: string, now: number): number {
  const { duration, offset } = participantMotion(identity);
  return ((now + offset) % duration + duration) % duration;
}

/** Native animation timelines keep running without a JS tick or room messages. */
export function bindParticipantMotion(root: SVGSVGElement, identity: string): () => void {
  const sync = () => {
    if (document.hidden) return;
    const timeline = document.timeline.currentTime;
    if (typeof timeline !== "number") return;
    // Sample wall time at this rendered frame, not at each component's mount.
    const phase = participantMotionPhase(identity, Date.now() - performance.now() + timeline);
    for (const animation of root.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && animation.animationName.startsWith("lr-person-")) {
        animation.startTime = timeline - phase;
      }
    }
  };
  // animationstart also covers returning from reduced motion.
  root.addEventListener("animationstart", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    root.removeEventListener("animationstart", sync);
    document.removeEventListener("visibilitychange", sync);
  };
}
