import { describe, expect, it, vi } from "vitest";

import {
  CodecProofReporter,
  type CodecProofRouteSample,
} from "../src/client/media/codec-proof.ts";
import { EMPTY_METRICS } from "../src/client/types.ts";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol.ts";

const request = {
  type: "video-codec-proof-request",
  shareGeneration: "share_generation_12345678",
  generation: 1,
  resumeAttempt: 3,
  routeRevision: 7,
  expectedCodec: "vp8",
  binding: { kind: "peer", connectionId: "connection_12345678" },
} satisfies Extract<ServerMessage, { type: "video-codec-proof-request" }>;

function sample(
  timestamp: number,
  framesDecodedDelta: number | null,
  rtpStatsId = "inbound_video_12345678",
): CodecProofRouteSample {
  return {
    routeRevision: 7,
    binding: { kind: "peer", connectionId: "connection_12345678" },
    metrics: {
      ...EMPTY_METRICS,
      sampleTimestampMs: timestamp,
      rtpStatsId,
      rtpSsrc: 42,
      rtpMid: "0",
      trackIdentifier: "track_12345678",
      intervalFramesDecoded: framesDecodedDelta,
      codec: "video/VP8",
    },
  };
}

describe("CodecProofReporter", () => {
  it("proves only a later decoded sample on the exact frozen binding", () => {
    const sent: ClientMessage[] = [];
    const reporter = new CodecProofReporter((message) => {
      sent.push(message);
      return true;
    });

    expect(reporter.request(request)).toBe(true);
    reporter.offer(sample(100, 1));
    reporter.offer(sample(200, 0));
    expect(sent).toEqual([]);
    reporter.offer(sample(300, 5));

    expect(sent).toEqual([
      expect.objectContaining({
        type: "video-codec-proof",
        generation: 1,
        resumeAttempt: 3,
        routeRevision: 7,
        evidence: expect.objectContaining({
          baselineSampleTimestampMs: 100,
          sampleTimestampMs: 300,
          framesDecodedDelta: 5,
          actualCodec: "vp8",
        }),
      }),
    ]);
  });

  it("re-baselines when the inbound RTP stats object changes", () => {
    const send = vi.fn((_message: ClientMessage) => true);
    const reporter = new CodecProofReporter(send);
    reporter.request(request);

    reporter.offer(sample(100, 0, "old_inbound_12345678"));
    reporter.offer(sample(200, 1, "new_inbound_12345678"));
    expect(send).not.toHaveBeenCalled();
    reporter.offer(sample(300, 2, "new_inbound_12345678"));
    expect(send).toHaveBeenCalledOnce();
  });

  it("retains a request until an exact-route baseline becomes available", () => {
    const send = vi.fn(() => true);
    const reporter = new CodecProofReporter(send);
    expect(reporter.request(request)).toBe(true);
    reporter.offer({ ...sample(150, 1), routeRevision: 8 });
    expect(send).not.toHaveBeenCalled();
    reporter.offer(sample(200, 0));
    reporter.offer(sample(300, 2));
    expect(send).toHaveBeenCalledOnce();
  });

  it("ignores out-of-order samples without replacing the current baseline", () => {
    const send = vi.fn((_message: ClientMessage) => true);
    const reporter = new CodecProofReporter(send);
    reporter.request(request);

    reporter.offer(sample(200, 0));
    reporter.offer(sample(100, 1, "older_inbound_12345678"));
    reporter.offer(sample(300, 2));

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "video-codec-proof",
      evidence: {
        baselineSampleTimestampMs: 200,
        sampleTimestampMs: 300,
      },
    });
  });

  it("uses the first exact sample after the proof request only as a baseline", () => {
    const send = vi.fn((_message: ClientMessage) => true);
    const reporter = new CodecProofReporter(send);

    reporter.request(request);
    reporter.offer(sample(200, 1));
    reporter.offer(sample(300, 0));
    expect(send).not.toHaveBeenCalled();

    reporter.offer(sample(400, 2));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: "video-codec-proof",
      resumeAttempt: 3,
      evidence: {
        baselineSampleTimestampMs: 200,
        sampleTimestampMs: 400,
        framesDecodedDelta: 2,
      },
    });
  });
});
