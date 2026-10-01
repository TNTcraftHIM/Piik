import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserEncodingPool } from "../src/client/media/browser-encoding-pool";
import { BrowserEncodingProducer } from "../src/client/media/browser-encoding-producer";
import type { BrowserEncodingOutput } from "../src/client/media/browser-encoding-output";
import { QUALITY_PROFILES } from "../src/client/media/quality";

const codec = { mimeType: "video/VP8", clockRate: 90_000 };
const profile = QUALITY_PROFILES["1080p30"];
const source = { kind: "video", readyState: "live", enabled: true, id: "source" } as MediaStreamTrack;
const producers = new Map<BrowserEncodingProducer, {
  budget: number; bitrate: number; bytes: number; frames: number; fps: number; width: number; height: number; reason: string;
}>();
let pool: BrowserEncodingPool;

function stats(row: Record<string, unknown>): RTCStatsReport {
  return new Map([
    ["video", { id: "video", timestamp: Date.now(), type: "outbound-rtp", kind: "video", codecId: "codec", ...row }],
    ["codec", { id: "codec", timestamp: Date.now(), type: "codec", ...codec }],
  ]) as unknown as RTCStatsReport;
}

function member(budget = 2_000_000) {
  const demand = { budget };
  let producerId: string | null = null;
  const select = vi.fn((id: string, _requestKey: () => Promise<void>, selected: () => void,
    accept: (metadata: RTCEncodedVideoFrameMetadata) => boolean) => {
    const [, output] = [...producers].find(([producer]) => producer.id === id)!;
    if (!accept({ width: output.width, height: output.height })) return;
    producerId = id;
    selected();
  });
  const cancelSelection = vi.fn(() => true);
  const encoded = {
    select, cancelSelection, push: vi.fn(), passthrough: vi.fn(), setPaused: vi.fn(),
    snapshot: () => ({ frames: producerId ? 30 : 0, width: 1920, height: 1080, timestamp: Date.now(), lastProducerId: producerId }),
  } as unknown as BrowserEncodingOutput;
  const connection = { connectionState: "connected", getStats: async () => stats({ targetBitrate: demand.budget }) };
  const fatal = vi.fn();
  const handle = pool.create(source, {} as RTCRtpSender, connection as RTCPeerConnection, profile,
    encoded, async () => true, async () => undefined, fatal)!;
  return { demand, select, cancelSelection, fatal, handle, producerId: () => producerId };
}

async function sample(count = 1) {
  await vi.advanceTimersByTimeAsync(500 * count);
}

function holdNextProducerStart(): () => void {
  let ready!: () => void;
  const start = vi.mocked(BrowserEncodingProducer.prototype.start).getMockImplementation()!;
  vi.mocked(BrowserEncodingProducer.prototype.start).mockImplementationOnce(async function (this: BrowserEncodingProducer, budget) {
    await start.call(this, budget);
    await new Promise<void>((resolve) => { ready = resolve; });
  });
  return () => ready();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [codec] }) });
  producers.clear();
  vi.spyOn(BrowserEncodingProducer.prototype, "start").mockImplementation(async function (this: BrowserEncodingProducer, budget) {
    producers.set(this, { budget: budget!, bitrate: budget! / 2, bytes: 0, frames: 0, fps: 30,
      width: 1920, height: 1080, reason: "none" });
  });
  vi.spyOn(BrowserEncodingProducer.prototype, "report").mockImplementation(async function (this: BrowserEncodingProducer) {
    const output = producers.get(this)!;
    output.bytes += output.bitrate / 16;
    output.frames += output.fps / 2;
    return stats({ bytesSent: output.bytes, framesEncoded: output.frames, frameWidth: output.width, frameHeight: output.height,
      qualityLimitationReason: output.reason });
  });
  vi.spyOn(BrowserEncodingProducer.prototype, "update").mockImplementation(async function (this: BrowserEncodingProducer, _profile, budget) {
    producers.get(this)!.budget = budget!;
  });
  vi.spyOn(BrowserEncodingProducer.prototype, "setPaused").mockImplementation(() => undefined);
  vi.spyOn(BrowserEncodingProducer.prototype, "dispose").mockImplementation(() => undefined);
  pool = new BrowserEncodingPool();
});

