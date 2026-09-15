export const TEXT_ROTATION_INTERVAL_MS = 8_000;

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

/** Hidden surfaces keep their entry and resume with a full reading interval. */
export function startTextRotation(tick: () => void, element?: Element | null): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let inView = !element;
  let retired = false;
  let timer: number | undefined;
  const sync = () => {
    if (retired) return;
    window.clearInterval(timer);
    timer = undefined;
    if (inView && document.visibilityState === "visible" && !reducedMotion.matches) {
      timer = window.setInterval(tick, TEXT_ROTATION_INTERVAL_MS);
    }
  };
  const observer = element ? new IntersectionObserver(entries => {
    const entry = entries.at(-1);
    const visible = Boolean(entry?.isIntersecting && entry.intersectionRatio > 0);
    if (visible === inView) return;
    inView = visible;
    sync();
  }) : undefined;
  if (element) observer!.observe(element);
  document.addEventListener("visibilitychange", sync);
  reducedMotion.addEventListener("change", sync);
  sync();
  return () => {
    retired = true; // An already queued observer notification may still arrive.
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", sync);
    reducedMotion.removeEventListener("change", sync);
    observer?.disconnect();
  };
}
