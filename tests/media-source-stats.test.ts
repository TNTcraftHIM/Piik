import { describe, expect, it } from "vitest";
import {
  collectConnectionMetricsFromReport,
  collectNativeSenderQualityFromReport,
  createNativeSenderQualityAccumulator,
  createStatsAccumulator,
  maxEncodedVideoFrames,
  mediaSourceRecord,
} from "../src/client/webrtc/stats.ts";

function report(timestamp = 1_000, trackIdentifier = "video-track") {
  const records = [
    { id: "video", type: "outbound-rtp", kind: "video", bytesSent: timestamp * 100,
      framesEncoded: timestamp * 30 / 1_000, frameWidth: 1280, frameHeight: 720 },
    { id: "video-source", type: "media-source", kind: "video", trackIdentifier,
      framesPerSecond: 30 },
    { id: "audio", type: "outbound-rtp", kind: "audio", bytesSent: timestamp * 16 },
    { id: "audio-source", type: "media-source", kind: "audio", trackIdentifier: "audio-track" },
    { id: "received", type: "inbound-rtp", kind: "video" },
    { id: "remote", type: "remote-outbound-rtp", kind: "video" },
  ];
  return new Map(records.map((record) => [record.id, { ...record, timestamp }])) as unknown as RTCStatsReport;
}

describe("sender source statistics", () => {
  it("reads the sole same-kind source without mediaSourceId and resets on replacement", () => {
    const previous = createStatsAccumulator();
    const sample = (timestamp: number, trackIdentifier = "video-track") =>
      collectConnectionMetricsFromReport(report(timestamp, trackIdentifier), "send", previous,
        { trackIdentifier, audioTrackIdentifier: "audio-track" });

    expect(sample(1_000)).toMatchObject({
      trackIdentifier: "video-track", mediaSourceFramesPerSecond: 30,
      resolution: "1280x720", intervalFramesEncoded: null, audioBitrateKbps: null,
    });
    expect(sample(2_000)).toMatchObject({
      intervalFramesEncoded: 30, bitrateKbps: 800, audioBitrateKbps: 128,
    });
    expect(sample(3_000, "replacement")).toMatchObject({
      trackIdentifier: "replacement", intervalFramesEncoded: null, bitrateKbps: null,
    });
    expect(maxEncodedVideoFrames(report(3_000, "replacement"), "video-track")).toBeNull();
    expect(maxEncodedVideoFrames(report(3_000, "replacement"), "replacement")).toBe(90);

    const quality = createNativeSenderQualityAccumulator();
    collectNativeSenderQualityFromReport(report(1_000), "video-track", quality);
    expect(collectNativeSenderQualityFromReport(report(2_000), "video-track", quality))
      .toMatchObject({ bitrateKbps: 800, nativeEdgeQualityState: "unknown" });
  });

  it.each(["media-source", "outbound-rtp"])("does not infer a source with another %s of the same kind", (type) => {
    const stats = report();
    (stats as unknown as Map<string, unknown>).set("old", {
      id: "old", type, kind: "video", timestamp: 1_000, trackIdentifier: "old-track",
    });
    expect(mediaSourceRecord(stats, stats.get("video"))).toBeNull();
    expect(maxEncodedVideoFrames(stats, "video-track")).toBeNull();
    stats.get("video").mediaSourceId = "video-source";
    expect(maxEncodedVideoFrames(stats, "video-track")).toBe(30);
  });

  it.each(["missing", "received", null, ""])("does not replace an invalid explicit reference (%s)", (mediaSourceId) => {
    const stats = report();
    stats.get("video").mediaSourceId = mediaSourceId;
    expect(mediaSourceRecord(stats, stats.get("video"))).toBeNull();
  });
});
