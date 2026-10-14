import { useEffect, useMemo, useState, type RefObject } from "react";
import { createTextCycle, startTextRotation } from "./text-rotation";

/** Catalogs have stable identities; only their semantic context starts a new draw. */
export function useRotatingText<T>(
  frames: readonly T[],
  context: string,
  { element, still = false, rotate = true }: {
    element?: RefObject<HTMLElement | null>; still?: boolean; rotate?: boolean;
  } = {},
): T | undefined {
  const cycle = useMemo(() => {
    const next = createTextCycle(frames);
    return { next, first: next() };
  }, [frames, context]);
  const [selected, select] = useState({ cycle, value: cycle.first });
  useEffect(() => {
    if (still) return;
    const surface = element?.current;
    const tick = rotate && frames.length > 1 ? () => select({ cycle, value: cycle.next() }) : undefined;
    if (!tick && !surface) return;
    const stop = startTextRotation(tick, surface,
      active => surface?.setAttribute("data-text-active", String(active)));
    return () => { stop(); surface?.removeAttribute("data-text-active"); };
  }, [cycle, frames.length, element, still, rotate]);
  // Language/context changes display the new pool immediately, before effects.
  return selected.cycle === cycle ? selected.value : cycle.first;
}
