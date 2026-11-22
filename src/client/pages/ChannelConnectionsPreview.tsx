import { useState } from "react";
import type { z } from "zod";
import { ChannelConnectionReport } from "../channel/components/ChannelConnections";
import { snapshotSchema, type ChannelTopology } from "../channel/protocol";
import type { ChannelConnectionSample } from "../channel/types";
import { Chip } from "../components/living/primitives";
import { EMPTY_METRICS } from "../types";
import { useCopy } from "../ui/copy";
import { PREVIEW_METRICS } from "./preview-metrics";
import { QUALITY_PROFILES, screenVideoSettings } from "../media/quality";

type ConnectionPreviewMode = "room" | "room-links" | "voice" | "both" | "app" | "unwatched" | "host-endpoints" | "multiple-endpoints" | "site-forwarding";
export function channelConnectionPreview(mode: ConnectionPreviewMode, longNames = false) {
  const forwarding = mode === "site-forwarding";
  if (forwarding) mode = "both";
  const roomOnly = mode === "room" || mode === "room-links";
  const participants = roomOnly ? ["host", "self", "friend", "app"] : ["host", "self", "friend"];
  const state = snapshotSchema.parse({
    channel: { id: "domain", name: "Friends", icon: "couch", ownerId: "host-user", roomCreationPolicy: "ordinary", hostingMode: "lightweight", historyWindow: 100, userCount: 3, managedRoomIds: [],
      rooms: [{ id: "room", name: "Living room", icon: "couch", creatorId: "host-user", access: "public", hidden: false,
        hasPassword: false, authorized: true, canManage: false, participantSessionIds: participants,
        fileActivity: [],
        available: true, reading: true, lastMessageSeq: 0, capabilities: { attachments: true },
        delivery: { hostSessionId: "host", bindingId: "binding" } }] },
    users: [{ id: "host-user", name: longNames ? "Host with a very long display name" : "Momo", version: "0".repeat(64) },
      { id: "self-user", name: "Nori", version: "0".repeat(64) }, { id: "friend-user", name: "Kiki", version: "0".repeat(64) }],
    sessions: ["host", "self", "friend", "app"].map(id => ({ id, userId: id === "app" ? "self-user" : `${id}-user`, online: true, signingKey: Array(32).fill(0) })),
    publications: roomOnly ? [] : [
      ...["host", "self", "friend"].map(id => ({ audience: [], id: `voice-${id}`, roomId: "room", sessionId: id, userId: `${id}-user`, kind: "voice" as const, paused: false })),
      ...(mode === "voice" ? [] : ["host", "self"].map(id => ({ audience: [], id: `screen-${id}`, roomId: "room", sessionId: id, userId: `${id}-user`, kind: "screen" as const, source: { kind: "screen" as const, name: null }, title: null, videoSettings: screenVideoSettings(QUALITY_PROFILES["1080p30"]), paused: false }))),
    ], voice: roomOnly ? [] : ["host", "self", "friend"].map(sessionId => ({
      sessionId, roomId: "room", muted: false, deafened: false,
    })), subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  } satisfies z.input<typeof snapshotSchema>);
  const topology: ChannelTopology = { serviceAvailable: false, serviceEnabled: false, bindingId: "binding", transitSession: null,
    sessionIds: [], pairs: roomOnly ? [] : [
      { first: "friend", second: "host", confirmed: true }, { first: "host", second: "self", confirmed: true },
    ], screen: mode === "app" ? { publicationId: "screen-host", sourceSessionId: "host", edges: [
    { sender: "host", receiver: "app", selected: true, proof: "forwardable", presented: null, presentation: false },
    { sender: "app", receiver: "self", selected: true, proof: "decoded", presented: null, presentation: true },
    { sender: "app", receiver: "friend", selected: false, proof: null, presented: false, presentation: false },
  ] } : mode === "both" || mode === "unwatched" ? { publicationId: "screen-host", sourceSessionId: "host", edges: mode === "unwatched" ? [] : [
    { sender: "host", receiver: "self", selected: true, proof: "decoded", presented: true, presentation: false },
    { sender: "self", receiver: "friend", selected: true, proof: "decoded", presented: true, presentation: false },
  ] } : null };
  const metric = (publicationId: string, peerId: string, direction: "send" | "receive", media: "video" | "audio", ownerSessionId = "self"): ChannelConnectionSample => ({
    pairId: `pair-${peerId}`, flowId: `${publicationId}-${direction}`, publicationId, peerId, direction, media,
    ownerSessionId, connectionId: `${ownerSessionId}/pair-${peerId}`, selected: true,
    metrics: media === "video" ? { ...(ownerSessionId === "self" ? PREVIEW_METRICS : { ...EMPTY_METRICS,
      bitrateKbps: 7200, rttMs: 24, packetLossPercent: .2, codec: "video/h264", availableOutgoingKbps: 10_000 }), rtpStatsId: publicationId }
      : { ...EMPTY_METRICS, rtpStatsId: publicationId, bitrateKbps: 48, audioBitrateKbps: 48,
        rttMs: 24, jitterMs: 1.2, packetLossPercent: .2, audioCodec: "audio/opus" },
  });
  const metrics: ChannelConnectionSample[] = roomOnly ? [] : [
    metric("voice-host", "host", "receive", "audio"), metric("voice-friend", "host", "receive", "audio"),
    metric("voice-self", "host", "send", "audio"),
    ...(mode === "voice" || mode === "unwatched" ? [] : [metric("screen-host", mode === "app" ? "app" : "host", "receive", "video"),
      metric(mode === "app" ? "screen-self" : "screen-host", "friend", "send", "video")]),
  ];
  if (mode === "app") {
    metrics.push(metric("screen-host", "host", "receive", "video", "app"),
      metric("screen-host", "self", "send", "video", "app"));
  }
  if (forwarding) {
    state.sessions.push({ ...state.sessions.find(session => session.id === "host")!, id: "site-service" });
    topology.serviceAvailable = topology.serviceEnabled = true;
    topology.transitSession = "site-service";
    const path = ["host", "site-service", "self", "friend"];
    topology.screen!.edges = path.slice(1).map((receiver, index) => ({ sender: path[index], receiver, selected: true,
      proof: "forwardable", presented: null, presentation: false }));
    topology.pairs = [];
    for (const sample of metrics) if (sample.peerId === "host") {
      sample.peerId = "site-service"; sample.pairId = "pair-site-service";
      sample.connectionId = `${sample.ownerSessionId}/${sample.pairId}`;
    }
  }
  for (const sample of metrics.filter(sample => sample.ownerSessionId === "self")) {
    let pair = state.pairs.find(pair => pair.id === sample.pairId);
    if (!pair) {
      pair = { id: sample.pairId, peerId: sample.peerId, canReceiveVideoLayers: false, rooms: ["room"], incoming: [], outgoing: [] };
      state.pairs.push(pair);
    }
    (sample.direction === "send" ? pair.outgoing : pair.incoming).push({ id: sample.flowId,
      publicationId: sample.publicationId, selected: true, inputFlowId: null });
  }
  if (mode === "host-endpoints") {
    // The site owner stays separate; one room owner has an App and a webpage.
    state.channel.rooms[0].creatorId = "self-user";
    state.channel.rooms[0].delivery!.hostSessionId = "app";
    topology.pairs = [];
    topology.screen = { publicationId: "screen-self", sourceSessionId: "app", edges: [
      { sender: "app", receiver: "self", selected: true, proof: "decoded", presented: true, presentation: true },
      { sender: "app", receiver: "friend", selected: true, proof: "forwardable", presented: null, presentation: false },
    ] };
    state.publications.find(value => value.id === "screen-self")!.sessionId = "app";
  }
  if (mode === "multiple-endpoints") {
    state.sessions.push({ ...state.sessions.find(value => value.id === "friend")!, id: "friend-app" });
    topology.screen = { publicationId: "screen-host", sourceSessionId: "host", edges: [
      { sender: "host", receiver: "app", selected: true, proof: "forwardable", presented: null, presentation: false },
      { sender: "app", receiver: "self", selected: true, proof: "decoded", presented: true, presentation: true },
      { sender: "app", receiver: "friend-app", selected: true, proof: "forwardable", presented: null, presentation: false },
      { sender: "friend-app", receiver: "friend", selected: true, proof: "decoded", presented: true, presentation: true },
    ] };
  }
  if (mode === "room-links") {
    state.users.push({ id: "guest-user", name: "Rin", version: "0".repeat(64) });
    state.sessions.push({ id: "guest", userId: "guest-user", online: true, signingKey: Array(32).fill(0) });
    state.channel.userCount++;
    state.channel.rooms[0].participantSessionIds.push("guest");
    topology.pairs = [
      { first: "app", second: "host", confirmed: false },
      { first: "friend", second: "host", confirmed: true },
      { first: "friend", second: "self", confirmed: true },
      { first: "host", second: "self", confirmed: true },
    ];
  }
  // Selected and preparing picture flows both use already confirmed physical pairs.
  for (const { sender, receiver } of topology.screen?.edges ?? []) {
    const [first, second] = [sender, receiver].sort();
    if (!topology.pairs.some(pair => pair.first === first && pair.second === second)) {
      topology.pairs.push({ first, second, confirmed: true });
    }
  }
  const room = state.channel.rooms[0];
  topology.sessionIds = [...new Set([...room.participantSessionIds, room.delivery!.hostSessionId,
    ...topology.pairs.flatMap(pair => [pair.first, pair.second])])].sort();
  return { state, topology, metrics: mode === "host-endpoints" || mode === "multiple-endpoints" ? [] : metrics, roomId: "room", sessionId: "self" };
}

