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
        natPredictionEnabled: true,
        natPredictionStunUrls: [
          "stun:survey-a.example.test:3478",
          "stun:survey-b.example.test:3478",
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
      natPredictionStunUrls: [
        "stun:survey-a.example.test:3478",
        "stun:survey-b.example.test:3478",
      ],
    });
  });

  it("keeps local development explicit when STUN is absent", () => {
    expect(
      createIceConfig({ stunUrls: [], natPredictionEnabled: false }),
    ).toEqual({ iceServers: [], natPredictionStunUrls: [] });
  });

  it("does not expose auxiliary listeners when the capability is disabled", () => {
    expect(
      createIceConfig({
        stunUrls: ["stun:share.example.test:3478"],
        natPredictionEnabled: false,
      }),
    ).toEqual({
      iceServers: [{ urls: ["stun:share.example.test:3478"] }],
      natPredictionStunUrls: [],
    });
  });

  it("derives auxiliary listeners from an IPv6 STUN authority", () => {
    expect(
      createIceConfig({
        stunUrls: ["STUN:[2001:db8::1]:3478"],
        natPredictionEnabled: true,
      }).natPredictionStunUrls,
    ).toEqual([
      "stun:[2001:db8::1]:3479",
      "stun:[2001:db8::1]:3480",
    ]);
  });
});
