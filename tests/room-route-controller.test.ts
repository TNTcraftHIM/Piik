import { describe, expect, it } from "vitest";

import type { ViewerQualityEvidenceMetrics } from "../src/shared/protocol.ts";

import {
  RoomRouteController,
  type CandidateGuard,
  type CandidateCursorGuard,
  type CandidateReservation,
  type CommittedEdgeSeed,
  type OperationSnapshot,
} from "../src/server/room-route-controller.ts";

const HOST = "host_12345678";
const A = "viewer_a_12345678";
const B = "viewer_b_12345678";
const C = "viewer_c_12345678";
const D = "viewer_d_12345678";
const E = "viewer_e_12345678";
const F = "viewer_f_12345678";

function controller(
  capacity: 1 | 2 | 3 = 2,
  options: {
    sfuEnabled?: boolean;
    qualityConvergenceEnabled?: boolean;
    operationTimeoutMs?: number;
  } = {},
) {
  const routes = new RoomRouteController<string>({
    hostPeerId: HOST,
    endpointMediaCopyCapacity: capacity,
    operationTimeoutMs: 10_000,
    ...options,
  });
  routes.upsertParticipant({
    peerId: HOST,
    role: "host",
    sessionId: "host_session",
    effectiveDownstreamCapacity: capacity,
  });
  return routes;
}

function addViewer(
  routes: RoomRouteController<string>,
  peerId: string,
  capacity: 0 | 1 | 2 | 3,
  nowMs?: number,
) {
  routes.upsertParticipant({
    peerId,
    role: "viewer",
    sessionId: `${peerId}_session`,
    effectiveDownstreamCapacity: capacity,
  }, nowMs);
}

function cursorGuard(operation: OperationSnapshot): CandidateCursorGuard {
  return {
    childPeerId: operation.childPeerId,
    childSessionId: operation.childSessionId,
    baseRevision: operation.baseRevision,
    factVersion: operation.factVersion,
    cursor: operation.cursor,
    plan: operation.candidates[operation.cursor]!,
  };
}

function beginCandidate(
  routes: RoomRouteController<string>,
  input: {
    nowMs: number;
    connectionId: string;
    reservation: CandidateReservation<string>;
    publicationGeneration?: string;
    publicationConnectionId?: string;
    hostSessionId?: string;
  },
) {
  const operation = routes.snapshot().operation!;
  return routes.beginCurrentCandidate({
    guard: cursorGuard(operation),
    ...(input.reservation.kind === "direct"
      ? {}
      : { hostSessionId: input.hostSessionId ?? "host_session" }),
    ...input,
  });
}

function skipCandidate(routes: RoomRouteController<string>, nowMs: number) {
  const operation = routes.snapshot().operation!;
  return routes.skipCurrentCandidate(cursorGuard(operation), nowMs);
}

function commitCurrent(
  routes: RoomRouteController<string>,
  nowMs: number,
  connectionId: string,
) {
  const begin = beginCandidate(routes, {
    nowMs,
    connectionId,
    reservation: { kind: "direct" },
  });
  const prepared = begin.operation!;
  const current = prepared.current!;
  const guard: CandidateGuard = {
    childPeerId: prepared.childPeerId,
    childSessionId: prepared.childSessionId,
    revision: current.revision,
    connectionId,
  };
  expect(routes.candidateReady(guard, nowMs + 1).accepted).toBe(true);
  return guard;
}

function peerEdge(
  parentPeerId: string,
  connectionId: string,
  usable = true,
): CommittedEdgeSeed<string> {
  return {
    kind: "peer",
    parentPeerId,
    transport: "direct",
    connectionId,
    usable,
    physicalActive: true,
  };
}

function observeSenderState(
  routes: RoomRouteController<string>,
  input: {
    childPeerId: string;
    connectionId: string;
    state: "healthy" | "degraded";
    acceptedAtMs: number;
    parentPeerId?: string;
  },
) {
  const parentPeerId = input.parentPeerId ?? HOST;
  return routes.observeSenderQualityEvidence({
    parentPeerId,
    parentSessionId:
      parentPeerId === HOST ? "host_session" : `${parentPeerId}_session`,
    childPeerId: input.childPeerId,
    routeRevision: routes.snapshot().revision,
    connectionId: input.connectionId,
    senderIdentity: `${input.connectionId}-rtp\u0000track`,
    sampleTimestampMs: input.acceptedAtMs,
    state: input.state,
    acceptedAtMs: input.acceptedAtMs,
  });
}

function observePersistentDegraded(
  routes: RoomRouteController<string>,
  childPeerId: string,
  connectionId: string,
  acceptedAtMs: number,
  parentPeerId = HOST,
): void {
  expect(
    observeSenderState(routes, {
      childPeerId,
      connectionId,
      parentPeerId,
      state: "healthy",
      acceptedAtMs,
    }).accepted,
  ).toBe(true);
  for (let offset = 1; offset <= 3; offset += 1) {
    expect(
      observeSenderState(routes, {
        childPeerId,
        connectionId,
        parentPeerId,
        state: "degraded",
        acceptedAtMs: acceptedAtMs + offset,
      }).accepted,
    ).toBe(true);
  }
}

function observePersistentSfuHealthy(
  routes: RoomRouteController<string>,
  publicationGeneration: string,
  routeRevision: number,
  acceptedAtMs: number,
) {
  let result;
  for (let offset = 0; offset < 3; offset += 1) {
    result = routes.observeSfuPublisherQualityEvidence({
      hostPeerId: HOST,
      hostSessionId: "host_session",
      publicationGeneration,
      routeRevision,
      state: "healthy",
      sampleTimestampMs: acceptedAtMs + offset,
      acceptedAtMs: acceptedAtMs + offset,
    });
    expect(result.accepted).toBe(true);
  }
  return result!;
}

type RouteQualityMetrics = Pick<
  ViewerQualityEvidenceMetrics,
  | "framesDecodedDelta"
  | "freezeCountDelta"
  | "freezeDurationMsDelta"
  | "pauseCountDelta"
  | "pauseDurationMsDelta"
>;

function qualityMetrics(
  overrides: Partial<RouteQualityMetrics> = {},
): RouteQualityMetrics {
  return {
    framesDecodedDelta: 120,
    freezeCountDelta: 1,
    freezeDurationMsDelta: 250,
    pauseCountDelta: 0,
    pauseDurationMsDelta: 0,
    ...overrides,
  };
}

