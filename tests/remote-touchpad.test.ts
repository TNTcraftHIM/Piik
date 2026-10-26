import { expect, it, vi } from "vitest";
import { RemoteTouchpad } from "../src/client/remote-control/touchpad";
import type { RemoteInputEvent } from "../src/client/remote-control/input-session";
import { picturePoint, pictureRect, type VideoRotation } from "../src/client/media/video-geometry";

it("targets the touched picture directly, ignores letterboxing and retires gestures when mouse mode changes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const video = { videoWidth: 400, videoHeight: 200, style: { objectFit: "contain" }, dataset: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) } as unknown as HTMLVideoElement;
    const events: RemoteInputEvent[] = [];
    const pad = new RemoteTouchpad(() => {
      const picture = pictureRect(video);
      return picture && { ...picture, rotation: 0 };
    }, event => events.push(event), () => {}, () => {},
    { scale: 1, transform: () => {} });
    pad.down(1, 320, 10, picturePoint(video, 320, 10)); pad.move(1, 350, 100); pad.up(1);
    expect(events).toEqual([]); expect(vi.getTimerCount()).toBe(0);

    pad.down(1, 320, 100, picturePoint(video, 320, 100)); pad.up(1);
    expect(events).toEqual([{ type: "move", x: .8, y: .25 },
      { type: "button", button: 0, down: true }, { type: "button", button: 0, down: false }]);
    events.length = 0;
    pad.down(2, 80, 150, picturePoint(video, 80, 150)); vi.advanceTimersByTime(500);
    pad.move(2, 160, 190); pad.up(2);
    expect(events).toEqual([{ type: "move", x: .2, y: .5 }, { type: "button", button: 0, down: true },
      { type: "move", x: .4, y: .7 }, { type: "button", button: 0, down: false }]);

    events.length = 0;
    pad.down(3, 100, 150, picturePoint(video, 100, 150)); vi.advanceTimersByTime(500);
    pad.setVirtualMouse(true); pad.up(3);
    expect(events.filter(event => event.type === "button")).toEqual([
      { type: "button", button: 0, down: true }, { type: "button", button: 0, down: false }]);
    expect(events.at(-1)).toEqual({ type: "move", x: .25, y: .5 });
    expect(vi.getTimerCount()).toBe(0);
    events.length = 0;
    pad.down(4, 100, 150, { x: .9, y: .9 }); pad.move(4, 140, 150); pad.up(4);
    expect(events).toEqual([{ type: "move", x: .35, y: .5 }]);
    pad.setVirtualMouse(false);
    pad.down(5, 320, 100, picturePoint(video, 320, 100)); pad.up(5);
    expect(events.at(-3)).toEqual({ type: "move", x: .8, y: .25 });
  } finally { vi.useRealTimers(); }
});

it("anchors expansion in source coordinates and refreshes geometry without input", () => {
  const video = { videoWidth: 400, videoHeight: 200, style: { objectFit: "contain" }, dataset: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) } as unknown as HTMLVideoElement;
  const events: RemoteInputEvent[] = [], changed = vi.fn();
  const pad = new RemoteTouchpad(() => {
    const picture = pictureRect(video);
    return picture && { ...picture, rotation: 0 };
  }, event => events.push(event), () => {}, changed, { scale: 1, transform: () => {} });
  pad.setVirtualMouse(true, picturePoint(video, 320, 100));
  expect(pad.position).toEqual({ x: .8, y: .25 });
  expect(events).toEqual([{ type: "move", x: .8, y: .25 }]);
  expect(changed.mock.calls).toEqual([[pad.position]]);
  pad.moveBy(-40, 20);
  expect(pad.position.x).toBeCloseTo(.7); expect(pad.position.y).toBeCloseTo(.35);
  expect(events.at(-1)).toEqual({ type: "move", ...pad.position });
  expect(changed).toHaveBeenLastCalledWith(pad.position);
  pad.setVirtualMouse(false);
  events.length = 0; changed.mockClear();
  pad.setVirtualMouse(true, picturePoint(video, 320, 10));
  expect(events).toEqual([{ type: "move", ...pad.position }]);
  expect(changed.mock.calls).toEqual([[pad.position]]);
  pad.setVirtualMouse(true, { x: .1, y: .9 });
  expect(pad.position).toEqual({ x: .1, y: .9 });
  expect(events.at(-1)).toEqual({ type: "move", x: .1, y: .9 });
  events.length = 0; changed.mockClear();
  pad.setVirtualMouse(true);
  expect(changed).not.toHaveBeenCalled();
  const position = pad.position;
  pad.refresh();
  expect(changed.mock.calls).toEqual([[position]]);
  expect(pad.position).toBe(position);
  expect(events).toEqual([]);
  pad.reset();
});

