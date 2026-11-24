import { expect, it, vi } from "vitest";
import { playbackOutput } from "../src/client/media/playback-output";

it("moves registered outputs together, preserves the previous selection on refusal and releases retired outputs", async () => {
  const element = { setSinkId: vi.fn(async (_id: string) => {}) };
  const context = { setSinkId: vi.fn(async (id: string) => { if (id === "missing") throw Error("missing"); }) };
  const stopElement = playbackOutput.attach(element as unknown as HTMLMediaElement);
  const stopContext = playbackOutput.attach(context as unknown as AudioContext);
  await playbackOutput.choose("headphones");
  expect(context.setSinkId).toHaveBeenCalledWith("headphones");
  await expect(playbackOutput.choose("missing")).rejects.toThrow();
  expect(element.setSinkId).toHaveBeenLastCalledWith("headphones");
  expect(playbackOutput.selected).toBe("headphones");
  stopContext();
  await playbackOutput.choose("");
  expect(element.setSinkId).toHaveBeenLastCalledWith("");
  expect(context.setSinkId).toHaveBeenLastCalledWith("missing");
  stopElement();
});

it("keeps healthy outputs on the chosen device when a retiring output rejects late", async () => {
  let started!: () => void;
  let reject!: () => void;
  const entering = new Promise<void>(resolve => { started = resolve; });
  const healthy = { setSinkId: vi.fn(async (_id: string) => {}) };
  const retiring = { setSinkId: () => new Promise<void>((_, fail) => {
    reject = () => fail(new Error("closed"));
    started();
  }) };
  const stopHealthy = playbackOutput.attach(healthy as unknown as HTMLMediaElement);
  const stopRetiring = playbackOutput.attach(retiring as unknown as AudioContext);
  const changing = playbackOutput.choose("headset");
  await entering;
  stopRetiring();
  reject();
  await changing;
  expect(playbackOutput.selected).toBe("headset");
  expect(healthy.setSinkId.mock.calls).toEqual([["headset"]]);
  expect(playbackOutput.failed).toBe(false);
  stopHealthy();
  await playbackOutput.choose("");
});
