import { describe, expect, it } from "vitest";

import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  deriveViewerPresentation,
  reduceViewerPresentation,
  type ViewerPresentationAction,
  type ViewerPresentationState,
} from "../src/client/media/viewer-presentation.ts";

function apply(
  ...actions: readonly ViewerPresentationAction[]
): ViewerPresentationState {
  return actions.reduce(
    reduceViewerPresentation,
    INITIAL_VIEWER_PRESENTATION_STATE,
  );
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
      showPlay: false,
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
    });
  });

  it("shows Play only for the exact media generation rejected by autoplay", () => {
    const blocked = apply(
      { type: "access", access: "ready" },
      { type: "host", host: "online" },
      { type: "route", revision: 2, phase: "active", kind: "sfu" },
      { type: "media-bound", generation: 4, revision: 2 },
      { type: "autoplay-blocked", generation: 4, revision: 2 },
    );
    expect(deriveViewerPresentation(blocked)).toMatchObject({
      stage: "needs-play",
      showPlay: true,
      failureCode: "AUTOPLAY_BLOCKED",
    });

    const staleClear = reduceViewerPresentation(blocked, {
      type: "autoplay-cleared",
      generation: 3,
    });
    expect(deriveViewerPresentation(staleClear).showPlay).toBe(true);

    const cleared = reduceViewerPresentation(blocked, {
      type: "autoplay-cleared",
      generation: 4,
    });
    expect(deriveViewerPresentation(cleared)).toMatchObject({
      stage: "receiving",
      showPlay: false,
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

  it("keeps a proven old frame through recovery without accepting stale proof", () => {
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
      stage: "preparing-sfu",
      overlay: "status",
      hasCurrentFrame: false,
      hasRetainedFrame: true,
    });

    const staleProof = reduceViewerPresentation(recovering, {
      type: "frame-presented",
      generation: 5,
      revision: 5,
    });
    expect(staleProof).toBe(recovering);

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
      notice: "信令正在恢复，画面仍在播放",
    });
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
      showPlay: false,
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
      retryAvailable: false,
    });
  });
});
