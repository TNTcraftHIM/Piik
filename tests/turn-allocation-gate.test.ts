import { describe, expect, it } from "vitest";

import { parseGateEnvironment, parseGateResult } from "../scripts/turn-allocation-gate";

describe("TURN UDP allocation gate", () => {
  it("parses credential input without truncating values containing equals", () => {
    expect(
      parseGateEnvironment(
        "SELECTED_EDGE_TURN_URLS=turn:relay.example:3478?transport=udp\n" +
          "SELECTED_EDGE_TURN_SHARED_SECRET=secret=value==\n",
      ),
    ).toEqual({
      SELECTED_EDGE_TURN_URLS: "turn:relay.example:3478?transport=udp",
      SELECTED_EDGE_TURN_SHARED_SECRET: "secret=value==",
    });
  });

  it("returns only allowlisted allocation fields from Chrome output", () => {
    const secret = "must-not-leak";
    const result = parseGateResult(
      '{"status":"passed","relayCandidateCount":1,"protocols":["udp","udp"],' +
        `"errorCodeBuckets":[],"credential":"${secret}"}`,
    );

    expect(result).toEqual({
      status: "passed",
      relayCandidateCount: 1,
      protocols: ["udp"],
      errorCodeBuckets: [],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects pending or raw Chrome output with a fixed message", () => {
    expect(() => parseGateResult('"pending"')).toThrow(
      "Chrome returned an invalid TURN allocation result",
    );
    expect(() => parseGateResult("credential=must-not-leak")).toThrow(
      "Chrome returned an invalid TURN allocation result",
    );
    expect(() => parseGateResult(
      '{"status":"passed","relayCandidateCount":0,"protocols":[],"errorCodeBuckets":[]}',
    )).toThrow("Chrome returned an invalid TURN allocation result");
    expect(() => parseGateResult(
      '{"status":"passed","relayCandidateCount":1,"protocols":["tcp"],"errorCodeBuckets":[]}',
    )).toThrow("Chrome returned an invalid TURN allocation result");
  });
});
