import { expect, it, vi } from "vitest";
import { RemoteInputSession } from "../src/client/remote-control/input-session";
import { picturePoint, rotatePicturePoint, rotatePictureDelta, type VideoRotation } from "../src/client/media/video-geometry";
import { InputRoute, type InputIdentity } from "../src/client/remote-control/input-route";
import { matchesRemoteShortcut, remoteInputStateSchema } from "../src/client/remote-control/protocol";
import { RemoteGamepad } from "../src/client/remote-control/gamepad";

it("recognizes only the selected local release chord outside IME composition", () => {
  const chord = { code: "F9", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, isComposing: false };
  expect(matchesRemoteShortcut(chord, 9)).toBe(true);
  expect(matchesRemoteShortcut(chord, 10)).toBe(false);
  for (const changed of [{ ctrlKey: false }, { altKey: false }, { shiftKey: true }, { metaKey: true }, { isComposing: true }]) {
    expect(matchesRemoteShortcut({ ...chord, ...changed }, 9)).toBe(false);
  }
});

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  receive(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

it("updates text availability without replacing an active keyboard grant", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  channel.receive({ platform: "windows", mode: "room", state: "ready", coPlay: true, capabilities: ["coPlay"] });
  session.request();
  const intent = channel.sent.at(-1)?.intent, grant = "d".repeat(64);
  const active = { platform: "windows", mode: "room", state: "active", coPlay: true, intent, grant };
  for (const enabled of [true, false, true]) {
    channel.receive({ ...active, capabilities: enabled ? ["coPlay", "text"] : ["coPlay"] });
    const before = channel.sent.length;
    session.input({ type: "text", text: "hello" });
    expect(channel.sent.length - before).toBe(enabled ? 1 : 0);
    expect(session.state?.grant).toBe(grant);
  }
  session.dispose();
});

it("keeps keyboard control when optional gamepad support fails for the grant", () => {
  const channel = new Channel(), changed = vi.fn();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, changed);
  channel.receive({ platform: "windows", mode: "room", state: "ready", coPlay: true, capabilities: ["coPlay", "gamepad"] });
  session.request();
  const intent = channel.sent.at(-1)?.intent, grant = "e".repeat(64);
  const active = { platform: "windows", mode: "room", state: "active", coPlay: true, intent, grant };
  const gamepad = { buttons: 0, leftTrigger: 0, rightTrigger: 0, leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
  channel.receive({ ...active, capabilities: ["coPlay", "gamepad", "text"] });
  session.input({ type: "gamepad", gamepad });
  expect(channel.sent.at(-1)).toEqual({ type: "gamepad", gamepad, grant });
  channel.receive({ ...active, capabilities: ["coPlay", "text"], reason: "gamepad" });
  const before = channel.sent.length;
  session.input({ type: "gamepad", gamepad }); session.input({ type: "gamepad-reset" });
  expect(channel.sent).toHaveLength(before);
  session.input({ type: "key", code: "KeyW", down: false });
  session.input({ type: "text", text: "hello" });
  session.input({ type: "reset" });
  expect(channel.sent.slice(before)).toEqual([
    { type: "key", code: "KeyW", down: false, grant }, { type: "text", text: "hello", grant }, { type: "reset", grant },
  ]);
  expect(session.state?.state).toBe("active"); expect(session.state?.grant).toBe(grant);
  session.dispose();
});

