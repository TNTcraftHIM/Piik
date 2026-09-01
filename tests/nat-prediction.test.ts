import { describe, expect, it } from "vitest";

import {
  iceServersWithNatPrediction,
  MAX_NAT_PREDICTION_CANDIDATES,
  NatPredictionCandidateBatch,
  predictSrflxCandidates,
  type SignalCandidate,
} from "../src/client/webrtc/nat-prediction.ts";

function candidate(port: number, address = "203.0.113.7"): SignalCandidate {
  return {
    candidate:
      `candidate:base 1 udp 2122260223 ${address} ${port} ` +
      "typ srflx raddr 192.0.2.7 rport 50000 generation 0 ufrag test",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "test",
  };
}

function hostCandidate(): SignalCandidate {
  return {
    candidate:
      "candidate:host 1 udp 2122260223 192.0.2.7 50000 typ host generation 0 ufrag test",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "test",
  };
}

function portOf(value: SignalCandidate): number {
  return Number(value?.candidate.trim().split(/\s+/)[5]);
}

describe("NAT prediction ICE adapter", () => {
  it("leaves the configured servers unchanged when disabled", () => {
    const servers = [
      { urls: ["stun:share.example.test:3478"] },
      { urls: "stun:other.example.test:5349" },
    ];

    expect(iceServersWithNatPrediction(servers, false)).toEqual(servers);
  });

  it("derives only the two optional same-host survey listeners", () => {
    const servers = [
      { urls: ["stun:share.example.test:3478", "stun:share.example.test:3478"] },
      { urls: "stun:other.example.test:3478" },
    ];

    expect(iceServersWithNatPrediction(servers, true)).toEqual([
      ...servers,
      { urls: "stun:share.example.test:3479" },
      { urls: "stun:share.example.test:3480" },
    ]);
  });

  it("does not duplicate already configured auxiliary listeners", () => {
    const servers = [
      { urls: "stun:share.example.test:3478" },
      { urls: "stun:share.example.test:3479" },
    ];

    expect(iceServersWithNatPrediction(servers, true)).toEqual([
      ...servers,
      { urls: "stun:share.example.test:3480" },
    ]);
  });

  it("predicts a bounded two-sided window for a stable arithmetic shape", () => {
    const predictions = predictSrflxCandidates([
      candidate(40_000),
      candidate(40_003),
      candidate(40_006),
    ]);

    expect(predictions.length).toBeLessThanOrEqual(
      MAX_NAT_PREDICTION_CANDIDATES,
    );
    expect(predictions.map(portOf)).toEqual(
      expect.arrayContaining([40_009, 39_997]),
    );
    expect(predictions.every((value) => value?.sdpMid === "0")).toBe(true);
  });

  it("does not predict an unstable or incomplete mapping shape", () => {
    expect(predictSrflxCandidates([candidate(40_000), candidate(40_001)])).toEqual(
      [],
    );
    expect(
      predictSrflxCandidates([
        candidate(40_000),
        candidate(40_003),
        candidate(40_011),
      ]),
    ).toEqual([]);
  });

  it("sends predictions before held srflx candidates while retaining every one", () => {
    const sent: Array<SignalCandidate | null> = [];
    const batch = new NatPredictionCandidateBatch((value) => sent.push(value));
    const first = candidate(40_000);
    const second = candidate(40_003);
    const third = candidate(40_006);

    batch.add(hostCandidate());
    batch.add(first);
    batch.add(second);
    batch.add(third);
    batch.complete();
    batch.complete();

    expect(sent[0]).toEqual(hostCandidate());
    const firstOriginal = sent.indexOf(first);
    const firstPrediction = sent.findIndex(
      (value) => value?.candidate.includes("candidate:s") ?? false,
    );
    expect(firstPrediction).toBeGreaterThanOrEqual(1);
    expect(firstPrediction).toBeLessThan(firstOriginal);
    expect(sent.filter((value) => value === first)).toHaveLength(1);
    expect(sent.filter((value) => value === second)).toHaveLength(1);
    expect(sent.filter((value) => value === third)).toHaveLength(1);
    expect(sent.at(-1)).toBeNull();
  });

  it("flushes ordinary candidates without inventing a prediction", () => {
    const sent: Array<SignalCandidate | null> = [];
    const batch = new NatPredictionCandidateBatch((value) => sent.push(value));
    const first = candidate(40_000);
    const second = candidate(40_007);

    batch.add(first);
    batch.add(second);
    batch.complete();

    expect(sent).toEqual([first, second, null]);
  });
});
