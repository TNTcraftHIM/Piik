import { useEffect, useMemo, useState, type RefObject } from "react";
import { createTextCycle, startTextRotation } from "./text-rotation";

/** Catalogs have stable identities; only their semantic context starts a new draw. */
export function useRotatingText<T>(
  frames: readonly T[],
  context: string,
  element?: RefObject<HTMLElement | null>,
  still = false,
): T | undefined {
  const cycle = useMemo(() => {
    const next = createTextCycle(frames);
    return { next, first: next() };
  }, [frames, context]);
  const [selected, select] = useState({ cycle, value: cycle.first });
  useEffect(() => {
    if (frames.length < 2 || still) return;
    return startTextRotation(() => select({ cycle, value: cycle.next() }), element?.current);
  }, [cycle, frames.length, element, still]);
  // Language/context changes display the new pool immediately, before effects.
  return selected.cycle === cycle ? selected.value : cycle.first;
}
