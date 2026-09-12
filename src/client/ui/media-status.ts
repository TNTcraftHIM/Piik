// One visual vocabulary; facts stay with the media/session owners. This module
// only projects current facts. It has no state, timers, scores or recovery work.
import type { ComicKind, HintKind } from "./visual-kinds";
import type { ViewerPresentation, ViewerStage } from "../media/viewer-presentation";
import type { SignalConnectionState } from "../types";
import type { MediaRouteUpstream } from "../../shared/protocol";
import { qualityEvidenceUpstreamMatches, type ViewerQualityEvidencePresentation } from "../media/viewer-quality-evidence";
import type { CopyKey, TitleFrameKey } from "./copy";
import type { GlyphName } from "./icons";

export interface StatusDescriptor {
  tone: "off" | "busy" | "live" | "warn" | "bad";
  labelKey: CopyKey;
  icon: GlyphName;
  comic?: ComicKind;
  tooltip?: ComicKind | HintKind;
  pulse?: boolean;
}

export interface QualityObservation {
  // Only the current, matching media path; callers own identity and freshness.
  // A relay's outbound limitation says nothing about its own received picture.
  reason: RTCQualityLimitationReason | "unknown";
  fresh: boolean;
}

export const STATUS_CATALOG = {
  idle: { tone: "off", labelKey: "state.peer.waiting", icon: "moon", comic: "waiting-for-host" },
  connected: { tone: "live", labelKey: "state.peer.connected", icon: "check" },
  joining: { tone: "busy", labelKey: "state.peer.connecting", icon: "loader", comic: "connecting-p2p", pulse: true },
  reconnecting: { tone: "warn", labelKey: "state.peer.reconnecting", icon: "refresh", comic: "recovering", pulse: true },
  disconnected: { tone: "bad", labelKey: "state.peer.disconnected", icon: "wifiOff", comic: "route-failed" },
  qualityUnknown: { tone: "off", labelKey: "stats.unknown", icon: "gauge" },
  qualityNormal: { tone: "live", labelKey: "stats.quality.normal", icon: "check" },
  stuttering: { tone: "warn", labelKey: "state.peer.stuttering", icon: "wave", comic: "warning" },
  bandwidth: { tone: "warn", labelKey: "stats.quality.bandwidth", icon: "gauge", comic: "bandwidth-limited" },
  cpu: { tone: "warn", labelKey: "stats.quality.cpu", icon: "cpu", comic: "encoder-limited" },
  other: { tone: "warn", labelKey: "stats.quality.other", icon: "alert", comic: "warning" },
} as const satisfies Record<string, StatusDescriptor>;

export function deriveParticipantStatus(
  participant: { mediaReady?: boolean; upstream: MediaRouteUpstream },
  sourceActive: boolean,
  presentation?: ViewerQualityEvidencePresentation,
): StatusDescriptor {
  // Room authority owns readiness. Receive evidence can annotate it, not
  // convert a pending path into connected or a missing sample into failure.
  if (!participant.mediaReady) {
    if (!sourceActive) return STATUS_CATALOG.idle;
    return { ...STATUS_CATALOG.joining,
      labelKey: participant.upstream.kind === "none" ? "state.peer.routing" : "state.peer.connecting" };
  }
  if (sourceActive && presentation?.fresh &&
      qualityEvidenceUpstreamMatches(presentation.evidence, participant.upstream)) {
    const { freezeCountDelta, freezeDurationMsDelta } = presentation.evidence.metrics;
    if ((freezeCountDelta ?? 0) > 0 || (freezeDurationMsDelta ?? 0) > 0) return STATUS_CATALOG.stuttering;
  }
  return STATUS_CATALOG.connected;
}

