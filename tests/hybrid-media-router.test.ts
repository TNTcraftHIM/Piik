import { describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "../src/shared/protocol.ts";
import {
  HybridMediaRouter,
  type AuthenticatedRouteParticipant,
  type HybridAuthenticationState,
} from "../src/server/hybrid-media-router.ts";
import { RoomStore } from "../src/server/room-store.ts";
import { SfuResourceAdmission } from "../src/server/sfu-resource-admission.ts";
import { TurnAllocationAdmission } from "../src/server/turn-allocation-admission.ts";
import { FakeSfuRoomControl } from "./fake-sfu-room-control.ts";

const SHARE_GENERATION = "share_generation_12345678";

function createStore(maxViewersPerRoom = 20) {
  return new RoomStore({
    ttlMs: 60_000,
    maxRooms: 4,
    maxViewersPerRoom,
  });
}

function connectHost(store: RoomStore, room: ReturnType<RoomStore["createRoom"]>) {
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
  };
}

function connectViewer(
  store: RoomStore,
  room: ReturnType<RoomStore["createRoom"]>,
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

function harness(
  endpointMediaCopyCapacity: 1 | 2 | 3,
  withSfu = false,
  withSelectedTurn = false,
) {
  const store = createStore();
  const sent = new Map<string, ServerMessage[]>();
  const connections = new Map<string, string>();
  const admission = withSfu
    ? new SfuResourceAdmission({ ingressCapacity: 2, egressCapacity: 20 })
    : undefined;
  const roomControl = withSfu ? new FakeSfuRoomControl() : undefined;
  const turnAdmission = withSelectedTurn
    ? new TurnAllocationAdmission({ capacity: 20 })
    : undefined;
  const router = new HybridMediaRouter({
    roomStore: store,
    endpointMediaCopyCapacity,
    ...(admission && roomControl
      ? {
          sfuFallback: {
            url: "wss://sfu.example.test",
            admission,
            roomControl,
            tokenIssuer: {
              async issueToken({ peerId }) {
                return `token-${peerId}`;
              },
            },
          },
        }
      : {}),
    ...(turnAdmission
      ? {
          selectedEdgeTurn: {
            config: {
              urls: ["turn:turn.example.test:3478?transport=udp"] as const,
              sharedSecret: "t".repeat(32),
              credentialTtlSeconds: 120,
              allocationCapacity: 20,
            },
            admission: turnAdmission,
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
  });
  return { store, sent, admission, turnAdmission, router };
}

describe("HybridMediaRouter v7 runtime", () => {
  it("orders exact prepare, commits only child proof, and rolls back above P", async () => {
    const { store, sent, router } = harness(2);
    const room = store.createRoom();
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
    const room = store.createRoom();
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

  it("uses selected TURN only as the exact Viewer-parent edge transport", async () => {
    const { store, sent, turnAdmission, router } = harness(1, true, true);
    const room = store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const parent = connectViewer(store, room, "selected_parent");
    complete(router, parent);
    await vi.waitFor(() => expect(preparedFor(sent, parent.sessionId)).toBeDefined());
    const parentPrepare = preparedFor(sent, parent.sessionId)!;
    router.handleRouteReady(parent, {
      type: "route-ready",
      revision: parentPrepare.revision,
      phase: "prepare",
    });
    router.setViewerRelayCapacity(parent, 1);

    const child = connectViewer(store, room, "selected_child");
    complete(router, child);
    await vi.waitFor(() =>
      expect(preparedFor(sent, child.sessionId)?.candidate.transport).toBe("direct"),
    );
    const direct = preparedFor(sent, child.sessionId)!;
    expect(direct.assignment.upstream).toEqual({
      kind: "peer",
      peerId: parent.peerId,
    });
    router.handleRouteReady(child, {
      type: "route-ready",
      revision: direct.revision,
      phase: "prepare",
    });

    router.handleRouteFailed(child, {
      type: "route-failed",
      revision: direct.revision,
      phase: "active",
      connectionId: direct.candidate.connectionId,
    });
    await vi.waitFor(() =>
      expect(preparedFor(sent, child.sessionId)?.candidate.transport).toBe(
        "selected-turn",
      ),
    );
    const selected = preparedFor(sent, child.sessionId)!;
    expect(
      sent
        .get(child.sessionId)
        ?.some(
          (message) =>
            message.type === "selected-edge-turn" &&
            message.edgeKind === "peer-selected" &&
            message.newConnectionId === selected.candidate.connectionId,
        ),
    ).toBe(true);
    router.handleRouteReady(child, {
      type: "route-ready",
      revision: selected.revision,
      phase: "prepare",
    });
    await vi.waitFor(() =>
      expect(turnAdmission?.usage()).toEqual({ allocations: 1 }),
    );
    await router.close();
    expect(turnAdmission?.usage()).toEqual({ allocations: 0 });
  });

  it("uses selected TURN as one Host-SFU ingress after direct ingress fails", async () => {
    const { store, sent, turnAdmission, router } = harness(1, true, true);
    const room = store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const first = connectViewer(store, room, "ingress_first");
    complete(router, first);
    await vi.waitFor(() => expect(preparedFor(sent, first.sessionId)).toBeDefined());
    const direct = preparedFor(sent, first.sessionId)!;
    router.handleRouteReady(first, {
      type: "route-ready",
      revision: direct.revision,
      phase: "prepare",
    });

    const waiting = connectViewer(store, room, "ingress_waiting");
    complete(router, waiting);
    await vi.waitFor(() =>
      expect(preparedFor(sent, first.sessionId)?.candidate.transport).toBe("sfu"),
    );
    const directIngress = preparedFor(sent, first.sessionId)!;
    router.handleRouteFailed(first, {
      type: "route-failed",
      revision: directIngress.revision,
      phase: "prepare",
      connectionId: directIngress.candidate.connectionId,
    });

    await vi.waitFor(() => {
      const prepared = preparedFor(sent, first.sessionId);
      expect(prepared?.revision).toBeGreaterThan(directIngress.revision);
      return prepared;
    });
    const selectedIngress = preparedFor(sent, first.sessionId)!;
    expect(
      sent
        .get(host.sessionId)
        ?.some(
          (message) =>
            message.type === "selected-edge-turn" &&
            message.edgeKind === "host-sfu-ingress" &&
            message.revision === selectedIngress.revision,
        ),
    ).toBe(true);
    router.handleRouteReady(first, {
      type: "route-ready",
      revision: selectedIngress.revision,
      phase: "prepare",
    });
    await vi.waitFor(() =>
      expect(turnAdmission?.usage()).toEqual({ allocations: 1 }),
    );
    await router.close();
  });
});
