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
  publicationGeneration = "publication_generation_12345678",
): ParticipantRouteAssignment => ({
  upstream: { kind: "sfu" },
  childPeerIds,
  sfuPublicationGeneration: publicationGeneration,
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
  codecTransition: PreparedRouteCandidate["codecTransition"] = null,
): PreparedRouteCandidate => ({
  childPeerId,
  connectionId,
  transport,
  codecTransition,
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

  it("treats the codec transaction tag as part of exact candidate identity", () => {
    const route = new MediaRouteTransition();
    const assignment = viewerSfuAssignment();
    const tagged = candidate(
      2,
      "viewer_12345678",
      "sfu",
      "candidate_2_12345678",
      { generation: 7, videoCodec: "h264" },
    );

    expect(
      route.accept({
        revision: 2,
        phase: "prepare",
        assignment,
        candidate: tagged,
      }),
    ).toBe("accepted");
    expect(
      route.accept({
        revision: 2,
        phase: "prepare",
        assignment,
        candidate: {
          ...tagged,
          codecTransition: { generation: 8, videoCodec: "h264" },
        },
      }),
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

  it("prepares a fresh tagged SFU publisher while paused with the tagged codec", async () => {
    const messages: ClientMessage[] = [];
    const prepared: unknown[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      onCodecPublisherPrepared: (result) => prepared.push(result),
      createPublisher: () => {
        const publisher = createFakePublisher([], "codec-publisher");
        publishers.push(publisher);
        return publisher;
      },
    });

    route.setPaused(true);
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("ordinary-publication"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2));
    expect(publishers).toEqual([]);

    route.accept({
      revision: 3,
      phase: "prepare",
      assignment: hostAssignment("fresh-publication"),
      candidate: candidate(
        3,
        "viewer_12345678",
        "sfu",
        "candidate_3_12345678",
        { generation: 11, videoCodec: "h264" },
      ),
    });
    await route.acceptConfig(sfuConfig(3));

    expect(publishers).toHaveLength(1);
    expect(publishers[0]?.activate).toHaveBeenCalledWith(
      expect.anything(),
      { ...QUALITY_PROFILES["720p30"], videoCodec: "h264" },
    );
    expect(prepared).toEqual([
      {
        generation: 11,
        videoCodec: "h264",
        binding: {
          kind: "sfu",
          publicationGeneration: "fresh-publication",
        },
        accepted: true,
      },
    ]);
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);
  });

  it("reports an exact rejected binding when fresh codec publication fails", async () => {
    const prepared: unknown[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: () => true,
      onCodecPublisherPrepared: (result) => prepared.push(result),
      createPublisher: () => ({
        ...createFakePublisher([], "failed-codec-publisher"),
        activate: vi.fn(async () => false),
      }),
    });

    route.setPaused(true);
    route.accept({
      revision: 5,
      phase: "prepare",
      assignment: hostAssignment("failed-publication"),
      candidate: candidate(
        5,
        "viewer_12345678",
        "sfu",
        "candidate_5_12345678",
        { generation: 13, videoCodec: "vp8" },
      ),
    });
    await route.acceptConfig(sfuConfig(5));

    expect(prepared).toEqual([
      {
        generation: 13,
        videoCodec: "vp8",
        binding: {
          kind: "sfu",
          publicationGeneration: "failed-publication",
        },
        accepted: false,
      },
    ]);
  });

  it("reconciles paused Host active truth by exact SFU publication", async () => {
    let releaseOldPublisher!: () => void;
    const oldPublisherRetired = new Promise<void>((resolve) => {
      releaseOldPublisher = resolve;
    });
    const reconciledChildren: string[][] = [];
    const disconnectedCallbacks: Array<() => void> = [];
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: (children) => reconciledChildren.push(children),
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: (onDisconnected) => {
        disconnectedCallbacks.push(onDisconnected);
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        if (publishers.length === 0) {
          publisher.deactivate.mockImplementation(async () => {
            await oldPublisherRetired;
            return true;
          });
          publisher.disconnect.mockImplementation(async () => {
            onDisconnected();
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
    expect(publishers[0]?.disconnect).not.toHaveBeenCalled();

    const retiringOldPublication = route.acceptAndWait({
      revision: 3,
      phase: "active",
      assignment: hostAssignment(null, ["retained-child"]),
    });
    disconnectedCallbacks[0]?.();

    route.accept({
      revision: 4,
      phase: "prepare",
      assignment: hostAssignment("publication-fresh", ["retained-child"]),
      candidate: candidate(
        4,
        "viewer_12345678",
        "sfu",
        "candidate_4_12345678",
        { generation: 15, videoCodec: "vp8" },
      ),
    });
    const freshPublication = route.acceptConfig(sfuConfig(4));
    await vi.waitFor(() => expect(publishers).toHaveLength(2));
    expect(publishers[1]?.connect).toHaveBeenCalledOnce();
    expect(publishers[1]?.activate).not.toHaveBeenCalled();
    releaseOldPublisher();
    await Promise.all([retiringOldPublication, freshPublication]);
    expect(publishers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(publishers[1]?.activate).toHaveBeenCalledOnce();
    disconnectedCallbacks[0]?.();
    expect(
      messages.filter((message) => message.type === "route-failed"),
    ).toEqual([]);

    route.setPaused(false);
    await route.acceptAndWait({
      revision: 4,
      phase: "active",
      assignment: hostAssignment("publication-fresh", ["retained-child"]),
    });
    expect(publishers[1]?.disconnect).not.toHaveBeenCalled();
  });

  it("does not activate a fresh SFU publisher after its exact route becomes stale", async () => {
    let releaseOldPublisher!: () => void;
    const oldPublisherRetired = new Promise<void>((resolve) => {
      releaseOldPublisher = resolve;
    });
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => {
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        if (publishers.length === 0) {
          publisher.deactivate.mockImplementation(async () => {
            await oldPublisherRetired;
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
    route.setPaused(true);
    const retiringOldPublication = route.acceptAndWait({
      revision: 2,
      phase: "active",
      assignment: hostAssignment(null),
    });
    await vi.waitFor(() =>
      expect(publishers[0]?.deactivate).toHaveBeenCalledOnce(),
    );

    route.accept({
      revision: 3,
      phase: "prepare",
      assignment: hostAssignment("publication-fresh"),
      candidate: candidate(
        3,
        "viewer_12345678",
        "sfu",
        "candidate_3_12345678",
        { generation: 17, videoCodec: "h264" },
      ),
    });
    const freshPublication = route.acceptConfig(sfuConfig(3));
    await vi.waitFor(() => expect(publishers).toHaveLength(2));
    expect(publishers[1]?.activate).not.toHaveBeenCalled();

    const stalePublication = route.acceptAndWait({
      revision: 4,
      phase: "active",
      assignment: hostAssignment(null),
    });
    releaseOldPublisher();
    await Promise.all([
      retiringOldPublication,
      freshPublication,
      stalePublication,
    ]);

    expect(publishers[1]?.activate).not.toHaveBeenCalled();
    expect(publishers[1]?.disconnect).toHaveBeenCalledOnce();
  });

  it("rejects a tagged codec candidate that reuses the active SFU publication", async () => {
    const messages: ClientMessage[] = [];
    const prepared: unknown[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      onCodecPublisherPrepared: (result) => prepared.push(result),
      createPublisher: () => {
        const publisher = createFakePublisher([], "publisher");
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
    route.setPaused(true);
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-a"),
      candidate: candidate(
        2,
        "viewer_12345678",
        "sfu",
        "candidate_2_12345678",
        { generation: 14, videoCodec: "h264" },
      ),
    });
    await route.acceptConfig(sfuConfig(2));

    expect(publishers).toHaveLength(1);
    expect(prepared).toEqual([
      {
        generation: 14,
        videoCodec: "h264",
        binding: { kind: "sfu", publicationGeneration: "publication-a" },
        accepted: false,
      },
    ]);
    expect(messages.at(-1)).toEqual({
      type: "route-failed",
      revision: 2,
      phase: "prepare",
      connectionId: null,
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
    subscribers[0]?.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toEqual([firstStream]));

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
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

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
    subscriber.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);
  });

  it("keeps a tagged SFU subscriber while paused and waits for a post-resume frame", async () => {
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
        subscriber = createFakeSubscriber(events, [], "codec-subscriber");
        return subscriber;
      },
    });

    route.setPaused(true);
    route.accept({
      revision: 4,
      phase: "prepare",
      assignment: viewerSfuAssignment([], "fresh-publication"),
      candidate: candidate(
        4,
        "viewer_12345678",
        "sfu",
        "candidate_4_12345678",
        { generation: 12, videoCodec: "vp8" },
      ),
    });
    await route.acceptConfig(sfuConfig(4));
    expect(subscriber.connect).toHaveBeenCalledOnce();
    expect(subscriber.activate).toHaveBeenCalledOnce();
    expect(subscriber.armDecodedFrameProof).not.toHaveBeenCalled();

    subscriber.events.onStream({} as MediaStream);
    subscriber.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);

    route.setPaused(false);
    expect(subscriber.armDecodedFrameProof).toHaveBeenLastCalledWith(true);
    subscriber.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 4, phase: "prepare" },
    ]);

    route.setPaused(true);
    expect(subscriber.stopDecodedFrameProof).toHaveBeenCalled();
    subscriber.events.onFirstDecodedFrame();
    route.setPaused(false);
    expect(subscriber.armDecodedFrameProof).toHaveBeenLastCalledWith(true);
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 4, phase: "prepare" },
    ]);
    subscriber.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 4, phase: "prepare" },
      { type: "route-ready", revision: 4, phase: "prepare" },
    ]);
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

    route.accept({
      revision: 4,
      phase: "prepare",
      assignment: viewerSfuAssignment(
        ["retained-child"],
        "publication-fresh",
      ),
      candidate: candidate(
        4,
        "viewer_12345678",
        "sfu",
        "candidate_4_12345678",
        { generation: 16, videoCodec: "h264" },
      ),
    });
    await route.acceptConfig(sfuConfig(4));
    subscribers[0]?.events.onDisconnected();
    subscribers[1]?.events.onStream({} as MediaStream);
    subscribers[1]?.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([]);
    expect(
      messages.filter((message) => message.type === "route-failed"),
    ).toEqual([]);

    route.setPaused(false);
    expect(subscribers[1]?.armDecodedFrameProof).toHaveBeenLastCalledWith(true);
    subscribers[1]?.events.onFirstDecodedFrame();
    expect(messages.filter((message) => message.type === "route-ready")).toEqual([
      { type: "route-ready", revision: 4, phase: "prepare" },
    ]);
    expect(subscribers[1]?.disconnect).not.toHaveBeenCalled();
  });
});
