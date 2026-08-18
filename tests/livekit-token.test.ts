import { describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";

import { LiveKitTokenIssuer } from "../src/server/livekit-token.ts";

const apiKey = "test-api-key";
const apiSecret = "s".repeat(32);

describe("LiveKitTokenIssuer", () => {
  it("issues a five-minute host token limited to screen-share publishing", async () => {
    const issuer = new LiveKitTokenIssuer({
      apiKey,
      apiSecret,
      maxViewersPerRoom: 8,
    });
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      await issuer.issueToken({
        roomId: "42",
        role: "host",
        peerId: "host_peer_12345678",
      }),
    );

    expect(claims.sub).toBe("host");
    expect(claims.exp! - claims.nbf!).toBe(5 * 60);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: "screener-42",
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
      canPublishSources: ["screen_share", "screen_share_audio"],
    });
    expect(claims.roomConfig).toMatchObject({
      name: "screener-42",
      maxParticipants: 9,
    });
  });

  it("issues a viewer token that can subscribe but cannot publish", async () => {
    const issuer = new LiveKitTokenIssuer({
      apiKey,
      apiSecret,
      maxViewersPerRoom: 3,
    });
    const claims = await new TokenVerifier(apiKey, apiSecret).verify(
      await issuer.issueToken({
        roomId: "7",
        role: "viewer",
        peerId: "viewer_peer_12345678",
      }),
    );

    expect(claims.sub).toBe("viewer:viewer_peer_12345678");
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: "screener-7",
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(claims.video?.canPublishSources).toBeUndefined();
    expect(claims.roomConfig?.maxParticipants).toBe(4);
  });
});
