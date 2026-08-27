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
      message: "正在建立 P2P",
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
      revision: 1,
    });
    expect(deriveViewerPresentation(playing)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      connectionState: "connected",
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
      message: "点击播放",
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

  it("keeps proven media independent of room graph revision changes", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "p2p" },
      { type: "connection", revision: 2, connection: "connected" },
      { type: "media-bound", generation: 4, revision: 2 },
      { type: "frame-presented", generation: 4, revision: 2 },
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
      { type: "frame-presented", generation: 5, revision: 5 },
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
      failure: "AUTOPLAY_BLOCKED",
    });
    expect(staleFailure).toMatchObject({ failure: "PLAYBACK_FAILED" });
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
    expect(preparing.failure).toBe("AUTOPLAY_BLOCKED");
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
      { type: "frame-presented", generation: 5, revision: 5 },
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
      { type: "frame-presented", generation: 1, revision: 0 },
      { type: "signal", signal: "reconnecting" },
    );
    expect(deriveViewerPresentation(state)).toMatchObject({
      stage: "recovering",
      overlay: "none",
      notice: "服务器连接正在恢复，画面仍在播放",
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
      revision: 3,
    });
    expect(resumed.connection).toBe("connected");
    expect(deriveViewerPresentation(resumed)).toMatchObject({
      stage: "playing",
      message: "正在播放",
      notice: null,
    });
  });

  it("re-arms current media when active authority returns after route failure", () => {
    const failed = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, revision: 3 },
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
      failure: null,
      media: { generation: 2, framePresented: false },
    });

    const resumed = reduceViewerPresentation(recovering, {
      type: "frame-presented",
      generation: 2,
      revision: 3,
    });
    expect(resumed.connection).toBe("connected");
    expect(deriveViewerPresentation(resumed)).toMatchObject({
      stage: "playing",
      overlay: "none",
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

    expect(rebased.failure).toBe("PLAYBACK_FAILED");
    expect(deriveViewerPresentation(rebased).stage).toBe("playback-failed");
  });

  it("keeps a healthy Host-offline frame but invalidates it on upstream failure", () => {
    const offlineWithMedia = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, revision: 3 },
      { type: "host", host: "offline" },
    );
    expect(deriveViewerPresentation(offlineWithMedia)).toMatchObject({
      stage: "playing",
      overlay: "none",
      hasCurrentFrame: true,
      notice: "分享者连接已中断，画面可能冻结",
    });
    expect(
      reduceViewerPresentation(offlineWithMedia, {
        type: "media-invalidated",
        revision: 2,
      }),
    ).toBe(offlineWithMedia);

    const failed = reduceViewerPresentation(offlineWithMedia, {
      type: "media-invalidated",
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

  it("retains the current frame while signaling reconnects", () => {
    const reconnecting = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, revision: 3 },
      { type: "signal", signal: "reconnecting" },
    );

    expect(deriveViewerPresentation(reconnecting)).toMatchObject({
      stage: "recovering",
      message: "正在恢复连接",
      overlay: "none",
      notice: "服务器连接正在恢复，画面仍在播放",
    });
  });

  it("requires a new composited frame after presentation proof resets", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 3, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 3 },
      { type: "frame-presented", generation: 2, revision: 3 },
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
        revision: 3,
      }).media?.framePresented,
    ).toBe(true);
  });

  it("demotes the current frame when an exact route terminally fails", () => {
    const playing = apply(
      { type: "access", access: "ready" },
      { type: "signal", signal: "connected" },
      { type: "host", host: "online" },
      { type: "route", revision: 4, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 3, revision: 4 },
      { type: "frame-presented", generation: 3, revision: 4 },
    );
    const failed = reduceViewerPresentation(playing, {
      type: "route-status",
      revision: 4,
      state: "failed",
    });

    expect(deriveViewerPresentation(failed)).toMatchObject({
      stage: "route-failed",
      message: "没有可用的媒体线路",
      overlay: "status",
      hasCurrentFrame: false,
      hasRetainedFrame: true,
      failureCode: "ROUTE_EXHAUSTED",
      connectionState: "failed",
    });

    const lateFrame = reduceViewerPresentation(failed, {
      type: "frame-presented",
      generation: 3,
      revision: 4,
    });
    expect(lateFrame).toBe(failed);
    expect(
      reduceViewerPresentation(failed, {
        type: "media-bound",
        generation: 4,
        revision: 4,
      }),
    ).toBe(failed);
    const restored = reduceViewerPresentation(failed, {
      type: "route",
      revision: 4,
      phase: "active",
      kind: "sfu",
    });
    expect(restored.routeStatus).toBeNull();
    expect(restored.failure).toBeNull();
    expect(
      reduceViewerPresentation(restored, {
        type: "frame-presented",
        generation: 3,
        revision: 4,
      }).media?.framePresented,
    ).toBe(true);

    const localFailure = reduceViewerPresentation(playing, {
      type: "failure",
      failure: "ROUTE_EXHAUSTED",
      revision: 4,
    });
    expect(
      reduceViewerPresentation(localFailure, {
        type: "media-bound",
        generation: 4,
        revision: 4,
      }),
    ).toBe(localFailure);
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
      message: "当前无法通过房间号加入",
    });

    const notFound = reduceViewerPresentation(failed, {
      type: "access",
      access: "denied",
      failure: "ROOM_NOT_FOUND",
    });
    expect(deriveViewerPresentation(notFound)).toMatchObject({
      stage: "room-not-found",
      message: "房间不存在或已过期",
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
  });

  it("starts a fresh route revision namespace after sharing stops", () => {
    const previousShare = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 8, phase: "active", kind: "p2p" },
      { type: "media-bound", generation: 2, revision: 8 },
      { type: "frame-presented", generation: 2, revision: 8 },
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
      failure: "HOST_STOPPED",
    });

    const restarted = applyFrom(stopped,
      { type: "host", host: "online" },
      { type: "route", revision: 1, phase: "prepare", kind: "p2p" },
      { type: "media-bound", generation: 3, revision: 1 },
      { type: "frame-presented", generation: 3, revision: 1 },
    );
    expect(deriveViewerPresentation(restarted)).toMatchObject({
      stage: "playing",
      message: "正在播放",
      overlay: "none",
    });
  });
});
