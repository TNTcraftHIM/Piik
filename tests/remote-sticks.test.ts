import { expect, test } from "vitest";
import { RemoteGamepad } from "../src/client/remote-control/gamepad";
import { StickMouse } from "../src/client/remote-control/stick-mouse";
import type { RemoteInputEvent } from "../src/client/remote-control/input-session";

function animationClock() {
  let callback: FrameRequestCallback | undefined;
  return {
    requestAnimationFrame(next: FrameRequestCallback) { callback = next; return 1; },
    cancelAnimationFrame() { callback = undefined; },
    advance(time: number) {
      const current = callback;
      callback = undefined;
      current?.(time);
    },
  };
}

test("releasing one virtual gamepad stick preserves the other stick", () => {
  const clock = animationClock();
  const owner = Object.assign(new EventTarget(), clock, { navigator: {} }) as unknown as Window;
  const page = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }) as unknown as Document;
  const events: RemoteInputEvent[] = [];
  const pad = new RemoteGamepad(event => events.push(event), () => {}, owner, page);
  pad.setLeftStick(1, 0);
  pad.setRightStick(0, -1);
  clock.advance(100);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { leftX: 32767, rightY: -32768 } });
  pad.setRightStick(0, 0);
  clock.advance(120);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { leftX: 32767, rightY: 0 } });
  pad.setLeftStick(0, 0);
  expect(events.at(-1)).toEqual({ type: "gamepad-reset" });
  pad.dispose();
});

test("mouse movement uses elapsed time and stops on neutral", () => {
  function moveForOneSecond(interval: number) {
    const clock = animationClock();
    let distance = 0;
    const stick = new StickMouse(dx => { distance += dx; }, clock);
    stick.set(1, 0);
    for (let time = 0; time <= 1000; time += interval) clock.advance(time);
    const moved = distance;
    stick.set(0, 0);
    clock.advance(1020);
    expect(distance).toBe(moved);
    return moved;
  }

  expect(moveForOneSecond(10)).toBe(900);
  expect(moveForOneSecond(20)).toBe(900);
});