describe("RoomRouteController", () => {
  it("keeps isolated limitation windows diagnostic", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 99,
    });
    observeSenderState(routes, {
      childPeerId: A,
      connectionId: "a_from_host",
      state: "healthy",
      acceptedAtMs: 99,
    });
    observeSenderState(routes, {
      childPeerId: A,
      connectionId: "a_from_host",
      state: "degraded",
      acceptedAtMs: 100,
    });
    expect(
      routes.observeSenderQualityEvidence({
        parentPeerId: HOST,
        parentSessionId: "host_session",
        childPeerId: A,
        routeRevision: routes.snapshot().revision,
        connectionId: "a_from_host",
        senderIdentity: "a_from_host-rtp\u0000track",
        sampleTimestampMs: 100,
        state: "degraded",
        acceptedAtMs: 101,
      }).accepted,
    ).toBe(true);
    expect(routes.reconcile(101).operation).toBeUndefined();
    for (const acceptedAtMs of [102]) {
      observeSenderState(routes, {
        childPeerId: A,
        connectionId: "a_from_host",
        state: "degraded",
        acceptedAtMs,
      });
      expect(routes.reconcile(acceptedAtMs).operation).toBeUndefined();
    }
    observeSenderState(routes, {
      childPeerId: A,
      connectionId: "a_from_host",
      state: "degraded",
      acceptedAtMs: 103,
    });
    expect(routes.reconcile(104).operation).toMatchObject({
      childPeerId: A,
      reason: "quality-convergence",
    });
  });

  it("never treats one degraded Host edge as SFU fanout pressure", () => {
    const routes = controller(2, {
      sfuEnabled: true,
      qualityConvergenceEnabled: true,
    });
    addViewer(routes, A, 1);
    addViewer(routes, B, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateHostPublication(
      "publication_generation_12345678",
      "publication_resource",
    );
    routes.hydrateEdge(B, {
      kind: "sfu",
      publicationGeneration: "publication_generation_12345678",
      transport: "sfu",
      connectionId: "b_from_sfu",
      usable: true,
      physicalActive: true,
      resource: "b_subscription",
    });
    observePersistentDegraded(routes, A, "a_from_host", 99);
    observePersistentSfuHealthy(
      routes,
      "publication_generation_12345678",
      routes.snapshot().revision,
      103,
    );
    expect(routes.reconcile(104).operation).toBeUndefined();
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      parentPeerId: HOST,
    });
  });

  it("commits only after the Viewer approves a P2P receive improvement", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    expect(
      observeSenderState(routes, {
        childPeerId: B,
        connectionId: "b_from_host",
        state: "healthy",
        acceptedAtMs: 100,
      }).accepted,
    ).toBe(true);
    observePersistentDegraded(routes, A, "a_from_host", 99);

    const operation = routes.reconcile(103).operation!;
    expect(operation.reason).toBe("quality-convergence");
    expect(operation.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: B,
      transport: "direct",
    });
    const begin = beginCandidate(routes, {
      nowMs: 104,
      connectionId: "a_from_b",
      reservation: { kind: "direct" },
    });
    const current = begin.operation!.current!;
    const guard: CandidateGuard = {
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: current.revision,
      connectionId: "a_from_b",
    };
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      parentPeerId: HOST,
      connectionId: "a_from_host",
    });
    expect(
      routes.candidateReady(guard, 105, undefined, {
        relativeQualityApproved: true,
      }),
    ).toMatchObject({
      accepted: true,
      committed: true,
    });
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      parentPeerId: B,
      connectionId: "a_from_b",
    });

    const migratedRevision = routes.snapshot().revision;
    const observeMigrated = (state: "healthy" | "degraded", at: number) =>
      routes.observeSenderQualityEvidence({
        parentPeerId: B,
        parentSessionId: `${B}_session`,
        childPeerId: A,
        routeRevision: migratedRevision,
        connectionId: "a_from_b",
        senderIdentity: "a-from-b-rtp\u0000a-track",
        sampleTimestampMs: at,
        state,
        acceptedAtMs: at,
      });
    expect(observeMigrated("degraded", 107).accepted).toBe(true);
    expect(routes.reconcile(108).operation).toBeUndefined();
    expect(observeMigrated("healthy", 109).accepted).toBe(true);
    expect(observeMigrated("degraded", 110).accepted).toBe(true);
    expect(observeMigrated("degraded", 111).accepted).toBe(true);
    expect(observeMigrated("degraded", 112).accepted).toBe(true);
    expect(routes.reconcile(113).operation?.reason).toBe(
      "quality-convergence",
    );
  });

  it("uses one healthy serial operation to distribute a newly committed Host root", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, B, 2);
    addViewer(routes, C, 0);
    addViewer(routes, D, 0);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    routes.hydrateEdge(C, peerEdge(B, "c_from_b"));
    routes.hydrateEdge(D, peerEdge(B, "d_from_b"));
    addViewer(routes, A, 2, 10);

    const joined = routes.reconcile(10).operation!;
    expect(joined.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: HOST,
      transport: "direct",
    });
    commitCurrent(routes, 11, "a_from_host");

    const convergence = routes.reconcile(13).operation!;
    expect(convergence).toMatchObject({ reason: "root-convergence" });
    expect(convergence.candidates).toHaveLength(1);
    expect(convergence.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: A,
      transport: "direct",
    });
    const oldParent = (
      routes.snapshot().upstreamByViewer.get(convergence.childPeerId) as {
        parentPeerId: string;
      }
    ).parentPeerId;
    expect(oldParent).toBe(B);

    const prepared = beginCandidate(routes, {
      nowMs: 14,
      connectionId: "root_convergence_candidate",
      reservation: { kind: "direct" },
    }).operation!;
    const guard = {
      childPeerId: convergence.childPeerId,
      childSessionId: convergence.childSessionId,
      revision: prepared.current!.revision,
      connectionId: "root_convergence_candidate",
    };
    expect(routes.candidateReady(guard, 15)).toMatchObject({
      accepted: true,
      committed: false,
    });
    expect(
      routes.observeSenderQualityEvidence({
        parentPeerId: A,
        parentSessionId: `${A}_session`,
        childPeerId: convergence.childPeerId,
        routeRevision: prepared.current!.revision,
        connectionId: "root_convergence_candidate",
        senderIdentity: "root-rtp\u0000track",
        sampleTimestampMs: 16,
        state: "healthy",
        acceptedAtMs: 16,
      }).committed,
    ).toBe(true);
    expect(
      routes.snapshot().upstreamByViewer.get(convergence.childPeerId),
    ).toMatchObject({ parentPeerId: A });
    expect(routes.reconcile(17).operation).toBeUndefined();
  });

  it("gives each unconnected Peer candidate its own bounded progress window", () => {
    const routes = controller(2, { operationTimeoutMs: 20_000 });
    addViewer(routes, B, 2);
    addViewer(routes, C, 2);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"));
    addViewer(routes, A, 0, 0);

    const operation = routes.reconcile(0).operation!;
    beginCandidate(routes, {
      nowMs: 100,
      connectionId: "first_silent_candidate",
      reservation: { kind: "direct" },
    });
    expect(routes.snapshot().operation?.wakeAtMs).toBe(5_100);
    expect(routes.operationExpired(5_100).accepted).toBe(true);

    beginCandidate(routes, {
      nowMs: 5_200,
      connectionId: "second_silent_candidate",
      reservation: { kind: "direct" },
    });
    expect(routes.snapshot().operation?.wakeAtMs).toBe(10_200);
    expect(routes.snapshot().operation?.deadlineAtMs).toBe(
      operation.deadlineAtMs,
    );
  });

  it("keeps only fresh exact-edge quality shadow aggregates", () => {
    const routes = controller(2);
    addViewer(routes, A, 1, 0);
    routes.reconcile(10);
    commitCurrent(routes, 20, "a_quality_connection");
    const active = routes.snapshot();

    expect(
      routes.observeQualityEvidence({
        childPeerId: A,
        childSessionId: `${A}_session`,
        routeRevision: active.revision,
        connectionId: "a_quality_connection",
        upstream: { kind: "peer", peerId: HOST },
        presentationEpoch: 1,
        windowMs: 2_000,
        metrics: qualityMetrics(),
        acceptedAtMs: 1_000,
      }),
    ).toBe("observed");
    expect(routes.snapshot()).toMatchObject({
      revision: active.revision,
      factVersion: active.factVersion,
    });
    addViewer(routes, B, 0, 1_100);
    routes.reconcile(1_200);
    commitCurrent(routes, 1_210, "b_quality_connection");
    expect(routes.routeDiagnosticSnapshot(1_300).children[0]?.quality).toEqual({
      eligibleWindows: 1,
      eligibleDurationMs: 2_000,
      freezeWindows: 1,
      freezeCount: 1,
      freezeDurationMs: 250,
      pauseCount: 0,
      pauseDurationMs: 0,
    });
    expect(routes.routeDiagnosticSnapshot(5_999).children[0]?.quality).not.toBeNull();
    expect(routes.routeDiagnosticSnapshot(6_000).children[0]?.quality).toBeNull();

    const nextRevision = routes.snapshot().revision;
    expect(
      routes.observeQualityEvidence({
        childPeerId: A,
        childSessionId: `${A}_session`,
        routeRevision: nextRevision,
        connectionId: "a_quality_connection",
        upstream: { kind: "peer", peerId: HOST },
        presentationEpoch: 2,
        windowMs: 2_000,
        metrics: qualityMetrics({ framesDecodedDelta: null }),
        acceptedAtMs: 7_000,
      }),
    ).toBe("accepted");
    expect(routes.routeDiagnosticSnapshot(7_100).children[0]?.quality).toBeNull();
    expect(
      routes.observeQualityEvidence({
        childPeerId: A,
        childSessionId: `${A}_session`,
        routeRevision: nextRevision,
        connectionId: "a_quality_connection",
        upstream: { kind: "peer", peerId: HOST },
        presentationEpoch: 2,
        windowMs: 2_000,
        metrics: qualityMetrics(),
        acceptedAtMs: 7_100,
      }),
    ).toBe("observed");
    expect(
      routes.observeQualityEvidence({
        childPeerId: A,
        childSessionId: `${A}_session`,
        routeRevision: nextRevision,
        connectionId: "a_quality_connection",
        upstream: { kind: "peer", peerId: HOST },
        presentationEpoch: 1,
        windowMs: 2_000,
        metrics: qualityMetrics(),
        acceptedAtMs: 7_200,
      }),
    ).toBe("rejected");

    routes.setPaused(true, 7_300);
    expect(routes.routeDiagnosticSnapshot(7_301).children[0]?.quality).toBeNull();
  });

  it("does not let one candidate limitation window override relative proof", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    expect(
      observeSenderState(routes, {
        childPeerId: B,
        connectionId: "b_from_host",
        state: "healthy",
        acceptedAtMs: 100,
      }).accepted,
    ).toBe(true);
    observePersistentDegraded(routes, A, "a_from_host", 99);
    routes.reconcile(103);
    const begin = beginCandidate(routes, {
      nowMs: 104,
      connectionId: "a_from_b",
      reservation: { kind: "direct" },
    });
    const current = begin.operation!.current!;
    expect(
      routes.candidateTransportConnected(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_b",
        },
        105,
      ).accepted,
    ).toBe(true);
    expect(
      routes.observeSenderQualityEvidence({
        parentPeerId: B,
        parentSessionId: `${B}_session`,
        childPeerId: A,
        routeRevision: current.revision,
        connectionId: "a_from_b",
        senderIdentity: "a-from-b-rtp\u0000track",
        sampleTimestampMs: 105,
        state: "degraded",
        acceptedAtMs: 105,
      }).accepted,
    ).toBe(true);
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_b",
        },
        106,
        undefined,
        { relativeQualityApproved: true },
      ).committed,
    ).toBe(true);
  });

  it("does not let unknown candidate sender evidence veto relative proof", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 99,
    });
    observePersistentDegraded(routes, A, "a_from_host", 99);
    routes.reconcile(103);
    const begin = beginCandidate(routes, {
      nowMs: 104,
      connectionId: "a_from_b",
      reservation: { kind: "direct" },
    });
    const current = begin.operation!.current!;
    expect(
      routes.observeSenderQualityEvidence({
        parentPeerId: B,
        parentSessionId: `${B}_session`,
        childPeerId: A,
        routeRevision: current.revision,
        connectionId: "a_from_b",
        senderIdentity: null,
        sampleTimestampMs: null,
        state: "unknown",
        acceptedAtMs: 105,
      }).accepted,
    ).toBe(true);
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_b",
        },
        106,
        undefined,
        { relativeQualityApproved: true },
      ).committed,
    ).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      parentPeerId: B,
      connectionId: "a_from_b",
    });
  });

  it("advances past a persistently limited quality candidate", () => {
    const routes = controller(3, { qualityConvergenceEnabled: true });
    for (const [peerId, connectionId] of [
      [A, "a_from_host"],
      [B, "b_from_host"],
      [C, "c_from_host"],
    ] as const) {
      addViewer(routes, peerId, 3);
      routes.hydrateEdge(peerId, peerEdge(HOST, connectionId));
    }
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 99,
    });
    observeSenderState(routes, {
      childPeerId: C,
      connectionId: "c_from_host",
      state: "healthy",
      acceptedAtMs: 99,
    });
    observePersistentDegraded(routes, A, "a_from_host", 99);

    const operation = routes.reconcile(103).operation!;
    const deadlineAtMs = operation.deadlineAtMs;
    const firstParent = (
      operation.candidates[0]!.tuple as Extract<
        (typeof operation.candidates)[number]["tuple"],
        { kind: "peer" }
      >
    ).parentPeerId;
    const first = beginCandidate(routes, {
      nowMs: 104,
      connectionId: "first_quality_candidate",
      reservation: { kind: "direct" },
    }).operation!;
    let lastResult;
    for (const acceptedAtMs of [105, 106, 107]) {
      lastResult = routes.observeSenderQualityEvidence({
        parentPeerId: firstParent,
        parentSessionId: `${firstParent}_session`,
        childPeerId: A,
        routeRevision: first.current!.revision,
        connectionId: "first_quality_candidate",
        senderIdentity: "first-quality-rtp\u0000track",
        sampleTimestampMs: acceptedAtMs,
        state: "degraded",
        acceptedAtMs,
      });
      expect(lastResult.accepted).toBe(true);
    }
    expect(lastResult?.committed).toBe(false);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      parentPeerId: HOST,
      connectionId: "a_from_host",
    });
    expect(routes.snapshot().operation).toMatchObject({
      cursor: 1,
      deadlineAtMs,
      current: undefined,
    });

    const secondParent = (
      routes.snapshot().operation!.candidates[1]!.tuple as Extract<
        (typeof operation.candidates)[number]["tuple"],
        { kind: "peer" }
      >
    ).parentPeerId;
    expect(secondParent).not.toBe(firstParent);
    const second = beginCandidate(routes, {
      nowMs: 108,
      connectionId: "second_quality_candidate",
      reservation: { kind: "direct" },
    }).operation!;
    expect(
      routes.observeSenderQualityEvidence({
        parentPeerId: secondParent,
        parentSessionId: `${secondParent}_session`,
        childPeerId: A,
        routeRevision: second.current!.revision,
        connectionId: "second_quality_candidate",
        senderIdentity: null,
        sampleTimestampMs: null,
        state: "unknown",
        acceptedAtMs: 109,
      }).accepted,
    ).toBe(true);
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: second.current!.revision,
          connectionId: "second_quality_candidate",
        },
        110,
        undefined,
        { relativeQualityApproved: true },
      ).committed,
    ).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      parentPeerId: secondParent,
      connectionId: "second_quality_candidate",
    });
  });

  it("preempts quality work for a Viewer without media", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 100,
    });
    observePersistentDegraded(routes, A, "a_from_host", 99);
    expect(routes.reconcile(103).operation?.reason).toBe(
      "quality-convergence",
    );
    addViewer(routes, C, 0, 104);
    expect(routes.reconcile(105).operation).toMatchObject({
      childPeerId: C,
      reason: "join",
    });
    commitCurrent(routes, 106, "c_join_connection");
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 107,
    });
    observePersistentDegraded(routes, A, "a_from_host", 107);
    expect(routes.reconcile(111).operation?.reason).toBe(
      "quality-convergence",
    );
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      parentPeerId: HOST,
      connectionId: "a_from_host",
    });
  });

  it("keeps a quality operation reason immutable until availability preempts it", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 99,
    });
    observePersistentDegraded(routes, A, "a_from_host", 99);
    expect(routes.reconcile(103).operation?.reason).toBe(
      "quality-convergence",
    );

    expect(
      routes.invalidateEdge(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          parentSessionId: "host_session",
          routeRevision: routes.snapshot().revision,
          connectionId: "a_from_host",
        },
        104,
      ),
    ).toBe(true);
    expect(routes.snapshot().operation?.reason).toBe("quality-convergence");
    expect(routes.reconcile(105).operation).toMatchObject({
      childPeerId: A,
      reason: "edge-unavailable",
    });
  });

  it("keeps a direct convergence reason immutable until availability preempts it", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    routes.hydrateHostPublication("publication", "publication_resource");
    addViewer(routes, A, 0, 0);
    const acquisition = routes.reconcile(0).operation!;
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(acquisition.wakeAtMs);
    const sfu = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 1,
      connectionId: "a_sfu",
      reservation: { kind: "sfu-reuse", edge: "a_subscription" },
    }).operation!;
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: sfu.current!.revision,
          connectionId: "a_sfu",
        },
        acquisition.wakeAtMs + 2,
      ).committed,
    ).toBe(true);
    expect(routes.reconcile(acquisition.wakeAtMs + 3).operation?.reason).toBe(
      "direct-convergence",
    );

    expect(
      routes.invalidateEdge(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          routeRevision: routes.snapshot().revision,
          connectionId: "a_sfu",
        },
        acquisition.wakeAtMs + 4,
      ),
    ).toBe(true);
    expect(routes.snapshot().operation?.reason).toBe("direct-convergence");
    expect(routes.reconcile(acquisition.wakeAtMs + 5).operation).toMatchObject({
      childPeerId: A,
      reason: "edge-unavailable",
    });
  });

  it("keeps a root convergence reason immutable until availability preempts it", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, B, 2);
    addViewer(routes, C, 0);
    addViewer(routes, D, 0);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    routes.hydrateEdge(C, peerEdge(B, "c_from_b"));
    routes.hydrateEdge(D, peerEdge(B, "d_from_b"));
    addViewer(routes, A, 2, 10);
    routes.reconcile(10);
    commitCurrent(routes, 11, "a_from_host");
    const convergence = routes.reconcile(13).operation!;
    expect(convergence.reason).toBe("root-convergence");
    const oldEdge = routes.snapshot().upstreamByViewer.get(
      convergence.childPeerId,
    );
    expect(oldEdge?.kind).toBe("peer");
    if (oldEdge?.kind !== "peer") throw new Error("Expected Peer edge");

    expect(
      routes.invalidateEdge(
        {
          childPeerId: convergence.childPeerId,
          childSessionId: convergence.childSessionId,
          parentSessionId: oldEdge.parentSessionId,
          routeRevision: routes.snapshot().revision,
          connectionId: oldEdge.connectionId,
        },
        14,
      ),
    ).toBe(true);
    expect(routes.snapshot().operation?.reason).toBe("root-convergence");
    expect(routes.reconcile(15).operation).toMatchObject({
      childPeerId: convergence.childPeerId,
      reason: "edge-unavailable",
    });
  });

  it("keeps a usable parent eligible before native state becomes clear", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observePersistentDegraded(routes, A, "a_from_host", 99);
    expect(routes.reconcile(103).operation).toMatchObject({
      childPeerId: A,
      reason: "quality-convergence",
      candidates: [
        {
          tuple: { kind: "peer", parentPeerId: B, transport: "direct" },
        },
      ],
    });
  });

  it("uses relative proof after candidate native state expires", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    const observeCurrent = (
      childPeerId: string,
      connectionId: string,
      state: "healthy" | "degraded",
      acceptedAtMs: number,
    ) =>
      routes.observeSenderQualityEvidence({
        parentPeerId: HOST,
        parentSessionId: "host_session",
        childPeerId,
        routeRevision: routes.snapshot().revision,
        connectionId,
        senderIdentity: `${connectionId}-rtp\u0000track`,
        sampleTimestampMs: acceptedAtMs,
        state,
        acceptedAtMs,
      });
    expect(observeCurrent(B, "b_from_host", "healthy", 100).accepted).toBe(
      true,
    );
    expect(observeCurrent(A, "a_from_host", "healthy", 99).accepted).toBe(
      true,
    );
    expect(observeCurrent(A, "a_from_host", "degraded", 100).accepted).toBe(
      true,
    );
    expect(observeCurrent(A, "a_from_host", "degraded", 101).accepted).toBe(
      true,
    );
    expect(observeCurrent(A, "a_from_host", "degraded", 102).accepted).toBe(
      true,
    );
    routes.reconcile(103);
    const begin = beginCandidate(routes, {
      nowMs: 104,
      connectionId: "a_from_b_stale",
      reservation: { kind: "direct" },
    });
    const current = begin.operation!.current!;
    expect(
      routes.candidateTransportConnected(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_b_stale",
        },
        105,
      ).accepted,
    ).toBe(true);
    expect(
      routes.observeSenderQualityEvidence({
        parentPeerId: B,
        parentSessionId: `${B}_session`,
        childPeerId: A,
        routeRevision: current.revision,
        connectionId: "a_from_b_stale",
        senderIdentity: "a-stale-rtp\u0000a-track",
        sampleTimestampMs: 104,
        state: "healthy",
        acceptedAtMs: 104,
      }).accepted,
    ).toBe(true);
    for (const acceptedAtMs of [5_101, 5_102, 5_103]) {
      expect(
        observeCurrent(A, "a_from_host", "degraded", acceptedAtMs).accepted,
      ).toBe(true);
    }
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_b_stale",
        },
        5_104,
        undefined,
        { relativeQualityApproved: true },
      ).committed,
    ).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      parentPeerId: B,
      connectionId: "a_from_b_stale",
    });
  });

  it("keeps a usable candidate when its native source category expires", () => {
    const routes = controller(2, { qualityConvergenceEnabled: true });
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observeSenderState(routes, {
      childPeerId: B,
      connectionId: "b_from_host",
      state: "healthy",
      acceptedAtMs: 0,
    });
    observePersistentDegraded(routes, A, "a_from_host", 0);
    expect(routes.reconcile(4).operation?.reason).toBe("quality-convergence");
    const begin = beginCandidate(routes, {
      nowMs: 5_001,
      connectionId: "expired_candidate",
      reservation: { kind: "direct" },
    });
    expect(begin.accepted).toBe(true);
    expect(begin.operation?.current?.connectionId).toBe("expired_candidate");
  });

  it("keeps bounded SFU after direct candidates when every Host root is degraded", () => {
    const routes = controller(2, {
      sfuEnabled: true,
      qualityConvergenceEnabled: true,
    });
    addViewer(routes, A, 1);
    addViewer(routes, B, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observePersistentDegraded(routes, A, "a_from_host", 99);
    expect(routes.reconcile(103).operation).toBeUndefined();
    observePersistentDegraded(routes, B, "b_from_host", 104);
    const operation = routes.reconcile(108).operation!;
    const childPeerId = operation.childPeerId;
    expect(operation.candidates.map((candidate) => candidate.tuple)).toEqual([
      { kind: "peer", parentPeerId: A, transport: "direct" },
      { kind: "sfu", publication: "create" },
    ]);
    const direct = beginCandidate(routes, {
      nowMs: 109,
      connectionId: "quality_peer_candidate",
      reservation: { kind: "direct" },
    }).operation!;
    expect(
      routes.candidateFailed(
        {
          childPeerId,
          childSessionId: `${childPeerId}_session`,
          revision: direct.current!.revision,
          connectionId: "quality_peer_candidate",
        },
        110,
      ),
    ).toMatchObject({ accepted: true, failedPeerIds: [] });

    const begin = beginCandidate(routes, {
      nowMs: 111,
      connectionId: "quality_sfu_candidate",
      reservation: {
        kind: "sfu-create",
        edge: "sfu-edge",
        publication: "sfu-publication",
        overlap: "host-overlap",
      },
      publicationGeneration: "publication_generation_12345678",
      publicationConnectionId: "publication_connection_12345678",
      hostSessionId: "host_session",
    });
    const current = begin.operation!.current!;
    expect(
      routes.candidateReady(
        {
          childPeerId,
          childSessionId: `${childPeerId}_session`,
          revision: current.revision,
          connectionId: "quality_sfu_candidate",
        },
        112,
      ),
    ).toMatchObject({ accepted: true, committed: false });
    expect(
      observePersistentSfuHealthy(
        routes,
        "publication_generation_12345678",
        current.revision,
        113,
      ).committed,
    ).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(childPeerId)).toMatchObject({
      kind: "sfu",
      connectionId: "quality_sfu_candidate",
    });
  });

  it("abandons Host relief when another Host root recovers during the canary", () => {
    const routes = controller(2, {
      sfuEnabled: true,
      qualityConvergenceEnabled: true,
    });
    addViewer(routes, A, 1);
    addViewer(routes, B, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    observePersistentDegraded(routes, A, "a_from_host", 99);
    observePersistentDegraded(routes, B, "b_from_host", 99);
    routes.reconcile(103);
    const begin = beginCandidate(routes, {
      nowMs: 104,
      connectionId: "a_from_sfu",
      reservation: {
        kind: "sfu-create",
        edge: "sfu-edge",
        publication: "sfu-publication",
        overlap: "host-overlap",
      },
      publicationGeneration: "publication_generation_12345678",
      publicationConnectionId: "publication_connection_12345678",
      hostSessionId: "host_session",
    });
    const current = begin.operation!.current!;
    expect(
      observeSenderState(routes, {
        childPeerId: B,
        connectionId: "b_from_host",
        state: "healthy",
        acceptedAtMs: 105,
      }).accepted,
    ).toBe(true);
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_sfu",
        },
        106,
      ).committed,
    ).not.toBe(true);
    expect(routes.snapshot().operation).toBeUndefined();
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      parentPeerId: HOST,
      connectionId: "a_from_host",
    });
  });

  it("uses SFU reuse only for multi-edge Host relief with healthy ingress", () => {
    const routes = controller(3, {
      sfuEnabled: true,
      qualityConvergenceEnabled: true,
    });
    addViewer(routes, A, 0);
    addViewer(routes, B, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    routes.hydrateHostPublication(
      "publication_generation_12345678",
      "publication_resource",
    );
    const revision = routes.snapshot().revision;
    observePersistentDegraded(routes, A, "a_from_host", 99);
    observePersistentDegraded(routes, B, "b_from_host", 99);
    expect(routes.reconcile(103).operation).toBeUndefined();
    observePersistentSfuHealthy(
      routes,
      "publication_generation_12345678",
      revision,
      104,
    );
    expect(routes.reconcile(105).operation?.candidates[0]?.tuple).toEqual({
      kind: "sfu",
      publication: "reuse",
    });
    const begin = beginCandidate(routes, {
      nowMs: 106,
      connectionId: "a_from_sfu_reuse",
      reservation: { kind: "sfu-reuse", edge: "a_subscription" },
    });
    const current = begin.operation!.current!;
    expect(
      routes.observeSfuPublisherQualityEvidence({
        hostPeerId: HOST,
        hostSessionId: "host_session",
        publicationGeneration: "publication_generation_12345678",
        routeRevision: revision,
        state: "unknown",
        sampleTimestampMs: null,
        acceptedAtMs: 107,
      }).accepted,
    ).toBe(true);
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: current.revision,
          connectionId: "a_from_sfu_reuse",
        },
        108,
      ).committed,
    ).not.toBe(true);
    for (const acceptedAtMs of [2_100, 4_100, 6_100]) {
      observeSenderState(routes, {
        childPeerId: A,
        connectionId: "a_from_host",
        state: "degraded",
        acceptedAtMs,
      });
      observeSenderState(routes, {
        childPeerId: B,
        connectionId: "b_from_host",
        state: "degraded",
        acceptedAtMs,
      });
      const settled = routes.observeSfuPublisherQualityEvidence({
        hostPeerId: HOST,
        hostSessionId: "host_session",
        publicationGeneration: "publication_generation_12345678",
        routeRevision: revision,
        state: "healthy",
        sampleTimestampMs: acceptedAtMs,
        acceptedAtMs,
      });
      expect(settled.committed).toBe(acceptedAtMs === 6_100);
    }
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "sfu",
      connectionId: "a_from_sfu_reuse",
    });
  });

  it("accepts an SFU-fed Peer parent from decoded progress without freeze stats", () => {
    const routes = controller(2, {
      sfuEnabled: true,
      qualityConvergenceEnabled: true,
    });
    addViewer(routes, A, 1);
    addViewer(routes, B, 2);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateHostPublication(
      "publication_generation_12345678",
      "publication_resource",
    );
    routes.hydrateEdge(B, {
      kind: "sfu",
      publicationGeneration: "publication_generation_12345678",
      transport: "sfu",
      connectionId: "b_from_sfu",
      usable: true,
      physicalActive: true,
      resource: "b_subscription",
    });
    const revision = routes.snapshot().revision;
    observePersistentSfuHealthy(
      routes,
      "publication_generation_12345678",
      revision,
      100,
    );
    expect(
      routes.observeQualityEvidence({
        childPeerId: B,
        childSessionId: `${B}_session`,
        routeRevision: revision,
        connectionId: "b_from_sfu",
        upstream: { kind: "sfu" },
        presentationEpoch: 1,
        windowMs: 2_000,
        metrics: qualityMetrics({
          freezeCountDelta: null,
          freezeDurationMsDelta: null,
          pauseCountDelta: null,
          pauseDurationMsDelta: null,
        }),
        acceptedAtMs: 100,
      }),
    ).toBe("accepted");
    observePersistentDegraded(routes, A, "a_from_host", 99);
    expect(routes.reconcile(103).operation?.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: B,
      transport: "direct",
    });
  });

  it("clears quality shadow for a relay subtree when its source changes", () => {
    const routes = controller(2);
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    addViewer(routes, C, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(A, "b_from_a"));
    routes.hydrateEdge(C, peerEdge(B, "c_from_b"));
    const revision = routes.snapshot().revision;

    for (const [childPeerId, parentPeerId, connectionId] of [
      [B, A, "b_from_a"],
      [C, B, "c_from_b"],
    ] as const) {
      expect(
        routes.observeQualityEvidence({
          childPeerId,
          childSessionId: `${childPeerId}_session`,
          routeRevision: revision,
          connectionId,
          upstream: { kind: "peer", peerId: parentPeerId },
          presentationEpoch: 1,
          windowMs: 2_000,
          metrics: qualityMetrics(),
          acceptedAtMs: 1_000,
        }),
      ).toBe("observed");
    }
    expect(
      routes
        .routeDiagnosticSnapshot(1_001)
        .children.filter((child) => child.quality !== null),
    ).toHaveLength(2);

    expect(
      routes.adoptDirectConnection({
        childPeerId: A,
        childSessionId: `${A}_session`,
        parentSessionId: "host_session",
        routeRevision: revision,
        connectionId: "a_from_host",
        newConnectionId: "a_from_host_recovered",
      }),
    ).toBe(true);
    expect(
      routes
        .routeDiagnosticSnapshot(1_002)
        .children.every((child) => child.quality === null),
    ).toBe(true);

    for (const [acceptedAtMs, expected] of [
      [1_100, "accepted"],
      [3_100, "observed"],
    ] as const) {
      for (const [childPeerId, parentPeerId, connectionId] of [
        [B, A, "b_from_a"],
        [C, B, "c_from_b"],
      ] as const) {
        expect(
          routes.observeQualityEvidence({
            childPeerId,
            childSessionId: `${childPeerId}_session`,
            routeRevision: revision,
            connectionId,
            upstream: { kind: "peer", peerId: parentPeerId },
            presentationEpoch: 1,
            windowMs: 2_000,
            metrics: qualityMetrics(),
            acceptedAtMs,
          }),
        ).toBe(expected);
      }
    }
    expect(
      routes
        .routeDiagnosticSnapshot(3_101)
        .children.filter((child) => child.quality !== null),
    ).toHaveLength(2);
  });

  it("retains one latest timing sample for a 20-Viewer burst", () => {
    const routes = controller(2);
    const viewerPeerIds = Array.from(
      { length: 20 },
      (_, index) => `burst_${String(index).padStart(2, "0")}_12345678`,
    );
    for (const peerId of viewerPeerIds) addViewer(routes, peerId, 2, 0);

    for (const [index, peerId] of viewerPeerIds.entries()) {
      const operationStartedAtMs = (index + 1) * 10;
      expect(routes.reconcile(operationStartedAtMs).operation?.childPeerId).toBe(
        peerId,
      );
      commitCurrent(
        routes,
        operationStartedAtMs + 1,
        `${peerId}_connection`,
      );
    }

    const snapshot = routes.routeDiagnosticSnapshot(250);
    expect(snapshot.children).toHaveLength(20);
    expect(snapshot.children.map((child) => child.queueWaitMs)).toEqual(
      Array.from({ length: 20 }, (_, index) => (index + 1) * 10),
    );
    expect(snapshot.children.every((child) => child.finalRoute === "direct"))
      .toBe(true);
  });

  it("projects latest route timing through snapshot-local ordinals", () => {
    const routes = controller(2);
    addViewer(routes, A, 1, 100);

    expect(routes.routeDiagnosticSnapshot(150)).toEqual({
      children: [
        {
          ordinal: 1,
          parent: { kind: "none" },
          effectiveCapacity: 1,
          childCount: 0,
          demandAgeMs: 50,
          queueWaitMs: null,
          candidateStartMs: null,
          firstDecodedFrameMs: null,
          finalMs: null,
          finalRoute: "waiting",
          rejectionBucket: "none",
          quality: null,
        },
      ],
      operation: null,
    });

    const operation = routes.reconcile(160).operation!;
    expect(routes.routeDiagnosticSnapshot(165).operation).toEqual({
      childOrdinal: 1,
      reason: "join",
      stage: "admission",
      cursor: 0,
      candidateCount: operation.candidates.length,
    });
    const prepared = beginCandidate(routes, {
      nowMs: 170,
      connectionId: "a_connection",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.routeDiagnosticSnapshot(180)).toMatchObject({
      children: [
        {
          queueWaitMs: 60,
          candidateStartMs: 70,
          firstDecodedFrameMs: null,
          finalMs: null,
        },
      ],
      operation: { childOrdinal: 1, stage: "first-frame" },
    });
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: prepared.current!.revision,
          connectionId: "a_connection",
        },
        230,
      ).accepted,
    ).toBe(true);
    const settled = routes.routeDiagnosticSnapshot(240);
    expect(settled).toMatchObject({
      children: [
        {
          parent: { kind: "host" },
          queueWaitMs: 60,
          candidateStartMs: 70,
          firstDecodedFrameMs: 130,
          finalMs: 130,
          finalRoute: "direct",
          rejectionBucket: "none",
        },
      ],
      operation: null,
    });
    expect(JSON.stringify(settled)).not.toContain(A);
    expect(JSON.stringify(settled)).not.toContain("a_connection");

    expect(
      routes.invalidateEdge(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          parentSessionId: "host_session",
          routeRevision: routes.snapshot().revision,
          connectionId: "a_connection",
        },
        300,
      ),
    ).toBe(true);
    expect(routes.routeDiagnosticSnapshot(320).children[0]).toMatchObject({
      demandAgeMs: 20,
      queueWaitMs: null,
      candidateStartMs: null,
      firstDecodedFrameMs: null,
      finalMs: null,
      finalRoute: "waiting",
      rejectionBucket: "none",
    });

    expect(routes.confirmDeparture(A, 330)).toBe(true);
    expect(routes.routeDiagnosticSnapshot(330)).toEqual({
      children: [],
      operation: null,
    });
  });

  it("records a bounded candidate failure without retaining route identity", () => {
    const routes = controller(1);
    addViewer(routes, A, 0, 0);
    routes.reconcile(10);
    const prepared = beginCandidate(routes, {
      nowMs: 20,
      connectionId: "failed_candidate",
      reservation: { kind: "direct" },
    }).operation!;
    expect(
      routes.candidateFailed(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: prepared.current!.revision,
          connectionId: "failed_candidate",
        },
        30,
      ),
    ).toMatchObject({ accepted: true, failedPeerIds: [A] });
    expect(routes.routeDiagnosticSnapshot(30).children[0]).toMatchObject({
      finalMs: 30,
      finalRoute: "failed",
      rejectionBucket: "candidate-failed",
    });

    routes.dispose();
    expect(routes.routeDiagnosticSnapshot(40)).toEqual({
      children: [],
      operation: null,
    });
  });

  it("reports a current child that has no usable candidate", () => {
    const routes = controller(1);
    addViewer(routes, A, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_connection"));
    addViewer(routes, B, 0, 0);

    const result = routes.reconcile(10);
    expect(result.operation).toBeUndefined();
    expect(result.failedPeerIds).toEqual([B]);
    expect(routes.routeDiagnosticSnapshot(10).children[1]).toMatchObject({
      finalMs: 10,
      finalRoute: "failed",
      rejectionBucket: "candidate-failed",
    });
  });

  it("records SFU admission waiting without advancing the route cursor", () => {
    const routes = controller(1, { sfuEnabled: true });
    addViewer(routes, A, 0, 0);
    const direct = routes.reconcile(10).operation!;
    expect(direct.candidates.map((candidate) => candidate.tuple.kind)).toEqual([
      "peer",
      "sfu",
    ]);
    expect(
      routes.skipCurrentCandidate(
        cursorGuard(direct),
        20,
        "candidate-failed",
      ).accepted,
    ).toBe(true);
    const sfu = routes.snapshot().operation!;
    expect(
      routes.noteCurrentCandidateRejection(
        cursorGuard(sfu),
        "sfu-admission",
      ),
    ).toBe(true);
    expect(routes.routeDiagnosticSnapshot(30)).toMatchObject({
      children: [
        {
          finalRoute: "waiting",
          rejectionBucket: "sfu-admission",
        },
      ],
      operation: {
        childOrdinal: 1,
        stage: "admission",
        cursor: 1,
        candidateCount: 2,
      },
    });
  });

  it("distinguishes first-frame timeout from the total operation deadline", () => {
    const routes = controller(1, { sfuEnabled: true });
    addViewer(routes, A, 0, 0);
    const direct = routes.reconcile(10).operation!;
    beginCandidate(routes, {
      nowMs: 20,
      connectionId: "silent_direct",
      reservation: { kind: "direct" },
    });

    expect(routes.operationExpired(direct.wakeAtMs)).toMatchObject({
      accepted: true,
    });
    expect(routes.routeDiagnosticSnapshot(direct.wakeAtMs)).toMatchObject({
      children: [
        {
          candidateStartMs: null,
          finalMs: null,
          finalRoute: "waiting",
          rejectionBucket: "first-frame-timeout",
        },
      ],
      operation: { cursor: 1, stage: "admission" },
    });

    const deadline = routes.snapshot().operation!.deadlineAtMs;
    expect(routes.operationExpired(deadline)).toMatchObject({
      accepted: true,
      failedPeerIds: [A],
    });
    expect(routes.routeDiagnosticSnapshot(deadline).children[0]).toMatchObject({
      finalMs: deadline,
      finalRoute: "failed",
      rejectionBucket: "operation-deadline",
    });
  });

  it.each([1, 2, 3] as const)(
    "admits 20 Viewers through one bounded event-driven graph at C=%i",
    (capacity) => {
      const routes = controller(capacity);
      const viewerPeerIds = Array.from(
        { length: 20 },
        (_, index) => `viewer_${String(index).padStart(2, "0")}_12345678`,
      );
      viewerPeerIds.forEach((peerId, index) => {
        addViewer(routes, peerId, capacity);
        const operation = routes.reconcile(index * 2).operation!;
        expect(operation.childPeerId).toBe(peerId);
        commitCurrent(routes, index * 2 + 1, `${peerId}_connection`);
      });
      const snapshot = routes.snapshot();
      expect(snapshot.upstreamByViewer).toHaveLength(20);
      for (const parentPeerId of [HOST, ...viewerPeerIds]) {
        const childCount = [...snapshot.upstreamByViewer.values()].filter(
          (edge) =>
            edge.kind === "peer" &&
            edge.physicalActive &&
            edge.parentPeerId === parentPeerId,
        ).length;
        expect(childCount).toBeLessThanOrEqual(capacity);
      }
    },
  );

  it("admits waiting Viewers through existing SFU before direct convergence", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateHostPublication(
      "publication_generation",
      "publication_resource",
    );
    routes.hydrateEdge(B, {
      kind: "sfu",
      publicationGeneration: "publication_generation",
      transport: "sfu",
      connectionId: "b_sfu",
      usable: true,
      physicalActive: true,
      resource: "b_subscription",
    });
    addViewer(routes, C, 0);
    routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"));
    const waiting = Array.from(
      { length: 18 },
      (_, index) => `silent_${String(index).padStart(2, "0")}_12345678`,
    );
    waiting.forEach((peerId) => addViewer(routes, peerId, 0));

    let nowMs = 0;
    waiting.forEach((peerId, index) => {
      const directOperation = routes.reconcile(nowMs).operation!;
      expect(directOperation.childPeerId).toBe(peerId);
      expect(directOperation.candidates[0]?.tuple.kind).toBe("peer");
      beginCandidate(routes, {
        nowMs: nowMs + 1,
        connectionId: `${peerId}_direct`,
        reservation: { kind: "direct" },
      });
      routes.operationExpired(directOperation.wakeAtMs);
      const sfuOperation = routes.snapshot().operation!;
      expect(sfuOperation.candidates[sfuOperation.cursor]!.tuple).toEqual({
        kind: "sfu",
        publication: "reuse",
      });
      const prepared = beginCandidate(routes, {
        nowMs: directOperation.wakeAtMs + 1,
        connectionId: `${peerId}_sfu`,
        reservation: {
          kind: "sfu-reuse",
          edge: `${peerId}_subscription`,
        },
      }).operation!;
      expect(
        routes.candidateReady(
          {
            childPeerId: peerId,
            childSessionId: `${peerId}_session`,
            revision: prepared.current!.revision,
            connectionId: `${peerId}_sfu`,
          },
          directOperation.wakeAtMs + 2,
        ).accepted,
      ).toBe(true);
      nowMs = directOperation.wakeAtMs + 3;

      expect(routes.snapshot().upstreamByViewer.get(B)).toMatchObject({
        kind: "sfu",
        connectionId: "b_sfu",
      });
      expect(routes.snapshot().upstreamByViewer.get(C)).toMatchObject({
        kind: "peer",
        parentPeerId: HOST,
        connectionId: "c_from_host",
      });
      expect(routes.snapshot().upstreamByViewer.get(peerId)).toMatchObject({
        kind: "sfu",
        usable: true,
      });
      expect(routes.snapshot().upstreamByViewer.size).toBe(index + 3);
    });

    expect(routes.snapshot().upstreamByViewer.size).toBe(20);
    expect(routes.snapshot().hostPublication).toMatchObject({
      generation: "publication_generation",
      usable: true,
    });
    expect(routes.reconcile(nowMs).operation).toMatchObject({
      reason: "direct-convergence",
    });
  });

  it.each([1, 2, 3] as const)(
    "builds a deterministic acyclic route without a depth cap at C=%i",
    (capacity) => {
      const routes = controller(capacity);
      for (const peerId of [A, B, C, D]) {
        addViewer(routes, peerId, capacity);
        const result = routes.reconcile(0);
        expect(result.operation?.childPeerId).toBe(peerId);
        commitCurrent(routes, 1, `${peerId}_connection`);
      }

      const snapshot = routes.snapshot();
      expect(snapshot.upstreamByViewer).toHaveLength(4);
      for (const [childPeerId, edge] of snapshot.upstreamByViewer) {
        expect(edge.kind).toBe("peer");
        expect(edge.kind === "peer" && edge.parentPeerId).not.toBe(childPeerId);
      }
      if (capacity === 1) {
        expect(snapshot.upstreamByViewer.get(D)).toMatchObject({
          kind: "peer",
          parentPeerId: C,
        });
      }
    },
  );

  it("keeps the old edge until exact candidate first-frame ready", () => {
    const routes = controller(2);
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    routes.reconcile(0);
    commitCurrent(routes, 1, "old_connection");
    routes.reconcile(2);
    commitCurrent(routes, 3, "b_connection");
    const revision = routes.snapshot().revision;
    expect(
      routes.invalidateEdge({
        childPeerId: A,
        childSessionId: `${A}_session`,
        parentSessionId: "host_session",
        routeRevision: revision,
        connectionId: "old_connection",
      }),
    ).toBe(true);

    routes.reconcile(100);
    const prepared = beginCandidate(routes, {
      nowMs: 101,
      connectionId: "new_connection",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.snapshot().upstreamByViewer.get(A)?.connectionId).toBe(
      "old_connection",
    );
    expect(
      routes.candidateReady({
        childPeerId: A,
        childSessionId: `${A}_session`,
        revision: prepared.current!.revision - 1,
        connectionId: "new_connection",
      }, 102).accepted,
    ).toBe(false);
    expect(
      routes.candidateReady({
        childPeerId: A,
        childSessionId: `${A}_session`,
        revision: prepared.current!.revision,
        connectionId: "new_connection",
      }, 102),
    ).toMatchObject({ accepted: true });
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      connectionId: "new_connection",
      parentPeerId: B,
      usable: true,
    });
  });

  it("invalidates one exact active Peer edge from its parent idempotently", () => {
    const routes = controller(2);
    addViewer(routes, A, 0);
    addViewer(routes, B, 1);
    routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    const report = {
      parentPeerId: HOST,
      parentSessionId: "host_session",
      routeRevision: routes.snapshot().revision,
      connectionId: "a_from_host",
    };

    expect(routes.invalidateDirectEdgeFromParent(report, 10)).toBe(true);
    const afterFirst = routes.snapshot();
    expect(afterFirst.upstreamByViewer.get(A)).toMatchObject({
      usable: false,
      connectionId: "a_from_host",
    });
    expect(afterFirst.upstreamByViewer.get(B)).toMatchObject({
      usable: true,
      connectionId: "b_from_host",
    });
    expect(routes.invalidateDirectEdgeFromParent(report, 11)).toBe(true);
    expect(routes.snapshot().factVersion).toBe(afterFirst.factVersion);
    expect(
      routes.invalidateDirectEdgeFromParent({
        ...report,
        connectionId: "unknown_connection",
      }),
    ).toBe(false);
    expect(routes.reconcile(12).operation).toMatchObject({
      childPeerId: A,
      reason: "edge-unavailable",
      candidates: [
        {
          tuple: { kind: "peer", parentPeerId: B, transport: "direct" },
        },
      ],
    });
  });

  it("advances one candidate cursor without resetting the operation deadline", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, A, 2);
    const operation = routes.reconcile(1_000).operation!;
    const deadline = operation.deadlineAtMs;
    const first = beginCandidate(routes, {
      nowMs: 1_001,
      connectionId: "candidate_1",
      reservation: { kind: "direct" },
    }).operation!;
    const failed = routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: first.current!.revision,
      connectionId: "candidate_1",
    }, 1_001);
    expect(failed.accepted).toBe(true);
    expect(failed.activeRevision).toBeGreaterThan(first.current!.revision);
    expect(failed.failedPeerIds).toEqual([]);
    expect(failed.released).toEqual([]);
    expect(routes.snapshot().operation).toMatchObject({
      cursor: 1,
      deadlineAtMs: deadline,
    });

    const second = beginCandidate(routes, {
      nowMs: 1_002,
      connectionId: "candidate_2",
      publicationGeneration: "publication_2",
      publicationConnectionId: "publication_connection_2",
      reservation: {
        kind: "sfu-create",
        edge: "candidate_2_edge",
        publication: "candidate_2_publication",
      },
    }).operation!;
    const lateReady = routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: second.current!.revision,
      connectionId: "candidate_2",
    }, deadline);
    expect(lateReady).toMatchObject({ accepted: false, failedPeerIds: [A] });
    expect(lateReady.released).toEqual([
      "candidate_2_edge",
      "candidate_2_publication",
    ]);
    expect(routes.snapshot().operation).toBeUndefined();
    expect(
      routes.candidateReady({
        childPeerId: A,
        childSessionId: `${A}_session`,
        revision: second.current!.revision,
        connectionId: "candidate_2",
      }, deadline + 1).accepted,
    ).toBe(false);
    expect(routes.reconcile(deadline + 1).operation).toBeUndefined();
    routes.touchExternalFacts();
    expect(routes.reconcile(deadline + 2).operation?.childPeerId).toBe(A);
  });

  it("reserves one derived deadline stage for direct and SFU", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    addViewer(routes, A, 0);

    const operation = routes.reconcile(0).operation!;
    expect(operation.deadlineAtMs).toBe(10_000);
    expect(operation.wakeAtMs).toBe(5_000);
    expect(operation.candidates.map((candidate) => candidate.tuple)).toEqual(
      expect.arrayContaining([
        { kind: "peer", parentPeerId: B, transport: "direct" },
        { kind: "sfu", publication: "create" },
      ]),
    );

    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "silent_direct",
      reservation: { kind: "direct" },
    });
    const directExpired = routes.operationExpired(operation.wakeAtMs);
    expect(directExpired).toMatchObject({ accepted: true });
    expect(directExpired.failedPeerIds).toEqual([]);
    expect(routes.snapshot().operation).toMatchObject({
      deadlineAtMs: 10_000,
      wakeAtMs: 10_000,
      current: undefined,
    });
    expect(
      routes.snapshot().operation!.candidates[
        routes.snapshot().operation!.cursor
      ]!.tuple,
    ).toMatchObject({ kind: "sfu" });

    const prepared = beginCandidate(routes, {
      nowMs: 7_000,
      connectionId: "sfu_subscription",
      publicationGeneration: "publication_generation",
      publicationConnectionId: "publication_connection",
      reservation: {
        kind: "sfu-create",
        edge: "sfu_edge",
        publication: "sfu_publication",
      },
    }).operation!;
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: prepared.current!.revision,
          connectionId: "sfu_subscription",
        },
        9_000,
      ).accepted,
    ).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "sfu",
      usable: true,
    });
  });

  it("uses the same direct head-start after an early hard failure", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, D, 0);
    routes.hydrateEdge(D, peerEdge(HOST, "host_full"));
    routes.hydrateHostPublication("publication_1", "publication_resource");
    for (const peerId of [B, C]) {
      addViewer(routes, peerId, 1);
      routes.hydrateEdge(peerId, {
        kind: "sfu",
        publicationGeneration: "publication_1",
        transport: "sfu",
        connectionId: `${peerId}_sfu`,
        usable: true,
        physicalActive: true,
        resource: `${peerId}_subscription`,
      });
    }
    addViewer(routes, A, 0);

    const operation = routes.reconcile(0).operation!;
    expect(operation.candidates.map((candidate) => candidate.tuple.kind)).toEqual([
      "peer",
      "sfu",
      "peer",
    ]);
    const first = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "first_direct",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: first.current!.revision,
      connectionId: "first_direct",
    }, 2).accepted).toBe(true);
    expect(routes.snapshot().operation).toMatchObject({
      cursor: 1,
      wakeAtMs: operation.wakeAtMs,
    });
    expect(
      routes.snapshot().operation!.candidates[1]!.tuple.kind,
    ).toBe("peer");
  });

  it("keeps a transport-connected direct candidate until the total deadline", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, D, 0);
    routes.hydrateEdge(D, peerEdge(HOST, "host_full"));
    routes.hydrateHostPublication("publication", "publication_resource");
    addViewer(routes, B, 1);
    routes.hydrateEdge(B, {
      kind: "sfu",
      publicationGeneration: "publication",
      transport: "sfu",
      connectionId: "b_sfu",
      usable: true,
      physicalActive: true,
      resource: "b_subscription",
    });
    addViewer(routes, A, 0);

    const operation = routes.reconcile(0).operation!;
    const direct = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_direct",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateTransportConnected({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: direct.current!.revision,
      connectionId: "a_direct",
    }, 1_000).accepted).toBe(true);
    expect(routes.candidateTransportConnected({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: direct.current!.revision,
      connectionId: "a_direct",
    }, 1_001).accepted).toBe(true);
    expect(routes.candidateTransportConnected({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: direct.current!.revision,
      connectionId: "stale_direct",
    }, 1_002).accepted).toBe(false);
    expect(routes.snapshot().revision).toBe(direct.current!.revision - 1);
    expect(routes.snapshot().operation?.wakeAtMs).toBe(operation.deadlineAtMs);
    expect(routes.operationExpired(operation.wakeAtMs).accepted).toBe(false);
    expect(routes.snapshot().operation?.current?.connectionId).toBe("a_direct");
    expect(routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: direct.current!.revision,
      connectionId: "a_direct",
    }, operation.wakeAtMs + 1).accepted).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      connectionId: "a_direct",
    });
  });

  it("keeps SFU active while converging through an SFU-fed parent", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateHostPublication(
      "publication_generation",
      "publication_resource",
    );
    routes.hydrateEdge(B, {
      kind: "sfu",
      publicationGeneration: "publication_generation",
      transport: "sfu",
      connectionId: "b_sfu",
      usable: true,
      physicalActive: true,
      resource: "b_subscription",
    });
    addViewer(routes, C, 0);
    routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"));
    addViewer(routes, A, 0);

    const acquisition = routes.reconcile(0).operation!;
    expect(acquisition.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: B,
      transport: "direct",
    });
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_direct_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(acquisition.wakeAtMs);
    const prepared = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 1,
      connectionId: "a_sfu_reuse",
      reservation: { kind: "sfu-reuse", edge: "a_subscription" },
    }).operation!;
    expect(
      routes.candidateReady(
        {
          childPeerId: A,
          childSessionId: `${A}_session`,
          revision: prepared.current!.revision,
          connectionId: "a_sfu_reuse",
        },
        acquisition.wakeAtMs + 2,
      ).accepted,
    ).toBe(true);
    expect(routes.snapshot().hostPublication).toMatchObject({
      generation: "publication_generation",
      usable: true,
    });
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "sfu",
      publicationGeneration: "publication_generation",
      usable: true,
    });
    const convergence = routes.reconcile(acquisition.wakeAtMs + 3).operation!;
    expect(convergence).toMatchObject({
      childPeerId: A,
      reason: "direct-convergence",
    });
    expect(convergence.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: B,
      transport: "direct",
    });
    const direct = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 4,
      connectionId: "a_from_b",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "sfu",
      connectionId: "a_sfu_reuse",
    });
    expect(routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: direct.current!.revision,
      connectionId: "a_from_b",
    }, acquisition.wakeAtMs + 5).accepted).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      parentPeerId: B,
      connectionId: "a_from_b",
    });
  });

  it("advances exact direct convergence failures without failing SFU", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, D, 0);
    routes.hydrateEdge(D, peerEdge(HOST, "host_full"));
    routes.hydrateHostPublication("publication_1", "publication_resource");
    for (const peerId of [B, C]) {
      addViewer(routes, peerId, 1);
      routes.hydrateEdge(peerId, {
        kind: "sfu",
        publicationGeneration: "publication_1",
        transport: "sfu",
        connectionId: `${peerId}_sfu`,
        usable: true,
        physicalActive: true,
        resource: `${peerId}_subscription`,
      });
    }
    addViewer(routes, A, 0, 0);
    const acquisition = routes.reconcile(0).operation!;
    const headStartTuple = acquisition.candidates[0]!.tuple;
    expect(headStartTuple.kind).toBe("peer");
    const headStartParent = headStartTuple.kind === "peer"
      ? headStartTuple.parentPeerId
      : "";
    const otherParent = headStartParent === B ? C : B;
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_direct_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(acquisition.wakeAtMs);
    const sfu = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 1,
      connectionId: "a_sfu",
      reservation: { kind: "sfu-reuse", edge: "a_subscription" },
    }).operation!;
    expect(routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: sfu.current!.revision,
      connectionId: "a_sfu",
    }, acquisition.wakeAtMs + 2).accepted).toBe(true);

    const first = routes.reconcile(acquisition.wakeAtMs + 3).operation!;
    expect(first.candidates[0]?.tuple).toMatchObject({
      kind: "peer",
      parentPeerId: otherParent,
    });
    const failed = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 4,
      connectionId: "a_direct_followup",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: failed.current!.revision,
      connectionId: "a_direct_followup",
    }, acquisition.wakeAtMs + 5).failedPeerIds).toEqual([]);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "sfu",
      connectionId: "a_sfu",
    });
    expect(
      routes.reconcile(acquisition.wakeAtMs + 6).operation?.candidates[0]?.tuple,
    ).toMatchObject({
      kind: "peer",
      parentPeerId: headStartParent,
    });
  });

  it("round-robins background direct convergence between SFU Viewers", () => {
    const routes = controller(2, { sfuEnabled: true });
    routes.hydrateHostPublication("publication", "publication_resource");
    for (const peerId of [B, C]) {
      addViewer(routes, peerId, 2);
      routes.hydrateEdge(peerId, {
        kind: "sfu",
        publicationGeneration: "publication",
        transport: "sfu",
        connectionId: `${peerId}_sfu`,
        usable: true,
        physicalActive: true,
        resource: `${peerId}_subscription`,
      });
    }

    let nowMs = 0;
    for (const peerId of [A, D]) {
      addViewer(routes, peerId, 0, nowMs);
      const acquisition = routes.reconcile(nowMs).operation!;
      beginCandidate(routes, {
        nowMs: nowMs + 1,
        connectionId: `${peerId}_head_start`,
        reservation: { kind: "direct" },
      });
      routes.operationExpired(acquisition.wakeAtMs);
      const sfu = beginCandidate(routes, {
        nowMs: acquisition.wakeAtMs + 1,
        connectionId: `${peerId}_sfu`,
        reservation: {
          kind: "sfu-reuse",
          edge: `${peerId}_subscription`,
        },
      }).operation!;
      expect(routes.candidateReady({
        childPeerId: peerId,
        childSessionId: `${peerId}_session`,
        revision: sfu.current!.revision,
        connectionId: `${peerId}_sfu`,
      }, acquisition.wakeAtMs + 2).accepted).toBe(true);
      nowMs = acquisition.wakeAtMs + 3;
    }

    const first = routes.reconcile(nowMs).operation!;
    expect(first).toMatchObject({
      childPeerId: A,
      reason: "direct-convergence",
    });
    const firstAttempt = beginCandidate(routes, {
      nowMs: nowMs + 1,
      connectionId: "a_background_direct",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: firstAttempt.current!.revision,
      connectionId: "a_background_direct",
    }, nowMs + 2).accepted).toBe(true);
    expect(routes.reconcile(nowMs + 3).operation).toMatchObject({
      childPeerId: D,
      reason: "direct-convergence",
    });
  });

  it("preempts direct convergence when another Viewer needs a route", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateHostPublication("publication_1", "publication_resource");
    routes.hydrateEdge(B, {
      kind: "sfu",
      publicationGeneration: "publication_1",
      transport: "sfu",
      connectionId: "b_sfu",
      usable: true,
      physicalActive: true,
      resource: "b_subscription",
    });
    addViewer(routes, C, 0);
    routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"));
    addViewer(routes, A, 0, 0);
    const acquisition = routes.reconcile(0).operation!;
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_direct_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(acquisition.wakeAtMs);
    const sfu = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 1,
      connectionId: "a_sfu",
      reservation: { kind: "sfu-reuse", edge: "a_subscription" },
    }).operation!;
    routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: sfu.current!.revision,
      connectionId: "a_sfu",
    }, acquisition.wakeAtMs + 2);
    expect(
      routes.reconcile(acquisition.wakeAtMs + 3).operation?.reason,
    ).toBe("direct-convergence");
    beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 4,
      connectionId: "a_direct_pending",
      reservation: { kind: "direct", overlap: "a_overlap" },
    });

    const activeRevision = routes.snapshot().revision;
    expect(routes.invalidateEdge({
      childPeerId: C,
      childSessionId: `${C}_session`,
      parentSessionId: "host_session",
      routeRevision: activeRevision,
      connectionId: "c_from_host",
    }, acquisition.wakeAtMs + 5)).toBe(true);
    const reconciled = routes.reconcile(acquisition.wakeAtMs + 6);
    expect(reconciled.released).toEqual(["a_overlap"]);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "sfu",
      connectionId: "a_sfu",
    });
    expect(reconciled.operation).toMatchObject({
      childPeerId: C,
      reason: "edge-unavailable",
    });
  });

  it("owns Host-full SFU bootstrap failure by the waiting demand", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    addViewer(routes, C, 0);
    routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"));
    addViewer(routes, A, 0);
    addViewer(routes, D, 0);

    const operation = routes.reconcile(0).operation!;
    expect(operation.candidates.some((candidate) => candidate.tuple.kind === "sfu"))
      .toBe(false);
    expect(operation.wakeAtMs).toBe(5_000);
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_silent_direct",
      reservation: { kind: "direct" },
    });
    const blocked = routes.operationExpired(operation.wakeAtMs);
    expect(blocked).toMatchObject({ accepted: true });
    expect(blocked.failedPeerIds).toEqual([]);
    expect(blocked.released).toEqual([]);
    expect(routes.snapshot().operation).toBeUndefined();

    const bootstrap = routes.reconcile(operation.wakeAtMs + 1).operation!;
    expect(bootstrap.childPeerId).toBe(C);
    expect(bootstrap.demandPeerId).toBe(A);
    expect(bootstrap.candidates[0]!.tuple).toMatchObject({
      kind: "sfu",
      publication: "create",
    });
    expect(bootstrap.candidates[0]!.endpointTransition.kind).toBe("overlap");
    const firstCarrier = beginCandidate(routes, {
      nowMs: operation.wakeAtMs + 2,
      connectionId: "c_bootstrap_sfu",
      publicationGeneration: "c_bootstrap_publication",
      publicationConnectionId: "c_bootstrap_ingress",
      reservation: {
        kind: "sfu-create",
        edge: "c_bootstrap_subscription",
        publication: "c_bootstrap_publication_resource",
        overlap: "c_bootstrap_overlap",
      },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: C,
      childSessionId: `${C}_session`,
      revision: firstCarrier.current!.revision,
      connectionId: "c_bootstrap_sfu",
    }, operation.wakeAtMs + 3).failedPeerIds).toEqual([]);
    expect(routes.snapshot().upstreamByViewer.get(C)).toMatchObject({
      connectionId: "c_from_host",
      usable: true,
      physicalActive: true,
    });

    const secondBootstrap = routes.reconcile(operation.wakeAtMs + 4).operation!;
    expect(secondBootstrap).toMatchObject({
      childPeerId: B,
      demandPeerId: A,
      reason: "sfu-bootstrap",
    });
    const secondCarrier = beginCandidate(routes, {
      nowMs: operation.wakeAtMs + 5,
      connectionId: "b_bootstrap_sfu",
      publicationGeneration: "b_bootstrap_publication",
      publicationConnectionId: "b_bootstrap_ingress",
      reservation: {
        kind: "sfu-create",
        edge: "b_bootstrap_subscription",
        publication: "b_bootstrap_publication_resource",
        overlap: "b_bootstrap_overlap",
      },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: B,
      childSessionId: `${B}_session`,
      revision: secondCarrier.current!.revision,
      connectionId: "b_bootstrap_sfu",
    }, operation.wakeAtMs + 6).failedPeerIds).toEqual([A]);
    for (const [peerId, connectionId] of [
      [B, "b_from_host"],
      [C, "c_from_host"],
    ] as const) {
      expect(routes.snapshot().upstreamByViewer.get(peerId)).toMatchObject({
        connectionId,
        usable: true,
        physicalActive: true,
      });
    }
    const nextDemand = routes.reconcile(operation.wakeAtMs + 7).operation!;
    expect(nextDemand).toMatchObject({ childPeerId: D, reason: "join" });
    beginCandidate(routes, {
      nowMs: operation.wakeAtMs + 8,
      connectionId: "d_direct",
      reservation: { kind: "direct" },
    });
    expect(routes.operationExpired(nextDemand.deadlineAtMs).failedPeerIds).toEqual([D]);
    expect(routes.reconcile(nextDemand.deadlineAtMs + 1).operation).toBeUndefined();
  });

  it("abandons bootstrap when a Host slot becomes available", () => {
    const routes = controller(2, { sfuEnabled: true });
    expect(routes.setEffectiveCapacity(HOST, "host_session", 1)).toBe(true);
    addViewer(routes, B, 0);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    addViewer(routes, A, 0);

    const bootstrap = routes.reconcile(0).operation!;
    expect(bootstrap).toMatchObject({
      childPeerId: B,
      demandPeerId: A,
      reason: "sfu-bootstrap",
    });
    const prepared = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "stale_bootstrap",
      publicationGeneration: "stale_publication",
      publicationConnectionId: "stale_ingress",
      reservation: {
        kind: "sfu-create",
        edge: "stale_subscription",
        publication: "stale_publication_resource",
        overlap: "stale_overlap",
      },
    }).operation!;

    expect(routes.setEffectiveCapacity(HOST, "host_session", 2)).toBe(true);
    const stale = routes.candidateReady({
      childPeerId: B,
      childSessionId: `${B}_session`,
      revision: prepared.current!.revision,
      connectionId: "stale_bootstrap",
    }, 2);
    expect(stale.accepted).toBe(false);
    expect(stale.released).toEqual(expect.arrayContaining([
      "stale_subscription",
      "stale_publication_resource",
      "stale_overlap",
    ]));
    expect(routes.snapshot().upstreamByViewer.get(B)).toMatchObject({
      connectionId: "b_from_host",
      usable: true,
      physicalActive: true,
    });
    expect(routes.reconcile(3).operation).toMatchObject({
      childPeerId: A,
      demandPeerId: A,
      reason: "join",
    });
  });

  it("tries SFU first after bootstrap and retains the direct suffix", () => {
    const routes = controller(2, { sfuEnabled: true });
    for (const [peerId, connectionId] of [
      [B, "b_from_host"],
      [C, "c_from_host"],
    ] as const) {
      addViewer(routes, peerId, 1);
      routes.hydrateEdge(peerId, peerEdge(HOST, connectionId));
    }
    addViewer(routes, A, 0);

    const acquisition = routes.reconcile(0).operation!;
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_direct_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(acquisition.wakeAtMs);
    const bootstrap = routes.reconcile(acquisition.wakeAtMs + 1).operation!;
    const carrier = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 2,
      connectionId: "bootstrap_sfu",
      publicationGeneration: "bootstrap_publication",
      publicationConnectionId: "bootstrap_ingress",
      reservation: {
        kind: "sfu-create",
        edge: "carrier_subscription",
        publication: "bootstrap_publication_resource",
        overlap: "bootstrap_overlap",
      },
    }).operation!;
    expect(routes.candidateReady({
      childPeerId: bootstrap.childPeerId,
      childSessionId: bootstrap.childSessionId,
      revision: carrier.current!.revision,
      connectionId: "bootstrap_sfu",
    }, acquisition.wakeAtMs + 3).accepted).toBe(true);

    const demand = routes.reconcile(acquisition.wakeAtMs + 4).operation!;
    expect(demand).toMatchObject({
      childPeerId: A,
      demandPeerId: A,
      reason: "join",
    });
    expect(demand.candidates[0]?.tuple).toEqual({
      kind: "sfu",
      publication: "reuse",
    });
    expect(
      demand.candidates.slice(1).every((candidate) => candidate.tuple.kind === "peer"),
    ).toBe(true);
    const subscription = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 5,
      connectionId: "a_sfu",
      reservation: { kind: "sfu-reuse", edge: "a_subscription" },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: subscription.current!.revision,
      connectionId: "a_sfu",
    }, acquisition.wakeAtMs + 6).accepted).toBe(true);
    expect(
      routes.snapshot().operation?.candidates[
        routes.snapshot().operation!.cursor
      ]?.tuple.kind,
    ).toBe("peer");
    const direct = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 7,
      connectionId: "a_deferred_direct",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: direct.current!.revision,
      connectionId: "a_deferred_direct",
    }, acquisition.wakeAtMs + 8).accepted).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      kind: "peer",
      connectionId: "a_deferred_direct",
    });
    expect(routes.reconcile(acquisition.wakeAtMs + 9).operation).toMatchObject({
      childPeerId: bootstrap.childPeerId,
      reason: "direct-convergence",
    });
  });

  it("replans when the current candidate parent fails", () => {
    const routes = controller(3);
    addViewer(routes, A, 1);
    addViewer(routes, B, 1);
    addViewer(routes, C, 1);
    routes.hydrateEdge(A, peerEdge(HOST, "a_old"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_old"));
    routes.hydrateEdge(C, peerEdge(HOST, "c_old"));
    const revision = routes.snapshot().revision;
    expect(
      routes.invalidateEdge({
        childPeerId: A,
        childSessionId: `${A}_session`,
        parentSessionId: "host_session",
        routeRevision: revision,
        connectionId: "a_old",
      }),
    ).toBe(true);
    routes.reconcile(0);
    const current = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_new",
      reservation: { kind: "direct" },
    }).operation!;
    const currentTuple = current.current!.tuple;
    expect(currentTuple.kind).toBe("peer");
    const failedParentPeerId = currentTuple.kind === "peer"
      ? currentTuple.parentPeerId
      : B;
    const failedParentConnectionId = failedParentPeerId === B
      ? "b_old"
      : "c_old";
    expect(
      routes.invalidateEdge({
        childPeerId: failedParentPeerId,
        childSessionId: `${failedParentPeerId}_session`,
        parentSessionId: "host_session",
        routeRevision: revision,
        connectionId: failedParentConnectionId,
      }),
    ).toBe(true);
    expect(
      routes.candidateReady({
        childPeerId: A,
        childSessionId: `${A}_session`,
        revision: current.current!.revision,
        connectionId: "a_new",
      }, 2).accepted,
    ).toBe(false);
    const replacement = beginCandidate(routes, {
      nowMs: 2,
      connectionId: "a_new_2",
      reservation: { kind: "direct" },
    }).operation!;
    expect(
      routes.candidateReady({
        childPeerId: A,
        childSessionId: `${A}_session`,
        revision: replacement.current!.revision,
        connectionId: "a_new_2",
      }, 3).accepted,
    ).toBe(true);
    expect(routes.reconcile(3).operation?.childPeerId).toBe(
      failedParentPeerId,
    );
  });

  it("keeps an active candidate when an unrelated session is replaced", () => {
    const routes = controller(2);
    for (const [peerId, connectionId] of [
      [B, "b_from_host"],
      [C, "c_from_host"],
    ] as const) {
      addViewer(routes, peerId, 1);
      routes.hydrateEdge(peerId, peerEdge(HOST, connectionId));
    }
    addViewer(routes, A, 0);
    const operation = routes.reconcile(0).operation!;
    const active = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_active_candidate",
      reservation: { kind: "direct" },
    }).operation!;
    const tuple = active.current!.tuple;
    expect(tuple.kind).toBe("peer");
    const unrelatedPeerId = tuple.kind === "peer" && tuple.parentPeerId === B
      ? C
      : B;

    expect(routes.upsertParticipant({
      peerId: unrelatedPeerId,
      role: "viewer",
      sessionId: `${unrelatedPeerId}_replacement`,
      effectiveDownstreamCapacity: 1,
    }, 2)).toEqual([]);
    expect(routes.snapshot().operation?.current).toMatchObject({
      revision: operation.baseRevision + 1,
      connectionId: "a_active_candidate",
    });
  });

  it("uses a freed Host slot for new demand without moving healthy descendants", () => {
    const routes = controller(2);
    addViewer(routes, A, 2);
    addViewer(routes, B, 2);
    addViewer(routes, C, 0);
    addViewer(routes, D, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_root"));
    routes.hydrateEdge(B, peerEdge(HOST, "b_root"));
    routes.hydrateEdge(C, peerEdge(A, "c_from_a"));
    routes.hydrateEdge(D, peerEdge(B, "d_from_b"));

    expect(routes.confirmDeparture(B)).toBe(true);
    const repair = routes.reconcile(0).operation!;
    expect(repair.childPeerId).toBe(D);
    expect(repair.candidates[0]!.tuple).toEqual({
      kind: "peer",
      parentPeerId: A,
      transport: "direct",
    });
    commitCurrent(routes, 1, "d_from_a");
    expect(routes.reconcile(2).operation).toBeUndefined();
    expect(routes.snapshot().upstreamByViewer.has(B)).toBe(false);

    addViewer(routes, E, 0);
    const join = routes.reconcile(3).operation!;
    expect(join.childPeerId).toBe(E);
    expect(join.candidates[0]!.tuple).toEqual({
      kind: "peer",
      parentPeerId: HOST,
      transport: "direct",
    });
    commitCurrent(routes, 4, "e_from_host");

    expect(routes.snapshot().upstreamByViewer.get(C)).toMatchObject({
      parentPeerId: A,
      connectionId: "c_from_a",
    });
    expect(routes.snapshot().upstreamByViewer.get(D)).toMatchObject({
      parentPeerId: A,
      connectionId: "d_from_a",
    });
    expect(routes.snapshot().upstreamByViewer.get(E)).toMatchObject({
      parentPeerId: HOST,
      connectionId: "e_from_host",
    });
  });

  it("keeps grace media, then reparents a confirmed relay departure", () => {
    const routes = controller(2);
    addViewer(routes, A, 2);
    addViewer(routes, B, 1);
    addViewer(routes, C, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "a_connection"));
    routes.hydrateEdge(B, peerEdge(A, "b_connection"));
    routes.hydrateEdge(C, peerEdge(B, "c_connection"));

    expect(routes.disconnectSession(A, `${A}_session`)).toBe(true);
    expect(routes.reconcile(0).operation).toBeUndefined();
    expect(routes.confirmDeparture(A)).toBe(true);
    expect(routes.reconcile(1).operation?.childPeerId).toBe(B);
    commitCurrent(routes, 2, "b_reparented");
    const beforePrune = routes.snapshot().revision;
    const after = routes.reconcile(3);
    expect(after.removedPeerIds).toContain(A);
    expect(routes.snapshot().revision).toBeGreaterThan(beforePrune);
    expect(routes.snapshot().upstreamByViewer.get(C)).toMatchObject({
      parentPeerId: B,
      connectionId: "c_connection",
    });
  });

  it("moves newest overflow children and supports effective capacity zero", () => {
    const routes = controller(3);
    addViewer(routes, A, 3);
    routes.hydrateEdge(A, peerEdge(HOST, "a_connection"));
    for (const peerId of [B, C, D]) {
      addViewer(routes, peerId, 0);
      routes.hydrateEdge(peerId, peerEdge(A, `${peerId}_connection`));
    }
    expect(routes.setEffectiveCapacity(A, `${A}_session`, 1)).toBe(true);
    expect(routes.reconcile(0).operation?.childPeerId).toBe(D);
    expect(routes.setPaused(true)).toEqual([]);
    expect(routes.setEffectiveCapacity(A, `${A}_session`, 0)).toBe(true);
    expect(routes.setPaused(false)).toEqual([]);
    expect(routes.reconcile(1).operation?.childPeerId).toBe(D);

    const blocked = controller(1);
    addViewer(blocked, A, 0);
    addViewer(blocked, B, 0);
    blocked.hydrateEdge(A, peerEdge(HOST, "blocked_a"));
    blocked.hydrateEdge(B, peerEdge(A, "blocked_b"));
    expect(blocked.reconcile(0).operation).toBeUndefined();
    expect(blocked.reconcile(1).operation).toBeUndefined();
  });

  it("aborts pending SFU resources on pause and repairs publication", () => {
    const routes = controller(1, { sfuEnabled: true });
    addViewer(routes, A, 1);
    addViewer(routes, B, 0);
    routes.hydrateHostPublication("publication_1", "publication_resource");
    routes.hydrateEdge(A, {
      kind: "sfu",
      publicationGeneration: "publication_1",
      transport: "sfu",
      connectionId: "a_sfu",
      usable: true,
      physicalActive: true,
      resource: "a_subscription",
    });
    const operation = routes.reconcile(0).operation!;
    expect(operation.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: A,
      transport: "direct",
    });
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "b_direct_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(operation.wakeAtMs);
    beginCandidate(routes, {
      nowMs: operation.wakeAtMs + 1,
      connectionId: "b_candidate",
      reservation: { kind: "sfu-reuse", edge: "b_subscription" },
    });
    expect(routes.setPaused(true)).toEqual(["b_subscription"]);
    expect(routes.snapshot().operation).toBeUndefined();
    expect(routes.snapshot().upstreamByViewer.get(A)?.connectionId).toBe("a_sfu");
    routes.setPaused(false);
    expect(routes.invalidateHostPublication({
      hostSessionId: "host_session",
      routeRevision: routes.snapshot().revision,
      generation: "publication_1",
      connectionId: "publication:publication_1",
    })).toBe(true);
    routes.touchExternalFacts();
    const repair = routes.reconcile(2).operation!;
    expect(repair.childPeerId).toBe(A);
    expect(repair.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: HOST,
      transport: "direct",
    });
    skipCandidate(routes, 3);
    expect(routes.snapshot().operation?.candidates[1]?.tuple).toEqual({
      kind: "sfu",
      publication: "replace",
    });
    expect(() => beginCandidate(routes, {
      nowMs: 3,
      connectionId: "a_sfu_2",
      publicationGeneration: "publication_2",
      publicationConnectionId: "publication_connection_2",
      reservation: {
        kind: "sfu-create",
        edge: "a_subscription_2",
        publication: "publication_resource_2",
      },
    })).toThrow("endpoint overlap reservation");
    const publicationRepair = beginCandidate(routes, {
      nowMs: 3,
      connectionId: "a_sfu_2",
      publicationGeneration: "publication_2",
      publicationConnectionId: "publication_connection_2",
      reservation: {
        kind: "sfu-create",
        edge: "a_subscription_2",
        publication: "publication_resource_2",
        overlap: "publication_overlap",
      },
    }).operation!;
    const repaired = routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: publicationRepair.current!.revision,
      connectionId: "a_sfu_2",
    }, 4);
    expect(repaired.accepted).toBe(true);
    expect(repaired.released).toHaveLength(3);
    expect(repaired.released).toEqual(expect.arrayContaining([
      "publication_overlap",
      "a_subscription",
      "publication_resource",
    ]));
    expect(routes.snapshot().hostPublication).toMatchObject({
      generation: "publication_2",
      usable: true,
      physicalActive: true,
    });

    const bootstrap = controller(1, { sfuEnabled: true });
    addViewer(bootstrap, A, 0);
    addViewer(bootstrap, B, 0);
    bootstrap.hydrateEdge(A, peerEdge(HOST, "bootstrap_a"));
    const bootstrapOperation = bootstrap.reconcile(0).operation!;
    expect(bootstrapOperation.childPeerId).toBe(A);
    expect(bootstrapOperation.candidates[0]?.tuple).toEqual({
      kind: "sfu",
      publication: "create",
    });
    expect(() => beginCandidate(bootstrap, {
      nowMs: 2,
      connectionId: "bootstrap_sfu",
      publicationGeneration: "bootstrap_publication",
      publicationConnectionId: "bootstrap_ingress_connection",
      reservation: {
        kind: "sfu-create",
        edge: "bootstrap_subscription",
        publication: "bootstrap_ingress",
      },
    })).toThrow("endpoint overlap reservation");
    const preparedBootstrap = beginCandidate(bootstrap, {
      nowMs: 2,
      connectionId: "bootstrap_sfu",
      publicationGeneration: "bootstrap_publication",
      publicationConnectionId: "bootstrap_ingress_connection",
      reservation: {
        kind: "sfu-create",
        edge: "bootstrap_subscription",
        publication: "bootstrap_ingress",
        overlap: "bootstrap_overlap",
      },
    }).operation!;
    expect(bootstrap.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: preparedBootstrap.current!.revision,
      connectionId: "bootstrap_sfu",
    }, 3).accepted).toBe(true);
    expect(bootstrap.reconcile(4).operation?.childPeerId).toBe(B);
  });

  it("binds reserve and skip results to the exact candidate cursor", () => {
    const reserve = controller(2);
    addViewer(reserve, A, 2);
    reserve.hydrateEdge(A, peerEdge(HOST, "a_active"));
    addViewer(reserve, B, 0);
    const first = reserve.reconcile(0).operation!;
    expect(first.candidates[0]?.tuple).toMatchObject({
      kind: "peer",
      parentPeerId: HOST,
    });
    reserve.setEffectiveCapacity(HOST, "host_session", 0);
    const staleReserve = reserve.beginCurrentCandidate({
      guard: cursorGuard(first),
      nowMs: 1,
      connectionId: "reserved_for_old_cursor",
      reservation: { kind: "direct", overlap: "stale_reservation" },
    });
    expect(staleReserve).toMatchObject({ accepted: false });
    expect(staleReserve.released).toEqual(["stale_reservation"]);
    expect(reserve.snapshot().operation).toMatchObject({
      cursor: 0,
      candidates: [
        {
          tuple: { kind: "peer", parentPeerId: A, transport: "direct" },
        },
      ],
    });
    expect(reserve.snapshot().operation?.current).toBeUndefined();

    const skip = controller(2);
    addViewer(skip, A, 2);
    skip.hydrateEdge(A, peerEdge(HOST, "a_active"));
    addViewer(skip, B, 0);
    const staleCursor = skip.reconcile(0).operation!;
    skip.setEffectiveCapacity(HOST, "host_session", 0);
    expect(skip.skipCurrentCandidate(cursorGuard(staleCursor), 1).accepted).toBe(false);
    expect(skip.snapshot().operation).toMatchObject({ cursor: 0 });
    expect(skip.snapshot().operation?.candidates[0]?.tuple).toMatchObject({
      kind: "peer",
      parentPeerId: A,
    });
  });


  it("replaces one publication and makes every old subscriber waiting", () => {
    const routes = controller(1, { sfuEnabled: true });
    addViewer(routes, A, 0);
    addViewer(routes, B, 0);
    routes.hydrateHostPublication("publication_1", "publication_resource_1");
    for (const [peerId, resource] of [[A, "subscription_a"], [B, "subscription_b"]] as const) {
      routes.hydrateEdge(peerId, {
        kind: "sfu",
        publicationGeneration: "publication_1",
        transport: "sfu",
        connectionId: `${peerId}_sfu_1`,
        usable: true,
        physicalActive: true,
        resource,
      });
    }
    expect(routes.invalidateHostPublication({
      hostSessionId: "host_session",
      routeRevision: 0,
      generation: "publication_1",
      connectionId: "publication:publication_1",
    }, 10)).toBe(true);
    routes.touchExternalFacts();
    const operation = routes.reconcile(20).operation!;
    expect(operation.candidates[0]).toMatchObject({
      tuple: { kind: "sfu", publication: "replace" },
      endpointTransition: { kind: "overlap", producerPeerId: HOST },
    });
    const prepared = beginCandidate(routes, {
      nowMs: 21,
      connectionId: "a_sfu_2",
      publicationGeneration: "publication_2",
      publicationConnectionId: "publication_connection_2",
      reservation: {
        kind: "sfu-create",
        edge: "subscription_a_2",
        publication: "publication_resource_2",
        overlap: "publication_overlap",
      },
    }).operation!;
    const settled = routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: prepared.current!.revision,
      connectionId: "a_sfu_2",
    }, 22);
    expect(settled.accepted).toBe(true);
    expect(settled.released).toHaveLength(4);
    expect(settled.released).toEqual(expect.arrayContaining([
      "publication_overlap",
      "subscription_a",
      "subscription_b",
      "publication_resource_1",
    ]));
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      publicationGeneration: "publication_2",
    });
    expect(routes.snapshot().upstreamByViewer.has(B)).toBe(false);
    expect(routes.routeDiagnosticSnapshot(22).children[1]).toMatchObject({
      demandAgeMs: 12,
      finalRoute: "waiting",
    });
    expect(routes.reconcile(23).operation).toMatchObject({
      childPeerId: B,
      reason: "edge-unavailable",
    });
  });

  it("rebinds direct and SFU media to replacement sessions", () => {
    const peerRoutes = controller(2);
    addViewer(peerRoutes, A, 1);
    addViewer(peerRoutes, B, 0);
    peerRoutes.hydrateEdge(A, peerEdge(HOST, "a_direct"));
    peerRoutes.hydrateEdge(B, peerEdge(A, "b_direct"));
    expect(peerRoutes.upsertParticipant({
      peerId: A,
      role: "viewer",
      sessionId: "a_replacement",
      effectiveDownstreamCapacity: 1,
    })).toEqual([]);
    expect(peerRoutes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      childSessionId: "a_replacement",
      usable: true,
      physicalActive: true,
    });
    expect(peerRoutes.snapshot().upstreamByViewer.get(B)).toMatchObject({
      parentSessionId: "a_replacement",
    });
    expect(peerRoutes.upsertParticipant({
      peerId: B,
      role: "viewer",
      sessionId: "b_replacement",
      effectiveDownstreamCapacity: 0,
    })).toEqual([]);
    expect(peerRoutes.snapshot().upstreamByViewer.get(B)).toMatchObject({
      childSessionId: "b_replacement",
      usable: true,
      physicalActive: true,
    });

    const sfuRoutes = controller(1, { sfuEnabled: true });
    addViewer(sfuRoutes, A, 0);
    sfuRoutes.hydrateHostPublication(
      "publication",
      "publication_resource",
      "publication_connection",
    );
    sfuRoutes.hydrateEdge(A, {
      kind: "sfu",
      publicationGeneration: "publication",
      transport: "sfu",
      connectionId: "subscription_connection",
      usable: true,
      physicalActive: true,
      resource: "subscription_resource",
    });
    expect(sfuRoutes.upsertParticipant({
      peerId: HOST,
      role: "host",
      sessionId: "host_replacement",
      effectiveDownstreamCapacity: 1,
    })).toEqual([]);
    expect(sfuRoutes.snapshot().hostPublication).toMatchObject({
      hostSessionId: "host_replacement",
      usable: true,
      physicalActive: true,
    });
    expect(sfuRoutes.upsertParticipant({
      peerId: A,
      role: "viewer",
      sessionId: "a_replacement",
      effectiveDownstreamCapacity: 0,
    })).toEqual([]);
    expect(sfuRoutes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      childSessionId: "a_replacement",
      physicalActive: true,
    });
  });

  it("retries a bootstrap carrier only when its transition improves", () => {
    const routes = controller(1, { sfuEnabled: true });
    addViewer(routes, A, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "failed_direct"));
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      parentSessionId: "host_session",
      routeRevision: 0,
      connectionId: "failed_direct",
    })).toBe(true);
    const operation = routes.reconcile(0).operation!;
    const prepared = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "failed_sfu",
      publicationGeneration: "failed_publication",
      publicationConnectionId: "failed_publication_connection",
      reservation: {
        kind: "sfu-create",
        edge: "failed_subscription_resource",
        publication: "failed_publication_resource",
        overlap: "failed_overlap",
      },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: operation.childPeerId,
      childSessionId: operation.childSessionId,
      revision: prepared.current!.revision,
      connectionId: "failed_sfu",
    }, 2)).toMatchObject({ accepted: true, failedPeerIds: [A] });
    const improved = routes.reconcile(3).operation!;
    expect(improved.candidates[0]).toMatchObject({
      tuple: { kind: "sfu", publication: "create" },
      endpointTransition: { kind: "none", producerPeerId: HOST },
    });
    const improvedAttempt = beginCandidate(routes, {
      nowMs: 4,
      connectionId: "improved_sfu",
      publicationGeneration: "improved_publication",
      publicationConnectionId: "improved_publication_connection",
      reservation: {
        kind: "sfu-create",
        edge: "improved_subscription_resource",
        publication: "improved_publication_resource",
      },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: improved.childPeerId,
      childSessionId: improved.childSessionId,
      revision: improvedAttempt.current!.revision,
      connectionId: "improved_sfu",
    }, 5)).toMatchObject({ accepted: true, failedPeerIds: [A] });
    const factVersion = routes.snapshot().factVersion;
    expect(routes.reconcile(6).operation).toBeUndefined();
    expect(routes.setEffectiveCapacity(A, `${A}_session`, 0)).toBe(true);
    expect(routes.snapshot().factVersion).toBe(factVersion);
    expect(routes.reconcile(7).operation).toBeUndefined();
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      parentSessionId: "host_session",
      routeRevision: routes.snapshot().revision,
      connectionId: "failed_direct",
    })).toBe(true);
    expect(routes.snapshot().factVersion).toBe(factVersion);
    expect(routes.reconcile(8).operation).toBeUndefined();

    addViewer(routes, B, 0, 9);
    expect(routes.reconcile(9).operation?.childPeerId).toBe(B);
    while (routes.snapshot().operation) skipCandidate(routes, 10);
    expect(routes.reconcile(11).operation).toBeUndefined();
  });

  it.each([1, 2] as const)(
    "requires one overlap slot for an SFU-to-Host transition at C=%i",
    (capacity) => {
      const routes = controller(capacity, { sfuEnabled: true });
      addViewer(routes, A, 0);
      if (capacity === 2) {
        addViewer(routes, E, 0);
        routes.hydrateEdge(E, peerEdge(HOST, "e_direct"));
      }
      routes.hydrateHostPublication("publication_1", "publication_resource_1");
      routes.hydrateEdge(A, {
        kind: "sfu",
        publicationGeneration: "publication_1",
        transport: "sfu",
        connectionId: "a_sfu",
        usable: true,
        physicalActive: true,
        resource: "a_subscription",
      });
      routes.invalidateEdge({
        childPeerId: A,
        childSessionId: `${A}_session`,
        routeRevision: 0,
        connectionId: "a_sfu",
      });
      const operation = routes.reconcile(0).operation!;
      expect(operation.candidates[0]).toMatchObject({
        tuple: { kind: "peer", parentPeerId: HOST, transport: "direct" },
        endpointTransition: { kind: "overlap", producerPeerId: HOST },
      });
      expect(() => beginCandidate(routes, {
        nowMs: 1,
        connectionId: "a_host_direct",
        reservation: { kind: "direct" },
      })).toThrow("endpoint overlap reservation");
    },
  );

  it("uses one bounded gap instead of a fourth Host copy at C=3", () => {
    const routes = controller(3, { sfuEnabled: true });
    addViewer(routes, A, 0);
    for (const peerId of [E, F]) {
      addViewer(routes, peerId, 0);
      routes.hydrateEdge(peerId, peerEdge(HOST, `${peerId}_direct`));
    }
    routes.hydrateHostPublication("publication_1", "publication_resource_1");
    routes.hydrateEdge(A, {
      kind: "sfu",
      publicationGeneration: "publication_1",
      transport: "sfu",
      connectionId: "a_sfu",
      usable: true,
      physicalActive: true,
      resource: "a_subscription",
    });
    routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      routeRevision: 0,
      connectionId: "a_sfu",
    });
    const operation = routes.reconcile(10).operation!;
    const deadline = operation.deadlineAtMs;
    expect(operation.candidates[0]).toMatchObject({
      tuple: { kind: "peer", parentPeerId: HOST, transport: "direct" },
      endpointTransition: {
        kind: "bounded-gap",
        producerPeerId: HOST,
        retire: { kind: "publication", generation: "publication_1" },
      },
    });
    const gap = routes.retireCurrentCandidateProducer(cursorGuard(operation), 11);
    expect(gap).toMatchObject({ accepted: true });
    expect(gap.released).toEqual(["a_subscription", "publication_resource_1"]);
    expect(gap.operation).toMatchObject({
      deadlineAtMs: deadline,
      candidates: [{ endpointTransition: { kind: "none", producerPeerId: HOST } }],
    });
    const prepared = beginCandidate(routes, {
      nowMs: 12,
      connectionId: "a_host_direct",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateReady({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: prepared.current!.revision,
      connectionId: "a_host_direct",
    }, 13).accepted).toBe(true);
    expect(routes.snapshot().hostPublication).toBeNull();
  });

  it("does not reopen a consumed none transition when it worsens to overlap", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, A, 0);
    routes.hydrateHostPublication("publication", "publication_resource");
    routes.hydrateEdge(A, {
      kind: "sfu",
      publicationGeneration: "publication",
      transport: "sfu",
      connectionId: "a_from_sfu",
      usable: true,
      physicalActive: true,
      resource: "a_subscription",
    });
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      routeRevision: 0,
      connectionId: "a_from_sfu",
    })).toBe(true);
    const operation = routes.reconcile(0).operation!;
    expect(operation.candidates[0]).toMatchObject({
      tuple: { kind: "peer", parentPeerId: HOST, transport: "direct" },
      endpointTransition: { kind: "none", producerPeerId: HOST },
    });

    expect(routes.setEffectiveCapacity(HOST, "host_session", 1)).toBe(true);
    expect(routes.operationExpired(operation.deadlineAtMs).failedPeerIds).toEqual([
      A,
    ]);
    const retry = routes.reconcile(operation.deadlineAtMs + 1).operation!;
    expect(retry.candidates).toEqual([
      {
        tuple: { kind: "sfu", publication: "replace" },
        endpointTransition: { kind: "none", producerPeerId: HOST },
      },
    ]);
    expect(
      retry.candidates.some(
        (candidate) =>
          candidate.tuple.kind === "peer" &&
          candidate.tuple.parentPeerId === HOST,
      ),
    ).toBe(false);
  });

  it("does not unblock an exhausted demand for an unrelated join", () => {
    const routes = controller(1);
    addViewer(routes, B, 0);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    addViewer(routes, A, 0, 0);
    expect(routes.reconcile(0).failedPeerIds).toEqual([A]);

    expect(routes.setEffectiveCapacity(A, `${A}_session`, 1)).toBe(true);
    expect(routes.reconcile(1).operation).toBeUndefined();

    addViewer(routes, C, 0, 2);
    expect(routes.reconcile(2).failedPeerIds).toEqual([C]);
    expect(routes.snapshot().operation).toBeUndefined();

    expect(routes.setEffectiveCapacity(B, `${B}_session`, 1)).toBe(true);
    expect(routes.reconcile(3).operation).toMatchObject({
      childPeerId: A,
      candidates: [
        {
          tuple: { kind: "peer", parentPeerId: B, transport: "direct" },
        },
      ],
    });
  });

  it("does not revive an exact failed Host tuple when a new parent joins", () => {
    const routes = controller(1);
    addViewer(routes, A, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "failed_direct"));
    expect(
      routes.invalidateEdge({
        childPeerId: A,
        childSessionId: `${A}_session`,
        parentSessionId: "host_session",
        routeRevision: 0,
        connectionId: "failed_direct",
      }),
    ).toBe(true);
    expect(routes.reconcile(0).operation).toBeUndefined();

    addViewer(routes, B, 1, 1);
    expect(routes.reconcile(2).operation).toMatchObject({
      childPeerId: B,
      reason: "join",
    });
    commitCurrent(routes, 2, "b_from_host");
    const retry = routes.reconcile(4).operation!;
    expect(retry).toMatchObject({
      childPeerId: A,
      candidates: [
        {
          tuple: { kind: "peer", parentPeerId: B, transport: "direct" },
        },
      ],
    });
    expect(
      retry.candidates.some(
        (candidate) =>
          candidate.tuple.kind === "peer" &&
          candidate.tuple.parentPeerId === HOST,
      ),
    ).toBe(false);
  });

  it("does not unblock an exhausted Viewer when its candidate set shrinks", () => {
    const routes = controller(1);
    addViewer(routes, A, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "failed_host"));
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      parentSessionId: "host_session",
      routeRevision: 0,
      connectionId: "failed_host",
    })).toBe(true);
    expect(routes.reconcile(0).operation).toBeUndefined();

    addViewer(routes, B, 1, 1);
    routes.reconcile(1);
    commitCurrent(routes, 2, "b_from_host");
    const candidate = routes.reconcile(3).operation!;
    const attempt = beginCandidate(routes, {
      nowMs: 4,
      connectionId: "a_from_b",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: attempt.current!.revision,
      connectionId: "a_from_b",
    }, 5).failedPeerIds).toEqual([A]);
    expect(candidate.candidates).toHaveLength(1);

    expect(routes.disconnectSession(B, `${B}_session`)).toBe(true);
    expect(routes.reconcile(6).operation).toBeUndefined();
  });

  it("treats a replacement child session as a new exact opportunity", () => {
    const routes = controller(1);
    addViewer(routes, A, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "failed_host"));
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      parentSessionId: "host_session",
      routeRevision: 0,
      connectionId: "failed_host",
    })).toBe(true);
    expect(routes.reconcile(0).operation).toBeUndefined();

    routes.upsertParticipant({
      peerId: A,
      role: "viewer",
      sessionId: "replacement_session",
      effectiveDownstreamCapacity: 0,
    });
    expect(routes.reconcile(1).operation).toMatchObject({
      childPeerId: A,
      childSessionId: "replacement_session",
      candidates: [
        {
          tuple: { kind: "peer", parentPeerId: HOST, transport: "direct" },
        },
      ],
    });
  });

  it("does not retry a failed bootstrap carrier when another carrier leaves", () => {
    const routes = controller(2, { sfuEnabled: true });
    for (const [peerId, connectionId] of [
      [B, "b_from_host"],
      [C, "c_from_host"],
    ] as const) {
      addViewer(routes, peerId, 1);
      routes.hydrateEdge(peerId, peerEdge(HOST, connectionId));
    }
    addViewer(routes, A, 0, 0);
    const acquisition = routes.reconcile(0).operation!;
    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "a_head_start",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(acquisition.wakeAtMs);

    const bootstrap = routes.reconcile(acquisition.wakeAtMs + 1).operation!;
    expect(bootstrap.reason).toBe("sfu-bootstrap");
    const failedCarrier = bootstrap.childPeerId;
    const otherCarrier = failedCarrier === B ? C : B;
    const attempt = beginCandidate(routes, {
      nowMs: acquisition.wakeAtMs + 2,
      connectionId: "failed_bootstrap",
      publicationGeneration: "failed_publication",
      publicationConnectionId: "failed_publication_connection",
      reservation: {
        kind: "sfu-create",
        edge: "failed_subscription",
        publication: "failed_publication_resource",
        overlap: "failed_overlap",
      },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: failedCarrier,
      childSessionId: `${failedCarrier}_session`,
      revision: attempt.current!.revision,
      connectionId: "failed_bootstrap",
    }, acquisition.wakeAtMs + 3).accepted).toBe(true);

    expect(
      routes.disconnectSession(otherCarrier, `${otherCarrier}_session`),
    ).toBe(true);
    const next = routes.reconcile(acquisition.wakeAtMs + 4).operation;
    expect(next).not.toMatchObject({
      reason: "sfu-bootstrap",
      childPeerId: failedCarrier,
    });
  });

  it("reopens only SFU opportunities for a new external fact", () => {
    const routes = controller(1, { sfuEnabled: true });
    addViewer(routes, A, 0, 0);
    routes.reconcile(0);
    const directAttempt = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "failed_direct",
      reservation: { kind: "direct" },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: directAttempt.current!.revision,
      connectionId: "failed_direct",
    }, 2).accepted).toBe(true);
    const sfuAttempt = beginCandidate(routes, {
      nowMs: 3,
      connectionId: "failed_sfu",
      publicationGeneration: "failed_publication",
      publicationConnectionId: "failed_publication_connection",
      reservation: {
        kind: "sfu-create",
        edge: "failed_subscription",
        publication: "failed_publication_resource",
      },
    }).operation!;
    expect(routes.candidateFailed({
      childPeerId: A,
      childSessionId: `${A}_session`,
      revision: sfuAttempt.current!.revision,
      connectionId: "failed_sfu",
    }, 4).accepted).toBe(true);
    expect(routes.snapshot().operation).toBeUndefined();
    expect(routes.reconcile(5).operation).toBeUndefined();

    routes.touchExternalFacts();
    const retried = routes.reconcile(6).operation!;
    expect(retried.candidates).toEqual([
      {
        tuple: { kind: "sfu", publication: "create" },
        endpointTransition: { kind: "none", producerPeerId: HOST },
      },
    ]);
    expect(
      retried.candidates.some(
        (candidate) => candidate.tuple.kind === "peer",
      ),
    ).toBe(false);
  });

  it("fails all waiting demands without cutting capacity-three Host children", () => {
    const routes = controller(3, { sfuEnabled: true });
    for (const [peerId, connectionId] of [
      [A, "a_direct"],
      [B, "b_direct"],
      [C, "c_direct"],
    ] as const) {
      addViewer(routes, peerId, 0);
      routes.hydrateEdge(peerId, peerEdge(HOST, connectionId));
    }
    addViewer(routes, D, 0);
    addViewer(routes, E, 0);
    const reconciled = routes.reconcile(0);
    expect(reconciled.operation).toBeUndefined();
    expect(reconciled.failedPeerIds).toEqual([D, E]);
    for (const [peerId, connectionId] of [
      [A, "a_direct"],
      [B, "b_direct"],
      [C, "c_direct"],
    ] as const) {
      expect(routes.snapshot().upstreamByViewer.get(peerId)).toMatchObject({
        connectionId,
        usable: true,
        physicalActive: true,
      });
    }
  });

  it("does not promote when synchronous admission commit fails", () => {
    const routes = controller(1);
    addViewer(routes, A, 0);
    const operation = routes.reconcile(0).operation!;
    const prepared = beginCandidate(routes, {
      nowMs: 1,
      connectionId: "candidate_connection",
      reservation: { kind: "direct" },
    }).operation!;
    const settled = routes.candidateReady(
      {
        childPeerId: operation.childPeerId,
        childSessionId: operation.childSessionId,
        revision: prepared.current!.revision,
        connectionId: "candidate_connection",
      },
      2,
      () => false,
    );
    expect(settled.accepted).toBe(false);
    expect(settled.activeRevision).toBeGreaterThan(prepared.current!.revision);
    expect(routes.snapshot().upstreamByViewer.has(A)).toBe(false);
  });
});
