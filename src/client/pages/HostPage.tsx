import {
  Check,
  Copy,
  Globe2,
  Hash,
  KeyRound,
  LockKeyhole,
  Maximize2,
  MonitorUp,
  Network,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOST_DISPLAY_NAME_PREFIX,
  DEFAULT_QUALITY_SETTINGS,
  MAX_VIEWER_PASSWORD_LENGTH,
  viewerPasswordSchema,
  type CreateRoomResponse,
  type IceConfig,
  type ParticipantPresenceEntry,
  type ServerMessage,
  type ViewerAccessPolicy,
} from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import { ConnectionSelfCheck } from "../components/ConnectionSelfCheck";
import { ConnectionDetailsToggle } from "../components/ConnectionDetailsToggle";
import { RoomCode } from "../components/RoomCode";
import { RoomCodeEntry } from "../components/RoomCodeEntry";
import { qualityLimitationSummary } from "../components/connection-details";
import {
  MediaRouteBadge,
  PathBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { TopologyView } from "../components/TopologyView";
import { hasPeerRouteEvidence } from "../components/status-badge-model";
import { ApiError, createRoom } from "../lib/api";
import { createOpaqueId } from "../lib/opaque-id";
import { downloadDiagnosticReport, type DiagnosticConnectionInput } from "../lib/diagnostic-export";
import {
  defaultHostDisplayName,
  readDisplayName,
  saveDisplayName,
} from "../lib/display-name";
import {
  clearHostRoom,
  clearViewerGrant,
  getStableClientId,
  type HostRoomIdentity,
  type HostRoomState,
  isHostRoomExpired,
  mergeAuthenticatedHostRoom,
  readHostRoom,
  replaceViewerInvite,
  writeHostRoom,
} from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import { labelParticipantSnapshot } from "../lib/viewer-presence";
import {
  applyCaptureProfile,
  captureDisplay,
  DEGRADATION_PREFERENCE_LABELS,
  matchingQualityProfileId,
  QUALITY_PROFILES,
  QUALITY_PROFILE_LABELS,
  QUALITY_RESOLUTIONS,
  qualitySettingsLabel,
  resolveScreenAudioQuality,
  SCREEN_AUDIO_QUALITY_LABELS,
  setMediaPaused,
  type DegradationPreference,
  type QualityProfileId,
  type QualitySettings,
  type ScreenAudioQuality,
  type VideoCodecPreference,
  VIDEO_CODEC_PREFERENCE_LABELS,
} from "../media/quality";
import {
  HostSfuRoute,
  type HostSfuPublisherSnapshot,
} from "../media/host-sfu-route";
import {
  HostProvisionalChild,
} from "../media/host-provisional-child";
import {
  ParentEdgeQualityEvidenceReporter,
} from "../media/parent-edge-quality-evidence";
import { SfuStandbyPrewarmer } from "../media/sfu-standby-prewarmer";
import {
  classifyHostViewerQualityEvidence,
  freshViewerQualityEvidence,
  metricsFromQualityEvidence,
  nextViewerQualityEvidencePresentationExpiryAt,
  presentViewerQualityEvidence,
  reconcileViewerQualityEvidencePresentation,
  refreshViewerQualityEvidencePresentation,
  type ViewerQualityEvidencePresentation,
} from "../media/viewer-quality-evidence";
import type {
  PeerSnapshot,
  SignalConnectionState,
} from "../types";
import { HostPeer } from "../webrtc/host-peer";
import {
  MAX_HOST_MEDIA_CHILDREN,
  reconcileBoundedMediaChildren,
} from "../webrtc/media-assignment";
import {
  screenAudioQualityLockNotice,
  shouldPauseLocalPreview,
  sourceSwitchNotice,
  videoCodecLockNotice,
} from "./host-page-notices";

type HostPhase = "idle" | "starting" | "live" | "ended" | "error";

type ViewerQualityEvidence = Extract<
  ServerMessage,
  { type: "viewer-quality-evidence" }
>;
type SelectedEdgeTurn = Extract<
  ServerMessage,
  { type: "selected-edge-turn"; edgeKind: "peer-selected" }
>;
type HostRouteAssignment = Extract<
  ServerMessage,
  { type: "route-update" }
>["assignment"];
interface ActiveSelectedHostChild {
  peerId: string;
  connectionId: string;
  currentRouteRevision: number;
  pendingCarryRevision: number | null;
}
interface FailedActiveHostChild {
  revision: number;
  peerId: string;
}

interface CaptureDetails {
  resolution: string;
  frameRate: number | null;
  hasAudio: boolean;
}

function captureDetails(stream: MediaStream): CaptureDetails {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  return {
    resolution:
      settings?.width && settings.height
        ? `${settings.width}x${settings.height}`
        : "未知",
    frameRate: settings?.frameRate ?? null,
    hasAudio: stream.getAudioTracks().length > 0,
  };
}

function readableError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "屏幕选择已取消或没有共享权限";
  }
  return error instanceof Error && error.message ? error.message : "启动分享失败";
}

function closeAbandonedRoom(room: HostRoomIdentity): void {
  try {
    const signal = new SignalingClient(
      {
        roomId: room.roomId,
        role: "host",
        token: room.hostToken,
        clientId: getStableClientId("host", room.roomId),
        shareGeneration: createOpaqueId(),
      },
      {
        onMessage: () => undefined,
        onStatus: () => undefined,
        onTerminated: () => undefined,
        onAccessRequired: () => undefined,
      },
    );
    signal.start();
    signal.sendThenStop({ type: "abandon-room" });
  } catch {
    // Best effort only: cancellation must not revive the obsolete generation.
  }
}

function hostRoomFromStored(room: HostRoomIdentity | null): HostRoomState | null {
  return room
    ? {
        ...room,
        viewerPolicy: null,
        inviteUrl: null,
      }
    : null;
}

function hostRoomFromCreated(room: CreateRoomResponse): HostRoomState {
  replaceViewerInvite(room.roomId, room.inviteUrl);
  const canonicalUrl = new URL(room.inviteUrl);
  canonicalUrl.hash = "";
  canonicalUrl.search = "";
  return {
    roomId: room.roomId,
    hostToken: room.hostToken,
    expiresAt: room.expiresAt,
    canonicalUrl: canonicalUrl.toString(),
    viewerPolicy: room.viewerPolicy,
    inviteUrl: room.inviteUrl,
  };
}

interface HostPageProps {
  onAuthorizationRequired?: () => void;
}

