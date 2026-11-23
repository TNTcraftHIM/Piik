import type { ChannelSnapshot, ChannelTopology } from "../protocol";
import type { ChannelConnectionSample } from "../types";
import type { ConnectionDetail } from "../../components/living/ConnectionDetails";
import type { RouteGraphEdge, RouteGraphNode } from "../../components/living/RouteGraph";
import type { CopyKey } from "../../ui/copy";
import { EMPTY_METRICS } from "../../types";

type Translate = (key: CopyKey, vars?: Record<string, string>) => string;
type ChannelConnectionDetail = ConnectionDetail & { selectedDisplayReceiver?: string };

function hopRoute(topology: ChannelTopology, from: string, to: string): "p2p" | "sfu" {
  return from === topology.transitSession || to === topology.transitSession ? "sfu" : "p2p";
}

export function hasSelectedLocalDisplay(topology: ChannelTopology | null, sessionId: string): boolean {
  return topology?.screen?.edges.some(edge => edge.presentation && edge.selected && edge.receiver === sessionId) ?? false;
}

export function connectionSessionName(state: ChannelSnapshot, sessionId: string, t: Translate): string {
  const session = state.sessions.find(value => value.id === sessionId);
  return state.users.find(user => user.id === session?.userId)?.name ?? t("voice.participant");
}

export function channelConnectionGraph(state: ChannelSnapshot, roomId: string, sessionId: string,
  topology: ChannelTopology, t: Translate) {
  const screen = topology.screen;
  const rootId = screen?.sourceSessionId ?? null;
  const edges: RouteGraphEdge[] = screen ? screen.edges.map(edge => ({
    from: edge.sender, to: edge.receiver, selected: edge.selected,
    ready: edge.proof === "forwardable" || edge.proof === "decoded", presentation: edge.presentation,
    route: edge.presentation ? undefined : hopRoute(topology, edge.sender, edge.receiver),
  })) : topology.pairs.map(pair => ({ from: pair.first, to: pair.second, selected: true, ready: pair.confirmed }));
  const apps = new Set(screen?.edges.filter(edge => edge.presentation).map(edge => edge.sender));
  const display = new Set(screen?.edges.filter(edge => edge.presentation).map(edge => edge.receiver));
  const room = state.channel.rooms.find(room => room.id === roomId);
  const ids = screen ? [...new Set([screen.sourceSessionId, ...edges.flatMap(edge => [edge.from, edge.to])])]
    : topology.sessionIds;
  const sessionUsers = new Map(state.sessions.map(session => [session.id, session.userId]));
  const identity = (id: string) => sessionUsers.get(id) ?? id;
  const people = ids.filter(id => id !== topology.transitSession && sessionUsers.has(id));
  const groups = [...new Set(people.map(identity))].map(userId => ({ userId,
    name: state.users.find(user => user.id === userId)?.name ?? t("voice.participant"),
    ids: people.filter(id => identity(id) === userId).sort(),
  }));
  const endpointKind = (id: string) => apps.has(id) ? "app" as const
    : display.has(id) || id === sessionId ? "webpage" as const : undefined;
  const endpoint = (id: string) => {
    const kind = endpointKind(id);
    if (kind) return kind === "app" ? "App" : t("connection.webpage");
    const group = groups.find(group => group.userId === identity(id));
    return t("connection.endpoint", { number: String((group?.ids.indexOf(id) ?? 0) + 1) });
  };
  const roomMembers = new Set(room?.participantSessionIds);
  const nodes = ids.map((id, index): RouteGraphNode => {
    if (id === topology.transitSession) return { id, identity: id, kind: "sfu", label: t(screen ? "connection.siteForwarding" : "connection.siteService") };
    const userId = sessionUsers.get(id);
    if (!userId) return { id, kind: "endpoint", you: id === sessionId,
      label: t("connection.endpoint", { number: String(index + 1) }) };
    const name = connectionSessionName(state, id, t);
    const multiple = groups.some(group => group.userId === identity(id) && group.ids.length > 1);
    const host = id === room?.delivery?.hostSessionId && userId === room?.creatorId;
    const kind = endpointKind(id);
    const showEndpoint = multiple || !!kind || !host && !roomMembers.has(id);
    return { id, identity: userId ?? id,
      kind: showEndpoint ? "endpoint" : "person", endpointKind: kind,
      endpointLabel: showEndpoint ? endpoint(id) : undefined,
      you: id === sessionId, host, label: name };
  });
  return { nodes, rootId, edges, endpointGroups: groups.filter(group => group.ids.length > 1)
    .map(group => ({ ...group, endpoints: group.ids.map(endpoint) })) };
}

