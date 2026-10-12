import { afterEach, expect, it, vi } from "vitest";
import { NativePunchReceiver, NativePunchSender, type NativePunchControl } from "../src/client/native/native-punch";
import type { PunchPrediction, SignalPayload } from "../src/shared/protocol";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const prediction: PunchPrediction = { address: "198.51.100.1", port: 40000, step: 1 };
const ice = { iceServers: [] };
const control = () => ({
  preparePunch: vi.fn<NativePunchControl["preparePunch"]>(async () => prediction),
  runPunch: vi.fn<NativePunchControl["runPunch"]>(async () => true),
  closePunch: vi.fn<NativePunchControl["closePunch"]>(async () => undefined),
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it.each(["success", "receiver-fails", "sender-fails", "browser", "timeout", "dispose"])(
  "uses one bounded preparation and requires mutual success: %s", async outcome => {
    vi.useFakeTimers();
    const source = control();
    const target = control();
    const sent: SignalPayload[] = [];
    if (outcome === "receiver-fails") target.runPunch.mockResolvedValue(false);
    if (outcome === "sender-fails") source.runPunch.mockResolvedValue(false);
    let receiver!: NativePunchReceiver;
    const sender = new NativePunchSender(source, "share", "connection", ice, payload => {
      sent.push(payload);
      if (payload.kind !== "punch" || outcome === "timeout" || outcome === "dispose") return true;
      if (payload.punch.phase === "prepare") {
        if (outcome === "browser") sender.accept({ phase: "ready" });
        else void receiver.prepare(payload.punch.secret);
      } else if (payload.punch.phase === "start") void receiver.run(payload.punch.prediction);
      return true;
    });
    receiver = new NativePunchReceiver("parent", "connection", "share", ice, 2, async () => target, payload => {
      if (payload.kind === "punch") sender.accept(payload.punch);
      return true;
    });
    try {
      const result = sender.start();
      if (outcome === "dispose") sender.dispose();
      await flush();
      if (outcome === "timeout") await vi.advanceTimersByTimeAsync(3_500);
      expect(await result).toBe(outcome === "success");
      expect(source.preparePunch).toHaveBeenCalledOnce();
      expect(source.preparePunch.mock.calls[0][4]).toBeUndefined();
      if (outcome === "success") {
        expect(target.preparePunch.mock.calls[0][4]).toBe(2);
        expect(receiver.commit()).toBe(true);
        expect(source.closePunch).not.toHaveBeenCalled();
        expect(target.closePunch).not.toHaveBeenCalled();
        // The SDP commit consumes the prepared sockets; duplicate preflight
        // phases cannot allocate more sockets or send a second start.
        sender.accept({ phase: "ready", prediction });
        await receiver.run(prediction);
        await flush();
        expect(source.runPunch).toHaveBeenCalledOnce();
        expect(target.runPunch).toHaveBeenCalledOnce();
      } else {
        expect(source.closePunch).toHaveBeenCalled();
      }
      if (["browser", "timeout", "dispose"].includes(outcome)) expect(source.runPunch).not.toHaveBeenCalled();
      const prepare = sent[0];
      expect(prepare.kind === "punch" && prepare.punch.phase === "prepare" && prepare.punch.secret).toMatch(/^[a-f0-9]{64}$/);
    } finally { sender.dispose(); receiver.dispose(); }
  },
);

it("does not allocate after late App discovery or revive an expired receiver", async () => {
  vi.useFakeTimers();
  const target = control();
  let discovered!: (value: NativePunchControl) => void;
  const sent = vi.fn(() => true);
  const receiver = new NativePunchReceiver("parent", "connection", "share", ice, 2,
    () => new Promise(resolve => { discovered = resolve; }), sent);
  const prepared = receiver.prepare("42".repeat(32));
  await vi.advanceTimersByTimeAsync(3_500);
  discovered(target);
  await prepared;
  expect(target.preparePunch).not.toHaveBeenCalled();
  expect(sent).not.toHaveBeenCalled();
  expect(receiver.commit()).toBe(false);
});

it("retires successful sockets if their SDP never arrives", async () => {
  vi.useFakeTimers();
  const target = control();
  const receiver = new NativePunchReceiver("parent", "connection", "share", ice, 2, async () => target, () => true);
  await receiver.prepare("42".repeat(32));
  await receiver.run(prediction);
  await vi.advanceTimersByTimeAsync(3_500);
  expect(receiver.commit()).toBe(false);
  expect(target.closePunch).toHaveBeenCalledExactlyOnceWith("share", "connection");
});

it("ignores late success after sender cancellation", async () => {
  vi.useFakeTimers();
  const source = control();
  let complete!: (value: boolean) => void;
  source.runPunch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const sender = new NativePunchSender(source, "share", "connection", ice, () => true);
  const result = sender.start();
  sender.accept({ phase: "ready", prediction });
  await flush();
  sender.dispose();
  complete(true);
  sender.accept({ phase: "complete", connected: true });
  expect(await result).toBe(false);
});
