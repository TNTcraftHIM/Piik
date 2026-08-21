import { describe, expect, it } from "vitest";

import {
  relayCapacityMessageForBrowser,
} from "../src/client/media/relay-capability.ts";

describe("browser relay capability", () => {
  it("advertises the current one-child browser release capacity", () => {
    expect(relayCapacityMessageForBrowser(true)).toEqual({
      type: "relay-capacity",
      downstreamEdges: 1,
    });
  });

  it("does not create a relay message for ordinary P2P", () => {
    expect(relayCapacityMessageForBrowser(false)).toBeNull();
  });
});
