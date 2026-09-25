import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserEncodingPool } from "../src/client/media/browser-encoding-pool";
import { BrowserEncodingProducer } from "../src/client/media/browser-encoding-producer";
import type { BrowserEncodingOutput } from "../src/client/media/browser-encoding-output";
import { QUALITY_PROFILES } from "../src/client/media/quality";

const codec = { mimeType: "video/VP8", clockRate: 90_000 };
const profile = QUALITY_PROFILES["1080p30"];
const source = { kind: "video", readyState: "live", enabled: true, id: "source" } as MediaStreamTrack;
const producers = new Map<BrowserEncodingProducer, { budget: number; bitrate: number; bytes: number; frames: number }>();
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
  const select = vi.fn((id: string, _requestKey: () => Promise<void>, selected: () => void) => {
    producerId = id;
    selected();
  });
  const encoded = {
    select, push: vi.fn(), passthrough: vi.fn(), setPaused: vi.fn(),
    snapshot: () => ({ frames: producerId ? 30 : 0, width: 1920, height: 1080, timestamp: Date.now(), lastProducerId: producerId }),
  } as unknown as BrowserEncodingOutput;
  const connection = { connectionState: "connected", getStats: async () => stats({ targetBitrate: demand.budget }) };
  const fatal = vi.fn();
  const handle = pool.create(source, {} as RTCRtpSender, connection as RTCPeerConnection, profile,
    encoded, async () => true, async () => undefined, fatal)!;
  return { demand, select, fatal, handle, producerId: () => producerId };
}

async function sample(count = 1) {
  await vi.advanceTimersByTimeAsync(500 * count);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [codec] }) });
  producers.clear();
  vi.spyOn(BrowserEncodingProducer.prototype, "start").mockImplementation(async function (this: BrowserEncodingProducer, budget) {
    producers.set(this, { budget: budget!, bitrate: budget! / 2, bytes: 0, frames: 0 });
  });
  vi.spyOn(BrowserEncodingProducer.prototype, "report").mockImplementation(async function (this: BrowserEncodingProducer) {
    const output = producers.get(this)!;
    output.bytes += output.bitrate / 16;
    output.frames += 15;
    return stats({ bytesSent: output.bytes, framesEncoded: output.frames, frameWidth: 1920, frameHeight: 1080,
      qualityLimitationReason: "none" });
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
});
