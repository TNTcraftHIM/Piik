import { describe, expect, it, vi } from "vitest";

import type { RoutePolicy, ServerMessage } from "../src/shared/protocol.ts";
import {
  HybridMediaRouter,
  type AuthenticatedRouteParticipant,
  type HybridAuthenticationState,
} from "../src/server/hybrid-media-router.ts";
import { RoomStore, type CreatedRoom } from "../src/server/room-store.ts";
import { SfuResourceAdmission } from "../src/server/sfu-resource-admission.ts";
import { FakeSfuRoomControl } from "./fake-sfu-room-control.ts";

const SHARE_GENERATION = "share_generation_12345678";

function senderDiagnostics(state: "unknown" | "healthy" | "degraded") {
  return {
    reason:
      state === "unknown" ? null : state === "healthy" ? "none" : "bandwidth",
    framesPerSecond: null,
    bitrateKbps: null,
  } as const;
}

function createStore(maxViewersPerRoom = 20) {
  return new RoomStore({
    leaseMs: 60_000,
    maxRooms: 4,
    maxViewersPerRoom,
  });
}

function connectHost(
  store: RoomStore,
  room: CreatedRoom,
  routePolicy?: RoutePolicy,
) {
  const connected = store.connectParticipant({
    roomId: room.roomId,
    role: "host",
    token: room.hostToken,
    clientId: "host_client_12345678",
    sessionId: "host_session_12345678",
  });
  return {
    roomId: room.roomId,
    role: "host" as const,
    peerId: connected.peerId,
    sessionId: "host_session_12345678",
    ...(routePolicy ? { routePolicy } : {}),
  };
}

function connectViewer(
  store: RoomStore,
  room: CreatedRoom,
  suffix: string,
): AuthenticatedRouteParticipant {
  const connected = store.connectParticipant({
    roomId: room.roomId,
    role: "viewer",
    ...(room.viewerGrant ? { viewerGrant: room.viewerGrant } : {}),
    clientId: `viewer_client_${suffix}_12345678`,
    sessionId: `viewer_session_${suffix}_12345678`,
  });
  return {
    roomId: room.roomId,
    role: "viewer",
    peerId: connected.peerId,
    sessionId: `viewer_session_${suffix}_12345678`,
  };
}

function complete(
  router: HybridMediaRouter,
  participant: AuthenticatedRouteParticipant,
): HybridAuthenticationState {
  const state = router.connectParticipant(participant);
  router.completeAuthentication(participant, state);
  return state;
}

function preparedFor(
  sent: Map<string, ServerMessage[]>,
  sessionId: string,
) {
  return sent
    .get(sessionId)
    ?.findLast(
      (message): message is Extract<ServerMessage, { type: "route-update"; phase: "prepare" }> =>
        message.type === "route-update" && message.phase === "prepare",
    );
}

