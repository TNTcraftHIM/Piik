import { createElement } from "react";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
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

describe("connection sampling lifetime", () => {
  it("samples only the visible displaying document and rejects retired results", async () => {
    const source = ts.createSourceFile("ChannelConnections.tsx", readFileSync(new URL(
      "../src/client/channel/components/ChannelConnections.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") effect = node.arguments[0]!.getText(source);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!effect) throw new Error("Missing connection observation effect");
    const ownerDocument = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const requests: { signal: AbortSignal; finish(value: object): void }[] = [];
    const updates: { topology: object }[] = [];
    const timers = new Map<number, { run(): void; delay: number }>();
    let sequence = 0;
    const channel = {
      appConnected: true, state: { publications: [] },
      roomTopology: (_room: string, _source: string, signal: AbortSignal) => new Promise<object>(finish => requests.push({ signal, finish })),
      connectionMetrics: async () => ({ samples: [], unavailable: false }),
      appConnectionMetrics: async () => null,
    };
    const cleanup = runInNewContext(ts.transpileModule(`(${effect})()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, {
      active: true, ownerDocument, room: { authorized: true, available: true, delivery: {} },
      current: { current: channel }, roomId: "room", selected: "", scope: "scope", sessionId: "self",
      AbortController, Map, Promise, collectNativeConnectionMetrics, hasSelectedLocalDisplay: () => false,
      setResult: (value: { topology: object }) => updates.push(value),
      setTimeout: (run: () => void, delay: number) => { const id = ++sequence; timers.set(id, { run, delay }); return id; },
      clearTimeout: (id: number) => timers.delete(id),
    }) as () => void;
    const visibility = (value: "visible" | "hidden") => { ownerDocument.visibilityState = value; ownerDocument.dispatchEvent(new Event("visibilitychange")); };
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(0);
    visibility("visible");
    expect(requests).toHaveLength(1);
    visibility("hidden");
    expect(requests[0].signal.aborted).toBe(true);
    visibility("visible");
    expect(requests).toHaveLength(2);
    requests[0].finish({ source: "retired" }); await settle();
    expect(updates).toHaveLength(0);
    expect(timers.size).toBe(0);
    requests[1].finish({ source: "current" }); await settle();
    expect(updates).toEqual([expect.objectContaining({ topology: { source: "current" } })]);
    expect([...timers.values()].map(timer => timer.delay)).toEqual([1000]);
    visibility("hidden");
    expect(timers.size).toBe(0);
    visibility("visible");
    expect(requests).toHaveLength(3);
    cleanup();
    expect(requests[2].signal.aborted).toBe(true);
    requests[2].finish({ source: "closed" }); await settle();
    visibility("hidden"); visibility("visible");
    expect(requests).toHaveLength(3);
    expect(updates).toHaveLength(1);
    expect(timers.size).toBe(0);
  });
});

describe("channel connection presentation", () => {
  it("draws the actual service as forwarding infrastructure while keeping its operator's real endpoint", () => {
    const fixture = channelConnectionPreview("host-endpoints");
    fixture.topology.transitSession = "app";
    const graph = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(graph.nodes.find(node => node.id === "app")).toMatchObject({ kind: "sfu", label: "connection.siteForwarding" });
    expect(graph.nodes.find(node => node.id === "self")).toMatchObject({ kind: "person", identity: "self-user", you: true });
    expect(graph.endpointGroups).toEqual([]);
    const routed = channelConnectionPreview("app");
    routed.topology.transitSession = "app";
    const sample = routed.metrics.find(value => value.peerId === "app" && value.ownerSessionId === routed.sessionId)!;
    expect(sample).toBeDefined();
    routed.topology.screen!.edges.forEach(edge => { edge.presentation = false; });
    const routedGraph = channelConnectionGraph(routed.state, routed.roomId, routed.sessionId, routed.topology, t);
    expect(routedGraph.edges.filter(edge => edge.from === "app" || edge.to === "app").every(edge => edge.route === "sfu")).toBe(true);
    const rows = channelConnectionRows(routed.state, routed.sessionId, routed.topology, [sample], t);
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe("sfu");
    const withoutTopology = channelConnectionRows(routed.state, routed.sessionId, null, [sample], t);
    expect(withoutTopology).toHaveLength(1);
    expect(withoutTopology[0].metrics).toEqual(rows[0].metrics);
    expect(withoutTopology[0].route).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ChannelConnectionReport, routed))).toContain("is-sfu");
  });
  it("merges room audience by user without counting publishers, retired identities or relay paths", () => {
    const { state } = channelConnectionPreview("app");
    const publication = state.publications.find(value => value.kind === "screen")!;
    state.users.push({ id: "third-user", name: "Third", version: "a".repeat(64) });
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

  it("shows only projected, undirected room links and keeps an isolated endpoint visible", () => {
    const fixture = channelConnectionPreview("room-links");
    fixture.state.users.push({ id: "outside-user", name: "Outside", version: "a".repeat(64) });
    fixture.state.sessions.push({ id: "outside", userId: "outside-user", online: true, signingKey: Array(32).fill(0) });
    fixture.topology.sessionIds.push("unknown");
    const graph = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(graph.rootId).toBeNull();
    expect(graph.nodes.find(node => node.id === "unknown")).toMatchObject({ kind: "endpoint", label: "connection.endpoint" });
    expect(graph.nodes.map(node => node.id)).toEqual(["app", "friend", "guest", "host", "self", "unknown"]);
    expect(graph.edges.map(({ from, to, ready }) => [from, to, ready])).toEqual([
      ["app", "self", false], ["friend", "host", true], ["friend", "self", true], ["host", "self", true],
    ]);
    expect(graph.nodes.filter(node => node.host).map(node => node.id)).toEqual(["host"]);
    expect(graph.endpointGroups.map(group => group.ids)).toEqual([["app", "self"]]);
    const html = renderToStaticMarkup(createElement(ChannelConnectionReport, fixture));
    expect(html).toContain(say("connection.roomLinkLegend"));
    expect(html).toContain("is-pending");
    expect(html).not.toContain("Outside");
    expect(html).not.toContain(say("connection.siteForwarding"));
  });

  it("shows no peer paths or media measurements when the room has none", () => {
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
    expect(graph.nodes.find(node => node.id === "self")).toMatchObject({ identity: "self-user", label: "Nori (connection.webpage)", you: true });
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

  it("groups one person's endpoints without merging routes or making the site owner the room host", () => {
    const fixture = channelConnectionPreview("host-endpoints");
    const graph = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(fixture.state.channel.ownerId).not.toBe(fixture.state.channel.rooms[0].creatorId);
    expect(graph.nodes.map(node => node.id).sort()).toEqual(["app", "friend", "self"]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.find(node => node.id === "app")).toMatchObject({ host: true, identity: "self-user", kind: "endpoint" });
    expect(graph.nodes.find(node => node.id === "self")).toMatchObject({ host: false, identity: "self-user", kind: "endpoint" });
    expect(graph.endpointGroups).toEqual([{ userId: "self-user", name: "Nori", ids: ["app", "self"], endpoints: ["App", "connection.webpage"] }]);
    // A different participant's picture root never takes the room host's marker.
    fixture.topology.screen!.sourceSessionId = "friend";
    const otherSource = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(otherSource.rootId).toBe("friend");
    expect(otherSource.nodes.find(node => node.id === "app")?.host).toBe(true);
    expect(otherSource.nodes.find(node => node.id === "friend")?.host).toBe(false);
    fixture.topology.screen!.edges.push({ ...fixture.topology.screen!.edges[0], sender: "friend", receiver: "app", presentation: false });
    const reader = renderToStaticMarkup(createElement(ChannelConnectionReport, fixture)).split('<ul class="visually-hidden">')[1].split("</ul>")[0];
    expect(reader.replace(/<\/?span>/g, "")).toContain(`<li>Nori (App) · ${say("common.host")} ← Kiki`);
    fixture.topology.screen = null;
    const untyped = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(untyped.nodes.find(node => node.id === "app")?.label).toBe("Nori (connection.endpoint)");
    expect(untyped.nodes.find(node => node.id === "self")?.label).toBe("Nori (connection.webpage)");
  });

  it("keeps each person's physical endpoints and only labels an App from its actual display hop", () => {
    const fixture = channelConnectionPreview("multiple-endpoints");
    const graph = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(4);
    expect(graph.endpointGroups.map(group => group.userId)).toEqual(["self-user", "friend-user"]);
    expect(graph.nodes.filter(node => node.kind === "endpoint")).toHaveLength(4);
    expect(graph.nodes.find(node => node.id === "friend-app")?.label).toBe("Kiki (App)");
    fixture.state.users.find(user => user.id === "friend-user")!.name = "Nori";
    fixture.topology.screen!.edges = fixture.topology.screen!.edges.map(edge => ({ ...edge, presentation: false }));
    const untyped = channelConnectionGraph(fixture.state, fixture.roomId, fixture.sessionId, fixture.topology, t);
    expect(untyped.endpointGroups).toHaveLength(2); // Equal names do not merge people.
    expect(untyped.nodes.some(node => node.label.includes("(App)"))).toBe(false);
  });

  it("scopes an unwatched picture's empty path to that share while room voice remains active", () => {
    const fixture = channelConnectionPreview("unwatched");
    expect(fixture.topology.pairs.length).toBeGreaterThan(0);
    expect(fixture.topology.screen?.edges).toEqual([]);
    const html = renderToStaticMarkup(createElement(ChannelConnectionReport, fixture));
    expect(html).toContain(say("connection.noScreenPath"));
    expect(html).not.toContain(say("connection.noRoomLinks"));
    expect(html).not.toContain(say("host.topology.idle"));
    expect(html).toContain('data-media="audio" data-direction="receive"');
  });

  it("keeps unclassified picture samples out of network totals when topology is unavailable", () => {
    const fixture = channelConnectionPreview("app");
    const rows = channelConnectionRows(fixture.state, fixture.sessionId, null, fixture.metrics, t);
    expect(rows.filter(row => row.media === "video")).toHaveLength(4);
    expect(rows.filter(row => row.media === "video").every(row => row.detailOnly)).toBe(true);
    expect(rows.filter(row => row.media === "audio").every(row => !row.detailOnly)).toBe(true);
    expect(channelConnectionRows(fixture.state, fixture.sessionId, fixture.topology, fixture.metrics, t)
      .some(row => row.media === "video" && !row.detailOnly)).toBe(true);
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
