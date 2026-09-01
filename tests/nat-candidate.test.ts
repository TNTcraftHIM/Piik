import { describe, expect, it } from "vitest";

import {
  candidateSignalOrigin,
  isPredictedCandidateFoundation,
} from "../src/shared/nat-candidate.ts";

describe("NAT candidate diagnostics", () => {
  it("recognizes only the bounded synthetic foundation namespace", () => {
    expect(isPredictedCandidateFoundation("sp1")).toBe(true);
    expect(isPredictedCandidateFoundation("sm4")).toBe(true);
    expect(isPredictedCandidateFoundation("base")).toBe(false);
    expect(isPredictedCandidateFoundation(null)).toBe(false);
  });

  it("classifies candidate signals without retaining endpoint data", () => {
    expect(candidateSignalOrigin(null)).toBe("end");
    expect(candidateSignalOrigin(" ")).toBe("end");
    expect(
      candidateSignalOrigin(
        "candidate:sp2 1 udp 1 203.0.113.1 50000 typ srflx",
      ),
    ).toBe("predicted");
    expect(
      candidateSignalOrigin(
        "candidate:base 1 udp 1 203.0.113.1 50000 typ srflx",
      ),
    ).toBe("ordinary");
  });
});