it("maps standard gamepads into one negotiated grant and resets on focus loss, unplug and retirement", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  channel.receive({ platform: "windows", mode: "ask", state: "ready" });
  expect(channel.sent.at(-1)).toEqual({ type: "capabilities" });
  channel.receive({ platform: "windows", mode: "ask", state: "ready", coPlay: true, capabilities: ["coPlay", "gamepad"] });
  session.request();
  const intent = channel.sent.at(-1)?.intent;
  expect(channel.sent.at(-1)).toEqual({ type: "request", intent });
  const grant = "d".repeat(64);
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent, grant, coPlay: true, capabilities: ["coPlay", "gamepad"] });
  const beforeInput = channel.sent.length;
  session.input({ type: "key", code: "KeyW", down: true });
  session.input({ type: "button", button: 0, down: true });
  expect(channel.sent.slice(beforeInput)).toEqual([
    { type: "key", code: "KeyW", down: true, grant }, { type: "button", button: 0, down: true, grant },
  ]);

  const pad = { index: 1, connected: true, mapping: "standard", axes: [-1, -1, 1, 1],
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: [0, 1, 4, 8, 9, 10, 12].includes(index), value: index === 6 ? .5 : index === 7 ? 1 : 0 })),
  } as unknown as Gamepad;
  let pads: (Gamepad | null)[] = [{ ...pad, index: 0, mapping: "" } as Gamepad, pad];
  let focused = true;
  const page = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => focused });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const owner = Object.assign(new EventTarget(), { navigator: { getGamepads: () => pads },
    requestAnimationFrame: (frame: FrameRequestCallback) => { frames.set(++sequence, frame); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const tick = (time: number) => {
    const entry = frames.entries().next().value!;
    frames.delete(entry[0]); entry[1](time);
  };
  const controller = new RemoteGamepad(event => session.input(event), () => {}, owner as unknown as Window, page as unknown as Document);
  try {
    tick(0); tick(17);
    const report = { type: "gamepad", grant, gamepad: { buttons: 0x1713,
      leftTrigger: 128, rightTrigger: 255, leftX: -32768, leftY: -32768, rightX: 32767, rightY: 32767 } };
    expect(channel.sent.slice(-2)).toEqual([report, report]);
    focused = false; owner.dispatchEvent(new Event("blur"));
    expect(channel.sent.at(-1)).toEqual({ type: "gamepad-reset", grant });
    expect(frames.size).toBe(0);
    focused = true; owner.dispatchEvent(new Event("focus")); tick(34);
    expect(channel.sent.at(-1)).toEqual(report);
    pads = [];
    owner.dispatchEvent(Object.assign(new Event("gamepaddisconnected"), { gamepad: pad }));
    expect(channel.sent.at(-1)).toEqual({ type: "gamepad-reset", grant });
    tick(51);
    expect(channel.sent.at(-1)).toEqual({ type: "gamepad-reset", grant });
    page.hidden = true; page.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
  } finally { controller.dispose(); session.dispose(); }
  expect(frames.size).toBe(0);
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent });
  owner.dispatchEvent(new Event("focus"));
  expect(frames.size).toBe(0);
});

it.each(["windows", "darwin", "linux"] as const)("keeps the Host platform in local request state (%s)", platform => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  session.request();
  expect(channel.sent).toEqual([{ type: "sync" }]);
  expect(remoteInputStateSchema.safeParse({ mode: "ask", state: "ready" }).success).toBe(false);
  expect(remoteInputStateSchema.safeParse({ mode: "ask", state: "ready", platform: "unknown" }).success).toBe(false);
  channel.receive({ mode: "ask", state: "ready", platform });
  session.request();
  expect(session.state).toMatchObject({ state: "pending", platform });
  session.release();
  expect(session.state).toMatchObject({ state: "ready", platform });
  session.dispose();
});

it("reuses the authenticated identity across media routes and syncs after delayed key installation", async () => {
  const registered: InputIdentity[] = [];
  const route = new InputRoute(() => {});
  route.enable(identity => { registered.push(identity); return true; });
  const first = new Channel();
  route.setUpstream(first as unknown as RTCDataChannel);
  first.receive({ ready: true });
  const oldEndpoint = route.current!;
  const session = new RemoteInputSession(oldEndpoint, () => {});
  await vi.waitFor(() => expect(first.sent.filter(p => p.data)).toHaveLength(1));
  const oldPacket = first.sent.find(p => p.data)!;
  expect(oldPacket.data).not.toContain("sync");
  first.receive({ id: registered[0].endpointId, ready: true });
  await vi.waitFor(() => expect(first.sent.filter(p => p.data)).toHaveLength(2));
  session.dispose();
  const next = new Channel();
  route.setUpstream(next as unknown as RTCDataChannel);
  expect(oldEndpoint.readyState).toBe("closed");
  next.receive({ ready: true });
  const nextSession = new RemoteInputSession(route.current!, () => {});
  await vi.waitFor(() => expect(next.sent.filter(p => p.data)).toHaveLength(1));
  const newPacket = next.sent.find(p => p.data)!;
  expect(registered).toHaveLength(1);
  expect(newPacket.id).toBe(oldPacket.id);
  expect(newPacket.epoch).not.toBe(oldPacket.epoch);
  const sequence = (p: Record<string, unknown>) => new DataView(Uint8Array.from(atob(p.data as string), c => c.charCodeAt(0)).buffer).getBigUint64(0);
  expect(sequence(newPacket)).toBeGreaterThan(sequence(oldPacket));
  nextSession.dispose();
  route.dispose();
});

