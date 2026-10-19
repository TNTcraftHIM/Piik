import { describe, expect, it, vi } from "vitest";
import { punchIceConfig } from "../src/client/native/native-punch";

import {
  addRemoteIceCandidate,
  iceServersWithNatPrediction,
  isNativeNatSurveyCandidate,
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
  it("uses only explicit Native survey candidates as prediction evidence", () => {
    const iceConfig = {
      iceServers: [{ urls: ["stun:share.example.test:3478", "stun:other.example.test:3478"] }],
      natPredictionStunUrls: ["stun:share.example.test:3479", "stun:share.example.test:3480"],
    };
    const survey = candidate(40_000);
    if (survey) {
      survey.candidate = survey.candidate.replace(
        "candidate:base",
        "candidate:ns1",
      );
    }

    const eligible = (value: SignalCandidate) => isNativeNatSurveyCandidate(value, iceConfig.iceServers, iceConfig.natPredictionStunUrls);
    expect(eligible(survey)).toBe(true);
    for (const [index, expected] of [[2, false], [3, true], [4, true], [5, false], [0, false]] as const) {
      expect(eligible({ candidate: `candidate:ns${index} 1 udp 1 203.0.113.7 40000 typ srflx` })).toBe(expected);
    }
    expect(eligible(candidate(40_000))).toBe(false);
    expect(eligible(hostCandidate())).toBe(false);
  });

  it.each([
    { surveyPorts: [40_000, 40_003, 40_006], predictions: MAX_NAT_PREDICTION_CANDIDATES },
    { surveyPorts: [40_000, 40_000, 40_000], predictions: 0 },
  ])("retains survey identity before mapping deduplication: $surveyPorts", ({ surveyPorts, predictions }) => {
    const iceServers = [{ urls: ["stun:share.example.test:3478", "stun:other.example.test:3478"] }];
    const auxiliary = ["stun:share.example.test:3479", "stun:share.example.test:3480"];
    const send = vi.fn<(candidate: SignalCandidate) => void>();
    const batch = new NatPredictionCandidateBatch(send);
    // A faster ordinary destination shares the first survey mapping. All
    // destinations reach ICE, but only the actual survey can prove a pattern.
    const observations = [[2, 40_000], [1, surveyPorts[0]], [3, surveyPorts[1]], [4, surveyPorts[2]]];
    for (const [index, port] of observations) {
      const observation = candidate(port!)!;
      observation.candidate = observation.candidate.replace("candidate:base", `candidate:ns${index}`);
      batch.add(observation, isNativeNatSurveyCandidate(observation, iceServers, auxiliary));
    }
    batch.complete();
    const emitted = send.mock.calls.map(([value]) => value);
    expect(emitted.filter(value => /^candidate:ns/.test(value?.candidate ?? ""))).toHaveLength(4);
    expect(emitted.filter(value => /^candidate:s[pm]/.test(value?.candidate ?? ""))).toHaveLength(predictions);
    expect(emitted.at(-1)).toBeNull();
  });

  it("keeps unexpected ordinary-candidate failures visible", async () => {
    const error = new Error("candidate rejected");
    const connection = {
      addIceCandidate: vi.fn(async () => {
        throw error;
      }),
    } as unknown as RTCPeerConnection;
    const predicted = candidate(40_000);
    if (predicted) {
      predicted.candidate = predicted.candidate.replace(
        "candidate:base",
        "candidate:sp1",
      );
    }

    await expect(
      addRemoteIceCandidate(connection, predicted),
    ).resolves.toBeUndefined();
    await expect(
      addRemoteIceCandidate(connection, candidate(40_000)),
    ).rejects.toBe(error);
    await expect(addRemoteIceCandidate(connection, null)).rejects.toBe(error);
  });

  it("isolates candidate rejection without hiding a missing remote description", async () => {
    const connection = { addIceCandidate: vi.fn() } as unknown as RTCPeerConnection;
    vi.mocked(connection.addIceCandidate).mockRejectedValueOnce(new DOMException("Rejected", "OperationError"));
    await expect(addRemoteIceCandidate(connection, candidate(40_000))).resolves.toBeUndefined();
    const error = new DOMException("Remote description is missing", "InvalidStateError");
    vi.mocked(connection.addIceCandidate).mockRejectedValueOnce(error);
    await expect(addRemoteIceCandidate(connection, candidate(40_000))).rejects.toBe(error);
  });

  it("leaves the configured servers unchanged when disabled", () => {
    const servers = [
      { urls: ["stun:share.example.test:3478"] },
      { urls: "stun:other.example.test:5349" },
    ];

    expect(
      iceServersWithNatPrediction(
        servers,
        false,
        [
          "stun:share.example.test:3479",
          "stun:share.example.test:3480",
        ],
      ),
    ).toEqual(servers);
  });

  it("adds only the configured survey destinations", () => {
    const servers = [{ urls: "stun:share.example.test:3478" }];
    const auxiliary = [
      "stun:survey-a.example.test:3478",
      "stun:survey-b.example.test:3478",
    ];

    expect(
      iceServersWithNatPrediction(servers, true, auxiliary),
    ).toEqual([
      ...servers,
      { urls: "stun:survey-a.example.test:3478" },
      { urls: "stun:survey-b.example.test:3478" },
    ]);
    expect(
      natPredictionSurveyUrls(servers, auxiliary),
    ).toEqual(
      new Set([
        "stun:share.example.test:3478",
        "stun:survey-a.example.test:3478",
        "stun:survey-b.example.test:3478",
      ]),
    );
    expect(
      natPredictionSurveyUrls([
        { urls: "stun:share.example.test:5349" },
      ], auxiliary),
    ).toEqual(new Set([
      "stun:share.example.test:5349",
      ...auxiliary,
    ]));
  });

  it("does not invent auxiliary listeners that the server did not enable", () => {
    const servers = [
      { urls: ["stun:share.example.test:3478", "stun:share.example.test:3478"] },
      { urls: "stun:other.example.test:3478" },
    ];

    expect(iceServersWithNatPrediction(servers, true)).toEqual(servers);
    expect(natPredictionSurveyUrls(servers)).toEqual(new Set());
  });

  it("retains ordinary fallback discovery independently of prediction", () => {
    const urls = ["stun:primary.test:3478", "stun:fallback-a.test:3478", "stun:fallback-b.test:3478"];
    const servers = [{ urls }];
    const auxiliary = urls.slice(1);
    for (const enabled of [false, true]) {
      expect(iceServersWithNatPrediction(servers, enabled, auxiliary)).toEqual(servers);
    }
    expect(natPredictionSurveyUrls(servers, auxiliary)).toEqual(new Set(urls));
  });

  it("keeps auxiliary discovery entries from replacing the ordinary base", () => {
    const auxiliary = ["stun:site.test:3479", "stun:site.test:3480"];
    const urls = [...auxiliary, "stun:site.test:3478"];
    expect(natPredictionSurveyUrls([{ urls }], auxiliary)).toEqual(new Set([
      "stun:site.test:3478", ...auxiliary,
    ]));
    expect(natPredictionSurveyUrls([{ urls: auxiliary }], auxiliary)).toEqual(new Set());
  });

  it.each([
    ["stun:site.test:3479", "stun:site.test:3480"],
    ["stun:survey-a.test:3478", "stun:survey-b.test:3478"],
  ])("preserves the published base choice with non-default discovery first: %s", (...auxiliary) => {
    const servers = [{ urls: ["stun:discovery.test:19302", "stun:site.test:3478"] }];
    expect(natPredictionSurveyUrls(servers, auxiliary)).toEqual(new Set([
      "stun:site.test:3478", ...auxiliary,
    ]));
  });

  it("uses a non-default base when the remaining discovery URLs are the survey pair", () => {
    const urls = ["stun:primary.test:19302", "stun:survey-a.test:3478", "stun:survey-b.test:3478"];
    const servers = [{ urls }];
    const auxiliary = urls.slice(1, 3);
    expect(natPredictionSurveyUrls(servers, auxiliary)).toEqual(new Set(urls.slice(0, 3)));
    expect(punchIceConfig({ iceServers: servers, natPredictionStunUrls: auxiliary })).toEqual({
      iceServers: [{ urls: urls.slice(0, 3) }],
    });

    const send = vi.fn<(candidate: SignalCandidate) => void>();
    const batch = new NatPredictionCandidateBatch(send);
    for (const [index, port] of [[1, 40_000], [2, 40_003], [3, 40_006]]) {
      const observation = candidate(port!)!;
      observation.candidate = observation.candidate.replace("candidate:base", `candidate:ns${index}`);
      const eligible = isNativeNatSurveyCandidate(observation, servers, auxiliary);
      expect(eligible).toBe(true);
      batch.add(observation, eligible);
    }
    batch.complete();
    const emitted = send.mock.calls.map(([value]) => value);
    expect(emitted.filter(value => /^candidate:ns/.test(value?.candidate ?? ""))).toHaveLength(3);
    expect(emitted.filter(value => /^candidate:s[pm]/.test(value?.candidate ?? ""))).toHaveLength(MAX_NAT_PREDICTION_CANDIDATES);
    expect(emitted.at(-1)).toBeNull();
  });

  it.each([
    ["stun:Share.TEST", "stun:share.test:3478"],
    ["STUN:Share.TEST:03478", "stun:share.test:3478"],
    ["stun:[2001:DB8::1]:3478", "stun:[2001:db8::1]:3478"],
    ["stun:share.test:80", "stun:share.test:80"],
    ["stun:share.test:00080", "stun:share.test:80"],
    ["stun:share.test:443", "stun:share.test:443"],
  ] as const)("preserves the STUN port in survey membership for %s", (url, base) => {
    const auxiliary = ["stun:survey.test:80", "stun:survey.test:443"];
    expect(natPredictionSurveyUrls([{ urls: url }], auxiliary)).toEqual(
      new Set([base, ...auxiliary]),
    );
  });

  it("keeps a port-80 auxiliary distinct from the ordinary base endpoint", () => {
    const servers = [{ urls: "stun:share.test:3478" }];
    expect(iceServersWithNatPrediction(servers, true, [
      "stun:share.test:00080",
      "stun:share.test:3480",
    ])).toEqual([
      ...servers,
      { urls: "stun:share.test:00080" },
      { urls: "stun:share.test:3480" },
    ]);
  });

  it("does not duplicate already configured auxiliary listeners", () => {
    const servers = [
      { urls: "stun:share.example.test:3478" },
      { urls: "stun:share.example.test:3479" },
    ];

    expect(iceServersWithNatPrediction(servers, true, [
      "stun:share.example.test:3479",
      "stun:share.example.test:3480",
    ])).toEqual([
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

    expect(predictions).toHaveLength(MAX_NAT_PREDICTION_CANDIDATES);
    expect(predictions.map(portOf)).toEqual([
      40_009,
      40_012,
      40_015,
      40_018,
      39_997,
      39_994,
      39_991,
      39_988,
    ]);
    expect(predictions.every((value) => value?.sdpMid === "0")).toBe(true);
  });

  it("anchors on the port sequence extreme when responses arrive reversed", () => {
    const predictions = predictSrflxCandidates([
      candidate(40_006),
      candidate(40_003),
      candidate(40_000),
    ]);

    expect(predictions.map(portOf)).toEqual([
      40_009,
      40_012,
      40_015,
      40_018,
      39_997,
      39_994,
      39_991,
      39_988,
    ]);
  });

  it.each([
    ["component", "base 1 udp", "base 2 udp"],
    ["address", "raddr 192.0.2.7", "raddr 192.0.2.8"],
    ["port", "rport 50000", "rport 50001"],
  ] as const)("keeps the prediction budget when a different base %s interrupts the survey", (_, from, to) => {
    const sent: SignalCandidate[] = [];
    const batch = new NatPredictionCandidateBatch(value => sent.push(value));
    const first = candidate(40_000)!;
    const second = candidate(40_003)!;
    const third = candidate(40_006)!;
    const unrelated = { ...third, candidate: third.candidate.replace(from, to) };
    batch.add(first);
    batch.add(second);
    batch.add(unrelated);
    expect(sent).toEqual([first, second, unrelated]);

    // A later observation from the original base can still use this
    // generation's budget; the unrelated one must not consume it first.
    batch.add(third);
    expect(sent.filter(value => /^candidate:s[pm]/.test(value?.candidate ?? "")))
      .toHaveLength(MAX_NAT_PREDICTION_CANDIDATES);
    expect(sent.filter(value => !/^candidate:s[pm]/.test(value?.candidate ?? "")))
      .toEqual([first, second, unrelated, third]);
  });

  it("retains bounded prediction when the Browser conceals related addresses", () => {
    const concealed = [40_000, 40_003, 40_006].map(port => {
      const value = candidate(port)!;
      return { ...value, candidate: value.candidate.replace("raddr 192.0.2.7 rport 50000", "raddr 0.0.0.0 rport 0") };
    });
    expect(predictSrflxCandidates(concealed)).toHaveLength(MAX_NAT_PREDICTION_CANDIDATES);
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

  it("forwards an ineligible srflx candidate without using it as sequence evidence", () => {
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
        "stun:survey-a.example.test:3478",
        "stun:survey-b.example.test:3478",
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

  it("retires an unfinished generation without ending the restarted ICE session", () => {
    const sent: SignalCandidate[] = [];
    const survey = [
      "stun:share.example.test:19302",
      "stun:survey-a.example.test:3478",
      "stun:survey-b.example.test:3478",
    ];
    const emitter = new NatPredictionCandidateEmitter(
      true,
      (value) => sent.push(value),
      natPredictionSurveyUrls([{ urls: survey }], survey.slice(1)),
    );
    const emit = (port: number, usernameFragment: string, url: string) => {
      emitter.add({
        ...candidate(port),
        usernameFragment,
        url,
      } as unknown as RTCIceCandidate);
    };

    emit(40_000, "previous", survey[0]!);
    emit(40_003, "previous", survey[1]!);
    emit(40_006, "restarted", survey[0]!);
    expect(sent).toHaveLength(3);
    expect(sent.every((value) => value !== null)).toBe(true);

    emit(40_009, "restarted", survey[1]!);
    emit(40_012, "restarted", survey[2]!);
    const predictions = sent.filter((value) =>
      value?.candidate.startsWith("candidate:sp") ||
      value?.candidate.startsWith("candidate:sm"),
    );
    expect(predictions).toHaveLength(MAX_NAT_PREDICTION_CANDIDATES);
    expect(predictions.every((value) => value?.usernameFragment === "restarted")).toBe(true);

    emitter.gatheringComplete();
    emitter.add(null);
    expect(sent.filter((value) => value === null)).toHaveLength(1);
    expect(sent.at(-1)).toBeNull();
  });
});
