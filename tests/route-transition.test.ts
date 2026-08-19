import { describe, expect, it, vi } from "vitest";

import type {
  ClientMessage,
  ParticipantRouteAssignment,
} from "../src/shared/protocol.ts";
import {
  MediaRouteTransition,
  reportActivePeerRouteFailure,
} from "../src/client/media/route-transition.ts";
import { HostSfuRoute } from "../src/client/media/host-sfu-route.ts";
import { ViewerSfuRoute } from "../src/client/media/viewer-sfu-route.ts";
import { QUALITY_PROFILES } from "../src/client/media/quality.ts";

const peerAssignment = (
  parentPeerId: string,
  childPeerIds: string[] = [],
): ParticipantRouteAssignment => ({
  upstream: { kind: "peer", peerId: parentPeerId },
  childPeerIds,
  sfuPublicationGeneration: null,
});

const sfuAssignment = (childPeerIds: string[] = []): ParticipantRouteAssignment => ({
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
    connect: vi.fn(async () => {
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

interface FakeSubscriberEvents {
  onStream: (stream: MediaStream | null) => void;
  onDisconnected: () => void;
}

function createFakeSubscriber(
  events: FakeSubscriberEvents,
  log: string[],
  label: string,
) {
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

describe("MediaRouteTransition", () => {
  it("keeps current media through prepare and until an active SFU video track", () => {
    const route = new MediaRouteTransition();
    const direct = peerAssignment("host_12345678", ["child_a_12345678"]);
    const sfu = sfuAssignment(["child_a_12345678"]);

    expect(route.accept({ revision: 1, phase: "active", assignment: direct })).toBe(
      "accepted",
    );
    const directToken = route.token()!;
    expect(route.markMediaActive(directToken)).toBe(true);

    expect(route.accept({ revision: 2, phase: "prepare", assignment: sfu })).toBe(
      "accepted",
    );
    expect(route.getActiveAssignment()).toEqual(direct);
    expect(route.getMediaAssignment()).toEqual(direct);

    expect(route.accept({ revision: 2, phase: "active", assignment: sfu })).toBe(
      "accepted",
    );
    const sfuToken = route.token()!;
    expect(route.getActiveAssignment()).toEqual(sfu);
    expect(route.getMediaAssignment()).toEqual(direct);

    expect(route.markMediaActive(sfuToken)).toBe(true);
    expect(route.getMediaAssignment()).toEqual(sfu);
  });

  it("rejects stale config and async work after a rollback revision", () => {
    const route = new MediaRouteTransition();
    const sfu = sfuAssignment();
    const direct = peerAssignment("host_12345678");

    route.accept({ revision: 4, phase: "prepare", assignment: sfu });
    const staleToken = route.token()!;
    expect(route.acceptsConfig(4)).toBe(true);

    route.accept({ revision: 5, phase: "active", assignment: direct });

    expect(route.acceptsConfig(4)).toBe(false);
    expect(route.owns(staleToken)).toBe(false);
    expect(route.markMediaActive(staleToken)).toBe(false);
  });

  it("is idempotent for duplicates and rejects conflicting same revisions", () => {
    const route = new MediaRouteTransition();
    const direct = peerAssignment("host_12345678");

    expect(route.accept({ revision: 7, phase: "prepare", assignment: direct })).toBe(
      "accepted",
    );
    const token = route.token();
    expect(route.accept({ revision: 7, phase: "prepare", assignment: direct })).toBe(
      "duplicate",
    );
    expect(route.token()).toEqual(token);
    expect(
      route.accept({
        revision: 7,
        phase: "prepare",
        assignment: peerAssignment("other_12345678"),
      }),
    ).toBe("stale");
  });

  it("returns signaling failure so ViewerPeer can retry its route report", () => {
    const route = new MediaRouteTransition();
    const assignment = peerAssignment("host_12345678");
    route.accept({ revision: 9, phase: "active", assignment });
    const send = vi.fn(() => false);

    expect(
      reportActivePeerRouteFailure(
        route,
        "host_12345678",
        "connection_12345678",
        send,
      ),
    ).toBe(false);
    expect(send).toHaveBeenCalledWith({
      type: "route-failed",
      revision: 9,
      phase: "active",
      connectionId: "connection_12345678",
    });
  });
});

describe("HostSfuRoute", () => {
  it("settles authoritative activation before exposing its quality warning", async () => {
    const publisher = {
      ...createFakePublisher([], "publisher"),
      getQualityWarning: vi.fn(() => "SFU sender parameters were rewritten"),
    };
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => publisher,
    });
    const assignment = hostAssignment("generation-a");

    route.accept({ revision: 1, phase: "prepare", assignment });
    await route.acceptConfig(sfuConfig(1));
    await expect(
      route.resyncAuthoritative({ revision: 1, phase: "active", assignment }),
    ).resolves.toBe("accepted");

    expect(publisher.activate).toHaveBeenCalledOnce();
    expect(route.getQualityWarning()).toBe(
      "SFU sender parameters were rewritten",
    );
  });

  it("reports a publisher prepare failure without requesting refresh", async () => {
    const messages: ClientMessage[] = [];
    const publisher = createFakePublisher([], "publisher");
    publisher.connect.mockResolvedValue(false);
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: () => publisher,
    });

    route.accept({
      revision: 1,
      phase: "prepare",
      assignment: hostAssignment("generation-a"),
    });
    await route.acceptConfig(sfuConfig(1));

    expect(messages).toEqual([
      {
        type: "route-failed",
        revision: 1,
        phase: "prepare",
        connectionId: null,
      },
    ]);
  });

  it("never overlaps more than two host media edges while changing route kinds", async () => {
    const log: string[] = [];
    const edgeCounts: number[] = [];
    const publishers: Array<{
      connect: ReturnType<typeof vi.fn>;
      activate: ReturnType<typeof vi.fn>;
      deactivate: ReturnType<typeof vi.fn>;
      replaceStream: ReturnType<typeof vi.fn>;
      updateProfile: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    let directEdges = 0;
    let sfuEdges = 0;
    const record = (event: string) => {
      log.push(event);
      edgeCounts.push(directEdges + sfuEdges);
    };
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: (children) => {
        directEdges = children.length;
        record(`children:${children.join(",")}`);
      },
      send: () => true,
      createPublisher: () => {
        const label = `publisher-${publishers.length + 1}`;
        const publisher = {
          connect: vi.fn(async () => true),
          activate: vi.fn(async () => {
            sfuEdges = 1;
            record(`${label}:activate`);
            return true;
          }),
          deactivate: vi.fn(async () => {
            sfuEdges = 0;
            record(`${label}:deactivate`);
            return true;
          }),
          replaceStream: vi.fn(async () => true),
          updateProfile: vi.fn(async () => true),
          disconnect: vi.fn(async () => record(`${label}:disconnect`)),
        };
        publishers.push(publisher);
        return publisher;
      },
    });

    route.accept({
      revision: 1,
      phase: "active",
      assignment: hostAssignment(null, ["direct-a", "direct-b"]),
    });
    await vi.waitFor(() => expect(log).toContain("children:direct-a,direct-b"));

    const generationA = hostAssignment("generation-a", ["direct-a"]);
    route.accept({ revision: 2, phase: "prepare", assignment: generationA });
    await route.acceptConfig(sfuConfig(2));
    log.length = 0;
    route.accept({ revision: 2, phase: "active", assignment: generationA });
    await vi.waitFor(() => expect(publishers[0]?.activate).toHaveBeenCalledOnce());
    expect(log.slice(0, 2)).toEqual([
      "children:direct-a",
      "publisher-1:activate",
    ]);

    const generationB = hostAssignment("generation-b", ["direct-b"]);
    route.accept({ revision: 3, phase: "prepare", assignment: generationB });
    await route.acceptConfig(sfuConfig(3));
    log.length = 0;
    route.accept({ revision: 3, phase: "active", assignment: generationB });
    await vi.waitFor(() => expect(publishers[1]?.activate).toHaveBeenCalledOnce());
    expect(log.slice(0, 4)).toEqual([
      "children:direct-b",
      "publisher-1:deactivate",
      "publisher-1:disconnect",
      "publisher-2:activate",
    ]);

    log.length = 0;
    route.accept({
      revision: 4,
      phase: "active",
      assignment: hostAssignment(null, ["direct-a", "direct-b"]),
    });
    await vi.waitFor(() =>
      expect(log).toContain("children:direct-a,direct-b"),
    );
    expect(log.slice(0, 3)).toEqual([
      "publisher-2:deactivate",
      "publisher-2:disconnect",
      "children:direct-a,direct-b",
    ]);
    expect(Math.max(...edgeCounts)).toBeLessThanOrEqual(2);
  });

  it("serializes continuous active revisions while the old publisher retires", async () => {
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
        publishers.push(publisher);
        return publisher;
      },
    });

    const generationA = hostAssignment("generation-a", ["direct-a"]);
    route.accept({ revision: 1, phase: "prepare", assignment: generationA });
    await route.acceptConfig(sfuConfig(1));
    route.accept({ revision: 1, phase: "active", assignment: generationA });
    await vi.waitFor(() => expect(publishers[0]?.activate).toHaveBeenCalledOnce());

    let finishOldDeactivate!: () => void;
    let oldDeactivateFinished = false;
    const oldDeactivateGate = new Promise<void>((resolve) => {
      finishOldDeactivate = resolve;
    });
    publishers[0]?.deactivate.mockImplementation(async () => {
      await oldDeactivateGate;
      oldDeactivateFinished = true;
      return true;
    });

    const generationB = hostAssignment("generation-b", ["direct-b"]);
    route.accept({ revision: 2, phase: "prepare", assignment: generationB });
    await route.acceptConfig(sfuConfig(2));
    route.accept({ revision: 2, phase: "active", assignment: generationB });
    await vi.waitFor(() => expect(publishers[0]?.deactivate).toHaveBeenCalled());

    const generationC = hostAssignment("generation-c", ["direct-c"]);
    route.accept({ revision: 3, phase: "prepare", assignment: generationC });
    await route.acceptConfig(sfuConfig(3));
    route.accept({ revision: 3, phase: "active", assignment: generationC });

    expect(publishers[2]?.disconnect).not.toHaveBeenCalled();
    expect(publishers[1]?.activate).not.toHaveBeenCalled();
    expect(publishers[2]?.activate).not.toHaveBeenCalled();

    finishOldDeactivate();
    await vi.waitFor(() => expect(oldDeactivateFinished).toBe(true));
    expect(publishers[2]?.disconnect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(publishers[2]?.activate).toHaveBeenCalledOnce());
    expect(publishers[1]?.activate).not.toHaveBeenCalled();
  });

  it("releases active ownership when a published activation becomes stale", async () => {
    const streamA = {} as MediaStream;
    const streamB = {} as MediaStream;
    let currentStream = streamA;
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => currentStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
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

    const generationA = hostAssignment("generation-a");
    route.accept({ revision: 1, phase: "prepare", assignment: generationA });
    await route.acceptConfig(sfuConfig(1));

    let finishReplace!: () => void;
    const replaceGate = new Promise<void>((resolve) => {
      finishReplace = resolve;
    });
    publishers[0]?.activate.mockImplementation(async () => {
      currentStream = streamB;
      return true;
    });
    publishers[0]?.replaceStream.mockImplementation(async () => {
      await replaceGate;
      return true;
    });

    route.accept({ revision: 1, phase: "active", assignment: generationA });
    await vi.waitFor(() => expect(publishers[0]?.replaceStream).toHaveBeenCalled());

    const generationB = hostAssignment("generation-b");
    route.accept({ revision: 2, phase: "prepare", assignment: generationB });
    await route.acceptConfig(sfuConfig(2));
    finishReplace();
    await vi.waitFor(() => expect(publishers[0]?.disconnect).toHaveBeenCalled());

    await expect(
      route.updateProfile(QUALITY_PROFILES["1080p30"]),
    ).resolves.toBe(true);
    expect(publishers[0]?.updateProfile).not.toHaveBeenCalled();
    expect(publishers[1]?.disconnect).not.toHaveBeenCalled();

    route.accept({ revision: 2, phase: "active", assignment: generationB });
    await vi.waitFor(() => expect(publishers[1]?.activate).toHaveBeenCalledOnce());
  });

  it("keeps an activating publisher on a duplicate active update", async () => {
    const messages: ClientMessage[] = [];
    const publisher = createFakePublisher([], "publisher");
    let finishActivate!: () => void;
    const activateGate = new Promise<void>((resolve) => {
      finishActivate = resolve;
    });
    publisher.activate.mockImplementation(async () => {
      await activateGate;
      return true;
    });
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: () => publisher,
    });
    const assignment = hostAssignment("generation-a");

    route.accept({ revision: 1, phase: "prepare", assignment });
    await route.acceptConfig(sfuConfig(1));
    route.accept({ revision: 1, phase: "active", assignment });
    await vi.waitFor(() => expect(publisher.activate).toHaveBeenCalledOnce());

    expect(
      route.accept({ revision: 1, phase: "active", assignment }),
    ).toBe("duplicate");
    expect(publisher.activate).toHaveBeenCalledOnce();
    expect(publisher.disconnect).not.toHaveBeenCalled();

    finishActivate();
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "route-ready",
        revision: 1,
        phase: "active",
      }),
    );
    expect(publisher.disconnect).not.toHaveBeenCalled();
  });

  it("prepares without media, commits in order, and reuses a publication generation", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const stream = {} as MediaStream;
    const route = new HostSfuRoute({
      getStream: () => stream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: (children) => log.push(`children:${children.join(",")}`),
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

    const generationA = hostAssignment("generation-a", ["direct-a"]);
    route.accept({ revision: 1, phase: "prepare", assignment: generationA });
    await route.acceptConfig(sfuConfig(1));

    expect(publishers[0]?.activate).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 1,
      phase: "prepare",
    });

    route.accept({ revision: 1, phase: "active", assignment: generationA });
    await vi.waitFor(() => expect(publishers[0]?.activate).toHaveBeenCalledOnce());

    const generationB = hostAssignment("generation-b", ["direct-b"]);
    route.accept({ revision: 2, phase: "prepare", assignment: generationB });
    await route.acceptConfig(sfuConfig(2));
    expect(publishers[0]?.deactivate).not.toHaveBeenCalled();
    expect(publishers[1]?.activate).not.toHaveBeenCalled();

    log.length = 0;
    route.accept({ revision: 2, phase: "active", assignment: generationB });
    await vi.waitFor(() => expect(publishers[1]?.activate).toHaveBeenCalledOnce());
    expect(log.slice(0, 4)).toEqual([
      "children:direct-b",
      "publisher-1:deactivate",
      "publisher-1:disconnect",
      "publisher-2:activate",
    ]);

    route.accept({
      revision: 3,
      phase: "active",
      assignment: hostAssignment("generation-b", ["direct-c"]),
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "route-ready",
        revision: 3,
        phase: "active",
      }),
    );
    expect(publishers).toHaveLength(2);
    expect(publishers[1]?.deactivate).not.toHaveBeenCalled();

    route.accept({
      revision: 4,
      phase: "prepare",
      assignment: hostAssignment("generation-c"),
    });
    await route.acceptConfig(sfuConfig(4));
    route.accept({
      revision: 5,
      phase: "active",
      assignment: hostAssignment("generation-b", ["direct-c"]),
    });
    await vi.waitFor(() => expect(publishers[2]?.disconnect).toHaveBeenCalled());
    expect(publishers[1]?.deactivate).not.toHaveBeenCalled();
  });

  it("retires old media before applying a lower authoritative host revision", async () => {
    const log: string[] = [];
    const publisher = createFakePublisher(log, "publisher");
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: (children) =>
        log.push(`children:${children.join(",")}`),
      send: () => true,
      createPublisher: () => publisher,
    });

    const oldAssignment = hostAssignment("generation-old");
    route.accept({ revision: 10, phase: "prepare", assignment: oldAssignment });
    await route.acceptConfig(sfuConfig(10));
    route.accept({ revision: 10, phase: "active", assignment: oldAssignment });
    await vi.waitFor(() => expect(publisher.activate).toHaveBeenCalledOnce());

    let finishDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      finishDeactivate = resolve;
    });
    publisher.deactivate.mockImplementation(async () => {
      log.push("publisher:deactivate");
      await deactivateGate;
      return true;
    });
    log.length = 0;

    const authoritative = hostAssignment(null, ["new-child-a", "new-child-b"]);
    const resync = route.resyncAuthoritative({
      revision: 1,
      phase: "active",
      assignment: authoritative,
    });
    await vi.waitFor(() => expect(publisher.deactivate).toHaveBeenCalledOnce());
    expect(log).toEqual(["children:", "publisher:deactivate"]);

    finishDeactivate();
    await expect(resync).resolves.toBe("accepted");
    expect(log).toEqual([
      "children:",
      "publisher:deactivate",
      "publisher:disconnect",
      "children:new-child-a,new-child-b",
    ]);

    await expect(
      route.resyncAuthoritative({
        revision: 1,
        phase: "active",
        assignment: authoritative,
      }),
    ).resolves.toBe("duplicate");
    expect(publisher.disconnect).toHaveBeenCalledOnce();
  });
});

