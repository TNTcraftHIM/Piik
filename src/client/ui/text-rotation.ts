/** A local decoration cycle; changing product state creates a new cycle. */
export function createTextCycle<T>(frames: readonly T[]): () => T | undefined {
  const remaining: T[] = [];
  let last: T | undefined;
  return () => {
    if (remaining.length === 0) remaining.push(...frames);
    let index = Math.floor(Math.random() * remaining.length);
    if (remaining.length > 1 && remaining[index] === last) {
      index = (index + 1) % remaining.length;
    }
    last = remaining.splice(index, 1)[0];
    return last;
  };
}

/** Decorative copy shares one visibility/motion policy, never a network clock. */
export function startTextRotation(tick: () => void, intervalMs: number): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reducedMotion.matches) return () => {};
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible" && !reducedMotion.matches) tick();
  }, intervalMs);
  return () => window.clearInterval(timer);
}