it("shares virtual buttons with picture gestures until their final owner releases", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const events: RemoteInputEvent[] = [];
    const pad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: 0 }), event => events.push(event),
      () => {}, () => {}, { scale: 1, transform: () => {} });
    pad.setVirtualMouse(true);
    events.length = 0;
    const buttons = () => events.filter(event => event.type === "button");
    pad.button(0, true);
    pad.down(1, 20, 20, null); pad.move(1, 24, 22); pad.up(1);
    pad.down(2, 20, 20, null); vi.advanceTimersByTime(600); pad.move(2, 70, 45); pad.up(2);
    expect(buttons()).toEqual([{ type: "button", button: 0, down: true }]);
    expect(events.at(-1)).toEqual({ type: "move", x: .77, y: .77 });
    pad.button(0, false);
    expect(buttons().at(-1)).toEqual({ type: "button", button: 0, down: false });

    events.length = 0;
    pad.down(3, 20, 20, null); vi.advanceTimersByTime(500);
    pad.button(0, true); pad.up(3);
    expect(buttons()).toEqual([{ type: "button", button: 0, down: true }]);
    pad.button(0, false);
    expect(buttons()).toHaveLength(2);

    events.length = 0;
    pad.down(4, 20, 20, null); pad.button(2, true); pad.button(2, false);
    vi.advanceTimersByTime(600); pad.up(4);
    expect(buttons()).toEqual([{ type: "button", button: 2, down: true }, { type: "button", button: 2, down: false }]);
    pad.down(5, 20, 20, null); vi.advanceTimersByTime(500); pad.button(0, true); pad.button(1, true);
    events.length = 0;
    pad.moveBy(20, 10);
    expect(events).toEqual([{ type: "move", ...pad.position }]);
    pad.cancel(5); pad.reset(); pad.up(5); pad.button(0, false); pad.button(1, false); vi.advanceTimersByTime(600);
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
      event => events.push(event), delta => scroll.push(delta), () => {}, { scale: 1, transform: () => {} });
    touchpad.setVirtualMouse(true);
    events.length = 0;
    touchpad.down(1, 20, 20, null); touchpad.up(1);
    expect(events).toEqual([{ type: "move", x: .5, y: .5 },
      { type: "button", button: 0, down: true }, { type: "button", button: 0, down: false }]);
    events.length = 0;
    touchpad.down(1, 20, 20, null);
    touchpad.move(1, 24, 22); // Below the tap threshold: retain, don't lose motion.
    touchpad.move(1, 26, 23);
    touchpad.move(1, 70, 45); touchpad.up(1);
    expect(events.at(-1)).toEqual({ type: "move", x: .75, y: .75 });
    expect(events.some(event => event.type === "button")).toBe(false);

    events.length = 0;
    touchpad.down(1, 20, 20, null); vi.advanceTimersByTime(500); touchpad.move(1, 500, 45);
    expect(touchpad.position).toEqual({ x: 1, y: 1 });
    touchpad.reset(); touchpad.up(1); vi.advanceTimersByTime(1000);
    expect(events.filter(event => event.type === "button")).toEqual([
      { type: "button", button: 0, down: true }, { type: "button", button: 0, down: false },
    ]);

    events.length = 0;
    touchpad.down(1, 20, 20, null); touchpad.down(2, 40, 20, null); touchpad.up(2);
    touchpad.cancel(2); // Normal pointer-up also emits lostpointercapture.
    touchpad.up(1);
    expect(events.slice(-2)).toEqual([
      { type: "button", button: 2, down: true }, { type: "button", button: 2, down: false },
    ]);
    events.length = 0;
    touchpad.down(1, 20, 20, null); touchpad.down(2, 40, 20, null);
    touchpad.move(1, 20, 50); touchpad.move(2, 40, 50);
    touchpad.up(1); touchpad.move(2, 40, 80); touchpad.up(2);
    expect(scroll.reduce((sum, delta) => sum + delta, 0)).toBe(-30);
    expect(events.some(event => event.type === "button")).toBe(false);

    touchpad.down(1, 20, 20, null); touchpad.reset(); vi.advanceTimersByTime(600);
    expect(events.some(event => event.type === "button")).toBe(false);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it("keeps pinch/pan local and never turns the remaining finger into a remote click", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  try {
    const input = vi.fn(), scroll = vi.fn(), transform = vi.fn();
    const viewport = { scale: 1, transform };
    const pad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: 0 }), input, scroll, () => {}, viewport);
    pad.setVirtualMouse(true);
    pad.down(1, 40, 50, null); pad.down(2, 160, 50, null);
    input.mockClear();
    pad.move(1, 10, 50); pad.move(2, 190, 50);
    vi.advanceTimersByTime(16);
    expect(transform).toHaveBeenLastCalledWith({ x: 100, y: 50 }, { x: 100, y: 50 }, 1.5);
    pad.up(1); pad.move(2, 180, 60); pad.up(2);
    expect(input).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();

    viewport.scale = 1.5;
    pad.down(1, 40, 50, null); pad.down(2, 160, 50, null);
    pad.move(1, 60, 70); pad.move(2, 180, 70);
    vi.advanceTimersByTime(16);
    expect(transform).toHaveBeenLastCalledWith({ x: 100, y: 50 }, { x: 120, y: 70 }, 1);
    expect(scroll).not.toHaveBeenCalled();
    pad.up(1); pad.up(2);

    viewport.scale = .5;
    pad.down(1, 40, 50, null); pad.down(2, 160, 50, null);
    pad.move(1, 60, 70); pad.move(2, 180, 70);
    vi.advanceTimersByTime(16);
    expect(transform).toHaveBeenLastCalledWith({ x: 100, y: 50 }, { x: 120, y: 70 }, 1);
    expect(scroll).not.toHaveBeenCalled();
    pad.up(1); pad.up(2);

    // A zoomed two-finger tap remains a right-click, and cancellation discards
    // pending local movement instead of replaying it after the grant ends.
    pad.down(1, 40, 50, null); pad.down(2, 160, 50, null);
    pad.up(1); pad.up(2);
    expect(input.mock.calls.slice(-2)).toEqual([
      [{ type: "button", button: 2, down: true }], [{ type: "button", button: 2, down: false }],
    ]);
    pad.down(1, 40, 50, null); pad.down(2, 160, 50, null);
    pad.move(1, 10, 50); transform.mockClear(); pad.reset();
    vi.advanceTimersByTime(600);
    expect(transform).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it("moves across the full source through the rendered zoom without a delayed click", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const events: RemoteInputEvent[] = [];
    const changed = vi.fn(), scroll = vi.fn(), transform = vi.fn();
    // pictureRect already includes the local zoom; do not divide by scale again.
    const pad = new RemoteTouchpad(() => ({ width: 400, height: 200, rotation: 0 }),
      event => events.push(event), scroll, changed, { scale: 2, transform });
    pad.setVirtualMouse(true);
    events.length = 0;
    pad.down(1, 20, 20, null);
    pad.moveBy(100, 50);
    expect(pad.position).toEqual({ x: .75, y: .75 });
    expect(changed).toHaveBeenLastCalledWith(pad.position);
    expect(events).toEqual([{ type: "move", x: .75, y: .75 }]);
    vi.advanceTimersByTime(600); pad.up(1);
    expect(events).toHaveLength(1);
    pad.moveBy(400, 200);
    expect(events.at(-1)).toEqual({ type: "move", x: 1, y: 1 });
    expect(scroll).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each([
  [0, .75, .5], [90, .5, .25], [180, .25, .5], [270, .5, .75],
] as const)("aligns picture and widget motion with rotation and releases a held drag (%s°)", (rotation, x, y) => {
  vi.useFakeTimers();
  try {
    const events: RemoteInputEvent[] = [];
    const pad = new RemoteTouchpad(() => ({ width: 200, height: 100, rotation: rotation as VideoRotation }),
      event => events.push(event), () => {}, () => {}, { scale: 1, transform: () => {} });
    pad.setVirtualMouse(true);
    events.length = 0;
    pad.down(1, 20, 20, null);
    vi.advanceTimersByTime(500);
    pad.move(1, 70, 20);
    expect(events.at(-1)).toEqual({ type: "move", x, y });
    pad.reset();
    expect(events.at(-1)).toEqual({ type: "button", button: 0, down: false });
    pad.up(1);
    expect(events.filter(event => event.type === "button")).toHaveLength(2);
    events.length = 0;
    pad.position = { x: .5, y: .5 };
    pad.moveBy(50, 0);
    vi.advanceTimersByTime(600);
    expect(events).toEqual([{ type: "move", x, y }]);
  } finally { vi.useRealTimers(); }
});
