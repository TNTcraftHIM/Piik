import { expect, it, vi } from "vitest";
import { RemoteInputSession } from "../src/client/remote-control/input-session";
import { RemoteKeyboardPresses } from "../src/client/remote-control/keyboard";
import { RemoteTouchpad } from "../src/client/remote-control/touchpad";

class Channel extends EventTarget {
  readyState = "open" as RTCDataChannelState;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  receive(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

const grant = "a".repeat(64);
const ready = { mode: "room", platform: "windows", state: "ready", capabilities: ["text"] };
function setup() {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  const renew = () => {
    channel.receive(ready);
    session.request();
    const intent = channel.sent.at(-1)?.intent;
    channel.receive({ ...ready, state: "active", grant, intent });
    channel.sent.length = 0;
  };
  renew();
  const input: RemoteInputSession["input"] = event => session.input(event);
  const stick = new RemoteTouchpad(() => null, input, () => {}, () => {}, { scale: 1, transform: () => {} });
  return { channel, session, keyboard: new RemoteKeyboardPresses(input), stick, renew };
}
const key = (code: string, down: boolean) => ({ type: "key", code, down, grant });

it("keeps a selected modifier across keys without repeating it and releases it on reset", () => {
  vi.useFakeTimers();
  try {
    const { keyboard, session, channel } = setup();
    const events = channel.sent;
    keyboard.down(-2, ["ControlLeft"], false);
    keyboard.tap(["ControlLeft", "KeyC"]);
    keyboard.tap(["ControlLeft", "KeyV"]);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([
      key("ControlLeft", true),
      key("KeyC", true), key("KeyC", false),
      key("KeyV", true), key("KeyV", false),
    ]);
    keyboard.reset();
    expect(events.at(-1)).toEqual(key("ControlLeft", false));
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  } finally { vi.useRealTimers(); }
});

it("holds and repeats virtual chords, shares modifiers, and releases every contact on retirement", () => {
  vi.useFakeTimers();
  try {
    const { keyboard, session, channel } = setup();
    const events = channel.sent;
    keyboard.down(1, ["ControlLeft", "KeyA"]);
    keyboard.down(2, ["ControlLeft", "KeyC"]);
    keyboard.up(1);
    expect(events).toEqual([
      key("ControlLeft", true), key("KeyA", true),
      key("KeyC", true), key("KeyA", false),
    ]);
    vi.advanceTimersByTime(450);
    expect(events.slice(-2)).toEqual(Array(2).fill(key("KeyC", true)));
    keyboard.reset(); keyboard.up(2);
    expect(events.slice(-2)).toEqual([
      key("KeyC", false), key("ControlLeft", false),
    ]);
    const count = events.length;
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(count);
    keyboard.tap(["MetaLeft", "Space"]);
    expect(events.slice(-4)).toEqual([
      key("MetaLeft", true), key("Space", true),
      key("Space", false), key("MetaLeft", false),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  } finally { vi.useRealTimers(); }
});

it("keeps a joystick key held through an on-screen tap", () => {
  const { channel, keyboard, stick, session } = setup();
  stick.direction(0, -1);
  keyboard.tap(["KeyW"]);
  expect(channel.sent).toEqual([key("KeyW", true)]);
  stick.direction(0, 0);
  expect(channel.sent).toEqual([key("KeyW", true), key("KeyW", false)]);
  session.dispose();
});

it("keeps an on-screen key held and repeating after the stick is disabled", () => {
  vi.useFakeTimers();
  const { channel, keyboard, stick, session } = setup();
  try {
    keyboard.down(1, ["KeyW"]);
    stick.direction(0, -1);
    stick.direction(0, 0); // The same neutral callback used when hiding the stick.
    expect(channel.sent).toEqual([key("KeyW", true)]);
    vi.advanceTimersByTime(450);
    expect(channel.sent).toEqual([key("KeyW", true), key("KeyW", true), key("KeyW", true)]);
    keyboard.up(1);
    expect(channel.sent.at(-1)).toEqual(key("KeyW", false));
  } finally {
    keyboard.reset(); session.dispose(); vi.useRealTimers();
  }
});

it("counts physical keyboard repeat separately from virtual press and release", () => {
  const { channel, keyboard, session } = setup();
  session.input({ type: "key", code: "KeyW", down: true });
  keyboard.down(1, ["KeyW"], false);
  session.input({ type: "key", code: "KeyW", down: true, repeat: true });
  session.input({ type: "key", code: "KeyW", down: false });
  expect(channel.sent).toEqual([key("KeyW", true), key("KeyW", true)]);
  keyboard.reset();
  expect(channel.sent.at(-1)).toEqual(key("KeyW", false));
  session.dispose();
});

it.each(["reset", "revoke", "release"] as const)("clears old holds on %s and waits for fresh presses", transition => {
  vi.useFakeTimers();
  const { channel, keyboard, stick, session, renew } = setup();
  try {
    stick.direction(0, -1);
    keyboard.down(1, ["KeyW"]);
    const before = [key("KeyW", true)];
    if (transition === "reset") {
      session.input({ type: "reset" });
      expect(channel.sent).toEqual([...before, { type: "reset", grant }]);
    } else if (transition === "revoke") {
      channel.receive({ ...ready, intent: session.state?.intent });
      expect(channel.sent).toEqual(before);
      renew();
    } else {
      const intent = session.state?.intent;
      session.release();
      expect(channel.sent).toEqual([...before, { type: "release", intent }]);
      renew();
    }
    channel.sent.length = 0;
    vi.advanceTimersByTime(450);
    session.input({ type: "key", code: "KeyW", down: true, repeat: true });
    stick.reset();
    expect(channel.sent).toEqual([]);
    keyboard.down(2, ["KeyW"], false);
    keyboard.up(1);
    expect(channel.sent).toEqual([key("KeyW", true)]);
    keyboard.up(2);
    expect(channel.sent).toEqual([key("KeyW", true), key("KeyW", false)]);
  } finally {
    keyboard.reset(); session.dispose(); vi.useRealTimers();
  }
});
