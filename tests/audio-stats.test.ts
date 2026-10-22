import { describe, expect, it } from "vitest";

import {
  collectConnectionMetricsFromReport,
  createStatsAccumulator,
} from "../src/client/webrtc/stats.ts";

function outboundReport(
  timestamp: number,
  audioABytes: number,
  audioBBytes: number,
): RTCStatsReport {
  const record = (
    id: string,
    type: string,
    values: Record<string, unknown>,
  ): [string, Record<string, unknown>] => [
    id,
    { id, type, timestamp, ...values },
  ];
  return new Map<string, Record<string, unknown>>([
    record("transport", "transport", {}),
    record("video-out", "outbound-rtp", {
      kind: "video",
      transportId: "transport",
      mediaSourceId: "video-source",
      bytesSent: timestamp * 10,
      framesEncoded: timestamp / 20,
    }),
    record("video-source", "media-source", {
      kind: "video",
      trackIdentifier: "video-current",
    }),
    record("audio-a-out", "outbound-rtp", {
      kind: "audio",
      ssrc: 101,
      transportId: "transport",
      mediaSourceId: "audio-a-source",
      codecId: "audio-a-codec",
      bytesSent: audioABytes,
    }),
    record("audio-a-source", "media-source", {
      kind: "audio",
      trackIdentifier: "audio-a",
    }),
    record("audio-a-codec", "codec", {
      transportId: "transport",
      mimeType: "audio/opus",
      sdpFmtpLine: "stereo=1",
    }),
    record("audio-b-out", "outbound-rtp", {
      kind: "audio",
      ssrc: 202,
      transportId: "transport",
      mediaSourceId: "audio-b-source",
      codecId: "audio-b-codec",
      bytesSent: audioBBytes,
    }),
    record("audio-b-source", "media-source", {
      kind: "audio",
      trackIdentifier: "audio-b",
    }),
    record("audio-b-codec", "codec", {
      transportId: "transport",
      mimeType: "audio/opus",
      sdpFmtpLine: "stereo=0",
    }),
  ]) as unknown as RTCStatsReport;
}

describe("audio stats selection", () => {
  it("uses audio-only RTP identity, interval loss and transport RTT in both directions", () => {
    for (const direction of ["send", "receive"] as const) {
      const previous = createStatsAccumulator();
      const sample = (timestamp: number, identity = "first", candidatePair = true) => {
        const record = (id: string, type: string, values: Record<string, unknown>) =>
          [id, { id, type, timestamp, ...values }] as const;
        const report = new Map([
          record("transport", "transport", candidatePair ? { selectedCandidatePairId: "pair" } : {}),
          record("pair", "candidate-pair", { transportId: "transport", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.04 }),
          record("local", "local-candidate", { candidateType: "host" }),
          record("remote", "remote-candidate", { candidateType: "srflx" }),
          record("codec", "codec", { transportId: "transport", mimeType: "audio/opus", clockRate: 48_000, channels: 1 }),
          record("source", "media-source", { kind: "audio", trackIdentifier: identity }),
          record("audio", direction === "send" ? "outbound-rtp" : "inbound-rtp", {
            kind: "audio", ssrc: identity === "first" ? 1 : 2, trackIdentifier: identity, mediaSourceId: "source",
            remoteId: "feedback", transportId: "transport", codecId: "codec", jitter: 0.003,
            bytesSent: timestamp * 4, bytesReceived: timestamp * 4,
            packetsReceived: timestamp / 20, packetsLost: timestamp / 1_000,
          }),
          record("feedback", "remote-inbound-rtp", { kind: "audio", fractionLost: 0.125, roundTripTime: 0.06, jitter: 0.005 }),
          record("unrelated", direction === "send" ? "outbound-rtp" : "inbound-rtp", {
            kind: "audio", trackIdentifier: "other", mediaSourceId: "other-source", bytesSent: timestamp * 100, bytesReceived: timestamp * 100,
          }),
          record("other-source", "media-source", { kind: "audio", trackIdentifier: "other" }),
        ]) as unknown as RTCStatsReport;
        return collectConnectionMetricsFromReport(report, direction, previous,
          { kind: "audio", trackIdentifier: identity, audioTrackIdentifier: identity });
      };
      expect(sample(1_000)).toMatchObject({ bitrateKbps: null, packetLossPercent: null, rttMs: 40, sampleTimestampMs: 1_000, sampleWindowMs: null });
      const measured = sample(2_000);
      expect(measured).toMatchObject({ bitrateKbps: 32, audioBitrateKbps: 32, audioCodec: "audio/opus", rttMs: 40, sampleWindowMs: 1_000,
        jitterMs: direction === "send" ? 5 : 3 });
      expect(measured.packetLossPercent).toBeCloseTo(direction === "send" ? 12.5 : 100 / 51);
      // A source replacement resets deltas even if the RTP stats ID is reused.
      expect(sample(3_000, "replacement", false)).toMatchObject({ bitrateKbps: null, packetLossPercent: null, sampleWindowMs: null,
        rttMs: direction === "send" ? 60 : null });
      expect(sample(4_000, "replacement")).toMatchObject({ bitrateKbps: 32, sampleWindowMs: 1_000 });
    }
  });

  it("binds exact audio tracks and resets the baseline across identity and absence", () => {
    const accumulator = createStatsAccumulator();
    const sample = (
      timestamp: number,
      audioABytes: number,
      audioBBytes: number,
      audioTrackIdentifier: string | null,
    ) =>
      collectConnectionMetricsFromReport(
        outboundReport(timestamp, audioABytes, audioBBytes),
        "send",
        accumulator,
        { trackIdentifier: "video-current", audioTrackIdentifier },
      );

    expect(sample(1_000, 10_000, 100_000, "audio-a")).toMatchObject({
      audioBitrateKbps: null,
      audioCodecParameters: "stereo=1",
    });
    expect(sample(3_000, 50_000, 300_000, "audio-a")).toMatchObject({
      audioBitrateKbps: 160,
      audioCodecParameters: "stereo=1",
    });
    expect(sample(5_000, 90_000, 340_000, "audio-b")).toMatchObject({
      audioBitrateKbps: null,
      audioCodecParameters: "stereo=0",
    });
    expect(sample(7_000, 130_000, 380_000, "audio-b")).toMatchObject({
      audioBitrateKbps: 160,
      audioCodecParameters: "stereo=0",
    });
    expect(sample(9_000, 170_000, 420_000, null)).toMatchObject({
      audioBitrateKbps: null,
      audioCodec: null,
      audioCodecParameters: null,
    });
    expect(sample(11_000, 210_000, 460_000, "audio-b")).toMatchObject({
      audioBitrateKbps: null,
      audioCodecParameters: "stereo=0",
    });
  });
});
