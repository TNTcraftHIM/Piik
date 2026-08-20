import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { issuePeerIceTurnGrant } from "../src/server/peer-ice-turn.ts";

const config = {
  urls: ["turn:relay.example.test:3478?transport=udp"],
  sharedSecret: "turn-test-secret-that-is-at-least-32-bytes",
  credentialTtlSeconds: 300,
} as const;

describe("Peer ICE TURN credential issuer", () => {
  it("issues coturn REST credentials with an opaque participant-session bearer", () => {
    const nowMs = Date.parse("2026-08-20T12:00:00.500Z");
    const grant = issuePeerIceTurnGrant(
      config,
      {
        roomId: "123456789012",
        role: "viewer",
        peerId: "viewer_12345678",
        sessionId: "session_12345678",
      },
      nowMs,
    );

    expect(grant.urls).toEqual(config.urls);
    expect(grant.expiresAtMs).toBe(
      Math.floor(nowMs / 1_000) * 1_000 + 300_000,
    );
    expect(grant.expiresAt).toBe(new Date(grant.expiresAtMs).toISOString());
    expect(grant.username).toMatch(/^[1-9]\d{9}:[A-Za-z0-9_-]{32}$/);
    expect(grant.username).not.toContain("123456789012");
    expect(grant.username).not.toContain("viewer_12345678");
    expect(grant.credential).toBe(
      createHmac("sha1", config.sharedSecret)
        .update(grant.username)
        .digest("base64"),
    );
  });

  it("changes the opaque bearer across sessions and issuance windows", () => {
    const identity = {
      roomId: "1",
      role: "host" as const,
      peerId: "host_12345678",
      sessionId: "session_12345678",
    };
    const first = issuePeerIceTurnGrant(config, identity, 1_000_000);
    const otherSession = issuePeerIceTurnGrant(
      config,
      { ...identity, sessionId: "session_87654321" },
      1_000_000,
    );
    const later = issuePeerIceTurnGrant(config, identity, 1_001_000);

    expect(otherSession.username).not.toBe(first.username);
    expect(later.username).not.toBe(first.username);
    expect(() => issuePeerIceTurnGrant(config, identity, Number.NaN)).toThrow(
      "grant time is invalid",
    );
  });
});
