import { describe, expect, it, vi } from "vitest";

import type {
  ClientMessage,
  ParticipantRouteAssignment,
} from "../src/shared/protocol.ts";
import { HostSfuRoute } from "../src/client/media/host-sfu-route.ts";
import { QUALITY_PROFILES } from "../src/client/media/quality.ts";
import {
  exactPeerSignalOwner,
  MediaRouteTransition,
  reportActivePeerRouteFailure,
} from "../src/client/media/route-transition.ts";
import { ViewerSfuRoute } from "../src/client/media/viewer-sfu-route.ts";
import type { ConnectionMetrics } from "../src/client/types.ts";

const peerAssignment = (
  parentPeerId: string,
  childPeerIds: string[] = [],
): ParticipantRouteAssignment => ({
  upstream: { kind: "peer", peerId: parentPeerId },
  childPeerIds,
  sfuPublicationGeneration: null,
});

const viewerSfuAssignment = (
  childPeerIds: string[] = [],
): ParticipantRouteAssignment => ({
  upstream: { kind: "sfu" },
  childPeerIds,
  sfuPublicationGeneration: null,
});

const hostAssignment = (
  publicationGeneration: string | null,
  childPeerIds: string[] = [],
): ParticipantRouteAssignment => ({
  upstream: { kind: "none" },
  childPeerIds,
  sfuPublicationGeneration: publicationGeneration,
});

function sfuConfig(revision: number) {
  return {
    type: "sfu-config" as const,
    revision,
    url: "wss://sfu.example.test",
    token: `token-${revision}`,
  };
}

function createFakePublisher(log: string[], label: string) {
  return {
    connect: vi.fn(async (_config: unknown) => {
      log.push(`${label}:connect`);
      return true;
    }),
    activate: vi.fn(async () => {
      log.push(`${label}:activate`);
      return true;
    }),
    deactivate: vi.fn(async () => {
      log.push(`${label}:deactivate`);
      return true;
    }),
    replaceStream: vi.fn(async () => true),
    updateProfile: vi.fn(async () => true),
    disconnect: vi.fn(async () => {
      log.push(`${label}:disconnect`);
    }),
  };
}

type SubscriberEvents = Parameters<
  NonNullable<ConstructorParameters<typeof ViewerSfuRoute>[1]["createSubscriber"]>
>[0];

const candidate = (
  revision: number,
  childPeerId = "viewer_12345678",
  transport: "direct" | "selected-turn" | "sfu" = "direct",
  connectionId = `candidate_${revision}_12345678`,
) => ({ childPeerId, connectionId, transport });

function createFakeSubscriber(events: SubscriberEvents, log: string[], label: string) {
  return {
    events,
    connect: vi.fn(async () => {
      log.push(`${label}:connect`);
      return true;
    }),
    activate: vi.fn(() => {
      log.push(`${label}:activate`);
      return true;
    }),
    deactivate: vi.fn(() => {
      log.push(`${label}:deactivate`);
      return true;
    }),
    disconnect: vi.fn(async () => {
      log.push(`${label}:disconnect`);
    }),
  };
}

