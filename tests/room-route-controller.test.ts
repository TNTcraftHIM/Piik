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
  options: { selectedTurnEnabled?: boolean; sfuEnabled?: boolean } = {},
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
) {
  routes.upsertParticipant({
    peerId,
    role: "viewer",
    sessionId: `${peerId}_session`,
    effectiveDownstreamCapacity: capacity,
  });
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
  },
) {
  const operation = routes.snapshot().operation!;
  return routes.beginCurrentCandidate({
    guard: cursorGuard(operation),
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
    const routes = controller(2, {
      selectedTurnEnabled: true,
      sfuEnabled: true,
    });
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

    const overlap = controller(2, { selectedTurnEnabled: true });
    addViewer(overlap, A, 1);
    addViewer(overlap, B, 0);
    overlap.hydrateEdge(A, peerEdge(HOST, "a_parent"));
    overlap.hydrateEdge(B, peerEdge(A, "b_direct"));
    expect(overlap.invalidateEdge({
      childPeerId: B,
      childSessionId: `${B}_session`,
      parentSessionId: `${A}_session`,
      routeRevision: 0,
      connectionId: "b_direct",
    })).toBe(true);
    overlap.reconcile(0);
    const hostAttempt = beginCandidate(overlap, {
      nowMs: 1,
      connectionId: "b_host",
      reservation: { kind: "direct" },
    }).operation!;
    overlap.candidateFailed({
      childPeerId: B,
      childSessionId: `${B}_session`,
      revision: hostAttempt.current!.revision,
      connectionId: "b_host",
    }, 2);
    expect(() => beginCandidate(overlap, {
      nowMs: 3,
      connectionId: "b_turn",
      reservation: { kind: "selected-turn", edge: "turn_edge" },
    })).toThrow("endpoint overlap reservation");
    beginCandidate(overlap, {
      nowMs: 3,
      connectionId: "b_turn",
      reservation: {
        kind: "selected-turn",
        edge: "turn_edge",
        overlap: "overlap_slot",
      },
    });
    overlap.setEffectiveCapacity(A, `${A}_session`, 0);
    expect(overlap.reconcile(4).released).toEqual([
      "turn_edge",
      "overlap_slot",
    ]);
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
      ingress: "direct",
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
      ingress: "direct",
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
    })).toBe(true);
    routes.touchExternalFacts();
    const operation = routes.reconcile(0).operation!;
    expect(operation.candidates[0]).toMatchObject({
      tuple: { kind: "sfu", publication: "replace", ingress: "direct" },
      endpointTransition: { kind: "overlap", producerPeerId: HOST },
    });
    const prepared = beginCandidate(routes, {
      nowMs: 1,
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
    }, 2);
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
    expect(routes.reconcile(3).operation?.childPeerId).toBe(B);
  });

  it("releases session-bound transports while rebinding direct media", () => {
    const peerRoutes = controller(2);
    addViewer(peerRoutes, A, 1);
    addViewer(peerRoutes, B, 0);
    peerRoutes.hydrateEdge(A, {
      kind: "peer",
      parentPeerId: HOST,
      transport: "selected-turn",
      connectionId: "a_selected",
      usable: true,
      physicalActive: true,
      resource: "a_turn_allocation",
    });
    peerRoutes.hydrateEdge(B, peerEdge(HOST, "b_direct"));
    expect(peerRoutes.upsertParticipant({
      peerId: A,
      role: "viewer",
      sessionId: "a_replacement",
      effectiveDownstreamCapacity: 1,
    })).toEqual(["a_turn_allocation"]);
    expect(peerRoutes.snapshot().upstreamByViewer.get(A)).toMatchObject({
      childSessionId: `${A}_session`,
      usable: false,
      physicalActive: false,
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
      "selected_publication",
      "selected_ingress_resource",
      "selected_ingress_connection",
      "selected-turn",
    );
    sfuRoutes.hydrateEdge(A, {
      kind: "sfu",
      publicationGeneration: "selected_publication",
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
    })).toEqual(["selected_ingress_resource"]);
    expect(sfuRoutes.snapshot().hostPublication).toMatchObject({
      hostSessionId: "host_session",
      ingress: "selected-turn",
      usable: false,
      physicalActive: false,
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

  it("retires one exact peer edge for a C=3 bounded gap", () => {
    const routes = controller(3, { selectedTurnEnabled: true });
    addViewer(routes, A, 3);
    routes.hydrateEdge(A, peerEdge(HOST, "a_direct"));
    for (const peerId of [B, C, D]) {
      addViewer(routes, peerId, 0);
      routes.hydrateEdge(peerId, peerEdge(A, `${peerId}_from_a`));
    }
    routes.invalidateEdge({
      childPeerId: B,
      childSessionId: `${B}_session`,
      parentSessionId: `${A}_session`,
      routeRevision: 0,
      connectionId: `${B}_from_a`,
    });
    const first = routes.reconcile(0).operation!;
    expect(first.candidates[0]?.tuple).toMatchObject({
      kind: "peer",
      parentPeerId: HOST,
      transport: "direct",
    });
    expect(skipCandidate(routes, 1).accepted).toBe(true);
    const bounded = routes.snapshot().operation!;
    expect(bounded.candidates[bounded.cursor]).toMatchObject({
      tuple: { kind: "peer", parentPeerId: A, transport: "selected-turn" },
      endpointTransition: {
        kind: "bounded-gap",
        producerPeerId: A,
        retire: { kind: "edge", childPeerId: B, connectionId: `${B}_from_a` },
      },
    });
    const gap = routes.retireCurrentCandidateProducer(cursorGuard(bounded), 2);
    expect(gap).toMatchObject({ accepted: true, released: [] });
    const prepared = beginCandidate(routes, {
      nowMs: 3,
      connectionId: "b_selected_turn",
      reservation: { kind: "selected-turn", edge: "b_turn_resource" },
    }).operation!;
    expect(routes.candidateReady({
      childPeerId: B,
      childSessionId: `${B}_session`,
      revision: prepared.current!.revision,
      connectionId: "b_selected_turn",
    }, 4).accepted).toBe(true);
    expect(routes.snapshot().upstreamByViewer.get(B)).toMatchObject({
      parentPeerId: A,
      transport: "selected-turn",
      resource: "b_turn_resource",
    });
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
