import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  decodeClientEndpoint,
  readClientEndpoint,
} from "../scripts/client-gate-endpoint";

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

  it("reads an endpoint after optional client status lines", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout }) as unknown as
      ChildProcessWithoutNullStreams;
    const result = readClientEndpoint(child, {
      ignoreNonEndpointLines: true,
    });
    stdout.write("Local access: open\n");
    stdout.write(`${JSON.stringify(endpoint)}\n`);
    await expect(result).resolves.toEqual(endpoint);
  });
});