it("binds input to the current request and retires cancelled or replaced grants", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  const grant = "a".repeat(64);
  channel.receive({ platform: "windows", mode: "ask", state: "ready" });
  session.request();
  const first = channel.sent.at(-1)?.intent;
  session.release();
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent: first, grant });
  expect(session.state?.state).toBe("ready");
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: first });
  session.request();
  const second = channel.sent.at(-1)?.intent;
  channel.receive({ platform: "windows", mode: "ask", state: "ready", intent: first });
  expect(session.state?.state).toBe("pending");
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent: second, grant });
  session.input({ type: "key", code: "KeyW", down: true });
  expect(channel.sent.at(-1)).toEqual({ type: "key", code: "KeyW", down: true, grant });
  channel.receive({ platform: "windows", mode: "ask", state: "suspended", intent: second, grant });
  const count = channel.sent.length;
  session.input({ type: "key", code: "KeyD", down: true });
  expect(channel.sent).toHaveLength(count);
  session.input({ type: "reset" });
  expect(channel.sent.at(-1)).toEqual({ type: "reset", grant });
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent: second, grant });
  session.dispose();
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: second });
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent: second, grant });
  session.input({ type: "key", code: "KeyW", down: true });
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: second });
  expect(channel.readyState).toBe("open"); // Media owns the channel lifetime.
});

it("maps only visible picture pixels when playback has letterboxing", () => {
  const video = { videoWidth: 1920, videoHeight: 1080,
    style: { objectFit: "contain" }, dataset: {},
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
  } as HTMLVideoElement;
  expect(picturePoint(video, 500, 350)).toEqual({ x: 0.5, y: 0.5 });
  expect(picturePoint(video, 500, 60)).toBeNull();
  expect(picturePoint(video, 901, 350)).toBeNull();
  video.style.objectFit = "cover";
  expect(picturePoint(video, 500, 350)).toEqual({ x: 0.5, y: 0.5 });
  // Filling this 4:3 player crops the 16:9 picture, it does not stretch input.
  expect(picturePoint(video, 100, 50)?.x).toBeCloseTo(0.125);
  expect(picturePoint(video, 900, 650)?.x).toBeCloseTo(0.875);
  video.style.objectFit = "fill";
  expect(picturePoint(video, 100, 50)).toEqual({ x: 0, y: 0 });
  expect(picturePoint(video, 900, 650)).toEqual({ x: 1, y: 1 });
  expect(picturePoint(video, 300, 500)).toEqual({ x: 0.25, y: 0.75 });
});

it("ends a pending request when its source becomes unavailable, even before the request reaches the Host", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  channel.receive({ platform: "windows", mode: "ask", state: "ready" });
  session.request();
  // Source pause/off can be announced before the Host has seen this intent.
  // It still invalidates the whole endpoint, not just an older request.
  channel.receive({ platform: "windows", mode: "ask", state: "unavailable" });
  expect(session.state?.state).toBe("unavailable");
  channel.receive({ platform: "windows", mode: "ask", state: "ready" });
  session.request();
  channel.receive({ platform: "windows", mode: "off", state: "unavailable", intent: "a".repeat(32) });
  expect(session.state?.mode).toBe("off");
  session.dispose();
});

it.each([
  [0, { x: .25, y: .75 }], [90, { x: .25, y: .25 }],
  [180, { x: .75, y: .25 }], [270, { x: .75, y: .75 }],
] as const)("maps rotated picture pixels and relative motion back to source axes (%s°)", (rotation, shown) => {
  const video = { videoWidth: 1920, videoHeight: 1080,
    style: { objectFit: "fill" }, dataset: { pictureRotation: String(rotation) },
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
  } as unknown as HTMLVideoElement;
  expect(rotatePicturePoint({ x: .25, y: .75 }, rotation)).toEqual(shown);
  expect(picturePoint(video, 100 + shown.x * 800, 50 + shown.y * 600)).toEqual({ x: .25, y: .75 });
  expect(picturePoint(video, 99, 50)).toBeNull();
  const motion = rotatePictureDelta({ x: .1, y: -.2 }, rotation as VideoRotation);
  expect(rotatePictureDelta(motion, rotation, true)).toEqual({ x: .1, y: -.2 });
  video.style.objectFit = "contain";
  const sideways = rotation === 90 || rotation === 270;
  expect(picturePoint(video, sideways ? 101 : 500, sideways ? 350 : 51)).toBeNull();
  expect(picturePoint(video, 500, 350)).toEqual({ x: .5, y: .5 });
});

