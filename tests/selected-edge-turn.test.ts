import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSelectedEdgeTurnCredential } from "../src/server/selected-edge-turn.ts";
const config = {
  urls: ["turn:turn.example.test:3478?transport=udp"] as [string],
  sharedSecret: "t".repeat(32),
  credentialTtlSeconds: 120,
  allocationCapacity: 4,
};
const identity = {
  edgeKind: "peer-selected" as const,
  roomId: "123456789012",
  shareGeneration: "share_generation_12345678",
  revision: 7,
  parentPeerId: "parent_peer_12345678",
  parentSessionId: "parent_session_12345678",
  viewerPeerId: "viewer_peer_12345678",
  viewerSessionId: "viewer_session_12345678",
  oldConnectionId: "old_connection_12345678",
  newConnectionId: "new_connection_12345678",
};
describe("selected-edge TURN", () => {
  it("issues an opaque, expiring coturn REST credential bound to the edge", () => {
    const grant = issueSelectedEdgeTurnCredential(config, identity, 1_700_000_000_000);
    expect(grant.expiresAt).toBe("2023-11-14T22:15:20.000Z");
    expect(grant.iceServer.username).toMatch(/^1700000120:[A-Za-z0-9_-]{32}$/);
    expect(grant.iceServer.credential).toBe(
      createHmac("sha1", config.sharedSecret)
        .update(grant.iceServer.username)
        .digest("base64"),
    );
    const serialized = JSON.stringify(grant);
    for (const value of Object.values(identity).filter((value) => typeof value === "string")) {
      expect(serialized).not.toContain(String(value));
    }
    expect(
      issueSelectedEdgeTurnCredential(
        config,
        { ...identity, shareGeneration: "share_generation_87654321" },
        1_700_000_000_000,
      ).iceServer.username,
    ).not.toBe(grant.iceServer.username);
  });

  it("binds a Host-to-SFU ingress grant to its publication generation", () => {
    const grant = issueSelectedEdgeTurnCredential(
      config,
      {
        edgeKind: "host-sfu-ingress",
        roomId: "1",
        shareGeneration: "share_generation_12345678",
        revision: 7,
        hostPeerId: "host_peer_12345678",
        hostSessionId: "host_session_12345678",
        publicationGeneration: "publication_generation_12345678",
        oldConnectionId: "publication_generation_12345678",
        newConnectionId: "new_connection_12345678",
      },
      1_700_000_000_000,
    );

    expect(grant.iceServer.username).toMatch(
      /^1700000120:[A-Za-z0-9_-]{32}$/,
    );
    expect(
      issueSelectedEdgeTurnCredential(
        config,
        {
          edgeKind: "host-sfu-ingress",
          roomId: "1",
          shareGeneration: "share_generation_12345678",
          revision: 7,
          hostPeerId: "host_peer_12345678",
          hostSessionId: "host_session_12345678",
          publicationGeneration: "publication_generation_87654321",
          oldConnectionId: "publication_generation_87654321",
          newConnectionId: "new_connection_12345678",
        },
        1_700_000_000_000,
      ).iceServer.username,
    ).not.toBe(grant.iceServer.username);
  });
});
