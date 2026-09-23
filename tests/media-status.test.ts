import { describe, expect, it } from "vitest";
import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  deriveViewerPresentation,
  reduceViewerPresentation,
  type ViewerPresentationAction,
} from "../src/client/media/viewer-presentation";
import { deriveHostStatus, deriveParticipantStatus, deriveViewerStatus } from "../src/client/ui/media-status";

const playingActions: ViewerPresentationAction[] = [
  { type: "access", access: "ready" },
  { type: "host", host: "online" },
  { type: "signal", signal: "connected" },
  { type: "route", revision: 1, phase: "active", kind: "p2p" },
  { type: "media-bound", generation: 1, revision: 1 },
  { type: "frame-presented", generation: 1, revision: 1, proofEpoch: 0 },
];
const presentation = (...extra: ViewerPresentationAction[]) => deriveViewerPresentation(
  [...playingActions, ...extra].reduce(reduceViewerPresentation, INITIAL_VIEWER_PRESENTATION_STATE),
);

describe("media status projection", () => {
  it.each(["p2p", "sfu"] as const)("keeps %s setup distinct from proved playback", route => {
    const receiving = deriveViewerPresentation(playingActions.slice(0, -1)
      .reduce(reduceViewerPresentation, INITIAL_VIEWER_PRESENTATION_STATE));
    const pending = deriveViewerStatus(receiving, "connected", route);
    expect(pending.overlay?.status.comic).toBe(route === "sfu" ? "connecting-sfu" : "connecting-p2p");
    expect(pending.titleFrameKey).toBe("viewerWaiting");
    const live = deriveViewerStatus(presentation(), "connected", route);
    expect(live.television.tone).toBe("live");
    expect(live.overlay).toBeNull();
    expect(live.titleFrameKey).toBe("viewerActive");
  });

  it("separates signaling recovery from media loss", () => {
    const signaling = deriveViewerStatus(presentation({ type: "signal", signal: "reconnecting" }), "reconnecting");
    expect(signaling.connection.tone).toBe("warn");
    expect(signaling.television.tone).toBe("live");
    expect(signaling.overlay).toBeNull();
    expect(signaling.activity.labelKey).toBe("viewer.msg.playing");
    expect(signaling.notice?.comic).toBe("signal-recovering");
    const failed = deriveViewerStatus(presentation({ type: "route-status", revision: 1, state: "failed" }), "connected");
    expect(failed.television.tone).toBe("bad");
    expect(failed.overlay?.mode).toBe("status");
    expect(failed.titleFrameKey).toBe("viewerUnavailable");
    expect(failed.connection.tone).toBe("live");
    const tapToPlay = deriveViewerStatus(presentation({ type: "autoplay-blocked", generation: 1, revision: 1 }), "connected");
    expect(tapToPlay.titleFrameKey).toBe("viewerReady");
  });

  it.each(["reconnecting", "failed"] as const)("shows media recovery only on the television: %s", (connection) => {
    const result = deriveViewerStatus(presentation({ type: "connection", revision: 1, connection }), "connected");
    expect(result.television).toMatchObject({
      tone: "warn", icon: "refresh", labelKey: "viewer.msg.recovering",
    });
    expect(result.notice).toBeNull();
    expect(result.overlay).toBeNull();
    expect(result.connection.tone).toBe("live");
    const recovered = deriveViewerStatus(presentation({ type: "connection", revision: 1, connection: "connected" }), "connected");
    expect(recovered.television.labelKey).toBe("viewer.msg.playing");
    expect(recovered.notice).toBeNull();
  });

  it("keeps the independent Host availability notice alongside a current picture", () => {
    const result = deriveViewerStatus(presentation({ type: "host", host: "offline" }), "connected");
    expect(result.television.labelKey).toBe("viewer.msg.playing");
    expect(result.notice?.labelKey).toBe("viewer.notice.hostOffline");
    expect(result.overlay).toBeNull();
  });

  it.each(["reconnecting", "failed"] as const)("does not let coexisting notices hide media %s", connection => {
    for (const host of ["online", "offline"] as const) {
      for (const signal of ["connected", "reconnecting"] as const) {
        const state = [
          ...playingActions,
          { type: "host", host } as const,
          { type: "signal", signal } as const,
          { type: "connection", revision: 1, connection } as const,
        ].reduce(reduceViewerPresentation, INITIAL_VIEWER_PRESENTATION_STATE);
        const status = deriveViewerStatus(deriveViewerPresentation(state), signal);
        expect(status.television).toMatchObject({ tone: "warn", comic: "recovering" });
        expect(status.overlay).toBeNull();
        expect(status.notice?.labelKey ?? null).toBe(host === "offline"
          ? "viewer.notice.hostOffline" : signal === "reconnecting" ? "viewer.notice.signalRecovering" : null);
        const recovered = reduceViewerPresentation(state, { type: "frame-presented", generation: 1, revision: 1, proofEpoch: 0 });
        const healthy = deriveViewerStatus(deriveViewerPresentation(recovered), signal);
        expect(healthy.television).toMatchObject({ tone: "live", labelKey: "viewer.msg.playing" });
        expect(healthy.notice).toEqual(status.notice);
      }
    }
  });

  it.each([
    ["unknown", "viewer.msg.waitingHost", "waiting-for-host", "viewerWaiting"],
    ["stopped", "viewer.msg.waitingHost", "waiting-for-host", "viewerWaiting"],
    ["offline", "viewer.msg.hostOffline", "host-offline", "viewerUnavailable"],
    ["paused", "viewer.msg.hostPaused", "host-paused", "paused"],
  ] as const)("explains absent Host %s instead of exhausted routes in either event order", (host, labelKey, comic, titleFrameKey) => {
    const absence: ViewerPresentationAction = { type: "host", host };
    const failure: ViewerPresentationAction = { type: "route-status", revision: 1, state: "failed" };
    for (const hadPicture of [false, true]) {
      for (const kind of ["p2p", "sfu"] as const) {
        for (const order of [[absence, failure], [failure, absence]]) {
          const state = [
            ...(hadPicture ? playingActions : playingActions.slice(0, 4)),
            { type: "route", revision: 1, phase: "active", kind } as const,
            ...order,
          ].reduce(reduceViewerPresentation, INITIAL_VIEWER_PRESENTATION_STATE);
          const status = deriveViewerStatus(deriveViewerPresentation(state), "connected", kind);
          expect(status).toMatchObject({
            television: { labelKey, comic },
            overlay: { mode: hadPicture ? "status" : "blocking", status: { labelKey, comic } },
            titleFrameKey,
          });
          // Host return cannot by itself turn an exhausted route into a healthy one.
          expect(state.routeStatus).toEqual({ revision: 1, state: "failed" });
          const returned = reduceViewerPresentation(state, { type: "host", host: "online" });
          expect(deriveViewerPresentation(returned).stage).toBe("route-failed");
        }
      }
    }
  });

  it("keeps Host source activity separate from signaling and ignores a previous share's pause", () => {
    const sharing = deriveHostStatus({ phase: "live", paused: false, signal: "reconnecting", roomReady: true });
    expect(sharing.television.tone).toBe("live");
    expect(sharing.connection.tone).toBe("warn");
    expect(sharing.titleFrameKey).toBe("hostActive");
    const failed = deriveHostStatus({ phase: "error", paused: true, signal: "connected", roomReady: true });
    expect(failed.television.tone).toBe("bad");
    expect(failed.connection.tone).toBe("live");
    expect(failed.titleFrameKey).toBe("hostUnavailable");
  });

  it("keeps intentional closure and interrupted sharing distinct in the title and source indicator", () => {
    const closed = deriveViewerStatus(presentation({ type: "access", access: "denied", failure: "ROOM_CLOSED" }), "offline");
    expect(closed.activity).toMatchObject({ tone: "off", comic: "room-closed" });
    expect(closed.titleFrameKey).toBe("viewerClosed");
    expect(closed.titleMarker).toBeNull();
    const ended = { phase: "ended", paused: false, signal: "connected", roomReady: true } as const;
    expect(deriveHostStatus(ended).titleMarker).toBeNull();
    const failed = deriveHostStatus({ ...ended, sourceNotice: { tone: "bad", tooltip: "source-failed" } });
    expect(failed.television).toMatchObject({ tone: "bad", tooltip: "source-failed" });
    expect(failed.titleFrameKey).toBe("hostEnded");
    expect(failed.titleMarker).toBe("⚠️");
  });

  it("shows the assigned transport without claiming first-frame readiness during setup", () => {
    expect(deriveParticipantStatus({ mediaReady: false, upstream: { kind: "sfu" } }, true))
      .toMatchObject({ tone: "busy", comic: "connecting-sfu" });
    expect(deriveParticipantStatus({ mediaReady: false, upstream: { kind: "none" } }, true))
      .toMatchObject({ labelKey: "state.peer.routing", comic: "signal-connecting" });
    expect(deriveParticipantStatus({ mediaReady: true, upstream: { kind: "sfu" } }, true))
      .toMatchObject({ tone: "live", comic: "media-ready" });
  });
});
