import { describe, expect, it } from "vitest";

import {
  hasPeerRouteEvidence,
  MEDIA_ROUTE_PRESENTATION,
  ROUTING_STATUS_PRESENTATION,
  viewerReconnectRoute,
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

  it("reconnects only the exact transport with current media evidence", () => {
    const identity = {
      parentPeerId: peerSnapshot.peerId,
      connectionId: peerSnapshot.connectionId,
    };
    expect(
      viewerReconnectRoute(
        { kind: "peer", peerId: peerSnapshot.peerId },
        peerSnapshot,
        null,
        identity,
      ),
    ).toBe("p2p");
    expect(
      viewerReconnectRoute(
        { kind: "peer", peerId: peerSnapshot.peerId },
        peerSnapshot,
        null,
        { ...identity, connectionId: "connection-replaced" },
      ),
    ).toBeNull();

    const sfu = { connectionState: "connected" as const, metrics: null };
    expect(
      viewerReconnectRoute(
        { kind: "peer", peerId: "pending-parent" },
        peerSnapshot,
        sfu,
        null,
      ),
    ).toBe("sfu");
  });

});
