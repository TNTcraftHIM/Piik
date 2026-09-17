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
import { t } from "../src/client/ui/copy.ts";
import { resolveMediaFailure } from "../src/client/ui/media-failure.ts";
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

function sfuConfig(revision: number, publicationGeneration = "publication_generation_12345678") {
  return {
    type: "sfu-config" as const,
    revision,
    publicationGeneration,
    connectionId: `sfu_connection_${revision}_12345678`,
  };
}

function createFakePublisher(log: string[], label: string) {
  return {
    updateConfig: vi.fn(),
    acceptSignal: vi.fn(async () => undefined),
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
    setPaused: vi.fn(),
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
    updateConfig: vi.fn(),
    acceptSignal: vi.fn(async () => undefined),
    reconnect: vi.fn(() => true),
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

  it("treats child assignment order as presentation-only", () => {
    const route = new MediaRouteTransition();
    route.accept({
      revision: 1,
      phase: "active",
      assignment: peerAssignment("parent", ["first", "second"]),
    });
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: peerAssignment("parent", ["second", "first"]),
      candidate: candidate(2, "second"),
    });

    expect(
      route.accept({
        revision: 2,
        phase: "active",
        assignment: peerAssignment("parent", ["first", "second"]),
      }),
    ).toBe("accepted");
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

  it("reports committed Peer failure during another preparation using active authority", () => {
    const route = new MediaRouteTransition();
    const send = vi.fn(() => false);
    route.accept({ revision: 7, phase: "active", assignment: peerAssignment("parent") });
    route.accept({
      revision: 8, phase: "prepare",
      assignment: peerAssignment("parent", ["child"]), candidate: candidate(8, "child"),
    });

    expect(reportActivePeerRouteFailure(route, "parent", "active-connection", send)).toBe(false);
    expect(send).toHaveBeenLastCalledWith({
      type: "route-failed", revision: 7, phase: "active", connectionId: "active-connection",
    });
    send.mockReturnValue(true);
    expect(reportActivePeerRouteFailure(route, "parent", "active-connection", send)).toBe(true);

    route.accept({ revision: 9, phase: "active", assignment: peerAssignment("replacement") });
    send.mockClear();
    expect(reportActivePeerRouteFailure(route, "parent", "active-connection", send)).toBe(true);
    route.reset();
    expect(reportActivePeerRouteFailure(route, "replacement", "new-connection", send)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports the committed SFU publisher when a Peer child is preparing", async () => {
    const send = vi.fn(() => true);
    let fail!: () => void;
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "h264",
      reconcileChildren: () => undefined,
      send,
      createPublisher: (onDisconnected) => {
        fail = onDisconnected;
        return createFakePublisher([], "active");
      },
    });
    const config = sfuConfig(7);
    await route.acceptAndWait({ revision: 7, phase: "active", assignment: hostAssignment(config.publicationGeneration) });
    await route.acceptConfig(config);
    send.mockClear();
    route.accept({
      revision: 8, phase: "prepare",
      assignment: hostAssignment(config.publicationGeneration, ["child"]), candidate: candidate(8, "child"),
    });
    fail();
    fail();
    expect(send.mock.calls).toEqual([[{
      type: "route-failed", revision: 7, phase: "active", connectionId: config.connectionId,
    }]]);
    await route.disconnect();
  });

  it("reports the committed SFU subscription when a downstream Peer is preparing", async () => {
    const send = vi.fn(() => true);
    const stream = vi.fn();
    let events!: SubscriberEvents;
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      onSfuStream: stream,
      send,
      createSubscriber: (callbacks) => {
        events = callbacks;
        return createFakeSubscriber(callbacks, [], "active");
      },
    });
    const config = sfuConfig(7);
    route.accept({ revision: 7, phase: "active", assignment: viewerSfuAssignment() });
    await route.acceptConfig(config);
    events.onStream({} as MediaStream);
    events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
    send.mockClear();
    route.accept({
      revision: 8, phase: "prepare",
      assignment: viewerSfuAssignment(["child"]), candidate: candidate(8, "child"),
    });
    events.onDisconnected();
    events.onDisconnected();
    expect(send.mock.calls).toEqual([[{
      type: "route-failed", revision: 7, phase: "active", connectionId: config.connectionId,
    }]]);
    await route.disconnect();
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
    await route.acceptConfig(sfuConfig(1, "publication-a"));
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
    await route.acceptConfig(sfuConfig(2, "publication-b"));
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

  it("renders an SFU connection failure in each language without placeholders", async () => {
    const publisher = createFakePublisher([], "publisher");
    publisher.connect.mockResolvedValue(false);
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => ({
        ...publisher,
        getFailureStage: () => "connect",
      }),
    });
    route.accept({
      revision: 1,
      phase: "prepare",
      assignment: hostAssignment("publication"),
      candidate: candidate(1, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(1, "publication"));
    const warning = route.getQualityWarning();

    for (const lang of ["en", "zh"] as const) {
      const text = resolveMediaFailure(warning, {
        lang,
        t: (key, vars) => t(lang, key, vars),
      });
      expect(text).toBe(t(lang, "host.warn.sfuRecover", {
        params: t(lang, "host.warn.sfuStage.connect"),
      }));
      expect(text).not.toMatch(/\{[^}]+\}/);
    }
  });

  it("changes Host children only after active authority commits", async () => {
    const reconciledChildren: string[][] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: (children) => reconciledChildren.push(children),
      send: () => true,
      createPublisher: () => createFakePublisher([], "publisher"),
    });
    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication", ["committed-child"]),
    });
    await route.acceptConfig(sfuConfig(1, "publication"));
    reconciledChildren.length = 0;

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment(null, ["candidate-child"]),
      candidate: candidate(2, "candidate-child"),
    });
    expect(reconciledChildren).toEqual([]);

    await route.acceptAndWait({
      revision: 2,
      phase: "active",
      assignment: hostAssignment(null, ["candidate-child"]),
    });
    expect(reconciledChildren).toEqual([["candidate-child"]]);
  });

  it("replaces a Host physical connection within one publication and fences stale signaling", async () => {
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: () => true,
      createPublisher: () => {
        const publisher = createFakePublisher([], "publisher");
        publishers.push(publisher);
        return publisher;
      },
    });
    await route.acceptAndWait({ revision: 1, phase: "active", assignment: hostAssignment("publication") });
    const first = sfuConfig(1, "publication");
    await route.acceptConfig(first);
    const replacement = { ...first, connectionId: "replacement_connection" };
    await route.acceptConfig(replacement);
    expect(publishers).toHaveLength(2);
    expect(publishers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(publishers[1]!.disconnect).not.toHaveBeenCalled();
    await route.acceptSignal({ ...first, type: "sfu-signal", kind: "candidate", candidate: { candidate: "old" } });
    expect(publishers[0]!.acceptSignal).not.toHaveBeenCalled();
    await route.acceptSignal({ ...replacement, type: "sfu-signal", kind: "candidate", candidate: { candidate: "current" } });
    expect(publishers[1]!.acceptSignal).toHaveBeenCalledOnce();
    await route.disconnect();
  });

  it("reports and retires an exact active SFU source replacement failure", async () => {
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: () => {
        const publisher = createFakePublisher([], "publisher-active");
        publishers.push(publisher);
        return publisher;
      },
    });

    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication-active"),
    });
    await route.acceptConfig(sfuConfig(1, "publication-active"));
    publishers[0]!.replaceStream.mockResolvedValue(false);

    await expect(route.replaceStream({} as MediaStream)).resolves.toBe(false);
    expect(publishers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(messages).toContainEqual({ type: "refresh-sfu", revision: 1 });
  });

  it("retires a failed pending source without invalidating healthy active SFU", async () => {
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
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
      assignment: hostAssignment("publication-active"),
    });
    await route.acceptConfig(sfuConfig(1, "publication-active"));
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-pending"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2, "publication-pending"));
    publishers[1]!.replaceStream.mockResolvedValue(false);

    await expect(route.replaceStream({} as MediaStream)).resolves.toBe(true);
    expect(publishers[0]!.disconnect).not.toHaveBeenCalled();
    expect(publishers[1]!.disconnect).toHaveBeenCalledOnce();
    expect(messages).toContainEqual({
      type: "route-failed",
      revision: 2,
      phase: "prepare",
      connectionId: null,
    });
  });

  it("reports success when a pending SFU promotion supersedes an old failure", async () => {
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
        publishers.push(publisher);
        return publisher;
      },
    });

    await route.acceptAndWait({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication-old"),
    });
    await route.acceptConfig(sfuConfig(1, "publication-old"));
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-new"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2, "publication-new"));

    let resolveOldReplacement!: (replaced: boolean) => void;
    publishers[0]!.replaceStream.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOldReplacement = resolve;
        }),
    );
    const oldReplacementCalls = publishers[0]!.replaceStream.mock.calls.length;
    const replacing = route.replaceStream({} as MediaStream);
    await vi.waitFor(() =>
      expect(publishers[0]!.replaceStream).toHaveBeenCalledTimes(
        oldReplacementCalls + 1,
      ),
    );

    await route.acceptAndWait({
      revision: 2,
      phase: "active",
      assignment: hostAssignment("publication-new"),
    });
    resolveOldReplacement(false);

    await expect(replacing).resolves.toBe(true);
    expect(publishers[1]!.disconnect).not.toHaveBeenCalled();
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
    await route.acceptConfig(sfuConfig(1, "publication-old"));
    route.setPaused(true);
    expect(publishers[0]?.setPaused).toHaveBeenCalledWith(true);

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

  it("rebuilds a failed Host SFU publisher while sharing is paused", async () => {
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const disconnects: Array<() => void> = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: (onDisconnected) => {
        disconnects.push(onDisconnected);
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
      assignment: hostAssignment("publication-paused"),
    });
    await route.acceptConfig(sfuConfig(1, "publication-paused"));
    route.setPaused(true);
    disconnects[0]!();
    expect(messages).toContainEqual({ type: "refresh-sfu", revision: 1 });

    await route.acceptConfig({ ...sfuConfig(1, "publication-paused"), connectionId: "recovery_connection" });
    expect(publishers).toHaveLength(2);
    expect(publishers[1]!.setPaused).toHaveBeenCalledWith(true);

    route.setPaused(false);
    expect(publishers[1]!.setPaused).toHaveBeenLastCalledWith(false);
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
    await route.acceptConfig(sfuConfig(1, "publication-old"));

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
    const freshPublication = route.acceptConfig(sfuConfig(2, "publication-fresh"));
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

  it("ignores a retired publisher failure after same-generation resync", async () => {
    let releaseOldConnect!: () => void;
    const oldConnectGate = new Promise<void>((resolve) => {
      releaseOldConnect = resolve;
    });
    const messages: ClientMessage[] = [];
    const publishers: ReturnType<typeof createFakePublisher>[] = [];
    const route = new HostSfuRoute({
      getStream: () => ({}) as MediaStream,
      getProfile: () => QUALITY_PROFILES["720p30"],
      getVideoCodec: () => "vp8",
      reconcileChildren: () => undefined,
      send: (message) => {
        messages.push(message);
        return true;
      },
      createPublisher: () => {
        const publisher = createFakePublisher(
          [],
          `publisher-${publishers.length + 1}`,
        );
        if (publishers.length === 1) {
          publisher.connect.mockImplementation(async () => {
            await oldConnectGate;
            throw new Error("retired publisher");
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
    await route.acceptConfig(sfuConfig(1, "publication-old"));
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-new"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    const stale = route.acceptConfig(sfuConfig(2, "publication-new"));
    await vi.waitFor(() => expect(publishers[1]?.connect).toHaveBeenCalledOnce());

    await route.resyncAuthoritative({
      revision: 1,
      phase: "active",
      assignment: hostAssignment("publication-old"),
    });
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: hostAssignment("publication-new"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    const current = route.acceptConfig(sfuConfig(2, "publication-new"));
    await vi.waitFor(() => expect(publishers).toHaveLength(3));
    releaseOldConnect();
    await Promise.all([stale, current]);

    expect(messages.filter((message) => message.type === "route-failed")).toEqual(
      [],
    );
    expect(publishers[2]?.activate).toHaveBeenCalledOnce();
  });

  it("ignores a retired subscriber failure after same-generation resync", async () => {
    let releaseOldConnect!: () => void;
    const oldConnectGate = new Promise<void>((resolve) => {
      releaseOldConnect = resolve;
    });
    const messages: ClientMessage[] = [];
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
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
          subscriber.connect.mockImplementation(async () => {
            await oldConnectGate;
            throw new Error("retired subscriber");
          });
        }
        subscribers.push(subscriber);
        return subscriber;
      },
    });

    route.accept({
      revision: 1,
      phase: "active",
      assignment: viewerSfuAssignment([], "publication-old"),
    });
    await route.acceptConfig(sfuConfig(1, "publication-old"));
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment([], "publication-new"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    const stale = route.acceptConfig(sfuConfig(2, "publication-new"));
    await vi.waitFor(() => expect(subscribers[1]?.connect).toHaveBeenCalledOnce());

    await route.resyncAuthoritative(
      {
        revision: 1,
        phase: "active",
        assignment: viewerSfuAssignment([], "publication-old"),
      },
      "viewer_12345678",
    );
    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment([], "publication-new"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    const current = route.acceptConfig(sfuConfig(2, "publication-new"));
    await vi.waitFor(() => expect(subscribers).toHaveLength(3));
    releaseOldConnect();
    await Promise.all([stale, current]);

    expect(messages.filter((message) => message.type === "route-failed")).toEqual(
      [],
    );
    expect(subscribers[2]?.activate).toHaveBeenCalledOnce();
  });


  it("uses the subscriber first decoded frame as the only SFU prepare ready", async () => {
    const log: string[] = [];
    const messages: ClientMessage[] = [];
    const streams: MediaStream[] = [];
    const decodedSamples: Array<{
      framesDecodedDelta: number | null;
      revision: number;
      mediaIdentity: string;
      connectionId: string;
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
        connectionId,
      ) => decodedSamples.push({ framesDecodedDelta, revision, mediaIdentity, connectionId }),
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
        connectionId: sfuConfig(1).connectionId,
      },
    ]);

    route.accept({
      revision: 2,
      phase: "prepare",
      assignment: viewerSfuAssignment([], "publication-generation-2"),
      candidate: candidate(2, "viewer_12345678", "sfu"),
    });
    await route.acceptConfig(sfuConfig(2, "publication-generation-2"));
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
      connectionId: sfuConfig(2).connectionId,
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
    expect(subscribers[0]?.reconnect).toHaveBeenCalledOnce();
    expect(resetMedia).not.toHaveBeenCalled();
    expect(subscribers[0]?.deactivate).not.toHaveBeenCalled();
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();

    await route.acceptConfig(sfuConfig(7));
    expect(subscribers).toHaveLength(1);
    expect(streams).toEqual([firstStream]);
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();
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

  it("retains the physical SFU subscriber when a room revision advances during reconnect", async () => {
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
    await vi.waitFor(() => expect(subscribers[0]?.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 8 }),
    ));
    expect(messages.filter((message) => message.type === "refresh-sfu")).toEqual([]);
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();
    await route.disconnect();
  });

  it("keeps SFU reconnect on the physical subscriber through an unrelated prepare", async () => {
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
        const subscriber = createFakeSubscriber(events, [], "active");
        subscribers.push(subscriber);
        return subscriber;
      },
    });
    const assignment = viewerSfuAssignment(["relay-child"]);
    route.accept({ revision: 7, phase: "active", assignment });
    await route.acceptConfig(sfuConfig(7));
    subscribers[0]!.events.onStream({} as MediaStream);
    subscribers[0]!.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(route.reconnectActive()).toBe(true);

    route.accept({
      revision: 8,
      phase: "prepare",
      assignment,
      candidate: candidate(8, "relay-child"),
    });
    route.accept({ revision: 8, phase: "active", assignment });

    await vi.waitFor(() => expect(subscribers[0]?.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 8 }),
    ));
    expect(subscribers[0]?.reconnect).toHaveBeenCalledOnce();
    expect(subscribers[0]?.disconnect).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === "refresh-sfu").every((message) => message.revision === 7)).toBe(true);
  });

  it("does not spend SFU recovery until refresh signaling is sent", async () => {
    const messages: ClientMessage[] = [];
    const streams: MediaStream[] = [];
    let acceptsRefresh = false;
    const subscribers: ReturnType<typeof createFakeSubscriber>[] = [];
    const route = new ViewerSfuRoute("viewer_12345678", {
      activatePeer: () => true,
      reconcileSfuChildren: () => undefined,
      onSfuStream: (stream) => streams.push(stream),
      send: (message) => {
        messages.push(message);
        return message.type !== "refresh-sfu" || acceptsRefresh;
      },
      createSubscriber: (events) => {
        const subscriber = createFakeSubscriber(events, [], "active");
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
    subscribers[0]!.events.onStream({} as MediaStream);
    subscribers[0]!.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    subscribers[0]!.events.onDisconnected();
    acceptsRefresh = true;

    route.accept({
      revision: 8,
      phase: "active",
      assignment: viewerSfuAssignment(),
    });
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.type === "refresh-sfu"),
      ).toEqual([
        { type: "refresh-sfu", revision: 7 },
        { type: "refresh-sfu", revision: 8 },
      ]),
    );
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
      connectionId: "recovery_connection",
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

  it("rebuilds a failed Viewer SFU subscriber while sharing is paused", async () => {
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
    subscribers[0]!.events.onStream({} as MediaStream);
    subscribers[0]!.events.onFirstDecodedFrame();
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    route.setPaused(true);
    subscribers[0]!.events.onDisconnected();
    expect(messages).toContainEqual({ type: "refresh-sfu", revision: 7 });

    await route.acceptConfig({ ...sfuConfig(7), connectionId: "recovery_connection" });
    expect(subscribers).toHaveLength(2);
    expect(subscribers[1]!.armDecodedFrameProof).not.toHaveBeenCalled();

    route.setPaused(false);
    expect(subscribers[1]!.armDecodedFrameProof).toHaveBeenCalledOnce();
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
    await route.acceptConfig(sfuConfig(1, "publication-old"));
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