export function channelConnectionRows(state: ChannelSnapshot, sessionId: string,
  topology: ChannelTopology | null, samples: readonly ChannelConnectionSample[], t: Translate): ChannelConnectionDetail[] {
  return samples.flatMap(sample => {
    const publication = state.publications.find(publication => publication.id === sample.publicationId);
    if (!publication) return [];
    if (sample.ownerSessionId === sessionId) {
      const pair = state.pairs.find(pair => pair.id === sample.pairId);
      const flows = sample.direction === "send" ? pair?.outgoing : pair?.incoming;
      if (!flows?.some(flow => flow.id === sample.flowId && flow.publicationId === sample.publicationId && flow.selected)) return [];
    }
    const video = publication.kind === "screen" ? samples.find(other => other.connectionId === sample.connectionId
      && other.flowId === sample.flowId && other.direction === sample.direction && other.media === "video") : undefined;
    const sourceSound = publication.kind === "screen" ? samples.find(other => other.connectionId === sample.connectionId
      && other.flowId === sample.flowId && other.direction === sample.direction && other.media === "audio") : undefined;
    if (sourceSound === sample && video) return [];
    const metrics = sourceSound && (!video || video === sample) ? { ...(sample.media === "video" ? sample.metrics : { ...EMPTY_METRICS, rttMs: sample.metrics.rttMs }),
      audioBitrateKbps: sourceSound.metrics.audioBitrateKbps, audioCodec: sourceSound.metrics.audioCodec,
      audioPacketLossPercent: sourceSound.metrics.audioPacketLossPercent, audioJitterMs: sourceSound.metrics.audioJitterMs } : sample.metrics;
    const from = sample.direction === "send" ? sample.ownerSessionId : sample.peerId;
    const to = sample.direction === "send" ? sample.peerId : sample.ownerSessionId;
    const localDisplay = topology?.screen?.publicationId === sample.publicationId
      ? topology.screen.edges.find(edge => edge.presentation && edge.sender === from && edge.receiver === to)
      : undefined;
    const source = connectionSessionName(state, publication.sessionId, t);
    const peer = sample.peerId === topology?.transitSession ? t("connection.siteForwarding") : connectionSessionName(state, sample.peerId, t);
    const label = localDisplay ? t("connection.localDisplay")
      : sample.direction === "receive" ? t("voice.details.receiveFrom", { name: peer })
      : publication.sessionId !== sample.ownerSessionId ? t("voice.details.forwardTo", { source, name: peer })
      : t("voice.details.sendTo", { name: peer });
    // Without picture topology, a sample may be the App's local display hop.
    return [{ key: `${sample.ownerSessionId}/${sample.flowId}/${sample.metrics.rtpStatsId}`, connectionId: sample.connectionId,
      media: publication.kind === "voice" ? "audio" : "video", direction: sample.direction,
      route: topology && !localDisplay ? hopRoute(topology, from, to) : undefined, label, metrics,
      selectedDisplayReceiver: localDisplay?.selected ? localDisplay.receiver : undefined,
      detailOnly: publication.kind === "screen" && !topology?.screen || !!localDisplay || !sample.selected || undefined }];
  });
}
