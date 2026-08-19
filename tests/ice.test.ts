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
});