describe("ViewerSfuRoute", () => {
  it("reports a subscriber prepare failure without requesting refresh", async () => {
    const messages: ClientMessage[] = [];
    const subscriber = createFakeSubscriber(
      { onStream: () => undefined, onDisconnected: () => undefined },
      [],
      "subscriber",
    );
    subscriber.connect.mockResolvedValue(false);
    const route = new ViewerSfuRoute({
      activatePeer: () => undefined,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: () => subscriber,
    });

    route.accept({
      revision: 1,
      phase: "prepare",
      assignment: sfuAssignment(),
    });
    await route.acceptConfig(sfuConfig(1));

    expect(messages).toEqual([
      {
        type: "route-failed",
        revision: 1,
        phase: "prepare",
        connectionId: null,
      },
    ]);
  });

  it("buffers an assigned parent offer until SFU fallback retirement completes", async () => {
    const log: string[] = [];
    const bufferedSignals: string[] = [];
    const deliveredSignals: string[] = [];
    let preparedParentPeerId: string | null = null;
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute({
      activatePeer: (assignment) => {
        const peerId =
          assignment.upstream.kind === "peer"
            ? assignment.upstream.peerId
            : "none";
        log.push(`peer:${peerId}`);
        if (peerId === preparedParentPeerId) {
          deliveredSignals.push(...bufferedSignals.splice(0));
          preparedParentPeerId = null;
        }
      },
      preparePeer: (assignment) => {
        preparedParentPeerId =
          assignment?.upstream.kind === "peer"
            ? assignment.upstream.peerId
            : null;
      },
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: () => true,
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
    const sfu = sfuAssignment();

    route.accept({ revision: 1, phase: "prepare", assignment: sfu });
    await route.acceptConfig(sfuConfig(1));
    route.accept({ revision: 1, phase: "active", assignment: sfu });
    await vi.waitFor(() =>
      expect(subscribers[0]?.activate).toHaveBeenCalledOnce(),
    );
    subscribers[0]?.events.onStream({} as MediaStream);

    let finishDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      finishDisconnect = resolve;
    });
    subscribers[0]?.disconnect.mockImplementation(async () => {
      log.push("subscriber-1:disconnect");
      await disconnectGate;
    });

    log.length = 0;
    route.accept({
      revision: 2,
      phase: "active",
      assignment: peerAssignment("host-peer"),
    });
    expect(preparedParentPeerId).toBe("host-peer");
    bufferedSignals.push("early-offer");
    expect(deliveredSignals).toEqual([]);
    await vi.waitFor(() =>
      expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce(),
    );
    expect(log).toEqual([
      "subscriber-1:deactivate",
      "subscriber-1:disconnect",
    ]);

    finishDisconnect();
    await vi.waitFor(() => expect(log).toContain("peer:host-peer"));
    expect(log.slice(0, 3)).toEqual([
      "subscriber-1:deactivate",
      "subscriber-1:disconnect",
      "peer:host-peer",
    ]);
    expect(deliveredSignals).toEqual(["early-offer"]);
  });

  it("keeps peer media through prepare and switches on the first video stream callback", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const peerAssignments: ParticipantRouteAssignment[] = [];
    const streams: Array<{
      stream: MediaStream;
      initialVideoStream: boolean;
      assignment: ParticipantRouteAssignment;
    }> = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute({
      activatePeer: (assignment) => {
        peerAssignments.push(assignment);
      },
      reconcileSfuChildren: (children) => log.push(`children:${children.join(",")}`),
      onSfuStream: (stream, assignment, initialVideoStream) => {
        streams.push({ stream, assignment, initialVideoStream });
      },
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
      assignment: peerAssignment("host-peer"),
    });
    await vi.waitFor(() => expect(peerAssignments).toHaveLength(1));
    const nextAssignment = sfuAssignment(["relay-child"]);
    route.accept({ revision: 2, phase: "prepare", assignment: nextAssignment });
    await route.acceptConfig(sfuConfig(2));

    expect(peerAssignments).toHaveLength(1);
    expect(streams).toHaveLength(0);
    expect(subscribers[0]?.activate).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "prepare",
    });

    route.accept({ revision: 2, phase: "active", assignment: nextAssignment });
    await vi.waitFor(() =>
      expect(subscribers[0]?.activate).toHaveBeenCalledOnce(),
    );
    expect(streams).toHaveLength(0);
    expect(messages).not.toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "active",
    });

    const stream = {} as MediaStream;
    subscribers[0]?.events.onStream(stream);
    expect(streams).toEqual([
      { stream, assignment: nextAssignment, initialVideoStream: true },
    ]);
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "active",
    });

    route.accept({
      revision: 3,
      phase: "active",
      assignment: sfuAssignment(["other-child"]),
    });
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.deactivate).not.toHaveBeenCalled();

    route.accept({
      revision: 4,
      phase: "prepare",
      assignment: sfuAssignment(),
    });
    await route.acceptConfig(sfuConfig(4));
    route.accept({
      revision: 5,
      phase: "active",
      assignment: sfuAssignment(["other-child"]),
    });
    await vi.waitFor(() => expect(subscribers[1]?.disconnect).toHaveBeenCalled());
    expect(subscribers[0]?.deactivate).not.toHaveBeenCalled();
    expect(streams).toHaveLength(1);
  });

  it("disconnects a subscriber whose connect completes after rollback", async () => {
    let finishConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const messages: ClientMessage[] = [];
    const subscriber = {
      connect: vi.fn(async () => {
        await connectGate;
        return true;
      }),
      activate: vi.fn(() => true),
      deactivate: vi.fn(() => true),
      disconnect: vi.fn(async () => undefined),
    };
    const route = new ViewerSfuRoute({
      activatePeer: () => undefined,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: () => subscriber,
    });

    route.accept({
      revision: 10,
      phase: "prepare",
      assignment: sfuAssignment(),
    });
    const connecting = route.acceptConfig(sfuConfig(10));
    route.accept({
      revision: 11,
      phase: "active",
      assignment: peerAssignment("host-peer"),
    });
    finishConnect();
    await connecting;

    expect(subscriber.activate).not.toHaveBeenCalled();
    expect(subscriber.disconnect).toHaveBeenCalled();
    expect(messages).not.toContainEqual({
      type: "route-ready",
      revision: 10,
      phase: "prepare",
    });
  });

  it("refreshes once after terminal loss and reports a failed rebuild", async () => {
    const messages: ClientMessage[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute({
      activatePeer: () => undefined,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
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
        if (subscribers.length === 1) {
          subscriber.connect.mockResolvedValue(false);
        }
        subscribers.push(subscriber);
        return subscriber;
      },
    });
    const assignment = sfuAssignment();

    route.accept({ revision: 20, phase: "prepare", assignment });
    await route.acceptConfig(sfuConfig(20));
    route.accept({ revision: 20, phase: "active", assignment });
    await vi.waitFor(() =>
      expect(subscribers[0]?.activate).toHaveBeenCalledOnce(),
    );
    subscribers[0]?.events.onStream({} as MediaStream);
    messages.length = 0;

    subscribers[0]?.events.onDisconnected();
    expect(messages).toEqual([{ type: "refresh-sfu", revision: 20 }]);

    await route.acceptConfig(sfuConfig(20));
    expect(messages).toEqual([
      { type: "refresh-sfu", revision: 20 },
      {
        type: "route-failed",
        revision: 20,
        phase: "active",
        connectionId: null,
      },
    ]);
  });

  it("retires old media before applying a lower authoritative viewer revision", async () => {
    const log: string[] = [];
    const bufferedSignals: string[] = [];
    const deliveredSignals: string[] = [];
    let preparedParentPeerId: string | null = null;
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute({
      activatePeer: (assignment) => {
        const upstream = assignment.upstream;
        log.push(
          `peer:${upstream.kind === "peer" ? upstream.peerId : upstream.kind}`,
        );
        if (
          upstream.kind === "peer" &&
          upstream.peerId === preparedParentPeerId
        ) {
          deliveredSignals.push(...bufferedSignals.splice(0));
          preparedParentPeerId = null;
        }
      },
      preparePeer: (assignment) => {
        preparedParentPeerId =
          assignment?.upstream.kind === "peer"
            ? assignment.upstream.peerId
            : null;
      },
      resetMedia: () => log.push("reset-media"),
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: () => true,
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

    route.accept({ revision: 10, phase: "prepare", assignment: sfuAssignment() });
    await route.acceptConfig(sfuConfig(10));
    route.accept({ revision: 10, phase: "active", assignment: sfuAssignment() });
    await vi.waitFor(() =>
      expect(subscribers[0]?.activate).toHaveBeenCalledOnce(),
    );
    subscribers[0]?.events.onStream({} as MediaStream);
    log.length = 0;

    let finishDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      finishDisconnect = resolve;
    });
    subscribers[0]?.disconnect.mockImplementation(async () => {
      log.push("subscriber-1:disconnect");
      await disconnectGate;
    });

    const authoritative = peerAssignment("new-host-peer");
    const resync = route.resyncAuthoritative({
      revision: 1,
      phase: "active",
      assignment: authoritative,
    });
    expect(preparedParentPeerId).toBe("new-host-peer");
    bufferedSignals.push("early-resync-offer");
    expect(deliveredSignals).toEqual([]);
    await vi.waitFor(() =>
      expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce(),
    );
    expect(log).toEqual([
      "reset-media",
      "subscriber-1:deactivate",
      "subscriber-1:disconnect",
    ]);

    finishDisconnect();
    await expect(resync).resolves.toBe("accepted");
    expect(log).toEqual([
      "reset-media",
      "subscriber-1:deactivate",
      "subscriber-1:disconnect",
      "peer:new-host-peer",
    ]);
    expect(deliveredSignals).toEqual(["early-resync-offer"]);

    await expect(
      route.resyncAuthoritative({
        revision: 1,
        phase: "active",
        assignment: authoritative,
      }),
    ).resolves.toBe("duplicate");
    expect(subscribers[0]?.disconnect).toHaveBeenCalledOnce();
  });
});
