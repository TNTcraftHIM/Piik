import { describe, expect, it } from "vitest";

import {
  detectBrowserRelayCapacity,
  relayCapacityMessageForBrowser,
} from "../src/client/media/relay-capability.ts";

const desktop = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  userAgentDataMobile: false,
  maxTouchPoints: 0,
};

describe("browser relay capability", () => {
  it("allows one downstream edge on a desktop browser", () => {
    expect(detectBrowserRelayCapacity(desktop)).toBe(1);
    expect(relayCapacityMessageForBrowser(true, desktop)).toEqual({
      type: "relay-capacity",
      downstreamEdges: 1,
    });
  });

  it.each([
    {
      userAgent: desktop.userAgent,
      userAgentDataMobile: true,
      maxTouchPoints: 0,
    },
    {
      userAgent: "Mozilla/5.0 (Linux; Android 16; Mobile)",
      userAgentDataMobile: false,
      maxTouchPoints: 5,
    },
    {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)",
      maxTouchPoints: 5,
    },
    {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      userAgentDataMobile: false,
      maxTouchPoints: 5,
    },
  ])("keeps mobile and touch iPadOS browsers as leaves", (environment) => {
    expect(detectBrowserRelayCapacity(environment)).toBe(0);
  });

  it("does not create a relay message for ordinary P2P", () => {
    expect(relayCapacityMessageForBrowser(false)).toBeNull();
  });
});
