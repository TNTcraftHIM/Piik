import { describe, expect, it } from "vitest";

import { createIceConfig } from "../src/server/ice.ts";

describe("ordinary ICE configuration", () => {
  it("returns only the configured STUN servers", () => {
    expect(
      createIceConfig({
        stunUrls: [
          "stun:stun-a.example.test:3478",
          "stun:stun-b.example.test:3478",
        ],
      }),
    ).toEqual({
      iceServers: [
        {
          urls: [
            "stun:stun-a.example.test:3478",
            "stun:stun-b.example.test:3478",
          ],
        },
      ],
    });
  });

  it("keeps local development explicit when STUN is absent", () => {
    expect(createIceConfig({ stunUrls: [] })).toEqual({ iceServers: [] });
  });

  it("adds one authenticated TURN group and its bounded expiry", () => {
    expect(
      createIceConfig(
        { stunUrls: ["stun:stun.example.test:3478"] },
        {
          urls: ["turn:relay.example.test:3478?transport=udp"],
          username: `1787076000:${"a".repeat(32)}`,
          credential: "temporary-credential",
          expiresAt: "2026-08-20T12:00:00.000Z",
        },
      ),
    ).toEqual({
      iceServers: [
        { urls: ["stun:stun.example.test:3478"] },
        {
          urls: ["turn:relay.example.test:3478?transport=udp"],
          username: `1787076000:${"a".repeat(32)}`,
          credential: "temporary-credential",
        },
      ],
      turnCredentialsExpiresAt: "2026-08-20T12:00:00.000Z",
    });
  });
});
