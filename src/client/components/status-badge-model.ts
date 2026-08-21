import type { ParticipantRouteAssignment } from "../../shared/protocol";
import type { ConnectionMetrics, PeerSnapshot } from "../types";

export const MEDIA_ROUTE_PRESENTATION = {
  p2p: { tone: "good", label: "P2P", icon: "network" },
  sfu: { tone: "warning", label: "SFU fallback", icon: "server" },
} as const;
export const ROUTING_STATUS_PRESENTATION = { tone: "neutral", label: "线路分配中" } as const;

export type PresentedMediaRoute = keyof typeof MEDIA_ROUTE_PRESENTATION;

export function mediaTransportPresentation(
  metrics: Pick<
    ConnectionMetrics,
    "path" | "iceProtocol" | "localCandidateType" | "localRelayProtocol"
  >,
): { label: string; title: string } {
  if (metrics.path === "direct") {
    const protocol = metrics.iceProtocol?.toUpperCase() ?? null;
    return {
      label: protocol ?? "直连",
      title: protocol ? `此连接使用直连 ${protocol}` : "此连接使用直连传输",
    };
  }
  if (metrics.path === "relay") {
    const protocol =
      metrics.localCandidateType === "relay"
        ? (metrics.localRelayProtocol?.toUpperCase() ?? null)
        : null;
    return {
      label: protocol ? `TURN/${protocol}` : "TURN",
      title: protocol
        ? `此连接正在使用 TURN/${protocol} 中继`
        : "此连接正在使用 TURN 中继；远端中继协议不可见",
    };
  }
  return { label: "传输未确定", title: "尚未选出可用的传输路径" };
}

export function hasPeerRouteEvidence(
  peer: PeerSnapshot | null | undefined,
): boolean {
  return Boolean(
    peer &&
      (peer.connectionState === "connected" || peer.metrics.path !== "unknown"),
  );
}

export function viewerRouteEvidence(
  upstream: ParticipantRouteAssignment["upstream"] | null,
  peer: PeerSnapshot | null,
  sfu: {
    connectionState: "connected" | "reconnecting";
    metrics: ConnectionMetrics | null;
  } | null,
): {
  route: PresentedMediaRoute | null;
  evidence: {
    connectionState: PeerSnapshot["connectionState"] | "reconnecting";
    metrics: ConnectionMetrics | null;
  } | null;
} {
  if (!upstream) {
    return sfu
      ? { route: "sfu", evidence: sfu }
      : hasPeerRouteEvidence(peer)
        ? { route: "p2p", evidence: peer }
        : { route: null, evidence: null };
  }
  if (upstream.kind === "sfu") {
    return sfu
      ? { route: "sfu", evidence: sfu }
      : { route: null, evidence: null };
  }
  if (upstream.kind === "peer") {
    const matchingPeer = peer?.peerId === upstream.peerId ? peer : null;
    const hasMatchingPeerEvidence = hasPeerRouteEvidence(matchingPeer);
    return {
      route: hasMatchingPeerEvidence ? "p2p" : null,
      evidence: hasMatchingPeerEvidence ? matchingPeer : null,
    };
  }
  return { route: null, evidence: null };
}
