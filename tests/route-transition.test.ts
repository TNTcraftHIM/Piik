import { describe, expect, it, vi } from "vitest";

import type {
  ClientMessage,
  ParticipantRouteAssignment,
  PreparedRouteCandidate,
} from "../src/shared/protocol.ts";
import { HostSfuRoute } from "../src/client/media/host-sfu-route.ts";
import { QUALITY_PROFILES } from "../src/client/media/quality.ts";
import {
  exactPeerSignalOwner,
  MediaRouteTransition,
  reportActivePeerRouteFailure,
} from "../src/client/media/route-transition.ts";
import { ViewerSfuRoute } from "../src/client/media/viewer-sfu-route.ts";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
} from "../src/client/types.ts";

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
  publicationGeneration = "publication_generation_12345678",
): ParticipantRouteAssignment => ({
  upstream: { kind: "sfu" },
  childPeerIds,
  sfuPublicationGeneration: publicationGeneration,
});

const emptyViewerAssignment = (): ParticipantRouteAssignment => ({
  upstream: { kind: "none" },
  childPeerIds: [],
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
  transport: "direct" | "sfu" = "direct",
  connectionId = `candidate_${revision}_12345678`,
  qualityProbe = false,
): PreparedRouteCandidate => ({
  childPeerId,
  connectionId,
  transport,
  qualityProbe,
});

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
    armDecodedFrameProof: vi.fn((requireProgress = false) => {
      log.push(`${label}:proof:${requireProgress ? "progress" : "fresh"}`);
    }),
    stopDecodedFrameProof: vi.fn(() => {
      log.push(`${label}:proof:stop`);
    }),
    disconnect: vi.fn(async () => {
      log.push(`${label}:disconnect`);
    }),
  };
}

function receiveMetrics(
  timestampMs: number,
  overrides: Partial<ConnectionMetrics> = {},
): ConnectionMetrics {
  return {
    ...EMPTY_METRICS,
    sampleTimestampMs: timestampMs,
    sampleWindowMs: 2_000,
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 60,
    bitrateKbps: 5_000,
    intervalFramesDecoded: 120,
    intervalFreezeCount: 0,
    intervalFreezeDurationMs: 0,
    intervalPauseCount: 0,
    intervalPauseDurationMs: 0,
    ...overrides,
  };
}

