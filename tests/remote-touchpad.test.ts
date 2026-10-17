import { expect, it, vi } from "vitest";
import { RemoteTouchpad } from "../src/client/remote-control/touchpad";
import type { RemoteInputEvent } from "../src/client/remote-control/input-session";

it("keeps taps, dragging, two-finger gestures and grant retirement distinct", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const events: RemoteInputEvent[] = [], scroll: number[] = [];
    const touchpad = new RemoteTouchpad(() => ({ width: 200, height: 100 }),
      event => events.push(event), delta => scroll.push(delta), () => {});
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
    expect(scroll).toEqual([-15, -15]);
    expect(events.some(event => event.type === "button")).toBe(false);

    touchpad.down(1, 20, 20); touchpad.reset(); vi.advanceTimersByTime(600);
    expect(events.some(event => event.type === "button")).toBe(false);
  } finally { vi.useRealTimers(); }
});
