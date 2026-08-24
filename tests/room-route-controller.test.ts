import { describe, expect, it } from "vitest";

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
  options: { sfuEnabled?: boolean } = {},
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

describe("RoomRouteController", () => {
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
    ).toMatchObject({ accepted: true, exhausted: true });
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
      exhausted: true,
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

  it("keeps healthy branches while 18 silent Viewers fall back serially", () => {
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
      beginCandidate(routes, {
        nowMs: nowMs + 1,
        connectionId: `${peerId}_silent_direct`,
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
    expect(failed.exhausted).toBeUndefined();
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
    expect(lateReady).toMatchObject({ accepted: false, exhausted: true });
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
    expect(directExpired.exhausted).toBeUndefined();
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

  it("reaches a healthy SFU reuse stage after silent peer transport", () => {
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

    const operation = routes.reconcile(0).operation!;
    expect(operation.candidates.map((candidate) => candidate.tuple)).toEqual(
      expect.arrayContaining([
        { kind: "peer", parentPeerId: B, transport: "direct" },
        { kind: "sfu", publication: "reuse" },
      ]),
    );

    beginCandidate(routes, {
      nowMs: 1,
      connectionId: "silent_direct",
      reservation: { kind: "direct" },
    });
    routes.operationExpired(operation.wakeAtMs);

    expect(
      routes.snapshot().operation!.candidates[
        routes.snapshot().operation!.cursor
      ]!.tuple,
    ).toEqual({
      kind: "sfu",
      publication: "reuse",
    });
    const prepared = beginCandidate(routes, {
      nowMs: 7_000,
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
        8_000,
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
  });

  it("reserves a stage for Host-full SFU bootstrap before it is a tuple", () => {
    const routes = controller(2, { sfuEnabled: true });
    addViewer(routes, B, 2);
    routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"));
    addViewer(routes, C, 0);
    routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"));
    addViewer(routes, A, 0);

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
    expect(blocked.exhausted).toBe(false);
    expect(blocked.released).toEqual([]);
    expect(routes.snapshot().operation).toBeUndefined();

    const bootstrap = routes.reconcile(operation.wakeAtMs + 1).operation!;
    expect(bootstrap.childPeerId).toBe(C);
    expect(bootstrap.candidates[0]!.tuple).toMatchObject({
      kind: "sfu",
      publication: "create",
    });
  });

  it("retains another exact failed edge while one child operation is busy", () => {
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
    expect(
      routes.invalidateEdge({
        childPeerId: B,
        childSessionId: `${B}_session`,
        parentSessionId: "host_session",
        routeRevision: revision,
        connectionId: "b_old",
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
    expect(routes.reconcile(3).operation?.childPeerId).toBe(B);
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

  it("uses an SFU-fed endpoint as an ordinary parent and aborts pause resources", () => {
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
      connectionId: "b_candidate",
      reservation: { kind: "direct" },
    });
    expect(routes.setPaused(true)).toEqual([]);
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
    expect(reserve.snapshot().operation).toMatchObject({ cursor: 1 });
    expect(reserve.snapshot().operation?.current).toBeUndefined();

    const skip = controller(2);
    addViewer(skip, A, 2);
    skip.hydrateEdge(A, peerEdge(HOST, "a_active"));
    addViewer(skip, B, 0);
    const staleCursor = skip.reconcile(0).operation!;
    skip.setEffectiveCapacity(HOST, "host_session", 0);
    expect(skip.skipCurrentCandidate(cursorGuard(staleCursor), 1).accepted).toBe(false);
    expect(skip.snapshot().operation).toMatchObject({ cursor: 1 });
    expect(skip.snapshot().operation?.candidates[1]?.tuple).toMatchObject({
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

  it("does not reopen an exhausted bootstrap without a new fact", () => {
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
    }, 2)).toMatchObject({ accepted: true, exhausted: true });
    const factVersion = routes.snapshot().factVersion;
    expect(routes.reconcile(3).operation).toBeUndefined();
    expect(routes.setEffectiveCapacity(A, `${A}_session`, 0)).toBe(true);
    expect(routes.snapshot().factVersion).toBe(factVersion);
    expect(routes.reconcile(4).operation).toBeUndefined();
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      parentSessionId: "host_session",
      routeRevision: routes.snapshot().revision,
      connectionId: "failed_direct",
    })).toBe(true);
    expect(routes.snapshot().factVersion).toBe(factVersion);
    expect(routes.reconcile(5).operation).toBeUndefined();
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

  it("retries an exact failed tuple only after a new external fact", () => {
    const routes = controller(1);
    addViewer(routes, A, 0);
    routes.hydrateEdge(A, peerEdge(HOST, "failed_direct"));
    expect(routes.invalidateEdge({
      childPeerId: A,
      childSessionId: `${A}_session`,
      parentSessionId: "host_session",
      routeRevision: 0,
      connectionId: "failed_direct",
    })).toBe(true);
    expect(routes.reconcile(0).operation).toBeUndefined();
    expect(routes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      usable: false,
      physicalActive: false,
    });

    routes.touchExternalFacts();
    expect(routes.reconcile(1).operation?.candidates[0]?.tuple).toEqual({
      kind: "peer",
      parentPeerId: HOST,
      transport: "direct",
    });
  });

  it("appends one ordinary restore candidate after a healthy bounded gap", () => {
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
    const operation = routes.reconcile(0).operation!;
    expect(operation.childPeerId).toBe(C);
    expect(operation.candidates[0]?.endpointTransition.kind).toBe("bounded-gap");
    const gap = routes.retireCurrentCandidateProducer(cursorGuard(operation), 1);
    expect(gap.accepted).toBe(true);
    const tuples = routes.snapshot().operation?.candidates.map((plan) => plan.tuple);
    expect(tuples?.at(-1)).toEqual({
      kind: "peer",
      parentPeerId: HOST,
      transport: "direct",
    });
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
