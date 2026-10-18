import { expect, it, vi } from "vitest";
import { RemoteKeyboardPresses } from "../src/client/remote-control/keyboard";
import type { RemoteInputEvent } from "../src/client/remote-control/input-session";

it("keeps a selected modifier across keys without repeating it and releases it on reset", () => {
  vi.useFakeTimers();
  try {
    const events: RemoteInputEvent[] = [];
    const keyboard = new RemoteKeyboardPresses(event => events.push(event));
    keyboard.down(-2, ["ControlLeft"], false);
    keyboard.tap(["ControlLeft", "KeyC"]);
    keyboard.tap(["ControlLeft", "KeyV"]);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([
      { type: "key", code: "ControlLeft", down: true },
      { type: "key", code: "KeyC", down: true }, { type: "key", code: "KeyC", down: false },
      { type: "key", code: "KeyV", down: true }, { type: "key", code: "KeyV", down: false },
    ]);
    keyboard.reset();
    expect(events.at(-1)).toEqual({ type: "key", code: "ControlLeft", down: false });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("holds and repeats virtual chords, shares modifiers, and releases every contact on retirement", () => {
  vi.useFakeTimers();
  try {
    const events: RemoteInputEvent[] = [];
    const keyboard = new RemoteKeyboardPresses(event => events.push(event));
    keyboard.down(1, ["ControlLeft", "KeyA"]);
    keyboard.down(2, ["ControlLeft", "KeyC"]);
    keyboard.up(1);
    expect(events).toEqual([
      { type: "key", code: "ControlLeft", down: true }, { type: "key", code: "KeyA", down: true },
      { type: "key", code: "KeyC", down: true }, { type: "key", code: "KeyA", down: false },
    ]);
    vi.advanceTimersByTime(450);
    expect(events.slice(-2)).toEqual(Array(2).fill({ type: "key", code: "KeyC", down: true }));
    keyboard.reset(); keyboard.up(2);
    expect(events.slice(-2)).toEqual([
      { type: "key", code: "KeyC", down: false }, { type: "key", code: "ControlLeft", down: false },
    ]);
    const count = events.length;
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(count);
    keyboard.tap(["MetaLeft", "Space"]);
    expect(events.slice(-4)).toEqual([
      { type: "key", code: "MetaLeft", down: true }, { type: "key", code: "Space", down: true },
      { type: "key", code: "Space", down: false }, { type: "key", code: "MetaLeft", down: false },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
