import { afterEach, describe, expect, it, vi } from "vitest";

import {
  h264ProbeTarget,
  h264ProbeSustainsTarget,
  preferredVideoCodecForTrack,
  type H264ProbeSample,
} from "../src/client/webrtc/video-codec-preflight.ts";
import { QUALITY_PROFILES } from "../src/client/media/quality.ts";

function sample(
  overrides: Partial<H264ProbeSample> = {},
): H264ProbeSample {
  return {
    outboundId: "outbound",
    sourceId: "source",
    timestamp: 1_000,
    codec: "video/H264",
    framesEncoded: 10,
    sourceFrames: 10,
    encodedFramesPerSecond: 30,
    sourceFramesPerSecond: 30,
    qualityLimitationReason: "none",
    ...overrides,
  };
}

describe("H264 sender preflight", () => {
  it("uses the selected target cadence instead of captured-content cadence", () => {
    expect(
      h264ProbeTarget(
        { width: 2_560, height: 1_440, frameRate: 1 },
        QUALITY_PROFILES["1080p30"],
      ),
    ).toEqual({ width: 1_920, height: 1_080, frameRate: 30 });
  });

  it("accepts bounded pipeline lag against the same source", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 2_000,
      framesEncoded: 39,
      sourceFrames: 40,
    });

    expect(h264ProbeSustainsTarget(baseline, current, 30)).toBe(true);
  });

  it("rejects sustained encoder frame dropping", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 2_000,
      framesEncoded: 22,
      sourceFrames: 40,
      encodedFramesPerSecond: 12,
      sourceFramesPerSecond: 30,
    });

    expect(h264ProbeSustainsTarget(baseline, current, 30)).toBe(false);
  });

  it("waits for enough source progress before deciding", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 1_400,
      framesEncoded: 20,
      sourceFrames: 20,
    });

    expect(h264ProbeSustainsTarget(baseline, current, 30)).toBeNull();
  });

  it("rejects CPU-limited or identity-mismatched samples", () => {
    const baseline = sample();

    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: 40,
          sourceFrames: 40,
          qualityLimitationReason: "cpu",
        }),
        30,
      ),
    ).toBe(false);
    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          outboundId: "replacement",
          timestamp: 2_000,
          framesEncoded: 40,
          sourceFrames: 40,
        }),
        30,
      ),
    ).toBe(false);
  });

  it("uses reported cadence when cumulative source frames are unavailable", () => {
    const baseline = sample({ framesEncoded: null, sourceFrames: null });

    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 29,
          sourceFramesPerSecond: 30,
        }),
        30,
      ),
    ).toBe(true);
    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 12,
          sourceFramesPerSecond: 30,
        }),
        30,
      ),
    ).toBe(false);
    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 1_500,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 30,
          sourceFramesPerSecond: 30,
        }),
        30,
      ),
    ).toBeNull();
  });

  it("rejects a probe source that does not reach the selected cadence", () => {
    expect(
      h264ProbeSustainsTarget(
        sample(),
        sample({
          timestamp: 2_000,
          framesEncoded: 30,
          sourceFrames: 30,
          encodedFramesPerSecond: 20,
          sourceFramesPerSecond: 20,
        }),
        30,
      ),
    ).toBe(false);
  });
});

describe("codec probe lifetime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function fixture(blocked = "", failReceiver = false) {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    let resolve!: () => void;
    const pending = { promise: new Promise<void>((ready) => { resolve = ready; }), resolve: () => resolve() };
    const wait = (stage: string) => blocked === stage ? pending.promise : Promise.resolve();
    const source = { kind: "video", readyState: "live", getSettings: () => ({}), stop: vi.fn() };
    const track = { ...source, stop: vi.fn() };
    const createElement = vi.fn(() => ({
      getContext: () => ({ fillRect() {} }),
      captureStream: () => ({ getVideoTracks: () => [track] }),
    }));
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264", clockRate: 90_000 }] }),
    });
    const connections: Connection[] = [];
    class Connection {
      constructor() {
        if (failReceiver && connections.length === 1) throw new Error("no receiver");
        connections.push(this);
      }
      close = vi.fn();
      addEventListener() {}
      localDescription = { type: "offer", sdp: "fixture" };
      setLocalDescription = vi.fn(async () => {});
      async setRemoteDescription() {}
      async createOffer() { await wait("offer"); return this.localDescription; }
      async createAnswer() { return { type: "answer", sdp: "fixture" }; }
      addTransceiver() {
        return {
          setCodecPreferences() {},
          sender: {
            track,
            getParameters: () => ({ encodings: [{}] }),
            setParameters: () => wait("configure"),
            getStats: async () => {
              await wait("stats");
              const timestamp = Date.now();
              const frames = timestamp * 30 / 1_000;
              return new Map([
                ["out", { id: "out", type: "outbound-rtp", kind: "video", timestamp,
                  codecId: "codec", mediaSourceId: "source", framesEncoded: frames }],
                ["codec", { type: "codec", mimeType: "video/H264" }],
                ["source", { id: "source", type: "media-source", frames }],
              ]);
            },
          },
        };
      }
    }
    vi.stubGlobal("RTCPeerConnection", Connection);
    return {
      source: source as unknown as MediaStreamTrack,
      track, connections, createElement, pending,
    };
  }

  it.each(["configure", "offer", "stats"])("bounds a pending %s operation and cleans up", async (stage) => {
    const f = fixture(stage);
    let result: string | undefined;
    const run = preferredVideoCodecForTrack(f.source, QUALITY_PROFILES["1080p30"])
      .then((codec) => { result = codec; });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe("vp8");
    await run;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(f.connections.every((connection) => connection.close.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    f.pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (stage !== "stats") expect(f.connections[0]!.setLocalDescription).not.toHaveBeenCalled();
  });

  it("cancels pending SDP without waiting for the browser promise", async () => {
    const f = fixture("offer");
    const controller = new AbortController();
    let result: string | undefined;
    const run = preferredVideoCodecForTrack(f.source, QUALITY_PROFILES["1080p30"], controller.signal)
      .then((codec) => { result = codec; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe("vp8");
    await run;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.connections[0]!.setLocalDescription).not.toHaveBeenCalled();
  });

  it("does not allocate an already-cancelled probe", async () => {
    const f = fixture();
    await expect(preferredVideoCodecForTrack(f.source, QUALITY_PROFILES["1080p30"], AbortSignal.abort()))
      .resolves.toBe("vp8");
    expect(f.createElement).not.toHaveBeenCalled();
    expect(f.connections).toHaveLength(0);
  });

  it("closes the sender if receiver construction fails", async () => {
    const f = fixture("", true);
    await expect(preferredVideoCodecForTrack(f.source, QUALITY_PROFILES["1080p30"]))
      .resolves.toBe("vp8");
    expect(f.connections[0]!.close).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a proved H264 result and retires the budget", async () => {
    const f = fixture();
    const run = preferredVideoCodecForTrack(f.source, QUALITY_PROFILES["1080p30"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).resolves.toBe("h264");
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
