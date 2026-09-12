import { describe, expect, it } from "vitest";
import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  deriveViewerPresentation,
  reduceViewerPresentation,
  type ViewerPresentationAction,
} from "../src/client/media/viewer-presentation";
import { deriveHostStatus, deriveViewerStatus, peerConnectionStatus } from "../src/client/ui/media-status";

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
  it("annotates quality without masking playback, and releases stale warnings", () => {
    const current = presentation();
    const limited = deriveViewerStatus(current, "connected", { reason: "bandwidth", fresh: true });
    expect(limited.television.tone).toBe("warn");
    expect(limited.overlay).toBeNull();
    expect(limited.titleFrameKey).toBe("viewerActive");
    expect(limited.connection.tone).toBe("live");
    for (const observation of [{ reason: "none", fresh: true }, { reason: "bandwidth", fresh: false }] as const) {
      const result = deriveViewerStatus(current, "connected", observation);
      expect(result.television.tone).toBe("live");
      expect(result.quality.tone).toBe(observation.fresh ? "live" : "off");
      expect(result.titleMarker).toBeNull();
    }
  });

  it("separates signaling recovery from media loss and keeps failure above quality", () => {
    const signaling = deriveViewerStatus(presentation({ type: "signal", signal: "reconnecting" }), "reconnecting");
    expect(signaling.connection.tone).toBe("warn");
    expect(signaling.television.tone).toBe("live");
    expect(signaling.overlay).toBeNull();
    expect(signaling.activity.labelKey).toBe("viewer.msg.playing");
    expect(signaling.notice?.comic).toBe("signal-recovering");
    const failed = deriveViewerStatus(presentation({ type: "route-status", revision: 1, state: "failed" }), "connected", { reason: "cpu", fresh: true });
    expect(failed.television.tone).toBe("bad");
    expect(failed.overlay?.mode).toBe("status");
    expect(failed.titleFrameKey).toBe("viewerUnavailable");
    expect(failed.connection.tone).toBe("live");
    const tapToPlay = deriveViewerStatus(presentation({ type: "autoplay-blocked", generation: 1, revision: 1 }), "connected");
    expect(tapToPlay.titleFrameKey).toBe("viewerReady");
  });

  it("does not turn transient ICE loss or intentional retirement into failure", () => {
    expect(peerConnectionStatus("disconnected").tone).toBe("warn");
    expect(peerConnectionStatus("failed").tone).toBe("bad");
    expect(peerConnectionStatus("closed").tone).toBe("off");
  });

  it.each(["reconnecting", "failed"] as const)("shows media recovery only on the television: %s", (connection) => {
    const result = deriveViewerStatus(presentation({ type: "connection", revision: 1, connection }), "connected");
    expect(result.television).toMatchObject({
      tone: "warn", icon: "refresh", labelKey: "viewer.notice.mediaRecovering",
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
});
