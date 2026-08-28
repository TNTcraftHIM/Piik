import type { ParticipantRouteAssignment } from "../../shared/protocol";
import type { ConnectionMetrics, PeerSnapshot } from "../types";

export type PresentedMediaRoute = "p2p" | "sfu";

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

export function viewerReconnectRoute(
  upstream: ParticipantRouteAssignment["upstream"] | null,
  peer: PeerSnapshot | null,
  sfu: {
    connectionState: "connected" | "reconnecting";
    metrics: ConnectionMetrics | null;
  } | null,
  peerIdentity: { parentPeerId: string; connectionId: string } | null,
): PresentedMediaRoute | null {
  const route = viewerRouteEvidence(upstream, peer, sfu).route;
  if (route === "sfu") {
    return "sfu";
  }
  return route === "p2p" &&
    peer !== null &&
    peerIdentity?.parentPeerId === peer.peerId &&
    peerIdentity.connectionId === peer.connectionId
    ? "p2p"
    : null;
}