describe("minimal route transition contracts", () => {
  it("rebinds Viewer route ownership before a post-restart prepare", async () => {
    const prepared: Array<{ parentPeerId: string | null; revision?: number }> = [];
    const route = new ViewerSfuRoute("viewer_old_12345678", {
      activatePeer: () => true,
      preparePeer: (assignment, revision) =>
        prepared.push({
          parentPeerId:
            assignment?.upstream.kind === "peer"
              ? assignment.upstream.peerId
              : null,
          ...(revision === undefined ? {} : { revision }),
        }),
      resetMedia: () => undefined,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: () => true,
    });
    route.accept({
      revision: 9,
      phase: "active",
      assignment: peerAssignment("old_parent_12345678"),
    });

    const resync = route.resyncAuthoritative(
      {
        revision: 0,
        phase: "active",
        assignment: emptyViewerAssignment(),
      },
      "viewer_new_12345678",
    );
    expect(
      route.accept({
        revision: 1,
        phase: "prepare",
        assignment: peerAssignment("new_parent_12345678"),
        candidate: candidate(
          1,
          "viewer_new_12345678",
          "direct",
          "post_restart_connection_12345678",
        ),
      }),
    ).toBe("accepted");
    await resync;

    expect(prepared.at(-1)).toEqual({
      parentPeerId: "new_parent_12345678",
      revision: 1,
    });
  });

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
      getVideoCodec: () => "h264",
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
    expect(publishers[0]?.activate).toHaveBeenCalledWith(
      expect.anything(),
      QUALITY_PROFILES["720p30"],
      "h264",
    );

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



  it("reconciles paused Host active truth by exact SFU publication", async () => {
    const reconciledChildren: string[][] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: (children) => reconciledChildren.push(children),
      send: () => true,
      createPublisher: () => {
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        publishers.push(publisher);
        return publisher;
      },
    });

    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication-old"),
    });
    await route.acceptConfig(sfuConfig(1));
    route.setPaused(true);

    await route.acceptAndWait({
      revision: 2,
      phase: "active",
      assignment: hostAssignment("publication-old", ["retained-child"]),
    });
    expect(publishers[0]?.disconnect).not.toHaveBeenCalled();
    expect(reconciledChildren.at(-1)).toEqual(["retained-child"]);
    expect(
      route.accept({
        revision: 2,
        phase: "active",
        assignment: hostAssignment("publication-old", ["retained-child"]),
      }),
    ).toBe("duplicate");

    await route.acceptAndWait({
      revision: 3,
      phase: "active",
      assignment: hostAssignment(null, ["retained-child"]),
    });
    expect(publishers[0]?.deactivate).toHaveBeenCalledOnce();
    expect(publishers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(reconciledChildren.at(-1)).toEqual(["retained-child"]);
  });

  it("does not activate a fresh SFU publisher after its exact route becomes stale", async () => {
    let releaseFreshPublisher!: () => void;
    const freshPublisherGate = new Promise<void>((resolve) => {
      releaseFreshPublisher = resolve;
    });
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => {
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        if (publishers.length === 1) {
          publisher.activate.mockImplementation(async () => {
            await freshPublisherGate;
            return true;
          });
        }
        publishers.push(publisher);
        return publisher;
      },
    });

    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication-old"),
    });
    await route.acceptConfig(sfuConfig(1));

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-fresh"),
      candidate: candidate(
        2,
        "viewer_12345678",
        "sfu",
        "candidate_2_12345678",
      ),
    });
    const freshPublication = route.acceptConfig(sfuConfig(2));
    await vi.waitFor(() =>
      expect(publishers[1]?.activate).toHaveBeenCalledOnce(),
    );

    const staleRoute = route.acceptAndWait({
      revision: 3,
      phase: "active",
      assignment: hostAssignment("publication-old"),
    });
    releaseFreshPublisher();
    await Promise.all([freshPublication, staleRoute]);

    expect(publishers[0]?.disconnect).not.toHaveBeenCalled();
    expect(publishers[1]?.disconnect).toHaveBeenCalled();
  });


  it("uses the subscriber first decoded frame as the only SFU prepare ready", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const streams: MediaStream[] = [];
    const decodedSamples: Array<{
      framesDecodedDelta: number | null;
      revision: number;
      mediaIdentity: string;
    }> = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      onSfuDecodedFrameSample: (
        framesDecodedDelta,
        revision,
        mediaIdentity,
      ) => decodedSamples.push({ framesDecodedDelta, revision, mediaIdentity }),
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
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([firstStream]));
    subscribers[0]?.events.onDecodedFrameSample(3);
    expect(decodedSamples).toEqual([
      {
        framesDecodedDelta: 3,
        revision: 1,
        mediaIdentity: expect.stringContaining("publication_generation_12345678:"),
      },
    ]);

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment([], "publication-generation-2"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2));
    const pendingStream = {} as MediaStream;
    subscribers[1]?.events.onStream(pendingStream);
    subscribers[1]?.events.onStats?.({
      intervalFramesDecoded: 2,
    } as ConnectionMetrics);
    subscribers[1]?.events.onDecodedFrameSample(null);
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);
    expect(decodedSamples).toHaveLength(1);

    subscribers[1]?.events.onFirstDecodedFrame();
    subscribers[1]?.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 2, phase: "prepare" },
    ]);
    expect(streams).toEqual([firstStream]);

    route.accept({
      revision: 2,
      phase: "active",
      assignment: viewerSfuAssignment([], "publication-generation-2"),
    });
    await vi.waitFor(() => expect(streams).toEqual([firstStream, pendingStream]));
    subscribers[1]?.events.onDecodedFrameSample(null);
    subscribers[0]?.events.onDecodedFrameSample(9);
    expect(decodedSamples).toHaveLength(2);
    expect(decodedSamples[1]).toMatchObject({
      framesDecodedDelta: null,
      revision: 2,
    });
    expect(decodedSamples[1]!.mediaIdentity).not.toBe(
      decodedSamples[0]!.mediaIdentity,
    );
    expect(subscribers[0]?.deactivate).toHaveBeenCalledOnce();
    expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a quality SFU candidate pending until three non-regressing windows", async () => {
    const messages: ClientMessage[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    let currentMetrics = receiveMetrics(1_000);
    let qualityProbeEligible = true;
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      currentPeerMetrics: () => currentMetrics,
      qualityProbeEligible: () => qualityProbeEligible,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(
          events,
          [],
          `subscriber-${subscribers.length + 1}`,
        );
        subscribers.push(subscriber);
        return subscriber;
      },
    });

    route.accept({
      revision: 1,
      phase: "active",
      assignment: peerAssignment("parent_12345678"),
    });
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment(),
      candidate: candidate(
        2,
        "viewer_12345678",
        "sfu",
        "candidate_2_12345678",
        true,
      ),
    });
    await route.acceptConfig(sfuConfig(2));
    const subscriber = subscribers[0]!;
    subscriber.events.onStream({} as MediaStream);
    subscriber.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

    for (const timestampMs of [1_100, 3_100]) {
      currentMetrics = receiveMetrics(timestampMs - 100);
      subscriber.events.onStats(receiveMetrics(timestampMs));
    }
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

    qualityProbeEligible = false;
    for (const timestampMs of [5_100, 7_100, 9_100]) {
      currentMetrics = receiveMetrics(timestampMs - 100);
      subscriber.events.onStats(receiveMetrics(timestampMs));
    }
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

    qualityProbeEligible = true;
    for (const timestampMs of [11_100, 13_100, 15_100]) {
      currentMetrics = receiveMetrics(timestampMs - 100);
      subscriber.events.onStats(receiveMetrics(timestampMs));
    }
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 2, phase: "prepare" },
    ]);
  });

  it("rejects a quality SFU candidate after three comparable regressions", async () => {
    const messages: ClientMessage[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    let currentMetrics = receiveMetrics(1_000);
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      currentPeerMetrics: () => currentMetrics,
      qualityProbeEligible: () => true,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(events, [], "candidate");
        subscribers.push(subscriber);
        return subscriber;
      },
    });

    route.accept({
      revision: 1,
      phase: "active",
      assignment: peerAssignment("parent_12345678"),
    });
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment(),
      candidate: candidate(
        2,
        "viewer_12345678",
        "sfu",
        "candidate_2_12345678",
        true,
      ),
    });
    await route.acceptConfig(sfuConfig(2));
    const subscriber = subscribers[0]!;
    subscriber.events.onStream({} as MediaStream);
    subscriber.events.onFirstDecodedFrame();

    for (const timestampMs of [1_100, 3_100, 5_100]) {
      currentMetrics = receiveMetrics(timestampMs - 100);
      subscriber.events.onStats(
        receiveMetrics(timestampMs, { framesPerSecond: 30 }),
      );
    }

    expect(messages.at(-1)).toEqual({
      type: "route-failed",
      revision: 2,
      phase: "prepare",
      connectionId: null,
    });
    expect(subscriber.disconnect).toHaveBeenCalledOnce();
    expect(
      messages.filter((message) => message.type === "route-ready"),
    ).toEqual([]);
  });

  it("reconnects only the active SFU subscriber on the current route", async () => {
    const messages: ClientMessage[] = [];
    const streams: MediaStream[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const resetMedia = vi.fn();
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      resetMedia,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(
          events,
          [],
          `subscriber-${subscribers.length + 1}`,
        );
        subscribers.push(subscriber);
        return subscriber;
      },
    });

    route.accept({
      revision: 7,
      phase: "active",
      assignment: viewerSfuAssignment(),
    });
    await route.acceptConfig(sfuConfig(7));
    const firstStream = {} as MediaStream;
    subscribers[0]?.events.onStream(firstStream);
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([firstStream]));

    expect(route.reconnectActive()).toBe(true);
    expect(route.reconnectActive()).toBe(false);
    await vi.waitFor(() =>
      expect(messages.at(-1)).toEqual({ type: "refresh-sfu", revision: 7 }),
    );
    expect(resetMedia).not.toHaveBeenCalled();
    expect(subscribers[0]?.deactivate).not.toHaveBeenCalled();
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();

    await route.acceptConfig({ ...sfuConfig(7), token: "fresh-token" });
    const nextStream = {} as MediaStream;
    subscribers[1]?.events.onStream(nextStream);
    subscribers[1]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([firstStream, nextStream]));
    expect(subscribers[1]?.connect).toHaveBeenCalledWith({
      url: "wss://sfu.example.test",
      token: "fresh-token",
    });
    expect(subscribers[0]?.deactivate).toHaveBeenCalledOnce();
    expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce();
    await route.disconnect();
  });

  it("keeps an active SFU subscriber across same-publication resync", async () => {
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const streams: MediaStream[] = [];
    const resetMedia = vi.fn();
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      resetMedia,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      send: () => true,
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(events, [], "active");
        subscribers.push(subscriber);
        return subscriber;
      },
    });
    const assignment = viewerSfuAssignment();
    route.accept({ revision: 7, phase: "active", assignment });
    await route.acceptConfig(sfuConfig(7));
    const initialStream = {} as MediaStream;
    subscribers[0]?.events.onStream(initialStream);
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([initialStream]));

    await expect(
      route.resyncAuthoritative(
        { revision: 8, phase: "active", assignment },
        "viewer_12345678",
      ),
    ).resolves.toBe("accepted");
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.deactivate).not.toHaveBeenCalled();
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();
    expect(resetMedia).not.toHaveBeenCalled();
    await route.disconnect();
  });

  it("retargets manual SFU recovery after an unrelated room revision", async () => {
    const messages: ClientMessage[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const streams: MediaStream[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(events, [], "active");
        subscribers.push(subscriber);
        return subscriber;
      },
    });
    const assignment = viewerSfuAssignment();
    route.accept({ revision: 7, phase: "active", assignment });
    await route.acceptConfig(sfuConfig(7));
    const initialStream = {} as MediaStream;
    subscribers[0]?.events.onStream(initialStream);
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([initialStream]));
    messages.length = 0;
    expect(route.reconnectActive()).toBe(true);

    route.accept({ revision: 8, phase: "active", assignment });
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.type === "refresh-sfu"),
      ).toEqual([
        { type: "refresh-sfu", revision: 7 },
        { type: "refresh-sfu", revision: 8 },
      ]),
    );
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();
    await route.disconnect();
  });

  it("keeps an in-flight SFU recovery across an unrelated room revision", async () => {
    let releaseRecovery!: (connected: boolean) => void;
    const recoveryConnected = new Promise<boolean>((resolve) => {
      releaseRecovery = resolve;
    });
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const streams: MediaStream[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      send: () => true,
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(events, [], "subscriber");
        if (subscribers.length === 1) {
          subscriber.connect.mockImplementation(() => recoveryConnected);
        }
        subscribers.push(subscriber);
        return subscriber;
      },
    });
    const assignment = viewerSfuAssignment();
    route.accept({ revision: 7, phase: "active", assignment });
    await route.acceptConfig(sfuConfig(7));
    const initialStream = {} as MediaStream;
    subscribers[0]?.events.onStream(initialStream);
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([initialStream]));

    expect(route.reconnectActive()).toBe(true);
    const recovery = route.acceptConfig({
      ...sfuConfig(7),
      token: "recovery-token",
    });
    await vi.waitFor(() => expect(subscribers).toHaveLength(2));
    route.accept({ revision: 8, phase: "active", assignment });
    expect(subscribers).toHaveLength(2);
    expect(subscribers[1]?.disconnect).not.toHaveBeenCalled();

    releaseRecovery(true);
    await recovery;
    const recoveredStream = {} as MediaStream;
    subscribers[1]?.events.onStream(recoveredStream);
    subscribers[1]?.events.onFirstDecodedFrame();
    await vi.waitFor(() =>
      expect(streams).toEqual([initialStream, recoveredStream]),
    );
    expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce();
    await route.disconnect();
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
    subscriber.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);
  });


  it("retires only an unreferenced paused Viewer SFU slot", async () => {
    const messages: ClientMessage[] = [];
    const activatedPeers: ParticipantRouteAssignment[] = [];
    const activatedChildren: string[][] = [];
    const streams: MediaStream[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: (assignment) => {
        activatedPeers.push(assignment);
        return true;
      },
      activateChildren: (children) => activatedChildren.push([...children]),
      onSfuStream: (stream) => streams.push(stream),
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(
          events,
          [],
          `subscriber-${subscribers.length + 1}`,
        );
        subscribers.push(subscriber);
        return subscriber;
      },
    });

    route.accept({
      revision: 1,
      phase: "active",
      assignment: viewerSfuAssignment([], "publication-old"),
    });
    await route.acceptConfig(sfuConfig(1));
    const oldStream = {} as MediaStream;
    subscribers[0]?.events.onStream(oldStream);
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([oldStream]));
    route.setPaused(true);

    route.accept({
      revision: 2,
      phase: "active",
      assignment: viewerSfuAssignment(
        ["retained-child"],
        "publication-old",
      ),
    });
    await vi.waitFor(() =>
      expect(activatedChildren.at(-1)).toEqual(["retained-child"]),
    );
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();
    expect(
      route.accept({
        revision: 2,
        phase: "active",
        assignment: viewerSfuAssignment(
          ["retained-child"],
          "publication-old",
        ),
      }),
    ).toBe("duplicate");
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();

    route.accept({
      revision: 3,
      phase: "active",
      assignment: peerAssignment("retained-parent", ["retained-child"]),
    });
    await vi.waitFor(() =>
      expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce(),
    );
    expect(activatedPeers.at(-1)).toEqual(
      peerAssignment("retained-parent", ["retained-child"]),
    );
  });
});
