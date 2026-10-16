import { expect, it } from "vitest";
import { RemoteInputSession, picturePoint } from "../src/client/remote-control/input-session";

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  receive(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

it("binds input to the current request and retires cancelled or replaced grants", () => {
  const channel = new Channel();
  const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
  const grant = "a".repeat(64);
  channel.receive({ state: "ready" });
  session.request();
  const first = channel.sent.at(-1)?.intent;
  session.release();
  channel.receive({ state: "active", intent: first, grant });
  expect(session.state?.state).toBe("ready");
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: first });
  session.request();
  const second = channel.sent.at(-1)?.intent;
  channel.receive({ state: "ready", intent: first });
  expect(session.state?.state).toBe("pending");
  channel.receive({ state: "active", intent: second, grant });
  session.input({ type: "key", code: "KeyW", down: true });
  expect(channel.sent.at(-1)).toEqual({ type: "key", code: "KeyW", down: true, grant });
  channel.receive({ state: "suspended", intent: second, grant });
  const count = channel.sent.length;
  session.input({ type: "key", code: "KeyD", down: true });
  expect(channel.sent).toHaveLength(count);
  session.input({ type: "reset" });
  expect(channel.sent.at(-1)).toEqual({ type: "reset", grant });
  channel.receive({ state: "active", intent: second, grant });
  session.dispose();
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: second });
  channel.receive({ state: "active", intent: second, grant });
  session.input({ type: "key", code: "KeyW", down: true });
  expect(channel.sent.at(-1)).toEqual({ type: "release", intent: second });
  expect(channel.readyState).toBe("open"); // Media owns the channel lifetime.
});

it("maps only visible picture pixels when playback has letterboxing", () => {
  const video = { videoWidth: 1920, videoHeight: 1080,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
  } as HTMLVideoElement;
  expect(picturePoint(video, 500, 350)).toEqual({ x: 0.5, y: 0.5 });
  expect(picturePoint(video, 500, 60)).toBeNull();
  expect(picturePoint(video, 901, 350)).toBeNull();
});
