import { BEAT } from "../score.js";

type Point = {x: number; y: number};
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const ease = (n: number) => 1 - (1 - clamp(n)) ** 4;

// Both real pages place the same pointer from time and current control bounds.
export function point(cursor: HTMLElement, t: number, from: Point, target: Point | undefined,
  moveAt: number, moveFor: number, clickAt: number, hideAt: number) {
  if (target) {
    const p = clamp((t - moveAt) / moveFor), arrive = p * p * (3 - 2 * p);
    const x = from.x + (target.x - from.x) * arrive,
      y = from.y + (target.y - from.y) * arrive;
    cursor.style.transform = `translate(${x}px,${y}px) scale(${1 - 0.18 * Math.sin(clamp((t - clickAt) / (BEAT / 2)) * Math.PI)})`;
  }
  cursor.style.opacity = String(ease(t / (BEAT / 2)) * (1 - ease((t - hideAt + BEAT / 2) / (BEAT / 2))));
  cursor.toggleAttribute("hidden", !target || t >= hideAt);
}
