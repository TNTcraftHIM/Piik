import { describe, expect, it } from "vitest";

import {
  relayCapacityMessageForBrowser,
} from "../src/client/media/relay-capability.ts";

describe("browser relay capability", () => {
  it("advertises the endpoint capability envelope without a Browser tier", () => {
    expect(relayCapacityMessageForBrowser(true)).toEqual({
      type: "relay-capacity",
      downstreamEdges: 3,
    });
  });

  it("does not create a relay message for ordinary P2P", () => {
    expect(relayCapacityMessageForBrowser(false)).toBeNull();
  });
});
