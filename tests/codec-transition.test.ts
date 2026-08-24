import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodecTransitionCoordinator,
  type CodecTransitionCoordinatorOptions,
} from "../src/server/codec-transition.ts";
import type {
  CodecRouteSnapshot,
  CodecRouteTarget,
} from "../src/server/hybrid-media-router.ts";
import {
  clientMessageSchema,
  type CodecProofEvidence,
  type CodecTransitionGeneration,
  type ResumeAttempt,
  type ServerMessage,
} from "../src/shared/protocol.ts";

interface ResumeAuthorization {
  codecGeneration: CodecTransitionGeneration | null;
  resumeAttempt: ResumeAttempt;
}

const resumeAuthorizations = new WeakMap<
  CodecTransitionCoordinator,
  ResumeAuthorization[]
>();

const peerTarget = (
  viewerPeerId = "viewer_12345678",
  viewerSessionId = "viewer_session_12345678",
  parentSessionId = "host_session_12345678",
  connectionId = "connection_12345678",
): CodecRouteTarget => ({
  viewerPeerId,
  viewerSessionId,
  preparationOwnerSessionId: parentSessionId,
  preparationBinding: {
    kind: "peer",
    childPeerId: viewerPeerId,
    connectionId,
  },
  proofBinding: { kind: "peer", connectionId },
  routeRevision: 7,
  proofReady: true,
});