it("sends a control password only in the request and follows the App policy after cancellation", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  channel.receive({ platform: "windows", state: "ready", mode: "password" });
  session.request("temporary-secret");
  const intent = channel.sent.at(-1)?.intent;
  expect(channel.sent.at(-1)).toMatchObject({ type: "request", password: "temporary-secret" });
  channel.receive({ platform: "windows", state: "ready", mode: "password", reason: "password", intent });
  expect(session.state?.reason).toBe("password");
  session.release();
  expect(session.state?.reason).toBeUndefined();
  expect(session.state?.mode).toBe("password");
  session.request("temporary-secret");
  const nextIntent = channel.sent.at(-1)?.intent;
  channel.receive({ platform: "windows", state: "active", mode: "password", intent: nextIntent, grant: "a".repeat(64) });
  session.release();
  expect(session.state?.mode).toBe("password");
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: nextIntent });
  channel.receive({ platform: "windows", state: "ready", mode: "ask", intent: nextIntent });
  expect(session.state?.mode).toBe("ask");
  session.dispose();
});

it("preserves wheel magnitude and fractions across browser units, only within the current grant", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  channel.receive({ platform: "windows", mode: "ask", state: "ready" });
  session.request();
  const intent = channel.sent.at(-1)?.intent;
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent, grant: "c".repeat(64) });
  session.scroll(100, 0);
  session.scroll(3, 1);
  session.scroll(1, 2);
  expect(channel.sent.slice(-3).map(event => event.delta)).toEqual([-120, -120, -120]);
  const count = channel.sent.length;
  for (let i = 0; i < 4; i++) session.scroll(0.25, 0);
  expect(channel.sent).toHaveLength(count + 1);
  expect(channel.sent.at(-1)?.delta).toBe(-1);
  session.scroll(-10_000, 0);
  expect(channel.sent.at(-1)?.delta).toBe(1200);
  channel.receive({ platform: "windows", mode: "ask", state: "suspended", intent, grant: "c".repeat(64) });
  const suspendedCount = channel.sent.length;
  session.scroll(100, 0);
  expect(channel.sent).toHaveLength(suspendedCount);
  channel.receive({ platform: "windows", mode: "ask", state: "active", intent, grant: "c".repeat(64) });
  session.scroll(0.75, 0);
  expect(channel.sent).toHaveLength(suspendedCount);
  session.dispose();
});

it("flushes coalesced motion before buttons and discards it when control ends", () => {
  vi.useFakeTimers();
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  const grant = "b".repeat(64);
  try {
    channel.receive({ platform: "windows", mode: "ask", state: "ready" });
    session.request();
    const intent = channel.sent.at(-1)?.intent;
    channel.receive({ platform: "windows", mode: "ask", state: "active", intent, grant });
    session.input({ type: "move", x: 0.2, y: 0.3 });
    session.input({ type: "move", x: 0.7, y: 0.8 });
    session.input({ type: "button", button: 0, down: false });
    expect(channel.sent.slice(-2)).toEqual([
      { type: "move", x: 0.7, y: 0.8, grant },
      { type: "button", button: 0, down: false, grant },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    session.input({ type: "relative", dx: 3, dy: -2 });
    session.input({ type: "relative", dx: 4, dy: 5 });
    vi.advanceTimersByTime(4); // Input does not depend on a rendered frame.
    expect(channel.sent.at(-1)).toEqual({ type: "relative", dx: 7, dy: 3, grant });
    session.input({ type: "move", x: 0.9, y: 0.1 });
    const count = channel.sent.length;
    channel.receive({ platform: "windows", mode: "ask", state: "ready", intent });
    expect(vi.getTimerCount()).toBe(0);
    expect(channel.sent).toHaveLength(count);
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});
