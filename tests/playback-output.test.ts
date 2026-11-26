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

it("serializes two device choices across players, shared voice and a retiring player", async () => {
  let release!: () => void;
  let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const calls = new Map<string, string[]>();
  const sink = (name: string) => ({ setSinkId: async (id: string) => {
    calls.set(name, [...(calls.get(name) ?? []), id]);
    if (name === "screen" && id === "A") {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
  } }) as unknown as HTMLMediaElement;
  const screen = playbackOutput.attach(sink("screen"));
  const retiring = playbackOutput.attach(sink("page"));
  const voice = playbackOutput.attach(sink("voice"));
  const first = playbackOutput.choose("A");
  await entering;
  const second = playbackOutput.choose("B");
  const arriving = playbackOutput.attach(sink("new-page"));
  retiring();
  try {
    release();
    await Promise.all([first, second, arriving.ready]);
    expect(playbackOutput.selected).toBe("B");
    expect(playbackOutput.failed).toBe(false);
    expect(calls.get("screen")).toEqual(["A", "B"]);
    expect(calls.get("voice")).toEqual(["A", "B"]);
    expect(calls.get("page")).toBeUndefined();
    expect(calls.get("new-page")?.at(-1)).toBe("B");
    expect(arriving.getWaiting()).toBe(false);
  } finally { release(); screen(); voice(); arriving(); retiring(); await playbackOutput.choose(""); }
});

it("identifies the player whose previous device cannot be restored after another output refuses the change", async () => {
  let oldDeviceAvailable = true;
  let applied = "";
  const screen = { setSinkId: async (id: string) => {
    if (id === "headphones" && !oldDeviceAvailable) throw new DOMException("Unplugged", "NotFoundError");
    applied = id;
  } } as unknown as HTMLMediaElement;
  const voice = { setSinkId: async (id: string) => {
    if (id === "alternate") {
      oldDeviceAvailable = false;
      throw new DOMException("Cannot switch voice output", "AbortError");
    }
  } } as unknown as AudioContext;
  const stopScreen = playbackOutput.attach(screen), stopVoice = playbackOutput.attach(voice);
  try {
    await playbackOutput.choose("headphones");
    await expect(playbackOutput.choose("alternate")).rejects.toThrow("Cannot switch voice output");
    expect(playbackOutput.selected).toBe("headphones");
    expect(applied).toBe("alternate");
    expect(playbackOutput.failedFor(screen)).toBe(true);
    expect(playbackOutput.failedFor(voice)).toBe(false);
    await playbackOutput.choose("working");
    expect(applied).toBe("working");
    expect(playbackOutput.failed).toBe(false);
  } finally { stopScreen(); stopVoice(); await playbackOutput.choose(""); }
});

it("reports a missing selected device across active outputs and lets the browser resume it on reconnect", async () => {
  const devices = new EventTarget();
  let available = ["headphones"];
  const enumerate = vi.fn(async () => available.map(deviceId => ({ deviceId, kind: "audiooutput" })));
  Object.assign(devices, { enumerateDevices: enumerate });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  vi.resetModules();
  const { playbackOutput: output } = await import("../src/client/media/playback-output");
  const sink = () => ({ setSinkId: vi.fn(async () => {}) }) as unknown as HTMLMediaElement;
  const screen = sink(), page = sink(), voice = sink();
  const stops = [output.attach(screen), output.attach(page), output.attach(voice)];
  const changes = vi.fn();
  const unsubscribe = output.subscribe(changes);
  try {
    await output.choose("headphones");
    available = [];
    devices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(output.failed).toBe(true));
    expect(output.selected).toBe("headphones");
    expect([screen, page, voice].map(target => output.failedFor(target))).toEqual([true, true, true]);
    // setSinkId resolves without inspecting hardware when the sink ID is unchanged.
    await output.choose("headphones");
    expect(output.failed).toBe(true);
    stops[1]();
    expect(output.failedFor(page)).toBe(false);
    expect(output.failedFor(voice)).toBe(true);
    available = ["headphones"];
    devices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(output.failed).toBe(false));
    expect(output.selected).toBe("headphones");
    expect(screen.setSinkId).toHaveBeenCalledTimes(2);
    expect(voice.setSinkId).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenCalledTimes(4);
  } finally { unsubscribe(); for (const stop of stops) stop(); await output.choose(""); vi.unstubAllGlobals(); }
});

