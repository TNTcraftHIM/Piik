import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Link2Off,
  LoaderCircle,
  LockKeyhole,
  MonitorUp,
  Network,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Square,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOST_DISPLAY_NAME_PREFIX,
  DEFAULT_QUALITY_SETTINGS,
  DEFAULT_ROUTE_POLICY,
  MAX_VIEWER_PASSWORD_LENGTH,
  viewerPasswordSchema,
  type CreateRoomResponse,
  type IceConfig,
  type ParticipantPresenceEntry,
  type PreparedRouteCandidate,
  type ServerMessage,
  type CodeEntryPolicy,
  type RoutePolicy,
} from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import { ConnectionDetailsToggle } from "../components/ConnectionDetailsToggle";
import { RoomCode } from "../components/RoomCode";
import { StageEntryActions } from "../components/StageEntryActions";
import { qualityLimitationSummary } from "../components/connection-details";
import {
  MediaRouteBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { TopologyView } from "../components/TopologyView";
import { hasPeerRouteEvidence } from "../components/status-badge-model";
import {
  ApiError,
  createRoom,
  replaceOwnedRoom,
  updateRoomAccess,
} from "../lib/api";
import {
  readCreationProfile,
  saveCreationProfile,
  type HostCreationProfile,
} from "../lib/creation-profile";
import { createOpaqueId } from "../lib/opaque-id";
import {
  defaultHostDisplayName,
  readDisplayName,
  saveDisplayName,
} from "../lib/display-name";
import {
  clearHostRoom,
  getStableClientId,
  type HostRoomIdentity,
  type HostRoomState,
  mergeAuthenticatedHostRoom,
  readHostRoom,
  readPreferredRoomId,
  readViewerGrant,
  replaceViewerInvite,
  writeHostRoom,
  writePreferredRoom,
} from "../lib/session";
import {
  SignalingClient,
  type SignalingTerminationReason,
} from "../lib/signaling";
import { labelParticipantSnapshot } from "../lib/viewer-presence";
import {
  applyCaptureProfile,
  captureDisplay,
  DEGRADATION_PREFERENCE_HINTS,
  DEGRADATION_PREFERENCE_LABELS,
  matchingQualityProfileId,
  QUALITY_PROFILES,
  QUALITY_PROFILE_LABELS,
  QUALITY_RESOLUTIONS,
  qualitySettingsEqual,
  qualitySettingsLabel,
  resolveScreenAudioQuality,
  SCREEN_AUDIO_BITRATES,
  SCREEN_AUDIO_QUALITY_LABELS,
  setMediaPaused,
  videoQualitySettingsEqual,
  type DegradationPreference,
  type QualityProfileId,
  type QualitySettings,
  type ScreenAudioQuality,
} from "../media/quality";
import { HostSfuRoute } from "../media/host-sfu-route";
import {
  HostProvisionalChild,
} from "../media/host-provisional-child";
import { SfuStandbyPrewarmer } from "../media/sfu-standby-prewarmer";
import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
  sfuPublisherQualityEvidenceFromMetrics,
} from "../media/sender-quality-evidence";
import {
  classifyHostViewerQualityEvidence,
  metricsFromQualityEvidence,
  nextViewerQualityEvidencePresentationExpiryAt,
  presentViewerQualityEvidence,
  qualityEvidenceUpstreamMatches,
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
  MAX_ENDPOINT_MEDIA_CHILDREN,
  reconcileBoundedMediaChildren,
} from "../webrtc/media-assignment";
import {
  automaticVideoCodecPreference,
  manualVideoCodecPreference,
  type BrowserVideoCodec,
  type BrowserVideoCodecMode,
  type BrowserVideoCodecPreference,
  VP8_ONLY_VIDEO_CODEC,
} from "../webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../webrtc/video-codec-preflight";
import {
  hostActionErrorNotice,
  hostServerErrorNotice,
  shouldPauseLocalPreview,
  sourceSwitchNotice,
  type HostAction,
} from "./host-page-notices";

type HostPhase = "idle" | "starting" | "live" | "ended" | "error";

type ViewerQualityEvidence = Extract<
  ServerMessage,
  { type: "viewer-quality-evidence" }
>;
type HostRouteAssignment = Extract<
  ServerMessage,
  { type: "route-update" }
>["assignment"];

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

function readableError(error: unknown, action: HostAction): string {
  return error instanceof ApiError
    ? error.message
    : hostActionErrorNotice(error, action);
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
        routePolicy: DEFAULT_ROUTE_POLICY,
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
  if (!room) {
    return null;
  }
  const viewerGrant = readViewerGrant(room.roomId);
  const inviteUrl = new URL(room.canonicalUrl);
  if (viewerGrant) {
    inviteUrl.hash = `v=${viewerGrant}`;
  }
  return {
    ...room,
    codeEntryPolicy: null,
    inviteUrl: viewerGrant ? inviteUrl.toString() : null,
  };
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
    roomLeaseSeconds: room.roomLeaseSeconds,
    canonicalUrl: canonicalUrl.toString(),
    codeEntryPolicy: room.codeEntryPolicy,
    inviteUrl: room.inviteUrl,
  };
}