// Exhaustive stage mapping replaces the separate overlay/icon/lamp switches.
// Stage identity and priority still come from the existing presentation reducer.
const STAGE_VISUALS = {
  joining: { tone: "busy", icon: "loader", comic: "signal-connecting", pulse: true },
  "room-not-found": { tone: "bad", icon: "door", comic: "room-not-found" },
  "access-denied": { tone: "bad", icon: "lock", comic: "access-denied" },
  "invalid-invite": { tone: "bad", icon: "lock", comic: "invalid-invite" },
  "room-closed": { tone: "off", icon: "door", comic: "room-not-found" },
  "room-full": { tone: "bad", icon: "users", comic: "room-full" },
  "stale-client": { tone: "bad", icon: "alert", comic: "warning" },
  "server-error": { tone: "bad", icon: "alert", comic: "warning" },
  "session-replaced": { tone: "bad", icon: "alert", comic: "warning" },
  "signal-terminated": { tone: "bad", icon: "wifiOff", comic: "warning" },
  "host-paused": { tone: "warn", icon: "pause", comic: "host-paused" },
  "needs-play": { tone: "busy", icon: "play", comic: "tap-to-play" },
  playing: { tone: "live", icon: "play" },
  recovering: { tone: "warn", icon: "refresh", comic: "recovering", pulse: true },
  "route-failed": { tone: "bad", icon: "wifiOff", comic: "route-failed" },
  "playback-failed": { tone: "bad", icon: "alert", comic: "playback-failed" },
  "waiting-host": { tone: "off", icon: "moon", comic: "waiting-for-host" },
  "host-offline": { tone: "bad", icon: "wifiOff", comic: "host-offline" },
  "waiting-sfu": { tone: "busy", icon: "loader", comic: "connecting-sfu", pulse: true },
  "preparing-p2p": { tone: "busy", icon: "loader", comic: "connecting-p2p", pulse: true },
  "preparing-sfu": { tone: "busy", icon: "loader", comic: "connecting-sfu", pulse: true },
  receiving: { tone: "busy", icon: "loader", pulse: true },
  allocating: { tone: "busy", icon: "loader", comic: "signal-connecting", pulse: true },
} as const satisfies Record<ViewerStage, Omit<StatusDescriptor, "labelKey">>;

function qualityWarning(observation?: QualityObservation): StatusDescriptor | null {
  if (!observation?.fresh) return null;
  switch (observation.reason) {
    case "bandwidth": return STATUS_CATALOG.bandwidth;
    case "cpu": return STATUS_CATALOG.cpu;
    case "other": return STATUS_CATALOG.other;
    default: return null;
  }
}

export function peerConnectionStatus(state: RTCPeerConnectionState): StatusDescriptor {
  // WebRTC disconnected can recover. Red is reserved for a confirmed failure,
  // not a temporary loss of checks; closed is intentional retirement/idle.
  switch (state) {
    case "connected": return STATUS_CATALOG.connected;
    case "disconnected": return STATUS_CATALOG.reconnecting;
    case "failed": return STATUS_CATALOG.disconnected;
    case "closed": return STATUS_CATALOG.idle;
    default: return STATUS_CATALOG.joining;
  }
}

export type HostPhase = "idle" | "starting" | "live" | "ended" | "error";

const HOST_VISUALS = {
  idle: { ...STATUS_CATALOG.idle, labelKey: "host.notStarted" },
  starting: { tone: "busy", icon: "cast", tooltip: "hint-share-start", pulse: true, labelKey: "host.starting" },
  live: { tone: "live", icon: "play", labelKey: "host.live" },
  ended: { ...STATUS_CATALOG.idle, labelKey: "host.ended" },
  error: { tone: "bad", icon: "alert", comic: "warning", labelKey: "host.fail.start" },
} as const satisfies Record<HostPhase, StatusDescriptor>;