export function ChannelConnectionsPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [mode, setMode] = useState<ConnectionPreviewMode>("room-links");
  const [longNames, setLongNames] = useState(false);
  const modes = [
    { value: "room-links", label: en ? "Room peer links" : "房间连接" },
    { value: "room", label: en ? "No peer links" : "尚无连接" }, { value: "voice", label: en ? "Voice" : "语音" },
    { value: "both", label: en ? "Picture and voice" : "画面与语音" }, { value: "app", label: en ? "App display" : "App 显示" },
    { value: "unwatched", label: en ? "Unwatched share" : "尚未观看的分享" },
    { value: "host-endpoints", label: en ? "One owner, App and webpage" : "同一房主的 App 与网页" },
    { value: "multiple-endpoints", label: en ? "Two people, two connections each" : "两人各有两个连接" },
    { value: "site-forwarding", label: en ? "Site forwarding" : "站点转发" },
  ] as const;
  return <section id="channel-connections-preview" className="cp-section">
    <header className="cp-section-head"><h2>{en ? "Room and media connections" : "房间与媒体连接"}</h2></header>
    <div className="cp-tools" role="group" aria-label={t("host.details")}>
      {modes.map(({ value, label }) => <Chip key={value} selected={mode === value}
        title={label} onClick={() => setMode(value)}>{label}</Chip>)}
      <Chip selected={longNames} title={en ? "Long names" : "长昵称"} onClick={() => setLongNames(value => !value)}>{en ? "Long names" : "长昵称"}</Chip>
    </div>
    <div className="cp-connection-panel"><ChannelConnectionReport {...channelConnectionPreview(mode, longNames)} /></div>
  </section>;
}
