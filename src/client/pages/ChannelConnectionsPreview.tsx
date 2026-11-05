import { useState } from "react";
import { ChannelConnectionReport } from "../channel/components/ChannelConnections";
import { snapshotSchema, type ChannelTopology } from "../channel/protocol";
import type { ChannelConnectionSample } from "../channel/types";
import { Chip } from "../components/living/primitives";
import { EMPTY_METRICS } from "../types";
import { useCopy } from "../ui/copy";
import { PREVIEW_METRICS } from "./preview-metrics";
import { QUALITY_PROFILES, screenVideoCeiling } from "../media/quality";

export function channelConnectionPreview(mode: "room" | "voice" | "both" | "app", longNames = false) {
  const state = snapshotSchema.parse({
    channel: { id: "domain", name: "Friends", icon: "couch", ownerId: "host-user", historyWindow: 100,
      rooms: [{ id: "room", name: "Living room", icon: "couch", creatorId: "host-user", access: "public", hidden: false,
        hasPassword: false, authorized: true, canManage: false, participantSessionIds: ["host", "self", "friend", "app"],
        available: true, reading: true, capabilities: { attachments: true },
        delivery: { hostSessionId: "host", bindingId: "binding", nextHops: { host: "host" } } }], roles: [] },
    users: [{ id: "host-user", name: longNames ? "Host with a very long display name" : "Momo", roles: [] },
      { id: "self-user", name: "Nori", roles: [] }, { id: "friend-user", name: "Kiki", roles: [] }],
    sessions: ["host", "self", "friend", "app"].map(id => ({ id, userId: id === "app" ? "self-user" : `${id}-user`, online: true, signingKey: Array(32).fill(0) })),
    publications: mode === "room" ? [] : [
      ...["host", "self", "friend"].map(id => ({ id: `voice-${id}`, roomId: "room", sessionId: id, userId: `${id}-user`, kind: "voice", muted: false, paused: false })),
      ...(mode === "voice" ? [] : ["host", "self"].map(id => ({ id: `screen-${id}`, roomId: "room", sessionId: id, userId: `${id}-user`, kind: "screen", videoCeiling: screenVideoCeiling(QUALITY_PROFILES["1080p30"]), muted: false, paused: false }))),
    ], voice: [], subscriptions: [], failedSubscriptions: [], files: [], pairs: [], iceServers: [],
  });
  const topology: ChannelTopology = { bindingId: "binding", base: { rootSessionId: "host", edges: [
    { sender: "host", receiver: "self", ready: true }, { sender: "host", receiver: "friend", ready: true },
  ] }, screen: mode === "app" ? { publicationId: "screen-host", sourceSessionId: "host", edges: [
    { sender: "host", receiver: "app", selected: true, proof: "forwardable", presented: null, presentation: false },
    { sender: "app", receiver: "self", selected: true, proof: "decoded", presented: null, presentation: true },
    { sender: "app", receiver: "friend", selected: false, proof: null, presented: false, presentation: false },
  ] } : mode === "both" ? { publicationId: "screen-host", sourceSessionId: "host", edges: [
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
  const metrics: ChannelConnectionSample[] = mode === "room" ? [] : [
    metric("voice-host", "host", "receive", "audio"), metric("voice-friend", "host", "receive", "audio"),
    metric("voice-self", "host", "send", "audio"),
    ...(mode === "voice" ? [] : [metric("screen-host", mode === "app" ? "app" : "host", "receive", "video"),
      metric(mode === "app" ? "screen-self" : "screen-host", "friend", "send", "video")]),
  ];
  if (mode === "app") {
    metrics.push(metric("screen-host", "host", "receive", "video", "app"),
      metric("screen-host", "self", "send", "video", "app"));
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
  return { state, topology, metrics, roomId: "room", sessionId: "self" };
}

export function ChannelConnectionsPreview() {
  const { lang, t } = useCopy();
  const en = lang === "en";
  const [mode, setMode] = useState<"room" | "voice" | "both" | "app">("both");
  const [longNames, setLongNames] = useState(false);
  const modes = [
    { value: "room", label: en ? "Room" : "房间连接" }, { value: "voice", label: en ? "Voice" : "语音" },
    { value: "both", label: en ? "Picture and voice" : "画面与语音" }, { value: "app", label: en ? "App display" : "App 显示" },
  ] as const;
  return <section id="channel-connections-preview" className="cp-section">
    <header className="cp-section-head"><h2>{en ? "Multi-source connections" : "多源媒体连接"}</h2></header>
    <div className="cp-tools" role="group" aria-label={t("host.details")}>
      {modes.map(({ value, label }) => <Chip key={value} selected={mode === value}
        title={label} onClick={() => setMode(value)}>{label}</Chip>)}
      <Chip selected={longNames} title={en ? "Long names" : "长昵称"} onClick={() => setLongNames(value => !value)}>{en ? "Long names" : "长昵称"}</Chip>
    </div>
    <div className="cp-connection-panel"><ChannelConnectionReport {...channelConnectionPreview(mode, longNames)} /></div>
  </section>;
}
