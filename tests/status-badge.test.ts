import { describe, expect, it } from "vitest";

import {
  MEDIA_ROUTE_PRESENTATION,
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

  it("shows an assigned route before current media evidence", () => {
    expect(ROUTING_STATUS_PRESENTATION).toEqual({
      tone: "neutral", label: "线路分配中",
    });
    expect(viewerRouteEvidence({ kind: "sfu" }, null, null)).toEqual({
      route: "sfu",
      evidence: null,
    });
  });

  it("uses evidence only when it matches the authoritative upstream", () => {
    expect(viewerRouteEvidence({ kind: "sfu" }, peerSnapshot, null)).toEqual({
      route: "sfu",
      evidence: null,
    });
    expect(
      viewerRouteEvidence(
        { kind: "peer", peerId: "new-parent" },
        peerSnapshot,
        null,
      ),
    ).toEqual({ route: "p2p", evidence: null });
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
});
