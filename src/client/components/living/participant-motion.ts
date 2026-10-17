import { identityHash } from "../../lib/identity-hash";

/** UUID selects a quiet cadence; wall time keeps independently mounted views in phase. */
export function participantMotion(identity: string) {
  const seed = identityHash(identity);
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
  const owner = root.ownerDocument;
  const view = owner.defaultView;
  const sync = () => {
    if (owner.hidden || !view) return;
    const timeline = owner.timeline.currentTime;
    if (typeof timeline !== "number") return;
    // Sample wall time at this rendered frame, not at each component's mount.
    const phase = participantMotionPhase(identity, Date.now() - view.performance.now() + timeline);
    for (const animation of root.getAnimations({ subtree: true })) {
      if ("animationName" in animation && (animation as CSSAnimation).animationName.startsWith("lr-person-")) {
        animation.startTime = timeline - phase;
      }
    }
  };
  // animationstart also covers returning from reduced motion.
  root.addEventListener("animationstart", sync);
  owner.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    root.removeEventListener("animationstart", sync);
    owner.removeEventListener("visibilitychange", sync);
  };
}
