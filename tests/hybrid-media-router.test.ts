import { describe, expect, it, vi } from "vitest";

import type { ServerMessage } from "../src/shared/protocol.ts";
import {
  HybridMediaRouter,
  type AuthenticatedRouteParticipant,
  type HybridAuthenticationState,
} from "../src/server/hybrid-media-router.ts";
import { RoomStore, type CreatedRoom } from "../src/server/room-store.ts";
import { SfuResourceAdmission } from "../src/server/sfu-resource-admission.ts";
import { FakeSfuRoomControl } from "./fake-sfu-room-control.ts";

const SHARE_GENERATION = "share_generation_12345678";

function createStore(maxViewersPerRoom = 20) {
  return new RoomStore({
    leaseMs: 60_000,
    maxRooms: 4,
    maxViewersPerRoom,
  });
}

function connectHost(store: RoomStore, room: CreatedRoom) {
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function reconnectHost(
  store: RoomStore,
  room: CreatedRoom,
  sessionId: string,
): AuthenticatedRouteParticipant {
  const connected = store.connectParticipant({
    roomId: room.roomId,
    role: "host",
    token: room.hostToken,
    clientId: "host_client_12345678",
    sessionId,
  });
  return {
    roomId: room.roomId,
    role: "host",
    peerId: connected.peerId,
    sessionId,
  };
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
  prepareTimeoutMs?: number,
  sfuIngressCapacity = 2,
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
  const onActiveRouteChanged = vi.fn();
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
            tokenIssuer: {
              async issueToken({ peerId }) {
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
    onActiveRouteChanged,
  });
  return {
    store,
    sent,
    admission,
    roomControl,
    onActiveRouteChanged,
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
      expect(
        sent
          .get(waiting.sessionId)
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

  it("does not wake admission waiters when a subscription remains charged for drain", async () => {
    const { store, sent, admission, router } = harness(1, true, undefined, 2);
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
      await Promise.resolve();

      expect(admission?.usage()).toEqual({ ingress: 2, egress: 2 });
      expect(reservePublication).toHaveBeenCalledTimes(attemptsBeforeRelease);
    } finally {
      await router.close();
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

  it("replaces an SFU publication through the codec-owned paused operation", async () => {
    const { store, sent, admission, roomControl, router } = harness(
      1,
      true,
      undefined,
      1,
    );
    try {
      const room = await store.createRoom();
      const host = connectHost(store, room);
      complete(router, host);
      const first = connectViewer(store, room, "codec_sfu_first");
      complete(router, first);
      await vi.waitFor(() => expect(preparedFor(sent, first.sessionId)).toBeDefined());
      const firstDirect = preparedFor(sent, first.sessionId)!;
      expect(firstDirect.candidate.codecTransition).toBeNull();
      router.handleRouteReady(first, {
        type: "route-ready",
        revision: firstDirect.revision,
        phase: "prepare",
      });

      const second = connectViewer(store, room, "codec_sfu_second");
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
      await vi.waitFor(() =>
        expect(admission?.usage()).toEqual({ ingress: 1, egress: 2 }),
      );

      const previous = router.codecRouteSnapshot(room.roomId)!;
      const previousPublication = (
        previous.targets[0]!.proofBinding as Extract<
          (typeof previous.targets)[number]["proofBinding"],
          { kind: "sfu" }
        >
      ).publicationGeneration;
      router.setPaused(room.roomId, true);
      const preparedSnapshot = await router.beginCodecSfuReplacement({
        roomId: room.roomId,
        hostSessionId: host.sessionId,
        generation: 1,
        videoCodec: "h264",
        timeoutMs: 1_000,
      });
      expect(preparedSnapshot).not.toBeNull();
      const freshTarget = preparedSnapshot!.targets.find(
        (target) => target.preparationBinding.kind === "sfu",
      )!;
      expect(freshTarget).toMatchObject({ proofReady: false });
      expect(freshTarget.preparationBinding).not.toMatchObject({
        publicationGeneration: previousPublication,
      });
      const codecPrepare = preparedFor(sent, freshTarget.viewerSessionId)!;
      expect(codecPrepare.candidate).toMatchObject({
        transport: "sfu",
        codecTransition: { generation: 1, videoCodec: "h264" },
      });
      expect(roomControl?.deleted).toContainEqual(
        expect.objectContaining({ publicationGeneration: previousPublication }),
      );
      expect(roomControl?.created).toHaveLength(2);

      expect(router.parkCodecSfuReplacement(room.roomId, 1)).toBe(true);
      const anchor =
        freshTarget.viewerPeerId === first.peerId ? first : second;
      router.handleRouteReady(anchor, {
        type: "route-ready",
        revision: codecPrepare.revision,
        phase: "prepare",
      });
      expect(
        router.codecRouteSnapshot(room.roomId)?.targets.find(
          (target) => target.viewerPeerId === anchor.peerId,
        )?.proofReady,
      ).toBe(false);

      expect(router.beginCodecSfuProof(room.roomId, 1, 1_000)).toBe(true);
      router.handleRouteReady(anchor, {
        type: "route-ready",
        revision: codecPrepare.revision,
        phase: "prepare",
      });
      await vi.waitFor(() =>
        expect(
          router.codecRouteSnapshot(room.roomId)?.targets.find(
            (target) => target.viewerPeerId === anchor.peerId,
          ),
        ).toMatchObject({ proofReady: true }),
      );
      expect(admission?.usage()).toEqual({ ingress: 1, egress: 1 });
    } finally {
      await router.close();
    }
  });

  it("waits for exact old-generation drain before codec creation even with spare ingress", async () => {
    const { store, sent, admission, roomControl, router } = harness(
      1,
      true,
      undefined,
      2,
    );
    const drain = deferred();
    try {
      const room = await store.createRoom();
      const { host } = await establishSfuRoom(store, sent, router, room);
      await vi.waitFor(() =>
        expect(admission?.usage()).toEqual({ ingress: 1, egress: 2 }),
      );
      roomControl!.deleteBarrier = drain.promise;
      router.setPaused(room.roomId, true);
      let settled = false;
      const preparation = router
        .beginCodecSfuReplacement({
          roomId: room.roomId,
          hostSessionId: host.sessionId,
          generation: 1,
          videoCodec: "h264",
          timeoutMs: 1_000,
        })
        .finally(() => {
          settled = true;
        });

      await vi.waitFor(() =>
        expect(
          (
            Reflect.get(router, "resourceWaiters") as Map<string, unknown>
          ).has(room.roomId),
        ).toBe(true),
      );
      expect(roomControl?.created).toHaveLength(1);
      expect(settled).toBe(false);

      drain.resolve();
      const snapshot = await preparation;
      expect(snapshot).not.toBeNull();
      expect(roomControl?.deleted).toHaveLength(1);
      expect(roomControl?.created).toHaveLength(2);
    } finally {
      drain.resolve();
      await router.close();
    }
  });

  it("waits for an aborted fresh codec generation to drain before rollback at ingress two", async () => {
    const { store, sent, admission, roomControl, router } = harness(
      1,
      true,
      undefined,
      2,
    );
    const forwardDrain = deferred();
    try {
      const room = await store.createRoom();
      const { host } = await establishSfuRoom(store, sent, router, room);
      router.setPaused(room.roomId, true);
      const forward = await router.beginCodecSfuReplacement({
        roomId: room.roomId,
        hostSessionId: host.sessionId,
        generation: 1,
        videoCodec: "h264",
        timeoutMs: 1_000,
      });
      expect(forward).not.toBeNull();
      expect(roomControl?.created).toHaveLength(2);

      roomControl!.deleteBarrier = forwardDrain.promise;
      router.abortCodecSfuReplacement(room.roomId, 1);
      let rollbackSettled = false;
      const rollback = router
        .beginCodecSfuReplacement({
          roomId: room.roomId,
          hostSessionId: host.sessionId,
          generation: 2,
          videoCodec: "automatic",
          timeoutMs: 1_000,
        })
        .finally(() => {
          rollbackSettled = true;
        });

      await vi.waitFor(() =>
        expect(
          (
            Reflect.get(router, "resourceWaiters") as Map<string, unknown>
          ).has(room.roomId),
        ).toBe(true),
      );
      expect(admission?.usage()).toEqual({ ingress: 1, egress: 1 });
      expect(roomControl?.created).toHaveLength(2);
      expect(rollbackSettled).toBe(false);

      forwardDrain.resolve();
      await expect(rollback).resolves.not.toBeNull();
      expect(roomControl?.created).toHaveLength(3);
    } finally {
      forwardDrain.resolve();
      await router.close();
    }
  });

  it("ignores a stale Host session failure for the current codec publication candidate", async () => {
    const { store, sent, router } = harness(1, true);
    try {
      const room = await store.createRoom();
      const { host: staleHost } = await establishSfuRoom(
        store,
        sent,
        router,
        room,
      );
      const currentHost = reconnectHost(
        store,
        room,
        "host_session_reconnected_12345678",
      );
      complete(router, currentHost);
      router.setPaused(room.roomId, true);
      const snapshot = await router.beginCodecSfuReplacement({
        roomId: room.roomId,
        hostSessionId: currentHost.sessionId,
        generation: 1,
        videoCodec: "h264",
        timeoutMs: 1_000,
      });
      expect(snapshot).not.toBeNull();
      const target = snapshot!.targets.find(
        (candidate) => candidate.preparationBinding.kind === "sfu",
      )!;
      const prepared = preparedFor(sent, target.viewerSessionId)!;

      router.handleRouteFailed(staleHost, {
        type: "route-failed",
        revision: prepared.revision,
        phase: "prepare",
        connectionId: null,
      });

      expect(router.parkCodecSfuReplacement(room.roomId, 1)).toBe(true);
      router.abortCodecSfuReplacement(room.roomId, 1);
    } finally {
      await router.close();
    }
  });

  it("wakes codec revalidation when a paused active edge fails", async () => {
    const { store, sent, onActiveRouteChanged, router } = harness(1);
    const room = await store.createRoom();
    const host = connectHost(store, room);
    complete(router, host);
    const viewer = connectViewer(store, room, "paused_hard_failure");
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
    router.setPaused(room.roomId, true);
    onActiveRouteChanged.mockClear();

    router.handleRouteFailed(viewer, {
      type: "route-failed",
      revision: prepared.revision,
      phase: "active",
      connectionId: prepared.candidate.connectionId,
    });

    expect(onActiveRouteChanged).toHaveBeenCalledTimes(1);
    expect(onActiveRouteChanged).toHaveBeenCalledWith(room.roomId);
    expect(router.codecRouteSnapshot(room.roomId)?.targets).toEqual([]);
    await router.close();
  });

  it("clears an exact drain waiter on codec abort", async () => {
    const { store, sent, roomControl, router } = harness(1, true, undefined, 2);
    const drain = deferred();
    try {
      const room = await store.createRoom();
      const { host } = await establishSfuRoom(store, sent, router, room);
      roomControl!.deleteBarrier = drain.promise;
      router.setPaused(room.roomId, true);
      const preparation = router.beginCodecSfuReplacement({
        roomId: room.roomId,
        hostSessionId: host.sessionId,
        generation: 1,
        videoCodec: "h264",
        timeoutMs: 1_000,
      });
      const waiters = Reflect.get(router, "resourceWaiters") as Map<
        string,
        unknown
      >;
      await vi.waitFor(() => expect(waiters.has(room.roomId)).toBe(true));

      router.abortCodecSfuReplacement(room.roomId, 1);
      await expect(preparation).resolves.toBeNull();
      expect(waiters.has(room.roomId)).toBe(false);
    } finally {
      drain.resolve();
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
