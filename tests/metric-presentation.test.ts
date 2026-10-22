import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { MetricCells } from "../src/client/components/living/Metrics";
import { ViewerOverview } from "../src/client/components/living/ViewerOverview";
import { EMPTY_METRICS } from "../src/client/types";
import { setCopy, t } from "../src/client/ui/copy";
import { STATUS_CATALOG } from "../src/client/ui/media-status";
import type { RoomVoiceSnapshot } from "../src/client/room-voice/session";
import { VoiceConnectionDetails } from "../src/client/room-voice/VoiceConnectionDetails";

beforeEach(() => setCopy({ lang: "en", vis: false }));

describe("observed metric presentation", () => {
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
    const details = renderToStaticMarkup(createElement(VoiceConnectionDetails, { voice }));
    expect(details).toContain("96 kbps");
    expect(details).not.toContain(t("en", "stats.fps"));
    expect(renderToStaticMarkup(createElement(VoiceConnectionDetails, { voice: null }))).toBe("");
    voice.room!.members[0]!.joined = false;
    expect(renderToStaticMarkup(createElement(VoiceConnectionDetails, { voice }))).toBe("");
  });
});