afterEach(() => {
  pool.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Browser encoding pool ownership", () => {
  it("pauses a shared producer only when all of its members pause", async () => {
    const first = member(), second = member();
    await sample(4);
    expect(producers.size).toBe(1);
    const producer = [...producers.keys()][0]!;

    first.handle.setPaused(true);
    expect(producer.setPaused).toHaveBeenLastCalledWith(false);
    second.handle.setPaused(true);
    expect(producer.setPaused).toHaveBeenLastCalledWith(true);
    first.handle.setPaused(false);
    expect(producer.setPaused).toHaveBeenLastCalledWith(false);
    expect(first.producerId()).toBe(second.producerId());
    expect(producer.dispose).not.toHaveBeenCalled();
  });

  it("selects a prepared producer without waiting for another budget sample", async () => {
    const ready = holdNextProducerStart();
    const first = member();
    await sample();
    expect(first.select).not.toHaveBeenCalled();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.producerId()).toBe([...producers.keys()][0]!.id);
  });

  it("keeps a shared encoder through a bitrate spike with unchanged native demand", async () => {
    const first = member(), second = member();
    await sample(4);
    expect(producers.size).toBe(1);
    const [producer, output] = [...producers][0];
    expect(first.producerId()).toBe(producer.id);
    expect(second.producerId()).toBe(producer.id);

    output.bitrate = output.budget + 16;
    await sample();
    output.bitrate = output.budget / 2;
    await sample(2);

    expect(producers.size).toBe(1);
    expect(first.select).toHaveBeenCalledTimes(1);
    expect(second.select).toHaveBeenCalledTimes(1);
    expect(producer.dispose).not.toHaveBeenCalled();
  });

  it("updates shared demand in place when all children need a lower rate", async () => {
    const first = member(), second = member();
    await sample(4);
    const [producer, output] = [...producers][0];
    first.demand.budget = second.demand.budget = 500_000;
    await sample(2);

    expect(producers.size).toBe(1);
    expect(output.budget).toBe(500_000);
    expect(producer.update).toHaveBeenCalledWith(profile, 500_000);
    expect(first.select).toHaveBeenCalledTimes(1);
    expect(second.select).toHaveBeenCalledTimes(1);
  });

  it("gives a weaker child its own rate owner and reunites it after recovery", async () => {
    const strong = member(), weak = member();
    await sample(4);
    const [original, output] = [...producers][0];
    weak.demand.budget = 500_000;
    await sample(3);

    expect(producers.size).toBe(2);
    expect(strong.producerId()).toBe(original.id);
    expect(weak.producerId()).not.toBe(original.id);
    expect(output.budget).toBe(2_000_000);
    expect(strong.select).toHaveBeenCalledTimes(1);

    weak.demand.budget = 2_000_000;
    await sample(3);
    expect(weak.producerId()).toBe(original.id);
    expect(producers.size).toBe(2);
    expect(strong.fatal).not.toHaveBeenCalled();
    expect(weak.fatal).not.toHaveBeenCalled();
  });

  it("does not move a healthy child to a lower-budget output with briefly higher FPS", async () => {
    const strong = member(), weak = member();
    await sample(4);
    const [original, originalOutput] = [...producers][0];
    weak.demand.budget = 500_000;
    await sample(3);
    const [candidate, candidateOutput] = [...producers][1];

    originalOutput.fps = 27;
    candidateOutput.fps = 29;
    await sample(4);

    expect(strong.producerId()).toBe(original.id);
    expect(weak.producerId()).toBe(candidate.id);
    expect(strong.select).toHaveBeenCalledTimes(1);
    expect(originalOutput.budget).toBe(2_000_000);
    expect(candidateOutput.budget).toBe(500_000);
  });

  it("keeps unequal rate owners through scene changes until native demand recovers", async () => {
    const strong = member(), weak = member();
    await sample(4);
    const [original, originalOutput] = [...producers][0];
    weak.demand.budget = 500_000;
    await sample(3);
    const [lower] = [...producers][1];

    // A quiet scene fits both paths, but the shared encoder is still free to
    // consume the stronger child's allocation when motion returns.
    for (const bitrate of [250_000, 1_000_000, 250_000, 1_000_000]) {
      originalOutput.bitrate = bitrate;
      await sample(3);
      expect(weak.producerId()).toBe(lower.id);
      expect(strong.producerId()).toBe(original.id);
    }
    expect(producers.size).toBe(2);
    expect(weak.select).toHaveBeenCalledTimes(2);

    weak.demand.budget = 2_000_000;
    await sample(3);
    expect(weak.producerId()).toBe(original.id);
  });

  it("does not admit a new weak child to a quiet higher-rate producer", async () => {
    const strong = member();
    await sample(4);
    const [original, output] = [...producers][0];
    output.bitrate = 250_000;
    await sample(2);

    const weak = member(500_000);
    await sample(4);
    expect(strong.producerId()).toBe(original.id);
    expect(weak.producerId()).not.toBe(original.id);
    expect(producers.size).toBe(2);
    expect([...producers.values()][1].budget).toBe(500_000);
  });

  it("keeps an existing weaker child's encoder when a stronger child joins", async () => {
    const weak = member(1_000_000);
    await sample(4);
    const [original, output] = [...producers][0];
    const strong = member(2_000_000);
    await sample(4);
    output.bitrate = 1_500_000;
    await sample(2);

    expect(weak.producerId()).toBe(original.id);
    expect(strong.producerId()).not.toBe(original.id);
    expect(output.budget).toBe(1_000_000);
    expect(producers.size).toBe(2);
  });

  it.each(["rising newcomer", "falling incumbent"])("uses current demand for optional reuse with a %s", async (change) => {
    const first = member(1_000_000), second = member(2_000_000);
    await sample(4);
    const [[original, originalOutput], [candidate, candidateOutput]] = [...producers];
    originalOutput.fps = 27;
    if (change === "falling incumbent") {
      candidateOutput.reason = "bandwidth";
      first.demand.budget = 2_000_000;
      await sample(2);
      second.demand.budget = 1_000_000;
    } else first.demand.budget = 3_000_000;
    candidateOutput.fps = 30;
    candidateOutput.reason = "none";
    candidateOutput.bitrate = second.demand.budget + 100_000;
    await sample(4);

    expect(first.producerId()).toBe(original.id);
    expect(second.producerId()).toBe(candidate.id);
    expect(originalOutput.budget).toBe(first.demand.budget);
    expect(candidateOutput.budget).toBe(second.demand.budget);
    expect(producers.size).toBe(2);
  });

  it("shares a group's current demand while its previous budget is being reduced", async () => {
    const first = member(2_000_000);
    await sample(4);
    const [original, output] = [...producers][0];
    first.demand.budget = 1_000_000;
    const second = member(1_000_000);
    await sample(4);

    expect(first.producerId()).toBe(original.id);
    expect(second.producerId()).toBe(original.id);
    expect(output.budget).toBe(1_000_000);
    expect(producers.size).toBe(1);
  });

  it.each(["preparation", "recovery frame"])("keeps a necessary downgrade through quiet output during %s", async (stage) => {
    const strong = member(), weak = member();
    await sample(4);
    const [original, originalOutput] = [...producers][0];
    let resume!: () => void;
    if (stage === "preparation") resume = holdNextProducerStart();
    else {
      const select = weak.select.getMockImplementation()!;
      weak.select.mockImplementationOnce((...args) => { resume = () => select(...args); });
    }
    weak.demand.budget = 500_000;
    await sample();
    const [candidate, candidateOutput] = [...producers][1];
    candidateOutput.width = 640; candidateOutput.height = 360;
    originalOutput.bitrate = 250_000;
    await sample(2);
    resume();
    await sample(2);

    expect(vi.mocked(BrowserEncodingProducer.prototype.dispose).mock.contexts).not.toContain(candidate);
    expect(weak.producerId()).toBe(candidate.id);
    expect(strong.producerId()).toBe(original.id);
    originalOutput.bitrate = 1_000_000;
    await sample(3);
    expect(producers.size).toBe(2);
    expect(weak.producerId()).toBe(candidate.id);
    expect(weak.fatal).not.toHaveBeenCalled();
  });

  it.each(["demand recovers", "stronger sibling leaves"])("retires an unnecessary downgrade when %s", async (change) => {
    const strong = member(), weak = member();
    await sample(4);
    const [original] = [...producers][0];
    const ready = holdNextProducerStart();
    weak.demand.budget = 500_000;
    await sample();
    const [candidate] = [...producers][1];
    if (change === "demand recovers") weak.demand.budget = 2_000_000;
    else strong.handle.dispose();
    await sample(2);
    ready();
    await sample(2);

    expect(vi.mocked(BrowserEncodingProducer.prototype.dispose).mock.contexts).toEqual([candidate]);
    expect(weak.producerId()).toBe(original.id);
    expect(producers.size).toBe(2);
    expect(producers.get(original)!.budget).toBe(weak.demand.budget);
  });

  it("replans a waiting child when another member raises a quiet producer's budget", async () => {
    const ready = holdNextProducerStart();
    const strong = member(), weak = member();
    await sample();
    weak.handle.setPaused(true);
    const [original, output] = [...producers][0];
    output.bitrate = 250_000;
    strong.demand.budget = 4_000_000;
    ready();
    await sample(3);
    expect(output.budget).toBe(4_000_000);
    expect(weak.select).not.toHaveBeenCalled();

    weak.handle.setPaused(false);
    await sample(4);
    expect(weak.producerId()).not.toBe(original.id);
    expect(weak.producerId()).toBe([...producers.keys()][1].id);
    expect(weak.select).toHaveBeenCalledTimes(1);
    expect(strong.producerId()).toBe(original.id);
  });

  it.each([
    { currentFps: 30, candidateFps: 32, improves: false },
    { currentFps: 20, candidateFps: 30, improves: true },
  ])("compares $currentFps to $candidateFps fps within the Host ceiling", async ({ currentFps, candidateFps, improves }) => {
    const strong = member(), weak = member();
    await sample(4);
    const [original, originalOutput] = [...producers][0];
    weak.demand.budget = 500_000;
    await sample(3);
    const [candidate, candidateOutput] = [...producers][1];
    expect(strong.producerId()).toBe(original.id);
    expect(weak.producerId()).toBe(candidate.id);

    originalOutput.fps = currentFps;
    candidateOutput.fps = candidateFps;
    weak.demand.budget = 2_000_000;
    await sample(4);

    const selected = improves ? candidate : original;
    expect(strong.producerId()).toBe(selected.id);
    expect(weak.producerId()).toBe(selected.id);
    expect(strong.select).toHaveBeenCalledTimes(improves ? 2 : 1);
    expect(weak.select).toHaveBeenCalledTimes(improves ? 2 : 3);
    expect(vi.mocked(BrowserEncodingProducer.prototype.dispose).mock.contexts)
      .toEqual([improves ? original : candidate]);
  });

  it.each([
    { change: "frame rate", output: { fps: 10 } },
    { change: "dimensions", output: { width: 1280, height: 720 } },
    { change: "bitrate", output: { bitrate: 3_000_000 } },
    { change: "native limitation", output: { reason: "bandwidth" } },
  ])("rechecks a pending improvement's $change before selection", async ({ output }) => {
    const strong = member(), weak = member();
    await sample(4);
    const [original, originalOutput] = [...producers][0];
    weak.demand.budget = 500_000;
    await sample(3);
    const [candidate, candidateOutput] = [...producers][1];

    originalOutput.fps = 20;
    weak.demand.budget = 2_000_000;
    await sample();
    expect(candidateOutput.budget).toBe(2_000_000);
    expect(strong.producerId()).toBe(original.id);
    expect(weak.producerId()).toBe(candidate.id);

    Object.assign(candidateOutput, output);
    await sample();
    expect(strong.producerId()).toBe(original.id);
    expect(strong.select).toHaveBeenCalledTimes(1);
    expect(weak.fatal).not.toHaveBeenCalled();
  });

  it.each(["key dimensions", "quiet current", "unknown current", "sampled limitation", "budget", "target demand", "profile"])(
    "rejects an optional handoff when %s changes while waiting for its key", async (change) => {
      const strong = member(), weak = member();
      await sample(4);
      const [original, originalOutput] = [...producers][0];
      weak.demand.budget = 500_000;
      await sample(3);
      const [candidate, candidateOutput] = [...producers][1];
      let accept!: (metadata: RTCEncodedVideoFrameMetadata) => boolean;
      strong.select.mockImplementationOnce((_id, _key, _commit, validate) => { accept = validate; });
      originalOutput.fps = 20;
      weak.demand.budget = 2_000_000;
      await sample(2);
      expect(accept).toBeDefined();
      expect(strong.producerId()).toBe(original.id);

      if (change === "sampled limitation") { candidateOutput.reason = "bandwidth"; await sample(); }
      if (change === "quiet current") { originalOutput.fps = 0; await sample(); }
      if (change === "unknown current") {
        vi.spyOn(original, "report").mockResolvedValueOnce(new Map() as unknown as RTCStatsReport);
        await sample();
      }
      if (change === "budget") { strong.demand.budget = 500_000; await sample(); }
      if (change === "target demand") { weak.demand.budget = 500_000; await sample(); }
      if (change === "profile") await strong.handle.updateProfile({ ...profile, resolution: "720p" });
      const key = ["key dimensions", "quiet current", "unknown current"].includes(change)
        ? { width: 960, height: 540 } : { width: 1920, height: 1080 };
      expect(accept(key)).toBe(false);
      // No pending reference may keep a rejected producer alive after its real
      // user leaves, nor may the healthy current producer have been retired.
      weak.handle.dispose();
      expect(vi.mocked(BrowserEncodingProducer.prototype.dispose).mock.contexts).toEqual([candidate]);
      expect(strong.producerId()).toBe(original.id);
      expect(strong.fatal).not.toHaveBeenCalled();
    });

  it("accepts a necessary lower-resolution handoff at the recovery frame", async () => {
    const strong = member(), weak = member();
    await sample(4);
    const original = [...producers.keys()][0]!;
    let accept!: (metadata: RTCEncodedVideoFrameMetadata) => boolean, commit!: () => void;
    weak.select.mockImplementationOnce((_id, _key, selected, validate) => { accept = validate; commit = selected; });
    weak.demand.budget = 500_000;
    await sample(3);
    expect(accept({ width: 320, height: 180 })).toBe(true);
    commit();
    expect(strong.producerId()).toBe(original.id);
    expect(original.dispose).not.toHaveBeenCalled();
    expect(weak.fatal).not.toHaveBeenCalled();
  });

  it("retains the owner of an accepted recovery frame until its write completes", async () => {
    const strong = member(), weak = member();
    await sample(4);
    const [, originalOutput] = [...producers][0];
    weak.demand.budget = 500_000;
    await sample(3);
    const [candidate] = [...producers][1];
    const select = strong.select.getMockImplementation()!;
    let complete!: () => void;
    strong.select.mockImplementationOnce((id, key, selected, accept) => select(id, key, () => {
      complete = selected;
      strong.cancelSelection.mockReturnValue(false);
    }, accept));
    originalOutput.fps = 20;
    weak.demand.budget = 2_000_000;
    await sample(2);
    expect(complete).toBeDefined();
    weak.demand.budget = 500_000;
    await sample(2);
    weak.handle.dispose();
    expect(vi.mocked(BrowserEncodingProducer.prototype.dispose).mock.contexts).not.toContain(candidate);
    complete();
    await sample(2);
    expect(strong.producerId()).toBe(candidate.id);
    expect(strong.select).toHaveBeenCalledTimes(2);
    expect(strong.fatal).not.toHaveBeenCalled();
  });

  it("starts protection at committed output, ignoring retired selection callbacks", async () => {
    const begin = vi.spyOn(BrowserEncodingProducer.prototype, "beginOutput");
    const first = member();
    let selected: (() => void) | undefined;
    first.select.mockImplementation((_id, _requestKey, commit) => { selected = commit; });
    await sample(3);
    expect(selected).toBeDefined();
    expect(begin).not.toHaveBeenCalled();
    selected!();
    expect(begin).toHaveBeenCalledOnce();

    const late = member();
    let retired: (() => void) | undefined;
    late.select.mockImplementation((_id, _requestKey, commit) => { retired = commit; });
    await sample(2);
    expect(retired).toBeDefined();
    late.handle.dispose();
    retired!();
    expect(begin).toHaveBeenCalledOnce();
  });

  it("rechecks a ready handoff after applying a falling budget, without another stats tick", async () => {
    const strong = member(), weak = member();
    await sample(4);
    const original = [...producers.keys()][0]!;
    const ready = holdNextProducerStart();
    weak.demand.budget = 500_000;
    await sample();
    const candidate = [...producers.keys()][1]!;
    let complete!: () => void;
    vi.mocked(candidate.update).mockImplementationOnce(async (_profile, budget) => {
      await new Promise<void>((resolve) => { complete = resolve; });
      producers.get(candidate)!.budget = budget;
    });
    weak.demand.budget = 100_000;
    await sample();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(candidate.update).toHaveBeenCalledWith(profile, 100_000);
    expect(weak.producerId()).toBe(original.id);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(weak.producerId()).toBe(candidate.id);
    expect(strong.producerId()).toBe(original.id);
    expect(producers.get(original)!.budget).toBe(2_000_000);
  });

  it.each(["failed", "retired"])("does not install a %s budget update's candidate", async (outcome) => {
    member();
    const weak = member();
    await sample(4);
    const ready = holdNextProducerStart();
    weak.demand.budget = 500_000;
    await sample();
    const candidate = [...producers.keys()][1]!;
    let resolve!: () => void, reject!: (error: Error) => void;
    vi.mocked(candidate.update).mockImplementationOnce(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    weak.demand.budget = 100_000;
    await sample();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    const selections = weak.select.mock.calls.length;
    if (outcome === "retired") { weak.handle.dispose(); resolve(); }
    else reject(new Error("encoder settings failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(weak.select).toHaveBeenCalledTimes(selections);
    expect(weak.fatal).not.toHaveBeenCalled();
  });
});
