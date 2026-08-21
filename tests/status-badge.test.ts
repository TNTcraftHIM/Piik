import { describe, expect, it } from "vitest";

import {
  hasPeerRouteEvidence,
  MEDIA_ROUTE_PRESENTATION,
  mediaTransportPresentation,
  ROUTING_STATUS_PRESENTATION,
  viewerRouteEvidence,
} from "../src/client/components/status-badge-model.ts";
import { EMPTY_METRICS, type PeerSnapshot } from "../src/client/types.ts";

const peerSnapshot: PeerSnapshot = {
  peerId: "host-peer",
  connectionId: "connection-1",
  connectionState: "connected",
  iceConnectionState: "connected",
  metrics: { ...EMPTY_METRICS, path: "direct" },
  error: null,
};

describe("route status badges", () => {
  it("uses distinct icon and color language for active P2P and SFU routes", () => {
    expect(MEDIA_ROUTE_PRESENTATION.p2p).toEqual({
      tone: "good", label: "P2P", icon: "network",
    });
    expect(MEDIA_ROUTE_PRESENTATION.sfu).toEqual({
      tone: "warning", label: "SFU fallback", icon: "server",
    });
  });

  it("keeps an assigned route neutral before current media evidence", () => {
    expect(ROUTING_STATUS_PRESENTATION).toEqual({
      tone: "neutral", label: "线路分配中",
    });
    expect(viewerRouteEvidence({ kind: "sfu" }, null, null)).toEqual({
      route: null,
      evidence: null,
    });
  });

  it("uses evidence only when it matches the authoritative upstream", () => {
    expect(viewerRouteEvidence({ kind: "sfu" }, peerSnapshot, null)).toEqual({
      route: null,
      evidence: null,
    });
    expect(
      viewerRouteEvidence(
        { kind: "peer", peerId: "new-parent" },
        peerSnapshot,
        null,
      ),
    ).toEqual({ route: null, evidence: null });

    const sfu = { connectionState: "connected" as const, metrics: null };
    expect(viewerRouteEvidence({ kind: "sfu" }, null, sfu)).toEqual({
      route: "sfu",
      evidence: sfu,
    });
    expect(
      viewerRouteEvidence(
        { kind: "peer", peerId: "new-parent" },
        peerSnapshot,
        sfu,
      ),
    ).toEqual({ route: "sfu", evidence: sfu });
  });

  it("requires a connected peer or an observed selected path", () => {
    const connecting = {
      ...peerSnapshot,
      connectionState: "connecting" as const,
      metrics: { ...EMPTY_METRICS, path: "unknown" as const },
    };
    expect(hasPeerRouteEvidence(connecting)).toBe(false);
    expect(
      viewerRouteEvidence(
        { kind: "peer", peerId: "host-peer" },
        connecting,
        null,
      ),
    ).toEqual({ route: null, evidence: null });

    expect(
      viewerRouteEvidence(
        { kind: "peer", peerId: "host-peer" },
        { ...connecting, metrics: { ...EMPTY_METRICS, path: "direct" } },
        null,
      ).route,
    ).toBe("p2p");
  });

  it("exposes TURN only from current assigned-edge evidence", () => {
    const relayPeer = {
      ...peerSnapshot,
      metrics: { ...EMPTY_METRICS, path: "relay" as const },
    };
    expect(
      viewerRouteEvidence(
        { kind: "peer", peerId: "host-peer" },
        relayPeer,
        null,
      ).evidence?.metrics?.path,
    ).toBe("relay");
  });

  it("states a TURN protocol only from local relay evidence", () => {
    expect(
      mediaTransportPresentation({
        ...EMPTY_METRICS,
        path: "relay",
        localCandidateType: "relay",
        localRelayProtocol: "udp",
      }).label,
    ).toBe("TURN/UDP");
    expect(
      mediaTransportPresentation({
        ...EMPTY_METRICS,
        path: "relay",
        localCandidateType: "relay",
        localRelayProtocol: "tls",
      }).label,
    ).toBe("TURN/TLS");
    expect(
      mediaTransportPresentation({
        ...EMPTY_METRICS,
        path: "relay",
        localCandidateType: "host",
      }).label,
    ).toBe("TURN");
    expect(
      mediaTransportPresentation({
        ...EMPTY_METRICS,
        path: "direct",
        iceProtocol: "udp",
      }).label,
    ).toBe("UDP");
  });
});
