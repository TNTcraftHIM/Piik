import type { ParticipantRouteAssignment } from "../../shared/protocol";
import type { ConnectionMetrics, PeerSnapshot } from "../types";

export const MEDIA_ROUTE_PRESENTATION = {
  p2p: { tone: "good", label: "P2P", icon: "network" },
  sfu: { tone: "warning", label: "SFU fallback", icon: "server" },
} as const;
export const ROUTING_STATUS_PRESENTATION = { tone: "neutral", label: "线路分配中" } as const;

export type PresentedMediaRoute = keyof typeof MEDIA_ROUTE_PRESENTATION;

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
      : peer
        ? { route: "p2p", evidence: peer }
        : { route: null, evidence: null };
  }
  if (upstream.kind === "sfu") {
    return { route: "sfu", evidence: sfu };
  }
  if (upstream.kind === "peer") {
    return {
      route: "p2p",
      evidence: peer?.peerId === upstream.peerId ? peer : null,
    };
  }
  return { route: null, evidence: null };
}
