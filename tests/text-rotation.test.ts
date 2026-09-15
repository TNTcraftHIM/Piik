import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTextCycle, startTextRotation } from "../src/client/ui/text-rotation";

const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
const motion = Object.assign(new EventTarget(), { matches: false });
let stop: (() => void) | undefined;
let intersect: IntersectionObserverCallback;
const disconnect = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  page.visibilityState = "visible";
  motion.matches = false;
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { setInterval, clearInterval, matchMedia: () => motion });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("exhausts each pool before repeating and avoids repeating across a round boundary", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.99);
  const next = createTextCycle(["A", "B", "C"]);
  const first = [next(), next(), next()];
  vi.mocked(Math.random).mockReturnValue(0);
  const second = [next(), next(), next()];
  expect(new Set(first)).toEqual(new Set(["A", "B", "C"]));
  expect(new Set(second)).toEqual(new Set(first));
  expect(second[0]).not.toBe(first[2]);
  expect(createTextCycle([])()).toBeUndefined();
  const single = createTextCycle(["Only"]);
  expect([single(), single()]).toEqual(["Only", "Only"]);
});

it("advances on the shared eight-second cadence", () => {
  const tick = vi.fn();
  stop = startTextRotation(tick);
  vi.advanceTimersByTime(7_999);
  expect(tick).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(16_000);
  expect(tick).toHaveBeenCalledTimes(3);
});

it("does not consume hidden entries and resumes with a full reading interval", () => {
  const tick = vi.fn();
  stop = startTextRotation(tick);
  vi.advanceTimersByTime(6_000);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(7_999);
  expect(tick).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(1);
});

it("honors reduced motion at entry and when the preference changes", () => {
  motion.matches = true;
  const tick = vi.fn();
  stop = startTextRotation(tick);
  expect(vi.getTimerCount()).toBe(0);
  motion.matches = false;
  motion.dispatchEvent(new Event("change"));
  vi.advanceTimersByTime(8_000);
  expect(tick).toHaveBeenCalledTimes(1);
  motion.matches = true;
  motion.dispatchEvent(new Event("change"));
  vi.advanceTimersByTime(60_000);
  expect(tick).toHaveBeenCalledTimes(1);
  motion.matches = false;
  motion.dispatchEvent(new Event("change"));
  vi.advanceTimersByTime(7_999);
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(2);
});

it("pauses offscreen surfaces and releases all listeners at retirement", () => {
  const tick = vi.fn();
  const show = (visible: boolean) => intersect([
    { isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry,
  ], {} as IntersectionObserver);
  stop = startTextRotation(tick, {} as Element);
  expect(vi.getTimerCount()).toBe(0);
  intersect([
    { isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry,
    { isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry,
  ], {} as IntersectionObserver); // One notification can contain several queued states.
  vi.advanceTimersByTime(4_000);
  show(true); // A repeated observation must not reset the running clock.
  vi.advanceTimersByTime(4_000);
  expect(tick).toHaveBeenCalledTimes(1);
  show(false);
  vi.advanceTimersByTime(60_000);
  expect(tick).toHaveBeenCalledTimes(1);
  show(true);
  vi.advanceTimersByTime(7_999);
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(2);
  show(false);
  stop();
  stop = undefined;
  show(true); // A notification queued before disconnect must not revive the timer.
  page.dispatchEvent(new Event("visibilitychange"));
  motion.dispatchEvent(new Event("change"));
  expect(vi.getTimerCount()).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});
