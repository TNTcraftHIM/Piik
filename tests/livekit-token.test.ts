import { describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";

import { LiveKitTokenIssuer } from "../src/server/livekit-token.ts";

const apiKey = "test-api-key";
const apiSecret = "s".repeat(32);
const publicationGeneration = "publication_12345678";
const rootPeerId = "viewer_root_12345678";
const secondRootPeerId = "viewer_root_23456789";
const thirdRootPeerId = "viewer_root_34567890";

function issuer(maxViewersPerRoom = 8): LiveKitTokenIssuer {
  return new LiveKitTokenIssuer({
    apiKey,
    apiSecret,
    maxViewersPerRoom,
  });
}

describe("LiveKitTokenIssuer", () => {
  it("allows every admitted root within the room Viewer bound", async () => {
    const tokenIssuer = issuer();
    await expect(
      tokenIssuer.issueToken({
        roomId: "42",
        role: "host",
        peerId: "host_peer_12345678",
        publicationGeneration,
        allowlistedRootPeerIds: [rootPeerId, secondRootPeerId],
      }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      tokenIssuer.issueToken({
        roomId: "42",
        role: "viewer",
        peerId: secondRootPeerId,
        publicationGeneration,
        allowlistedRootPeerIds: [rootPeerId, secondRootPeerId],
      }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      tokenIssuer.issueToken({
        roomId: "42",
        role: "host",
        peerId: "host_peer_12345678",
        publicationGeneration,
        allowlistedRootPeerIds: [
          rootPeerId,
          secondRootPeerId,
          thirdRootPeerId,
        ],
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("issues a generation-bound host token limited to screen sharing", async () => {
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      await issuer().issueToken({
        roomId: "42",
        role: "host",
        peerId: "host_peer_12345678",
        publicationGeneration,
        allowlistedRootPeerIds: [rootPeerId],
      }),
    );

    expect(claims.sub).toBe("host");
    expect(claims.exp! - claims.nbf!).toBe(5 * 60);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `screener-42-${publicationGeneration}`,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: ["screen_share", "screen_share_audio"],
    });
    expect(claims.roomConfig).toMatchObject({
      name: `screener-42-${publicationGeneration}`,
      maxParticipants: 9,
    });
  });

  it("issues a subscribe-only token to a current fallback root", async () => {
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      await issuer(3).issueToken({
        roomId: "7",
        role: "viewer",
        peerId: rootPeerId,
        publicationGeneration,
        allowlistedRootPeerIds: [rootPeerId],
      }),
    );

    expect(claims.sub).toBe(`viewer:${rootPeerId}`);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `screener-7-${publicationGeneration}`,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video?.canPublishSources).toBeUndefined();
    expect(claims.roomConfig?.maxParticipants).toBe(4);
  });

  it("does not issue viewer tokens outside the current root allowlist", async () => {
    await expect(
      issuer().issueToken({
        roomId: "7",
        role: "viewer",
        peerId: "viewer_other_12345678",
        publicationGeneration,
        allowlistedRootPeerIds: [rootPeerId],
      }),
    ).rejects.toThrow("viewer is not an allowlisted SFU root");
  });

  it("rejects duplicate, excessive, and malformed root allowlists", async () => {
    const tokenIssuer = issuer(1);
    const request = {
      roomId: "7",
      role: "host" as const,
      peerId: "host_peer_12345678",
      publicationGeneration,
    };

    await expect(
      tokenIssuer.issueToken({
        ...request,
        allowlistedRootPeerIds: [rootPeerId, rootPeerId],
      }),
    ).rejects.toThrow("root allowlist is invalid");
    await expect(
      issuer().issueToken({
        ...request,
        allowlistedRootPeerIds: [rootPeerId, rootPeerId],
      }),
    ).rejects.toThrow("root allowlist contains duplicates");
    await expect(
      issuer().issueToken({
        ...request,
        allowlistedRootPeerIds: ["not valid"],
      }),
    ).rejects.toThrow("root allowlist is invalid");
  });

  it("isolates publication generations in separate LiveKit rooms", async () => {
    const tokenIssuer = issuer();
    const verifier = new TokenVerifier(apiKey, apiSecret);
    const baseRequest = {
      roomId: "7",
      role: "host" as const,
      peerId: "host_peer_12345678",
      allowlistedRootPeerIds: [rootPeerId],
    };
    const first = await verifier.verify(
      await tokenIssuer.issueToken({
        ...baseRequest,
        publicationGeneration: "generation_first_12345678",
      }),
    );
    const second = await verifier.verify(
      await tokenIssuer.issueToken({
        ...baseRequest,
        publicationGeneration: "generation_second_12345678",
      }),
    );

    expect(first.video?.room).not.toBe(second.video?.room);
  });
});