function activeAfter(
  sent: Map<string, ServerMessage[]>,
  sessionId: string,
  revision: number,
) {
  return sent
    .get(sessionId)
    ?.findLast(
      (message): message is Extract<ServerMessage, { type: "route-update"; phase: "active" }> =>
        message.type === "route-update" &&
        message.phase === "active" &&
        message.revision > revision,
    );
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(
  endpointMediaCopyCapacity: 1 | 2 | 3,
  withSfu = false,
  prepareTimeoutMs?: number,
  sfuIngressCapacity = 2,
  drainRetryMs?: number,
) {
  const store = createStore();
  const sent = new Map<string, ServerMessage[]>();
  const connections = new Map<string, string>();
  const admission = withSfu
    ? new SfuResourceAdmission({
        ingressCapacity: sfuIngressCapacity,
        egressCapacity: 20,
      })
    : undefined;
  const roomControl = withSfu ? new FakeSfuRoomControl() : undefined;
  const onRoutesChanged = vi.fn();
  let nextTokenIssueError: Error | null = null;
  const router = new HybridMediaRouter({
    roomStore: store,
    endpointMediaCopyCapacity,
    ...(admission && roomControl
      ? {
          sfuFallback: {
            url: "wss://sfu.example.test",
            admission,
            roomControl,
            ...(prepareTimeoutMs ? { prepareTimeoutMs } : {}),
            ...(drainRetryMs ? { drainRetryMs } : {}),
            tokenIssuer: {
              async issueToken({ peerId }) {
                if (nextTokenIssueError) {
                  const error = nextTokenIssueError;
                  nextTokenIssueError = null;
                  throw error;
                }
                return `token-${peerId}`;
              },
            },
          },
        }
      : {}),
    sendToSession(sessionId, message) {
      const messages = sent.get(sessionId) ?? [];
      messages.push(message);
      sent.set(sessionId, messages);
    },
    getConnectionId(roomId, viewerPeerId) {
      return connections.get(`${roomId}:${viewerPeerId}`);
    },
    setConnectionId(roomId, viewerPeerId, connectionId) {
      connections.set(`${roomId}:${viewerPeerId}`, connectionId);
    },
    deleteConnectionId(roomId, viewerPeerId) {
      connections.delete(`${roomId}:${viewerPeerId}`);
    },
    getShareGeneration: () => SHARE_GENERATION,
    onRoutesChanged,
  });
  return {
    store,
    sent,
    admission,
    roomControl,
    onRoutesChanged,
    failNextTokenIssue() {
      nextTokenIssueError = new Error("token issue failed");
    },
    router,
  };
}

async function establishSfuRoom(
  store: RoomStore,
  sent: Map<string, ServerMessage[]>,
  router: HybridMediaRouter,
  room: CreatedRoom,
) {
  const host = connectHost(store, room);
  complete(router, host);
  const first = connectViewer(store, room, `sfu-root-${room.roomId}`);
  complete(router, first);
  await vi.waitFor(() => expect(preparedFor(sent, first.sessionId)).toBeDefined());
  const firstDirect = preparedFor(sent, first.sessionId)!;
  router.handleRouteReady(first, {
    type: "route-ready",
    revision: firstDirect.revision,
    phase: "prepare",
  });
  const second = connectViewer(store, room, `sfu-leaf-${room.roomId}`);
  complete(router, second);
  await vi.waitFor(() =>
    expect(preparedFor(sent, first.sessionId)?.candidate.transport).toBe("sfu"),
  );
  const firstSfu = preparedFor(sent, first.sessionId)!;
  router.handleRouteReady(first, {
    type: "route-ready",
    revision: firstSfu.revision,
    phase: "prepare",
  });
  await vi.waitFor(() =>
    expect(preparedFor(sent, second.sessionId)?.candidate.transport).toBe("sfu"),
  );
  const secondSfu = preparedFor(sent, second.sessionId)!;
  router.handleRouteReady(second, {
    type: "route-ready",
    revision: secondSfu.revision,
    phase: "prepare",
  });
  return { host, first, second };
}

describe("HybridMediaRouter v9 runtime", () => {
  it("projects exact endpoint copy context from the current snapshot", async () => {
    const { router } = harness(2);
    const internal = router as unknown as {
      qualityCopyContext(
        snapshot: unknown,
        hostPeerId: string,
        observedPeerId: string,
        endpointCapacity: number,
        sample: unknown,
      ): Record<string, unknown>;
    };
    const edge = (parentPeerId: string, connectionId: string) => ({
      kind: "peer", childSessionId: "child-session", parentPeerId,
      parentSessionId: "parent-session", transport: "direct", connectionId,
      usable: true, physicalActive: true,
    });
    const operation = (tuple: unknown, transition: unknown) => ({
      childPeerId: "candidate", childSessionId: "candidate-session",
      demandPeerId: "candidate", reason: "quality-convergence",
      baseRevision: 7, factVersion: 1, candidates: [{ tuple, endpointTransition: transition }],
      cursor: 0, deadlineAtMs: 20_000, wakeAtMs: 20_000,
      current: { tuple, revision: 8, connectionId: "candidate-connection" },
    });
    const snapshot = (
      upstreamByViewer: Map<string, unknown>,
      op?: unknown,
      hostPublication: unknown = null,
    ) => ({
      revision: 7, paused: false, factVersion: 1, upstreamByViewer,
      hostPublication, ...(op ? { operation: op } : {}),
    });
    const project = (
      state: unknown,
      observedPeerId: string,
      endpointCapacity: number,
      sample: unknown,
    ) => internal.qualityCopyContext(
      state, "host", observedPeerId, endpointCapacity, sample,
    );
    const hostEdges = new Map<string, unknown>([
      ["a", edge("host", "a-connection")],
      ["b", edge("host", "b-connection")],
    ]);
    const peerCandidate = {
      kind: "peer", parentPeerId: "host", transport: "direct",
    };
    const sfuSample = {
      kind: "sfu", routeRevision: 8,
      publicationGeneration: "publication", hostSessionId: "host-session",
    };
    const publication = {
      generation: "publication", hostSessionId: "host-session",
      connectionId: "publication-connection", usable: true,
      physicalActive: true, resource: {},
    };

    try {
      expect(project(
        snapshot(hostEdges, operation(peerCandidate, {
          kind: "overlap", producerPeerId: "host",
        })),
        "host", 2,
        { kind: "peer", childPeerId: "candidate", routeRevision: 8,
          connectionId: "candidate-connection" },
      )).toMatchObject({
        committedCopies: 2, candidateReservedCopies: 1, possibleCopies: 3,
        endpointCapacity: 2, operationReason: "quality-convergence",
        candidateTransition: "overlap", sampleRole: "candidate",
      });

      const oneHostEdge = new Map<string, unknown>([
        ["a", edge("host", "a-connection")],
      ]);
      const sfuCases = [
        {
          state: snapshot(hostEdges, operation(
            { kind: "sfu", publication: "create" },
            { kind: "overlap", producerPeerId: "host" },
          )),
          expected: { committedCopies: 2, candidateReservedCopies: 1,
            possibleCopies: 3, candidateTransition: "overlap" },
        },
        {
          state: snapshot(oneHostEdge, operation(
            { kind: "sfu", publication: "reuse" }, { kind: "none" },
          ), publication),
          expected: { committedCopies: 2, candidateReservedCopies: 0,
            possibleCopies: 2, candidateTransition: "none" },
        },
      ];
      for (const testCase of sfuCases) {
        expect(project(testCase.state, "host", 2, sfuSample)).toMatchObject({
          ...testCase.expected, sampleRole: "candidate",
        });
      }

      const relayEdges = new Map<string, unknown>([
        ["a", edge("relay", "relay-a")],
        ["b", edge("relay", "relay-b")],
      ]);
      const relaySample = {
        kind: "peer", childPeerId: "a", routeRevision: 7,
        connectionId: "relay-a",
      };
      expect(project(snapshot(relayEdges), "relay", 3, relaySample)).toMatchObject({
        committedCopies: 2, candidateReservedCopies: 0, possibleCopies: 2,
        endpointCapacity: 3, sampleRole: "active",
      });
      expect(project(
        snapshot(relayEdges), "relay", 3,
        { ...relaySample, routeRevision: 6 },
      ).sampleRole).toBe("unknown");
    } finally {
      await router.close();
    }
  });

  it("keeps the controller diagnostic label until a departed relay is pruned", async () => {
    const { store, sent, router } = harness(2);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const parent = connectViewer(store, room, "diagnostic-label-parent");
      complete(router, parent);
      const parentPrepare = await vi.waitFor(() => {
        const prepared = preparedFor(sent, parent.sessionId);
        expect(prepared).toBeDefined();
        return prepared!;
      });
      router.handleRouteReady(parent, {
        type: "route-ready",
        revision: parentPrepare.revision,
        phase: "prepare",
      });
      router.setViewerRelayCapacity(parent, 1);

      const temporaryRoot = connectViewer(
        store,
        room,
        "diagnostic-label-temporary-root",
      );
      complete(router, temporaryRoot);
      const temporaryPrepare = await vi.waitFor(() => {
        const prepared = preparedFor(sent, temporaryRoot.sessionId);
        expect(prepared?.assignment.upstream).toEqual({
          kind: "peer",
          peerId: host.peerId,
        });
        return prepared!;
      });
      router.handleRouteReady(temporaryRoot, {
        type: "route-ready",
        revision: temporaryPrepare.revision,
        phase: "prepare",
      });

      const child = connectViewer(store, room, "diagnostic-label-child");
      complete(router, child);
      const childPrepare = await vi.waitFor(() => {
        const prepared = preparedFor(sent, child.sessionId);
        expect(prepared?.assignment.upstream).toEqual({
          kind: "peer",
          peerId: parent.peerId,
        });
        return prepared!;
      });
      router.handleRouteReady(child, {
        type: "route-ready",
        revision: childPrepare.revision,
        phase: "prepare",
      });

      store.disconnectParticipant(
        room.roomId,
        temporaryRoot.peerId,
        temporaryRoot.sessionId,
      );
      router.disconnectParticipant(
        room.roomId,
        temporaryRoot.peerId,
        temporaryRoot.sessionId,
      );
      router.removeViewer(room.roomId, temporaryRoot.peerId);
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(
            room.roomId,
            temporaryRoot.peerId,
          ),
        ).toBeUndefined(),
      );

      const internal = router as unknown as {
        debugPeer(roomId: string, peerId: string): string;
      };
      const label = internal.debugPeer(room.roomId, parent.peerId);

      store.disconnectParticipant(
        room.roomId,
        parent.peerId,
        parent.sessionId,
      );
      router.disconnectParticipant(
        room.roomId,
        parent.peerId,
        parent.sessionId,
      );
      router.removeViewer(room.roomId, parent.peerId);
      expect(internal.debugPeer(room.roomId, parent.peerId)).toBe(label);

      const recovery = await vi.waitFor(() => {
        const prepared = preparedFor(sent, child.sessionId);
        expect(prepared?.revision).toBeGreaterThan(childPrepare.revision);
        expect(prepared?.assignment.upstream).toEqual({
          kind: "peer",
          peerId: host.peerId,
        });
        return prepared!;
      });
      router.handleRouteReady(child, {
        type: "route-ready",
        revision: recovery.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(internal.debugPeer(room.roomId, parent.peerId)).toBe(
          "viewer-unknown",
        ),
      );
    } finally {
      await router.close();
    }
  });

  it("maps an exact Host active failure to its committed direct edge", async () => {
    const { store, sent, router } = harness(2);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "host-edge-failure");
      complete(router, viewer);
      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)).toBeDefined(),
      );
      const prepared = preparedFor(sent, viewer.sessionId)!;
      router.handleRouteReady(viewer, {
        type: "route-ready",
        revision: prepared.revision,
        phase: "prepare",
      });
      const active = router.resolveActiveViewerMediaEdge(
        room.roomId,
        viewer.peerId,
      )!;

      router.handleRouteFailed(host, {
        type: "route-failed",
        revision: active.revision,
        phase: "active",
        connectionId: active.connectionId,
      });

      await vi.waitFor(() =>
        expect(
          sent
            .get(viewer.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          state: "failed",
          reason: "route-exhausted",
        }),
      );
    } finally {
      await router.close();
    }
  });

  it("accepts active failure for a direct connection adopted during rebuild", async () => {
    const { store, sent, router } = harness(2);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "rebuilt-edge-failure");
      complete(router, viewer);
      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)).toBeDefined(),
      );
      const prepared = preparedFor(sent, viewer.sessionId)!;
      router.handleRouteReady(viewer, {
        type: "route-ready",
        revision: prepared.revision,
        phase: "prepare",
      });
      const active = router.resolveActiveViewerMediaEdge(
        room.roomId,
        viewer.peerId,
      )!;
      const rebuiltConnectionId = "rebuilt_connection_12345678";
      expect(
        router.peerSignalAuthorization({
          roomId: room.roomId,
          sourcePeerId: host.peerId,
          sourceSessionId: host.sessionId,
          targetPeerId: viewer.peerId,
          targetSessionId: viewer.sessionId,
          connectionId: rebuiltConnectionId,
          signalKind: "description",
          descriptionType: "offer",
        }),
      ).toBe(true);
      expect(
        router.resolveActiveViewerMediaEdge(room.roomId, viewer.peerId),
      ).toMatchObject({
        revision: active.revision,
        connectionId: rebuiltConnectionId,
      });

      router.handleRouteFailed(viewer, {
        type: "route-failed",
        revision: active.revision,
        phase: "active",
        connectionId: rebuiltConnectionId,
      });

      await vi.waitFor(() =>
        expect(
          sent
            .get(viewer.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          state: "failed",
          reason: "route-exhausted",
        }),
      );
    } finally {
      await router.close();
    }
  });

  it("commits P2P quality convergence after client relative approval", async () => {
    const { store, sent, router } = harness(2);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room, {
        peerOnly: false,
        topologyOptimization: true,
      });
      complete(router, host);
      const first = connectViewer(store, room, "quality-first");
      complete(router, first);
      await vi.waitFor(() => expect(preparedFor(sent, first.sessionId)).toBeDefined());
      const firstPrepare = preparedFor(sent, first.sessionId)!;
      expect(firstPrepare.candidate.qualityProbe).toBe(false);
      router.handleRouteReady(first, {
        type: "route-ready",
        revision: firstPrepare.revision,
        phase: "prepare",
      });
      const second = connectViewer(store, room, "quality-second");
      complete(router, second);
      await vi.waitFor(() => expect(preparedFor(sent, second.sessionId)).toBeDefined());
      const secondPrepare = preparedFor(sent, second.sessionId)!;
      router.handleRouteReady(second, {
        type: "route-ready",
        revision: secondPrepare.revision,
        phase: "prepare",
      });
      router.setViewerRelayCapacity(second, 3);

      const firstEdge = router.resolveActiveViewerMediaEdge(room.roomId, first.peerId)!;
      const secondEdge = router.resolveActiveViewerMediaEdge(room.roomId, second.peerId)!;
      expect(firstEdge.upstream).toEqual({ kind: "peer", peerId: host.peerId });
      expect(secondEdge.upstream).toEqual({ kind: "peer", peerId: host.peerId });
      const debug = vi.spyOn(
        router as unknown as {
          debug(
            roomId: string,
            event: string,
            details: Record<string, unknown>,
          ): void;
        },
        "debug",
      );
      expect(
        router.observeSenderQualityEvidence(host, {
          type: "sender-quality-evidence",
          childPeerId: second.peerId,
          connectionId: secondEdge.connectionId,
          rtpStatsId: "second-rtp",
          trackIdentifier: "track",
          sampleTimestampMs: 100,
          routeRevision: secondEdge.revision,
          state: "healthy",
          diagnostics: senderDiagnostics("healthy"),
        }),
      ).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        room.roomId,
        "sender-quality-evidence",
        expect.objectContaining({
          routeRevision: secondEdge.revision,
          committedCopies: 2,
          candidateReservedCopies: 0,
          possibleCopies: 2,
          endpointCapacity: 2,
          operationReason: null,
          candidateTransition: null,
          sampleRole: "active",
        }),
      );
      expect(
        router.observeSenderQualityEvidence(host, {
          type: "sender-quality-evidence",
          childPeerId: first.peerId,
          connectionId: firstEdge.connectionId,
          rtpStatsId: "first-rtp",
          trackIdentifier: "track",
          sampleTimestampMs: 100,
          routeRevision: firstEdge.revision,
          state: "healthy",
          diagnostics: senderDiagnostics("healthy"),
        }),
      ).toBe(true);
      for (let window = 0; window < 3; window += 1) {
        expect(
          router.observeSenderQualityEvidence(host, {
            type: "sender-quality-evidence",
            childPeerId: first.peerId,
            connectionId: firstEdge.connectionId,
            rtpStatsId: "first-rtp",
            trackIdentifier: "track",
            sampleTimestampMs: 101 + window,
            routeRevision: firstEdge.revision,
            state: "degraded",
            diagnostics: senderDiagnostics("degraded"),
          }),
        ).toBe(true);
      }

      await vi.waitFor(() =>
        expect(preparedFor(sent, first.sessionId)?.revision).toBeGreaterThan(
          firstEdge.revision,
        ),
      );
      const qualityPrepare = preparedFor(sent, first.sessionId)!;
      expect(qualityPrepare.candidate.qualityProbe).toBe(true);
      expect(
        router.observeSenderQualityEvidence(second, {
          type: "sender-quality-evidence",
          childPeerId: first.peerId,
          connectionId: qualityPrepare.candidate.connectionId,
          rtpStatsId: "candidate-rtp",
          trackIdentifier: "track",
          sampleTimestampMs: 200,
          routeRevision: qualityPrepare.revision,
          state: "healthy",
          diagnostics: senderDiagnostics("healthy"),
        }),
      ).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        room.roomId,
        "sender-quality-evidence",
        expect.objectContaining({
          routeRevision: qualityPrepare.revision,
          committedCopies: 0,
          candidateReservedCopies: 1,
          possibleCopies: 1,
          endpointCapacity: 2,
          operationReason: "quality-convergence",
          candidateTransition: "none",
          sampleRole: "candidate",
        }),
      );
      router.handleRouteReady(first, {
        type: "route-ready",
        revision: qualityPrepare.revision,
        phase: "prepare",
      });
      expect(
        router.resolveActiveViewerMediaEdge(room.roomId, first.peerId)?.upstream,
      ).toEqual({ kind: "peer", peerId: host.peerId });
      router.handleRouteReady(first, {
        type: "route-ready",
        revision: qualityPrepare.revision,
        phase: "prepare",
        qualityApproved: true,
      });
      expect(
        router.resolveActiveViewerMediaEdge(room.roomId, first.peerId)?.upstream,
      ).toEqual({ kind: "peer", peerId: second.peerId });
    } finally {
      await router.close();
    }
  });

  it("keeps peer-only shares out of configured SFU fallback", async () => {
    const { store, sent, router } = harness(1, true);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room, {
        peerOnly: true,
        topologyOptimization: false,
      });
      complete(router, host);
      const first = connectViewer(store, room, "peer-only-first");
      complete(router, first);
      await vi.waitFor(() =>
        expect(preparedFor(sent, first.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const direct = preparedFor(sent, first.sessionId)!;
      router.handleRouteReady(first, {
        type: "route-ready",
        revision: direct.revision,
        phase: "prepare",
      });

      const blocked = connectViewer(store, room, "peer-only-blocked");
      complete(router, blocked);
      await vi.waitFor(() =>
        expect(
          sent
            .get(blocked.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({ state: "failed", reason: "route-exhausted" }),
      );
      expect(
        [...sent.values()]
          .flat()
          .some((message) => message.type === "sfu-config"),
      ).toBe(false);
    } finally {
      await router.close();
    }
  });

  it("silently keeps working media when quality-only SFU admission is denied", async () => {
    const { store, sent, admission, router } = harness(1, true, undefined, 1);
    const occupied = {
      roomId: "9001",
      shareGeneration: "occupied_share_12345678",
      publicationGeneration: "occupied_publication_12345678",
    };
    try {
      expect(admission?.reservePublication(occupied)).toBe(true);
      const room = await store.createRoom();
      const host = connectHost(store, room, {
        peerOnly: false,
        topologyOptimization: true,
      });
      complete(router, host);
      const viewer = connectViewer(store, room, "quality-sfu-denied");
      complete(router, viewer);
      await vi.waitFor(() => expect(preparedFor(sent, viewer.sessionId)).toBeDefined());
      const prepared = preparedFor(sent, viewer.sessionId)!;
      router.handleRouteReady(viewer, {
        type: "route-ready",
        revision: prepared.revision,
        phase: "prepare",
      });
      const active = router.resolveActiveViewerMediaEdge(room.roomId, viewer.peerId)!;
      for (const [index, state] of (
        ["healthy", "degraded"] as const
      ).entries()) {
        expect(
          router.observeSenderQualityEvidence(host, {
            type: "sender-quality-evidence",
            childPeerId: viewer.peerId,
            connectionId: active.connectionId,
            rtpStatsId: "viewer-rtp",
            trackIdentifier: "track",
            sampleTimestampMs: 100 + index,
            routeRevision: active.revision,
            state,
            diagnostics: senderDiagnostics(state),
          }),
        ).toBe(true);
      }
      await vi.waitFor(() =>
        expect(router.routeDiagnosticSnapshot(room.roomId).operation).toBeNull(),
      );
      expect(
        sent
          .get(viewer.sessionId)
          ?.some((message) => message.type === "route-status"),
      ).toBe(false);
      expect(
        router.resolveActiveViewerMediaEdge(room.roomId, viewer.peerId),
      ).toMatchObject({
        connectionId: active.connectionId,
        upstream: { kind: "peer", peerId: host.peerId },
      });
    } finally {
      if (admission) {
        admission.beginDrain(occupied);
        admission.completeDrain(occupied);
      }
      await router.close();
    }
  });


  it("notifies the presence owner after the committed graph changes", async () => {
    const { store, sent, router, onRoutesChanged } = harness(1, true);
    try {
      const room = await store.createRoom();
      await establishSfuRoom(
        store,
        sent,
        router,
        room,
      );

      await vi.waitFor(() => {
        expect(onRoutesChanged.mock.calls.at(-1)).toEqual([room.roomId]);
      });
    } finally {
      await router.close();
    }
  });

  it("wakes at the derived direct boundary and prepares SFU automatically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, router } = harness(2, true, 300);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "staged-deadline");
      complete(router, viewer);

      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      expect(
        sent
          .get(viewer.sessionId)
          ?.some(
            (message) =>
              message.type === "route-status" && message.state === "failed",
          ),
      ).toBe(false);
    } finally {
      await router.close();
      vi.useRealTimers();
    }
  });

  it("keeps an exact transport-connected direct candidate past the boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, router } = harness(2, true, 300);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "transport-connected");
      complete(router, viewer);
      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const direct = preparedFor(sent, viewer.sessionId)!;
      router.handleRouteTransportConnected(viewer, {
        type: "route-transport-connected",
        revision: direct.revision,
        connectionId: direct.candidate.connectionId,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(preparedFor(sent, viewer.sessionId)).toEqual(direct);
      router.handleRouteReady(viewer, {
        type: "route-ready",
        revision: direct.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(activeAfter(sent, viewer.sessionId, direct.revision - 1)).toMatchObject({
          assignment: { upstream: { kind: "peer" } },
        }),
      );
    } finally {
      await router.close();
      vi.useRealTimers();
    }
  });

  it("uses the direct boundary to bootstrap SFU when every Host slot is full", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, router } = harness(2, true, 300);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);

      const firstRoot = connectViewer(store, room, "first-root");
      complete(router, firstRoot);
      await vi.waitFor(() =>
        expect(preparedFor(sent, firstRoot.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const firstPrepare = preparedFor(sent, firstRoot.sessionId)!;
      router.handleRouteReady(firstRoot, {
        type: "route-ready",
        revision: firstPrepare.revision,
        phase: "prepare",
      });
      router.setViewerRelayCapacity(firstRoot, 2);

      const secondRoot = connectViewer(store, room, "second-root");
      complete(router, secondRoot);
      await vi.waitFor(() =>
        expect(preparedFor(sent, secondRoot.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const secondPrepare = preparedFor(sent, secondRoot.sessionId)!;
      router.handleRouteReady(secondRoot, {
        type: "route-ready",
        revision: secondPrepare.revision,
        phase: "prepare",
      });

      const waiting = connectViewer(store, room, "waiting");
      complete(router, waiting);
      await vi.waitFor(() =>
        expect(preparedFor(sent, waiting.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );

      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(preparedFor(sent, secondRoot.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      const secondBootstrap = preparedFor(sent, secondRoot.sessionId)!;
      router.handleRouteFailed(secondRoot, {
        type: "route-failed",
        revision: secondBootstrap.revision,
        phase: "prepare",
        connectionId: secondBootstrap.candidate.connectionId,
      });
      await vi.waitFor(() =>
        expect(preparedFor(sent, firstRoot.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      expect(
        sent
          .get(secondRoot.sessionId)
          ?.some(
            (message) =>
              message.type === "route-status" && message.state === "failed",
          ),
      ).toBe(false);
      const firstBootstrap = preparedFor(sent, firstRoot.sessionId)!;
      router.handleRouteFailed(firstRoot, {
        type: "route-failed",
        revision: firstBootstrap.revision,
        phase: "prepare",
        connectionId: firstBootstrap.candidate.connectionId,
      });
      await vi.waitFor(() =>
        expect(
          sent
            .get(waiting.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          state: "failed",
          reason: "route-exhausted",
        }),
      );
      for (const root of [firstRoot, secondRoot]) {
        expect(
          sent
            .get(root.sessionId)
            ?.some(
              (message) =>
                message.type === "route-status" && message.state === "failed",
            ),
        ).toBe(false);
      }
      expect(
        sent
          .get(waiting.sessionId)
          ?.some(
            (message) =>
              message.type === "route-status" && message.state === "failed",
          ),
      ).toBe(true);
    } finally {
      await router.close();
      vi.useRealTimers();
    }
  });

  it("does not recreate SFU after an exhausted reuse and carrier teardown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, admission, roomControl, router } = harness(
      2,
      true,
      300,
    );
    const sfuConfigCount = () =>
      [...sent.values()]
        .flat()
        .filter((message) => message.type === "sfu-config").length;
    const ownPrepare = (participant: AuthenticatedRouteParticipant) =>
      sent
        .get(participant.sessionId)
        ?.findLast(
          (
            message,
          ): message is Extract<
            ServerMessage,
            { type: "route-update"; phase: "prepare" }
          > =>
            message.type === "route-update" &&
            message.phase === "prepare" &&
            message.candidate.childPeerId === participant.peerId,
        );
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);

      const firstRoot = connectViewer(store, room, "reuse-loop-first-root");
      complete(router, firstRoot);
      await vi.waitFor(() =>
        expect(preparedFor(sent, firstRoot.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const firstDirect = preparedFor(sent, firstRoot.sessionId)!;
      router.handleRouteReady(firstRoot, {
        type: "route-ready",
        revision: firstDirect.revision,
        phase: "prepare",
      });
      router.setViewerRelayCapacity(firstRoot, 1);

      const secondRoot = connectViewer(store, room, "reuse-loop-second-root");
      complete(router, secondRoot);
      await vi.waitFor(() =>
        expect(preparedFor(sent, secondRoot.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const secondDirect = preparedFor(sent, secondRoot.sessionId)!;
      router.handleRouteReady(secondRoot, {
        type: "route-ready",
        revision: secondDirect.revision,
        phase: "prepare",
      });

      const departedParent = connectViewer(
        store,
        room,
        "reuse-loop-departed-parent",
      );
      complete(router, departedParent);
      await vi.waitFor(() =>
        expect(
          preparedFor(sent, departedParent.sessionId)?.assignment.upstream,
        ).toEqual({ kind: "peer", peerId: firstRoot.peerId }),
      );
      const parentDirect = preparedFor(sent, departedParent.sessionId)!;
      router.handleRouteReady(departedParent, {
        type: "route-ready",
        revision: parentDirect.revision,
        phase: "prepare",
      });
      router.setViewerRelayCapacity(departedParent, 1);

      const demand = connectViewer(store, room, "reuse-loop-demand");
      complete(router, demand);
      await vi.waitFor(() =>
        expect(preparedFor(sent, demand.sessionId)?.assignment.upstream).toEqual(
          { kind: "peer", peerId: departedParent.peerId },
        ),
      );
      const demandDirect = preparedFor(sent, demand.sessionId)!;
      router.handleRouteReady(demand, {
        type: "route-ready",
        revision: demandDirect.revision,
        phase: "prepare",
      });

      const departureAt = Date.now();
      store.disconnectParticipant(
        room.roomId,
        departedParent.peerId,
        departedParent.sessionId,
      );
      router.disconnectParticipant(
        room.roomId,
        departedParent.peerId,
        departedParent.sessionId,
      );
      router.removeViewer(room.roomId, departedParent.peerId);
      router.setViewerRelayCapacity(secondRoot, 1);

      await vi.waitFor(() => {
        const recovery = ownPrepare(demand);
        expect(recovery?.revision).toBeGreaterThan(demandDirect.revision);
        expect(recovery?.candidate).toMatchObject({
          childPeerId: demand.peerId,
          transport: "direct",
        });
      });
      await vi.advanceTimersByTimeAsync(
        Math.max(0, departureAt + 150 - Date.now()),
      );

      const carrier = await vi.waitFor(() => {
        const value = [firstRoot, secondRoot].find(
          (viewer) =>
            ownPrepare(viewer)?.candidate.transport === "sfu",
        );
        expect(value).toBeDefined();
        return value!;
      });
      const bootstrap = ownPrepare(carrier)!;
      router.handleRouteReady(carrier, {
        type: "route-ready",
        revision: bootstrap.revision,
        phase: "prepare",
      });

      await vi.waitFor(() =>
        expect(preparedFor(sent, demand.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      expect(roomControl?.created).toHaveLength(1);
      const configCountAfterBootstrap = sfuConfigCount();
      expect(configCountAfterBootstrap).toBeGreaterThanOrEqual(3);

      await vi.advanceTimersByTimeAsync(
        Math.max(0, departureAt + 300 - Date.now()),
      );
      await vi.waitFor(() =>
        expect(ownPrepare(carrier)?.candidate.transport).toBe(
          "direct",
        ),
      );
      expect(router.routeDiagnosticSnapshot(room.roomId).operation).toMatchObject({
        reason: "direct-convergence",
      });
      const carrierDirect = ownPrepare(carrier)!;
      router.handleRouteReady(carrier, {
        type: "route-ready",
        revision: carrierDirect.revision,
        phase: "prepare",
      });

      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, carrier.peerId)
            ?.upstream,
        ).toEqual({ kind: "peer", peerId: host.peerId }),
      );
      await vi.waitFor(() => expect(roomControl?.deleted).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(300);

      expect(roomControl?.created).toHaveLength(1);
      expect(sfuConfigCount()).toBe(configCountAfterBootstrap);
      expect(admission?.usage()).toEqual({ ingress: 0, egress: 0 });
    } finally {
      await router.close();
      vi.useRealTimers();
    }
  });

  it("reports a late final SFU bootstrap ready only to the waiting demand", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, router } = harness(2, true, 300);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);

      const firstRoot = connectViewer(store, room, "late-ready-first-root");
      complete(router, firstRoot);
      await vi.waitFor(() =>
        expect(preparedFor(sent, firstRoot.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const firstPrepare = preparedFor(sent, firstRoot.sessionId)!;
      router.handleRouteReady(firstRoot, {
        type: "route-ready",
        revision: firstPrepare.revision,
        phase: "prepare",
      });
      router.setViewerRelayCapacity(firstRoot, 2);

      const secondRoot = connectViewer(store, room, "late-ready-second-root");
      complete(router, secondRoot);
      await vi.waitFor(() =>
        expect(preparedFor(sent, secondRoot.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const secondPrepare = preparedFor(sent, secondRoot.sessionId)!;
      router.handleRouteReady(secondRoot, {
        type: "route-ready",
        revision: secondPrepare.revision,
        phase: "prepare",
      });

      const waiting = connectViewer(store, room, "late-ready-waiting");
      complete(router, waiting);
      await vi.waitFor(() =>
        expect(preparedFor(sent, waiting.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );

      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(preparedFor(sent, secondRoot.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      const firstCarrier = preparedFor(sent, secondRoot.sessionId)!;
      router.handleRouteFailed(secondRoot, {
        type: "route-failed",
        revision: firstCarrier.revision,
        phase: "prepare",
        connectionId: firstCarrier.candidate.connectionId,
      });

      await vi.waitFor(() =>
        expect(preparedFor(sent, firstRoot.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      const finalCarrier = preparedFor(sent, firstRoot.sessionId)!;
      vi.setSystemTime(451);
      router.handleRouteReady(firstRoot, {
        type: "route-ready",
        revision: finalCarrier.revision,
        phase: "prepare",
      });

      await vi.waitFor(() =>
        expect(
          sent
            .get(waiting.sessionId)
            ?.filter(
              (message) =>
                message.type === "route-status" &&
                message.state === "failed" &&
                message.reason === "route-exhausted",
            ),
        ).toHaveLength(1),
      );
      for (const carrier of [firstRoot, secondRoot]) {
        expect(
          sent
            .get(carrier.sessionId)
            ?.some(
              (message) =>
                message.type === "route-status" && message.state === "failed",
            ),
        ).toBe(false);
      }
    } finally {
      await router.close();
      vi.useRealTimers();
    }
  });

  it("reports bounded route exhaustion without raw error text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, router } = harness(2, true, 300);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "route-exhausted");
      complete(router, viewer);

      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(
          sent
            .get(viewer.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          type: "route-status",
          state: "failed",
          reason: "route-exhausted",
        }),
      );
      expect(
        sent
          .get(viewer.sessionId)
          ?.some(
            (message) =>
              message.type === "error" &&
              message.message.includes("media route"),
          ),
      ).toBe(false);
    } finally {
      await router.close();
      vi.useRealTimers();
    }
  });

  it("reports typed exhaustion when the exact candidate fails", async () => {
    const { store, sent, router } = harness(1);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "candidate-failed");
      complete(router, viewer);

      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)).toBeDefined(),
      );
      const prepared = preparedFor(sent, viewer.sessionId)!;
      router.handleRouteFailed(viewer, {
        type: "route-failed",
        revision: prepared.revision,
        phase: "prepare",
        connectionId: prepared.candidate.connectionId,
      });

      await vi.waitFor(() =>
        expect(
          sent
            .get(viewer.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          state: "failed",
          reason: "route-exhausted",
        }),
      );
    } finally {
      await router.close();
    }
  });

  it("reports typed exhaustion when reconciliation has no candidate", async () => {
    const { store, sent, router } = harness(1);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);

      const first = connectViewer(store, room, "only-slot");
      complete(router, first);
      await vi.waitFor(() =>
        expect(preparedFor(sent, first.sessionId)).toBeDefined(),
      );
      const firstPrepare = preparedFor(sent, first.sessionId)!;
      router.handleRouteReady(first, {
        type: "route-ready",
        revision: firstPrepare.revision,
        phase: "prepare",
      });

      const blocked = connectViewer(store, room, "no-candidate");
      complete(router, blocked);
      await vi.waitFor(() =>
        expect(
          sent
            .get(blocked.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          state: "failed",
          reason: "route-exhausted",
        }),
      );
    } finally {
      await router.close();
    }
  });

  it("reports only SFU admission waiting while bounded capacity is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { store, sent, admission, router } = harness(2, true, 300);
    const capacityFences = [
      {
        roomId: "9001",
        shareGeneration: "capacity_share_a",
        publicationGeneration: "capacity_publication_a",
      },
      {
        roomId: "9002",
        shareGeneration: "capacity_share_b",
        publicationGeneration: "capacity_publication_b",
      },
    ] as const;
    try {
      for (const fence of capacityFences) {
        expect(admission?.reservePublication(fence)).toBe(true);
      }
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const viewer = connectViewer(store, room, "sfu-admission-wait");
      complete(router, viewer);

      await vi.waitFor(() =>
        expect(preparedFor(sent, viewer.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(
          sent
            .get(viewer.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({
          type: "route-status",
          state: "waiting",
          reason: "sfu-admission",
        }),
      );
    } finally {
      for (const fence of capacityFences) {
        admission?.beginDrain(fence);
        admission?.completeDrain(fence);
      }
      await router.close();
      vi.useRealTimers();
    }
  });

  it("physically removes an exact subscription without releasing its generation charge", async () => {
    const { store, sent, admission, roomControl, router } = harness(
      1,
      true,
      undefined,
      2,
    );
    let closed = false;
    try {
      const activeRoom = await store.createRoom();
      const active = await establishSfuRoom(
        store,
        sent,
        router,
        activeRoom,
      );
      await vi.waitFor(() =>
        expect(admission?.usage()).toEqual({ ingress: 1, egress: 2 }),
      );
      expect(
        admission?.reservePublication({
          roomId: "9001",
          shareGeneration: "waiter_share_12345678",
          publicationGeneration: "waiter_publication_12345678",
        }),
      ).toBe(true);
      const reservePublication = vi.spyOn(admission!, "reservePublication");

      const waitingRoom = await store.createRoom();
      const waitingHost = connectHost(store, waitingRoom);
      complete(router, waitingHost);
      const waitingViewer = connectViewer(store, waitingRoom, "waiter");
      complete(router, waitingViewer);
      await vi.waitFor(() =>
        expect(preparedFor(sent, waitingViewer.sessionId)).toBeDefined(),
      );
      const direct = preparedFor(sent, waitingViewer.sessionId)!;
      router.handleRouteFailed(waitingViewer, {
        type: "route-failed",
        revision: direct.revision,
        phase: "prepare",
        connectionId: direct.candidate.connectionId,
      });
      await vi.waitFor(() =>
        expect(
          sent
            .get(waitingViewer.sessionId)
            ?.findLast((message) => message.type === "route-status"),
        ).toMatchObject({ state: "waiting", reason: "sfu-admission" }),
      );
      const attemptsBeforeRelease = reservePublication.mock.calls.length;
      const drainGate = deferred();
      roomControl!.subscriptionDrainBarrier = drainGate.promise;

      store.disconnectParticipant(
        activeRoom.roomId,
        active.first.peerId,
        active.first.sessionId,
      );
      router.disconnectParticipant(
        activeRoom.roomId,
        active.first.peerId,
        active.first.sessionId,
      );
      router.removeViewer(activeRoom.roomId, active.first.peerId);
      await vi.waitFor(() =>
        expect(router.routeDiagnosticSnapshot(activeRoom.roomId).children).toHaveLength(1),
      );
      await vi.waitFor(() =>
        expect(roomControl?.subscriptionDrainAttempts).toContainEqual(
          expect.objectContaining({ viewerPeerId: active.first.peerId }),
        ),
      );
      expect(admission?.usage()).toEqual({ ingress: 2, egress: 2 });
      drainGate.resolve();
      await vi.waitFor(() =>
        expect(roomControl?.drainedSubscriptions).toContainEqual(
          expect.objectContaining({ viewerPeerId: active.first.peerId }),
        ),
      );

      expect(admission?.usage()).toEqual({ ingress: 2, egress: 2 });
      expect(reservePublication).toHaveBeenCalledTimes(attemptsBeforeRelease);

      await router.close();
      closed = true;
      expect(admission?.usage()).toEqual({ ingress: 0, egress: 0 });
    } finally {
      if (!closed) await router.close();
    }
  });

  it("orders exact prepare, commits only child proof, and rolls back above P", async () => {
    const { store, sent, router } = harness(2);
    const room = await store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const first = connectViewer(store, room, "first");
    complete(router, first);

    await vi.waitFor(() => expect(preparedFor(sent, first.sessionId)).toBeDefined());
    const firstPrepare = preparedFor(sent, first.sessionId)!;
    expect(firstPrepare.candidate).toMatchObject({
      childPeerId: first.peerId,
      transport: "direct",
    });
    expect(preparedFor(sent, host.sessionId)?.candidate).toEqual(
      firstPrepare.candidate,
    );

    router.handleRouteReady(host, {
      type: "route-ready",
      revision: firstPrepare.revision,
      phase: "prepare",
    });
    expect(activeAfter(sent, first.sessionId, firstPrepare.revision)).toBeUndefined();
    router.handleRouteReady(first, {
      type: "route-ready",
      revision: firstPrepare.revision,
      phase: "prepare",
    });
    await vi.waitFor(() =>
      expect(
        sent
          .get(first.sessionId)
          ?.findLast(
            (message) =>
              message.type === "route-update" &&
              message.phase === "active" &&
              message.revision === firstPrepare.revision,
          ),
      ).toBeDefined(),
    );

    const second = connectViewer(store, room, "second");
    complete(router, second);
    await vi.waitFor(() => expect(preparedFor(sent, second.sessionId)).toBeDefined());
    const secondPrepare = preparedFor(sent, second.sessionId)!;
    router.handleRouteFailed(second, {
      type: "route-failed",
      revision: secondPrepare.revision,
      phase: "prepare",
      connectionId: secondPrepare.candidate.connectionId,
    });
    await vi.waitFor(() =>
      expect(activeAfter(sent, second.sessionId, secondPrepare.revision)).toBeDefined(),
    );
    expect(activeAfter(sent, second.sessionId, secondPrepare.revision)!.revision).toBeGreaterThan(
      secondPrepare.revision,
    );
    await router.close();
  });

  it("creates one Host publication and reuses exact Viewer subscriptions", async () => {
    const { store, sent, admission, router } = harness(1, true);
    const room = await store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const first = connectViewer(store, room, "sfu_first");
    complete(router, first);
    const firstDirect = await vi.waitFor(() => {
      const message = preparedFor(sent, first.sessionId);
      expect(message).toBeDefined();
      return message!;
    });
    router.handleRouteReady(first, {
      type: "route-ready",
      revision: firstDirect.revision,
      phase: "prepare",
    });

    const second = connectViewer(store, room, "sfu_second");
    complete(router, second);
    await vi.waitFor(() =>
      expect(
        preparedFor(sent, first.sessionId)?.candidate.transport,
      ).toBe("sfu"),
    );
    const firstSfu = preparedFor(sent, first.sessionId)!;
    router.handleRouteReady(first, {
      type: "route-ready",
      revision: firstSfu.revision,
      phase: "prepare",
    });

    await vi.waitFor(() =>
      expect(preparedFor(sent, second.sessionId)?.candidate.transport).toBe("sfu"),
    );
    const secondSfu = preparedFor(sent, second.sessionId)!;
    router.handleRouteReady(second, {
      type: "route-ready",
      revision: secondSfu.revision,
      phase: "prepare",
    });
    await vi.waitFor(() =>
      expect(admission?.usage()).toEqual({ ingress: 1, egress: 2 }),
    );
    const hostConfigs = sent
      .get(host.sessionId)
      ?.filter((message) => message.type === "sfu-config");
    expect(hostConfigs).toHaveLength(1);
    await router.close();
  });

  it("resolves exact direct and peer-relayed Viewer evidence sources", async () => {
    const { store, sent, router } = harness(1);
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const root = connectViewer(store, room, "evidence-root");
      complete(router, root);
      await vi.waitFor(() =>
        expect(preparedFor(sent, root.sessionId)).toBeDefined(),
      );
      const rootPrepare = preparedFor(sent, root.sessionId)!;
      expect(
        router.resolveActiveViewerMediaEdge(room.roomId, root.peerId),
      ).toBeUndefined();
      router.handleRouteReady(root, {
        type: "route-ready",
        revision: rootPrepare.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, root.peerId),
        ).toEqual({
          revision: rootPrepare.revision,
          connectionId: rootPrepare.candidate.connectionId,
          upstream: { kind: "peer", peerId: host.peerId },
        }),
      );

      router.setViewerRelayCapacity(root, 1);
      const child = connectViewer(store, room, "evidence-child");
      complete(router, child);
      await vi.waitFor(() =>
        expect(preparedFor(sent, child.sessionId)).toBeDefined(),
      );
      const childPrepare = preparedFor(sent, child.sessionId)!;
      expect(childPrepare.candidate.transport).toBe("direct");
      router.handleRouteReady(child, {
        type: "route-ready",
        revision: childPrepare.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, child.peerId),
        ).toEqual({
          revision: childPrepare.revision,
          connectionId: childPrepare.candidate.connectionId,
          upstream: { kind: "peer", peerId: root.peerId },
        }),
      );
    } finally {
      await router.close();
    }
  });

  it("retries a failed physical drain before reusing the exact SFU identity", async () => {
    const { store, sent, admission, roomControl, router } = harness(
      1,
      true,
      1_000,
      2,
      10,
    );
    try {
      const room = await store.createRoom();
      const { first } = await establishSfuRoom(store, sent, router, room);
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, first.peerId)
            ?.upstream,
        ).toEqual({ kind: "sfu" }),
      );

      router.setViewerRelayCapacity(first, 1);
      const child = connectViewer(store, room, "sfu-peer-child");
      complete(router, child);
      await vi.waitFor(() =>
        expect(preparedFor(sent, child.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 510));
      await vi.waitFor(() =>
        expect(preparedFor(sent, child.sessionId)?.candidate.transport).toBe(
          "sfu",
        ),
      );
      const sfuPrepare = preparedFor(sent, child.sessionId)!;
      router.handleRouteReady(child, {
        type: "route-ready",
        revision: sfuPrepare.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, child.peerId)
            ?.upstream,
        ).toEqual({ kind: "sfu" }),
      );
      await vi.waitFor(() =>
        expect(preparedFor(sent, child.sessionId)?.candidate.transport).toBe(
          "direct",
        ),
      );
      const directPrepare = preparedFor(sent, child.sessionId)!;
      const drainGate = deferred();
      const drainSubscription = vi
        .spyOn(roomControl!, "drainSubscription")
        .mockImplementationOnce(() => drainGate.promise);
      router.handleRouteReady(child, {
        type: "route-ready",
        revision: directPrepare.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, child.peerId)
            ?.upstream,
        ).toEqual({ kind: "peer", peerId: first.peerId }),
      );
      await vi.waitFor(() =>
        expect(drainSubscription).toHaveBeenCalledWith(
          expect.objectContaining({ viewerPeerId: child.peerId }),
        ),
      );
      expect(admission?.usage()).toEqual({ ingress: 1, egress: 3 });

      router.handleRouteFailed(child, {
        type: "route-failed",
        revision: directPrepare.revision,
        phase: "active",
        connectionId: directPrepare.candidate.connectionId,
      });
      await vi.waitFor(() =>
        expect(router.routeDiagnosticSnapshot(room.roomId).operation).not.toBeNull(),
      );
      expect(preparedFor(sent, child.sessionId)?.revision).toBe(
        directPrepare.revision,
      );

      drainGate.reject(new Error("transient participant drain failure"));
      await vi.waitFor(() => expect(drainSubscription).toHaveBeenCalledTimes(2));
      const reusedSfu = await vi.waitFor(() => {
        const prepared = preparedFor(sent, child.sessionId);
        expect(prepared?.revision).toBeGreaterThan(directPrepare.revision);
        expect(prepared?.candidate.transport).toBe("sfu");
        return prepared!;
      });
      router.handleRouteReady(child, {
        type: "route-ready",
        revision: reusedSfu.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, child.peerId)
            ?.upstream,
        ).toEqual({ kind: "sfu" }),
      );
      expect(roomControl!.drainedSubscriptions).toContainEqual(
        expect.objectContaining({ viewerPeerId: child.peerId }),
      );
      expect(admission?.usage()).toEqual({ ingress: 1, egress: 3 });
      expect(
        router.resolveActiveViewerMediaEdge(room.roomId, first.peerId)
          ?.upstream,
      ).toEqual({ kind: "sfu" });
    } finally {
      await router.close();
    }
  });

  it("serializes fresh SFU configuration without making refresh one-shot", async () => {
    const { store, sent, router } = harness(1, true);
    try {
      const room = await store.createRoom();
      const { first } = await establishSfuRoom(store, sent, router, room);
      const active = router.resolveActiveViewerMediaEdge(
        room.roomId,
        first.peerId,
      );
      expect(active?.upstream).toEqual({ kind: "sfu" });
      const configCount = () =>
        sent
          .get(first.sessionId)
          ?.filter((message) => message.type === "sfu-config").length ?? 0;
      const initialCount = configCount();

      router.refreshSfu(first, 0);
      await vi.waitFor(() => expect(configCount()).toBe(initialCount + 1));
      router.refreshSfu(first, active!.revision);
      await vi.waitFor(() => expect(configCount()).toBe(initialCount + 2));
    } finally {
      await router.close();
    }
  });

  it("fails the exact active SFU route when fresh configuration cannot be issued", async () => {
    const { store, sent, router, failNextTokenIssue } = harness(1, true);
    try {
      const room = await store.createRoom();
      const { first } = await establishSfuRoom(store, sent, router, room);
      const active = router.resolveActiveViewerMediaEdge(
        room.roomId,
        first.peerId,
      )!;
      expect(active.upstream).toEqual({ kind: "sfu" });

      failNextTokenIssue();
      router.refreshSfu(first, active.revision);

      await vi.waitFor(() =>
        expect(
          router.resolveActiveViewerMediaEdge(room.roomId, first.peerId),
        ).not.toEqual(active),
      );
    } finally {
      await router.close();
    }
  });







  it("emits typed exhaustion and clears diagnostics on departure and room deletion", async () => {
    const { store, sent, router } = harness(1);
    const room = await store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const viewer = connectViewer(store, room, "diagnostic");
    complete(router, viewer);
    await vi.waitFor(() =>
      expect(preparedFor(sent, viewer.sessionId)).toBeDefined(),
    );
    const prepared = preparedFor(sent, viewer.sessionId)!;
    expect(router.routeDiagnosticSnapshot(room.roomId).children).toHaveLength(1);

    router.handleRouteFailed(viewer, {
      type: "route-failed",
      revision: prepared.revision,
      phase: "prepare",
      connectionId: prepared.candidate.connectionId,
    });
    await vi.waitFor(() =>
      expect(
        sent
          .get(viewer.sessionId)
          ?.findLast((message) => message.type === "route-status"),
      ).toMatchObject({
        state: "failed",
        reason: "route-exhausted",
      }),
    );

    router.removeViewer(room.roomId, viewer.peerId);
    expect(router.routeDiagnosticSnapshot(room.roomId)).toEqual({
      children: [],
      operation: null,
    });

    const replacement = connectViewer(store, room, "diagnostic-replacement");
    complete(router, replacement);
    expect(router.routeDiagnosticSnapshot(room.roomId).children).toHaveLength(1);
    router.stopRoom(room.roomId);
    expect(router.routeDiagnosticSnapshot(room.roomId)).toEqual({
      children: [],
      operation: null,
    });

    complete(router, host);
    expect(
      router.routeDiagnosticSnapshot(room.roomId).children.length,
    ).toBeGreaterThan(0);
    router.deleteRoom(room.roomId);
    expect(router.routeDiagnosticSnapshot(room.roomId)).toEqual({
      children: [],
      operation: null,
    });
    await router.close();
  });

  it("preserves connected Viewer capacity across sharing generations", async () => {
    const { store, sent, router } = harness(1);
    const room = await store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const root = connectViewer(store, room, "retained-capacity-root");
    complete(router, root);
    await vi.waitFor(() => expect(preparedFor(sent, root.sessionId)).toBeDefined());
    const initialRoot = preparedFor(sent, root.sessionId)!;
    router.handleRouteReady(root, {
      type: "route-ready",
      revision: initialRoot.revision,
      phase: "prepare",
    });
    router.setViewerRelayCapacity(root, 1);

    router.stopRoom(room.roomId);
    sent.set(root.sessionId, []);
    complete(router, host);
    await vi.waitFor(() => expect(preparedFor(sent, root.sessionId)).toBeDefined());
    const restartedRoot = preparedFor(sent, root.sessionId)!;
    router.handleRouteReady(root, {
      type: "route-ready",
      revision: restartedRoot.revision,
      phase: "prepare",
    });

    const child = connectViewer(store, room, "retained-capacity-child");
    complete(router, child);
    await vi.waitFor(() => expect(preparedFor(sent, child.sessionId)).toBeDefined());
    expect(preparedFor(sent, child.sessionId)?.assignment.upstream).toEqual({
      kind: "peer",
      peerId: root.peerId,
    });
    await router.close();
  });

  it("emits typed exhaustion when reconciliation has no candidate", async () => {
    const { store, sent, router } = harness(1);
    const room = await store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);

    const first = connectViewer(store, room, "only-slot");
    complete(router, first);
    await vi.waitFor(() =>
      expect(preparedFor(sent, first.sessionId)).toBeDefined(),
    );
    const firstPrepare = preparedFor(sent, first.sessionId)!;
    router.handleRouteReady(first, {
      type: "route-ready",
      revision: firstPrepare.revision,
      phase: "prepare",
    });

    const blocked = connectViewer(store, room, "no-candidate");
    complete(router, blocked);
    await vi.waitFor(() =>
      expect(
        sent
          .get(blocked.sessionId)
          ?.findLast((message) => message.type === "route-status"),
      ).toMatchObject({
        state: "failed",
        reason: "route-exhausted",
      }),
    );
    await router.close();
  });

});
