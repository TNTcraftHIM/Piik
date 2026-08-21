import { describe, expect, it } from "vitest";

import {
  relayCapacityMessageForBrowser,
} from "../src/client/media/relay-capability.ts";

describe("browser relay capability", () => {
  it("allows two downstream edges on a peer-assisted Web viewer", () => {
    expect(relayCapacityMessageForBrowser(true)).toEqual({
      type: "relay-capacity",
      downstreamEdges: 2,
    });
  });

  it("does not create a relay message for ordinary P2P", () => {
    expect(relayCapacityMessageForBrowser(false)).toBeNull();
  });
});
