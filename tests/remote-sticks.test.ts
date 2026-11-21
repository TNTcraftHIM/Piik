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

test("screen keyboard suppresses physical reports while virtual sticks remain available", () => {
  const clock = animationClock();
  const physical = {
    index: 0, connected: true, mapping: "standard",
    buttons: [{ pressed: true, value: 1 }], axes: [-1, 0, 0, 0],
  };
  let reads = 0;
  const owner = Object.assign(new EventTarget(), clock, {
    navigator: { getGamepads() { reads++; return [physical]; } },
  }) as unknown as Window;
  const page = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }) as unknown as Document;
  const events: RemoteInputEvent[] = [];
  const connections: boolean[] = [];
  const input = (event: RemoteInputEvent) => events.push(event);
  const changed = (connected: boolean) => connections.push(connected);
  const disconnect = () => owner.dispatchEvent(Object.assign(new Event("gamepaddisconnected"), { gamepad: physical }));

  const before = new RemoteGamepad(input, changed, owner, page);
  clock.advance(100);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { buttons: 1, leftX: -32768 } });
  before.dispose();
  expect(events.slice(-2)).toEqual([{ type: "gamepad-reset" }, { type: "gamepad-stop" }]);
  expect(connections).toEqual([true, false]);

  events.length = 0;
  const keyboard = new RemoteGamepad(input, changed, owner, page, false);
  clock.advance(120);
  expect(events).toEqual([]);
  keyboard.setLeftStick(1, 0);
  physical.connected = false;
  disconnect();
  clock.advance(140);
  physical.connected = true;
  clock.advance(160);
  expect(reads).toBe(1);
  expect(connections).toEqual([true, false]);
  expect(events).toEqual(Array(2).fill({
    type: "gamepad",
    gamepad: { buttons: 0, leftTrigger: 0, rightTrigger: 0, leftX: 32767, leftY: 0, rightX: 0, rightY: 0 },
  }));
  keyboard.dispose();
  expect(events.slice(-2)).toEqual([{ type: "gamepad-reset" }, { type: "gamepad-stop" }]);

  events.length = 0;
  const after = new RemoteGamepad(input, changed, owner, page);
  after.setRightStick(0, 1);
  clock.advance(180);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { buttons: 1, leftX: -32768, rightY: 0 } });
  physical.connected = false;
  disconnect();
  clock.advance(200);
  expect(events.slice(-2)).toEqual([{ type: "gamepad-reset" }, { type: "gamepad-stop" }]);
  expect(connections).toEqual([true, false, true, false]);
  after.setRightStick(0, 1);
  clock.advance(220);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { buttons: 0, rightY: 32767 } });
  after.dispose();
});

test("an input reset clears virtual axes while the collector stays active", () => {
  const clock = animationClock();
  const owner = Object.assign(new EventTarget(), clock, { navigator: {} }) as unknown as Window;
  const page = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }) as unknown as Document;
  const events: RemoteInputEvent[] = [];
  const pad = new RemoteGamepad(event => events.push(event), () => {}, owner, page);
  pad.setLeftStick(1, 0);
  clock.advance(100);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { leftX: 32767 } });
  events.length = 0;
  pad.clearVirtualSticks();
  clock.advance(120);
  expect(events).toEqual([]);
  pad.setRightStick(0, -1);
  clock.advance(140);
  expect(events.at(-1)).toMatchObject({ type: "gamepad", gamepad: { leftX: 0, rightY: -32768 } });
  pad.dispose();
});
