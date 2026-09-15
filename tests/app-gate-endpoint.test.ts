import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  decodeAppEndpoint,
  readAppEndpoint,
} from "../scripts/app-gate-endpoint";

describe("App gate endpoint decoder", () => {
  const endpoint = {
    url: "http://127.0.0.1:39721",
    host: "127.0.0.1:39721",
    port: 39_721,
    instanceToken: "a".repeat(43),
  };

  it("accepts the one exact loopback endpoint shape", () => {
    expect(decodeAppEndpoint(JSON.stringify(endpoint))).toEqual(endpoint);
  });

  it("rejects partial, inconsistent, extended, and malformed endpoints", () => {
    for (const value of [
      { ...endpoint, host: "localhost:39721" },
      { ...endpoint, port: 40_000 },
      { ...endpoint, instanceToken: "short" },
      { ...endpoint, extra: true },
      { port: endpoint.port, instanceToken: endpoint.instanceToken },
    ]) {
      expect(() => decodeAppEndpoint(JSON.stringify(value))).toThrow(
        "App endpoint is invalid",
      );
    }
    expect(() => decodeAppEndpoint("not-json")).toThrow(
      "App endpoint is invalid",
    );
  });

  it("reads an endpoint after optional App status lines", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout }) as unknown as
      ChildProcessWithoutNullStreams;
    const result = readAppEndpoint(child, {
      ignoreNonEndpointLines: true,
    });
    stdout.write("Local access: open\n");
    stdout.write(`${JSON.stringify(endpoint)}\n`);
    await expect(result).resolves.toEqual(endpoint);
  });
});