const sfuTarget = (
  publicationGeneration = "publication_generation_12345678",
  connectionId = "sfu_connection_12345678",
  routeRevision = 7,
  proofReady = true,
  viewerPeerId = "viewer_sfu_12345678",
  viewerSessionId = "viewer_session_sfu_12345678",
): CodecRouteTarget => ({
  viewerPeerId,
  viewerSessionId,
  preparationOwnerSessionId: "host_session_12345678",
  preparationBinding: {
    kind: "sfu",
    publicationGeneration,
  },
  proofBinding: {
    kind: "sfu",
    connectionId,
    publicationGeneration,
  },
  routeRevision,
  proofReady,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function createHarness(
  initialTargets: CodecRouteTarget[] = [peerTarget()],
  options: {
    createGeneration?: () => CodecTransitionGeneration;
    createResumeAttempt?: () => ResumeAttempt;
    routeWaitRevision?: number | null;
    beginSfuReplacement?: CodecTransitionCoordinatorOptions["beginSfuReplacement"];
    parkSfuReplacement?: CodecTransitionCoordinatorOptions["parkSfuReplacement"];
    beginSfuProof?: CodecTransitionCoordinatorOptions["beginSfuProof"];
    abortSfuReplacement?: CodecTransitionCoordinatorOptions["abortSfuReplacement"];
  } = {},
) {
  let snapshot: CodecRouteSnapshot | null = {
    revision: 7,
    targets: initialTargets,
  };
  let nextGeneration = 1;
  let nextResumeAttempt = 1;
  const routeWaitRevision: number | null =
    options.routeWaitRevision === undefined ? 9 : options.routeWaitRevision;
  let routeWaitHandler: (() => void) | null = null;
  const sent: Array<{ sessionId: string; message: ServerMessage }> = [];
  const committed: string[] = [];
  const resumes: ResumeAuthorization[] = [];
  const confirmations: ResumeAuthorization[] = [];
  const pauses: Array<CodecTransitionGeneration | null> = [];
  const pauseAttempts: Array<ResumeAttempt | null> = [];
  const releases: string[] = [];
  const routeWaitCalls: Array<{
    roomId: string;
    viewerPeerIds: string[];
  }> = [];
  const sfuReplacementCalls: Array<
    Parameters<CodecTransitionCoordinatorOptions["beginSfuReplacement"]>[0]
  > = [];
  const parkedSfuReplacements: Array<{
    roomId: string;
    generation: CodecTransitionGeneration;
  }> = [];
  const sfuProofCalls: Array<{
    roomId: string;
    generation: CodecTransitionGeneration;
    timeoutMs: number;
  }> = [];
  const abortedSfuReplacements: Array<{
    roomId: string;
    generation: CodecTransitionGeneration;
  }> = [];
  const coordinator = new CodecTransitionCoordinator({
    snapshot: () => snapshot,
    sendToSession: (sessionId, message) => sent.push({ sessionId, message }),
    commitCodec: (_roomId, codec) => committed.push(codec),
    authorizeResume: (
      _roomId,
      _hostSessionId,
      _shareGeneration,
      codecGeneration,
      resumeAttempt,
    ) => resumes.push({ codecGeneration, resumeAttempt }),
    confirmSourceEnabled: (
      _roomId,
      _hostSessionId,
      _shareGeneration,
      codecGeneration,
      resumeAttempt,
    ) => {
      confirmations.push({ codecGeneration, resumeAttempt });
      return true;
    },
    restoreAuthoritativePause: (
      _roomId,
      _hostSessionId,
      _shareGeneration,
      codecGeneration,
      resumeAttempt,
    ) => {
      pauses.push(codecGeneration);
      pauseAttempts.push(resumeAttempt);
    },
    returnTargetsToRouteWait: (roomId, viewerPeerIds) => {
      routeWaitCalls.push({ roomId, viewerPeerIds: [...viewerPeerIds] });
      routeWaitHandler?.();
      return routeWaitRevision;
    },
    beginSfuReplacement: (input) => {
      sfuReplacementCalls.push({ ...input });
      return options.beginSfuReplacement?.(input) ?? Promise.resolve(null);
    },
    parkSfuReplacement: (roomId, generation) => {
      parkedSfuReplacements.push({ roomId, generation });
      return options.parkSfuReplacement?.(roomId, generation) ?? false;
    },
    beginSfuProof: (roomId, generation, timeoutMs) => {
      sfuProofCalls.push({ roomId, generation, timeoutMs });
      return options.beginSfuProof?.(roomId, generation, timeoutMs) ?? false;
    },
    abortSfuReplacement: (roomId, generation) => {
      abortedSfuReplacements.push({ roomId, generation });
      options.abortSfuReplacement?.(roomId, generation);
    },
    releaseRoutePause: (roomId) => releases.push(roomId),
    timeoutMs: 100,
    createGeneration: options.createGeneration ?? (() => nextGeneration++),
    createResumeAttempt:
      options.createResumeAttempt ?? (() => nextResumeAttempt++),
  });
  resumeAuthorizations.set(coordinator, resumes);
  return {
    coordinator,
    sent,
    committed,
    resumes,
    confirmations,
    pauses,
    pauseAttempts,
    releases,
    routeWaitCalls,
    sfuReplacementCalls,
    parkedSfuReplacements,
    sfuProofCalls,
    abortedSfuReplacements,
    setSnapshot(next: CodecRouteSnapshot | null) {
      snapshot = next;
    },
    setRouteWaitHandler(next: (() => void) | null) {
      routeWaitHandler = next;
    },
  };
}

const start = (coordinator: CodecTransitionCoordinator) =>
  coordinator.start({
    roomId: "1234",
    hostSessionId: "host_session_12345678",
    shareGeneration: "share_generation_12345678",
    requested: "h264",
    previous: "vp8",
  });

const prepared = (
  coordinator: CodecTransitionCoordinator,
  accepted = true,
  generation: CodecTransitionGeneration = 1,
) =>
  coordinator.prepared("1234", "host_session_12345678", {
    type: "video-codec-prepared",
    shareGeneration: "share_generation_12345678",
    generation,
    binding: {
      kind: "peer",
      childPeerId: "viewer_12345678",
      connectionId: "connection_12345678",
    },
    accepted,
  });

const sfuPrepared = (
  coordinator: CodecTransitionCoordinator,
  publicationGeneration: string,
  accepted = true,
  generation: CodecTransitionGeneration = 1,
) =>
  coordinator.prepared("1234", "host_session_12345678", {
    type: "video-codec-prepared",
    shareGeneration: "share_generation_12345678",
    generation,
    binding: {
      kind: "sfu",
      publicationGeneration,
    },
    accepted,
  });

const requestResume = (coordinator: CodecTransitionCoordinator) =>
  coordinator.requestResume({
    roomId: "1234",
    hostSessionId: "host_session_12345678",
    shareGeneration: "share_generation_12345678",
  });

const acknowledgeLatestResume = (coordinator: CodecTransitionCoordinator) => {
  const authorization = resumeAuthorizations.get(coordinator)?.at(-1);
  if (!authorization) return false;
  return coordinator.sourceEnabled({
    roomId: "1234",
    hostSessionId: "host_session_12345678",
    shareGeneration: "share_generation_12345678",
    ...authorization,
  });
};

const resume = (coordinator: CodecTransitionCoordinator) => {
  const result = requestResume(coordinator);
  if (result !== "busy") {
    acknowledgeLatestResume(coordinator);
  }
  return result;
};

const latestResumeAttempt = (coordinator: CodecTransitionCoordinator) =>
  resumeAuthorizations.get(coordinator)?.at(-1)?.resumeAttempt ?? 1;

const proofEvidence = (
  actualCodec: CodecProofEvidence["actualCodec"],
  overrides: Partial<CodecProofEvidence> = {},
): CodecProofEvidence => ({
  baselineSampleTimestampMs: 100,
  sampleTimestampMs: 200,
  rtpStatsId: "inbound_rtp_1",
  rtpSsrc: 1_234,
  rtpMid: "0",
  rtpRid: null,
  trackIdentifier: "remote_video_track_1",
  framesDecodedDelta: 1,
  actualCodec,
  ...overrides,
});

const proof = (
  coordinator: CodecTransitionCoordinator,
  actualCodec: CodecProofEvidence["actualCodec"],
  options: {
    generation?: CodecTransitionGeneration;
    resumeAttempt?: ResumeAttempt;
    routeRevision?: number;
    evidence?: Partial<CodecProofEvidence>;
  } = {},
) =>
  coordinator.proof("1234", "viewer_session_12345678", {
    type: "video-codec-proof",
    shareGeneration: "share_generation_12345678",
    generation: options.generation ?? 1,
    resumeAttempt:
      options.resumeAttempt ?? latestResumeAttempt(coordinator),
    routeRevision: options.routeRevision ?? 7,
    binding: { kind: "peer", connectionId: "connection_12345678" },
    evidence: proofEvidence(actualCodec, options.evidence),
  });

const sfuProof = (
  coordinator: CodecTransitionCoordinator,
  actualCodec: CodecProofEvidence["actualCodec"],
  publicationGeneration: string,
  connectionId: string,
  options: {
    generation?: CodecTransitionGeneration;
    resumeAttempt?: ResumeAttempt;
    routeRevision?: number;
    evidence?: Partial<CodecProofEvidence>;
  } = {},
) =>
  coordinator.proof("1234", "viewer_session_sfu_12345678", {
    type: "video-codec-proof",
    shareGeneration: "share_generation_12345678",
    generation: options.generation ?? 1,
    resumeAttempt:
      options.resumeAttempt ?? latestResumeAttempt(coordinator),
    routeRevision: options.routeRevision ?? 7,
    binding: {
      kind: "sfu",
      connectionId,
      publicationGeneration,
    },
    evidence: proofEvidence(actualCodec, options.evidence),
  });

describe("CodecTransitionCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("waits without a timer after preparation and commits only after decoded proof", () => {
    const harness = createHarness();

    expect(start(harness.coordinator)).toBe("started");
    expect(harness.sent.at(-1)?.message.type).toBe("video-codec-prepare");
    prepared(harness.coordinator);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "prepared",
      videoCodec: "h264",
    });

    vi.advanceTimersByTime(10_000);
    expect(harness.committed).toEqual([]);
    expect(harness.pauses).toEqual([]);

    expect(resume(harness.coordinator)).toBe("started-proof");
    expect(harness.resumes).toEqual([
      { codecGeneration: 1, resumeAttempt: 1 },
    ]);
    expect(harness.releases).toEqual([]);
    proof(harness.coordinator, "h264");

    expect(harness.committed).toEqual(["h264"]);
    expect(harness.releases).toEqual(["1234"]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "committed",
      failure: null,
    });
  });

  it("keeps the room paused and withholds proof until the exact source ack", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);

    expect(requestResume(harness.coordinator)).toBe("started-proof");
    expect(harness.confirmations).toEqual([]);
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([]);
    expect(
      harness.coordinator.sourceEnabled({
        roomId: "1234",
        hostSessionId: "host_session_12345678",
        shareGeneration: "share_generation_12345678",
        codecGeneration: 1,
        resumeAttempt: 2,
      }),
    ).toBe(false);

    expect(acknowledgeLatestResume(harness.coordinator)).toBe(true);
    expect(harness.confirmations).toEqual([
      { codecGeneration: 1, resumeAttempt: 1 },
    ]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-proof-request",
      generation: 1,
      resumeAttempt: 1,
    });

    proof(harness.coordinator, "h264", { resumeAttempt: 2 });
    expect(harness.committed).toEqual([]);
    proof(harness.coordinator, "h264");
    expect(harness.committed).toEqual(["h264"]);
  });

  it("invalidates an old source ack and proof when Pause opens a new attempt", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);
    requestResume(harness.coordinator);
    const first = harness.resumes.at(-1)!;

    harness.coordinator.pause({
      roomId: "1234",
      hostSessionId: "host_session_12345678",
      shareGeneration: "share_generation_12345678",
    });
    expect(
      harness.coordinator.sourceEnabled({
        roomId: "1234",
        hostSessionId: "host_session_12345678",
        shareGeneration: "share_generation_12345678",
        ...first,
      }),
    ).toBe(false);

    requestResume(harness.coordinator);
    const second = harness.resumes.at(-1)!;
    expect(second.resumeAttempt).toBeGreaterThan(first.resumeAttempt);
    expect(acknowledgeLatestResume(harness.coordinator)).toBe(true);
    proof(harness.coordinator, "h264", {
      resumeAttempt: first.resumeAttempt,
    });
    expect(harness.committed).toEqual([]);
    proof(harness.coordinator, "h264");
    expect(harness.committed).toEqual(["h264"]);
  });

  it("bounds an ordinary Resume ack and permits a later retry", () => {
    const harness = createHarness([]);

    expect(requestResume(harness.coordinator)).toBe("normal");
    expect(harness.releases).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(harness.pauses).toEqual([null]);
    expect(harness.pauseAttempts).toEqual([1]);
    expect(harness.releases).toEqual([]);

    expect(requestResume(harness.coordinator)).toBe("normal");
    expect(harness.resumes.at(-1)).toEqual({
      codecGeneration: null,
      resumeAttempt: 2,
    });
    expect(acknowledgeLatestResume(harness.coordinator)).toBe(true);
    expect(harness.releases).toEqual(["1234"]);
  });

  it("invalidates an ordinary Resume across a Host session replacement", () => {
    const harness = createHarness([]);
    requestResume(harness.coordinator);

    harness.coordinator.invalidateHostSession(
      "1234",
      "host_session_reconnected_12345678",
    );

    expect(harness.pauses).toEqual([null]);
    expect(harness.pauseAttempts).toEqual([null]);
    expect(acknowledgeLatestResume(harness.coordinator)).toBe(false);
    expect(harness.releases).toEqual([]);
  });

  it("uses one Resume deadline across source ack and proof", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);
    requestResume(harness.coordinator);

    vi.advanceTimersByTime(90);
    expect(acknowledgeLatestResume(harness.coordinator)).toBe(true);
    vi.advanceTimersByTime(10);

    expect(harness.pauses).toEqual([1]);
    expect(harness.pauseAttempts).toEqual([1]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-prepare",
      generation: 2,
      videoCodec: "vp8",
    });
  });

  it("continues the same generation when a pending SFU target has left", async () => {
    const replacement = deferred<CodecRouteSnapshot | null>();
    const direct = peerTarget();
    const harness = createHarness(
      [direct, sfuTarget("publication_generation_old_12345678")],
      { beginSfuReplacement: () => replacement.promise },
    );
    start(harness.coordinator);

    harness.setSnapshot({
      revision: 8,
      targets: [{ ...direct, routeRevision: 8 }],
    });
    replacement.resolve(null);
    await flushPromises();

    expect(harness.abortedSfuReplacements).toEqual([
      { roomId: "1234", generation: 1 },
    ]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-prepare",
      generation: 1,
      videoCodec: "h264",
    });
    expect(harness.sfuReplacementCalls).toHaveLength(1);
  });

  it("recomputes SFU need from the current snapshot for rollback", () => {
    const never = () => new Promise<CodecRouteSnapshot | null>(() => undefined);
    const direct = peerTarget();
    const harness = createHarness(
      [sfuTarget("publication_generation_old_12345678")],
      { beginSfuReplacement: never },
    );
    start(harness.coordinator);
    harness.setSnapshot({ revision: 8, targets: [direct] });

    vi.advanceTimersByTime(100);

    expect(harness.sfuReplacementCalls).toHaveLength(1);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-prepare",
      generation: 2,
      videoCodec: "vp8",
    });
  });

  it("parks a fresh SFU publication and gates proof until its route is ready", async () => {
    const oldPublication = "publication_generation_old_12345678";
    const freshPublication = "publication_generation_h264_12345678";
    const freshConnection = "sfu_connection_h264_12345678";
    const replacement = deferred<CodecRouteSnapshot | null>();
    const harness = createHarness([sfuTarget(oldPublication)], {
      beginSfuReplacement: () => replacement.promise,
      parkSfuReplacement: () => true,
      beginSfuProof: () => true,
    });

    expect(start(harness.coordinator)).toBe("started");
    expect(harness.sfuReplacementCalls).toEqual([
      {
        roomId: "1234",
        hostSessionId: "host_session_12345678",
        generation: 1,
        videoCodec: "h264",
        timeoutMs: 100,
      },
    ]);
    expect(harness.sent).toEqual([]);

    const freshPending = sfuTarget(
      freshPublication,
      freshConnection,
      8,
      false,
    );
    const freshSnapshot = { revision: 8, targets: [freshPending] };
    harness.setSnapshot(freshSnapshot);
    replacement.resolve(freshSnapshot);
    await flushPromises();

    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-prepare",
      ),
    ).toEqual([]);
    sfuPrepared(harness.coordinator, freshPublication);
    expect(harness.parkedSfuReplacements).toEqual([
      { roomId: "1234", generation: 1 },
    ]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      generation: 1,
      status: "prepared",
    });

    vi.advanceTimersByTime(10_000);
    expect(harness.sfuReplacementCalls).toHaveLength(1);
    expect(harness.abortedSfuReplacements).toEqual([]);
    expect(harness.committed).toEqual([]);

    expect(resume(harness.coordinator)).toBe("started-proof");
    expect(harness.sfuProofCalls).toEqual([
      { roomId: "1234", generation: 1, timeoutMs: 100 },
    ]);
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([]);

    harness.setSnapshot({
      revision: 9,
      targets: [{ ...freshPending, routeRevision: 9, proofReady: true }],
    });
    harness.coordinator.participantChanged("1234");
    expect(harness.sent.at(-1)).toMatchObject({
      sessionId: "viewer_session_sfu_12345678",
      message: {
        type: "video-codec-proof-request",
        generation: 1,
        routeRevision: 9,
        binding: {
          kind: "sfu",
          connectionId: freshConnection,
          publicationGeneration: freshPublication,
        },
      },
    });

    sfuProof(
      harness.coordinator,
      "h264",
      freshPublication,
      freshConnection,
      { routeRevision: 9 },
    );
    expect(harness.committed).toEqual(["h264"]);
    expect(harness.releases).toEqual(["1234"]);
  });

  it("starts rollback with another fresh SFU generation after proof failure", async () => {
    const replacements = [
      deferred<CodecRouteSnapshot | null>(),
      deferred<CodecRouteSnapshot | null>(),
    ];
    let replacementIndex = 0;
    const harness = createHarness(
      [sfuTarget("publication_generation_old_12345678")],
      {
        beginSfuReplacement: () =>
          replacements[replacementIndex++]!.promise,
        parkSfuReplacement: () => true,
        beginSfuProof: () => true,
      },
    );

    start(harness.coordinator);
    const requestedPending = sfuTarget(
      "publication_generation_h264_12345678",
      "sfu_connection_h264_12345678",
      8,
      false,
    );
    const requestedSnapshot = { revision: 8, targets: [requestedPending] };
    harness.setSnapshot(requestedSnapshot);
    replacements[0]!.resolve(requestedSnapshot);
    await flushPromises();
    sfuPrepared(
      harness.coordinator,
      "publication_generation_h264_12345678",
    );
    resume(harness.coordinator);
    harness.setSnapshot({
      revision: 9,
      targets: [{ ...requestedPending, routeRevision: 9, proofReady: true }],
    });
    harness.coordinator.participantChanged("1234");

    sfuProof(
      harness.coordinator,
      "vp8",
      "publication_generation_h264_12345678",
      "sfu_connection_h264_12345678",
      { routeRevision: 9 },
    );
    expect(harness.pauses).toEqual([1]);
    expect(harness.sfuReplacementCalls.map((call) => call.generation)).toEqual([
      1, 2,
    ]);
    expect(harness.sfuReplacementCalls.at(-1)).toMatchObject({
      generation: 2,
      videoCodec: "vp8",
    });
    expect(harness.resumes).toHaveLength(1);

    const rollbackPending = sfuTarget(
      "publication_generation_rollback_12345678",
      "sfu_connection_rollback_12345678",
      10,
      false,
    );
    const rollbackSnapshot = { revision: 10, targets: [rollbackPending] };
    harness.setSnapshot(rollbackSnapshot);
    replacements[1]!.resolve(rollbackSnapshot);
    await flushPromises();
    sfuPrepared(
      harness.coordinator,
      "publication_generation_rollback_12345678",
      true,
      2,
    );
    expect(harness.parkedSfuReplacements).toEqual([
      { roomId: "1234", generation: 1 },
      { roomId: "1234", generation: 2 },
    ]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      generation: 2,
      status: "rollback-prepared",
      failure: "proof-failed",
    });
    expect(harness.resumes).toHaveLength(1);

    expect(resume(harness.coordinator)).toBe("started-proof");
    harness.setSnapshot({
      revision: 11,
      targets: [{ ...rollbackPending, routeRevision: 11, proofReady: true }],
    });
    harness.coordinator.participantChanged("1234");
    sfuProof(
      harness.coordinator,
      "vp8",
      "publication_generation_rollback_12345678",
      "sfu_connection_rollback_12345678",
      { generation: 2, routeRevision: 11 },
    );

    expect(harness.committed).toEqual(["vp8"]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      generation: 2,
      status: "committed",
      failure: "proof-failed",
    });
  });

  it("bounds SFU initialization while leaving a parked preparation timerless", async () => {
    const parkedReplacement = deferred<CodecRouteSnapshot | null>();
    const parkedHarness = createHarness(
      [sfuTarget("publication_generation_old_12345678")],
      {
        beginSfuReplacement: () => parkedReplacement.promise,
        parkSfuReplacement: () => true,
      },
    );
    start(parkedHarness.coordinator);
    const freshPending = sfuTarget(
      "publication_generation_parked_12345678",
      "sfu_connection_parked_12345678",
      8,
      false,
    );
    const freshSnapshot = { revision: 8, targets: [freshPending] };
    parkedHarness.setSnapshot(freshSnapshot);
    parkedReplacement.resolve(freshSnapshot);
    await flushPromises();
    sfuPrepared(
      parkedHarness.coordinator,
      "publication_generation_parked_12345678",
    );
    vi.advanceTimersByTime(10_000);
    expect(parkedHarness.sfuReplacementCalls).toHaveLength(1);
    expect(parkedHarness.abortedSfuReplacements).toEqual([]);
    expect(parkedHarness.coordinator.blocksResume("1234")).toBe(true);

    const never = () => new Promise<CodecRouteSnapshot | null>(() => undefined);
    const boundedHarness = createHarness(
      [sfuTarget("publication_generation_old_12345678")],
      { beginSfuReplacement: never },
    );
    start(boundedHarness.coordinator);
    vi.advanceTimersByTime(100);
    expect(
      boundedHarness.sfuReplacementCalls.map((call) => ({
        generation: call.generation,
        videoCodec: call.videoCodec,
      })),
    ).toEqual([
      { generation: 1, videoCodec: "h264" },
      { generation: 2, videoCodec: "vp8" },
    ]);
    expect(boundedHarness.abortedSfuReplacements).toEqual([
      { roomId: "1234", generation: 1 },
    ]);

    vi.advanceTimersByTime(100);
    expect(boundedHarness.abortedSfuReplacements).toEqual([
      { roomId: "1234", generation: 1 },
      { roomId: "1234", generation: 2 },
    ]);
    expect(boundedHarness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      generation: 2,
      status: "failed",
      failure: "rollback-failed",
    });
  });

  it("retires a target that is no longer proof-ready before issuing proof", () => {
    const target = peerTarget();
    const harness = createHarness([target]);

    start(harness.coordinator);
    prepared(harness.coordinator);
    expect(requestResume(harness.coordinator)).toBe("started-proof");

    harness.setSnapshot({
      revision: 8,
      targets: [{ ...target, routeRevision: 8, proofReady: false }],
    });
    harness.coordinator.participantChanged("1234");
    expect(acknowledgeLatestResume(harness.coordinator)).toBe(true);

    expect(harness.routeWaitCalls).toEqual([
      { roomId: "1234", viewerPeerIds: ["viewer_12345678"] },
    ]);
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([]);
    expect(harness.committed).toEqual(["h264"]);
    expect(harness.releases).toEqual(["1234"]);

    vi.advanceTimersByTime(10_000);
    expect(harness.pauses).toEqual([]);
  });

  it("removes an invalid SFU anchor from proof without starting rollback", async () => {
    const replacement = deferred<CodecRouteSnapshot | null>();
    const direct = peerTarget();
    const harness = createHarness(
      [direct, sfuTarget("publication_generation_old_12345678")],
      {
        beginSfuReplacement: () => replacement.promise,
        parkSfuReplacement: () => true,
        beginSfuProof: () => true,
      },
    );

    start(harness.coordinator);
    const retainedDirect = { ...direct, routeRevision: 8 };
    const pendingAnchor = sfuTarget(
      "publication_generation_h264_12345678",
      "sfu_connection_h264_12345678",
      8,
      false,
    );
    const freshSnapshot = {
      revision: 8,
      targets: [retainedDirect, pendingAnchor],
    };
    harness.setSnapshot(freshSnapshot);
    replacement.resolve(freshSnapshot);
    await flushPromises();
    prepared(harness.coordinator);
    sfuPrepared(
      harness.coordinator,
      "publication_generation_h264_12345678",
    );
    expect(resume(harness.coordinator)).toBe("started-proof");
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([]);

    harness.setSnapshot({
      revision: 9,
      targets: [{ ...retainedDirect, routeRevision: 9 }],
    });
    harness.coordinator.participantChanged("1234");
    expect(harness.routeWaitCalls).toEqual([
      { roomId: "1234", viewerPeerIds: ["viewer_sfu_12345678"] },
    ]);
    expect(harness.abortedSfuReplacements).toEqual([
      { roomId: "1234", generation: 1 },
    ]);
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId: "viewer_session_12345678",
        message: expect.objectContaining({
          generation: 1,
          routeRevision: 9,
          binding: {
            kind: "peer",
            connectionId: "connection_12345678",
          },
        }),
      }),
    ]);

    proof(harness.coordinator, "h264", { routeRevision: 9 });
    expect(harness.committed).toEqual(["h264"]);
    expect(harness.pauses).toEqual([]);
    expect(harness.sfuReplacementCalls).toHaveLength(1);
    expect(
      harness.sent.some(
        ({ message }) =>
          message.type === "video-codec-result" &&
          (message.status === "rollback-prepared" ||
            message.status === "failed"),
      ),
    ).toBe(false);
  });

  it("routes non-ready targets outside the pending SFU subtree to wait immediately", async () => {
    const replacement = deferred<CodecRouteSnapshot | null>();
    const retainedAnchorChild = peerTarget(
      "viewer_anchor_child_12345678",
      "viewer_session_anchor_child_12345678",
      "viewer_session_sfu_anchor_12345678",
      "connection_anchor_child_12345678",
    );
    const retainedAnchorGrandchild = peerTarget(
      "viewer_anchor_grandchild_12345678",
      "viewer_session_anchor_grandchild_12345678",
      "viewer_session_anchor_child_12345678",
      "connection_anchor_grandchild_12345678",
    );
    const unreachableOtherRootChild = {
      ...peerTarget(
        "viewer_other_child_12345678",
        "viewer_session_other_child_12345678",
        "viewer_session_sfu_other_12345678",
        "connection_other_child_12345678",
      ),
      proofReady: false,
    };
    const harness = createHarness(
      [
        sfuTarget(
          "publication_generation_old_12345678",
          "sfu_connection_anchor_old_12345678",
          7,
          true,
          "viewer_sfu_anchor_12345678",
          "viewer_session_sfu_anchor_12345678",
        ),
        sfuTarget(
          "publication_generation_old_12345678",
          "sfu_connection_other_old_12345678",
          7,
          true,
          "viewer_sfu_other_12345678",
          "viewer_session_sfu_other_12345678",
        ),
        retainedAnchorChild,
        retainedAnchorGrandchild,
        { ...unreachableOtherRootChild, proofReady: true },
      ],
      {
        beginSfuReplacement: () => replacement.promise,
        parkSfuReplacement: () => true,
        beginSfuProof: () => true,
      },
    );

    start(harness.coordinator);
    const freshAnchor = sfuTarget(
      "publication_generation_h264_12345678",
      "sfu_connection_anchor_h264_12345678",
      8,
      false,
      "viewer_sfu_anchor_12345678",
      "viewer_session_sfu_anchor_12345678",
    );
    const preparedSnapshot = {
      revision: 8,
      targets: [
        freshAnchor,
        { ...retainedAnchorChild, routeRevision: 8, proofReady: false },
        {
          ...retainedAnchorGrandchild,
          routeRevision: 8,
          proofReady: false,
        },
        { ...unreachableOtherRootChild, routeRevision: 8 },
      ],
    };
    harness.setSnapshot(preparedSnapshot);
    replacement.resolve(preparedSnapshot);
    await flushPromises();
    for (const target of preparedSnapshot.targets) {
      if (target.preparationBinding.kind !== "peer") continue;
      harness.coordinator.prepared("1234", target.preparationOwnerSessionId, {
        type: "video-codec-prepared",
        shareGeneration: "share_generation_12345678",
        generation: 1,
        binding: target.preparationBinding,
        accepted: true,
      });
    }
    sfuPrepared(
      harness.coordinator,
      "publication_generation_h264_12345678",
    );
    expect(resume(harness.coordinator)).toBe("started-proof");
    expect(harness.routeWaitCalls).toEqual([
      {
        roomId: "1234",
        viewerPeerIds: ["viewer_other_child_12345678"],
      },
    ]);
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([]);

    harness.setSnapshot({
      revision: 9,
      targets: [
        { ...freshAnchor, routeRevision: 9, proofReady: true },
        { ...retainedAnchorChild, routeRevision: 9, proofReady: true },
        {
          ...retainedAnchorGrandchild,
          routeRevision: 9,
          proofReady: true,
        },
        { ...unreachableOtherRootChild, routeRevision: 9 },
      ],
    });
    harness.coordinator.participantChanged("1234");

    expect(harness.routeWaitCalls).toEqual([
      {
        roomId: "1234",
        viewerPeerIds: ["viewer_other_child_12345678"],
      },
    ]);
    expect(
      harness.sent
        .filter(({ message }) => message.type === "video-codec-proof-request")
        .map(({ sessionId }) => sessionId),
    ).toEqual([
      "viewer_session_sfu_anchor_12345678",
      "viewer_session_anchor_child_12345678",
      "viewer_session_anchor_grandchild_12345678",
    ]);
    expect(harness.pauses).toEqual([]);
  });

  it("rolls back an actual-codec mismatch and waits for another user resume", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);
    resume(harness.coordinator);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-proof-request",
      generation: 1,
      expectedCodec: "h264",
    });

    proof(harness.coordinator, "vp8");
    expect(harness.pauses).toEqual([1]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-prepare",
      generation: 2,
      videoCodec: "vp8",
    });
    expect(harness.resumes).toHaveLength(1);

    prepared(harness.coordinator, true, 2);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "rollback-prepared",
      failure: "proof-failed",
    });
    vi.advanceTimersByTime(10_000);
    expect(harness.resumes).toHaveLength(1);
    expect(harness.committed).toEqual([]);

    resume(harness.coordinator);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-proof-request",
      generation: 2,
      expectedCodec: null,
    });
    proof(harness.coordinator, "vp8", { generation: 2 });
    expect(harness.committed).toEqual(["vp8"]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "committed",
      videoCodec: "vp8",
      failure: "proof-failed",
    });
  });

  it("accepts a different actual codec after exact rollback preparation", () => {
    const harness = createHarness();
    expect(
      harness.coordinator.start({
        roomId: "1234",
        hostSessionId: "host_session_12345678",
        shareGeneration: "share_generation_12345678",
        requested: "vp8",
        previous: "h264",
      }),
    ).toBe("started");
    prepared(harness.coordinator);
    resume(harness.coordinator);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-proof-request",
      generation: 1,
      expectedCodec: "vp8",
    });

    proof(harness.coordinator, "h264");
    expect(harness.pauses).toEqual([1]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-prepare",
      generation: 2,
      videoCodec: "h264",
    });
    prepared(harness.coordinator, true, 2);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "rollback-prepared",
      failure: "proof-failed",
    });

    resume(harness.coordinator);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-proof-request",
      generation: 2,
      expectedCodec: null,
    });
    proof(harness.coordinator, "vp8", { generation: 2 });

    expect(harness.committed).toEqual(["h264"]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      generation: 2,
      status: "committed",
      videoCodec: "h264",
      failure: "proof-failed",
    });
  });

  it("returns a user-paused proof to the prepared state", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);
    resume(harness.coordinator);

    harness.coordinator.pause({
      roomId: "1234",
      hostSessionId: "host_session_12345678",
      shareGeneration: "share_generation_12345678",
    });
    vi.advanceTimersByTime(10_000);
    expect(harness.pauses).toEqual([]);
    expect(harness.committed).toEqual([]);

    expect(resume(harness.coordinator)).toBe("started-proof");
    proof(harness.coordinator, "h264");
    expect(harness.committed).toEqual(["h264"]);
  });

  it("removes invalidated bindings and leaves routing to rebuild after commit", () => {
    const harness = createHarness();
    start(harness.coordinator);
    harness.setSnapshot({ revision: 8, targets: [] });
    harness.coordinator.participantChanged("1234");

    expect(harness.routeWaitCalls).toEqual([
      { roomId: "1234", viewerPeerIds: ["viewer_12345678"] },
    ]);
    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "committed",
    });
    expect(harness.committed).toEqual(["h264"]);
    expect(resume(harness.coordinator)).toBe("normal");
    expect(harness.resumes).toEqual([
      { codecGeneration: null, resumeAttempt: 1 },
    ]);
    expect(harness.releases).toEqual(["1234"]);
  });

  it("batch-retires invalid bindings, rebases proof, and defers synchronous reentry", () => {
    const retained = peerTarget();
    const removedA = peerTarget(
      "viewer_removed_a_12345678",
      "viewer_session_removed_a_12345678",
      "host_session_12345678",
      "connection_removed_a_12345678",
    );
    const removedB = peerTarget(
      "viewer_removed_b_12345678",
      "viewer_session_removed_b_12345678",
      "host_session_12345678",
      "connection_removed_b_12345678",
    );
    const harness = createHarness([retained, removedA, removedB]);
    start(harness.coordinator);
    harness.setSnapshot({
      revision: 8,
      targets: [{ ...retained, routeRevision: 8 }],
    });
    harness.setRouteWaitHandler(() => {
      harness.setSnapshot({
        revision: 9,
        targets: [{ ...retained, routeRevision: 9 }],
      });
      harness.coordinator.participantChanged("1234");
    });

    harness.coordinator.participantChanged("1234");

    expect(harness.routeWaitCalls).toEqual([
      {
        roomId: "1234",
        viewerPeerIds: [
          "viewer_removed_a_12345678",
          "viewer_removed_b_12345678",
        ],
      },
    ]);
    prepared(harness.coordinator);
    expect(resume(harness.coordinator)).toBe("started-proof");
    expect(
      harness.sent.filter(
        ({ message }) => message.type === "video-codec-proof-request",
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId: "viewer_session_12345678",
        message: expect.objectContaining({
          routeRevision: 9,
          generation: 1,
        }),
      }),
    ]);

    proof(harness.coordinator, "h264", { routeRevision: 9 });
    expect(harness.committed).toEqual(["h264"]);
  });

  it("allocates increasing generations and rejects a duplicate allocator value", () => {
    const harness = createHarness([]);

    expect(start(harness.coordinator)).toBe("committed");
    expect(
      harness.coordinator.start({
        roomId: "5678",
        hostSessionId: "host_session_12345678",
        shareGeneration: "share_generation_12345678",
        requested: "h264",
        previous: "vp8",
      }),
    ).toBe("committed");
    expect(
      harness.sent
        .map(({ message }) => message)
        .filter((message) => message.type === "video-codec-result")
        .map((message) => message.generation),
    ).toEqual([1, 2]);

    const duplicate = createHarness([], { createGeneration: () => 1 });
    expect(start(duplicate.coordinator)).toBe("committed");
    expect(() =>
      duplicate.coordinator.start({
        roomId: "5678",
        hostSessionId: "host_session_12345678",
        shareGeneration: "share_generation_12345678",
        requested: "h264",
        previous: "vp8",
      }),
    ).toThrow("Codec transition generation must increase monotonically");
  });

  it("rejects a non-increasing Resume attempt across rooms", () => {
    const harness = createHarness([], { createResumeAttempt: () => 1 });
    expect(requestResume(harness.coordinator)).toBe("normal");

    expect(() =>
      harness.coordinator.requestResume({
        roomId: "5678",
        hostSessionId: "host_session_other_12345678",
        shareGeneration: "share_generation_other_12345678",
      }),
    ).toThrow("Resume attempt must increase monotonically");
  });

  it("accepts only proof evidence sampled after a positive decoded-frame delta", () => {
    const message = {
      type: "video-codec-proof" as const,
      shareGeneration: "share_generation_12345678",
      generation: 1,
      resumeAttempt: 1,
      routeRevision: 7,
      binding: { kind: "peer" as const, connectionId: "connection_12345678" },
      evidence: proofEvidence("h264"),
    };

    expect(clientMessageSchema.safeParse(message).success).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        ...message,
        evidence: proofEvidence("h264", {
          baselineSampleTimestampMs: 200,
          sampleTimestampMs: 200,
        }),
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        ...message,
        evidence: proofEvidence("h264", { framesDecodedDelta: 0 }),
      }).success,
    ).toBe(false);
  });

  it("updates only the future preference when no route target exists", () => {
    const harness = createHarness([]);

    expect(start(harness.coordinator)).toBe("committed");
    expect(harness.committed).toEqual(["h264"]);
    expect(harness.resumes).toEqual([]);
    expect(harness.releases).toEqual([]);
  });

  it("keeps a failed rollback as a timerless resume blocker", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);
    resume(harness.coordinator);
    proof(harness.coordinator, "vp8");
    prepared(harness.coordinator, false, 2);

    expect(harness.sent.at(-1)?.message).toMatchObject({
      type: "video-codec-result",
      status: "failed",
      failure: "rollback-failed",
    });
    vi.advanceTimersByTime(10_000);
    expect(resume(harness.coordinator)).toBe("busy");
    expect(harness.releases).toEqual([]);
    expect(harness.coordinator.blocksResume("1234")).toBe(true);
  });

  it("invalidates a transaction across a host session boundary", () => {
    const harness = createHarness();
    start(harness.coordinator);

    harness.coordinator.invalidateHostSession(
      "1234",
      "host_session_reconnected_12345678",
    );

    expect(harness.pauses).toEqual([1]);
    expect(harness.sent.at(-1)).toMatchObject({
      sessionId: "host_session_reconnected_12345678",
      message: {
        type: "video-codec-result",
        status: "failed",
        failure: "stale-binding",
      },
    });
    expect(
      harness.coordinator.requestResume({
        roomId: "1234",
        hostSessionId: "host_session_reconnected_12345678",
        shareGeneration: "share_generation_12345678",
      }),
    ).toBe("busy");
    expect(harness.releases).toEqual([]);
  });

  it("repauses a proving transaction on reconnect and ignores its delayed proof", () => {
    const harness = createHarness();
    start(harness.coordinator);
    prepared(harness.coordinator);
    expect(requestResume(harness.coordinator)).toBe("started-proof");
    expect(acknowledgeLatestResume(harness.coordinator)).toBe(true);
    const staleResumeAttempt = latestResumeAttempt(harness.coordinator);

    harness.coordinator.invalidateHostSession(
      "1234",
      "host_session_reconnected_12345678",
    );

    expect(harness.pauses).toEqual([1]);
    expect(harness.pauseAttempts).toEqual([null]);
    proof(harness.coordinator, "h264", {
      resumeAttempt: staleResumeAttempt,
    });
    expect(harness.committed).toEqual([]);
    expect(harness.releases).toEqual([]);
    expect(harness.coordinator.blocksResume("1234")).toBe(true);
  });
});
