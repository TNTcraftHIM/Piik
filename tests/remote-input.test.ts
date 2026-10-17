import { expect, it, vi } from "vitest";
import { RemoteInputSession, picturePoint } from "../src/client/remote-control/input-session";
import { InputRoute, type InputIdentity } from "../src/client/remote-control/input-route";
import { remoteInputStateSchema } from "../src/client/remote-control/protocol";

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  receive(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

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
    style: { objectFit: "contain" },
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
