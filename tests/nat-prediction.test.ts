import { describe, expect, it } from "vitest";

import {
  iceServersWithNatPrediction,
  MAX_NAT_PREDICTION_CANDIDATES,
  NatPredictionCandidateBatch,
  NatPredictionCandidateEmitter,
  natPredictionSurveyUrls,
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

function rtcCandidate(port: number): RTCIceCandidate {
  return {
    ...candidate(port),
  } as unknown as RTCIceCandidate;
}

describe("NAT prediction ICE adapter", () => {
  it("leaves the configured servers unchanged when disabled", () => {
    const servers = [
      { urls: ["stun:share.example.test:3478"] },
      { urls: "stun:other.example.test:5349" },
    ];

    expect(
      iceServersWithNatPrediction(
        servers,
        false,
        ["stun:observer.example.test:3478"],
      ),
    ).toEqual(servers);
  });

  it("adds independent observers only inside the enabled experiment", () => {
    const servers = [{ urls: "stun:share.example.test:3478" }];

    expect(
      iceServersWithNatPrediction(servers, true, [
        "stun:observer.example.test:3478",
      ]),
    ).toEqual([
      ...servers,
      { urls: "stun:share.example.test:3479" },
      { urls: "stun:share.example.test:3480" },
      { urls: "stun:observer.example.test:3478" },
    ]);
    expect(
      natPredictionSurveyUrls(servers),
    ).toEqual(
      new Set([
        "stun:share.example.test:3478",
        "stun:share.example.test:3479",
        "stun:share.example.test:3480",
      ]),
    );
    expect(
      natPredictionSurveyUrls([
        { urls: "stun:share.example.test:5349" },
      ]),
    ).toEqual(new Set());
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

  it("anchors on the port sequence extreme when responses arrive reversed", () => {
    const predictions = predictSrflxCandidates([
      candidate(40_006),
      candidate(40_003),
      candidate(40_000),
    ]);

    expect(predictions.map(portOf)).toEqual(
      expect.arrayContaining([40_009, 39_997]),
    );
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

  it("appends predictions without delaying or replacing ordinary candidates", () => {
    const sent: Array<SignalCandidate | null> = [];
    const batch = new NatPredictionCandidateBatch((value) => sent.push(value));
    const first = candidate(40_000);
    const second = candidate(40_003);
    const third = candidate(40_006);

    batch.add(hostCandidate());
    batch.add(first);
    batch.add(second);
    expect(sent).toEqual([hostCandidate(), first, second]);
    batch.add(third);
    batch.complete();
    batch.complete();

    expect(sent[0]).toEqual(hostCandidate());
    const firstPrediction = sent.findIndex(
      (value) => value?.candidate.includes("candidate:s") ?? false,
    );
    expect(firstPrediction).toBeGreaterThan(sent.indexOf(second));
    expect(firstPrediction).toBeLessThan(sent.indexOf(third));
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

  it("does not wait for auxiliary gathering before sending stock srflx", () => {
    const sent: Array<SignalCandidate | null> = [];
    const batch = new NatPredictionCandidateBatch((value) => sent.push(value));
    const first = candidate(40_000);

    batch.add(first);

    expect(sent).toEqual([first]);
  });

  it("retains independent observations without using them as sequence evidence", () => {
    const sent: Array<SignalCandidate | null> = [];
    const batch = new NatPredictionCandidateBatch((value) => sent.push(value));
    const external = candidate(50_000);

    batch.add(external, false);
    batch.add(candidate(40_000));
    batch.add(candidate(40_003));
    batch.add(candidate(40_006));

    expect(sent[0]).toEqual(external);
    expect(
      sent.some((value) => value?.candidate.startsWith("candidate:sp")),
    ).toBe(true);
  });

  it("does not predict when the Browser omits candidate source URLs", () => {
    const sent: Array<SignalCandidate | null> = [];
    const emitter = new NatPredictionCandidateEmitter(
      true,
      (value) => sent.push(value),
      new Set([
        "stun:share.example.test:3478",
        "stun:share.example.test:3479",
        "stun:share.example.test:3480",
      ]),
    );

    emitter.add(rtcCandidate(40_000));
    emitter.add(rtcCandidate(40_003));
    emitter.add(rtcCandidate(40_006));
    emitter.gatheringComplete();

    expect(
      sent.some((value) => value?.candidate.startsWith("candidate:sp")),
    ).toBe(false);
    expect(sent.filter((value) => value !== null)).toHaveLength(3);
  });
});
