import { describe, expect, it } from "vitest";

import { decodeClientEndpoint } from "../scripts/client-gate-endpoint";

describe("Client gate endpoint decoder", () => {
  const endpoint = {
    url: "http://127.0.0.1:39721",
    host: "127.0.0.1:39721",
    port: 39_721,
    instanceToken: "a".repeat(43),
  };

  it("accepts the one exact loopback endpoint shape", () => {
    expect(decodeClientEndpoint(JSON.stringify(endpoint))).toEqual(endpoint);
  });

  it("rejects partial, inconsistent, extended, and malformed endpoints", () => {
    for (const value of [
      { ...endpoint, host: "localhost:39721" },
      { ...endpoint, port: 40_000 },
      { ...endpoint, instanceToken: "short" },
      { ...endpoint, extra: true },
      { port: endpoint.port, instanceToken: endpoint.instanceToken },
    ]) {
      expect(() => decodeClientEndpoint(JSON.stringify(value))).toThrow(
        "Client endpoint is invalid",
      );
    }
    expect(() => decodeClientEndpoint("not-json")).toThrow(
      "Client endpoint is invalid",
    );
  });
});