export function HostPage({ onAuthorizationRequired }: HostPageProps = {}) {
  const [qualitySettings, setQualitySettings] = useState<QualitySettings>(
    DEFAULT_QUALITY_SETTINGS,
  );
  const [advancedQuality, setAdvancedQuality] = useState<QualitySettings>(
    DEFAULT_QUALITY_SETTINGS,
  );
  const shareGenerationRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<HostPhase>("idle");
  const [signalStatus, setSignalStatus] =
    useState<SignalConnectionState>("offline");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [details, setDetails] = useState<CaptureDetails | null>(null);
  const [room, setRoom] = useState<HostRoomState | null>(() =>
    hostRoomFromStored(readHostRoom()),
  );
  const [newRoomViewerPolicy, setNewRoomViewerPolicy] =
    useState<ViewerAccessPolicy>("private-link");
  const [viewerAccessUpdating, setViewerAccessUpdating] = useState(false);
  const [viewerPasswordEnabled, setViewerPasswordEnabled] = useState(false);
  const [viewerPasswordDraft, setViewerPasswordDraft] = useState("");
  const [viewerPasswordUpdating, setViewerPasswordUpdating] = useState(false);
  const [maxViewers, setMaxViewers] = useState<number | null>(null);
  const [peerSnapshots, setPeerSnapshots] = useState<Map<string, PeerSnapshot>>(
    () => new Map(),
  );
  const [sfuPublisherSnapshot, setSfuPublisherSnapshot] =
    useState<HostSfuPublisherSnapshot | null>(null);
  const [participantPresence, setParticipantPresence] = useState<
    ParticipantPresenceEntry[]
  >([]);
  const [displayName, setDisplayName] = useState(() => readDisplayName());
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [viewerQualityEvidence, setViewerQualityEvidence] = useState<
    Map<string, ViewerQualityEvidencePresentation>
  >(() => new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [changingQuality, setChangingQuality] = useState(false);
  const [sharingPaused, setSharingPaused] = useState(false);
  const [localPreviewPaused, setLocalPreviewPaused] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [joiningRoom, setJoiningRoom] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const displayNameRef = useRef(displayName);
  const hostClientIdRef = useRef<string | null>(null);
  const viewerPasswordActionRef = useRef<"set" | "remove" | null>(null);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const peersRef = useRef(new Map<string, HostPeer>());
  const retiredConnectionsRef = useRef(new Map<string, string>());
  const selectedHostChildRef = useRef<ActiveSelectedHostChild | null>(null);
  const hostProvisionalChildRef = useRef<HostProvisionalChild | null>(null);
  const failedActiveHostChildRef = useRef<FailedActiveHostChild | null>(null);
  const activeHostChildPeerIdsRef = useRef<string[]>([]);
  const hostPeerIdRef = useRef<string | null>(null);
  const viewerQualityEvidenceRef = useRef(
    new Map<string, ViewerQualityEvidencePresentation>(),
  );
  const viewerQualityEvidenceTimersRef = useRef(
    new Map<string, number>(),
  );
  const parentEdgeQualityEvidenceReporterRef = useRef(
    new ParentEdgeQualityEvidenceReporter(),
  );
  const peerAssistedRef = useRef(false);
  const activeRouteRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const sourceSwitchRef = useRef<object | null>(null);
  const qualityChangeRef = useRef<object | null>(null);
  const qualitySettingsRef = useRef<QualitySettings>(DEFAULT_QUALITY_SETTINGS);
  const sharingPausedRef = useRef(false);
  const retiringStreamRef = useRef<MediaStream | null>(null);
  const hostSfuRouteRef = useRef<HostSfuRoute | null>(null);
  const sfuStandbyPrewarmerRef = useRef<SfuStandbyPrewarmer | null>(null);

  const mediaViewers = useMemo(
    () => Array.from(peerSnapshots.values()),
    [peerSnapshots],
  );
  const { host: labeledHostPresence, viewers } = useMemo(
    () => labelParticipantSnapshot(participantPresence),
    [participantPresence],
  );
  const hostPresence = useMemo(
    () =>
      participantPresence.find(
        (participant): participant is Extract<
          ParticipantPresenceEntry,
          { role: "host" }
        > => participant.role === "host",
      ) ?? null,
    [participantPresence],
  );
  const diagnosticConnections: DiagnosticConnectionInput[] = [];
  if (sfuPublisherSnapshot) {
    diagnosticConnections.push({
      scope: "host-sfu",
      route: "sfu",
      direction: "send",
      metrics: sfuPublisherSnapshot.metrics,
    });
  }
  for (const viewer of viewers) {
    const snapshot =
      viewer.upstream.kind === "peer" &&
      viewer.upstream.peerId ===
        (hostPresence?.peerId ?? hostPeerIdRef.current)
        ? peerSnapshots.get(viewer.peerId)
        : undefined;
    if (snapshot && hasPeerRouteEvidence(snapshot)) {
      diagnosticConnections.push({
        scope: "viewer-edge",
        route: "p2p",
        direction: "send",
        connectionState: snapshot.connectionState,
        iceConnectionState: snapshot.iceConnectionState,
        metrics: snapshot.metrics,
      });
    }
    const presentation = viewerQualityEvidence.get(viewer.peerId);
    const evidence = freshViewerQualityEvidence(presentation);
    if (
      viewer.upstream.kind === "peer" &&
      evidence?.parentPeerId === viewer.upstream.peerId
    ) {
      diagnosticConnections.push({
        scope: "viewer-edge",
        route: "p2p",
        direction: "receive",
        metrics: metricsFromQualityEvidence(evidence),
      });
    }
  }
  const selectedQualityProfileId = useMemo(
    () => matchingQualityProfileId(qualitySettings),
    [qualitySettings],
  );
  const qualityLimitation = useMemo(
    () => qualityLimitationSummary(mediaViewers),
    [mediaViewers],
  );

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    const syncPreviewPlayback = () => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const shouldPause = shouldPauseLocalPreview(
        document.visibilityState,
        document.hasFocus(),
      );
      setLocalPreviewPaused(shouldPause);
      if (shouldPause) {
        video.pause();
        return;
      }
      if (streamRef.current) {
        void video.play().catch(() => undefined);
      }
    };

    document.addEventListener("visibilitychange", syncPreviewPlayback);
    window.addEventListener("blur", syncPreviewPlayback);
    window.addEventListener("focus", syncPreviewPlayback);
    syncPreviewPlayback();
    return () => {
      document.removeEventListener("visibilitychange", syncPreviewPlayback);
      window.removeEventListener("blur", syncPreviewPlayback);
      window.removeEventListener("focus", syncPreviewPlayback);
    };
  }, [stream]);

  useEffect(
    () => () => {
      activeGenerationRef.current = null;
      generationRef.current += 1;
      sourceSwitchRef.current = null;
      qualityChangeRef.current = null;
      signalRef.current?.stop();
      peersRef.current.forEach((peer) => peer.dispose());
      peersRef.current.clear();
      retiredConnectionsRef.current.clear();
      selectedHostChildRef.current = null;
      hostProvisionalChildRef.current?.discard();
      hostProvisionalChildRef.current = null;
      failedActiveHostChildRef.current = null;
      activeHostChildPeerIdsRef.current = [];
      hostPeerIdRef.current = null;
      viewerQualityEvidenceTimersRef.current.forEach((timer) =>
        window.clearTimeout(timer),
      );
      viewerQualityEvidenceTimersRef.current.clear();
      viewerQualityEvidenceRef.current.clear();
      parentEdgeQualityEvidenceReporterRef.current.reset();
      activeRouteRevisionRef.current = 0;
      void hostSfuRouteRef.current?.disconnect();
      hostSfuRouteRef.current = null;
      sfuStandbyPrewarmerRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      retiringStreamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      retiringStreamRef.current = null;
    },
    [],
  );

  function isCurrentGeneration(generation: number): boolean {
    return (
      generationRef.current === generation &&
      activeGenerationRef.current === generation
    );
  }

  function ensureHostSfuRoute(generation: number): HostSfuRoute {
    const existing = hostSfuRouteRef.current;
    if (existing) {
      return existing;
    }
    let route: HostSfuRoute;
    route = new HostSfuRoute({
      getStream: () => streamRef.current,
      getProfile: () => qualitySettingsRef.current,
      reconcileChildren: (childPeerIds) => {
        if (
          isCurrentGeneration(generation) &&
          hostSfuRouteRef.current === route
        ) {
          reconcilePeerAssistedChildren(childPeerIds, generation);
        }
      },
      send: (message) =>
        isCurrentGeneration(generation) && hostSfuRouteRef.current === route
          ? signalRef.current?.send(message) === true
          : false,
      onPublisherUpdate: (snapshot) => {
        if (
          isCurrentGeneration(generation) &&
          hostSfuRouteRef.current === route
        ) {
          setSfuPublisherSnapshot(snapshot);
        }
      },
    });
    hostSfuRouteRef.current = route;
    return route;
  }

  function clearHostSfuRoute(): void {
    const route = hostSfuRouteRef.current;
    hostSfuRouteRef.current = null;
    setSfuPublisherSnapshot(null);
    sfuStandbyPrewarmerRef.current?.setUrl(null);
    void route?.disconnect();
  }

  function setSfuStandbyUrl(url: string | null | undefined): void {
    if (!url) {
      sfuStandbyPrewarmerRef.current?.setUrl(null);
      return;
    }
    sfuStandbyPrewarmerRef.current ??= new SfuStandbyPrewarmer();
    sfuStandbyPrewarmerRef.current.setUrl(url);
  }

  function showHostSfuQualityWarning(
    route: HostSfuRoute,
    generation: number,
  ): void {
    if (
      isCurrentGeneration(generation) &&
      hostSfuRouteRef.current === route
    ) {
      const warning = route.getQualityWarning();
      if (warning) {
        setNotice(warning);
      }
    }
  }

  function disposeResources(notifyServer: boolean): void {
    sourceSwitchRef.current = null;
    qualityChangeRef.current = null;
    const signal = signalRef.current;
    if (signal) {
      if (notifyServer) {
        const shareGeneration = shareGenerationRef.current;
        if (shareGeneration) {
          signal.send({ type: "stop-sharing", shareGeneration });
        }
      }
      // Never carry a terminal message into a later authentication: the next
      // sharing generation may already be reusing this room.
      signal.stop();
    }
    signalRef.current = null;
    shareGenerationRef.current = null;
    peersRef.current.forEach((peer) => peer.dispose());
    peersRef.current.clear();
    retiredConnectionsRef.current.clear();
    selectedHostChildRef.current = null;
    hostProvisionalChildRef.current?.discard();
    hostProvisionalChildRef.current = null;
    failedActiveHostChildRef.current = null;
    activeHostChildPeerIdsRef.current = [];
    hostPeerIdRef.current = null;
    void hostSfuRouteRef.current?.disconnect();
    hostSfuRouteRef.current = null;
    setSfuPublisherSnapshot(null);
    sfuStandbyPrewarmerRef.current?.setUrl(null);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    retiringStreamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    retiringStreamRef.current = null;
    iceConfigRef.current = null;
    peerAssistedRef.current = false;
    setStream(null);
    setDetails(null);
    setMaxViewers(null);
    setPeerSnapshots(new Map());
    setParticipantPresence([]);
    viewerQualityEvidenceTimersRef.current.forEach((timer) =>
      window.clearTimeout(timer),
    );
    viewerQualityEvidenceTimersRef.current.clear();
    viewerQualityEvidenceRef.current = new Map();
    parentEdgeQualityEvidenceReporterRef.current.reset();
    setViewerQualityEvidence(new Map());
    activeRouteRevisionRef.current = 0;
    setSignalStatus("offline");
    setSwitchingSource(false);
    setChangingQuality(false);
    sharingPausedRef.current = false;
    setSharingPaused(false);
  }

  function forgetRoom(): void {
    clearHostRoom();
    setRoom(null);
    setCopied(false);
  }

  function endSharing(message: string, notifyServer = true): void {
    const generation = activeGenerationRef.current;
    if (generation === null || generationRef.current !== generation) {
      return;
    }
    activeGenerationRef.current = null;
    generationRef.current += 1;
    disposeResources(notifyServer);
    setNotice(message);
    setPhase("ended");
  }

  function updatePeerSnapshot(snapshot: PeerSnapshot): void {
    const presentation = viewerQualityEvidenceRef.current.get(snapshot.peerId);
    if (presentation) {
      const reconciled = reconcileViewerQualityEvidencePresentation(
        presentation,
        snapshot,
      );
      if (reconciled !== presentation) {
        commitViewerQualityEvidence(snapshot.peerId, reconciled);
      }
    }
    setPeerSnapshots((current) => {
      const next = new Map(current);
      next.set(snapshot.peerId, snapshot);
      return next;
    });
  }

  function commitViewerQualityEvidence(
    peerId: string,
    presentation: ViewerQualityEvidencePresentation | null,
  ): void {
    const timer = viewerQualityEvidenceTimersRef.current.get(peerId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      viewerQualityEvidenceTimersRef.current.delete(peerId);
    }
    const current = viewerQualityEvidenceRef.current.get(peerId);
    if (presentation === null && current === undefined) {
      return;
    }
    if (current !== presentation) {
      const next = new Map(viewerQualityEvidenceRef.current);
      if (presentation === null) {
        next.delete(peerId);
      } else {
        next.set(peerId, presentation);
      }
      viewerQualityEvidenceRef.current = next;
      setViewerQualityEvidence(next);
    }
    if (presentation === null) {
      return;
    }

    const nowMs = Date.now();
    const expiryAt = nextViewerQualityEvidencePresentationExpiryAt(
      presentation,
      nowMs,
    );
    if (expiryAt === null) {
      return;
    }
    const expected = presentation;
    const nextTimer = window.setTimeout(() => {
      if (viewerQualityEvidenceRef.current.get(peerId) !== expected) {
        return;
      }
      commitViewerQualityEvidence(
        peerId,
        refreshViewerQualityEvidencePresentation(expected),
      );
    }, Math.max(0, expiryAt - nowMs));
    viewerQualityEvidenceTimersRef.current.set(peerId, nextTimer);
  }

  function clearViewerQualityEvidence(peerId: string): void {
    commitViewerQualityEvidence(peerId, null);
  }

  function clearAllViewerQualityEvidence(): void {
    viewerQualityEvidenceTimersRef.current.forEach((timer) =>
      window.clearTimeout(timer),
    );
    viewerQualityEvidenceTimersRef.current.clear();
    viewerQualityEvidenceRef.current = new Map();
    setViewerQualityEvidence(new Map());
  }

  function acceptViewerQualityEvidence(evidence: ViewerQualityEvidence): void {
    const peer = peersRef.current.get(evidence.viewerPeerId);
    const directSnapshot = peer?.getSnapshot() ?? null;
    const evidenceSource = classifyHostViewerQualityEvidence(
      evidence,
      hostPeerIdRef.current,
      activeRouteRevisionRef.current,
      directSnapshot,
    );
    if (
      !evidenceSource ||
      (evidenceSource === "peer-relayed" && !peerAssistedRef.current)
    ) {
      return;
    }
    if (evidenceSource === "direct") {
      const parentEvidence = parentEdgeQualityEvidenceReporterRef.current.offer(
        evidence,
        directSnapshot,
      );
      if (peerAssistedRef.current && parentEvidence) {
        signalRef.current?.send(parentEvidence);
      }
    }
    commitViewerQualityEvidence(
      evidence.viewerPeerId,
      presentViewerQualityEvidence(
        viewerQualityEvidenceRef.current.get(evidence.viewerPeerId) ?? null,
        evidence,
      ),
    );
  }

  function watchCaptureEnd(
    captured: MediaStream,
    generation: number,
  ): void {
    captured.getVideoTracks()[0]?.addEventListener(
      "ended",
      () => {
        if (
          isCurrentGeneration(generation) &&
          streamRef.current === captured
        ) {
          endSharing("已停止分享");
        }
      },
      { once: true },
    );
  }

  function finishSourceSwitch(token: object): void {
    if (sourceSwitchRef.current !== token) {
      return;
    }
    sourceSwitchRef.current = null;
    setSwitchingSource(false);
  }

  function commitQuality(settings: QualitySettings): void {
    qualitySettingsRef.current = settings;
    setQualitySettings(settings);
    setAdvancedQuality(settings);
  }

  function changeVideoCodec(videoCodec: VideoCodecPreference): void {
    if (phase === "starting" || phase === "live") {
      return;
    }
    const next = { ...qualitySettingsRef.current, videoCodec };
    qualitySettingsRef.current = next;
    setQualitySettings(next);
    setAdvancedQuality((current) => ({ ...current, videoCodec }));
  }

  function changeScreenAudioQuality(
    screenAudioQuality: ScreenAudioQuality,
  ): void {
    if (phase === "starting" || phase === "live") {
      return;
    }
    const next = { ...qualitySettingsRef.current, screenAudioQuality };
    qualitySettingsRef.current = next;
    setQualitySettings(next);
    setAdvancedQuality((current) => ({ ...current, screenAudioQuality }));
  }

  async function changeQuality(nextProfile: QualitySettings): Promise<void> {
    if (
      phase === "live" &&
      ((nextProfile.videoCodec ?? "automatic") !==
        (qualitySettingsRef.current.videoCodec ?? "automatic") ||
        resolveScreenAudioQuality(nextProfile.screenAudioQuality) !==
          resolveScreenAudioQuality(
            qualitySettingsRef.current.screenAudioQuality,
          ))
    ) {
      return;
    }
    if (phase !== "live") {
      commitQuality(nextProfile);
      return;
    }

    const generation = activeGenerationRef.current;
    const activeStream = streamRef.current;
    if (
      generation === null ||
      !activeStream ||
      !isCurrentGeneration(generation) ||
      sourceSwitchRef.current ||
      qualityChangeRef.current
    ) {
      return;
    }

    const token = {};
    qualityChangeRef.current = token;
    setChangingQuality(true);
    setNotice(null);

    try {
      await applyCaptureProfile(activeStream, nextProfile);
      if (
        !isCurrentGeneration(generation) ||
        qualityChangeRef.current !== token ||
        streamRef.current !== activeStream
      ) {
        return;
      }

      commitQuality(nextProfile);
      setDetails(captureDetails(activeStream));
      const roomSettingsSent =
        !peerAssistedRef.current ||
        signalRef.current?.send({
          type: "set-quality-settings",
          qualitySettings: nextProfile,
        }) === true;
      const activeSfuRoute = hostSfuRouteRef.current;
      const [results, sfuUpdated] = await Promise.all([
        Promise.all(
          [
            ...[...peersRef.current.values()].map((peer) =>
              peer.updateProfile(nextProfile),
            ),
            ...(hostProvisionalChildRef.current
              ? [hostProvisionalChildRef.current.updateProfile(nextProfile)]
              : []),
          ],
        ),
        activeSfuRoute?.updateProfile(nextProfile) ??
          Promise.resolve(true),
      ]);
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token
      ) {
        const failed = results.filter((updated) => !updated).length;
        const sfuWarning =
          hostSfuRouteRef.current === activeSfuRoute
            ? (activeSfuRoute?.getQualityWarning() ?? null)
            : null;
        const connectionWarning =
          failed > 0 || !sfuUpdated
            ? "画质已切换，但部分观看连接未能应用新参数"
            : null;
        const syncWarning = roomSettingsSent
          ? null
          : "房间画质同步将在信令重连后继续";
        const warning = [sfuWarning ?? connectionWarning, syncWarning]
          .filter((message): message is string => message !== null)
          .join("；");
        setNotice(
          warning || `画质已切换为 ${qualitySettingsLabel(nextProfile)}`,
        );
      }
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token
      ) {
        setNotice(readableError(error));
      }
    } finally {
      if (qualityChangeRef.current === token) {
        qualityChangeRef.current = null;
        setChangingQuality(false);
      }
    }
  }

  function toggleSharingPause(): void {
    const activeStream = streamRef.current;
    if (phase !== "live" || !activeStream) {
      return;
    }
    const nextPaused = !sharingPausedRef.current;
    if (!setMediaPaused(activeStream, nextPaused)) {
      setNotice("当前分享没有可暂停的媒体轨道");
      return;
    }
    sharingPausedRef.current = nextPaused;
    setSharingPaused(nextPaused);
    signalRef.current?.setSharingPaused(nextPaused);
    setNotice(nextPaused ? "音视频分享已暂停" : "音视频分享已恢复");
  }

  async function enterPreviewFullscreen(): Promise<void> {
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;
    if (!video) {
      return;
    }
    try {
      if (video.requestFullscreen) {
        await video.requestFullscreen();
      } else {
        video.webkitEnterFullscreen?.();
      }
    } catch {
      setNotice("当前浏览器无法放大本地预览");
    }
  }

  function removePeer(peerId: string): void {
    clearViewerQualityEvidence(peerId);
    parentEdgeQualityEvidenceReporterRef.current.forget(peerId);
    const peer = peersRef.current.get(peerId);
    if (peer) {
      retiredConnectionsRef.current.set(peerId, peer.connectionId);
      peer.dispose();
    }
    if (selectedHostChildRef.current?.peerId === peerId) {
      selectedHostChildRef.current = null;
    }
    peersRef.current.delete(peerId);
    setPeerSnapshots((current) => {
      const next = new Map(current);
      next.delete(peerId);
      return next;
    });
  }

  function discardPreparedHostChild(): void {
    const provisional = hostProvisionalChildRef.current;
    hostProvisionalChildRef.current = null;
    provisional?.discard();
  }

  function prepareHostChild(
    revision: number,
    assignment: HostRouteAssignment,
    generation: number,
  ): boolean {
    const stream = streamRef.current;
    const iceConfig = iceConfigRef.current;
    const signal = signalRef.current;
    if (
      !isCurrentGeneration(generation) ||
      !stream ||
      !iceConfig ||
      !signal
    ) {
      discardPreparedHostChild();
      return false;
    }
    hostProvisionalChildRef.current ??= new HostProvisionalChild({
      sendSignal: (targetPeerId, payload) =>
        isCurrentGeneration(generation) && signalRef.current === signal
          ? signal.send({ type: "signal", targetPeerId, payload })
          : false,
      hasActivePeer: (peerId) => peersRef.current.has(peerId),
      onPromotedStreamFailure: (peer) => {
        if (
          isCurrentGeneration(generation) &&
          peersRef.current.get(peer.peerId) === peer
        ) {
          removePeer(peer.peerId);
        }
      },
      onPromotedUpdate: (peer, snapshot) => {
        if (
          isCurrentGeneration(generation) &&
          peersRef.current.get(peer.peerId) === peer
        ) {
          updatePeerSnapshot(snapshot);
        }
      },
    });
    return hostProvisionalChildRef.current.prepare({
      revision,
      assignment,
      activeChildPeerIds: activeHostChildPeerIdsRef.current,
      selectedPeerId: selectedHostChildRef.current?.peerId ?? null,
      maxMediaEdges: MAX_HOST_MEDIA_CHILDREN,
      iceConfig,
      stream,
      profile: qualitySettingsRef.current,
    });
  }

  function activatePreparedHostChild(
    revision: number,
    assignment: HostRouteAssignment,
  ): void {
    const activeChildPeerIds = activeHostChildPeerIdsRef.current;
    const childPeerIds = [...new Set(assignment.childPeerIds)];
    const provisional = hostProvisionalChildRef.current;
    const activation = provisional?.activate({
      revision,
      assignment,
      activeChildPeerIds,
      selectedPeerId: selectedHostChildRef.current?.peerId ?? null,
      maxMediaEdges: MAX_HOST_MEDIA_CHILDREN,
    }) ?? { kind: "ordinary" as const };
    if (activation.kind === "promote") {
      hostProvisionalChildRef.current = null;
      failedActiveHostChildRef.current = null;
      peersRef.current.set(activation.peerId, activation.peer);
      updatePeerSnapshot(activation.peer.getSnapshot());
    } else if (activation.kind === "failed") {
      hostProvisionalChildRef.current = null;
      failedActiveHostChildRef.current = {
        revision,
        peerId: activation.peerId,
      };
      return;
    } else {
      discardPreparedHostChild();
      if (failedActiveHostChildRef.current?.revision !== revision) {
        failedActiveHostChildRef.current = null;
      }
    }
    activeHostChildPeerIdsRef.current = childPeerIds;
  }

  async function startPeer(
    peerId: string,
    generation: number,
    attempt = 0,
    selectedTurn?: SelectedEdgeTurn,
  ): Promise<void> {
    if (!isCurrentGeneration(generation)) {
      return;
    }
    // Preserve healthy media across control reconnects, but replace a stalled
    // negotiation whose offer or answer may have been lost with the WebSocket.
    const existing = peersRef.current.get(peerId);
    if (existing) {
      if (!selectedTurn && existing.isConnected()) {
        return;
      }
      removePeer(peerId);
    }
    const activeStream = streamRef.current;
    const iceConfig = iceConfigRef.current;
    const signal = signalRef.current;
    if (!activeStream || !iceConfig || !signal) {
      return;
    }

    const reportSelectedTurnFailure = (connectionId: string): void => {
      const selected = selectedHostChildRef.current;
      if (
        !selectedTurn ||
        selected?.peerId !== peerId ||
        selected.connectionId !== connectionId ||
        !isCurrentGeneration(generation) ||
        signalRef.current !== signal
      ) {
        return;
      }
      signal.send({
        type: "route-failed",
        revision: selected.currentRouteRevision,
        phase: "active",
        connectionId,
      });
    };

    let peer: HostPeer;
    peer = new HostPeer(
      peerId,
      selectedTurn ? { iceServers: [selectedTurn.iceServer] } : iceConfig,
      activeStream,
      qualitySettingsRef.current,
      {
        sendSignal: (targetPeerId, payload) =>
          isCurrentGeneration(generation) && signalRef.current === signal
            ? signal.send({ type: "signal", targetPeerId, payload })
            : false,
        onUpdate: (snapshot) => {
          if (
            isCurrentGeneration(generation) &&
            peersRef.current.get(peerId) === peer
          ) {
            if (selectedTurn && snapshot.connectionState === "failed") {
              reportSelectedTurnFailure(peer.connectionId);
              removePeer(peerId);
              return;
            }
            updatePeerSnapshot(snapshot);
          }
        },
      },
      selectedTurn !== undefined,
      selectedTurn?.newConnectionId,
    );
    peersRef.current.set(peerId, peer);
    let started: boolean;
    try {
      started = await peer.start();
    } catch (error) {
      if (peersRef.current.get(peerId) === peer) {
        reportSelectedTurnFailure(peer.connectionId);
        removePeer(peerId);
      }
      throw error;
    }
    if (started || peersRef.current.get(peerId) !== peer) {
      return;
    }

    reportSelectedTurnFailure(peer.connectionId);
    removePeer(peerId);
    if (selectedTurn || !isCurrentGeneration(generation) || attempt >= 1) {
      return;
    }
    window.setTimeout(() => {
      if (
        isCurrentGeneration(generation) &&
        !peersRef.current.has(peerId)
      ) {
        void startPeer(peerId, generation, attempt + 1).catch(
          (error: unknown) => {
            if (isCurrentGeneration(generation)) {
              setNotice(readableError(error));
            }
          },
        );
      }
    }, 500);
  }

  async function recoverPeer(
    peerId: string,
    connectionId: string,
    rebuild: boolean,
    generation: number,
  ): Promise<void> {
    const peer = peersRef.current.get(peerId);
    if (rebuild) {
      if (peer && peer.connectionId !== connectionId) {
        return;
      }
      if (peer) {
        removePeer(peerId);
      }
      await startPeer(peerId, generation);
      return;
    }
    if (
      !isCurrentGeneration(generation) ||
      !peer ||
      peer.connectionId !== connectionId
    ) {
      return;
    }
    if (await peer.restartIce()) {
      return;
    }
    if (!isCurrentGeneration(generation)) {
      return;
    }
    if (peersRef.current.get(peerId) !== peer) {
      return;
    }
    removePeer(peerId);
    await startPeer(peerId, generation);
  }

  function reconcilePeerAssistedChildren(
    childPeerIds: string[],
    generation: number,
  ): void {
    const failedPrepared = failedActiveHostChildRef.current;
    const authoritativeChildPeerIds =
      failedPrepared?.revision === activeRouteRevisionRef.current
        ? childPeerIds.filter((peerId) => peerId !== failedPrepared.peerId)
        : childPeerIds;
    const selected = selectedHostChildRef.current;
    const selectedIsCurrent =
      selected?.currentRouteRevision === activeRouteRevisionRef.current &&
      peersRef.current.get(selected.peerId)?.connectionId ===
        selected.connectionId;
    const effectiveChildPeerIds = selectedIsCurrent
      ? [...new Set([...authoritativeChildPeerIds, selected.peerId])]
      : authoritativeChildPeerIds;
    if (selected && !selectedIsCurrent) {
      selectedHostChildRef.current = null;
    }
    reconcileBoundedMediaChildren(
      peersRef.current.keys(),
      effectiveChildPeerIds,
      MAX_HOST_MEDIA_CHILDREN,
      removePeer,
      (peerId) => {
        void startPeer(peerId, generation).catch((error: unknown) => {
          if (isCurrentGeneration(generation)) {
            setNotice(readableError(error));
          }
        });
      },
    );
  }

  function handleSignalMessage(
    message: ServerMessage,
    generation: number,
    activeRoomId: string,
  ): void {
    if (!isCurrentGeneration(generation)) {
      return;
    }
    if (message.type === "authenticated" && message.role === "host") {
      discardPreparedHostChild();
      failedActiveHostChildRef.current = null;
      const selected = selectedHostChildRef.current;
      if (selected) {
        removePeer(selected.peerId);
      }
      hostPeerIdRef.current = message.peerId;
      setViewerAccessUpdating(false);
      clearAllViewerQualityEvidence();
      setSfuStandbyUrl(
        "sfuStandbyUrl" in message ? message.sfuStandbyUrl : null,
      );
      setMaxViewers(message.maxViewers);
      if (message.viewerPolicy === "public-watch") {
        clearViewerGrant(activeRoomId);
      }
      setRoom((current) =>
        mergeAuthenticatedHostRoom(
          current,
          activeRoomId,
          message.roomExpiresAt,
          message.viewerPolicy,
        ),
      );
      if (
        "mediaMode" in message &&
        message.mediaMode === "peer-assisted"
      ) {
        activeRouteRevisionRef.current = message.routeRevision;
        activeHostChildPeerIdsRef.current = [
          ...message.routeAssignment.childPeerIds,
        ];
        peerAssistedRef.current = true;
        signalRef.current?.send({
          type: "set-quality-settings",
          qualitySettings: qualitySettingsRef.current,
        });
        const route = ensureHostSfuRoute(generation);
        void route
          .resyncAuthoritative({
            revision: message.routeRevision,
            phase: "active",
            assignment: message.routeAssignment,
          })
          .then(() => showHostSfuQualityWarning(route, generation));
        return;
      }
      activeRouteRevisionRef.current = 0;
      activeHostChildPeerIdsRef.current = [];
      peerAssistedRef.current = false;
      clearHostSfuRoute();
      const currentViewerIds = new Set(message.viewerPeerIds);
      for (const peerId of peersRef.current.keys()) {
        if (!currentViewerIds.has(peerId)) {
          removePeer(peerId);
        }
      }
      return;
    }
    if (message.type === "selected-edge-turn") {
      if (message.edgeKind === "host-sfu-ingress") {
        if (
          peerAssistedRef.current &&
          message.hostPeerId === hostPeerIdRef.current &&
          Date.parse(message.expiresAt) > Date.now()
        ) {
          const route = ensureHostSfuRoute(generation);
          route.startSelectedEdgeTurn(message);
        }
        return;
      }
      const current = peersRef.current.get(message.viewerPeerId);
      const selected = selectedHostChildRef.current;
      if (
        peerAssistedRef.current &&
        message.parentPeerId === hostPeerIdRef.current &&
        selected?.peerId === message.viewerPeerId &&
        selected.connectionId === message.newConnectionId &&
        current?.connectionId === selected.connectionId &&
        message.revision >= selected.currentRouteRevision
      ) {
        selected.currentRouteRevision = message.revision;
        selected.pendingCarryRevision = message.revision;
        return;
      }
      const oldConnectionId =
        current?.connectionId ??
        retiredConnectionsRef.current.get(message.viewerPeerId);
      if (
        peerAssistedRef.current &&
        message.parentPeerId === hostPeerIdRef.current &&
        message.revision === activeRouteRevisionRef.current &&
        Date.parse(message.expiresAt) > Date.now() &&
        oldConnectionId === message.oldConnectionId
      ) {
        if (current) {
          removePeer(message.viewerPeerId);
        }
        selectedHostChildRef.current = {
          peerId: message.viewerPeerId,
          connectionId: message.newConnectionId,
          currentRouteRevision: message.revision,
          pendingCarryRevision: null,
        };
        void startPeer(message.viewerPeerId, generation, 0, message);
      }
      return;
    }
    if (message.type === "viewer-access-updated") {
      setViewerAccessUpdating(false);
      replaceViewerInvite(activeRoomId, message.inviteUrl);
      setRoom((current) =>
        current
          ? {
              ...current,
              viewerPolicy: message.viewerPolicy,
              inviteUrl: message.inviteUrl,
            }
          : current,
      );
      setNotice(
        message.viewerPolicy === "public-watch"
          ? "已允许仅凭房间号观看"
          : message.inviteUrl
            ? "已生成新的私密邀请，旧邀请已失效"
            : "已撤销当前私密邀请",
      );
      return;
    }
    if (message.type === "viewer-password-updated") {
      const action = viewerPasswordActionRef.current;
      viewerPasswordActionRef.current = null;
      setViewerPasswordEnabled(message.enabled);
      setViewerPasswordUpdating(false);
      setViewerPasswordDraft("");
      if (action) {
        setNotice(
          action === "remove" ? "房间密码已移除" : "房间密码已更新",
        );
      }
      return;
    }
    if (message.type === "viewer-presence") {
      setParticipantPresence(message.viewers);
      return;
    }
    if (message.type === "route-update") {
      if (peerAssistedRef.current) {
        if (message.phase === "prepare") {
          prepareHostChild(message.revision, message.assignment, generation);
        } else {
          activatePreparedHostChild(message.revision, message.assignment);
        }
        if (message.phase === "active") {
          const selected = selectedHostChildRef.current;
          if (selected?.pendingCarryRevision === message.revision) {
            selected.pendingCarryRevision = null;
          } else if (selected) {
            removePeer(selected.peerId);
          }
        }
        if (
          message.phase === "active" &&
          message.revision !== activeRouteRevisionRef.current
        ) {
          activeRouteRevisionRef.current = message.revision;
          clearAllViewerQualityEvidence();
        }
        const route = ensureHostSfuRoute(generation);
        void route
          .acceptAndWait(message)
          .then(() => showHostSfuQualityWarning(route, generation));
      }
      return;
    }
    if (message.type === "viewer-quality-evidence") {
      acceptViewerQualityEvidence(message);
      return;
    }
    if (message.type === "sfu-config") {
      if (peerAssistedRef.current) {
        const route = ensureHostSfuRoute(generation);
        void route
          .acceptConfig(message)
          .then(() => showHostSfuQualityWarning(route, generation));
      }
      return;
    }
    if (message.type === "media-assignment") {
      if (peerAssistedRef.current && !hostSfuRouteRef.current) {
        discardPreparedHostChild();
        failedActiveHostChildRef.current = null;
        activeHostChildPeerIdsRef.current = [
          ...message.mediaAssignment.childPeerIds,
        ];
        reconcilePeerAssistedChildren(
          message.mediaAssignment.childPeerIds,
          generation,
        );
      }
      return;
    }
    if (message.type === "peer-joined") {
      if (peerAssistedRef.current) {
        return;
      }
      void startPeer(message.peerId, generation).catch((error: unknown) => {
        if (isCurrentGeneration(generation)) {
          setNotice(readableError(error));
        }
      });
      return;
    }
    if (message.type === "peer-left") {
      if (peerAssistedRef.current) {
        return;
      }
      removePeer(message.peerId);
      return;
    }
    if (message.type === "signal") {
      if (
        hostProvisionalChildRef.current?.acceptSignal(
          message.fromPeerId,
          message.payload,
        )
      ) {
        return;
      }
      void peersRef.current.get(message.fromPeerId)?.acceptSignal(message.payload);
      return;
    }
    if (message.type === "restart-request") {
      void recoverPeer(
        message.fromPeerId,
        message.connectionId,
        message.rebuild,
        generation,
      ).catch((error: unknown) => {
        if (isCurrentGeneration(generation)) {
          setNotice(readableError(error));
        }
      });
      return;
    }
    if (message.type === "room-closed") {
      forgetRoom();
      endSharing(
        message.reason === "expired" ? "房间已过期" : "房间已关闭",
        false,
      );
      return;
    }
    if (message.type === "error") {
      setViewerAccessUpdating(false);
      setViewerPasswordUpdating(false);
      viewerPasswordActionRef.current = null;
      if (["INVALID_TOKEN", "ROOM_EXPIRED"].includes(message.code)) {
        forgetRoom();
        endSharing("房间已失效，再次点击将创建新房", false);
        return;
      }
      if (
        [
          "AUTH_REQUIRED",
          "HOST_ALREADY_CONNECTED",
        ].includes(message.code)
      ) {
        endSharing(message.message, false);
        return;
      }
      setNotice(message.message);
    }
  }

  async function startSharing(): Promise<void> {
    if (
      phase === "starting" ||
      phase === "live" ||
      activeGenerationRef.current !== null
    ) {
      return;
    }
    const generation = generationRef.current + 1;
    const shareGeneration = createOpaqueId();
    generationRef.current = generation;
    activeGenerationRef.current = generation;
    shareGenerationRef.current = shareGeneration;
    setNotice(null);
    setCopied(false);
    setPhase("starting");

    let captured: MediaStream;
    try {
      // This must remain the first awaited operation in the button gesture.
      captured = await captureDisplay(qualitySettingsRef.current);
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        return;
      }
      activeGenerationRef.current = null;
      shareGenerationRef.current = null;
      setNotice(readableError(error));
      setPhase("error");
      return;
    }

    if (!isCurrentGeneration(generation)) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = captured;
    setStream(captured);
    setDetails(captureDetails(captured));
    watchCaptureEnd(captured, generation);

    let createdRoom: HostRoomState | null = null;
    let claimedRoom = false;
    try {
      let reusableRoom = room;
      if (reusableRoom && isHostRoomExpired(reusableRoom)) {
        forgetRoom();
        reusableRoom = null;
      }
      createdRoom = reusableRoom ?? hostRoomFromStored(readHostRoom());
      if (!createdRoom) {
        const response = await createRoom(newRoomViewerPolicy);
        createdRoom = hostRoomFromCreated(response);
        if (!isCurrentGeneration(generation)) {
          captured.getTracks().forEach((track) => track.stop());
          closeAbandonedRoom(createdRoom);
          return;
        }
        writeHostRoom(createdRoom);
        setRoom(createdRoom);
        claimedRoom = true;
      } else {
        setRoom(createdRoom);
        claimedRoom = true;
      }
      const activeRoom = createdRoom;
      const hostClientId = getStableClientId("host", activeRoom.roomId);
      hostClientIdRef.current = hostClientId;
      const hostFallback = defaultHostDisplayName(hostClientId);
      const initialDisplayName = readDisplayName(hostFallback);
      displayNameRef.current = initialDisplayName;
      setDisplayName(initialDisplayName);
      setDisplayNameDraft(initialDisplayName);
      setDisplayNameError(null);
      const signal = new SignalingClient(
        {
          roomId: activeRoom.roomId,
          role: "host",
          token: activeRoom.hostToken,
          clientId: hostClientId,
          shareGeneration,
          sharingPaused: false,
          viewerPresence: true,
          viewerPasswordSettings: true,
          displayName: initialDisplayName,
        },
        {
          onStatus: (status) => {
            if (
              isCurrentGeneration(generation) &&
              signalRef.current === signal
            ) {
              setSignalStatus(status);
            }
          },
          onTerminated: (message) => {
            if (
              isCurrentGeneration(generation) &&
              signalRef.current === signal
            ) {
              endSharing(message, false);
            }
          },
          onAccessRequired: () => {
            if (
              isCurrentGeneration(generation) &&
              signalRef.current === signal
            ) {
              endSharing("站点访问已失效，请重新验证", false);
              onAuthorizationRequired?.();
            }
          },
          onMessage: (message) => {
            if (
              !isCurrentGeneration(generation) ||
              signalRef.current !== signal
            ) {
              return;
            }
            if (message.type === "authenticated" && message.role === "host") {
              iceConfigRef.current = message.iceConfig;
              peersRef.current.forEach((peer) =>
                peer.updateIceConfig(message.iceConfig),
              );
              writeHostRoom({
                ...activeRoom,
                expiresAt: message.roomExpiresAt,
              });
              setPhase("live");
            }
            handleSignalMessage(message, generation, activeRoom.roomId);
          },
        },
      );
      signalRef.current = signal;
      signal.start();
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        captured.getTracks().forEach((track) => track.stop());
        if (createdRoom && !claimedRoom) {
          closeAbandonedRoom(createdRoom);
        }
        return;
      }
      activeGenerationRef.current = null;
      disposeResources(false);
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        onAuthorizationRequired
      ) {
        onAuthorizationRequired();
        return;
      }
      setNotice(readableError(error));
      setPhase("error");
    }
  }

  async function switchSource(): Promise<void> {
    const generation = activeGenerationRef.current;
    if (
      phase !== "live" ||
      generation === null ||
      !isCurrentGeneration(generation) ||
      sourceSwitchRef.current ||
      qualityChangeRef.current
    ) {
      return;
    }

    const token = {};
    sourceSwitchRef.current = token;
    setSwitchingSource(true);
    setNotice(null);

    let captured: MediaStream;
    try {
      // Like initial capture, changing source must begin in this button gesture.
      captured = await captureDisplay(qualitySettingsRef.current);
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        setNotice(readableError(error));
      }
      finishSourceSwitch(token);
      return;
    }

    if (
      !isCurrentGeneration(generation) ||
      sourceSwitchRef.current !== token
    ) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    const previousStream = streamRef.current;
    if (!previousStream) {
      captured.getTracks().forEach((track) => track.stop());
      setNotice("当前分享已经结束");
      finishSourceSwitch(token);
      return;
    }

    retiringStreamRef.current = previousStream;
    setMediaPaused(captured, sharingPausedRef.current);
    streamRef.current = captured;
    setStream(captured);
    setDetails(captureDetails(captured));
    watchCaptureEnd(captured, generation);

    try {
      const activeSfuRoute = hostSfuRouteRef.current;
      const provisional = hostProvisionalChildRef.current;
      const [replacements, , sfuReplaced] = await Promise.all([
        Promise.all(
          [...peersRef.current.entries()].map(async ([peerId, peer]) => {
            try {
              return {
                peerId,
                peer,
                replaced: await peer.replaceStream(captured),
              };
            } catch {
              return { peerId, peer, replaced: false };
            }
          }),
        ),
        provisional?.replaceStream(captured) ?? Promise.resolve(true),
        activeSfuRoute?.replaceStream(captured) ?? Promise.resolve(true),
      ]);

      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token
      ) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }

      const failedPeerIds: string[] = [];
      for (const { peerId, peer, replaced } of replacements) {
        if (!replaced && peersRef.current.get(peerId) === peer) {
          removePeer(peerId);
          failedPeerIds.push(peerId);
        }
      }
      const sfuWarning =
        activeSfuRoute && hostSfuRouteRef.current === activeSfuRoute
          ? activeSfuRoute.getQualityWarning()
          : null;
      if (
        !sfuReplaced &&
        activeSfuRoute &&
        hostSfuRouteRef.current === activeSfuRoute
      ) {
        await activeSfuRoute.failActivePublisher();
      }

      previousStream.getTracks().forEach((track) => track.stop());
      if (retiringStreamRef.current === previousStream) {
        retiringStreamRef.current = null;
      }

      await Promise.all(
        failedPeerIds.map(async (peerId) => {
          if (
            !isCurrentGeneration(generation) ||
            sourceSwitchRef.current !== token ||
            peersRef.current.has(peerId)
          ) {
            return;
          }
          try {
            await startPeer(peerId, generation);
          } catch (error) {
            if (
              isCurrentGeneration(generation) &&
              sourceSwitchRef.current === token
            ) {
              setNotice(readableError(error));
            }
          }
        }),
      );

      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        setNotice(
          sourceSwitchNotice({
            failedPeerCount: failedPeerIds.length,
            sfuReplaced,
            sfuWarning,
          }),
        );
      }
    } finally {
      previousStream.getTracks().forEach((track) => track.stop());
      if (retiringStreamRef.current === previousStream) {
        retiringStreamRef.current = null;
      }
      finishSourceSwitch(token);
    }
  }

  async function copyInvite(): Promise<void> {
    const inviteUrl = room?.inviteUrl;
    if (!inviteUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1_500);
    } catch {
      setNotice("无法写入剪贴板，请手动复制邀请链接");
    }
  }

  function changeViewerAccess(
    action: "public-watch" | "rotate" | "revoke",
  ): void {
    if (
      viewerAccessUpdating ||
      phase !== "live" ||
      !signalRef.current?.send({ type: "set-viewer-access", action })
    ) {
      setNotice("开始分享并连接后才能修改观看权限");
      return;
    }
    setViewerAccessUpdating(true);
    setNotice(null);
  }

  function changeViewerPassword(password: string | null): void {
    if (
      password !== null &&
      !viewerPasswordSchema.safeParse(password).success
    ) {
      setNotice(
        `房间密码只需 1-${MAX_VIEWER_PASSWORD_LENGTH} 个可见字符`,
      );
      return;
    }
    if (
      viewerPasswordUpdating ||
      phase !== "live" ||
      !signalRef.current?.send({ type: "set-viewer-password", password })
    ) {
      setNotice("开始分享并连接后才能修改房间密码");
      return;
    }
    viewerPasswordActionRef.current = password === null ? "remove" : "set";
    setViewerPasswordUpdating(true);
    setViewerPasswordDraft("");
    setNotice(null);
  }

  function commitDisplayName(): void {
    const hostFallback = hostClientIdRef.current
      ? defaultHostDisplayName(hostClientIdRef.current)
      : DEFAULT_HOST_DISPLAY_NAME_PREFIX;
    const saved = saveDisplayName(displayNameDraft, hostFallback);
    if (!saved) {
      setDisplayNameError("名称格式无效或超过 24 个字符");
      return;
    }
    displayNameRef.current = saved;
    setDisplayName(saved);
    setDisplayNameDraft(saved);
    setDisplayNameError(null);
    setEditingDisplayName(false);
    if (!signalRef.current?.setDisplayName(saved)) {
      setNotice("开始分享并连接后才能修改昵称");
    }
  }

  const expirationText = room
    ? room.expiresAt
      ? `${new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(room.expiresAt))} 过期`
      : "长期有效"
    : null;
  const codecLockNotice = videoCodecLockNotice(phase);
  const audioQualityLockNotice = screenAudioQualityLockNotice(phase);

  return (
    <div className="app-shell">
      <AppHeader
        status={
          showConnectionDetails ? (
            <SignalStatusBadge state={signalStatus} />
          ) : null
        }
      />

      <main className="host-workspace">
        <section className="broadcast-area" aria-labelledby="broadcast-heading">
          <div className="section-heading">
            <div>
              <div className="title-line">
                <h1 id="broadcast-heading">
                  {hostPresence?.displayName ?? displayName} 的屏幕
                </h1>
                {room && <RoomCode roomId={room.roomId} />}
              </div>
              <p className="section-meta">
                {phase === "live"
                  ? `${viewers.length}/${maxViewers ?? "-"} 人在线`
                  : phase === "starting"
                    ? "正在连接"
                    : phase === "ended" && room
                      ? "已停止分享"
                      : room
                        ? "房间已就绪"
                        : "尚未开始"}
              </p>
            </div>
            {(phase === "live" || phase === "starting") && (
              <div className="broadcast-actions">
                {phase === "live" && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={switchingSource || changingQuality}
                    onClick={toggleSharingPause}
                  >
                    {sharingPaused ? (
                      <Play size={16} fill="currentColor" aria-hidden="true" />
                    ) : (
                      <Pause size={16} fill="currentColor" aria-hidden="true" />
                    )}
                    {sharingPaused ? "恢复分享" : "暂停分享"}
                  </button>
                )}
                {phase === "live" && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={switchingSource || changingQuality}
                    onClick={() => void switchSource()}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    {switchingSource ? "正在选择" : "切换来源"}
                  </button>
                )}
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() =>
                    endSharing(
                      phase === "starting"
                        ? "启动已取消"
                        : "已停止分享",
                    )
                  }
                >
                  <Square size={16} fill="currentColor" aria-hidden="true" />
                  {phase === "starting" ? "取消" : "停止分享"}
                </button>
              </div>
            )}
          </div>

          <form
            className={`viewer-name-control host-name-control${
              editingDisplayName ? " is-editing" : ""
            }`}
            onSubmit={(event) => {
              event.preventDefault();
              commitDisplayName();
            }}
          >
            <label
              htmlFor={editingDisplayName ? "host-display-name" : undefined}
            >
              昵称
            </label>
            {editingDisplayName ? (
              <>
                <input
                  id="host-display-name"
                  type="text"
                  value={displayNameDraft}
                  maxLength={96}
                  autoComplete="nickname"
                  autoFocus
                  aria-invalid={displayNameError ? "true" : undefined}
                  onChange={(event) => {
                    setDisplayNameDraft(event.target.value);
                    setDisplayNameError(null);
                  }}
                />
                <button
                  type="submit"
                  className="icon-button"
                  title="保存昵称"
                  aria-label="保存昵称"
                  disabled={displayNameDraft === displayName}
                >
                  <Save size={17} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="取消编辑"
                  aria-label="取消编辑昵称"
                  onClick={() => {
                    setDisplayNameDraft(displayName);
                    setDisplayNameError(null);
                    setEditingDisplayName(false);
                  }}
                >
                  <X size={17} />
                </button>
              </>
            ) : (
              <>
                <span className="viewer-name-value">{displayName}</span>
                <button
                  type="button"
                  className="icon-button"
                  title="编辑昵称"
                  aria-label="编辑昵称"
                  onClick={() => {
                    setDisplayNameDraft(displayName);
                    setDisplayNameError(null);
                    setEditingDisplayName(true);
                  }}
                >
                  <Pencil size={17} />
                </button>
              </>
            )}
            {displayNameError && (
              <span className="viewer-name-error" role="alert">
                {displayNameError}
              </span>
            )}
          </form>

          <div
            className="video-stage local-stage"
            role="group"
            aria-label="分享或加入房间"
          >
            {stream ? (
              <>
                <video ref={videoRef} autoPlay muted playsInline />
                <button
                  className="icon-button local-preview-action"
                  type="button"
                  title="放大本地预览"
                  aria-label="放大本地预览"
                  onClick={() => void enterPreviewFullscreen()}
                >
                  <Maximize2 size={18} aria-hidden="true" />
                </button>
              </>
            ) : phase === "idle" ||
              phase === "ended" ||
              phase === "error" ? (
              <div className="stage-placeholder stage-entry">
                {phase === "ended" && room && (
                  <span className="stage-status">已停止分享</span>
                )}
                <div className="entry-actions">
                  <button
                    className="entry-action"
                    type="button"
                    title="开始分享屏幕"
                    onClick={() => {
                      setJoiningRoom(false);
                      void startSharing();
                    }}
                  >
                    <MonitorUp size={18} aria-hidden="true" />
                    开始分享
                  </button>
                  <span className="entry-divider" aria-hidden="true">
                    或
                  </span>
                  <button
                    className="entry-action"
                    type="button"
                    title="输入房间码加入观看"
                    aria-expanded={joiningRoom}
                    aria-controls="host-room-code-entry"
                    onClick={() => setJoiningRoom((current) => !current)}
                  >
                    <Hash size={18} aria-hidden="true" />
                    加入房间
                  </button>
                  {joiningRoom && (
                    <RoomCodeEntry
                      id="host-room-code-entry"
                      autoFocus
                      inline
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="stage-placeholder">
                <MonitorUp size={36} strokeWidth={1.5} aria-hidden="true" />
              </div>
            )}
            {(phase === "starting" ||
              switchingSource ||
              sharingPaused ||
              (stream !== null && localPreviewPaused)) && (
              <div className="stage-overlay" role="status">
                {switchingSource
                  ? "正在切换来源"
                  : sharingPaused
                    ? "音视频分享已暂停"
                    : phase === "starting"
                      ? "正在连接"
                      : "本地预览已暂停，分享仍在继续"}
              </div>
            )}
          </div>

          {(phase === "idle" || phase === "ended" || phase === "error") && (
            <ConnectionSelfCheck />
          )}

          {showConnectionDetails && details && stream && (
            <div className="capture-strip" aria-label="实际捕获参数">
              <span>{details.resolution}</span>
              <span>{details.frameRate ? `${details.frameRate.toFixed(0)} fps` : "帧率未知"}</span>
              <span>{details.hasAudio ? "含音频" : "无音频"}</span>
            </div>
          )}

          {!details?.hasAudio && stream && (
            <WarningBanner>当前来源没有可共享音频</WarningBanner>
          )}
          {qualityLimitation && (
            <WarningBanner>{qualityLimitation}</WarningBanner>
          )}
          {notice && (
            <div className="notice" role="status" aria-live="polite">
              {notice}
            </div>
          )}

          <ConnectionDetailsToggle
            checked={showConnectionDetails}
            onChange={setShowConnectionDetails}
            onExport={diagnosticConnections.length > 0
              ? () => downloadDiagnosticReport("host", diagnosticConnections)
              : undefined}
          />

          <div className="setup-controls">
            <div className="quality-controls">
              {!room && (
                <label className="viewer-policy-toggle">
                  <input
                    type="checkbox"
                    checked={newRoomViewerPolicy === "public-watch"}
                    disabled={phase === "starting"}
                    onChange={(event) =>
                      setNewRoomViewerPolicy(
                        event.target.checked
                          ? "public-watch"
                          : "private-link",
                      )
                    }
                  />
                  <span>允许仅凭房间号观看</span>
                </label>
              )}
              <fieldset className="control-group">
                <legend>推荐画质</legend>
                <div className="segmented-control">
                  {(Object.keys(QUALITY_PROFILES) as QualityProfileId[]).map(
                    (id) => (
                      <button
                        key={id}
                        type="button"
                        className={
                          selectedQualityProfileId === id
                            ? "is-selected"
                            : undefined
                        }
                        aria-pressed={selectedQualityProfileId === id}
                        disabled={
                          phase === "starting" ||
                          switchingSource ||
                          changingQuality
                        }
                        onClick={() =>
                          void changeQuality({
                            ...QUALITY_PROFILES[id],
                            videoCodec:
                              qualitySettingsRef.current.videoCodec ?? "automatic",
                            screenAudioQuality: resolveScreenAudioQuality(
                              qualitySettingsRef.current.screenAudioQuality,
                            ),
                          })
                        }
                      >
                        {QUALITY_PROFILE_LABELS[id]}
                      </button>
                    ),
                  )}
                </div>
              </fieldset>

              <details className="advanced-quality">
                <summary>分享高级设置</summary>
                <div className="advanced-quality-grid">
                  <label>
                    <span>分辨率上限</span>
                    <select
                      value={advancedQuality.resolution}
                      disabled={changingQuality}
                      onChange={(event) =>
                        setAdvancedQuality((current) => ({
                          ...current,
                          resolution: event.target
                            .value as QualitySettings["resolution"],
                        }))
                      }
                    >
                      {Object.entries(QUALITY_RESOLUTIONS).map(
                        ([resolution, option]) => (
                          <option key={resolution} value={resolution}>
                            {option.label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    <span>帧率上限</span>
                    <div className="range-control">
                      <input
                        type="range"
                        min="15"
                        max="60"
                        step="5"
                        value={advancedQuality.maxFramerate}
                        disabled={changingQuality}
                        onChange={(event) =>
                          setAdvancedQuality((current) => ({
                            ...current,
                            maxFramerate: Number(event.target.value),
                          }))
                        }
                      />
                      <output>{advancedQuality.maxFramerate} fps</output>
                    </div>
                  </label>
                  <label>
                    <span>视频码率上限</span>
                    <div className="range-control">
                      <input
                        type="range"
                        min="2000000"
                        max="12000000"
                        step="500000"
                        value={advancedQuality.maxBitrate}
                        disabled={changingQuality}
                        onChange={(event) =>
                          setAdvancedQuality((current) => ({
                            ...current,
                            maxBitrate: Number(event.target.value),
                          }))
                        }
                      />
                      <output>
                        {(advancedQuality.maxBitrate / 1_000_000).toFixed(1)} Mbps
                      </output>
                    </div>
                  </label>
                  <fieldset className="control-group quality-priority">
                    <legend>质量优先级</legend>
                    <div className="segmented-control">
                      {(
                        Object.keys(
                          DEGRADATION_PREFERENCE_LABELS,
                        ) as DegradationPreference[]
                      ).map((preference) => (
                        <button
                          key={preference}
                          type="button"
                          className={
                            advancedQuality.degradationPreference === preference
                              ? "is-selected"
                              : undefined
                          }
                          aria-pressed={
                            advancedQuality.degradationPreference === preference
                          }
                          disabled={changingQuality}
                          onClick={() =>
                            setAdvancedQuality((current) => ({
                              ...current,
                              degradationPreference: preference,
                            }))
                          }
                        >
                          {DEGRADATION_PREFERENCE_LABELS[preference]}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset
                    className="control-group quality-priority"
                    aria-describedby={
                      codecLockNotice ? "video-codec-lock-notice" : undefined
                    }
                  >
                    <legend>视频编码</legend>
                    <div className="segmented-control">
                      {(
                        Object.keys(
                          VIDEO_CODEC_PREFERENCE_LABELS,
                        ) as VideoCodecPreference[]
                      ).map((codec) => (
                        <button
                          key={codec}
                          type="button"
                          className={
                            (advancedQuality.videoCodec ?? "automatic") === codec
                              ? "is-selected"
                              : undefined
                          }
                          aria-pressed={
                            (advancedQuality.videoCodec ?? "automatic") === codec
                          }
                          disabled={
                            phase === "starting" ||
                            phase === "live" ||
                            changingQuality
                          }
                          onClick={() =>
                            changeVideoCodec(codec)
                          }
                        >
                          {VIDEO_CODEC_PREFERENCE_LABELS[codec]}
                        </button>
                      ))}
                    </div>
                    {codecLockNotice && (
                      <p id="video-codec-lock-notice" className="control-note">
                        {codecLockNotice}
                      </p>
                    )}
                  </fieldset>
                  <fieldset
                    className="control-group quality-priority"
                    aria-describedby={
                      audioQualityLockNotice
                        ? "screen-audio-quality-lock-notice"
                        : undefined
                    }
                  >
                    <legend>音频质量</legend>
                    <div className="segmented-control">
                      {(
                        Object.keys(
                          SCREEN_AUDIO_QUALITY_LABELS,
                        ) as ScreenAudioQuality[]
                      ).map((audioQuality) => (
                        <button
                          key={audioQuality}
                          type="button"
                          className={
                            resolveScreenAudioQuality(
                              advancedQuality.screenAudioQuality,
                            ) === audioQuality
                              ? "is-selected"
                              : undefined
                          }
                          aria-pressed={
                            resolveScreenAudioQuality(
                              advancedQuality.screenAudioQuality,
                            ) === audioQuality
                          }
                          disabled={
                            phase === "starting" ||
                            phase === "live" ||
                            changingQuality
                          }
                          onClick={() =>
                            changeScreenAudioQuality(audioQuality)
                          }
                        >
                          {SCREEN_AUDIO_QUALITY_LABELS[audioQuality]}
                        </button>
                      ))}
                    </div>
                    {audioQualityLockNotice && (
                      <p
                        id="screen-audio-quality-lock-notice"
                        className="control-note"
                      >
                        {audioQualityLockNotice}
                      </p>
                    )}
                  </fieldset>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={
                      phase === "starting" ||
                      switchingSource ||
                      changingQuality
                    }
                    onClick={() => void changeQuality(advancedQuality)}
                  >
                    {changingQuality ? "正在应用" : "应用分享设置"}
                  </button>
                </div>
              </details>
            </div>
          </div>
          {room && (
            <div className="invite-bar">
              <div className="invite-copy">
                <span className="field-label">
                  房间 {room.roomId} · {expirationText} ·{" "}
                  {room.viewerPolicy === "public-watch"
                    ? "公开观看"
                    : "私密链接"}
                </span>
                <span className="invite-url" title={room.inviteUrl ?? undefined}>
                  {room.inviteUrl ?? "当前没有有效邀请，请轮换生成新链接"}
                </span>
              </div>
              <div className="invite-actions">
                <button
                  className="icon-button"
                  type="button"
                  title="复制邀请链接"
                  aria-label="复制邀请链接"
                  disabled={!room.inviteUrl}
                  onClick={() => void copyInvite()}
                >
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                </button>
                {room.viewerPolicy === "public-watch" ? (
                  <button
                    className="icon-button"
                    type="button"
                    title="设为私密并生成新邀请"
                    aria-label="设为私密并生成新邀请"
                    disabled={viewerAccessUpdating || phase !== "live"}
                    onClick={() => changeViewerAccess("rotate")}
                  >
                    <LockKeyhole size={18} />
                  </button>
                ) : (
                  <>
                    <button
                      className="icon-button"
                      type="button"
                      title="轮换私密邀请"
                      aria-label="轮换私密邀请"
                      disabled={viewerAccessUpdating || phase !== "live"}
                      onClick={() => changeViewerAccess("rotate")}
                    >
                      <RefreshCw size={18} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="撤销当前邀请"
                      aria-label="撤销当前邀请"
                      disabled={viewerAccessUpdating || phase !== "live"}
                      onClick={() => changeViewerAccess("revoke")}
                    >
                      <LockKeyhole size={18} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="允许仅凭房间号观看"
                      aria-label="允许仅凭房间号观看"
                      disabled={viewerAccessUpdating || phase !== "live"}
                      onClick={() => changeViewerAccess("public-watch")}
                    >
                      <Globe2 size={18} />
                    </button>
                  </>
                )}
              </div>
              {room.viewerPolicy === "private-link" && (
                <form
                  className="viewer-password-control"
                  onSubmit={(event) => {
                    event.preventDefault();
                    changeViewerPassword(viewerPasswordDraft);
                  }}
                >
                  <label htmlFor="viewer-password">房间密码</label>
                  <span className="input-with-icon">
                    <KeyRound size={16} aria-hidden="true" />
                    <input
                      id="viewer-password"
                      type="password"
                      value={viewerPasswordDraft}
                      maxLength={MAX_VIEWER_PASSWORD_LENGTH}
                      autoComplete="new-password"
                      placeholder={
                        viewerPasswordEnabled ? "输入新密码" : "设置密码"
                      }
                      disabled={viewerPasswordUpdating || phase !== "live"}
                      onChange={(event) =>
                        setViewerPasswordDraft(event.target.value)
                      }
                    />
                  </span>
                  <button
                    className="icon-button"
                    type="submit"
                    title={viewerPasswordEnabled ? "更改房间密码" : "设置房间密码"}
                    aria-label={
                      viewerPasswordEnabled ? "更改房间密码" : "设置房间密码"
                    }
                    disabled={
                      viewerPasswordUpdating ||
                      phase !== "live" ||
                      viewerPasswordDraft.length === 0
                    }
                  >
                    <Check size={18} />
                  </button>
                  {viewerPasswordEnabled && (
                    <button
                      className="icon-button"
                      type="button"
                      title="移除房间密码"
                      aria-label="移除房间密码"
                      disabled={viewerPasswordUpdating || phase !== "live"}
                      onClick={() => changeViewerPassword(null)}
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </form>
              )}
            </div>
          )}
        </section>

        <aside className="viewer-panel" aria-labelledby="viewer-heading">
          <div className="viewer-panel-heading">
            <div>
              <h2 id="viewer-heading">观看者</h2>
              <span>在线 {viewers.length}/{maxViewers ?? "-"}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              title={showTopology ? "隐藏连接拓扑" : "显示连接拓扑"}
              aria-label={showTopology ? "隐藏连接拓扑" : "显示连接拓扑"}
              aria-controls="room-topology"
              aria-expanded={showTopology}
              onClick={() => setShowTopology((current) => !current)}
            >
              <Network size={17} aria-hidden="true" />
            </button>
          </div>

          {showTopology && (
            <TopologyView
              hostPeerId={hostPresence?.peerId ?? hostPeerIdRef.current}
              hostLabel={labeledHostPresence?.label ?? displayName}
              viewers={viewers}
            />
          )}

          <div className="viewer-list">
            {showConnectionDetails && sfuPublisherSnapshot && (
              <article className="viewer-item" aria-label="SFU 发送详情">
                <div className="viewer-item-heading">
                  <div>
                    <h3>SFU 发送</h3>
                    <MediaRouteBadge route="sfu" />
                  </div>
                </div>
                <StatsGrid
                  metrics={sfuPublisherSnapshot.metrics}
                  direction="send"
                  senderParameters={sfuPublisherSnapshot.senderParameters}
                />
              </article>
            )}
            {viewers.map((viewer) => {
              const snapshot =
                viewer.upstream.kind === "peer" &&
                viewer.upstream.peerId ===
                  (hostPresence?.peerId ?? hostPeerIdRef.current)
                  ? peerSnapshots.get(viewer.peerId)
                  : undefined;
              const qualityPresentation = viewerQualityEvidence.get(
                viewer.peerId,
              );
              const qualityEvidence = qualityPresentation?.evidence;
              const hasMatchingQualityEvidence =
                viewer.upstream.kind === "peer" &&
                qualityEvidence?.parentPeerId === viewer.upstream.peerId;
              const hasCurrentQualityEvidence =
                hasMatchingQualityEvidence &&
                qualityPresentation?.fresh === true;
              const hasCurrentSfuEvidence =
                viewer.upstream.kind === "sfu" &&
                viewer.sfuMediaReady === true;
              const hasCurrentRouteEvidence =
                hasPeerRouteEvidence(snapshot) ||
                hasCurrentQualityEvidence ||
                hasCurrentSfuEvidence;
              const hasCurrentConnectionEvidence =
                snapshot?.connectionState === "connected" ||
                hasCurrentQualityEvidence ||
                hasCurrentSfuEvidence;
              const viewerState =
                hasCurrentConnectionEvidence
                  ? "connected"
                  : (snapshot?.connectionState ?? "routing");
              return (
                <article className="viewer-item" key={viewer.peerId}>
                  <div className="viewer-item-heading">
                    <div>
                      <h3 title={viewer.label}>{viewer.label}</h3>
                      <PeerStatusBadge state={viewerState} />
                    </div>
                  </div>
                  {showConnectionDetails &&
                    hasCurrentRouteEvidence &&
                    viewer.upstream.kind !== "none" && (
                    <div className="viewer-transport-heading">
                      <MediaRouteBadge
                        route={viewer.upstream.kind === "peer" ? "p2p" : "sfu"}
                      />
                      {snapshot?.metrics.path === "relay" && (
                        <PathBadge metrics={snapshot.metrics} />
                      )}
                    </div>
                  )}
                  {showConnectionDetails &&
                    snapshot &&
                    hasPeerRouteEvidence(snapshot) && (
                      <StatsGrid
                        metrics={snapshot.metrics}
                        direction="send"
                        senderParameters={snapshot.senderParameters}
                        progressive
                      />
                    )}
                  {showConnectionDetails &&
                    qualityEvidence &&
                    hasMatchingQualityEvidence && (
                    <>
                      <p className="section-meta">观看端接收</p>
                      <StatsGrid
                        metrics={metricsFromQualityEvidence(qualityEvidence)}
                        direction="receive"
                        progressive
                      />
                    </>
                  )}
                  {snapshot?.error && (
                    <p className="inline-error">{snapshot.error}</p>
                  )}
                </article>
              );
            })}
            {viewers.length === 0 && (
              <div className="empty-viewers">
                <Users size={24} strokeWidth={1.5} aria-hidden="true" />
                <span>{phase === "live" ? "等待朋友加入" : "暂无观看者"}</span>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