describe("minimal route transition contracts", () => {
  it("keeps old media through prepare and commits only exact active authority", () => {
    const route = new MediaRouteTransition();
    const oldAssignment = peerAssignment("old-parent");
    const nextAssignment = peerAssignment("next-parent");

    route.accept({ revision: 1, phase: "active", assignment: oldAssignment });
    const oldToken = route.token()!;
    expect(route.markMediaActive(oldToken)).toBe(true);

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: nextAssignment,
      candidate: candidate(2),
    });
    expect(route.getMediaAssignment()).toEqual(oldAssignment);
    expect(route.markMediaActive(route.token()!)).toBe(false);

    route.accept({ revision: 2, phase: "active", assignment: nextAssignment });
    expect(route.markMediaActive(route.token()!)).toBe(true);
    expect(route.getMediaAssignment()).toEqual(nextAssignment);
    expect(
      route.accept({ revision: 1, phase: "active", assignment: oldAssignment }),
    ).toBe("stale");
  });

  it("keeps duplicate peer prepare idempotent and releases it before takeover", async () => {
    const prepared: Array<{ parentPeerId: string | null; revision?: number }> = [];
    const activatePeer = vi.fn(() => true);
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer,
      preparePeer: (assignment, revision) =>
        prepared.push({
          parentPeerId:
            assignment?.upstream.kind === "peer"
              ? assignment.upstream.peerId
              : null,
          ...(revision === undefined ? {} : { revision }),
        }),
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: () => true,
    });
    const oldAssignment = peerAssignment("old-parent");
    const nextAssignment = peerAssignment("next-parent");

    route.accept({ revision: 1, phase: "active", assignment: oldAssignment });
    await vi.waitFor(() => expect(activatePeer).toHaveBeenCalled());
    prepared.length = 0;

    expect(
      route.accept({
        revision: 2,
        phase: "prepare",
        assignment: nextAssignment,
        candidate: candidate(2),
      }),
    ).toBe("accepted");
    expect(prepared).toEqual([
      { parentPeerId: "next-parent", revision: 2 },
    ]);

    expect(
      route.accept({
        revision: 2,
        phase: "prepare",
        assignment: nextAssignment,
        candidate: candidate(2),
      }),
    ).toBe("duplicate");
    expect(prepared).toEqual([
      { parentPeerId: "next-parent", revision: 2 },
    ]);

    route.accept({
      revision: 3,
      phase: "prepare",
      assignment: peerAssignment("third-parent"),
      candidate: candidate(3),
    });
    expect(prepared.slice(-2)).toEqual([
      { parentPeerId: null },
      { parentPeerId: "third-parent", revision: 3 },
    ]);

    route.accept({
      revision: 4,
      phase: "prepare",
      assignment: viewerSfuAssignment(),
      candidate: candidate(4, "viewer_12345678", "sfu"),
    });
    expect(prepared.at(-1)).toEqual({ parentPeerId: null });
  });

  it("routes same-parent overlap signals only by exact connection identity", () => {
    expect(exactPeerSignalOwner("pending", "pending", "active")).toBe(
      "pending",
    );
    expect(exactPeerSignalOwner("active", "pending", "active")).toBe(
      "active",
    );
    expect(exactPeerSignalOwner("unknown", "pending", "active")).toBeNull();
  });

  it("reports only the exact active peer failure", () => {
    const route = new MediaRouteTransition();
    const sent: ClientMessage[] = [];
    route.accept({
      revision: 4,
      phase: "active",
      assignment: peerAssignment("parent"),
    });

    expect(
      reportActivePeerRouteFailure(route, "other", "connection", (message) => {
        sent.push(message);
        return true;
      }),
    ).toBe(true);
    expect(sent).toEqual([]);

    reportActivePeerRouteFailure(route, "parent", "connection", (message) => {
      sent.push(message);
      return true;
    });
    expect(sent).toEqual([
      {
        type: "route-failed",
        revision: 4,
        phase: "active",
        connectionId: "connection",
      },
    ]);
  });

  it("publishes SFU media during prepare and promotes before retiring old media", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: () => {
        const publisher = createFakePublisher(
          log,
          `publisher-${publishers.length + 1}`,
        );
        publishers.push(publisher);
        return publisher;
      },
    });

    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication-a"),
    });
    await route.acceptConfig(sfuConfig(1));
    expect(publishers[0]?.activate).toHaveBeenCalledOnce();

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-b"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2));
    expect(publishers[1]?.activate).toHaveBeenCalledOnce();
    expect(publishers[0]?.deactivate).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

    await route.acceptAndWait({
      revision: 2,
      phase: "active",
      assignment: hostAssignment("publication-b"),
    });
    expect(publishers[0]?.deactivate).toHaveBeenCalledOnce();
    expect(publishers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(publishers[1]?.disconnect).not.toHaveBeenCalled();
  });

  it("replaces one pending Host publication with selected TURN transport", async () => {
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => {
        const publisher = createFakePublisher([], `publisher-${publishers.length + 1}`);
        publishers.push(publisher);
        return publisher;
      },
    });

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-b"),
      candidate: candidate(
        2,
        "viewer_12345678",
        "sfu",
        "selected-connection",
      ),
    });
    expect(
      route.startSelectedEdgeTurn({
        type: "selected-edge-turn",
        edgeKind: "host-sfu-ingress",
        revision: 2,
        hostPeerId: "host_12345678",
        publicationGeneration: "publication-b",
        oldConnectionId: "publication-b",
        newConnectionId: "selected-connection",
        expiresAt: "2099-01-01T00:00:00.000Z",
        iceServer: {
          urls: ["turn:turn.example.test:3478?transport=udp"],
          username: "1787230000:opaque_identity_12345678",
          credential: "short-lived-credential",
        },
      }),
    ).toBe(true);
    await route.acceptConfig(sfuConfig(2));

    await vi.waitFor(() => expect(publishers).toHaveLength(1));
    expect(publishers[0]?.connect).toHaveBeenCalledWith({
      url: "wss://sfu.example.test",
      token: "token-2",
      rtcConfig: {
        iceServers: [
          {
            urls: ["turn:turn.example.test:3478?transport=udp"],
            username: "1787230000:opaque_identity_12345678",
            credential: "short-lived-credential",
          },
        ],
        iceTransportPolicy: "relay",
      },
    });
  });

  it("uses the subscriber first decoded frame as the only SFU prepare ready", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const streams: MediaStream[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(
          events,
          log,
          `subscriber-${subscribers.length + 1}`,
        );
        subscribers.push(subscriber);
        return subscriber;
      },
    });

    route.accept({
      revision: 1,
      phase: "active",
      assignment: viewerSfuAssignment(),
    });
    await route.acceptConfig(sfuConfig(1));
    const firstStream = {} as MediaStream;
    subscribers[0]?.events.onStream(firstStream);
    subscribers[0]?.events.onStats?.({
      intervalFramesDecoded: 1,
    } as ConnectionMetrics);
    await vi.waitFor(() => expect(streams).toEqual([firstStream]));

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment(),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2));
    const pendingStream = {} as MediaStream;
    subscribers[1]?.events.onStream(pendingStream);
    subscribers[1]?.events.onStats?.({
      intervalFramesDecoded: 0,
    } as ConnectionMetrics);
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

    subscribers[1]?.events.onStats?.({
      intervalFramesDecoded: 2,
    } as ConnectionMetrics);
    subscribers[1]?.events.onStats?.({
      intervalFramesDecoded: 3,
    } as ConnectionMetrics);
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 2, phase: "prepare" },
    ]);
    expect(streams).toEqual([firstStream]);

    route.accept({
      revision: 2,
      phase: "active",
      assignment: viewerSfuAssignment(),
    });
    await vi.waitFor(() => expect(streams).toEqual([firstStream, pendingStream]));
    expect(subscribers[0]?.deactivate).toHaveBeenCalledOnce();
    expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("discards a paused pending subscriber and ignores its later evidence", async () => {
    const messages: ClientMessage[] = [];
    let subscriber!: ReturnType<typeof createFakeSubscriber>;
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        subscriber = createFakeSubscriber(events, [], "pending");
        return subscriber;
      },
    });

    route.accept({
      revision: 3,
      phase: "prepare",
      assignment: viewerSfuAssignment(),
      candidate: candidate(3, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(3));
    route.setPaused(true);
    expect(subscriber.disconnect).toHaveBeenCalledOnce();

    subscriber.events.onStream({} as MediaStream);
    subscriber.events.onStats?.({
      intervalFramesDecoded: 4,
    } as ConnectionMetrics);
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);
  });
});
