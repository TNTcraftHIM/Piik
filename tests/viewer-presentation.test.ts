import { describe, expect, it } from "vitest";

import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  deriveViewerPresentation,
  reduceViewerPresentation,
  viewerFailureFromServerCode,
  type ViewerPresentationAction,
  type ViewerPresentationState,
} from "../src/client/media/viewer-presentation.ts";

function apply(
  ...actions: readonly ViewerPresentationAction[]
): ViewerPresentationState {
  return applyFrom(INITIAL_VIEWER_PRESENTATION_STATE, ...actions);
}

function applyFrom(
  state: ViewerPresentationState,
  ...actions: readonly ViewerPresentationAction[]
): ViewerPresentationState {
  return actions.reduce(reduceViewerPresentation, state);
}

describe("Viewer presentation reducer", () => {
  it("derives connection stages from typed current-revision facts", () => {
    const preparing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 1, phase: "prepare", kind: "p2p" },
    );
    expect(deriveViewerPresentation(preparing)).toMatchObject({
      stage: "preparing-p2p",
      messageKey: "viewer.msg.preparingP2p",
      overlay: "blocking",
    });

    const receiving = reduceViewerPresentation(preparing, {
      type: "media-bound",
      generation: 1,
      revision: 1,
    });
    expect(deriveViewerPresentation(receiving).stage).toBe("receiving");

    const playing = reduceViewerPresentation(receiving, {
      type: "frame-presented",
      generation: 1,
      proofEpoch: 0,
      revision: 1,
    });
    expect(deriveViewerPresentation(playing)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
    });
  });

  it("reports native playback blocking only for the exact media generation", () => {
    const blocked = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 4, revision: 2 },
      { type: "autoplay-blocked", generation: 4, revision: 2 },
      { type: "connection", revision: 2, connection: "connected" },
    );
    expect(deriveViewerPresentation(blocked)).toMatchObject({
      stage: "needs-play",
      messageKey: "viewer.msg.needsPlay",
      overlay: "status",
      failureCode: "AUTOPLAY_BLOCKED",
    });

    const staleClear = reduceViewerPresentation(blocked, {
      type: "autoplay-cleared",
      generation: 3,
    });
    expect(deriveViewerPresentation(staleClear).stage).toBe("needs-play");

    const cleared = reduceViewerPresentation(blocked, {
      type: "autoplay-cleared",
      generation: 4,
    });
    expect(deriveViewerPresentation(cleared)).toMatchObject({
      stage: "receiving",
    });
  });

  it("waits for the current media connection before reporting playback blocking", () => {
    const blockedWhileConnecting = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 4, revision: 2 },
      { type: "autoplay-blocked", generation: 4, revision: 2 },
    );
    expect(deriveViewerPresentation(blockedWhileConnecting)).toMatchObject({
      stage: "receiving",
    });

    const connected = reduceViewerPresentation(blockedWhileConnecting, {
      type: "connection",
      revision: 2,
      connection: "connected",
    });
    expect(deriveViewerPresentation(connected)).toMatchObject({
      stage: "needs-play",
      overlay: "status",
    });
  });

  it("does not reuse a connected fact after the route revision advances", () => {
    const connected = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "p2p" },
      { type: "connection", revision: 2, connection: "connected" },
    );
    const nextRoute = reduceViewerPresentation(connected, {
      type: "route",
      revision: 3,
      phase: "prepare",
      kind: "sfu",
    });
    expect(nextRoute.connection).toBe("connecting");
  });

  it("accepts an authoritative lower route revision without retaining failure state", () => {
    const failed = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 8, phase: "active", kind: "p2p" },
      { type: "route-status", revision: 8, state: "failed" },
    );

    const rebound = reduceViewerPresentation(failed, {
      type: "route",
      revision: 0,
      phase: "active",
      kind: "none",
      authoritative: true,
    });

    expect(rebound.revision).toBe(0);
    expect(rebound.routeStatus).toBeNull();
    expect(rebound.connection).toBe("idle");
  });

  it("keeps proven media across an authoritative same-route reauthentication", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 8, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 1, revision: 8 },
      { type: "frame-presented", generation: 1, proofEpoch: 0, revision: 8 },
      { type: "route-status", revision: 8, state: "failed" },
    );

    const rebound = reduceViewerPresentation(playing, {
      type: "route",
      revision: 0,
      phase: "active",
      kind: "p2p",
      authoritative: true,
    });

    expect(rebound.routeStatus).toBeNull();
    expect(rebound.media).toMatchObject({ generation: 1 });
    expect(rebound.connection).toBe("reconnecting");
  });

  it("keeps proven media independent of room graph revision changes", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "p2p" },
      { type: "connection", revision: 2, connection: "connected" },
      { type: "media-bound", generation: 4, revision: 2 },
      { type: "frame-presented", generation: 4, proofEpoch: 0, revision: 2 },
    );
    const rebased = reduceViewerPresentation(playing, {
      type: "route",
      revision: 3,
      phase: "active",
      kind: "p2p",
    });

    expect(rebased.media).toEqual({
      generation: 4,
      boundAtRevision: 2,
      proofEpoch: 0,
      framePresented: true,
    });
    expect(rebased.connection).toBe("connected");
    expect(deriveViewerPresentation(rebased)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      hasRetainedFrame: false,
    });
  });

  it("ignores a late playback failure from a replaced media binding", () => {
    const rebound = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 1, revision: 2 },
      { type: "media-bound", generation: 2, revision: 2 },
    );
    const staleFailure = reduceViewerPresentation(rebound, {
      type: "playback-failed",
      generation: 1,
      revision: 2,
    });
    expect(staleFailure).toBe(rebound);
    expect(deriveViewerPresentation(staleFailure).stage).toBe("receiving");
  });

  it("keeps playback authority with the bound media generation", () => {
    const oldMedia = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 5, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 5, revision: 5 },
      { type: "frame-presented", generation: 5, proofEpoch: 0, revision: 5 },
    );
    const preparing = reduceViewerPresentation(oldMedia, {
      type: "route",
      revision: 6,
      phase: "prepare",
      kind: "sfu",
    });

    const staleAutoplay = reduceViewerPresentation(preparing, {
      type: "autoplay-blocked",
      generation: 5,
      revision: 5,
    });
    const staleFailure = reduceViewerPresentation(preparing, {
      type: "playback-failed",
      generation: 5,
      revision: 5,
    });

    expect(staleAutoplay).toMatchObject({
      autoplayBlockedGeneration: 5,
    });
    expect(staleFailure).toMatchObject({ playbackFailedGeneration: 5 });
    expect(deriveViewerPresentation(preparing)).toMatchObject({
      stage: "playing",
      overlay: "none",
    });
  });

  it("retains autoplay authority until the media generation changes", () => {
    const blocked = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 5, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 5, revision: 5 },
      { type: "autoplay-blocked", generation: 5, revision: 5 },
    );
    const preparing = reduceViewerPresentation(blocked, {
      type: "route",
      revision: 6,
      phase: "prepare",
      kind: "sfu",
    });

    expect(preparing.autoplayBlockedGeneration).toBe(5);
    expect(deriveViewerPresentation(preparing)).toMatchObject({
      stage: "receiving",
    });
  });

  it("keeps a proven frame until a replacement media generation binds", () => {
    const oldFrame = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 5, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 5, revision: 5 },
      { type: "frame-presented", generation: 5, proofEpoch: 0, revision: 5 },
    );
    const recovering = reduceViewerPresentation(oldFrame, {
      type: "route",
      revision: 6,
      phase: "prepare",
      kind: "sfu",
    });
    expect(deriveViewerPresentation(recovering)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      hasRetainedFrame: false,
    });

    const continuingProof = reduceViewerPresentation(recovering, {
      type: "frame-presented",
      generation: 5,
      proofEpoch: 0,
      revision: 5,
    });
    expect(continuingProof).toMatchObject({
      media: { generation: 5, framePresented: true },
    });

    const rebound = reduceViewerPresentation(recovering, {
      type: "media-bound",
      generation: 6,
      revision: 6,
    });
    const proven = reduceViewerPresentation(rebound, {
      type: "frame-presented",
      generation: 6,
      proofEpoch: 0,
      revision: 6,
    });
    expect(deriveViewerPresentation(proven)).toMatchObject({
      stage: "playing",
      hasCurrentFrame: true,
      hasRetainedFrame: false,
    });
  });

  it("keeps healthy media visible while signaling reconnects", () => {
    const state = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 0, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 1, revision: 0 },
      { type: "frame-presented", generation: 1, proofEpoch: 0, revision: 0 },
      { type: "signal", signal: "reconnecting" },
    );
    expect(deriveViewerPresentation(state)).toMatchObject({
      stage: "recovering",
      overlay: "none",
      noticeKey: "viewer.notice.signalRecovering",
    });
  });

  it("treats a new current-generation frame as connected media", () => {
    const recovering = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "connection", revision: 3, connection: "reconnecting" },
    );

    const resumed = reduceViewerPresentation(recovering, {
      type: "frame-presented",
      generation: 2,
      proofEpoch: 0,
      revision: 3,
    });
    expect(resumed.connection).toBe("connected");
    expect(deriveViewerPresentation(resumed)).toMatchObject({
      stage: "playing",
      messageKey: "viewer.msg.playing",
      noticeKey: null,
    });
  });

  it("re-arms current media when active authority returns after route failure", () => {
    const failed = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
      { type: "route-status", revision: 3, state: "failed" },
    );
    const recovering = reduceViewerPresentation(failed, {
      type: "route",
      revision: 4,
      phase: "active",
      kind: "sfu",
    });
    expect(recovering).toMatchObject({
      connection: "reconnecting",
      routeStatus: null,
      media: { generation: 2, framePresented: false },
    });

    const resumed = reduceViewerPresentation(recovering, {
      type: "frame-presented",
      generation: 2,
      proofEpoch: 1,
      revision: 3,
    });
    expect(resumed.connection).toBe("connected");
    expect(deriveViewerPresentation(resumed)).toMatchObject({
      stage: "playing",
      overlay: "none",
    });
  });

  it("re-proves committed media across background route attempts", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 74, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 9, revision: 74 },
      { type: "frame-presented", generation: 9, proofEpoch: 0, revision: 74 },
      { type: "frame-proof-reset", generation: 9, revision: 74 },
      { type: "route", revision: 75, phase: "prepare", kind: "p2p" },
      { type: "route", revision: 76, phase: "active", kind: "sfu" },
      { type: "route", revision: 77, phase: "prepare", kind: "p2p" },
    );

    expect(
      reduceViewerPresentation(playing, {
        type: "frame-presented",
        generation: 9,
        proofEpoch: 0,
        revision: 74,
      }),
    ).toBe(playing);

    const reproved = reduceViewerPresentation(playing, {
      type: "frame-presented",
      generation: 9,
      proofEpoch: 1,
      revision: 74,
    });
    expect(deriveViewerPresentation(reproved)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      hasRetainedFrame: false,
    });
  });

  it("keeps a browser playback failure across unrelated active authority", () => {
    const failed = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "playback-failed", generation: 2, revision: 3 },
    );
    const rebased = reduceViewerPresentation(failed, {
      type: "route",
      revision: 4,
      phase: "active",
      kind: "sfu",
    });

    expect(rebased.playbackFailedGeneration).toBe(2);
    expect(deriveViewerPresentation(rebased).stage).toBe("playback-failed");
  });

  it("keeps Host, route, and playback facts orthogonal", () => {
    const playbackFailed = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "playback-failed", generation: 2, revision: 3 },
      { type: "host", host: "offline" },
      { type: "host", host: "online" },
    );
    expect(playbackFailed.playbackFailedGeneration).toBe(2);
    expect(deriveViewerPresentation(playbackFailed).stage).toBe(
      "playback-failed",
    );

    const routeFailed = applyFrom(
      playbackFailed,
      { type: "route-status", revision: 3, state: "failed" },
      { type: "host", host: "offline" },
      { type: "host", host: "online" },
    );
    expect(routeFailed.routeStatus).toEqual({ revision: 3, state: "failed" });
    expect(deriveViewerPresentation(routeFailed).stage).toBe("route-failed");
  });

  it("does not retain a frame that remains current while a route waits", () => {
    const waiting = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
      { type: "route-status", revision: 4, state: "waiting" },
    );

    expect(waiting.media?.framePresented).toBe(true);
    expect(waiting.retainedFrame).toBe(false);
    expect(deriveViewerPresentation(waiting)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      hasRetainedFrame: false,
    });
  });

  it("keeps a healthy Host-offline frame but invalidates it on upstream failure", () => {
    const offlineWithMedia = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
      { type: "host", host: "offline" },
    );
    expect(deriveViewerPresentation(offlineWithMedia)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      noticeKey: "viewer.notice.hostOffline",
    });
    expect(
      reduceViewerPresentation(offlineWithMedia, {
        type: "frame-proof-reset",
        generation: 1,
        revision: 3,
      }),
    ).toBe(offlineWithMedia);

    const failed = reduceViewerPresentation(offlineWithMedia, {
      type: "frame-proof-reset",
      generation: 2,
      revision: 3,
    });
    expect(deriveViewerPresentation(failed)).toMatchObject({
      stage: "host-offline",
      overlay: "status",
      hasCurrentFrame: false,
      hasRetainedFrame: true,
      failureCode: "HOST_OFFLINE",
    });
  });

  it("lets current media prove a frame while Host signaling is offline", () => {
    const offlineBeforeFirstFrame = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "host", host: "offline" },
    );
    const lateFrame = reduceViewerPresentation(offlineBeforeFirstFrame, {
      type: "frame-presented",
      generation: 2,
      proofEpoch: 0,
      revision: 3,
    });

    expect(deriveViewerPresentation(lateFrame)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      noticeKey: "viewer.notice.hostOffline",
    });

    const previouslyPlaying = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
      { type: "host", host: "offline" },
      { type: "frame-proof-reset", generation: 2, revision: 3 },
    );
    const reproved = reduceViewerPresentation(previouslyPlaying, {
      type: "frame-presented",
      generation: 2,
      proofEpoch: 1,
      revision: 3,
    });
    expect(deriveViewerPresentation(reproved)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      noticeKey: "viewer.notice.hostOffline",
    });
  });

  it("retains the current frame while signaling reconnects", () => {
    const reconnecting = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
      { type: "signal", signal: "reconnecting" },
    );

    expect(deriveViewerPresentation(reconnecting)).toMatchObject({
      stage: "recovering",
      messageKey: "viewer.msg.recovering",
      overlay: "none",
      noticeKey: "viewer.notice.signalRecovering",
    });
  });

  it("requires a new composited frame after presentation proof resets", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
    );
    const reset = reduceViewerPresentation(playing, {
      type: "frame-proof-reset",
      generation: 2,
      revision: 3,
    });

    expect(deriveViewerPresentation(reset)).toMatchObject({
      hasCurrentFrame: false,
      hasRetainedFrame: true,
    });
    expect(
      deriveViewerPresentation(
        reduceViewerPresentation(reset, {
          type: "connection",
          revision: 3,
          connection: "reconnecting",
        }),
      ).stage,
    ).toBe("recovering");
    expect(
      reduceViewerPresentation(reset, {
        type: "frame-proof-reset",
        generation: 1,
        revision: 3,
      }),
    ).toBe(reset);
    expect(
      reduceViewerPresentation(reset, {
        type: "frame-presented",
        generation: 2,
        proofEpoch: 1,
        revision: 3,
      }).media?.framePresented,
    ).toBe(true);
  });

  it("re-arms observation without changing playback and accepts the next fresh frame", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 3 },
    );
    expect(deriveViewerPresentation(reduceViewerPresentation(playing, {
      type: "autoplay-blocked", generation: 2, revision: 3,
    }))).toMatchObject({
      stage: "needs-play", hasCurrentFrame: true,
    });
    const cases = [
      playing,
      reduceViewerPresentation(playing, { type: "connection", revision: 3, connection: "reconnecting" }),
      reduceViewerPresentation(playing, { type: "route-status", revision: 3, state: "failed" }),
      reduceViewerPresentation(playing, { type: "host", host: "paused" }),
      reduceViewerPresentation(playing, { type: "media-bound", generation: 3, revision: 3 }),
    ];
    for (const before of cases) {
      const media = before.media!;
      const rearmed = reduceViewerPresentation(before, {
        type: "frame-proof-rearm", generation: media.generation,
      });
      expect(deriveViewerPresentation(rearmed)).toEqual(deriveViewerPresentation(before));
      const frame = {
        type: "frame-presented" as const,
        generation: media.generation, revision: media.boundAtRevision, proofEpoch: media.proofEpoch,
      };
      expect(reduceViewerPresentation(rearmed, frame)).toBe(rearmed);
      const fresh = reduceViewerPresentation(rearmed, { ...frame, proofEpoch: media.proofEpoch + 1 });
      expect(fresh.connection).toBe("connected");
      expect(fresh.routeStatus).toBeNull();
      expect(deriveViewerPresentation(fresh).stage).toBe(before.host === "paused" ? "host-paused" : "playing");
    }
  });

  it("demotes the current frame when an exact route terminally fails", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 4, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 3, revision: 4 },
      { type: "frame-presented", generation: 3, proofEpoch: 0, revision: 4 },
    );
    const failed = reduceViewerPresentation(playing, {
      type: "route-status",
      revision: 4,
      state: "failed",
    });

    expect(deriveViewerPresentation(failed)).toMatchObject({
      stage: "route-failed",
      messageKey: "viewer.msg.routeFailed",
      overlay: "status",
      hasCurrentFrame: false,
      hasRetainedFrame: true,
      failureCode: "ROUTE_EXHAUSTED",
    });

    const lateFrame = reduceViewerPresentation(failed, {
      type: "frame-presented",
      generation: 3,
      proofEpoch: 0,
      revision: 4,
    });
    expect(lateFrame).toBe(failed);
    const rebound = reduceViewerPresentation(failed, {
      type: "media-bound",
      generation: 4,
      revision: 4,
    });
    expect(rebound).toMatchObject({
      media: { generation: 4, framePresented: false },
      retainedFrame: false,
      routeStatus: { revision: 4, state: "failed" },
    });
    expect(
      reduceViewerPresentation(rebound, {
        type: "frame-presented",
        generation: 4,
        proofEpoch: 0,
        revision: 4,
      }),
    ).toMatchObject({
      media: { generation: 4, framePresented: true },
      routeStatus: null,
      connection: "connected",
    });
    const restored = reduceViewerPresentation(failed, {
      type: "route",
      revision: 4,
      phase: "active",
      kind: "sfu",
    });
    expect(restored.routeStatus).toBeNull();
    expect(
      reduceViewerPresentation(restored, {
        type: "frame-presented",
        generation: 3,
        proofEpoch: 1,
        revision: 4,
      }).media?.framePresented,
    ).toBe(true);

  });

  it("honors terminal access, Host pause, and typed route status priority", () => {
    const paused = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "paused" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 1, revision: 3 },
      { type: "autoplay-blocked", generation: 1, revision: 3 },
    );
    expect(deriveViewerPresentation(paused)).toMatchObject({
      stage: "host-paused",
    });

    const waiting = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route-status", revision: 4, state: "waiting" },
    );
    expect(deriveViewerPresentation(waiting).stage).toBe("waiting-sfu");

    const failed = reduceViewerPresentation(waiting, {
      type: "route-status",
      revision: 4,
      state: "failed",
    });
    expect(deriveViewerPresentation(failed)).toMatchObject({
      stage: "route-failed",
      failureCode: "ROUTE_EXHAUSTED",
    });

    const denied = reduceViewerPresentation(failed, {
      type: "access",
      access: "denied",
      failure: "ROOM_ACCESS_DENIED",
    });
    expect(deriveViewerPresentation(denied)).toMatchObject({
      stage: "access-denied",
      messageKey: "viewer.msg.denied",
    });

    const notFound = reduceViewerPresentation(failed, {
      type: "access",
      access: "denied",
      failure: "ROOM_NOT_FOUND",
    });
    expect(deriveViewerPresentation(notFound)).toMatchObject({
      stage: "room-not-found",
      messageKey: "viewer.msg.notFound",
    });
  });

  it("preserves exact Viewer access failures without inferring a restart", () => {
    expect(viewerFailureFromServerCode("INVALID_TOKEN")).toBe("INVALID_TOKEN");
    expect(viewerFailureFromServerCode("ROOM_NOT_FOUND")).toBe(
      "ROOM_NOT_FOUND",
    );
    expect(viewerFailureFromServerCode("ROOM_ACCESS_DENIED")).toBe(
      "ROOM_ACCESS_DENIED",
    );
    expect(viewerFailureFromServerCode("FORBIDDEN")).toBeNull();
    expect(viewerFailureFromServerCode("INVALID_MESSAGE")).toBeNull();
  });

  it("keeps an intentional stop authoritative over the following offline fact", () => {
    const stopped = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "sharing-stopped" },
      { type: "host", host: "offline" },
    );

    expect(stopped).toMatchObject({
      host: "stopped",
    });
    expect(deriveViewerPresentation(stopped)).toMatchObject({
      stage: "waiting-host",
      messageKey: "viewer.msg.waitingHost",
      failureCode: "HOST_STOPPED",
    });
  });

  it("starts a fresh route revision namespace after sharing stops", () => {
    const previousShare = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 8, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 8 },
      { type: "frame-presented", generation: 2, proofEpoch: 0, revision: 8 },
    );
    const stopped = reduceViewerPresentation(previousShare, {
      type: "sharing-stopped",
    });
    expect(stopped).toMatchObject({
      host: "stopped",
      revision: null,
      route: null,
      connection: "idle",
      media: null,
      retainedFrame: false,
    });

    const restarted = applyFrom(stopped,
      { type: "host", host: "online" },
      { type: "route", revision: 1, phase: "prepare", kind: "p2p" },
      { type: "media-bound", generation: 3, revision: 1 },
      { type: "frame-presented", generation: 3, proofEpoch: 0, revision: 1 },
    );
    expect(deriveViewerPresentation(restarted)).toMatchObject({
      stage: "playing",
      messageKey: "viewer.msg.playing",
      overlay: "none",
    });
  });
});