it("applies a returning device to outputs created while it was absent and keeps a refused output actionable", async () => {
  const devices = new EventTarget();
  let available = false;
  Object.assign(devices, { enumerateDevices: async () => available ? [{ deviceId: "headphones", kind: "audiooutput" }] : [] });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  vi.resetModules();
  const { playbackOutput: output } = await import("../src/client/media/playback-output");
  await output.choose("headphones");
  const sink = (refused = false) => ({ setSinkId: vi.fn(async () => {
    if (!available) throw new DOMException("Unplugged", "NotFoundError");
    if (refused) throw new DOMException("Not allowed", "NotAllowedError");
  }) }) as unknown as HTMLMediaElement;
  const refused = sink(true), screen = sink(), voice = sink(), retired = sink();
  const stops = [output.attach(refused), output.attach(screen), output.attach(voice), output.attach(retired)];
  try {
    await vi.waitFor(() => expect(output.failedFor(retired)).toBe(true));
    expect(stops.every(stop => stop.getWaiting())).toBe(true);
    stops[3]();
    available = true;
    devices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(stops[1].getWaiting()).toBe(false));
    await stops[2].ready;
    expect(output.selected).toBe("headphones");
    expect(output.failedFor(screen)).toBe(false);
    expect(output.failedFor(voice)).toBe(false);
    expect(output.failedFor(refused)).toBe(true);
    expect(output.failed).toBe(true);
    expect(stops[0].getWaiting()).toBe(true);
    expect(retired.setSinkId).toHaveBeenCalledTimes(1);
    expect(screen.setSinkId).toHaveBeenLastCalledWith("headphones");
    stops[0]();
    expect(output.failed).toBe(false);
  } finally { for (const stop of stops) stop(); await output.choose(""); vi.unstubAllGlobals(); }
});

it("finishes device recovery before a later explicit choice without reviving a retired output", async () => {
  const devices = new EventTarget();
  let available = false, release!: () => void;
  Object.assign(devices, { enumerateDevices: async () => available ? [{ deviceId: "A", kind: "audiooutput" }] : [] });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  vi.resetModules();
  const { playbackOutput: output } = await import("../src/client/media/playback-output");
  await output.choose("A");
  const screen = { setSinkId: vi.fn(async (id: string) => {
    if (!available) throw new DOMException("Unplugged", "NotFoundError");
    if (id === "A") await new Promise<void>(resolve => { release = resolve; });
  }) } as unknown as HTMLMediaElement;
  const retired = { setSinkId: vi.fn(async () => {
    if (!available) throw new DOMException("Unplugged", "NotFoundError");
  }) } as unknown as HTMLMediaElement;
  const stopScreen = output.attach(screen), stopRetired = output.attach(retired);
  try {
    await vi.waitFor(() => expect(output.failedFor(retired)).toBe(true));
    available = true;
    devices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const choice = output.choose("B");
    stopRetired();
    release();
    await choice;
    await stopScreen.ready;
    expect(output.selected).toBe("B");
    expect(output.failed).toBe(false);
    expect(screen.setSinkId).toHaveBeenCalledTimes(3);
    expect(screen.setSinkId).toHaveBeenLastCalledWith("B");
    expect(retired.setSinkId).toHaveBeenCalledTimes(1);
    expect(output.failedFor(retired)).toBe(false);
  } finally { release?.(); stopScreen(); stopRetired(); await output.choose(""); vi.unstubAllGlobals(); }
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

it.each(["reselect", "close"])("clears one failed initial output on %s while keeping healthy outputs ready", async action => {
  await playbackOutput.choose("headphones");
  const refusedElement = { setSinkId: async (id: string) => {
    if (id === "headphones") throw Error("unavailable");
  } } as unknown as HTMLMediaElement;
  const healthyElement = { setSinkId: async () => {} } as unknown as HTMLMediaElement;
  const refused = playbackOutput.attach(refusedElement);
  const healthy = playbackOutput.attach(healthyElement);
  try {
    await healthy.ready;
    expect(refused.getWaiting()).toBe(true);
    expect(playbackOutput.failed).toBe(true);
    expect(playbackOutput.failedFor(refusedElement)).toBe(true);
    expect(healthy.getWaiting()).toBe(false);
    expect(playbackOutput.failedFor(healthyElement)).toBe(false);
    if (action === "reselect") await playbackOutput.choose("alternate");
    else refused();
    await refused.ready;
    expect(refused.getWaiting()).toBe(false);
    expect(playbackOutput.failedFor(refusedElement)).toBe(false);
    expect(healthy.getWaiting()).toBe(false);
    expect(playbackOutput.selected).toBe(action === "reselect" ? "alternate" : "headphones");
    expect(playbackOutput.failed).toBe(false);
  } finally { refused(); healthy(); await playbackOutput.choose(""); }
});
