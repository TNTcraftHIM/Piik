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