function hostTerminationMessage(reason: SignalingTerminationReason): string {
  switch (reason) {
    case "STALE_CLIENT":
      return "页面版本已更新，请刷新后重试";
    case "SESSION_REPLACED":
      return "此页面的会话已被另一个标签页接管";
    case "SIGNAL_TERMINATED":
      return "服务器连接已终止，请刷新后重试";
  }
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
  const [routePolicy, setRoutePolicy] = useState<RoutePolicy>(
    DEFAULT_ROUTE_POLICY,
  );
  const [videoCodecMode, setVideoCodecMode] =
    useState<BrowserVideoCodecMode>("auto");
  const [resolvedVideoCodec, setResolvedVideoCodec] =
    useState<BrowserVideoCodec | null>(null);
  const shareGenerationRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<HostPhase>("idle");
  const [signalStatus, setSignalStatus] =
    useState<SignalConnectionState>("offline");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [details, setDetails] = useState<CaptureDetails | null>(null);
  const [room, setRoom] = useState<HostRoomState | null>(() =>
    hostRoomFromStored(readHostRoom()),
  );
  const roomRef = useRef(room);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);
  const [creationProfile, setCreationProfile] =
    useState<HostCreationProfile>(readCreationProfile);
  const creationProfileRef = useRef(creationProfile);
  const [roomMutation, setRoomMutation] = useState<
    "access" | "replacement" | null
  >(null);
  const roomMutating = roomMutation !== null;
  const [viewerPasswordEnabled, setViewerPasswordEnabled] = useState(
    creationProfile.roomPassword !== null,
  );
  useEffect(() => {
    creationProfileRef.current = creationProfile;
  }, [creationProfile]);
  const [viewerPasswordDraft, setViewerPasswordDraft] = useState(
    creationProfile.roomPassword ?? "",
  );
  const [viewerPasswordVisible, setViewerPasswordVisible] = useState(false);
  const [maxViewers, setMaxViewers] = useState<number | null>(null);
  const [peerSnapshots, setPeerSnapshots] = useState<Map<string, PeerSnapshot>>(
    () => new Map(),
  );
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
  const iceConfigRef = useRef<IceConfig | null>(null);
  const peersRef = useRef(new Map<string, HostPeer>());
  const retiredConnectionsRef = useRef(new Map<string, string>());
  const hostProvisionalChildRef = useRef<HostProvisionalChild | null>(null);
  const activeHostChildPeerIdsRef = useRef<string[]>([]);
  const endpointMediaCopyCapacityRef = useRef(MAX_ENDPOINT_MEDIA_CHILDREN);
  const hostPeerIdRef = useRef<string | null>(null);
  const viewerQualityEvidenceRef = useRef(
    new Map<string, ViewerQualityEvidencePresentation>(),
  );
  const viewerQualityEvidenceTimersRef = useRef(
    new Map<string, number>(),
  );
  const peerAssistedRef = useRef(false);
  const activeRouteRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const sourceSwitchRef = useRef<object | null>(null);
  const qualityChangeRef = useRef<object | null>(null);
  const pendingQualityChangeRef = useRef<QualitySettings | null>(null);
  const qualitySettingsRef = useRef<QualitySettings>(DEFAULT_QUALITY_SETTINGS);
  const routePolicyRef = useRef<RoutePolicy>(DEFAULT_ROUTE_POLICY);
  const advancedQualityRef = useRef<QualitySettings>(advancedQuality);
  const videoCodecModeRef = useRef<BrowserVideoCodecMode>(videoCodecMode);
  const roomMutationRef = useRef<object | null>(null);
  const videoCodecRef = useRef<BrowserVideoCodecPreference>(
    VP8_ONLY_VIDEO_CODEC,
  );
  const codecProbeAbortRef = useRef<AbortController | null>(null);
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
    let senderQualitySuspended = false;
    const resetSenderQualityAuthority = () => {
      if (senderQualitySuspended) {
        return;
      }
      senderQualitySuspended = true;
      invalidateSenderQualityEvidence();
      if (routePolicyRef.current.topologyOptimization) {
        signalRef.current?.send({ type: "reset-sender-quality" });
      }
    };
    const syncPreviewPlayback = () => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const shouldPause = shouldPauseLocalPreview(
        document.visibilityState,
        document.hasFocus(),
      );
      if (document.visibilityState !== "visible") {
        resetSenderQualityAuthority();
      } else {
        senderQualitySuspended = false;
      }
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
    window.addEventListener("pagehide", resetSenderQualityAuthority);
    syncPreviewPlayback();
    return () => {
      document.removeEventListener("visibilitychange", syncPreviewPlayback);
      window.removeEventListener("blur", syncPreviewPlayback);
      window.removeEventListener("focus", syncPreviewPlayback);
      window.removeEventListener("pagehide", resetSenderQualityAuthority);
    };
  }, [stream]);

  useEffect(
    () => () => {
      activeGenerationRef.current = null;
      generationRef.current += 1;
      sourceSwitchRef.current = null;
      qualityChangeRef.current = null;
      pendingQualityChangeRef.current = null;
      codecProbeAbortRef.current?.abort();
      codecProbeAbortRef.current = null;
      signalRef.current?.stop();
      peersRef.current.forEach((peer) => peer.dispose());
      peersRef.current.clear();
      retiredConnectionsRef.current.clear();
      hostProvisionalChildRef.current?.discard();
      hostProvisionalChildRef.current = null;
      activeHostChildPeerIdsRef.current = [];
      endpointMediaCopyCapacityRef.current = MAX_ENDPOINT_MEDIA_CHILDREN;
      hostPeerIdRef.current = null;
      viewerQualityEvidenceTimersRef.current.forEach((timer) =>
        window.clearTimeout(timer),
      );
      viewerQualityEvidenceTimersRef.current.clear();
      viewerQualityEvidenceRef.current.clear();
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

  async function resolveStreamVideoCodec(
    stream: MediaStream,
  ): Promise<BrowserVideoCodecPreference> {
    codecProbeAbortRef.current?.abort();
    const mode = videoCodecModeRef.current;
    if (mode !== "auto") {
      codecProbeAbortRef.current = null;
      return manualVideoCodecPreference(mode);
    }
    const controller = new AbortController();
    codecProbeAbortRef.current = controller;
    const track = stream.getVideoTracks()[0];
    try {
      const codec = track
        ? await preferredVideoCodecForTrack(
            track,
            qualitySettingsRef.current,
            controller.signal,
          )
        : "vp8";
      return automaticVideoCodecPreference(codec);
    } finally {
      if (codecProbeAbortRef.current === controller) {
        codecProbeAbortRef.current = null;
      }
    }
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
      getVideoCodec: () => videoCodecRef.current.primary,
      reconcileChildren: (childPeerIds) => {
        if (
          isCurrentGeneration(generation) &&
          hostSfuRouteRef.current === route
        ) {
          reconcileHostChildren(childPeerIds, generation);
        }
      },
      send: (message) =>
        isCurrentGeneration(generation) && hostSfuRouteRef.current === route
          ? signalRef.current?.send(message) === true
          : false,
      onSenderUpdate: (metrics, revision, publicationGeneration) => {
        if (
          !isCurrentGeneration(generation) ||
          !routePolicyRef.current.topologyOptimization ||
          document.visibilityState !== "visible"
        ) {
          return;
        }
        const evidence = sfuPublisherQualityEvidenceFromMetrics(
          metrics,
          revision,
          publicationGeneration,
        );
        if (evidence) {
          signalRef.current?.send(evidence);
        }
      },
    });
    hostSfuRouteRef.current = route;
    return route;
  }

  function clearHostSfuRoute(): void {
    const route = hostSfuRouteRef.current;
    hostSfuRouteRef.current = null;
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
    pendingQualityChangeRef.current = null;
    codecProbeAbortRef.current?.abort();
    codecProbeAbortRef.current = null;
    videoCodecRef.current = VP8_ONLY_VIDEO_CODEC;
    setResolvedVideoCodec(null);
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
    hostProvisionalChildRef.current?.discard();
    hostProvisionalChildRef.current = null;
    activeHostChildPeerIdsRef.current = [];
    endpointMediaCopyCapacityRef.current = MAX_ENDPOINT_MEDIA_CHILDREN;
    hostPeerIdRef.current = null;
    void hostSfuRouteRef.current?.disconnect();
    hostSfuRouteRef.current = null;
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
    setViewerQualityEvidence(new Map());
    activeRouteRevisionRef.current = 0;
    setSignalStatus("offline");
    setSwitchingSource(false);
    setChangingQuality(false);
    sharingPausedRef.current = false;
    setSharingPaused(false);
  }

  function isCurrentRoomAuthority(expected: HostRoomState): boolean {
    const current = roomRef.current;
    return (
      current?.roomId === expected.roomId &&
      current.hostToken === expected.hostToken
    );
  }

  function forgetRoom(expected?: HostRoomState): boolean {
    if (expected && !isCurrentRoomAuthority(expected)) {
      return false;
    }
    clearHostRoom();
    roomRef.current = null;
    setRoom(null);
    setCopied(false);
    setViewerPasswordDraft(creationProfileRef.current.roomPassword ?? "");
    setViewerPasswordVisible(false);
    return true;
  }

  function beginRoomMutation(
    kind: "access" | "replacement",
  ): object | null {
    if (roomMutationRef.current) {
      return null;
    }
    const token = {};
    roomMutationRef.current = token;
    setRoomMutation(kind);
    return token;
  }

  function finishRoomMutation(token: object): void {
    if (roomMutationRef.current !== token) {
      return;
    }
    roomMutationRef.current = null;
    setRoomMutation(null);
  }

  function endSharing(message: string, notifyServer = true): void {
    const generation = activeGenerationRef.current;
    if (generation === null || generationRef.current !== generation) {
      return;
    }
    activeGenerationRef.current = null;
    generationRef.current += 1;
    const currentRoom = roomRef.current;
    if (notifyServer && currentRoom) {
      writePreferredRoom(currentRoom.roomId);
    }
    disposeResources(notifyServer);
    setNotice(message);
    setPhase("ended");
  }

  async function replaceCurrentRoom(): Promise<void> {
    const activeRoom = roomRef.current;
    if (!activeRoom || roomMutationRef.current || phase === "starting") {
      return;
    }
    const mutation = beginRoomMutation("replacement");
    if (!mutation) {
      return;
    }
    const wasSharing = activeGenerationRef.current !== null;
    try {
      const profile = creationProfileRef.current;
      const response = await replaceOwnedRoom(
        activeRoom.roomId,
        activeRoom.hostToken,
        profile.codeEntryPolicy,
        profile.roomPassword,
      );
      const replacement = hostRoomFromCreated(response);
      if (wasSharing) {
        endSharing("房间号已更换", false);
      }
      replaceViewerInvite(activeRoom.roomId, null);
      writeHostRoom(replacement);
      writePreferredRoom(replacement.roomId);
      roomRef.current = replacement;
      setRoom(replacement);
      setCopied(false);
      setViewerPasswordEnabled(profile.roomPassword !== null);
      setViewerPasswordDraft(profile.roomPassword ?? "");
      setViewerPasswordVisible(false);
      setNotice(null);
      setPhase(wasSharing ? "ended" : "idle");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (forgetRoom(activeRoom)) {
          endSharing("房间已失效，再次点击将创建新房", false);
        }
      }
      setNotice(readableError(error, "room"));
    } finally {
      finishRoomMutation(mutation);
    }
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
    const visibleSettings = pendingQualityChangeRef.current ?? settings;
    advancedQualityRef.current = visibleSettings;
    setAdvancedQuality(visibleSettings);
  }

  function changeScreenAudioQuality(
    screenAudioQuality: ScreenAudioQuality,
  ): void {
    if (phase === "starting") {
      return;
    }
    const next = { ...advancedQualityRef.current, screenAudioQuality };
    void changeQuality(next);
  }

  function changeVideoCodecMode(mode: BrowserVideoCodecMode): void {
    if (phase === "starting" || phase === "live") {
      return;
    }
    videoCodecModeRef.current = mode;
    setVideoCodecMode(mode);
    setResolvedVideoCodec(null);
  }

  function changeRoutePolicy(patch: Partial<RoutePolicy>): void {
    if (phase === "starting" || phase === "live") {
      return;
    }
    const next = { ...routePolicyRef.current, ...patch };
    routePolicyRef.current = next;
    setRoutePolicy(next);
  }

  function changeAdvancedQuality(
    patch: Partial<QualitySettings>,
  ): void {
    const next = { ...advancedQualityRef.current, ...patch };
    advancedQualityRef.current = next;
    setAdvancedQuality(next);
    void changeQuality(next);
  }

  async function changeQuality(nextProfile: QualitySettings): Promise<void> {
    advancedQualityRef.current = nextProfile;
    setAdvancedQuality(nextProfile);
    if (phase !== "live") {
      if (qualitySettingsEqual(qualitySettingsRef.current, nextProfile)) {
        return;
      }
      commitQuality(nextProfile);
      return;
    }
    if (qualityChangeRef.current) {
      pendingQualityChangeRef.current = nextProfile;
      return;
    }

    const previousProfile = qualitySettingsRef.current;
    if (qualitySettingsEqual(previousProfile, nextProfile)) {
      return;
    }

    const generation = activeGenerationRef.current;
    const activeStream = streamRef.current;
    if (
      generation === null ||
      !activeStream ||
      !isCurrentGeneration(generation) ||
      sourceSwitchRef.current
    ) {
      return;
    }
    const token = {};
    qualityChangeRef.current = token;
    setChangingQuality(true);
    setNotice(null);
    const videoChanged = !videoQualitySettingsEqual(
      previousProfile,
      nextProfile,
    );
    const captureChanged =
      previousProfile.resolution !== nextProfile.resolution ||
      previousProfile.maxFramerate !== nextProfile.maxFramerate;
    const audioChanged =
      resolveScreenAudioQuality(previousProfile.screenAudioQuality) !==
      resolveScreenAudioQuality(nextProfile.screenAudioQuality);
    try {
      if (captureChanged) {
        await applyCaptureProfile(activeStream, nextProfile);
      }
      if (
        !isCurrentGeneration(generation) ||
        qualityChangeRef.current !== token ||
        streamRef.current !== activeStream
      ) {
        return;
      }

      commitQuality(nextProfile);
      if (captureChanged) {
        setDetails(captureDetails(activeStream));
      }
      if (peerAssistedRef.current) {
        signalRef.current?.setHostQualitySettings(nextProfile);
      }
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
            ? "分享设置已更新，但部分观看连接未能应用新参数"
            : null;
        const warning = sfuWarning ?? connectionWarning;
        const successNotice =
          audioChanged && !videoChanged
            ? `音频质量已切换为 ${SCREEN_AUDIO_QUALITY_LABELS[resolveScreenAudioQuality(nextProfile.screenAudioQuality)]}`
            : videoChanged && audioChanged
              ? "分享设置已应用"
              : `画质已切换为 ${qualitySettingsLabel(nextProfile)}`;
        setNotice(warning || successNotice);
      }
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token
      ) {
        if (pendingQualityChangeRef.current === null) {
          advancedQualityRef.current = qualitySettingsRef.current;
          setAdvancedQuality(qualitySettingsRef.current);
        }
        setNotice(readableError(error, "quality"));
      }
    } finally {
      if (qualityChangeRef.current === token) {
        qualityChangeRef.current = null;
        const pending = pendingQualityChangeRef.current;
        pendingQualityChangeRef.current = null;
        if (
          pending &&
          isCurrentGeneration(generation) &&
          !qualitySettingsEqual(qualitySettingsRef.current, pending)
        ) {
          void changeQuality(pending);
        } else {
          setChangingQuality(false);
        }
      }
    }
  }

  function toggleSharingPause(): void {
    const activeStream = streamRef.current;
    if (phase !== "live" || !activeStream) {
      return;
    }
    if (sharingPausedRef.current) {
      if (!setMediaPaused(activeStream, false)) {
        setNotice("当前分享没有可恢复的媒体轨道");
        return;
      }
      hostSfuRouteRef.current?.setPaused(false);
      if (signalRef.current?.setSharingPaused(false) !== true) {
        setMediaPaused(activeStream, true);
        hostSfuRouteRef.current?.setPaused(true);
        signalRef.current?.confirmSharingPaused();
        setNotice("服务器连接正在恢复，分享仍保持暂停");
        return;
      }
      sharingPausedRef.current = false;
      setSharingPaused(false);
      setNotice("音视频分享已恢复");
      return;
    }
    if (!setMediaPaused(activeStream, true)) {
      setNotice("当前分享没有可暂停的媒体轨道");
      return;
    }
    sharingPausedRef.current = true;
    setSharingPaused(true);
    hostSfuRouteRef.current?.setPaused(true);
    discardPreparedHostChild();
    setNotice(
      signalRef.current?.setSharingPaused(true) === true
        ? "音视频分享已暂停"
        : "服务器连接正在恢复，分享保持暂停",
    );
  }

  function removePeer(peerId: string): void {
    clearViewerQualityEvidence(peerId);
    const peer = peersRef.current.get(peerId);
    if (peer) {
      retiredConnectionsRef.current.set(peerId, peer.connectionId);
      peer.dispose();
    }
    peersRef.current.delete(peerId);
    setPeerSnapshots((current) => {
      const next = new Map(current);
      next.delete(peerId);
      return next;
    });
  }

  function hostChildIsAssigned(peerId: string): boolean {
    return activeHostChildPeerIdsRef.current.includes(peerId);
  }

  function discardPreparedHostChild(): void {
    const provisional = hostProvisionalChildRef.current;
    hostProvisionalChildRef.current = null;
    provisional?.discard();
  }

  function reportSenderQuality(
    snapshot: PeerSnapshot,
    revision: number,
  ): void {
    if (
      !routePolicyRef.current.topologyOptimization ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const evidence = senderQualityEvidenceFromSnapshot(snapshot, revision);
    if (evidence) {
      signalRef.current?.send(evidence);
    }
  }

  function prepareHostChild(
    revision: number,
    assignment: HostRouteAssignment,
    candidate: PreparedRouteCandidate,
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
      activeConnectionId: (peerId) =>
        peersRef.current.get(peerId)?.connectionId ?? null,
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
          reportSenderQuality(snapshot, activeRouteRevisionRef.current);
        }
      },
      onPreparedUpdate: (_peer, snapshot, revision) => {
        if (isCurrentGeneration(generation)) {
          reportSenderQuality(snapshot, revision);
        }
      },
    });
    return hostProvisionalChildRef.current.prepare({
      revision,
      assignment,
      candidate,
      activeChildPeerIds: activeHostChildPeerIdsRef.current,
      maxMediaEdges: endpointMediaCopyCapacityRef.current,
      iceConfig,
      stream,
      profile: qualitySettingsRef.current,
      videoCodec: videoCodecRef.current,
    });
  }

  function activatePreparedHostChild(
    revision: number,
    assignment: HostRouteAssignment,
  ): void {
    const activeChildPeerIds = activeHostChildPeerIdsRef.current;
    const provisional = hostProvisionalChildRef.current;
    const activation = provisional?.activate({
      revision,
      assignment,
      activeChildPeerIds,
      maxMediaEdges: endpointMediaCopyCapacityRef.current,
    }) ?? { kind: "ordinary" as const };
    if (activation.kind === "promote") {
      hostProvisionalChildRef.current = null;
      const previous = peersRef.current.get(activation.peerId);
      peersRef.current.set(activation.peerId, activation.peer);
      previous?.dispose();
      updatePeerSnapshot(activation.peer.getSnapshot());
    } else {
      discardPreparedHostChild();
    }
  }

  async function startPeer(
    peerId: string,
    generation: number,
    attempt = 0,
  ): Promise<void> {
    if (!isCurrentGeneration(generation) || !hostChildIsAssigned(peerId)) {
      return;
    }
    // Preserve healthy media across control reconnects, but replace a stalled
    // negotiation whose offer or answer may have been lost with the WebSocket.
    const existing = peersRef.current.get(peerId);
    if (existing) {
      if (existing.isConnected()) {
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

    let peer: HostPeer;
    peer = new HostPeer(
      peerId,
      iceConfig,
      activeStream,
      qualitySettingsRef.current,
      {
        sendSignal: (targetPeerId, payload) =>
          targetPeerId === peerId &&
          isCurrentGeneration(generation) &&
          hostChildIsAssigned(peerId) &&
          peersRef.current.get(peerId) === peer &&
          signalRef.current === signal
            ? signal.send({ type: "signal", targetPeerId, payload })
            : false,
        onUpdate: (snapshot) => {
          if (
            isCurrentGeneration(generation) &&
            peersRef.current.get(peerId) === peer
          ) {
            updatePeerSnapshot(snapshot);
            reportSenderQuality(snapshot, activeRouteRevisionRef.current);
          }
        },
      },
      videoCodecRef.current,
    );
    peersRef.current.set(peerId, peer);
    let started: boolean;
    try {
      started = await peer.start();
    } catch (error) {
      if (peersRef.current.get(peerId) === peer) {
        removePeer(peerId);
      }
      throw error;
    }
    if (started || peersRef.current.get(peerId) !== peer) {
      return;
    }

    removePeer(peerId);
    if (peerAssistedRef.current || attempt >= 1) {
      return;
    }
    window.setTimeout(() => {
      if (
        isCurrentGeneration(generation) &&
        !peerAssistedRef.current &&
        hostChildIsAssigned(peerId) &&
        !peersRef.current.has(peerId)
      ) {
        void startPeer(peerId, generation, attempt + 1).catch(
          (error: unknown) => {
            if (
              isCurrentGeneration(generation) &&
              hostChildIsAssigned(peerId)
            ) {
              setNotice(readableError(error, "connection"));
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
    if (!hostChildIsAssigned(peerId)) {
      return;
    }
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

  function reconcileHostChildren(
    childPeerIds: string[],
    generation: number,
  ): void {
    activeHostChildPeerIdsRef.current = [
      ...new Set(childPeerIds),
    ].slice(0, endpointMediaCopyCapacityRef.current);
    reconcileBoundedMediaChildren(
      peersRef.current.keys(),
      activeHostChildPeerIdsRef.current,
      endpointMediaCopyCapacityRef.current,
      removePeer,
      (peerId) => {
        void startPeer(peerId, generation).catch((error: unknown) => {
          if (isCurrentGeneration(generation)) {
            setNotice(readableError(error, "connection"));
          }
        });
      },
    );
  }

  function handleSignalMessage(
    message: ServerMessage,
    generation: number,
    activeRoom: HostRoomState,
    reauthenticated: boolean,
    pendingQualitySettings: QualitySettings | null,
  ): void {
    if (!isCurrentGeneration(generation)) {
      return;
    }
    if (message.type === "authenticated" && message.role === "host") {
      discardPreparedHostChild();
      hostPeerIdRef.current = message.peerId;
      endpointMediaCopyCapacityRef.current = message.endpointMediaCopyCapacity;
      const authenticatedProfile = {
        codeEntryPolicy: message.codeEntryPolicy,
        roomPassword: message.viewerPasswordEnabled
          ? creationProfileRef.current.roomPassword
          : null,
      };
      saveCreationProfile(authenticatedProfile);
      creationProfileRef.current = authenticatedProfile;
      setCreationProfile(authenticatedProfile);
      setViewerPasswordEnabled(message.viewerPasswordEnabled);
      setViewerPasswordDraft(authenticatedProfile.roomPassword ?? "");
      setViewerPasswordVisible(false);
      clearAllViewerQualityEvidence();
      setSfuStandbyUrl(
        "sfuStandbyUrl" in message ? message.sfuStandbyUrl : null,
      );
      setMaxViewers(message.maxViewers);
      setRoom((current) =>
        mergeAuthenticatedHostRoom(
          current,
          activeRoom.roomId,
          message.roomExpiresAt,
          message.codeEntryPolicy,
        ),
      );
      if (
        "mediaMode" in message &&
        message.mediaMode === "peer-assisted"
      ) {
        routePolicyRef.current = { ...message.routePolicy };
        setRoutePolicy({ ...message.routePolicy });
        const currentQualitySettings =
          pendingQualitySettings ?? message.qualitySettings;
        activeRouteRevisionRef.current = message.routeRevision;
        peerAssistedRef.current = true;
        if (reauthenticated) {
          commitQuality(currentQualitySettings);
          const endpointUpdates = [
            ...[...peersRef.current.values()].map((peer) =>
              peer.updateProfile(currentQualitySettings),
            ),
            ...(hostProvisionalChildRef.current
              ? [
                  hostProvisionalChildRef.current.updateProfile(
                    currentQualitySettings,
                  ),
                ]
              : []),
          ];
          void Promise.allSettled(endpointUpdates);
        }
        const route = ensureHostSfuRoute(generation);
        void route
          .resyncAuthoritative({
            revision: message.routeRevision,
            phase: "active",
            assignment: message.routeAssignment,
          })
          .then(async () => {
            if (reauthenticated && hostSfuRouteRef.current === route) {
              await route.updateProfile(currentQualitySettings);
            }
            showHostSfuQualityWarning(route, generation);
          });
        return;
      }
      activeRouteRevisionRef.current = 0;
      peerAssistedRef.current = false;
      clearHostSfuRoute();
      reconcileHostChildren(message.viewerPeerIds, generation);
      return;
    }
    if (message.type === "viewer-presence") {
      setParticipantPresence(message.viewers);
      return;
    }
    if (message.type === "pause-sharing-source") {
      if (message.shareGeneration !== shareGenerationRef.current) {
        return;
      }
      const activeStream = streamRef.current;
      if (activeStream) {
        setMediaPaused(activeStream, true);
      }
      hostSfuRouteRef.current?.setPaused(true);
      sharingPausedRef.current = true;
      setSharingPaused(true);
      signalRef.current?.confirmSharingPaused();
      setNotice("分享仍保持暂停");
      return;
    }
    if (message.type === "route-update") {
      if (peerAssistedRef.current) {
        const route = ensureHostSfuRoute(generation);
        const accepted = route.accept(message);
        if (accepted === "stale") return;
        if (message.phase === "prepare") {
          if (message.candidate.transport === "direct") {
            prepareHostChild(
              message.revision,
              message.assignment,
              message.candidate,
              generation,
            );
          } else {
            discardPreparedHostChild();
          }
        } else {
          activatePreparedHostChild(message.revision, message.assignment);
        }
        if (
          message.phase === "active" &&
          message.revision !== activeRouteRevisionRef.current
        ) {
          activeRouteRevisionRef.current = message.revision;
        }
        showHostSfuQualityWarning(route, generation);
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
        reconcileHostChildren(
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
      reconcileHostChildren(
        [...activeHostChildPeerIdsRef.current, message.peerId],
        generation,
      );
      return;
    }
    if (message.type === "peer-waiting") {
      if (!peerAssistedRef.current) {
        reconcileHostChildren(
          activeHostChildPeerIdsRef.current.filter(
            (peerId) => peerId !== message.peerId,
          ),
          generation,
        );
      }
      return;
    }
    if (message.type === "peer-left") {
      if (peerAssistedRef.current) {
        return;
      }
      reconcileHostChildren(
        activeHostChildPeerIdsRef.current.filter(
          (peerId) => peerId !== message.peerId,
        ),
        generation,
      );
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
          setNotice(readableError(error, "connection"));
        }
      });
      return;
    }
    if (message.type === "room-closed") {
      if (!forgetRoom(activeRoom)) {
        return;
      }
      endSharing(
        message.reason === "expired" ? "房间已过期" : "房间已关闭",
        false,
      );
      return;
    }
    if (message.type === "error") {
      if (["INVALID_TOKEN", "ROOM_EXPIRED"].includes(message.code)) {
        if (!forgetRoom(activeRoom)) {
          return;
        }
        endSharing("房间已失效，再次点击将创建新房", false);
        return;
      }
      if (message.code === "AUTH_REQUIRED") {
        return;
      }
      if (message.code === "HOST_ALREADY_CONNECTED") {
        endSharing(hostServerErrorNotice(message.code), false);
        return;
      }
      setNotice(hostServerErrorNotice(message.code));
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
      setNotice(readableError(error, "capture"));
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

    videoCodecRef.current = await resolveStreamVideoCodec(captured);
    setResolvedVideoCodec(videoCodecRef.current.primary);
    if (!isCurrentGeneration(generation)) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    let createdRoom: HostRoomState | null = null;
    let claimedRoom = false;
    try {
      let reusableRoom = room;
      createdRoom = reusableRoom ?? hostRoomFromStored(readHostRoom());
      if (!createdRoom) {
        const response = await createRoom(
          creationProfileRef.current.codeEntryPolicy,
          creationProfileRef.current.roomPassword,
          readPreferredRoomId(),
        );
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
      let replacementAttempted = false;
      const connectSignal = (activeRoom: HostRoomState): SignalingClient => {
        let authenticated = false;
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
            qualitySettings: qualitySettingsRef.current,
            routePolicy: routePolicyRef.current,
            viewerPresence: true,
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
            onTerminated: (reason) => {
              if (
                isCurrentGeneration(generation) &&
                signalRef.current === signal
              ) {
                endSharing(hostTerminationMessage(reason), false);
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
              if (
                !authenticated &&
                message.type === "error" &&
                (message.code === "INVALID_TOKEN" ||
                  message.code === "ROOM_EXPIRED") &&
                !replacementAttempted
              ) {
                replacementAttempted = true;
                signalRef.current = null;
                signal.stop();
                setSignalStatus("offline");
                forgetRoom(activeRoom);
                void createReplacementRoom();
                return;
              }
              const reauthenticated =
                authenticated &&
                message.type === "authenticated" &&
                message.role === "host";
              if (message.type === "authenticated" && message.role === "host") {
                authenticated = true;
                iceConfigRef.current = message.iceConfig;
                peersRef.current.forEach((peer) =>
                  peer.updateIceConfig(message.iceConfig),
                );
                writeHostRoom({
                  ...activeRoom,
                  expiresAt: message.roomExpiresAt,
                });
                writePreferredRoom(activeRoom.roomId);
                setPhase("live");
              }
              handleSignalMessage(
                message,
                generation,
                activeRoom,
                reauthenticated,
                reauthenticated
                  ? signal.pendingHostQualitySettings(shareGeneration)
                  : null,
              );
            },
          },
        );
        return signal;
      };
      const createReplacementRoom = async (): Promise<void> => {
        try {
          const response = await createRoom(
            creationProfileRef.current.codeEntryPolicy,
            creationProfileRef.current.roomPassword,
            readPreferredRoomId(),
          );
          const replacement = hostRoomFromCreated(response);
          if (!isCurrentGeneration(generation)) {
            captured.getTracks().forEach((track) => track.stop());
            closeAbandonedRoom(replacement);
            return;
          }
          writeHostRoom(replacement);
          setRoom(replacement);
          const replacementSignal = connectSignal(replacement);
          signalRef.current = replacementSignal;
          replacementSignal.start();
        } catch (error) {
          if (!isCurrentGeneration(generation)) {
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
          setNotice(readableError(error, "room"));
          setPhase("error");
        }
      };
      const signal = connectSignal(createdRoom);
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
      setNotice(readableError(error, "room"));
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
        setNotice(readableError(error, "source"));
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
    invalidateSenderQualityEvidence();
    if (routePolicyRef.current.topologyOptimization) {
      signalRef.current?.send({ type: "reset-sender-quality" });
    }
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
              setNotice(readableError(error, "connection"));
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
      setNotice("无法复制邀请链接，请稍后重试");
    }
  }

  function handleRoomAccessFailure(
    error: unknown,
    activeRoom: HostRoomState,
  ): void {
    if (error instanceof ApiError && error.status === 401) {
      onAuthorizationRequired?.();
    }
    if (error instanceof ApiError && error.status === 404) {
      forgetRoom(activeRoom);
    }
    if (!isCurrentRoomAuthority(activeRoom) && roomRef.current !== null) {
      return;
    }
    setNotice(
      error instanceof ApiError
        ? error.message
        : "当前无法更新房间设置，请稍后重试",
    );
  }

  async function changeCodeEntryPolicy(policy: CodeEntryPolicy): Promise<void> {
    if (policy === activeCodeEntryPolicy) {
      setNotice(null);
      return;
    }
    const activeRoom = roomRef.current;
    if (!activeRoom) {
      return;
    }
    const mutation = beginRoomMutation("access");
    if (!mutation) {
      return;
    }
    try {
      const response = await updateRoomAccess(
        activeRoom.roomId,
        activeRoom.hostToken,
        { action: "set-code-entry-policy", policy },
      );
      if (response.type !== "code-entry-policy-updated") {
        throw new Error("Unexpected room access response");
      }
      if (!isCurrentRoomAuthority(activeRoom)) {
        return;
      }
      const profile = {
        codeEntryPolicy: response.codeEntryPolicy,
        roomPassword: creationProfileRef.current.roomPassword,
      };
      saveCreationProfile(profile);
      creationProfileRef.current = profile;
      setCreationProfile(profile);
      setViewerPasswordEnabled(response.viewerPasswordEnabled);
      setViewerPasswordVisible(false);
      const updatedRoom = {
        ...roomRef.current!,
        codeEntryPolicy: response.codeEntryPolicy,
      };
      roomRef.current = updatedRoom;
      setRoom(updatedRoom);
      setNotice(
        response.codeEntryPolicy === "open"
          ? "房间已设为公开"
          : response.viewerPasswordEnabled
            ? "房间已设为私密，可凭邀请或密码加入"
            : "房间已设为私密，仅限邀请加入",
      );
    } catch (error) {
      handleRoomAccessFailure(error, activeRoom);
    } finally {
      finishRoomMutation(mutation);
    }
  }

  async function changeViewerGrant(action: "rotate" | "revoke"): Promise<void> {
    const activeRoom = roomRef.current;
    if (!activeRoom) {
      return;
    }
    const mutation = beginRoomMutation("access");
    if (!mutation) {
      return;
    }
    try {
      const response = await updateRoomAccess(
        activeRoom.roomId,
        activeRoom.hostToken,
        {
          action:
            action === "rotate"
              ? "rotate-viewer-grant"
              : "revoke-viewer-grant",
        },
      );
      if (response.type !== "viewer-grant-updated") {
        throw new Error("Unexpected room access response");
      }
      if (!isCurrentRoomAuthority(activeRoom)) {
        return;
      }
      replaceViewerInvite(activeRoom.roomId, response.inviteUrl);
      const updatedRoom = {
        ...roomRef.current!,
        inviteUrl: response.inviteUrl,
      };
      roomRef.current = updatedRoom;
      setRoom(updatedRoom);
      setNotice(
        response.inviteUrl
          ? "邀请链接已更新"
          : "邀请链接已撤销",
      );
    } catch (error) {
      handleRoomAccessFailure(error, activeRoom);
    } finally {
      finishRoomMutation(mutation);
    }
  }

  async function changeViewerPassword(password: string | null): Promise<void> {
    if (
      password !== null &&
      !viewerPasswordSchema.safeParse(password).success
    ) {
      setNotice(
        `房间密码只需 1-${MAX_VIEWER_PASSWORD_LENGTH} 个可见字符`,
      );
      return;
    }
    const activeRoom = roomRef.current;
    if (!activeRoom) {
      return;
    }
    const hadPassword = viewerPasswordEnabled;
    const mutation = beginRoomMutation("access");
    if (!mutation) {
      return;
    }
    try {
      const response = await updateRoomAccess(
        activeRoom.roomId,
        activeRoom.hostToken,
        { action: "set-viewer-password", password },
      );
      if (response.type !== "viewer-password-updated") {
        throw new Error("Unexpected room access response");
      }
      if (!isCurrentRoomAuthority(activeRoom)) {
        return;
      }
      const passwordProfile = {
        codeEntryPolicy:
          activeRoom.codeEntryPolicy ??
          creationProfileRef.current.codeEntryPolicy,
        roomPassword: password,
      };
      saveCreationProfile(passwordProfile);
      creationProfileRef.current = passwordProfile;
      setCreationProfile(passwordProfile);
      setViewerPasswordEnabled(response.enabled);
      setViewerPasswordDraft(password ?? "");
      setViewerPasswordVisible(false);
      setNotice(
        password === null
          ? "房间密码已移除，仅限邀请加入"
          : hadPassword
            ? "房间密码已更新"
            : "房间密码已设置",
      );
    } catch (error) {
      handleRoomAccessFailure(error, activeRoom);
    } finally {
      finishRoomMutation(mutation);
    }
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

  const activeCodeEntryPolicy =
    room?.codeEntryPolicy ?? creationProfile.codeEntryPolicy;
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
                {room && (
                  <RoomCode
                    roomId={room.roomId}
                    onReplace={replaceCurrentRoom}
                    replaceDisabled={phase === "starting" || roomMutating}
                  />
                )}
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
                    disabled={
                      switchingSource ||
                      changingQuality
                    }
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
                    disabled={
                      switchingSource ||
                      changingQuality
                    }
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
              <video ref={videoRef} autoPlay muted playsInline />
            ) : phase === "idle" ||
              phase === "ended" ||
              phase === "error" ? (
              <div className="stage-placeholder stage-entry">
                {phase === "ended" && room && (
                  <span className="stage-status">已停止分享</span>
                )}
                <StageEntryActions
                  joiningRoom={joiningRoom}
                  onStartSharing={() => {
                    setJoiningRoom(false);
                    void startSharing();
                  }}
                  onJoinToggle={() =>
                    setJoiningRoom((current) => !current)
                  }
                />
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
                {switchingSource ? (
                  <RefreshCw
                    size={36}
                    strokeWidth={1.5}
                    className="spin"
                    aria-hidden="true"
                  />
                ) : sharingPaused ? (
                  <Pause size={36} strokeWidth={1.5} aria-hidden="true" />
                ) : phase === "starting" ? (
                  <LoaderCircle
                    size={36}
                    strokeWidth={1.5}
                    className="spin"
                    aria-hidden="true"
                  />
                ) : (
                  <EyeOff size={36} strokeWidth={1.5} aria-hidden="true" />
                )}
                <span>
                  {switchingSource
                    ? "正在切换来源"
                    : sharingPaused
                      ? "音视频分享已暂停"
                      : phase === "starting"
                        ? "正在连接"
                        : "本地预览已暂停，分享仍在继续"}
                </span>
              </div>
            )}
          </div>

          {showConnectionDetails && details && stream && (
            <div className="capture-strip" aria-label="实际捕获参数">
              <span>{details.resolution}</span>
              <span>{details.frameRate ? `${details.frameRate.toFixed(0)} fps` : "帧率未知"}</span>
              <span>{resolvedVideoCodec?.toUpperCase() ?? "编码待定"}</span>
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
          />

          <div className="setup-controls">
            <div className="quality-controls">
              <fieldset className="control-group">
                <legend>视频预设</legend>
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
                        title={`${QUALITY_PROFILE_LABELS[id]} · ${(QUALITY_PROFILES[id].maxBitrate / 1_000_000).toFixed(0)} Mbps`}
                        disabled={
                          phase === "starting" ||
                          switchingSource
                        }
                        onClick={() =>
                          void changeQuality({
                            ...QUALITY_PROFILES[id],
                            screenAudioQuality: resolveScreenAudioQuality(
                              advancedQualityRef.current.screenAudioQuality,
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
                <summary>高级设置</summary>
                <div className="advanced-quality-grid">
                  <label>
                    <span>分辨率上限</span>
                    <select
                      value={advancedQuality.resolution}
                      disabled={phase === "starting" || switchingSource}
                      onChange={(event) =>
                        changeAdvancedQuality({
                          resolution: event.target
                            .value as QualitySettings["resolution"],
                        })
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
                        disabled={phase === "starting" || switchingSource}
                        onChange={(event) =>
                          changeAdvancedQuality({
                            maxFramerate: Number(event.target.value),
                          })
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
                        disabled={phase === "starting" || switchingSource}
                        onChange={(event) =>
                          changeAdvancedQuality({
                            maxBitrate: Number(event.target.value),
                          })
                        }
                      />
                      <output>
                        {(advancedQuality.maxBitrate / 1_000_000).toFixed(1)} Mbps
                      </output>
                    </div>
                  </label>
                  <fieldset className="control-group quality-priority">
                    <legend>画面偏好</legend>
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
                          disabled={phase !== "live" || switchingSource}
                          onClick={() =>
                            changeAdvancedQuality({
                              degradationPreference: preference,
                            })
                          }
                        >
                          <span>
                            {DEGRADATION_PREFERENCE_LABELS[preference]}
                          </span>
                          <small>
                            {DEGRADATION_PREFERENCE_HINTS[preference]}
                          </small>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="control-group quality-priority">
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
                          title={`${SCREEN_AUDIO_QUALITY_LABELS[audioQuality]} · ${SCREEN_AUDIO_BITRATES[audioQuality] / 1_000} kbps 上限`}
                          disabled={
                            phase === "starting" ||
                            switchingSource
                          }
                          onClick={() =>
                            changeScreenAudioQuality(audioQuality)
                          }
                        >
                          <span>
                            {SCREEN_AUDIO_QUALITY_LABELS[audioQuality]}
                          </span>
                          <small>
                            {SCREEN_AUDIO_BITRATES[audioQuality] / 1_000} kbps
                          </small>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="control-group route-policy-controls">
                    <legend>路由策略</legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={routePolicy.topologyOptimization}
                        disabled={phase === "starting" || phase === "live"}
                        onChange={(event) =>
                          changeRoutePolicy({
                            topologyOptimization: event.target.checked,
                          })
                        }
                      />
                      <span>
                        自动优化拓扑
                        <small>观看中逐步选择更健康的连接</small>
                      </span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={routePolicy.peerOnly}
                        disabled={phase === "starting" || phase === "live"}
                        onChange={(event) =>
                          changeRoutePolicy({ peerOnly: event.target.checked })
                        }
                      />
                      <span>
                        纯 P2P
                        <small>不使用媒体服务器，无法直连时停止尝试</small>
                      </span>
                    </label>
                  </fieldset>
                  <fieldset className="control-group quality-priority">
                    <legend>视频编码</legend>
                    <div className="segmented-control">
                      {(["vp8", "auto", "h264"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={
                            videoCodecMode === mode ? "is-selected" : undefined
                          }
                          aria-pressed={videoCodecMode === mode}
                          disabled={phase === "starting" || phase === "live"}
                          onClick={() => changeVideoCodecMode(mode)}
                        >
                          <span>{mode === "auto" ? "自动" : mode.toUpperCase()}</span>
                          <small>
                            {mode === "vp8"
                              ? "兼容优先"
                              : mode === "h264"
                                ? "硬件优先"
                                : resolvedVideoCodec
                                  ? resolvedVideoCodec.toUpperCase()
                                  : "自动选择"}
                          </small>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
              </details>
            </div>
          </div>
          {room && (
            <div className="invite-bar">
              <div className="invite-primary">
                <div className="invite-heading">
                  <div className="invite-heading-copy">
                    <span className="field-label">邀请链接</span>
                    <span className="invite-status">
                      {room.inviteUrl ? "可用" : "暂无"}
                    </span>
                  </div>
                  <div className="invite-icon-actions">
                    <button
                      className="icon-button invite-icon-action"
                      type="button"
                      title="更新邀请链接"
                      aria-label="更新邀请链接"
                      disabled={roomMutating}
                      onClick={() => void changeViewerGrant("rotate")}
                    >
                      <RefreshCw size={17} aria-hidden="true" />
                    </button>
                    <button
                      className="icon-button invite-icon-action is-danger"
                      type="button"
                      title="撤销邀请链接"
                      aria-label="撤销邀请链接"
                      disabled={!room.inviteUrl || roomMutating}
                      onClick={() => void changeViewerGrant("revoke")}
                    >
                      <Link2Off size={17} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="invite-copy-row">
                  <span
                    className="invite-url"
                    title={room.inviteUrl ?? undefined}
                  >
                    {room.inviteUrl ??
                      (activeCodeEntryPolicy === "open"
                        ? "暂无邀请链接，仍可凭房间号加入"
                        : viewerPasswordEnabled
                          ? "暂无邀请链接，仍可凭房间号和密码加入"
                          : "暂无邀请链接，请先更新链接再邀请他人")}
                  </span>
                  <button
                    className="button button-primary invite-copy-action"
                    type="button"
                    disabled={!room.inviteUrl || roomMutating}
                    onClick={() => void copyInvite()}
                  >
                    {copied ? (
                      <Check size={16} aria-hidden="true" />
                    ) : (
                      <Copy size={16} aria-hidden="true" />
                    )}
                    {copied ? "已复制" : "复制邀请链接"}
                  </button>
                </div>
              </div>
              <div className="room-entry-policy">
                <div className="room-entry-heading">
                  <span className="field-label">准入方式</span>
                </div>
                <div className="segmented-control room-policy-control">
                  {(
                    [
                      ["open", "公开", Globe2],
                      ["private", "私密", LockKeyhole],
                    ] as const
                  ).map(([policy, label, Icon]) => (
                    <button
                      key={policy}
                      type="button"
                      className={`room-policy-option policy-${policy}${
                        activeCodeEntryPolicy === policy
                          ? " is-selected"
                          : ""
                      }`}
                      aria-pressed={activeCodeEntryPolicy === policy}
                      disabled={roomMutating}
                      onClick={() => void changeCodeEntryPolicy(policy)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                {activeCodeEntryPolicy === "private" && (
                  <form
                    className={`viewer-password-control${
                      viewerPasswordEnabled ? " has-password" : ""
                    }`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void changeViewerPassword(viewerPasswordDraft);
                    }}
                  >
                    <label htmlFor="viewer-password">
                      {viewerPasswordEnabled
                        ? "房间密码已设置"
                        : "房间密码未设置"}
                    </label>
                    <span className="input-with-icon">
                      <KeyRound size={16} aria-hidden="true" />
                      <input
                        id="viewer-password"
                        type={viewerPasswordVisible ? "text" : "password"}
                        value={viewerPasswordDraft}
                        maxLength={MAX_VIEWER_PASSWORD_LENGTH}
                        autoComplete="new-password"
                        placeholder={
                          viewerPasswordEnabled
                            ? "输入密码"
                            : "设置后可凭房间号加入"
                        }
                        autoFocus={!viewerPasswordEnabled}
                        disabled={roomMutating}
                        onChange={(event) =>
                          setViewerPasswordDraft(event.target.value)
                        }
                      />
                      {viewerPasswordEnabled && viewerPasswordDraft.length > 0 && (
                        <button
                          className="password-visibility-action"
                          type="button"
                          title={viewerPasswordVisible ? "隐藏密码" : "显示密码"}
                          aria-label={
                            viewerPasswordVisible ? "隐藏房间密码" : "显示房间密码"
                          }
                          aria-pressed={viewerPasswordVisible}
                          disabled={roomMutating}
                          onClick={() =>
                            setViewerPasswordVisible((current) => !current)
                          }
                        >
                          {viewerPasswordVisible ? (
                            <EyeOff size={17} aria-hidden="true" />
                          ) : (
                            <Eye size={17} aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </span>
                    <button
                      className="icon-button"
                      type="submit"
                      title={viewerPasswordEnabled ? "更改房间密码" : "设置房间密码"}
                      aria-label={
                        viewerPasswordEnabled ? "更改房间密码" : "设置房间密码"
                      }
                      disabled={
                        roomMutating ||
                        viewerPasswordDraft.length === 0 ||
                        (viewerPasswordEnabled &&
                          viewerPasswordDraft ===
                            creationProfile.roomPassword)
                      }
                    >
                      <Check size={18} aria-hidden="true" />
                    </button>
                    {viewerPasswordEnabled && (
                      <button
                        className="icon-button"
                        type="button"
                        title="移除房间密码"
                        aria-label="移除房间密码"
                        disabled={roomMutating}
                        onClick={() => void changeViewerPassword(null)}
                      >
                        <X size={18} aria-hidden="true" />
                      </button>
                    )}
                  </form>
                )}
              </div>
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
                qualityEvidence !== undefined &&
                qualityEvidenceUpstreamMatches(
                  qualityEvidence,
                  viewer.upstream,
                );
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
              const detailMetrics = hasMatchingQualityEvidence
                ? metricsFromQualityEvidence(qualityEvidence)
                : snapshot && hasPeerRouteEvidence(snapshot)
                  ? snapshot.metrics
                  : null;
              const detailDirection = hasMatchingQualityEvidence
                ? "receive"
                : "send";
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
                    </div>
                  )}
                  {showConnectionDetails && detailMetrics && (
                    <StatsGrid
                      metrics={detailMetrics}
                      direction={detailDirection}
                      progressive
                    />
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
