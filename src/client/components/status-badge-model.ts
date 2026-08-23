import type { ParticipantRouteAssignment } from "../../shared/protocol";
import type { ConnectionMetrics, PeerSnapshot } from "../types";

export const MEDIA_ROUTE_PRESENTATION = {
  p2p: { tone: "good", label: "P2P", icon: "network" },
  sfu: { tone: "warning", label: "SFU fallback", icon: "server" },
} as const;
export const ROUTING_STATUS_PRESENTATION = { tone: "neutral", label: "线路分配中" } as const;

export type PresentedMediaRoute = keyof typeof MEDIA_ROUTE_PRESENTATION;

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
    if (hasMatchingPeerEvidence) {
      return { route: "p2p", evidence: matchingPeer };
    }
    return sfu
      ? { route: "sfu", evidence: sfu }
      : { route: null, evidence: null };
  }
  return { route: null, evidence: null };
}
