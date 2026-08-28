import { describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";

import { LiveKitTokenIssuer } from "../src/server/livekit-token.ts";

const apiKey = "test-api-key";
const apiSecret = "s".repeat(32);
const publicationGeneration = "publication_12345678";
const shareGeneration = "share_generation_12345678";
const rootPeerId = "viewer_root_12345678";

function issuer(maxViewersPerRoom = 8): LiveKitTokenIssuer {
  return new LiveKitTokenIssuer({
    apiKey,
    apiSecret,
    maxViewersPerRoom,
  });
}

describe("LiveKitTokenIssuer", () => {
  it("issues a generation-bound host token limited to screen sharing", async () => {
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      await issuer().issueToken({
        roomId: "42",
        role: "host",
        peerId: "host_peer_12345678",
        shareGeneration,
        publicationGeneration,
      }),
    );

    expect(claims.sub).toBe("host");
    expect(claims.exp! - claims.nbf!).toBe(5 * 60);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `screener-v1.42.${shareGeneration}.${publicationGeneration}`,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: ["screen_share", "screen_share_audio"],
    });
    expect(claims.roomConfig).toBeUndefined();
  });

  it("issues a generation-bound subscribe-only Viewer token", async () => {
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      await issuer(3).issueToken({
        roomId: "7",
        role: "viewer",
        peerId: rootPeerId,
        shareGeneration,
        publicationGeneration,
      }),
    );

    expect(claims.sub).toBe(`viewer:${rootPeerId}`);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `screener-v1.7.${shareGeneration}.${publicationGeneration}`,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video?.canPublishSources).toBeUndefined();
    expect(claims.roomConfig).toBeUndefined();
  });

  it("isolates publication generations in separate LiveKit rooms", async () => {
    const tokenIssuer = issuer();
    const verifier = new TokenVerifier(apiKey, apiSecret);
    const baseRequest = {
      roomId: "7",
      role: "host" as const,
      peerId: "host_peer_12345678",
      shareGeneration,
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