const SIGNAL_VISUALS = {
  connected: { ...STATUS_CATALOG.connected, labelKey: "state.signal.connected" },
  connecting: { ...STATUS_CATALOG.joining, comic: "signal-connecting", labelKey: "state.signal.connecting" },
  reconnecting: { ...STATUS_CATALOG.reconnecting, comic: "signal-recovering", labelKey: "state.signal.reconnecting" },
  offline: { tone: "off", icon: "wifiOff", comic: "signal-offline", labelKey: "state.signal.offline" },
} as const satisfies Record<SignalConnectionState, StatusDescriptor>;

export function deriveHostStatus({ phase, paused, signal, roomReady }: {
  phase: HostPhase; paused: boolean; signal: SignalConnectionState; roomReady: boolean;
}) {
  const activity: StatusDescriptor = phase === "live" && paused
    ? { tone: "warn", icon: "pause", comic: "host-paused", labelKey: "host.paused" }
    : phase === "idle" && roomReady
      ? { ...HOST_VISUALS.idle, labelKey: "host.roomReady" }
      : HOST_VISUALS[phase];
  const titleFrameKey: TitleFrameKey = phase === "live" ? paused ? "paused" : "hostActive"
    : phase === "starting" ? "hostStarting"
    : phase === "error" ? "hostUnavailable"
    : phase === "ended" ? "hostEnded"
    : roomReady ? "hostReady" : "hostIdle";
  return {
    activity,
    // The Host television is a local source preview. A weak outbound child
    // belongs on that child's status, not on the Host's source lamp.
    television: activity,
    connection: SIGNAL_VISUALS[signal] as StatusDescriptor,
    titleFrameKey,
    titleMarker: phase === "live" && signal !== "connected" ? "⚠️" : null,
  };
}

export function deriveViewerStatus(
  presentation: ViewerPresentation,
  signal: SignalConnectionState,
  observation?: QualityObservation,
  route: "p2p" | "sfu" | null = null,
) {
  // Control recovery does not interrupt a picture that remains proved.
  const mediaRecovering = presentation.noticeKey === "viewer.notice.mediaRecovering";
  const playable = presentation.overlay === "none" && !mediaRecovering;
  const stage = playable ? "playing" : presentation.stage;
  const activity: StatusDescriptor = {
    ...STAGE_VISUALS[stage],
    labelKey: mediaRecovering ? "viewer.notice.mediaRecovering"
      : playable ? "viewer.msg.playing" : presentation.messageKey,
    ...(stage === "receiving" ? { comic: route === "sfu" ? "connecting-sfu" as const : "connecting-p2p" as const } : {}),
  };
  const warning = qualityWarning(observation);
  const quality: StatusDescriptor = warning ?? (observation?.fresh && observation.reason === "none"
    ? STATUS_CATALOG.qualityNormal : STATUS_CATALOG.qualityUnknown);
  let notice: StatusDescriptor | null = null;
  switch (presentation.noticeKey) {
    case "viewer.notice.hostOffline":
      notice = { tone: "warn", icon: "wifiOff", comic: "host-offline", labelKey: presentation.noticeKey };
      break;
    case "viewer.notice.signalRecovering":
      notice = { ...SIGNAL_VISUALS.reconnecting, icon: "signal", labelKey: presentation.noticeKey };
      break;
  }
  const overlay = presentation.overlay === "none"
    ? null
    : { mode: presentation.overlay, status: activity };
  const television: StatusDescriptor = playable
    ? warning ?? activity
    : activity;
  const connection: StatusDescriptor = SIGNAL_VISUALS[signal];
  const titleFrameKey: TitleFrameKey = presentation.stage === "host-paused"
    ? "paused"
    : presentation.stage === "needs-play" ? "viewerReady"
    : activity.tone === "bad" ? "viewerUnavailable"
    : !overlay && presentation.hasCurrentFrame ? "viewerActive"
    : "viewerWaiting";
  return {
    activity, television, connection, quality, notice, overlay,
    titleFrameKey,
    titleMarker: !overlay && (television.tone === "warn" || notice) ? "⚠️" : null,
  };
}
