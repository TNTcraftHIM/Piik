import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelConnectionReport } from "../src/client/channel/components/ChannelConnections";
import { channelConnectionGraph, channelConnectionRows } from "../src/client/channel/components/channel-connection-data";
import { channelConnectionPreview } from "../src/client/pages/ChannelConnectionsPreview";
import { collectNativeConnectionMetrics, type NativeMetricSamples } from "../src/client/channel/native-connection-metrics";
import type { NativeConnectionMetrics } from "../src/client/channel/app-link";
import { say, type CopyKey } from "../src/client/ui/copy";
import { screenAudience } from "../src/client/channel/presentation";

const t = (key: CopyKey) => key;

describe("channel connection presentation", () => {
  it("merges room audience by user without counting publishers, retired identities or relay paths", () => {
    const { state } = channelConnectionPreview("app");
    const publication = state.publications.find(value => value.kind === "screen")!;
    state.users.push({ id: "third-user", name: "Third", avatar: null });
    state.sessions.push({ id: "third", userId: "third-user", online: true, signingKey: Array(32).fill(0) });
    state.sessions.find(value => value.id === "app")!.online = false;
    publication.audience = [
      { sessionId: "self", state: "failed" }, { sessionId: "app", state: "active" },
      { sessionId: "friend", state: "failed" }, { sessionId: "third", state: "preparing" },
      { sessionId: "host", state: "active" }, { sessionId: "retired", state: "active" },
    ];
    expect(screenAudience(state, publication)).toEqual([
      { userId: "self-user", name: "Nori", state: "active" },
      { userId: "friend-user", name: "Kiki", state: "failed" },
      { userId: "third-user", name: "Third", state: "preparing" },
    ]);
    // Signaling grace leaves an established watch valid; true retirement removes that endpoint.
    state.sessions = state.sessions.filter(value => value.id !== "app");
    publication.audience.push({ sessionId: "self", state: "preparing" });
    expect(screenAudience(state, publication)[0].state).toBe("preparing");
    state.users = state.users.filter(value => value.id !== "friend-user");
    expect(screenAudience(state, publication).map(value => value.userId)).toEqual(["self-user", "third-user"]);
    publication.audience = [];
    expect(screenAudience(state, publication)).toEqual([]); // Topology alone never creates viewers.
  });

  it("keeps reading-only rooms free of peer paths and media statistics", () => {
    const fixture = channelConnectionPreview("room");
    const graph = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(graph.edges).toEqual([]);
    expect(fixture.state.pairs).toEqual([]);
    const html = renderToStaticMarkup(createElement(ChannelConnectionReport, fixture));
    expect(html).not.toContain("is-pending");
    expect(html).not.toContain("lr-connection-summary");
  });

  it("retains the real App display edge and separates endpoints sharing a user identity", () => {
    const fixture = channelConnectionPreview("app");
    const graph = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(graph.nodes.find(node => node.id === "app")).toMatchObject({ identity: "self-user", label: "Nori (App)" });
    expect(graph.nodes.find(node => node.id === "self")).toMatchObject({ identity: "self-user", label: "Nori (Web)", you: true });
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[2]).toMatchObject({ selected: false, ready: false });
    const rows = channelConnectionRows(fixture.state, fixture.sessionId, fixture.topology, fixture.metrics, t);
    expect(rows.filter(row => row.label === "connection.localDisplay")).toHaveLength(2);
    expect(rows.filter(row => row.label === "connection.localDisplay").every(row => row.detailOnly)).toBe(true);
    expect(rows.find(row => row.key.startsWith("app/screen-host-receive"))?.detailOnly).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ChannelConnectionReport, fixture))).toContain(say("connection.localDisplayHint"));
    fixture.topology.screen!.edges.find(edge => edge.presentation)!.selected = false;
    expect(renderToStaticMarkup(createElement(ChannelConnectionReport, fixture))).not.toContain(say("connection.localDisplayHint"));
  });

  it("uses the shared four groups for picture and voice in both directions", () => {
    const fixture = channelConnectionPreview("both");
    const html = renderToStaticMarkup(createElement(ChannelConnectionReport, fixture));
    expect(html.match(/class="lr-media-detail lr-connection-summary"/g)).toHaveLength(4);
    expect(html).toContain('data-media="video" data-direction="send"');
    expect(html).toContain('data-media="video" data-direction="receive"');
    expect(html).toContain('data-media="audio" data-direction="send"');
    expect(html).toContain('data-media="audio" data-direction="receive"');
    fixture.state.publications = fixture.state.publications.filter(publication => publication.kind === "voice");
    expect(channelConnectionRows(fixture.state, fixture.sessionId, fixture.topology, fixture.metrics, t)).toHaveLength(3);
  });

  it("retires Browser rows as soon as their current flow is no longer selected", () => {
    const fixture = channelConnectionPreview("both");
    fixture.state.pairs.forEach(pair => pair.incoming.forEach(flow => { flow.selected = false; }));
    const rows = channelConnectionRows(fixture.state, fixture.sessionId, fixture.topology, fixture.metrics, t);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.direction === "send")).toBe(true);
  });

  it("keeps Native source sound with the picture, once across RIDs, and excludes pending flows from totals", () => {
    const fixture = channelConnectionPreview("app");
    const video = fixture.metrics.find(sample => sample.ownerSessionId === "app" && sample.direction === "receive")!;
    const samples = [video, { ...video, metrics: { ...video.metrics, rtpStatsId: "other-rid" } },
      { ...video, media: "audio" as const, metrics: { ...video.metrics, rtpStatsId: "source-sound", audioBitrateKbps: 128, audioCodec: "audio/opus" } },
      { ...video, flowId: "pending", selected: false }];
    const rows = channelConnectionRows(fixture.state, fixture.sessionId, fixture.topology, samples, t);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.media === "video")).toBe(true);
    expect(rows.filter(row => row.metrics?.audioBitrateKbps === 128)).toHaveLength(1);
    expect(rows.find(row => row.key.includes("/pending/"))).toMatchObject({ detailOnly: true });
  });

  it("uses the SDK clock, preserves repeated samples and resets after physical connection replacement or retirement", () => {
    const previous: NativeMetricSamples = new Map();
    const report: NativeConnectionMetrics = { sessionId: "app", bindingId: "binding", connections: [{
      pairId: "pair", connectionId: "physical-1", peerId: "host", sampleTimestampMs: 1000, ageMs: 4,
      rttMs: 25, bweBps: 800_000, streams: [{ flowId: "flow", publicationId: "screen-host", selected: true,
        direction: "receive", media: "video", outputId: null, mid: "video", rid: "h", codec: "video/h264",
        sampleTimestampMs: 1000, ageMs: 4, bytes: 10_000, packets: 10, rttMs: null, lossFraction: .03, jitterMs: 2 }] }] };
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics.bitrateKbps).toBeNull();
    const stream = report.connections[0]!.streams[0]!;
    stream.sampleTimestampMs = 2000; stream.bytes = 60_000;
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics).toMatchObject({
      sampleWindowMs: 1000, bitrateKbps: 400, rttMs: 25, packetLossPercent: 3,
      availableOutgoingKbps: 800, framesPerSecond: null, resolution: null,
    });
    stream.ageMs = 500;
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics.bitrateKbps).toBe(400);
    report.connections[0]!.connectionId = "physical-2";
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics.bitrateKbps).toBeNull();
    expect(previous.size).toBe(1);
    report.connections = [];
    expect(collectNativeConnectionMetrics(report, previous)).toEqual([]);
    expect(previous.size).toBe(0);
  });

  it("starts a fresh egress baseline when the same flow reuses its MID with a new output", () => {
    const previous: NativeMetricSamples = new Map();
    const report: NativeConnectionMetrics = { sessionId: "app", bindingId: "binding", connections: [{
      pairId: "pair", connectionId: "physical", peerId: "host", sampleTimestampMs: 1000, ageMs: 4,
      rttMs: null, bweBps: null, streams: [{ flowId: "flow", publicationId: "screen-host", selected: true,
        direction: "send", media: "audio", outputId: "first-output", mid: "sound", rid: null, codec: "audio/opus",
        sampleTimestampMs: 1000, ageMs: 4, bytes: 1000, packets: 10, rttMs: null, lossFraction: null, jitterMs: null }] }] };
    const stream = report.connections[0]!.streams[0]!;
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics.bitrateKbps).toBeNull();
    stream.outputId = "next-output";
    stream.sampleTimestampMs = 2000; stream.bytes = 2000;
    // The retired interval need not coincide with a UI poll; larger new counters still reset.
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics).toMatchObject({
      sampleWindowMs: null, bitrateKbps: null, packetLossPercent: null, availableOutgoingKbps: null,
    });
    stream.sampleTimestampMs = 3000; stream.bytes = 3000;
    expect(collectNativeConnectionMetrics(report, previous)[0]!.metrics.bitrateKbps).toBe(8);
    expect(previous.size).toBe(1);
  });
});
