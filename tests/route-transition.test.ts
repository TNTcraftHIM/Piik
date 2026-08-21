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

function hostSfuIngressGrant(newConnectionId = "selected-connection-new") {
  return {
    type: "selected-edge-turn" as const,
    edgeKind: "host-sfu-ingress" as const,
    revision: 1,
    hostPeerId: "host_12345678",
    publicationGeneration: "generation-a",
    oldConnectionId: "generation-a",
    newConnectionId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    iceServer: {
      urls: ["turn:turn.example.test:3478?transport=udp"] as [string],
      username: "1787230000:opaque_identity_12345678",
      credential: "short-lived-credential",
    },
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
  onVideoAvailability?: (available: boolean) => void;
  onStats?: (metrics: ConnectionMetrics) => void;
  onState?: (state: "connected" | "reconnecting") => void;
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

async function activateViewerSfuRoute(
  events: ConstructorParameters<typeof ViewerSfuRoute>[0],
  log: string[] = [],
) {
  let subscriber!: ReturnType<typeof createFakeSubscriber>;
  const route = new ViewerSfuRoute({
    ...events,
    createSubscriber: (subscriberEvents) => {
      subscriber = createFakeSubscriber(subscriberEvents, log, "subscriber");
      return subscriber;
    },
  });
  route.accept({ revision: 1, phase: "prepare", assignment: sfuAssignment() });
  await route.acceptConfig(sfuConfig(1));
  route.accept({ revision: 1, phase: "active", assignment: sfuAssignment() });
  await vi.waitFor(() => expect(subscriber.activate).toHaveBeenCalledOnce());
  subscriber.events.onStream({} as MediaStream);
  return { route, subscriber };
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

    expect(
      route.accept({ revision: 4, phase: "active", assignment: sfu }),
    ).toBe("stale");
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
  it("exposes only current active publication stats and clears retired evidence", async () => {
    const updates: Array<
      Parameters<NonNullable<ConstructorParameters<typeof HostSfuRoute>[0]["onPublisherUpdate"]>>[0]
    > = [];
    const statsCallbacks: Array<(metrics: ConnectionMetrics | null) => void> = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: () => true,
      onPublisherUpdate: (snapshot) => updates.push(snapshot),
      createPublisher: (_onDisconnected, onStats) => {
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        publishers.push(publisher);
        statsCallbacks.push(onStats);
        return publisher;
      },
    });
    const metrics = {
      ...EMPTY_METRICS,
      trackIdentifier: "screen-a",
      framesPerSecond: 60,
    };
    const generationA = hostAssignment("generation-a");
    route.accept({ revision: 1, phase: "prepare", assignment: generationA });
    await route.acceptConfig(sfuConfig(1));
    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: generationA,
    });

    statsCallbacks[0]?.(metrics);
    expect(updates.at(-1)).toMatchObject({
      metrics: { trackIdentifier: "screen-a", framesPerSecond: 60 },
    });

    const generationB = hostAssignment("generation-b");
    route.accept({ revision: 2, phase: "prepare", assignment: generationB });
    await route.acceptConfig(sfuConfig(2));
    await route.acceptAndWait({
      revision: 2,
      phase: "active",
      assignment: generationB,
    });
    expect(updates.at(-1)).toBeNull();

    statsCallbacks[0]?.({ ...metrics, framesPerSecond: 1 });
    expect(updates.at(-1)).toBeNull();
    statsCallbacks[1]?.({
      ...metrics,
      trackIdentifier: "screen-b",
      framesPerSecond: 30,
    });
    expect(updates.at(-1)).toMatchObject({
      metrics: { trackIdentifier: "screen-b", framesPerSecond: 30 },
    });

    await route.resyncAuthoritative({
      revision: 1,
      phase: "active",
      assignment: hostAssignment(null),
    });
    expect(updates.at(-1)).toBeNull();
  });

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

  it("reports the pending peer revision when the active publisher fails", async () => {
    const messages: ClientMessage[] = [];
    const publisher = createFakePublisher([], "publisher");
    let disconnectActive!: () => void;
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: (onDisconnected) => {
        disconnectActive = onDisconnected;
        return publisher;
      },
    });
    const active = hostAssignment("generation-a");
    route.accept({ revision: 1, phase: "prepare", assignment: active });
    await route.acceptConfig(sfuConfig(1));
    route.accept({ revision: 1, phase: "active", assignment: active });
    await vi.waitFor(() => expect(publisher.activate).toHaveBeenCalledOnce());

    messages.length = 0;
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment(null, ["viewer-root"]),
    });
    disconnectActive();

    expect(messages).toEqual([{
      type: "route-failed",
      revision: 2,
      phase: "prepare",
      connectionId: null,
    }]);
  });

  it("reports the selected ingress connection when it fails during peer prepare", async () => {
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const failures: Array<() => void> = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: (onDisconnected) => {
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        publishers.push(publisher);
        failures.push(onDisconnected);
        return publisher;
      },
    });
    const active = hostAssignment("generation-a");
    route.accept({ revision: 1, phase: "prepare", assignment: active });
    await route.acceptConfig(sfuConfig(1));
    route.accept({ revision: 1, phase: "active", assignment: active });
    await vi.waitFor(() => expect(publishers[0]?.activate).toHaveBeenCalledOnce());
    failures[0]();
    messages.length = 0;

    expect(route.startSelectedEdgeTurn(hostSfuIngressGrant())).toBe(true);
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "route-ready",
        revision: 1,
        phase: "active",
      }),
    );
    messages.length = 0;
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment(null, ["viewer-root"]),
    });
    failures[1]();

    expect(messages).toEqual([{
      type: "route-failed",
      revision: 2,
      phase: "prepare",
      connectionId: "selected-connection-new",
    }]);
  });

  it("applies a host-SFU selected grant only to a relay-only publisher", async () => {
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const failures: Array<() => void> = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: (onDisconnected) => {
        const publisher = createFakePublisher([], `publisher-${publishers.length + 1}`);
        publishers.push(publisher);
        failures.push(onDisconnected);
        if (publishers.length === 1) {
          publisher.connect.mockResolvedValue(false);
        }
        return publisher;
      },
    });
    const assignment = hostAssignment("generation-a");
    route.accept({ revision: 1, phase: "prepare", assignment });
    await route.acceptConfig(sfuConfig(1));
    expect(messages).toContainEqual({
      type: "route-failed",
      revision: 1,
      phase: "prepare",
      connectionId: null,
    });

    expect(
      route.startSelectedEdgeTurn(hostSfuIngressGrant()),
    ).toBe(true);
    await vi.waitFor(() => expect(publishers).toHaveLength(2));
    expect(publishers[1].connect).toHaveBeenCalledWith({
      url: "wss://sfu.example.test",
      token: "token-1",
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
    expect(failures).toHaveLength(2);
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 1,
      phase: "prepare",
    });
  });

  it("identifies a failed selected ingress retry by its new connection", async () => {
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
        const publisher = createFakePublisher([], `publisher-${publishers.length + 1}`);
        publisher.connect.mockResolvedValue(false);
        publishers.push(publisher);
        return publisher;
      },
    });

    route.accept({
      revision: 1,
      phase: "prepare",
      assignment: hostAssignment("generation-a"),
    });
    await route.acceptConfig(sfuConfig(1));
    expect(route.startSelectedEdgeTurn(hostSfuIngressGrant())).toBe(true);

    await vi.waitFor(() => expect(publishers).toHaveLength(2));
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "route-failed",
        revision: 1,
        phase: "prepare",
        connectionId: "selected-connection-new",
      }),
    );
  });

  it("surfaces a bounded publisher stage after active fallback fails", async () => {
    const publisher = {
      ...createFakePublisher([], "publisher"),
      getFailureStage: vi.fn(() => "video-publish" as const),
    };
    publisher.activate.mockResolvedValue(false);
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
    await route.acceptAndWait({ revision: 1, phase: "active", assignment });

    expect(route.getQualityWarning()).toBe(
      "SFU 视频发布失败，已启动自动恢复",
    );

    route.accept({
      revision: 2,
      phase: "active",
      assignment: hostAssignment(null),
    });
    expect(route.getQualityWarning()).toBeNull();
  });

  it("clears a prior failure when authoritative state replaces the revision", async () => {
    const publisher = {
      ...createFakePublisher([], "publisher"),
      getFailureStage: vi.fn(() => "transport" as const),
    };
    publisher.activate.mockResolvedValue(false);
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => publisher,
    });
    const failedAssignment = hostAssignment("generation-a");

    route.accept({ revision: 1, phase: "prepare", assignment: failedAssignment });
    await route.acceptConfig(sfuConfig(1));
    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: failedAssignment,
    });
    expect(route.getQualityWarning()).toBe(
      "SFU 传输失败，已启动自动恢复",
    );

    await route.resyncAuthoritative({
      revision: 1,
      phase: "active",
      assignment: hostAssignment(null),
    });
    expect(route.getQualityWarning()).toBeNull();
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

  it("reports the pending peer revision when the active subscriber fails", async () => {
    const messages: ClientMessage[] = [];
    const { route, subscriber } = await activateViewerSfuRoute({
      activatePeer: () => undefined,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
    });

    messages.length = 0;
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: peerAssignment("host-peer"),
    });
    subscriber.events.onDisconnected();

    expect(messages).toEqual([{
      type: "route-failed",
      revision: 2,
      phase: "prepare",
      connectionId: null,
    }]);
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

  it("promotes a proven peer probe before retiring active SFU media", async () => {
    const log: string[] = [];
    let probeReady = false;
    const prepared: Array<{ parent: string | null; revision?: number }> = [];
    const activatePeer = vi.fn(
      async (assignment: ParticipantRouteAssignment, revision?: number) => {
        const parent = assignment.upstream.kind === "peer"
          ? assignment.upstream.peerId
          : assignment.upstream.kind;
        log.push(`peer:${parent}:${revision ?? "active"}`);
        return revision === undefined ? undefined : probeReady;
      },
    );
    const { route, subscriber } = await activateViewerSfuRoute({
      activatePeer,
      preparePeer: (assignment, revision) => prepared.push({
        parent: assignment?.upstream.kind === "peer"
          ? assignment.upstream.peerId
          : null,
        ...(revision === undefined ? {} : { revision }),
      }),
      reconcileSfuChildren: (children) => log.push(`children:${children.join(",")}`),
      onSfuStream: () => undefined,
      send: () => true,
    }, log);
    log.length = 0;

    const peer = peerAssignment("host-peer", ["relay-child"]);
    route.accept({ revision: 2, phase: "prepare", assignment: peer });
    expect(prepared).toContainEqual({ parent: "host-peer", revision: 2 });
    expect(log).toContain("children:relay-child");
    expect(subscriber.deactivate).not.toHaveBeenCalled();

    route.accept({ revision: 2, phase: "active", assignment: peer });
    await vi.waitFor(() => expect(activatePeer).toHaveBeenCalledWith(peer, 2));
    expect(subscriber.deactivate).not.toHaveBeenCalled();
    expect(subscriber.disconnect).not.toHaveBeenCalled();

    probeReady = true;
    route.accept({ revision: 2, phase: "active", assignment: peer });
    await vi.waitFor(() => expect(subscriber.disconnect).toHaveBeenCalledOnce());
    expect(log.indexOf("peer:host-peer:2")).toBeLessThan(
      log.indexOf("subscriber:deactivate"),
    );
    expect(activatePeer).not.toHaveBeenCalledWith(peer);
  });

  it("requests provisional peer teardown on a newer SFU rollback", async () => {
    const prepared: Array<{ parent: string | null; revision?: number }> = [];
    const { route, subscriber } = await activateViewerSfuRoute({
      activatePeer: () => undefined,
      preparePeer: (assignment, revision) => prepared.push({
        parent: assignment?.upstream.kind === "peer"
          ? assignment.upstream.peerId
          : null,
        ...(revision === undefined ? {} : { revision }),
      }),
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      send: () => true,
    });

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: peerAssignment("host-peer"),
    });
    expect(prepared.at(-1)).toEqual({ parent: "host-peer", revision: 2 });
    route.accept({ revision: 3, phase: "active", assignment: sfuAssignment() });
    expect(prepared.at(-1)).toEqual({ parent: null });
    expect(subscriber.deactivate).not.toHaveBeenCalled();
  });

  it("re-proves a sticky SFU route after a cooldown-bound authority reassertion", async () => {
    const healthy: number[] = [];
    const messages: ClientMessage[] = [];
    let subscriber!: ReturnType<typeof createFakeSubscriber>;
    const route = new ViewerSfuRoute({
      activatePeer: () => undefined,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
      onHealthySfu: (revision) => healthy.push(revision),
      send: (message) => {
        messages.push(message);
        return true;
      },
      createSubscriber: (events) => {
        subscriber = createFakeSubscriber(events, [], "subscriber");
        return subscriber;
      },
    });

    await route.resyncAuthoritative({
      revision: 7,
      phase: "active",
      assignment: sfuAssignment(),
    });
    route.armHealthySfuReselection(7);
    await route.acceptConfig(sfuConfig(7));
    await vi.waitFor(() => expect(subscriber.activate).toHaveBeenCalledOnce());
    expect(messages).not.toContainEqual({
      type: "route-ready",
      revision: 7,
      phase: "active",
    });
    subscriber.events.onStream({} as MediaStream);
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 7,
      phase: "active",
    });
    subscriber.events.onStats?.({
      intervalPacketsReceived: 4,
      intervalFramesDecoded: 0,
    } as ConnectionMetrics);
    subscriber.events.onStats?.({
      intervalPacketsReceived: 4,
      intervalFramesDecoded: 3,
    } as ConnectionMetrics);
    expect(healthy).toEqual([]);

    route.armHealthySfuReselection(7);
    subscriber.events.onStats?.({
      intervalPacketsReceived: 4,
      intervalFramesDecoded: 3,
    } as ConnectionMetrics);
    subscriber.events.onStats?.({
      intervalPacketsReceived: 2,
      intervalFramesDecoded: 1,
    } as ConnectionMetrics);
    expect(healthy).toEqual([7]);

    expect(route.accept({
      revision: 7,
      phase: "active",
      assignment: sfuAssignment(),
    })).toBe("duplicate");
    subscriber.events.onStats?.({
      intervalPacketsReceived: 3,
      intervalFramesDecoded: 2,
    } as ConnectionMetrics);
    subscriber.events.onStats?.({
      intervalPacketsReceived: 5,
      intervalFramesDecoded: 4,
    } as ConnectionMetrics);
    expect(healthy).toEqual([7, 7]);
  });

  it("switches on first SFU video and forwards loss across same-publication revision reuse", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const peerAssignments: ParticipantRouteAssignment[] = [];
    const streams: Array<{
      stream: MediaStream;
      initialVideoStream: boolean;
      assignment: ParticipantRouteAssignment;
    }> = [];
    const sfuUpdates: Array<ConnectionMetrics | null> = [];
    const sfuStates: string[] = [];
    const videoAvailability: boolean[] = [];
    const metrics = {} as ConnectionMetrics;
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute({
      activatePeer: (assignment) => {
        peerAssignments.push(assignment);
      },
      reconcileSfuChildren: (children) => log.push(`children:${children.join(",")}`),
      onSfuStream: (stream, assignment, initialVideoStream) => {
        streams.push({ stream, assignment, initialVideoStream });
      },
      onSfuUpdate: (update) => sfuUpdates.push(update),
      onSfuState: (state) => sfuStates.push(state),
      onSfuVideoAvailability: (available) =>
        videoAvailability.push(available),
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

    subscribers[0]?.events.onVideoAvailability?.(false);
    subscribers[0]?.events.onVideoAvailability?.(true);
    expect(videoAvailability).toEqual([]);
    subscribers[0]?.events.onStats?.(metrics);
    subscribers[0]?.events.onState?.("reconnecting");
    expect(sfuUpdates).toEqual([]);
    expect(sfuStates).toEqual([]);

    const stream = {} as MediaStream;
    subscribers[0]?.events.onStream(stream);
    subscribers[0]?.events.onStats?.(metrics);
    subscribers[0]?.events.onState?.("reconnecting");
    expect(sfuUpdates).toEqual([metrics]);
    expect(sfuStates).toEqual(["reconnecting"]);
    expect(streams).toEqual([
      { stream, assignment: nextAssignment, initialVideoStream: true },
    ]);
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "active",
    });

    subscribers[0]?.events.onVideoAvailability?.(false);
    subscribers[0]?.events.onVideoAvailability?.(true);
    expect(videoAvailability).toEqual([false, true]);
    expect(messages).toContainEqual({
      type: "route-media-unavailable",
      revision: 2,
    });
    expect(
      messages.filter(
        (message) =>
          message.type === "route-ready" &&
          message.revision === 2 &&
          message.phase === "active",
      ),
    ).toHaveLength(2);

    const revisionThreeAssignment = sfuAssignment(["other-child"]);
    route.accept({
      revision: 3,
      phase: "active",
      assignment: revisionThreeAssignment,
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "route-ready",
        revision: 3,
        phase: "active",
      }),
    );
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.deactivate).not.toHaveBeenCalled();
    subscribers[0]?.events.onVideoAvailability?.(false);
    expect(videoAvailability).toEqual([false, true, false]);
    expect(messages).toContainEqual({
      type: "route-media-unavailable",
      revision: 3,
    });

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
    expect(messages).not.toContainEqual({
      type: "route-ready",
      revision: 5,
      phase: "active",
    });

    await route.disconnect();
    expect(sfuUpdates).toEqual([metrics, null]);
    subscribers[0]?.events.onStats?.(metrics);
    subscribers[0]?.events.onState?.("connected");
    subscribers[0]?.events.onVideoAvailability?.(false);
    expect(sfuUpdates).toEqual([metrics, null]);
    expect(sfuStates).toEqual(["reconnecting"]);
    expect(videoAvailability).toEqual([false, true, false]);
  });

  it("rebuilds an authoritative SFU route before proving a replaced publication", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const resetMedia = vi.fn();
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute({
      activatePeer: () => undefined,
      resetMedia,
      reconcileSfuChildren: () => undefined,
      onSfuStream: () => undefined,
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
    const assignment = sfuAssignment();

    route.accept({ revision: 1, phase: "prepare", assignment });
    await route.acceptConfig(sfuConfig(1));
    route.accept({ revision: 1, phase: "active", assignment });
    await vi.waitFor(() =>
      expect(subscribers[0]?.activate).toHaveBeenCalledOnce(),
    );
    subscribers[0]?.events.onStream({} as MediaStream);
    messages.length = 0;
    log.length = 0;

    await expect(
      route.resyncAuthoritative({
        revision: 2,
        phase: "active",
        assignment,
      }),
    ).resolves.toBe("accepted");

    expect(resetMedia).toHaveBeenCalledOnce();
    expect(log).toEqual([
      "subscriber-1:deactivate",
      "subscriber-1:disconnect",
    ]);
    expect(messages).not.toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "active",
    });

    await route.acceptConfig(sfuConfig(2));
    await vi.waitFor(() =>
      expect(subscribers[1]?.activate).toHaveBeenCalledOnce(),
    );
    expect(subscribers).toHaveLength(2);
    expect(messages).not.toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "active",
    });

    subscribers[1]?.events.onStream({} as MediaStream);
    expect(messages).toContainEqual({
      type: "route-ready",
      revision: 2,
      phase: "active",
    });

    messages.length = 0;
    route.accept({ revision: 3, phase: "active", assignment });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "route-ready",
        revision: 3,
        phase: "active",
      }),
    );
    expect(subscribers).toHaveLength(2);
    expect(subscribers[1]?.deactivate).not.toHaveBeenCalled();
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
