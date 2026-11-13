import { describe, expect, it } from "vitest";
import {
  collectConnectionMetricsFromReport,
  collectTrackConnectionMetrics,
  createStatsAccumulator,
  maxEncodedVideoFrames,
  mediaSourceRecord,
  type StatsAccumulator,
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
  it("keeps a publication's RTP layers and source sound separate from other media on the same PC", () => {
    const previous = new Map<string, StatsAccumulator>();
    const sample = (timestamp: number, high = true) => {
      const records = [
        { id: "source", type: "media-source", kind: "video", trackIdentifier: "screen" },
        { id: "other-source", type: "media-source", kind: "video", trackIdentifier: "other" },
        { id: "sound-source", type: "media-source", kind: "audio", trackIdentifier: "sound" },
        { id: "voice-source", type: "media-source", kind: "audio", trackIdentifier: "voice" },
        { id: "q", type: "outbound-rtp", kind: "video", mediaSourceId: "source", rid: "q", bytesSent: timestamp * 10, framesEncoded: timestamp / 100 },
        ...(high ? [{ id: "h", type: "outbound-rtp", kind: "video", mediaSourceId: "source", rid: "h", bytesSent: timestamp * 30, framesEncoded: timestamp / 100 }] : []),
        { id: "other", type: "outbound-rtp", kind: "video", mediaSourceId: "other-source", bytesSent: timestamp * 1000 },
        { id: "sound", type: "outbound-rtp", kind: "audio", mediaSourceId: "sound-source", bytesSent: timestamp * 16 },
        { id: "voice", type: "outbound-rtp", kind: "audio", mediaSourceId: "voice-source", bytesSent: timestamp * 6 },
      ];
      const report = new Map(records.map(record => [record.id, { ...record, timestamp }])) as unknown as RTCStatsReport;
      return collectTrackConnectionMetrics(report, "send", previous, { trackIdentifier: "screen", audioTrackIdentifier: "sound" });
    };
    expect(sample(1000)).toMatchObject([{ rtpStatsId: "q", rtpRid: "q" }, { rtpStatsId: "h", rtpRid: "h" }]);
    expect(sample(2000)).toMatchObject([
      { bitrateKbps: 80, intervalFramesEncoded: 10, audioBitrateKbps: 128 },
      { bitrateKbps: 240, intervalFramesEncoded: 10, audioBitrateKbps: null },
    ]);
    expect(sample(3000, false)).toMatchObject([{ rtpStatsId: "q", bitrateKbps: 80, audioBitrateKbps: 128 }]);
    expect([...previous.keys()]).toEqual(["q"]);
  });
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
