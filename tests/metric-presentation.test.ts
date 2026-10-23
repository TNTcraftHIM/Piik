import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { MetricCells } from "../src/client/components/living/Metrics";
import { ViewerOverview } from "../src/client/components/living/ViewerOverview";
import { EMPTY_METRICS } from "../src/client/types";
import { setCopy, t } from "../src/client/ui/copy";
import { STATUS_CATALOG } from "../src/client/ui/media-status";
import type { RoomVoiceSnapshot } from "../src/client/room-voice/session";
import { voiceConnectionDetails } from "../src/client/room-voice/VoiceConnectionDetails";
import { ConnectionDetails } from "../src/client/components/living/ConnectionDetails";
import type { VoiceConnectionMetric } from "../src/client/room-voice/browser-endpoint";
import { summarizeConnectionMetrics } from "../src/client/components/connection-details";

beforeEach(() => setCopy({ lang: "en", vis: false }));

describe("observed metric presentation", () => {
  it("totals traffic, weights received loss and counts each RTT connection once", () => {
    const samples = [
      { connectionId: "peer", metrics: { ...EMPTY_METRICS, bitrateKbps: 64, rttMs: 20, jitterMs: 2,
        intervalPacketsReceived: 90, intervalPacketsLost: 10, packetLossPercent: 10, resolution: "1920x1080", framesPerSecond: 60 } },
      { connectionId: "peer", metrics: { ...EMPTY_METRICS, bitrateKbps: 32, rttMs: 20, jitterMs: 4,
        intervalPacketsReceived: 10, intervalPacketsLost: 0, packetLossPercent: 0, resolution: "1280x720", framesPerSecond: 30 } },
      { connectionId: "sfu", metrics: { ...EMPTY_METRICS, bitrateKbps: 16, rttMs: 80, jitterMs: 6,
        intervalPacketsReceived: 900, intervalPacketsLost: 0, packetLossPercent: 0, resolution: "1920x1080", framesPerSecond: 60 } },
    ];
    const received = summarizeConnectionMetrics(samples, "receive");
    expect(received).toMatchObject({ bitrateKbps: 112, rttMs: 50, jitterMs: 4,
      resolution: ["1280x720", "1920x1080"], framesPerSecond: [30, 60] });
    expect(received.packetLossPercent).toBeCloseTo(100 * 10 / 1010);
    expect(summarizeConnectionMetrics(samples, "send").packetLossPercent).toBeCloseTo(10 / 3);
    expect(summarizeConnectionMetrics(samples.slice(2), "receive")).toMatchObject({ bitrateKbps: 16, rttMs: 80, packetLossPercent: 0 });
    expect(summarizeConnectionMetrics([], "receive")).toMatchObject({ bitrateKbps: null, rttMs: null, packetLossPercent: null });
  });

  it("keeps many physical streams within four overview categories and one detail expansion", () => {
    const rows = (["video", "audio"] as const).flatMap(media => (["receive", "send"] as const).flatMap(direction =>
      [0, 1, 2].map(index => ({ key: `${media}/${direction}/${index}`, connectionId: `peer-${index}`, media, direction,
        label: `Raw stream ${index}`, route: "p2p" as const,
        metrics: { ...EMPTY_METRICS, bitrateKbps: 64, intervalPacketsReceived: 100, intervalPacketsLost: 0 },
      }))));
    const html = renderToStaticMarkup(createElement(ConnectionDetails, { rows: [...rows,
      { key: "remote-report", media: "video", direction: "receive", label: "Remote report", detailOnly: true,
        metrics: { ...EMPTY_METRICS, bitrateKbps: 999999 } },
    ] }));
    expect(html.match(/class="lr-media-detail lr-connection-summary"/g)).toHaveLength(4);
    expect(html.match(/class="lr-btn lr-metrics-more/g)).toHaveLength(1);
    expect(html).toContain("192 kbps");
    expect(html).not.toContain("Raw stream");
    expect(html).not.toContain("999999");
  });

  it("reports dropped frames from the current sampling interval, not the connection lifetime", () => {
    const render = (intervalFramesDropped: number | null) => renderToStaticMarkup(createElement(MetricCells, {
      metrics: { ...EMPTY_METRICS, framesDropped: 300, intervalFramesDropped },
      direction: "receive", expanded: true, onToggle() {},
    }));
    expect(render(2)).toContain(`${t("en", "stats.dropped")} · 2 `);
    expect(render(0)).toContain(`${t("en", "stats.dropped")} · 0 `);
    expect(render(null)).not.toContain(t("en", "stats.dropped"));
    expect(render(2)).not.toContain(`${t("en", "stats.dropped")} · 300`);
  });

  it("keeps an unrecognized sender reason distinct from no limitation", () => {
    const render = (qualityLimitationReason: string) => renderToStaticMarkup(createElement(MetricCells, {
      metrics: { ...EMPTY_METRICS, qualityLimitationReason },
      direction: "send", expanded: true, onToggle() {},
    }));
    expect(render("none")).toContain(t("en", "stats.quality.normal"));
    expect(render("future-limit")).toContain(t("en", "stats.quality.unclassified"));
    expect(render("future-limit")).not.toContain(t("en", "stats.quality.normal"));
  });

  it("retains overview units in visual mode without inventing values for missing samples", () => {
    setCopy({ vis: true });
    const html = renderToStaticMarkup(createElement(ViewerOverview, {
      pictureActive: true,
      entries: [
        { key: "measured", name: "Friend", status: STATUS_CATALOG.connected, route: "p2p",
          metrics: { ...EMPTY_METRICS, framesPerSecond: 59.8, bitrateKbps: 7200, rttMs: 24 } },
        { key: "unknown", name: "Joining", status: STATUS_CATALOG.joining, route: null, metrics: null },
      ],
      selectedKey: null, onSelect() {},
    }));
    expect(html).toContain("59.8 fps");
    expect(html).toContain("7200 kbps");
    expect(html).toContain("24 ms");
    expect(html).not.toContain("— fps");
    expect(html).not.toContain("— kbps");
  });

  it("selects overview columns and details from the media actually in use", () => {
    const voice: RoomVoiceSnapshot = {
      peerId: "friend", role: "viewer", connected: true,
      room: { type: "room-voice-state", revision: 1, enabled: true, hostPeerId: "host", bitrate: 96_000,
        members: [{ peerId: "friend", connected: true, joined: true, upstream: { kind: "peer", peerId: "host" } }],
        publications: [], connections: [], unavailable: [] },
      capturePending: false, microphone: false, deafened: false, autoplayBlocked: false, muted: new Set(), error: null,
      input: { deviceId: "", volume: 1, voiceProcessing: true }, listeningVolume: 1, peerVolumes: new Map(),
    };
    for (const pictureActive of [false, true]) for (const voiceActive of [false, true]) {
      const snapshot = voiceActive ? voice : null;
      const html = renderToStaticMarkup(createElement(ViewerOverview, {
        pictureActive, voice: snapshot,
        entries: [{ key: "friend", name: "Friend", status: STATUS_CATALOG.present, route: "p2p", metrics: null }],
        selectedKey: null, onSelect() {},
      }));
      expect(html.includes(t("en", "stats.fps"))).toBe(pictureActive);
      expect(html.includes(t("en", "stats.resolution"))).toBe(pictureActive);
      expect(html.includes(t("en", "voice.details.title"))).toBe(voiceActive);
    }
    const metrics: VoiceConnectionMetric[] = [{ connectionId: "voice", peerId: "friend", viaPeerId: "host", direction: "send", route: "p2p",
      metrics: { ...EMPTY_METRICS, bitrateKbps: 82, packetLossPercent: .5, jitterMs: 2, rttMs: 48, audioCodec: "audio/opus" } }];
    const voiceRows = (snapshot: RoomVoiceSnapshot | null, samples: readonly VoiceConnectionMetric[] = []) =>
      voiceConnectionDetails({ voice: snapshot, metrics: samples, t: (key, vars) => t("en", key, vars),
        peerName: id => id === "host" ? "Host" : "Friend" });
    const renderVoice = (snapshot: RoomVoiceSnapshot | null, samples: readonly VoiceConnectionMetric[] = []) =>
      renderToStaticMarkup(createElement(ConnectionDetails, { rows: voiceRows(snapshot, samples) }));
    const details = renderVoice(voice, metrics);
    const combined = renderToStaticMarkup(createElement(ConnectionDetails, {
      rows: [{ key: "picture", media: "video", label: "Picture", direction: "receive", route: "sfu",
        metrics: { ...EMPTY_METRICS, resolution: "1920x1080", codec: "video/H264" } }, ...voiceRows(voice, metrics)],
    }));
    expect(combined).toContain("1920x1080");
    expect(combined).toContain("82 kbps");
    expect(combined.match(/class="lr-btn lr-metrics-more/g)).toHaveLength(1);
    expect(details).toContain("82 kbps");
    expect(details).toContain("48 ms");
    expect(details).toContain("0.5%");
    expect(details).not.toContain("96 kbps");
    expect(details).not.toContain(t("en", "stats.warn.codec", { codec: "opus" }));
    expect(details).not.toContain(t("en", "stats.fps"));
    const receiveOnly = [{ connectionId: "relay", peerId: "other-viewer", viaPeerId: "host", direction: "receive" as const, route: "p2p" as const,
      metrics: { ...EMPTY_METRICS, bitrateKbps: 64, rttMs: 28 } }];
    const received = renderVoice(voice, receiveOnly);
    expect(received).toContain("64 kbps");
    expect(received).toContain(t("en", "stats.voiceReceive"));
    expect(voiceRows(voice, receiveOnly)[0]!.label).toBe(t("en", "voice.details.receiveFrom", { name: "Friend" }));
    expect(received).toContain(t("en", "voice.details.via", { name: "Host" }));
    voice.error = "transport";
    expect(renderVoice(voice)).toContain(t("en", "voice.details.unavailable"));
    expect(renderVoice(null)).toBe("");
    voice.room!.members[0]!.joined = false;
    expect(renderVoice(voice)).toBe("");
  });
});
