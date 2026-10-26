import { expect, it, vi } from "vitest";
import { RemoteTouchpad } from "../src/client/remote-control/touchpad";
import type { RemoteInputEvent } from "../src/client/remote-control/input-session";
import type { VideoRotation } from "../src/client/media/video-geometry";

it("shares virtual buttons with picture gestures until their final owner releases", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const events: RemoteInputEvent[] = [];
    const pad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: 0 }), event => events.push(event),
      () => {}, () => {}, { scale: 1, transform: () => {}, visiblePosition: position => position });
    const buttons = () => events.filter(event => event.type === "button");
    pad.button(0, true);
    pad.down(1, 20, 20); pad.move(1, 24, 22); pad.up(1);
    pad.down(2, 20, 20); vi.advanceTimersByTime(600); pad.move(2, 70, 45); pad.up(2);
    expect(buttons()).toEqual([{ type: "button", button: 0, down: true }]);
    expect(events.at(-1)).toEqual({ type: "move", x: .77, y: .77 });
    pad.button(0, false);
    expect(buttons().at(-1)).toEqual({ type: "button", button: 0, down: false });

    events.length = 0;
    pad.down(3, 20, 20); vi.advanceTimersByTime(500);
    pad.button(0, true); pad.up(3);
    expect(buttons()).toEqual([{ type: "button", button: 0, down: true }]);
    pad.button(0, false);
    expect(buttons()).toHaveLength(2);

    events.length = 0;
    pad.down(4, 20, 20); pad.button(2, true); pad.button(2, false);
    vi.advanceTimersByTime(600); pad.up(4);
    expect(buttons()).toEqual([{ type: "button", button: 2, down: true }, { type: "button", button: 2, down: false }]);
    pad.down(5, 20, 20); vi.advanceTimersByTime(500); pad.button(0, true); pad.button(1, true);
    events.length = 0;
    pad.reset(); pad.up(5); pad.button(0, false); pad.button(1, false); vi.advanceTimersByTime(600);
    expect(buttons()).toEqual([{ type: "button", button: 0, down: false }, { type: "button", button: 1, down: false }]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("keeps taps, dragging, two-finger gestures and grant retirement distinct", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const events: RemoteInputEvent[] = [], scroll: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    const touchpad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: 0 }),
      event => events.push(event), delta => scroll.push(delta), () => {}, { scale: 1, transform: () => {}, visiblePosition: position => position });
    touchpad.down(1, 20, 20); touchpad.up(1);
    expect(events).toEqual([{ type: "move", x: .5, y: .5 },
      { type: "button", button: 0, down: true }, { type: "button", button: 0, down: false }]);
    events.length = 0;
    touchpad.down(1, 20, 20);
    touchpad.move(1, 24, 22); // Below the tap threshold: retain, don't lose motion.
    touchpad.move(1, 26, 23);
    touchpad.move(1, 70, 45); touchpad.up(1);
    expect(events.at(-1)).toEqual({ type: "move", x: .75, y: .75 });
    expect(events.some(event => event.type === "button")).toBe(false);

    events.length = 0;
    touchpad.down(1, 20, 20); vi.advanceTimersByTime(500); touchpad.move(1, 500, 45);
    expect(touchpad.position).toEqual({ x: 1, y: 1 });
    touchpad.reset(); touchpad.up(1); vi.advanceTimersByTime(1000);
    expect(events.filter(event => event.type === "button")).toEqual([
      { type: "button", button: 0, down: true }, { type: "button", button: 0, down: false },
    ]);

    events.length = 0;
    touchpad.down(1, 20, 20); touchpad.down(2, 40, 20); touchpad.up(2);
    touchpad.cancel(2); // Normal pointer-up also emits lostpointercapture.
    touchpad.up(1);
    expect(events.slice(-2)).toEqual([
      { type: "button", button: 2, down: true }, { type: "button", button: 2, down: false },
    ]);
    events.length = 0;
    touchpad.down(1, 20, 20); touchpad.down(2, 40, 20);
    touchpad.move(1, 20, 50); touchpad.move(2, 40, 50);
    touchpad.up(1); touchpad.move(2, 40, 80); touchpad.up(2);
    expect(scroll.reduce((sum, delta) => sum + delta, 0)).toBe(-30);
    expect(events.some(event => event.type === "button")).toBe(false);

    touchpad.down(1, 20, 20); touchpad.reset(); vi.advanceTimersByTime(600);
    expect(events.some(event => event.type === "button")).toBe(false);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it("keeps pinch/pan local and never turns the remaining finger into a remote click", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  try {
    const input = vi.fn(), scroll = vi.fn(), transform = vi.fn();
    const viewport = { scale: 1, transform, visiblePosition: (position: { x: number; y: number }) => position };
    const pad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: 0 }), input, scroll, () => {}, viewport);
    pad.down(1, 40, 50); pad.down(2, 160, 50);
    input.mockClear();
    pad.move(1, 10, 50); pad.move(2, 190, 50);
    vi.advanceTimersByTime(16);
    expect(transform).toHaveBeenLastCalledWith({ x: 100, y: 50 }, { x: 100, y: 50 }, 1.5);
    pad.up(1); pad.move(2, 180, 60); pad.up(2);
    expect(input).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();

    viewport.scale = 1.5;
    pad.down(1, 40, 50); pad.down(2, 160, 50);
    pad.move(1, 60, 70); pad.move(2, 180, 70);
    vi.advanceTimersByTime(16);
    expect(transform).toHaveBeenLastCalledWith({ x: 100, y: 50 }, { x: 120, y: 70 }, 1);
    expect(scroll).not.toHaveBeenCalled();
    pad.up(1); pad.up(2);

    // A zoomed two-finger tap remains a right-click, and cancellation discards
    // pending local movement instead of replaying it after the grant ends.
    pad.down(1, 40, 50); pad.down(2, 160, 50);
    pad.up(1); pad.up(2);
    expect(input.mock.calls.slice(-2)).toEqual([
      [{ type: "button", button: 2, down: true }], [{ type: "button", button: 2, down: false }],
    ]);
    pad.down(1, 40, 50); pad.down(2, 160, 50);
    pad.move(1, 10, 50); transform.mockClear(); pad.reset();
    vi.advanceTimersByTime(600);
    expect(transform).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it.each([
  [0, .75, .5], [90, .5, .25], [180, .25, .5], [270, .5, .75],
] as const)("keeps touch motion aligned with the rotated picture and releases a held drag (%s°)", (rotation, x, y) => {
  vi.useFakeTimers();
  try {
    const events: RemoteInputEvent[] = [];
    const pad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: rotation as VideoRotation }),
      event => events.push(event), () => {}, () => {}, { scale: 1, transform: () => {}, visiblePosition: position => position });
    pad.down(1, 20, 20);
    vi.advanceTimersByTime(500);
    pad.move(1, 70, 20);
    expect(events.at(-1)).toEqual({ type: "move", x, y });
    pad.reset();
    expect(events.at(-1)).toEqual({ type: "button", button: 0, down: false });
    pad.up(1);
    expect(events.filter(event => event.type === "button")).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});
