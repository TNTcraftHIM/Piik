import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
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
import { qualityLimitationSummary } from "../components/connection-details";
import { AppHeader, LedStrip, type LedState } from "../components/living/Header";
import { Couch, type CouchEntry } from "../components/living/Couch";
import { useMetricsExpanded } from "../components/living/Metrics";
import { PawnDetail } from "../components/living/PawnDetail";
import {
  RoomAdmissionBadge,
  RoomChip,
} from "../components/living/RoomChip";
import { RouteTree } from "../components/living/RouteTree";
import {
  ViewerOverview,
  type ViewerOverviewEntry,
} from "../components/living/ViewerOverview";
import type { ComicKind } from "../components/living/Comic";
import { ComicTooltip } from "../components/living/ComicTooltip";
import type { HintKind } from "../components/living/hints";
import {
  StageOverlay,
  StageTv,
  StaticNoise,
  StoryBoard,
} from "../components/living/Stage";
import {
  Btn,
  Cap,
  Chip,
  FieldCap,
  NameTag,
  Pill,
  Row,
  RowGroup,
  StatusText,
  SwitchItem,
  VisGlyph,
} from "../components/living/primitives";
import { hasPeerRouteEvidence } from "../components/status-badge-model";
import { Glyph, type GlyphName } from "../ui/icons";
import { say, useCopy, type CopyKey } from "../ui/copy";
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
  readStoredDisplayName,
  saveDisplayName,
} from "../lib/display-name";
import { useDocumentTitle } from "../ui/document-title";
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
  roomRouteForExplicitEntry,
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
  matchingQualityProfileId,
  QUALITY_PROFILES,
  QUALITY_RESOLUTIONS,
  qualitySettingsEqual,
  qualitySettingsLabel,
  resolveScreenAudioQuality,
  SCREEN_AUDIO_BITRATES,
  setMediaPaused,
  videoQualitySettingsEqual,
  type DegradationPreference,
  type QualityProfileId,
  type QualityResolution,
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
  retainPresentViewerQualityEvidence,
  type ViewerQualityEvidencePresentation,
} from "../media/viewer-quality-evidence";
import type {
  ConnectionMetrics,
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

type NoticeValue =
  | { kind: "text"; text: string }
  | { kind: "key"; key: CopyKey; vars?: Record<string, string> };

const SIGNAL_LED_STATE: Record<SignalConnectionState, LedState> = {
  connected: "live",
  connecting: "busy",
  reconnecting: "warn",
  offline: "off",
};

const SIGNAL_LED_LABEL: Record<SignalConnectionState, CopyKey> = {
  connected: "state.signal.connected",
  connecting: "state.signal.connecting",
  reconnecting: "state.signal.reconnecting",
  offline: "state.signal.offline",
};

const QUALITY_PROFILE_CAPTIONS: Record<QualityProfileId, CopyKey> = {
  "720p30": "host.quality.720p30",
  "1080p30": "host.quality.1080p30",
  "1080p60": "host.quality.1080p60",
};

const PREFERENCE_PRESENTATION: Record<
  DegradationPreference,
  { icon: GlyphName; cap: CopyKey; hint: CopyKey }
> = {
  "maintain-resolution": {
    icon: "mountain",
    cap: "host.advanced.preference.resolution",
    hint: "host.advanced.preference.resolutionHint",
  },
  balanced: {
    icon: "balance",
    cap: "host.advanced.preference.balanced",
    hint: "host.advanced.preference.balancedHint",
  },
  "maintain-framerate": {
    icon: "zap",
    cap: "host.advanced.preference.framerate",
    hint: "host.advanced.preference.framerateHint",
  },
};

const AUDIO_QUALITY_CAPTIONS: Record<ScreenAudioQuality, CopyKey> = {
  saver: "host.advanced.audio.saver",
  music: "host.advanced.audio.music",
  "very-high": "host.advanced.audio.veryHigh",
};

type PresentedPeerState =
  | RTCPeerConnectionState
  | "routing"
  | "waiting"
  | "reconnecting";

const PEER_STATE_CAPTIONS: Record<PresentedPeerState, CopyKey> = {
  new: "state.peer.new",
  connecting: "state.peer.connecting",
  connected: "state.peer.connected",
  routing: "state.peer.routing",
  waiting: "state.peer.waiting",
  reconnecting: "state.peer.reconnecting",
  failed: "state.peer.failed",
  disconnected: "state.peer.disconnected",
  closed: "state.peer.closed",
};

// Scanline glyph on each quality tile: denser scanlines (plus a motion wave
// at 60 fps) read as a higher preset without any text.
function QualityTileGlyph({ density }: { density: number }) {
  const lines = [2, 3, 4][density] ?? 3;
  return (
    <svg width={28} height={38} viewBox="0 0 28 38" fill="none" aria-hidden="true">
      <rect x={2} y={3} width={24} height={26} rx={4} stroke="currentColor" strokeWidth={2.2} />
      {Array.from({ length: lines }, (_, index) => (
        <path
          key={index}
          d={`M6 ${13 + index * 6}h16`}
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          opacity={0.45 + index * 0.2}
        />
      ))}
      {density === 2 ? (
        <path
          d="M7 25.5c1.4 0 1.4-2 2.8-2s1.4 2 2.8 2 1.4-2 2.8-2 1.4 2 2.8 2"
          stroke="currentColor"
          strokeWidth={1.6}
          fill="none"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

type ViewerQualityEvidence = Extract<
  ServerMessage,
  { type: "viewer-quality-evidence" }
>;
type HostRouteAssignment = Extract<
  ServerMessage,
  { type: "route-update" }
>["assignment"];

interface CaptureDetails {
  /** null = source reported no usable width/height; mapped to a localized
   *  "unknown" (or the vis dash) at render time so language switches and vis
   *  mode never see a baked-in string from capture time. */
  resolution: string | null;
  frameRate: number | null;
  hasAudio: boolean;
}

function captureDetails(stream: MediaStream): CaptureDetails {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  return {
    resolution:
      settings?.width && settings.height
        ? `${settings.width}x${settings.height}`
        : null,
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

function hostTerminationKey(reason: SignalingTerminationReason): CopyKey {
  switch (reason) {
    case "STALE_CLIENT":
      return "host.terminated.stale";
    case "SESSION_REPLACED":
      return "host.terminated.session";
    case "SIGNAL_TERMINATED":
      return "host.terminated.signal";
  }
}

interface HostPageProps {
  onAuthorizationRequired?: () => void;
}

export function HostPage({ onAuthorizationRequired }: HostPageProps = {}) {
  const { lang, vis, t, titleFrames } = useCopy();
  const [qualitySettings, setQualitySettings] = useState<QualitySettings>(
    DEFAULT_QUALITY_SETTINGS,
  );
  const [advancedQuality, setAdvancedQuality] = useState<QualitySettings>(
    DEFAULT_QUALITY_SETTINGS,
  );
  const [routePolicy, setRoutePolicy] = useState<RoutePolicy>(
    DEFAULT_ROUTE_POLICY,
  );
  const [natPredictionEnabled, setNatPredictionEnabled] = useState(false);
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
    "access" | "replacement" | "sharing" | null
  >(null);
  const roomMutating = roomMutation !== null;
  const [viewerPasswordEnabled, setViewerPasswordEnabled] = useState(false);
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
  const [hasCustomDisplayName, setHasCustomDisplayName] = useState(
    () => readStoredDisplayName() !== null,
  );
  const [displayName, setDisplayName] = useState(() =>
    readDisplayName(defaultHostDisplayName("", vis)),
  );
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [viewerQualityEvidence, setViewerQualityEvidence] = useState<
    Map<string, ViewerQualityEvidencePresentation>
  >(() => new Map());
  const [noticeValue, setNoticeValue] = useState<NoticeValue | null>(null);
  const [noticeComic, setNoticeComic] = useState<ComicKind | null>(null);
  const [hostSfuQualityWarning, setHostSfuQualityWarning] = useState<
    string | null
  >(null);
  function setNotice(value: string | null, comic: ComicKind | null = null): void {
    setNoticeValue(value ? { kind: "text", text: value } : null);
    setNoticeComic(comic);
  }
  function setNoticeKey(key: CopyKey, vars?: Record<string, string>): void {
    setNoticeValue({ kind: "key", key, vars });
    setNoticeComic(null);
  }
  function setNoticeError(error: unknown, action: HostAction): void {
    setNoticeValue({ kind: "text", text: readableError(error, action) });
    setNoticeComic(action === "connection" ? "route-failed" : "warning");
  }
  function setNoticeErrorKey(
    key: CopyKey,
    comic: ComicKind = "warning",
    vars?: Record<string, string>,
  ): void {
    setNoticeValue({ kind: "key", key, vars });
    setNoticeComic(comic);
  }
  const [copied, setCopied] = useState(false);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [changingQuality, setChangingQuality] = useState(false);
  const [sharingPaused, setSharingPaused] = useState(false);
  const [localPreviewPaused, setLocalPreviewPaused] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [selectedPawn, setSelectedPawn] = useState<string | null>(null);
  const [joinRoomCode, setJoinRoomCode] = useState("");
  const [joinRoomError, setJoinRoomError] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [metricsExpanded, setMetricsExpanded] = useMetricsExpanded();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const displayNameRef = useRef(displayName);
  const hostClientIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasCustomDisplayName) return;
    const fallback = defaultHostDisplayName(
      hostClientIdRef.current ?? "",
      vis,
    );
    if (displayNameRef.current === fallback) return;
    displayNameRef.current = fallback;
    setDisplayName(fallback);
    if (!editingDisplayName) setDisplayNameDraft(fallback);
    signalRef.current?.setDisplayName(fallback);
  }, [hasCustomDisplayName, lang, vis]);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const peersRef = useRef(new Map<string, HostPeer>());
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
  const viewerQualityEvidenceRenderFrameRef = useRef<number | null>(null);
  const peerAssistedRef = useRef(false);
  const activeRouteRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const sourceSwitchRef = useRef<object | null>(null);
  const qualityChangeRef = useRef<object | null>(null);
  const pendingQualityChangeRef = useRef<QualitySettings | null>(null);
  const qualitySettingsRef = useRef<QualitySettings>(DEFAULT_QUALITY_SETTINGS);
  const routePolicyRef = useRef<RoutePolicy>(DEFAULT_ROUTE_POLICY);
  const natPredictionEnabledRef = useRef(false);
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
  const displayedVideoCodecMode =
    videoCodecMode === "auto" && phase === "live" && resolvedVideoCodec
      ? resolvedVideoCodec
      : videoCodecMode;

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
      cancelViewerQualityEvidenceRender();
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

  function isCurrentShare(
    generation: number,
    shareGeneration: string,
  ): boolean {
    return (
      isCurrentGeneration(generation) &&
      shareGenerationRef.current === shareGeneration
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
    setHostSfuQualityWarning(null);
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

  function syncHostSfuQualityWarning(
    route: HostSfuRoute,
    generation: number,
  ): string | null {
    if (
      !isCurrentGeneration(generation) ||
      hostSfuRouteRef.current !== route
    ) {
      return null;
    }
    const warning = route.getQualityWarning();
    setHostSfuQualityWarning(warning);
    return warning;
  }

  function disposeResources(notifyServer: boolean): void {
    sourceSwitchRef.current = null;
    qualityChangeRef.current = null;
    pendingQualityChangeRef.current = null;
    codecProbeAbortRef.current?.abort();
    codecProbeAbortRef.current = null;
    videoCodecRef.current = VP8_ONLY_VIDEO_CODEC;
    setResolvedVideoCodec(null);
    setHostSfuQualityWarning(null);
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
    cancelViewerQualityEvidenceRender();
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
    kind: "access" | "replacement" | "sharing",
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

  function endSharing(
    message: string | { key: CopyKey; vars?: Record<string, string> },
    notifyServer = true,
  ): void {
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
    if (typeof message === "string") {
      setNotice(message);
    } else {
      setNoticeKey(message.key, message.vars);
    }
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
    const profile = creationProfileRef.current;
    try {
      const response = await replaceOwnedRoom(
        activeRoom.roomId,
        activeRoom.hostToken,
        profile.codeEntryPolicy,
        profile.roomPassword,
      );
      const replacement = hostRoomFromCreated(response);
      if (wasSharing) {
        endSharing({ key: "host.roomReplaced" }, false);
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
      if (!wasSharing) {
        setNoticeKey("host.roomReplaced");
      }
      setPhase(wasSharing ? "ended" : "idle");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (!wasSharing) {
          // A lease can disappear while the host is idle (for example after a
          // server restart). Creation is the canonical recovery path; do not
          // clear the visible room before it succeeds.
          try {
            const response = await createRoom(
              profile.codeEntryPolicy,
              profile.roomPassword,
              readPreferredRoomId(),
            );
            const replacement = hostRoomFromCreated(response);
            if (
              roomMutationRef.current !== mutation ||
              !isCurrentRoomAuthority(activeRoom)
            ) {
              closeAbandonedRoom(replacement);
              return;
            }
            if (replacement.roomId !== activeRoom.roomId) {
              replaceViewerInvite(activeRoom.roomId, null);
            }
            writeHostRoom(replacement);
            writePreferredRoom(replacement.roomId);
            roomRef.current = replacement;
            setRoom(replacement);
            setCopied(false);
            setViewerPasswordEnabled(profile.roomPassword !== null);
            setViewerPasswordDraft(profile.roomPassword ?? "");
            setViewerPasswordVisible(false);
            setNoticeKey("host.roomReplaced");
            setPhase("idle");
            return;
          } catch (replacementError) {
            setNoticeError(replacementError, "room");
            return;
          }
        }
        if (forgetRoom(activeRoom)) {
          endSharing({ key: "host.roomInvalid" }, false);
        }
      }
      setNoticeError(error, "room");
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
      scheduleViewerQualityEvidenceRender();
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

  function scheduleViewerQualityEvidenceRender(): void {
    if (viewerQualityEvidenceRenderFrameRef.current !== null) return;
    viewerQualityEvidenceRenderFrameRef.current = window.requestAnimationFrame(
      () => {
        viewerQualityEvidenceRenderFrameRef.current = null;
        setViewerQualityEvidence(viewerQualityEvidenceRef.current);
      },
    );
  }

  function cancelViewerQualityEvidenceRender(): void {
    const frame = viewerQualityEvidenceRenderFrameRef.current;
    if (frame === null) return;
    window.cancelAnimationFrame(frame);
    viewerQualityEvidenceRenderFrameRef.current = null;
  }

  function retainViewerQualityEvidenceForPresence(
    entries: readonly ParticipantPresenceEntry[],
  ): void {
    const presentPeerIds = new Set(
      entries
        .filter((entry) => entry.role === "viewer")
        .map((entry) => entry.peerId),
    );
    const current = viewerQualityEvidenceRef.current;
    const retained = retainPresentViewerQualityEvidence(
      current,
      presentPeerIds,
    );
    if (retained === current) return;
    for (const peerId of current.keys()) {
      if (retained.has(peerId)) continue;
      const timer = viewerQualityEvidenceTimersRef.current.get(peerId);
      if (timer !== undefined) window.clearTimeout(timer);
      viewerQualityEvidenceTimersRef.current.delete(peerId);
    }
    viewerQualityEvidenceRef.current = retained;
    scheduleViewerQualityEvidenceRender();
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
          endSharing({ key: "host.stopNotice" });
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

  function changeNatPrediction(enabled: boolean): void {
    if (phase === "starting" || phase === "live") {
      return;
    }
    natPredictionEnabledRef.current = enabled;
    setNatPredictionEnabled(enabled);
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
              peer.updateCaptureProfile(nextProfile),
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
          activeSfuRoute && hostSfuRouteRef.current === activeSfuRoute
            ? syncHostSfuQualityWarning(activeSfuRoute, generation)
            : null;
        const connectionWarning =
          failed > 0 || !sfuUpdated
            ? say("host.notice.partialApply")
            : null;
        const successNotice =
          audioChanged && !videoChanged
            ? say("host.notice.audioSet", { label: say(AUDIO_QUALITY_CAPTIONS[resolveScreenAudioQuality(nextProfile.screenAudioQuality)]) })
            : videoChanged && audioChanged
              ? say("host.notice.qualityApplied")
              : say("host.notice.qualitySet", {
                  label: qualitySettingsLabel(nextProfile),
                });
        setNotice(connectionWarning ?? (sfuWarning ? null : successNotice));
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
        setNoticeError(error, "quality");
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
        setNoticeKey("host.pause.noTracksResume");
        return;
      }
      for (const peer of peersRef.current.values()) peer.setPaused(false);
      hostProvisionalChildRef.current?.setPaused(false);
      hostSfuRouteRef.current?.setPaused(false);
      if (signalRef.current?.setSharingPaused(false) !== true) {
        setMediaPaused(activeStream, true);
        for (const peer of peersRef.current.values()) peer.setPaused(true);
        hostProvisionalChildRef.current?.setPaused(true);
        hostSfuRouteRef.current?.setPaused(true);
        signalRef.current?.confirmSharingPaused();
        setNoticeKey("host.pause.signalRecovering");
        return;
      }
      sharingPausedRef.current = false;
      setSharingPaused(false);
      setNoticeKey("host.resumeNotice");
      return;
    }
    if (!setMediaPaused(activeStream, true)) {
      setNoticeKey("host.pause.noTracksPause");
      return;
    }
    for (const peer of peersRef.current.values()) peer.setPaused(true);
    hostProvisionalChildRef.current?.setPaused(true);
    sharingPausedRef.current = true;
    setSharingPaused(true);
    hostSfuRouteRef.current?.setPaused(true);
    discardPreparedHostChild();
    if (signalRef.current?.setSharingPaused(true) === true) {
      setNoticeKey("host.pauseNotice");
    } else {
      setNoticeKey("host.pause.signalRecovering");
    }
  }

  function removePeer(peerId: string): void {
    clearViewerQualityEvidence(peerId);
    const peer = peersRef.current.get(peerId);
    if (peer) {
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
      natPredictionEnabled: natPredictionEnabledRef.current,
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
      undefined,
      natPredictionEnabledRef.current,
    );
    peersRef.current.set(peerId, peer);
    let started: boolean;
    try {
      started = await peer.start();
    } catch (error) {
      if (peersRef.current.get(peerId) === peer) {
        const connectionId = peer.connectionId;
        reportHostChildFailure(peerId, connectionId, generation);
        removePeer(peerId);
      }
      throw error;
    }
    if (started || peersRef.current.get(peerId) !== peer) {
      return;
    }

    const connectionId = peer.connectionId;
    if (peerAssistedRef.current || attempt >= 1) {
      reportHostChildFailure(peerId, connectionId, generation);
      removePeer(peerId);
      return;
    }
    removePeer(peerId);
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
              setNoticeError(error, "connection");
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
            setNoticeError(error, "connection");
          }
        });
      },
    );
  }

  function reportHostChildFailure(
    peerId: string,
    connectionId: string,
    generation: number,
  ): boolean {
    return Boolean(
      isCurrentGeneration(generation) &&
        peerAssistedRef.current &&
        hostChildIsAssigned(peerId) &&
        signalRef.current?.send({
          type: "route-failed",
          revision: activeRouteRevisionRef.current,
          phase: "active",
          connectionId,
        }),
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
            syncHostSfuQualityWarning(route, generation);
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
      retainViewerQualityEvidenceForPresence(message.viewers);
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
      for (const peer of peersRef.current.values()) peer.setPaused(true);
      hostProvisionalChildRef.current?.setPaused(true);
      hostSfuRouteRef.current?.setPaused(true);
      sharingPausedRef.current = true;
      setSharingPaused(true);
      signalRef.current?.confirmSharingPaused();
      setNoticeKey("host.pause.stillPaused");
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
        syncHostSfuQualityWarning(route, generation);
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
          .then(() => syncHostSfuQualityWarning(route, generation));
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
          setNoticeError(error, "connection");
        }
      });
      return;
    }
    if (message.type === "room-closed") {
      if (!forgetRoom(activeRoom)) {
        return;
      }
      endSharing(
        message.reason === "expired" ? say("host.roomExpired") : say("host.roomClosed"),
        false,
      );
      return;
    }
    if (message.type === "error") {
      if (["INVALID_TOKEN", "ROOM_EXPIRED"].includes(message.code)) {
        if (!forgetRoom(activeRoom)) {
          return;
        }
        endSharing({ key: "host.roomInvalid" }, false);
        return;
      }
      if (message.code === "AUTH_REQUIRED") {
        return;
      }
      if (message.code === "HOST_ALREADY_CONNECTED") {
        endSharing(hostServerErrorNotice(message.code), false);
        return;
      }
      setNotice(hostServerErrorNotice(message.code), "warning");
    }
  }

  async function startSharing(): Promise<void> {
    if (
      phase === "starting" ||
      phase === "live" ||
      activeGenerationRef.current !== null ||
      roomMutationRef.current !== null
    ) {
      return;
    }
    const mutation = beginRoomMutation("sharing");
    if (!mutation) {
      return;
    }
    try {
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
      if (!isCurrentShare(generation, shareGeneration)) {
        return;
      }
      activeGenerationRef.current = null;
      shareGenerationRef.current = null;
      setNoticeError(error, "capture");
      setPhase("error");
      return;
    }

    if (!isCurrentShare(generation, shareGeneration)) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = captured;
    setStream(captured);
    setDetails(captureDetails(captured));
    watchCaptureEnd(captured, generation);

    videoCodecRef.current = await resolveStreamVideoCodec(captured);
    setResolvedVideoCodec(videoCodecRef.current.primary);
    if (!isCurrentShare(generation, shareGeneration)) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    let createdRoom: HostRoomState | null = null;
    let claimedRoom = false;
    try {
      const reusableRoom = roomRef.current;
      createdRoom = reusableRoom ?? hostRoomFromStored(readHostRoom());
      if (!createdRoom) {
        const response = await createRoom(
          creationProfileRef.current.codeEntryPolicy,
          creationProfileRef.current.roomPassword,
          readPreferredRoomId(),
        );
        createdRoom = hostRoomFromCreated(response);
        if (!isCurrentShare(generation, shareGeneration)) {
          captured.getTracks().forEach((track) => track.stop());
          closeAbandonedRoom(createdRoom);
          return;
        }
        writeHostRoom(createdRoom);
        roomRef.current = createdRoom;
        setRoom(createdRoom);
        claimedRoom = true;
      } else {
        roomRef.current = createdRoom;
        setRoom(createdRoom);
        claimedRoom = true;
      }
      let replacementAttempted = false;
      const connectSignal = (activeRoom: HostRoomState): SignalingClient => {
        let authenticated = false;
        const hostClientId = getStableClientId("host", activeRoom.roomId);
        hostClientIdRef.current = hostClientId;
        const hostFallback = defaultHostDisplayName(hostClientId, vis);
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
                isCurrentShare(generation, shareGeneration) &&
                signalRef.current === signal
              ) {
                setSignalStatus(status);
              }
            },
            onTerminated: (reason) => {
              if (
                isCurrentShare(generation, shareGeneration) &&
                signalRef.current === signal
              ) {
                endSharing({ key: hostTerminationKey(reason) }, false);
              }
            },
            onAccessRequired: () => {
              if (
                isCurrentShare(generation, shareGeneration) &&
                signalRef.current === signal
              ) {
                endSharing({ key: "gate.expired" }, false);
                onAuthorizationRequired?.();
              }
            },
            onMessage: (message) => {
              if (
                !isCurrentShare(generation, shareGeneration) ||
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
          if (!isCurrentShare(generation, shareGeneration)) {
            captured.getTracks().forEach((track) => track.stop());
            closeAbandonedRoom(replacement);
            return;
          }
          writeHostRoom(replacement);
          roomRef.current = replacement;
          setRoom(replacement);
          const replacementSignal = connectSignal(replacement);
          signalRef.current = replacementSignal;
          replacementSignal.start();
        } catch (error) {
          if (!isCurrentShare(generation, shareGeneration)) {
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
          setNoticeError(error, "room");
          setPhase("error");
        }
      };
      const signal = connectSignal(createdRoom);
      signalRef.current = signal;
      signal.start();
    } catch (error) {
      if (!isCurrentShare(generation, shareGeneration)) {
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
      setNoticeError(error, "room");
      setPhase("error");
    }
    } finally {
      finishRoomMutation(mutation);
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
        setNoticeError(error, "source");
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
      setNoticeKey("host.shareEnded");
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
          ? syncHostSfuQualityWarning(activeSfuRoute, generation)
          : null;
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
              setNoticeError(error, "connection");
            }
          }
        }),
      );

      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        const sourceNotice =
          sfuReplaced && sfuWarning && failedPeerIds.length === 0
            ? null
            : sourceSwitchNotice({
                failedPeerCount: failedPeerIds.length,
                sfuReplaced,
                sfuWarning: null,
              });
        setNotice(
          sourceNotice,
          sourceNotice &&
            (sfuWarning || !sfuReplaced || failedPeerIds.length > 0)
            ? "warning"
            : null,
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
      setNoticeKey("host.invite.copyFailed");
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
    if (error instanceof ApiError) {
      setNotice(error.message, "warning");
    } else {
      setNoticeErrorKey("host.accessFailed", "warning");
    }
  }

  async function changeCodeEntryPolicy(policy: CodeEntryPolicy): Promise<void> {
    const activeRoom = roomRef.current;
    if (!activeRoom) {
      return;
    }
    if (activeRoom.codeEntryPolicy === policy) {
      setNotice(null);
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
      setNoticeKey(
        response.codeEntryPolicy === "open"
          ? "host.policy.setOpen"
          : response.viewerPasswordEnabled
            ? "host.policy.setPrivatePassword"
            : "host.policy.setPrivateInvite",
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
      setNoticeKey(
        response.inviteUrl ? "host.invite.updated" : "host.invite.revoked",
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
      setNoticeKey("host.password.rule", {
        max: String(MAX_VIEWER_PASSWORD_LENGTH),
      });
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
      setNoticeKey(
        password === null
          ? "host.password.removed"
          : hadPassword
            ? "host.password.updated"
            : "host.password.saved",
      );
    } catch (error) {
      handleRoomAccessFailure(error, activeRoom);
    } finally {
      finishRoomMutation(mutation);
    }
  }

  function commitDisplayName(): void {
    const hostFallback = hostClientIdRef.current
      ? defaultHostDisplayName(hostClientIdRef.current, vis)
      : defaultHostDisplayName("", vis);
    const saved = saveDisplayName(displayNameDraft, hostFallback);
    if (!saved) {
      setDisplayNameError(say("host.nameError"));
      return;
    }
    displayNameRef.current = saved;
    setDisplayName(saved);
    setDisplayNameDraft(saved);
    setDisplayNameError(null);
    setEditingDisplayName(false);
    setHasCustomDisplayName(readStoredDisplayName() !== null);
    if (!signalRef.current?.setDisplayName(saved)) {
      setNoticeKey("host.nameOffline");
    }
  }

  function joinRoomFromStage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const route = roomRouteForExplicitEntry(joinRoomCode);
    if (!route) {
      setJoinRoomError(true);
      return;
    }
    window.location.assign(route);
  }

  const activeCodeEntryPolicy = room?.codeEntryPolicy ?? null;
  const hostPeerId = hostPresence?.peerId ?? hostPeerIdRef.current;

  const couchEntries: CouchEntry[] = viewers.map((viewer) => {
    const snapshot =
      viewer.upstream.kind === "peer" && viewer.upstream.peerId === hostPeerId
        ? peerSnapshots.get(viewer.peerId)
        : undefined;
    const qualityPresentation = viewerQualityEvidence.get(viewer.peerId);
    const qualityEvidence = qualityPresentation?.evidence;
    const hasCurrentQualityEvidence =
      qualityEvidence !== undefined &&
      qualityEvidenceUpstreamMatches(qualityEvidence, viewer.upstream) &&
      qualityPresentation?.fresh === true;
    const hasCommittedMedia = viewer.mediaReady === true;
    const connected =
      snapshot?.connectionState === "connected" ||
      hasCurrentQualityEvidence ||
      hasCommittedMedia;
    const viewerState = connected
      ? "connected"
      : (snapshot?.connectionState ??
        (viewer.upstream.kind === "none" ? "routing" : "connecting"));
    return {
      key: viewer.peerId,
      name: viewer.label,
      connected,
      statusLabel: t(
        PEER_STATE_CAPTIONS[viewerState] ?? "state.peer.connecting",
      ),
    };
  });

  type ViewerDetail = {
    route: "p2p" | "sfu" | null;
    metrics: ConnectionMetrics | null;
    direction: "send" | "receive";
    tag?: { icon: "loader"; label: string };
    error: string | null;
  };
  const detailForViewer = (viewer: (typeof viewers)[number]): ViewerDetail => {
    const snapshot =
      viewer.upstream.kind === "peer" && viewer.upstream.peerId === hostPeerId
        ? peerSnapshots.get(viewer.peerId)
        : undefined;
    const qualityPresentation = viewerQualityEvidence.get(viewer.peerId);
    const qualityEvidence = qualityPresentation?.evidence;
    const hasMatchingQualityEvidence =
      qualityEvidence !== undefined &&
      qualityEvidenceUpstreamMatches(qualityEvidence, viewer.upstream);
    const hasCurrentQualityEvidence =
      hasMatchingQualityEvidence && qualityPresentation?.fresh === true;
    const hasCommittedMedia = viewer.mediaReady === true;
    const hasCurrentRouteEvidence =
      hasPeerRouteEvidence(snapshot) ||
      hasCurrentQualityEvidence ||
      hasCommittedMedia;
    const connected =
      snapshot?.connectionState === "connected" ||
      hasCurrentQualityEvidence ||
      hasCommittedMedia;
    const viewerState = connected
      ? "connected"
      : (snapshot?.connectionState ?? "routing");
    const detailMetrics = hasCurrentQualityEvidence
      ? metricsFromQualityEvidence(qualityEvidence)
      : snapshot && hasPeerRouteEvidence(snapshot)
        ? snapshot.metrics
        : null;
    return {
      route:
        hasCurrentRouteEvidence && viewer.upstream.kind !== "none"
          ? viewer.upstream.kind === "peer"
            ? "p2p"
            : "sfu"
          : null,
      metrics: detailMetrics,
      direction: hasCurrentQualityEvidence ? "receive" : "send",
      tag: connected
        ? undefined
        : {
            icon: "loader",
            label: t(
              PEER_STATE_CAPTIONS[viewerState] ?? "state.peer.connecting",
            ),
          },
      error: snapshot?.error ?? null,
    };
  };
  const viewerDetails = new Map(
    viewers.map((viewer) => [viewer.peerId, detailForViewer(viewer)] as const),
  );
  const selectedViewer = selectedPawn
    ? (viewers.find((viewer) => viewer.peerId === selectedPawn) ?? null)
    : null;
  const selectedDetail = selectedViewer
    ? (viewerDetails.get(selectedViewer.peerId) ?? null)
    : null;
  const viewerOverviewEntries: ViewerOverviewEntry[] = couchEntries.map(
    (entry) => {
      const detail = viewerDetails.get(entry.key);
      return {
        ...entry,
        statusLabel: entry.statusLabel ?? t("state.peer.connecting"),
        route: detail?.route ?? null,
        metrics: detail?.metrics ?? null,
      };
    },
  );
  const hostDiagnosticsAvailable = Boolean(
    (details && stream) || viewerOverviewEntries.length > 0,
  );

  const noticeText = noticeValue
    ? noticeValue.kind === "text"
      ? noticeValue.text
      : t(noticeValue.key, noticeValue.vars)
    : null;

  const phaseLine =
    phase === "live"
      ? t("host.onlineCount", {
          n: String(viewers.length),
          max: String(maxViewers ?? "-"),
        })
      : phase === "starting"
        ? `${t("host.starting")}…`
        : phase === "ended" && room
          ? t("host.ended")
          : room
            ? t("host.roomReady")
            : t("host.notStarted");
  const titleFrameKey =
    phase === "live"
      ? sharingPaused
        ? "paused"
        : "hostActive"
      : phase === "starting"
        ? "hostStarting"
        : phase === "ended"
          ? "hostEnded"
          : room
            ? "hostReady"
            : "hostIdle";
  const titleContent = titleFrames(titleFrameKey);
  useDocumentTitle([room?.roomId, titleContent[0]], titleContent.slice(1));

  // Vis mode swaps native title tooltips for 2-panel hint comics; text modes
  // render the trigger unchanged, so markup structure stays identical.
  // wrapStyle adds a layout span around the tooltip wrapper (vis mode only)
  // for triggers whose flex context would otherwise stretch the wrapper away
  // from the trigger it must hug, or collapse a control's text-mode geometry.
  const hintWrap = (
    kind: HintKind,
    node: ReactNode,
    align: "start" | "center" | "end" = "center",
    wrapStyle?: CSSProperties,
  ): ReactNode =>
    vis ? (
      wrapStyle ? (
        <span style={wrapStyle}>
          <ComicTooltip kind={kind} align={align}>
            {node}
          </ComicTooltip>
        </span>
      ) : (
        <ComicTooltip kind={kind} align={align}>
          {node}
        </ComicTooltip>
      )
    ) : (
      node
    );

  return (
    <div className="lr-app">
      <AppHeader
        led={
          <LedStrip
            state={SIGNAL_LED_STATE[signalStatus]}
            label={t(SIGNAL_LED_LABEL[signalStatus])}
            comic={
              signalStatus === "reconnecting" || signalStatus === "offline"
                ? "recovering"
                : undefined
            }
          />
        }
      />

      <main className="lr-room">
        <h1 className="visually-hidden">
          {t("host.title", { name: hostPresence?.displayName ?? displayName })}
        </h1>
        <div className="lr-scene">
          <StageTv
            chin={
              phase === "live"
                ? sharingPaused
                  ? "warn"
                  : "on"
                : phase === "starting"
                  ? "busy"
                  : "off"
            }
            live={phase === "live"}
            hasEntry={
              phase === "idle" || phase === "ended" || phase === "error"
            }
            label={t("host.stageAria")}
          >
            {stream ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : null}
            {!stream &&
            (phase === "idle" || phase === "ended" || phase === "error") ? (
              <div className="lr-tv-overlay">
                {vis ? null : (
                  <div className="lr-entry-text">
                    <h1>{t("host.idle.heading")}</h1>
                    <p>{t("host.idle.hint")}</p>
                  </div>
                )}
                {phase === "ended" && room && !vis ? (
                  <span className="lr-tv-msg">{t("host.ended")}</span>
                ) : null}
                <div className="lr-entry-actions">
                  <span className="lr-entry-action">
                    {hintWrap(
                      "hint-share-start",
                      <button
                        type="button"
                        className="lr-tv-big is-action is-ripple"
                        title={vis ? undefined : t("host.start")}
                        aria-label={t("host.start")}
                        disabled={roomMutating}
                        onClick={() => {
                          setJoiningRoom(false);
                          void startSharing();
                        }}
                      >
                        <VisGlyph name="cast" size={34} draw="entry-cast" />
                      </button>,
                      "start",
                    )}
                    {vis ? null : (
                      <span className="lr-tv-msg">{t("host.start")}</span>
                    )}
                  </span>
                  <span className="lr-entry-action">
                    {hintWrap(
                      "hint-join-go",
                      <button
                        type="button"
                        className="lr-tv-big"
                        title={vis ? undefined : t("host.join")}
                        aria-label={t("host.join")}
                        aria-expanded={joiningRoom}
                        aria-controls="host-room-code-entry"
                        onClick={() => setJoiningRoom((current) => !current)}
                      >
                        <VisGlyph name="door" size={30} draw="entry-door" />
                      </button>,
                      "end",
                    )}
                    {vis ? null : (
                      <span className="lr-tv-msg">{t("host.join")}</span>
                    )}
                  </span>
                </div>
                {joiningRoom ? (
                  <form
                    id="host-room-code-entry"
                    className="lr-join-panel"
                    style={{ gap: 12 }}
                    onSubmit={joinRoomFromStage}
                  >
                    <div
                      className={`lr-dials-wrap${
                        joinRoomError ? " lr-join-door is-shake" : ""
                      }`}
                    >
                      <div className="lr-dials" aria-hidden="true">
                        {[0, 1, 2, 3].map((index) => (
                          <span
                            key={index}
                            className={`lr-dial${
                              joinRoomCode[index] ? " is-filled" : ""
                            }${index === joinRoomCode.length ? " is-active" : ""}`}
                          >
                            {joinRoomCode[index] ?? ""}
                          </span>
                        ))}
                      </div>
                      <input
                        value={joinRoomCode}
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        autoFocus
                        aria-label={t("join.field")}
                        aria-invalid={joinRoomError ? "true" : undefined}
                        onChange={(event) => {
                          setJoinRoomCode(
                            event.target.value.replace(/\D/g, "").slice(0, 4),
                          );
                          setJoinRoomError(false);
                        }}
                      />
                    </div>
                    {joinRoomError ? (
                      <>
                        <span
                          className="lr-join-error"
                          role="alert"
                          aria-label={t("join.invalid")}
                        >
                          <Glyph name="x" size={22} />
                        </span>
                        {vis ? null : (
                          <span className="lr-cap" style={{ color: "var(--danger)" }}>
                            {t("join.invalid")}
                          </span>
                        )}
                      </>
                    ) : null}
                    {hintWrap(
                      "hint-join-go",
                      <button
                        className="lr-join-go"
                        type="submit"
                        title={vis ? undefined : t("join.submit")}
                        aria-label={t("join.submit")}
                        disabled={joinRoomCode.length !== 4}
                      >
                        <Glyph name="arrowRight" size={24} />
                      </button>,
                    )}
                  </form>
                ) : null}
              </div>
            ) : null}
            {switchingSource ? (
              <StageOverlay
                icon="refresh"
                spin
                dim
                message={t("host.switchingSource")}
              />
            ) : sharingPaused ? (
              <StageOverlay icon="pause" dim comic="host-paused" message={t("host.pauseNotice")} />
            ) : phase === "starting" ? (
              <>
                <StaticNoise />
                <div
                  className="lr-tv-overlay"
                  role="status"
                  aria-label={t("host.starting")}
                >
                  <StoryBoard step={1} showBrand={stream !== null} />
                </div>
              </>
            ) : stream && localPreviewPaused ? (
              <StageOverlay
                icon="eyeOff"
                dim
                message={t("host.localPreviewPaused")}
              />
            ) : null}
          </StageTv>
          <div className="lr-shelf" aria-hidden="true" />
          <Couch
            host={{
              key: hostPeerId ?? hostClientIdRef.current ?? "host-local",
              name: hostPresence?.displayName ?? displayName,
              you: true,
              selected:
                hostDiagnosticsAvailable &&
                showConnectionDetails &&
                selectedPawn === null,
              controls: hostDiagnosticsAvailable
                ? "host-details-panel host-viewer-overview"
                : undefined,
              onSelect: hostDiagnosticsAvailable
                ? () => {
                    if (selectedPawn !== null) {
                      setSelectedPawn(null);
                      setShowConnectionDetails(true);
                      return;
                    }
                    setShowConnectionDetails((current) => !current);
                  }
                : undefined,
            }}
            entries={couchEntries}
            selectedKey={selectedPawn}
            onSelect={(key) =>
              setSelectedPawn((current) => (current === key ? null : key))
            }
            emptyHint={t(
              phase === "live" ? "host.viewers.waiting" : "host.viewers.empty",
            )}
          />
        </div>

        <div className="lr-deck">
          <Row>
            {room ? (
              <RowGroup>
                <FieldCap k="common.roomCode" />
                <RoomChip
                  roomId={room.roomId}
                  onReplace={replaceCurrentRoom}
                  replaceDisabled={phase === "starting" || roomMutating}
                />
                {activeCodeEntryPolicy ? (
                  <RoomAdmissionBadge
                    policy={activeCodeEntryPolicy}
                    passwordEnabled={viewerPasswordEnabled}
                  />
                ) : null}
              </RowGroup>
            ) : null}
            <RowGroup>
              <StatusText>{phaseLine}</StatusText>
              {!details?.hasAudio && stream ? (
                <Pill icon="speaker" label={t("host.noAudio")} comic="no-audio" />
              ) : null}
              {qualityLimitation ? (
                <Pill
                  icon="alert"
                  label={qualityLimitation.message}
                  comic={
                    qualityLimitation.kind === "bandwidth"
                      ? "bandwidth-limited"
                      : qualityLimitation.kind === "cpu"
                        ? "encoder-limited"
                        : "warning"
                  }
                />
              ) : null}
              {hostSfuQualityWarning &&
              hostSfuQualityWarning !== noticeText ? (
                <Pill
                  icon="alert"
                  label={hostSfuQualityWarning}
                  comic="route-failed"
                />
              ) : null}
              {noticeText && (vis || noticeText !== phaseLine) ? (
                <Pill
                  icon={noticeComic ? "alert" : "check"}
                  tone={noticeComic ? undefined : "good"}
                  label={noticeText}
                  comic={noticeComic ?? undefined}
                />
              ) : null}
            </RowGroup>
            <span className="lr-spacer" />
            <div className="lr-host-personal-controls">
              <div className="lr-row-group lr-group-name lr-host-identity-slot">
                {editingDisplayName ? (
                  <form
                    style={{ display: "contents" }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitDisplayName();
                    }}
                  >
                    <span className="lr-input lr-name-editor">
                      <input
                        id="host-display-name"
                        type="text"
                        value={displayNameDraft}
                        maxLength={96}
                        autoComplete="nickname"
                        autoFocus
                        aria-label={t("host.name")}
                        aria-invalid={displayNameError ? "true" : undefined}
                        onChange={(event) => {
                          setDisplayNameDraft(event.target.value);
                          setDisplayNameError(null);
                        }}
                      />
                    </span>
                    <Btn
                      icon="check"
                      title="host.nameSave"
                      hint="hint-rename"
                      type="submit"
                      disabled={displayNameDraft === displayName}
                    />
                    {hintWrap(
                      "hint-close",
                      <Btn
                        icon="x"
                        title="host.nameCancel"
                        onClick={() => {
                          setDisplayNameDraft(displayName);
                          setDisplayNameError(null);
                          setEditingDisplayName(false);
                        }}
                      />,
                      "end",
                    )}
                  </form>
                ) : (
                  <>
                    <NameTag
                      name={hostPresence?.displayName ?? displayName}
                      identity={
                        hostPeerId ?? hostClientIdRef.current ?? "host-pending"
                      }
                    />
                    {hintWrap(
                      "hint-rename",
                      <Btn
                        icon="pencil"
                        cap="common.edit"
                        title="host.nameEdit"
                        onClick={() => {
                          setDisplayNameDraft(displayName);
                          setDisplayNameError(null);
                          setEditingDisplayName(true);
                        }}
                      />,
                      "end",
                    )}
                  </>
                )}
                {displayNameError ? (
                  <Pill
                    icon="alert"
                    tone="bad"
                    label={displayNameError}
                    alert
                    comic="warning"
                  />
                ) : null}
              </div>
              <div className="lr-row-group lr-group-actions lr-host-diagnostics-slot">
                {hintWrap(
                  "hint-details",
                  <Btn
                    icon="gauge"
                    cap={
                      showConnectionDetails
                        ? "host.details.hide"
                        : "host.details"
                    }
                    title={
                      showConnectionDetails
                        ? "host.details.hide"
                        : "host.details"
                    }
                    tone={showConnectionDetails ? "on" : undefined}
                    expanded={showConnectionDetails}
                    controls="host-details-panel host-viewer-overview"
                    disabled={!hostDiagnosticsAvailable}
                    onClick={() =>
                      setShowConnectionDetails((current) => !current)
                    }
                  />,
                  "start",
                )}
                {hintWrap(
                  "hint-topology",
                  <Btn
                    icon="network"
                    cap="host.topology"
                    title={
                      showTopology
                        ? "host.topology.hide"
                        : "host.topology.show"
                    }
                    tone={showTopology ? "on" : undefined}
                    expanded={showTopology}
                    controls="room-topology"
                    onClick={() => setShowTopology((current) => !current)}
                  />,
                  "end",
                )}
              </div>
              {phase === "live" || phase === "starting" ? (
                <div className="lr-row-group lr-group-actions lr-host-share-slot">
                  {phase === "live" ? (
                    <>
                      <Btn
                        icon={sharingPaused ? "play" : "pause"}
                        cap={sharingPaused ? "host.resume" : "host.pause"}
                        title={sharingPaused ? "host.resume" : "host.pause"}
                        hint={sharingPaused ? "hint-resume" : "hint-pause"}
                        draw="host-share-toggle"
                        disabled={switchingSource || changingQuality}
                        onClick={toggleSharingPause}
                      />
                      {hintWrap(
                        "hint-switch-source",
                        <Btn
                          icon="switchSource"
                          cap={switchingSource ? "host.switching" : "host.switchSource"}
                          title="host.switchSource"
                          disabled={switchingSource || changingQuality}
                          onClick={() => void switchSource()}
                        />,
                        "end",
                      )}
                      {hintWrap(
                        "hint-share-stop",
                        <Btn
                          icon="stop"
                          tone="danger"
                          cap="host.stop"
                          title="host.stop"
                          onClick={() => endSharing({ key: "host.stopNotice" })}
                        />,
                        "end",
                      )}
                    </>
                  ) : (
                    hintWrap(
                      "hint-share-stop",
                      <Btn
                        icon="x"
                        tone="danger"
                        cap="host.cancelStart"
                        title="host.cancelStart"
                        onClick={() => endSharing({ key: "host.startCancelled" })}
                      />,
                      "end",
                    )
                  )}
                </div>
              ) : null}
            </div>
          </Row>

          {showConnectionDetails && details && stream ? (
            <Row sub>
              <div id="host-details-panel" style={{ display: "contents" }}>
                <span
                  className="lr-meter-tag"
                  title={vis ? undefined : t("host.captureAria")}
                >
                  <Glyph name="arrowUp" size={17} />
                  {vis ? null : (
                    <span className="lr-cap">{t("stats.capture")}</span>
                  )}
                </span>
                <div
                  className="lr-meter"
                  role="group"
                  aria-label={t("host.captureAria")}
                >
                  <span
                    className="lr-meter-cell"
                    title={vis ? undefined : t("stats.resolution")}
                  >
                    <Glyph name="expand" size={16} />
                    <b>
                      {details.resolution ?? (vis ? "—" : t("stats.unknown"))}
                    </b>
                    {vis ? (
                      <span className="visually-hidden">
                        {t("stats.resolution")}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="lr-meter-cell"
                    title={vis ? undefined : t("stats.fps")}
                  >
                    <Glyph name="wave" size={16} />
                    <b>
                      {details.frameRate
                        ? `${details.frameRate.toFixed(0)} fps`
                        : vis
                          ? "—"
                          : t("host.capture.fpsUnknown")}
                    </b>
                    {vis ? (
                      <span className="visually-hidden">{t("stats.fps")}</span>
                    ) : null}
                  </span>
                  <span
                    className="lr-meter-cell"
                    title={vis ? undefined : t("stats.codec")}
                  >
                    <Glyph name="cpu" size={16} />
                    <b>
                      {resolvedVideoCodec?.toUpperCase() ??
                        (vis ? "—" : t("host.capture.codecPending"))}
                    </b>
                    {vis ? (
                      <span className="visually-hidden">{t("stats.codec")}</span>
                    ) : null}
                  </span>
                  <span
                    className="lr-meter-cell"
                    title={vis ? undefined : t("stats.audio")}
                  >
                    {vis ? (
                      <span
                        style={{ position: "relative", display: "inline-flex" }}
                      >
                        <Glyph name="speaker" size={16} />
                        {details.hasAudio ? null : (
                          <span
                            aria-hidden="true"
                            style={{
                              position: "absolute",
                              top: -3,
                              bottom: -3,
                              left: "50%",
                              width: 2.5,
                              borderRadius: 2,
                              background: "currentColor",
                              transform: "translateX(-50%) rotate(45deg)",
                            }}
                          />
                        )}
                        <span className="visually-hidden">
                          {details.hasAudio
                            ? t("host.capture.hasAudio")
                            : t("host.capture.noAudio")}
                        </span>
                      </span>
                    ) : (
                      <>
                        <Glyph name="speaker" size={16} />
                        <b>
                          {details.hasAudio
                            ? t("host.capture.hasAudio")
                            : t("host.capture.noAudio")}
                        </b>
                      </>
                    )}
                  </span>
                </div>
              </div>
            </Row>
          ) : null}
          {showConnectionDetails && viewerOverviewEntries.length > 0 ? (
            <ViewerOverview
              entries={viewerOverviewEntries}
              selectedKey={selectedPawn}
              onSelect={(peerId) =>
                setSelectedPawn((current) =>
                  current === peerId ? null : peerId,
                )
              }
            />
          ) : null}
          {selectedViewer && selectedDetail ? (
            <PawnDetail
              pawnKey={selectedViewer.peerId}
              name={selectedViewer.label}
              route={selectedDetail.route}
              metrics={selectedDetail.metrics}
              direction={selectedDetail.direction}
              tag={selectedDetail.tag}
              error={selectedDetail.error}
              expanded={metricsExpanded}
              onToggleMetrics={setMetricsExpanded}
              onClose={() => setSelectedPawn(null)}
            />
          ) : null}
          {showTopology ? (
            <Row sub>
              <RouteTree
                hostPeerId={hostPeerId}
                hostLabel={labeledHostPresence?.label ?? displayName}
                viewers={viewers}
                selectedPeerId={selectedPawn}
                onSelectPeer={(peerId) =>
                  setSelectedPawn((current) =>
                    current === peerId ? null : peerId,
                  )
                }
              />
            </Row>
          ) : null}

          {room ? (
            <Row label={t("host.invite")}>
              <RowGroup actions>
                {hintWrap(
                  "hint-copy-invite",
                  <Btn
                    icon={copied ? "check" : "link"}
                    tone={room.inviteUrl ? "primary" : undefined}
                    cap="common.copy"
                    title={copied ? "common.copied" : "host.invite.copy"}
                    disabled={!room.inviteUrl || roomMutating}
                    onClick={() => void copyInvite()}
                  />,
                  "start",
                )}
                <Btn
                  icon="refresh"
                  cap="host.invite.rotateShort"
                  title="host.invite.rotate"
                  hint="hint-rotate-invite"
                  disabled={roomMutating}
                  onClick={() => void changeViewerGrant("rotate")}
                />
                <Btn
                  icon="linkOff"
                  tone="danger"
                  cap="host.invite.revokeShort"
                  title="host.invite.revoke"
                  hint="hint-revoke-invite"
                  disabled={!room.inviteUrl || roomMutating}
                  onClick={() => void changeViewerGrant("revoke")}
                />
              </RowGroup>
              {room.inviteUrl ? (
                <input
                  className="lr-invite-url"
                  type="text"
                  dir="ltr"
                  value={room.inviteUrl}
                  readOnly
                  spellCheck={false}
                  aria-label={t("host.invite")}
                  title={room.inviteUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
              ) : null}
              <span className="lr-divider" aria-hidden="true" />
              <RowGroup>
                <span
                  className="lr-toggle"
                  role="group"
                  aria-label={t("host.policy")}
                  data-selected={activeCodeEntryPolicy}
                >
                  {hintWrap(
                    "hint-policy-open",
                    <button
                      type="button"
                      className={
                        activeCodeEntryPolicy === "open" ? "is-selected" : undefined
                      }
                      title={
                        vis
                          ? undefined
                          : `${t("host.policy.open")} · ${t("host.policy.openHint")}`
                      }
                      aria-label={t("host.policy.open")}
                      aria-pressed={activeCodeEntryPolicy === "open"}
                      disabled={roomMutating}
                      onClick={() => void changeCodeEntryPolicy("open")}
                    >
                      <VisGlyph name="globe" size={19} />
                      <Cap k="host.policy.open" />
                    </button>,
                    "center",
                    // Vis mode interposes the tooltip wrapper between the
                    // toggle and its buttons, breaking the text-mode
                    // `.lr-toggle button { flex: 1 }` halves (and the sliding
                    // thumb's 50% geometry). Give each wrapper its half back.
                    { flex: 1, display: "grid" },
                  )}
                  {hintWrap(
                    "hint-policy-private",
                    <button
                      type="button"
                      className={
                        activeCodeEntryPolicy === "private"
                          ? "is-selected"
                          : undefined
                      }
                      title={
                        vis
                          ? undefined
                          : `${t("host.policy.private")} · ${t("host.policy.privateHint")}`
                      }
                      aria-label={t("host.policy.private")}
                      aria-pressed={activeCodeEntryPolicy === "private"}
                      disabled={roomMutating}
                      onClick={() => void changeCodeEntryPolicy("private")}
                    >
                      <VisGlyph name="lock" size={19} />
                      <Cap k="host.policy.private" />
                    </button>,
                    "center",
                    { flex: 1, display: "grid" },
                  )}
                </span>
                {activeCodeEntryPolicy === "private" ? (
                  hintWrap(
                    "hint-password",
                    <button
                      type="button"
                      className="lr-btn"
                      title={
                        vis
                          ? undefined
                          : t(
                              viewerPasswordEnabled
                                ? "host.password.set"
                                : "host.password.unset",
                            )
                      }
                      aria-label={t("host.password.setAction")}
                      aria-expanded={passwordOpen}
                      aria-controls="host-password-form"
                      onClick={() => setPasswordOpen((current) => !current)}
                    >
                      <VisGlyph name="key" size={19} />
                      {viewerPasswordEnabled ? (
                        <i className="lr-chip-dot" aria-hidden="true" />
                      ) : null}
                      <Cap k="join.password" />
                    </button>,
                    "end",
                  )
                ) : null}
                {!room.inviteUrl ? (
                  <Pill
                    icon="link"
                    label={t(
                      activeCodeEntryPolicy === "open"
                        ? "host.invite.emptyOpen"
                        : viewerPasswordEnabled
                          ? "host.invite.emptyPassword"
                          : "host.invite.emptyPrivate",
                    )}
                    comic={
                      activeCodeEntryPolicy === "private" &&
                      !viewerPasswordEnabled
                        ? "invalid-invite"
                        : undefined
                    }
                  />
                ) : null}
              </RowGroup>
              {activeCodeEntryPolicy === "private" && passwordOpen ? (
                <RowGroup>
                  <form
                    id="host-password-form"
                    style={{ display: "contents" }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void changeViewerPassword(viewerPasswordDraft);
                    }}
                  >
                    <span
                      className="lr-input"
                      style={{ flex: 1, minWidth: 180 }}
                    >
                      <Glyph name="key" size={17} />
                      <input
                        id="viewer-password"
                        type={viewerPasswordVisible ? "text" : "password"}
                        value={viewerPasswordDraft}
                        maxLength={MAX_VIEWER_PASSWORD_LENGTH}
                        autoComplete="new-password"
                        placeholder={
                          vis
                            ? ""
                            : viewerPasswordEnabled
                              ? t("host.password.inputPlaceholder")
                              : t("host.password.placeholder")
                        }
                        aria-label={t("join.password")}
                        autoFocus={!viewerPasswordEnabled}
                        disabled={roomMutating}
                        onChange={(event) =>
                          setViewerPasswordDraft(event.target.value)
                        }
                      />
                    </span>
                    {viewerPasswordEnabled && viewerPasswordDraft.length > 0 ? (
                      <Btn
                        icon={viewerPasswordVisible ? "eyeOff" : "eye"}
                        title={
                          viewerPasswordVisible
                            ? "host.password.hide"
                            : "host.password.show"
                        }
                        draw="host-password-eye"
                        pressed={viewerPasswordVisible}
                        disabled={roomMutating}
                        onClick={() =>
                          setViewerPasswordVisible((current) => !current)
                        }
                      />
                    ) : null}
                    <Btn
                      icon="check"
                      type="submit"
                      title={
                        viewerPasswordEnabled
                          ? "host.password.changeAction"
                          : "host.password.setAction"
                      }
                      hint="hint-password"
                      disabled={
                        roomMutating ||
                        viewerPasswordDraft.length === 0 ||
                        (viewerPasswordEnabled &&
                          viewerPasswordDraft === creationProfile.roomPassword)
                      }
                    />
                    {viewerPasswordEnabled ? (
                      <Btn
                        icon="x"
                        tone="danger"
                        title="host.password.remove"
                        disabled={roomMutating}
                        onClick={() => void changeViewerPassword(null)}
                      />
                    ) : null}
                  </form>
                </RowGroup>
              ) : null}
            </Row>
          ) : null}

          <Row label={t("host.quality")}>
            <RowGroup>
              <div className="lr-tiles">
                {(Object.keys(QUALITY_PROFILES) as QualityProfileId[]).map(
                  (id, index) => (
                    <Fragment key={id}>
                      {hintWrap(
                        "hint-quality",
                        <button
                          type="button"
                          className={`lr-tile${
                            selectedQualityProfileId === id ? " is-selected" : ""
                          }`}
                          aria-pressed={selectedQualityProfileId === id}
                          title={
                            vis
                              ? undefined
                              : t("host.quality.title", {
                                  label: t(QUALITY_PROFILE_CAPTIONS[id]),
                                  mbps: (
                                    QUALITY_PROFILES[id].maxBitrate / 1_000_000
                                  ).toFixed(0),
                                })
                          }
                          aria-label={t(QUALITY_PROFILE_CAPTIONS[id])}
                          disabled={phase === "starting" || switchingSource}
                          onClick={() =>
                            void changeQuality({
                              ...QUALITY_PROFILES[id],
                              screenAudioQuality: resolveScreenAudioQuality(
                                advancedQualityRef.current.screenAudioQuality,
                              ),
                            })
                          }
                        >
                          <QualityTileGlyph density={index} />
                          <small>
                            {vis
                              ? `${QUALITY_PROFILES[id].resolution.replace("p", "")}·${QUALITY_PROFILES[id].maxFramerate}`
                              : t(QUALITY_PROFILE_CAPTIONS[id])}
                          </small>
                        </button>,
                        index === 0 ? "start" : "center",
                      )}
                    </Fragment>
                  ),
                )}
              </div>
            </RowGroup>
            <span className="lr-spacer" />
            {hintWrap(
              "hint-advanced",
              <Btn
                icon="sliders"
                cap="host.advanced"
                title="host.advanced"
                tone={showAdvanced ? "on" : undefined}
                expanded={showAdvanced}
                controls="host-advanced-door"
                onClick={() => setShowAdvanced((current) => !current)}
              />,
              "end",
              // Mobile stacks `.lr-row` into a stretch column, which would
              // stretch the tooltip wrapper to full row width and leave its
              // wrapper-centered caret (and end-aligned panel) floating in
              // empty card space away from the button. Take the stretch on a
              // layout span instead and park the wrapper at the row's end,
              // matching the desktop row-right placement; in the desktop row
              // layout the span shrink-wraps and this is a no-op.
              { display: "flex", justifyContent: "flex-end" },
            )}
          </Row>
          <div
            id="host-advanced-door"
            className={`lr-door-reveal${showAdvanced ? " is-open" : ""}`}
          >
            <div>
              {showAdvanced ? (
                <div
                  className="lr-door-body"
                  role="group"
                  aria-label={t("host.advanced")}
                >
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.resolution")}
                    >
                      <VisGlyph name="expand" size={19} />
                      <Cap k="host.advanced.resolution" />
                    </span>
                    <div
                      className="lr-row-group"
                      role="group"
                      aria-label={t("host.advanced.resolution")}
                    >
                      {(
                        Object.keys(QUALITY_RESOLUTIONS) as QualityResolution[]
                      ).map((resolution) => (
                        <Chip
                          key={resolution}
                          selected={advancedQuality.resolution === resolution}
                          disabled={phase === "starting" || switchingSource}
                          title={QUALITY_RESOLUTIONS[resolution].label}
                          hint="hint-quality"
                          onClick={() =>
                            changeAdvancedQuality({ resolution })
                          }
                        >
                          {QUALITY_RESOLUTIONS[resolution].label}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.framerate")}
                    >
                      <VisGlyph name="wave" size={19} />
                      <Cap k="host.advanced.framerate" />
                    </span>
                    <span className="lr-slider">
                      <input
                        type="range"
                        min={15}
                        max={60}
                        step={5}
                        value={advancedQuality.maxFramerate}
                        disabled={phase === "starting" || switchingSource}
                        aria-label={t("host.advanced.framerate")}
                        onChange={(event) =>
                          changeAdvancedQuality({
                            maxFramerate: Number(event.target.value),
                          })
                        }
                      />
                      <output>{advancedQuality.maxFramerate} fps</output>
                    </span>
                  </div>
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.bitrate")}
                    >
                      <VisGlyph name="gauge" size={19} />
                      <Cap k="host.advanced.bitrate" />
                    </span>
                    <span className="lr-slider">
                      <input
                        type="range"
                        min={2000000}
                        max={12000000}
                        step={500000}
                        value={advancedQuality.maxBitrate}
                        disabled={phase === "starting" || switchingSource}
                        aria-label={t("host.advanced.bitrate")}
                        onChange={(event) =>
                          changeAdvancedQuality({
                            maxBitrate: Number(event.target.value),
                          })
                        }
                      />
                      <output>
                        {(advancedQuality.maxBitrate / 1_000_000).toFixed(1)}{" "}
                        Mbps
                      </output>
                    </span>
                  </div>
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.preference")}
                    >
                      <VisGlyph name="mountain" size={19} />
                      <Cap k="host.advanced.preference" />
                    </span>
                    <div
                      className="lr-row-group"
                      role="group"
                      aria-label={t("host.advanced.preference")}
                    >
                      {(
                        Object.keys(
                          PREFERENCE_PRESENTATION,
                        ) as DegradationPreference[]
                      ).map((preference) => (
                        <Chip
                          key={preference}
                          name="degradationPreference"
                          value={preference}
                          selected={
                            advancedQuality.degradationPreference === preference
                          }
                          disabled={phase !== "live" || switchingSource}
                          title={`${t(PREFERENCE_PRESENTATION[preference].cap)} · ${t(PREFERENCE_PRESENTATION[preference].hint)}`}
                          hint="hint-degrade-pref"
                          onClick={() =>
                            changeAdvancedQuality({
                              degradationPreference: preference,
                            })
                          }
                        >
                          <Glyph
                            name={PREFERENCE_PRESENTATION[preference].icon}
                            size={18}
                          />
                          <Cap k={PREFERENCE_PRESENTATION[preference].cap} />
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.audio")}
                    >
                      <VisGlyph name="speaker" size={19} />
                      <Cap k="host.advanced.audio" />
                    </span>
                    <div
                      className="lr-row-group"
                      role="group"
                      aria-label={t("host.advanced.audio")}
                    >
                      {(
                        Object.keys(
                          AUDIO_QUALITY_CAPTIONS,
                        ) as ScreenAudioQuality[]
                      ).map((audioQuality) => (
                        <Chip
                          key={audioQuality}
                          selected={
                            resolveScreenAudioQuality(
                              advancedQuality.screenAudioQuality,
                            ) === audioQuality
                          }
                          disabled={phase === "starting" || switchingSource}
                          title={t("host.audio.title", {
                            label: t(AUDIO_QUALITY_CAPTIONS[audioQuality]),
                            kbps: String(
                              SCREEN_AUDIO_BITRATES[audioQuality] / 1_000,
                            ),
                          })}
                          hint="hint-audio-quality"
                          onClick={() => changeScreenAudioQuality(audioQuality)}
                        >
                          <Cap k={AUDIO_QUALITY_CAPTIONS[audioQuality]} />
                          <small className="lr-audio-rate">
                            {SCREEN_AUDIO_BITRATES[audioQuality] / 1_000}
                          </small>
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.route")}
                    >
                      <VisGlyph name="branch" size={19} />
                      <Cap k="host.advanced.route" />
                    </span>
                    <div className="lr-row-group">
                      <SwitchItem
                        checked={routePolicy.topologyOptimization}
                        disabled={phase === "starting" || phase === "live"}
                        onChange={(checked) =>
                          changeRoutePolicy({ topologyOptimization: checked })
                        }
                        label={t("host.advanced.route.topo")}
                        note={t("host.advanced.route.topoHint")}
                        hint="hint-topology"
                      />
                      <SwitchItem
                        checked={routePolicy.peerOnly}
                        disabled={phase === "starting" || phase === "live"}
                        onChange={(checked) =>
                          changeRoutePolicy({ peerOnly: checked })
                        }
                        label={t("host.advanced.route.peerOnly")}
                        note={t("host.advanced.route.peerOnlyHint")}
                        hint="hint-route-p2p"
                      />
                      <SwitchItem
                        checked={natPredictionEnabled}
                        disabled={phase === "starting" || phase === "live"}
                        onChange={changeNatPrediction}
                        label={t("host.advanced.route.natPrediction")}
                        note={t("host.advanced.route.natPredictionHint")}
                        hint="hint-nat-prediction"
                      />
                    </div>
                  </div>
                  <div className="lr-door-group">
                    <span
                      className="lr-door-glyph"
                      title={vis ? undefined : t("host.advanced.codec")}
                    >
                      <VisGlyph name="cpu" size={19} />
                      <Cap k="host.advanced.codec" />
                    </span>
                    <div
                      className="lr-row-group"
                      role="group"
                      aria-label={t("host.advanced.codec")}
                    >
                      {(["vp8", "auto", "h264"] as const).map((mode) => (
                        <Chip
                          key={mode}
                          selected={displayedVideoCodecMode === mode}
                          disabled={phase === "starting" || phase === "live"}
                          title={
                            mode === "auto"
                              ? resolvedVideoCodec
                                ? `${t("host.advanced.codec.auto")} · ${resolvedVideoCodec.toUpperCase()}`
                                : `${t("host.advanced.codec.auto")} · ${t("host.advanced.codec.autoHint")}`
                              : `${mode.toUpperCase()} · ${t(
                                  mode === "vp8"
                                    ? "host.advanced.codec.vp8Hint"
                                    : "host.advanced.codec.h264Hint",
                                )}`
                          }
                          hint="hint-codec"
                          onClick={() => changeVideoCodecMode(mode)}
                        >
                          {mode.toUpperCase()}
                        </Chip>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
