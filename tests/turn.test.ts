import { describe, expect, it } from "vitest";

import { createIceConfig, createTurnCredentials } from "../src/server/turn.ts";

describe("TURN credentials", () => {
  it("matches a fixed coturn REST HMAC-SHA1 vector", () => {
    expect(
      createTurnCredentials("test-secret", "room_peer", 3_600, 1_700_000_000_000),
    ).toEqual({
      username: "1700003600:room_peer",
      credential: "h3+0FAYKf7T7n49pOZborViEEVQ=",
      expiresAt: "2023-11-14T23:13:20.000Z",
    });
  });

  it("does not issue credentials beyond room expiry", () => {
    const now = 1_700_000_000_000;
    const credentials = createTurnCredentials(
      "test-secret",
      "room_peer",
      3_600,
      now,
      now + 600_000,
    );

    expect(credentials.username).toBe("1700000600:room_peer");
    expect(Date.parse(credentials.expiresAt)).toBe(now + 600_000);
  });

  it("returns an explicit STUN-only configuration when TURN is absent", () => {
    expect(
      createIceConfig(
        {
          stunUrls: ["stun:stun.example.test:3478"],
          turnUrls: [],
          credentialTtlSeconds: 3_600,
        },
        "subject",
      ),
    ).toEqual({
      iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
      expiresAt: null,
      relayAvailable: false,
    });
  });

  it("does not advertise unusable relay credentials in the final room second", () => {
    const now = 1_700_000_000_900;
    expect(
      createIceConfig(
        {
          stunUrls: [],
          turnUrls: ["turn:turn.example.test:3478"],
          turnSharedSecret: "test-secret",
          credentialTtlSeconds: 3_600,
        },
        "subject",
        now,
        now + 50,
      ),
    ).toEqual({ iceServers: [], expiresAt: null, relayAvailable: false });
  });
});
