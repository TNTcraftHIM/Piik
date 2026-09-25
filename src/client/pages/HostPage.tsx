import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  DEFAULT_QUALITY_SETTINGS,
  DEFAULT_ROUTE_POLICY,
  MAX_VIEWER_PASSWORD_LENGTH,
  viewerPasswordSchema,
  type CreateRoomResponse,
  type ClientMessage,
  type IceConfig,
  type ParticipantPresenceEntry,
  type PreparedRouteCandidate,
  type ServerMessage,
  type SignalPayload,
  type CodeEntryPolicy,
  type RoutePolicy,
} from "../../shared/protocol";
import { browserCaptureDevices } from "../media/capture-devices";
import { AppHeader, LedStrip } from "../components/living/Header";
import { WelcomeLine } from "../components/living/WelcomeLine";
import { Couch, type CouchEntry } from "../components/living/Couch";
import { SharingSettings } from "../components/living/SharingSettings";
import { HostMicrophone, HostMicrophoneSettings } from "../components/living/HostMicrophone";
import { HostAudio } from "../media/host-audio";
import {
  CaptureSourcePicker,
  type NativeSourceList,
} from "../components/living/CaptureSourcePicker";
import { PawnDetail } from "../components/living/PawnDetail";
import {
  RoomAdmissionBadge,
  roomAdmission,
  RoomChip,
} from "../components/living/RoomChip";
import { RouteTree } from "../components/living/RouteTree";
import {
  ViewerOverview,
  type ViewerOverviewEntry,
} from "../components/living/ViewerOverview";
import type { ComicKind } from "../components/living/Comic";
import type { HintKind } from "../ui/visual-kinds";
import type { ComicTone } from "../components/living/comic-presentation";
import { Tooltip } from "../components/living/Tooltip";
import { QualityPresets } from "../components/living/QualityPresets";
import { RoomCodeInput, RoomCodeError } from "../components/living/RoomCodeInput";
import { MetricCell } from "../components/living/Metrics";
import {
  StageOverlay,
  StageTv,
  StaticNoise,
} from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import {
  Btn,
  Cap,
  Chip,
  FieldCap,
  NameTag,
  Pill,
  Row,
  RowGroup,
  SwitchItem,
} from "../components/living/primitives";
import { hasPeerRouteEvidence } from "../components/status-badge-model";
import { Glyph, type GlyphName } from "../ui/icons";
import { say, useCopy, type CopyKey } from "../ui/copy";
import { resolveMediaFailure, type MediaFailure } from "../ui/media-failure";
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
import { debugError, debugEvent, debugOperation } from "../lib/debug";
import {
  defaultHostDisplayName,
  readDisplayName,
  readStoredDisplayName,
  saveDisplayName,
} from "../lib/display-name";
import { useDocumentTitle } from "../ui/document-title";
import { deriveHostStatus, deriveParticipantStatus, type HostPhase } from "../ui/media-status";
import {
  clearHostRoom,
  getStableClientId,
  type HostRoomIdentity,
  type HostRoomState,
  mergeAuthenticatedHostRoom,
  readHostRoom,
  releaseHostRoom,
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
  captureBrowserSource,
  type BrowserCaptureSource,
  matchingQualityProfileId,
  QUALITY_PROFILES,
  DEGRADATION_PREFERENCE_KEYS,
  QUALITY_RESOLUTIONS,
  qualitySettingsEqual,
  qualitySettingsLabel,
  resolveScreenAudioQuality,
  SCREEN_AUDIO_BITRATES,
  setMediaPaused,
  videoQualitySettingsEqual,
  type DegradationPreference,
  type QualityResolution,
  type QualitySettings,
  type ScreenAudioQuality,
} from "../media/quality";
import { HostSfuRoute } from "../media/host-sfu-route";
import { BrowserEncodingPool } from "../media/browser-encoding-pool";
import {
  HostProvisionalChild,
} from "../media/host-provisional-child";
import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
  sfuPublisherQualityEvidenceFromMetrics,
} from "../media/sender-quality-evidence";
import {
  classifyHostViewerQualityEvidence,
  metricsFromQualityEvidence,
  presentViewerQualityEvidence,
  qualityEvidenceUpstreamMatches,
  reconcileViewerQualityEvidencePresentation,
  type ViewerQualityEvidencePresentation,
} from "../media/viewer-quality-evidence";
import { ViewerQualityEvidenceStore } from "../media/viewer-quality-evidence-store";
import type {
  ConnectionMetrics,
  PeerSnapshot,
  SignalConnectionState,
} from "../types";
import { HostPeer, type HostMediaPeer } from "../webrtc/host-peer";
import { NativeClient, NativeCompatibilityError } from "../native/client";
import {
  NativeSenderPeer,
  shouldUseBrowserQualityCandidate,
} from "../native/native-sender-peer";
import { NativeSfuPublisher } from "../native/native-sfu-publisher";
import { SfuPublisher } from "../sfu/publisher";
import { NativeMediaBridge } from "../native/media-bridge";
import { NativeMediaIngress } from "../native/media-ingress";
import {
  defaultNativeCapturePath,
  type NativeCapturePath,
} from "../native/capture-selection";
import type { NativeCaptureTarget } from "../native/wire";
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
  isCapturePermissionFailure,
  type HostAction,
} from "./host-page-notices";

type NoticeValue = (
  | { kind: "text"; text: string }
  | { kind: "key"; key: CopyKey; vars?: Record<string, string> }
) & {
  target: "television" | "operation";
  comic: ComicKind | HintKind;
  tone: ComicTone;
};

const PREFERENCE_PRESENTATION: Record<
  DegradationPreference,
  { icon: GlyphName; hint: CopyKey }
> = {
  "maintain-resolution": {
    icon: "mountain",
    hint: "host.advanced.preference.resolutionHint",
  },
  balanced: {
    icon: "balance",
    hint: "host.advanced.preference.balancedHint",
  },
  "maintain-framerate": {
    icon: "frames",
    hint: "host.advanced.preference.framerateHint",
  },
};

const AUDIO_QUALITY_CAPTIONS: Record<ScreenAudioQuality, CopyKey> = {
  saver: "host.advanced.audio.saver",
  music: "host.advanced.audio.music",
  "very-high": "host.advanced.audio.veryHigh",
};

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
  hasSourceAudio: boolean;
}

function captureDetails(stream: MediaStream, native = false, sourceAudio?: boolean): CaptureDetails {
  // A Native preview is a received track, not an observation of raw capture.
  const settings = native ? undefined : stream.getVideoTracks()[0]?.getSettings();
  return {
    resolution:
      settings?.width && settings.height
        ? `${settings.width}x${settings.height}`
        : null,
    frameRate: settings?.frameRate ?? null,
    hasSourceAudio: sourceAudio ?? stream.getAudioTracks().length > 0,
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
  sfuAvailable?: boolean;
  natPredictionAvailable?: boolean;
  connectionAttemptProgress4?: boolean;
  launchedByClient?: boolean;
  onAuthorizationRequired?: () => void;
}

type ShareSourceSelection =
  | { kind: "browser"; source?: BrowserCaptureSource; deviceId?: string }
  | {
      kind: "native";
      client: NativeClient;
      target: NativeCaptureTarget;
      audio: boolean;
      showCaptureBorder: boolean;
      path: NativeCapturePath;
    };

export function HostPage({
  sfuAvailable = false,
  natPredictionAvailable = false,
  connectionAttemptProgress4 = false,
  launchedByClient = false,
  onAuthorizationRequired,
}: HostPageProps = {}) {
  const copy = useCopy();
  const { lang, vis, t, titleFrames } = copy;
  const [qualitySettings, setQualitySettings] = useState<QualitySettings>(
    DEFAULT_QUALITY_SETTINGS,
  );
  const [advancedQuality, setAdvancedQuality] = useState<QualitySettings>(
    DEFAULT_QUALITY_SETTINGS,
  );
  const [routePolicy, setRoutePolicy] = useState<RoutePolicy>(
    () => ({
      ...DEFAULT_ROUTE_POLICY,
      peerOnly: !sfuAvailable,
      natPrediction: natPredictionAvailable,
    }),
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
  const hostAudioRef = useRef<HostAudio | null>(null);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [microphoneVolume, setMicrophoneVolume] = useState(1);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [microphoneDevices, setMicrophoneDevices] = useState({ browser: "", native: "" });
  const [cameraDevice, setCameraDevice] = useState("");
  const loadMicrophones = useCallback(() => {
    const client = nativeModeRef.current ? nativeClientRef.current : null;
    return client ? client.microphones() : browserCaptureDevices("audioinput");
  }, []);
  const [nativeActive, setNativeActive] = useState(false);
  const [showCaptureBorder, setShowCaptureBorder] = useState(false);
  const [nativeSources, setNativeSources] =
    useState<NativeSourceList | null>(null);
  const sourcePickerReturnRef = useRef<{ id: string; restore: boolean } | null>(null);
  const sourcePickerOpen = nativeSources !== null;
  useLayoutEffect(() => {
    if (sourcePickerOpen) {
      const panel = document.querySelector(".lr-source-picker");
      const returning = sourcePickerReturnRef.current;
      return () => {
        if (returning) returning.restore = !!panel?.contains(document.activeElement) ||
          document.activeElement === document.body;
      };
    }
    const returning = sourcePickerReturnRef.current;
    if (!returning) return;
    if (!returning.restore || (document.activeElement !== document.body &&
        document.activeElement?.id !== "host-cancel-share")) {
      sourcePickerReturnRef.current = null;
      return;
    }
    if (phase === "starting") {
      // Keep cancellation reachable during the OS picker. Its removal on
      // completion must not strand focus, unless the user moved it elsewhere.
      document.getElementById("host-cancel-share")?.focus({ preventScroll: true });
      return;
    }
    sourcePickerReturnRef.current = null;
    // Opening removes Start; the committed phase supplies its logical successor.
    const target = document.getElementById(returning.id) ??
      document.getElementById("host-switch-source") ??
      document.getElementById("host-start-share");
    target?.focus({ preventScroll: true });
  }, [sourcePickerOpen, phase]);
  const [details, setDetails] = useState<CaptureDetails | null>(null);
  const [room, setRoom] = useState<HostRoomState | null>(null);
  const roomRef = useRef(room);
  const roomInitializationRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    roomInitializationRef.current = readHostRoom().then((stored) => {
      if (!mounted || roomRef.current !== null) return;
      const restored = hostRoomFromStored(stored);
      roomRef.current = restored;
      setRoom(restored);
    });
    return () => {
      mounted = false;
      releaseHostRoom();
    };
  }, []);
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
    readDisplayName(defaultHostDisplayName(vis)),
  );
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [viewerQualityEvidence, setViewerQualityEvidence] = useState<
    ReadonlyMap<string, ViewerQualityEvidencePresentation>
  >(() => new Map());
  const [noticeValue, setNoticeValue] = useState<NoticeValue | null>(null);
  const [hostSfuQualityWarning, setHostSfuQualityWarning] = useState<
    MediaFailure[] | null
  >(null);
  function setNotice(value: string | null, comic: ComicKind | HintKind, tone: ComicTone): void {
    setNoticeValue(value ? { kind: "text", text: value, target: "operation", comic, tone } : null);
  }
  function setNoticeKey(key: CopyKey, comic: ComicKind | HintKind, tone: ComicTone, vars?: Record<string, string>): void {
    setNoticeValue({ kind: "key", key, vars, target: "operation", comic, tone });
  }
  function setNoticeError(
    error: unknown,
    action: HostAction,
    target: NoticeValue["target"] = "operation",
  ): void {
    const permissionMissing = isCapturePermissionFailure(error, action);
    setNoticeValue({ kind: "text", text: readableError(error, action), target, tone: permissionMissing ? "warn" : "bad",
      comic: permissionMissing ? "hint-capture-browser" : action === "connection" ? "route-failed" : action === "capture" || action === "source"
        ? "source-failed" : action === "quality" ? "settings-failed" : "warning" });
  }
  function setNoticeErrorKey(
    key: CopyKey,
    comic: ComicKind = "warning",
    vars?: Record<string, string>,
    tone: ComicTone = "bad",
  ): void {
    setNoticeKey(key, comic, tone, vars);
  }
  const [includeInviteCredential, setIncludeInviteCredential] = useState(true);
  const roomLink = includeInviteCredential ? room?.inviteUrl : room?.canonicalUrl;
  const roomLinkBlocked = !includeInviteCredential && room?.codeEntryPolicy === "private" && !viewerPasswordEnabled;
  const [copiedRoomLink, setCopiedRoomLink] = useState<string | null>(null);
  const copied = copiedRoomLink !== null && copiedRoomLink === roomLink;
  const copiedResetTimerRef = useRef<number | null>(null);
  const copyRoomLinkRequestRef = useRef<object | null>(null);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [changingQuality, setChangingQuality] = useState(false);
  const [sharingPaused, setSharingPaused] = useState(false);
  const [localPreviewPaused, setLocalPreviewPaused] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [selectedPawn, setSelectedPawn] = useState<string | null>(null);
  const [joinRoomCode, setJoinRoomCode] = useState("");
  const [joinRejectedAttempt, setJoinRejectedAttempt] = useState(0);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [metricsExpanded, setMetricsExpanded] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const displayNameRef = useRef(displayName);
  const hostClientIdRef = useRef<string | null>(null);
  // Share start awaits capture, codec probe and room creation; the host can
  // switch expression mode meanwhile, so the name is derived from the current
  // mode rather than the render that began the start.
  const visRef = useRef(vis);
  useEffect(() => {
    visRef.current = vis;
  }, [vis]);
  useEffect(() => {
    if (hasCustomDisplayName) return;
    const fallback = defaultHostDisplayName(vis);
    if (displayNameRef.current === fallback) return;
    displayNameRef.current = fallback;
    setDisplayName(fallback);
    if (!editingDisplayName) setDisplayNameDraft(fallback);
    signalRef.current?.setDisplayName(fallback);
  }, [hasCustomDisplayName, lang, vis]);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const peersRef = useRef(new Map<string, HostMediaPeer>());
  const browserVideoPoolRef = useRef<BrowserEncodingPool | null>(null);
  const hostProvisionalChildRef = useRef<HostProvisionalChild | null>(null);
  const activeHostChildPeerIdsRef = useRef<string[]>([]);
  const endpointMediaCopyCapacityRef = useRef(MAX_ENDPOINT_MEDIA_CHILDREN);
  const hostPeerIdRef = useRef<string | null>(null);
  const [viewerQualityEvidenceStore] = useState(
    () => new ViewerQualityEvidenceStore(scheduleViewerQualityEvidenceRender),
  );
  const viewerQualityEvidenceRenderFrameRef = useRef<number | null>(null);
  const activeRouteRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const sourceSwitchRef = useRef<{ replacingVideo?: MediaStreamTrack } | null>(null);
  const qualityChangeRef = useRef<object | null>(null);
  const pendingQualityChangeRef = useRef<QualitySettings | null>(null);
  const qualitySettingsRef = useRef<QualitySettings>(DEFAULT_QUALITY_SETTINGS);
  const routePolicyRef = useRef<RoutePolicy>(routePolicy);
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
  const nativeClientRef = useRef<NativeClient | null>(null);
  const nativeClientConnectRef = useRef<Promise<NativeClient | null> | null>(null);
  const nativeShareGenerationRef = useRef<string | null>(null);
  const nativeMediaBridgeRef = useRef<NativeMediaBridge | null>(null);
  const nativeMediaIngressRef = useRef<NativeMediaIngress | null>(null);
  const nativeEventCleanupRef = useRef<(() => void) | null>(null);
  const nativeClientCloseCleanupRef = useRef<(() => void) | null>(null);
  const nativeModeRef = useRef(false);
  const nativeSourceAudioRef = useRef<boolean | undefined>(undefined);
  const nativeSourceRequestRef = useRef<object | null>(null);
  const nativePreviewTailRef = useRef<Promise<void>>(Promise.resolve());
  const nativeSourcePathRef = useRef<NativeCapturePath | null>(null);
  const nativeShareCleanupRef = useRef<Promise<void>>(Promise.resolve());

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
  const displayedVideoCodecMode =
    phase === "live" && resolvedVideoCodec
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
      roomMutationRef.current = null;
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
      browserVideoPoolRef.current?.dispose();
      browserVideoPoolRef.current = null;
      activeHostChildPeerIdsRef.current = [];
      endpointMediaCopyCapacityRef.current = MAX_ENDPOINT_MEDIA_CHILDREN;
      hostPeerIdRef.current = null;
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = null;
      }
      copyRoomLinkRequestRef.current = null;
      viewerQualityEvidenceStore.clear();
      cancelViewerQualityEvidenceRender();
      activeRouteRevisionRef.current = 0;
      void hostSfuRouteRef.current?.disconnect();
      hostSfuRouteRef.current = null;
      nativeSourceRequestRef.current = null;
      nativeSourcePathRef.current = null;
      disposeNativeShare();
      nativeClientCloseCleanupRef.current?.();
      nativeClientCloseCleanupRef.current = null;
      nativeClientConnectRef.current = null;
      nativeClientRef.current?.close();
      nativeClientRef.current = null;
      hostAudioRef.current?.dispose();
      hostAudioRef.current = null;
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
      createPublisher: (onDisconnected, onStats) => {
        const events = {
          send: (message: ClientMessage) => isCurrentGeneration(generation) && hostSfuRouteRef.current === route
            ? signalRef.current?.send(message) === true : false,
          onDisconnected, onStats,
        };
        if (nativeModeRef.current) {
          const client = nativeClientRef.current;
          const shareId = nativeShareGenerationRef.current;
          const ice = iceConfigRef.current;
          if (!client || !shareId || !ice) throw new Error("Native publication source is unavailable");
          return new NativeSfuPublisher(client, shareId, ice, events);
        }
        return new SfuPublisher(events);
      },
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

  function syncHostSfuQualityWarning(
    route: HostSfuRoute,
    generation: number,
  ): MediaFailure[] | null {
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
    commitQuality(qualitySettingsRef.current);
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
    disposeNativeShare();
    peersRef.current.forEach((peer) => peer.dispose());
    peersRef.current.clear();
    hostProvisionalChildRef.current?.discard();
    hostProvisionalChildRef.current = null;
    browserVideoPoolRef.current?.dispose();
    browserVideoPoolRef.current = null;
    activeHostChildPeerIdsRef.current = [];
    endpointMediaCopyCapacityRef.current = MAX_ENDPOINT_MEDIA_CHILDREN;
    hostPeerIdRef.current = null;
    void hostSfuRouteRef.current?.disconnect();
    hostSfuRouteRef.current = null;
    hostAudioRef.current?.dispose();
    hostAudioRef.current = null;
    setMicrophoneEnabled(false);
    setMicrophonePending(false);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    retiringStreamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    retiringStreamRef.current = null;
    iceConfigRef.current = null;
    setStream(null);
    setDetails(null);
    setPeerSnapshots(new Map());
    setParticipantPresence([]);
    viewerQualityEvidenceStore.clear();
    cancelViewerQualityEvidenceRender();
    setViewerQualityEvidence(viewerQualityEvidenceStore.getSnapshot());
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

  function forgetRoom(expected?: HostRoomState, keepResumeHint = false): boolean {
    if (expected && !isCurrentRoomAuthority(expected)) {
      return false;
    }
    clearHostRoom(keepResumeHint);
    roomRef.current = null;
    setRoom(null);
    setCopiedRoomLink(null);
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
    releaseUnusedNativeClient();
  }

  function endSharing(
    message: string | { key: CopyKey; vars?: Record<string, string> },
    notifyServer = true,
    comic: ComicKind = "share-ended",
    tone: ComicTone = "off",
  ): void {
    const generation = activeGenerationRef.current;
    if (generation === null || generationRef.current !== generation) {
      return;
    }
    activeGenerationRef.current = null;
    generationRef.current += 1;
    closeCaptureSourcePicker();
    const currentRoom = roomRef.current;
    if (notifyServer && currentRoom) {
      writePreferredRoom(currentRoom.roomId);
    }
    disposeResources(notifyServer);
    setNoticeValue({
      ...(typeof message === "string"
        ? { kind: "text", text: message }
        : { kind: "key", key: message.key, vars: message.vars }),
      target: "television",
      comic,
      tone,
    });
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
      if (!(await writeHostRoom(
        replacement,
        () => roomMutationRef.current === mutation,
      ))) {
        throw new Error("Host room is already open in another tab");
      }
      writePreferredRoom(replacement.roomId);
      roomRef.current = replacement;
      setRoom(replacement);
      setCopiedRoomLink(null);
      setViewerPasswordEnabled(profile.roomPassword !== null);
      setViewerPasswordDraft(profile.roomPassword ?? "");
      setViewerPasswordVisible(false);
      if (!wasSharing) {
        setNoticeKey("host.roomReplaced", "hint-shuffle-code", "live");
      }
      setPhase(wasSharing ? "ended" : "idle");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (!wasSharing) {
          // A memory-only room can disappear after a server restart.
          // Creation is the canonical recovery path; do not
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
            if (!(await writeHostRoom(
              replacement,
              () => roomMutationRef.current === mutation,
            ))) {
              throw new Error("Host room is already open in another tab");
            }
            writePreferredRoom(replacement.roomId);
            roomRef.current = replacement;
            setRoom(replacement);
            setCopiedRoomLink(null);
            setViewerPasswordEnabled(profile.roomPassword !== null);
            setViewerPasswordDraft(profile.roomPassword ?? "");
            setViewerPasswordVisible(false);
            setNoticeKey("host.roomReplaced", "hint-shuffle-code", "live");
            setPhase("idle");
            return;
          } catch (replacementError) {
            setNoticeError(replacementError, "room");
            return;
          }
        }
        if (forgetRoom(activeRoom)) {
          // endSharing already stated the recovery path; the raw room error
          // would only overwrite it with the same 404 in server wording.
          endSharing({ key: "host.roomInvalid" }, false, "room-not-found", "bad");
          return;
        }
      }
      setNoticeError(error, "room");
    } finally {
      finishRoomMutation(mutation);
    }
  }

  function updatePeerSnapshot(snapshot: PeerSnapshot): void {
    const presentation = viewerQualityEvidenceStore.getSnapshot().get(snapshot.peerId);
    if (presentation) {
      const reconciled = reconcileViewerQualityEvidencePresentation(
        presentation,
        snapshot,
      );
      if (reconciled !== presentation) {
        viewerQualityEvidenceStore.set(snapshot.peerId, reconciled);
      }
    }
    setPeerSnapshots((current) => {
      const next = new Map(current);
      next.set(snapshot.peerId, snapshot);
      return next;
    });
  }

  function scheduleViewerQualityEvidenceRender(): void {
    if (viewerQualityEvidenceRenderFrameRef.current !== null) return;
    viewerQualityEvidenceRenderFrameRef.current = window.requestAnimationFrame(
      () => {
        viewerQualityEvidenceRenderFrameRef.current = null;
        setViewerQualityEvidence(viewerQualityEvidenceStore.getSnapshot());
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
    viewerQualityEvidenceStore.retain(presentPeerIds);
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
    if (!evidenceSource) {
      return;
    }
    viewerQualityEvidenceStore.set(
      evidence.viewerPeerId,
      presentViewerQualityEvidence(
        viewerQualityEvidenceStore.getSnapshot().get(evidence.viewerPeerId) ?? null,
        evidence,
      ),
    );
  }

  function watchCaptureEnd(
    captured: MediaStream,
    generation: number,
  ): void {
    const track = captured.getVideoTracks()[0];
    track?.addEventListener(
      "ended",
      () => {
        if (
          isCurrentGeneration(generation) &&
          streamRef.current?.getVideoTracks()[0] === track &&
          sourceSwitchRef.current?.replacingVideo !== track
        ) {
          endSharing({ key: "host.stopNotice" });
        }
      },
      { once: true },
    );
  }

  async function startNativeShare(
    generation: number,
    shareGeneration: string,
    selection: Extract<ShareSourceSelection, { kind: "native" }>,
  ): Promise<MediaStream | null> {
    const { client, target, audio, showCaptureBorder, path } = selection;
    let bridge: NativeMediaBridge | null = null;
    let shareStarted = false;
    let nativeEventCleanup: (() => void) | null = null;
    try {
      await nativeShareCleanupRef.current;
      await nativePreviewTailRef.current;
      if (!isCurrentShare(generation, shareGeneration)) return null;
      if (nativeClientRef.current !== client) throw new Error("Piik App is unavailable");
      nativeSourceAudioRef.current = undefined;
      nativeEventCleanup = client.onEvent((event) => {
        if (event.shareId !== shareGeneration || !isCurrentShare(generation, shareGeneration) || nativeClientRef.current !== client) return;
        if (event.type === "audio-state") {
          nativeSourceAudioRef.current = event.sourceAudio;
          setMicrophoneEnabled(event.microphone);
          setDetails(previous => previous ? { ...previous, hasSourceAudio: event.sourceAudio } : previous);
          if (event.failed) setNoticeValue({ kind: "key", key: "host.microphone.unavailable", target: "operation", comic: "warning", tone: "warn" });
        }
        if (event.type === "share-ended") {
          endSharing(
            { key: event.failed ? "host.shareEnded" : "host.stopNotice" },
            true,
            event.failed ? "source-failed" : "share-ended",
            event.failed ? "bad" : "off",
          );
        }
      });
      nativeEventCleanupRef.current = nativeEventCleanup;
      const started = await client.startShare({
        shareId: shareGeneration,
        source: target,
        audio,
        showCaptureBorder,
        adapterIndex: path.adapterIndex,
        encoderIndex: path.encoderIndex,
        edgeCapacity: MAX_ENDPOINT_MEDIA_CHILDREN,
        profile: qualitySettingsRef.current,
        codec: videoCodecModeRef.current,
      });
      shareStarted = true;
      if (!isCurrentShare(generation, shareGeneration)) {
        await client.stopShare(shareGeneration).catch(() => discardNativeClient(client));
        return null;
      }
      if (nativeClientRef.current !== client) throw new Error("Piik App is unavailable");
      nativeSourceAudioRef.current ??= started.sourceAudio ?? started.audio;
      videoCodecRef.current = manualVideoCodecPreference(started.codec);
      bridge = new NativeMediaBridge(
        shareGeneration,
        client,
        () => {
          if (
            nativeMediaBridgeRef.current === bridge &&
            isCurrentShare(generation, shareGeneration)
          ) {
            endSharing({ key: "host.shareEnded" }, true, "source-failed", "bad");
          }
        },
        started.audio,
      );
      // Register ownership before waiting for the local bridge. A native edge
      // may fail immediately after becoming ready.
      ownNativeClient(client);
      nativeShareGenerationRef.current = shareGeneration;
      nativeMediaBridgeRef.current = bridge;
      nativeModeRef.current = true;
      setNativeActive(true);
      const stream = await bridge.start();
      if (!isCurrentShare(generation, shareGeneration)) {
        if (nativeMediaBridgeRef.current === bridge) disposeNativeShare();
        else bridge.dispose();
        return null;
      }
      return stream;
    } catch (error) {
      nativeEventCleanup?.();
      if (nativeEventCleanupRef.current === nativeEventCleanup) nativeEventCleanupRef.current = null;
      if (
        nativeClientRef.current === client &&
        nativeShareGenerationRef.current === shareGeneration
      ) {
        disposeNativeShare();
      } else {
        bridge?.dispose();
        if (shareStarted) {
          nativeShareCleanupRef.current = client
            .stopShare(shareGeneration)
            .catch(() => discardNativeClient(client));
        } else {
          discardNativeClient(client);
        }
      }
      throw error;
    }
  }

  function ownNativeClient(client: NativeClient): void {
    if (nativeClientRef.current === client) return;
    nativeClientCloseCleanupRef.current?.();
    nativeClientRef.current = client;
    nativeClientCloseCleanupRef.current = client.onClose(() => {
      if (nativeClientRef.current !== client) return;
      nativeClientRef.current = null;
      nativeClientConnectRef.current = null;
      nativeClientCloseCleanupRef.current = null;
      if (nativeSourceRequestRef.current) {
        nativeSourcePathRef.current = null;
        setNativeSources({ kind: "unavailable" });
      }
      if (nativeMediaIngressRef.current) {
        recoverBrowserFanout(nativeMediaIngressRef.current);
      } else if (nativeModeRef.current && activeGenerationRef.current !== null) {
        endSharing({ key: "host.shareEnded" }, true, "source-failed", "bad");
      }
    });
  }

  function discardNativeClient(client: NativeClient): void {
    if (nativeClientRef.current === client) {
      nativeClientCloseCleanupRef.current?.();
      nativeClientCloseCleanupRef.current = null;
      nativeClientRef.current = null;
      nativeClientConnectRef.current = null;
    }
    client.close();
  }

  function acquireNativeClient(): Promise<NativeClient | null> {
    if (nativeClientConnectRef.current) return nativeClientConnectRef.current;
    const connecting: Promise<NativeClient | null> = nativeShareCleanupRef.current.then(() =>
      nativeClientConnectRef.current === connecting
        ? nativeClientRef.current ?? NativeClient.connect()
        : null,
    ).catch((error) => {
      debugError("native", "discovery-failed", error);
      if (error instanceof NativeCompatibilityError) throw error;
      return null;
    }).then((client) => {
      if (nativeClientConnectRef.current !== connecting) {
        client?.close();
        return null;
      }
      if (client) ownNativeClient(client);
      return client;
    }).finally(() => {
      if (nativeClientConnectRef.current === connecting) nativeClientConnectRef.current = null;
    });
    nativeClientConnectRef.current = connecting;
    return connecting;
  }

  function releaseUnusedNativeClient(): void {
    // The picker may hand its connection to a starting share; only Native media
    // needs to keep it after startup. Merely visiting the page owns no session.
    if (nativeSourceRequestRef.current || nativeShareGenerationRef.current ||
      (activeGenerationRef.current !== null && roomMutationRef.current !== null)) return;
    nativeClientConnectRef.current = null;
    const client = nativeClientRef.current;
    if (client) discardNativeClient(client);
  }

  function closeCaptureSourcePicker(): void {
    nativeSourceRequestRef.current = null;
    nativeSourcePathRef.current = null;
    setNativeSources(null);
    releaseUnusedNativeClient();
  }

  async function openCaptureSourcePicker(): Promise<void> {
    if (!nativeSourceRequestRef.current) {
      sourcePickerReturnRef.current = {
        id: phase === "live" ? "host-switch-source" : "host-start-share", restore: false,
      };
    }
    const request = {};
    nativeSourceRequestRef.current = request;
    nativeSourcePathRef.current = null;
    if (!launchedByClient || (phase === "live" && !nativeModeRef.current)) {
      setNativeSources({ kind: "browser" });
      return;
    }
    setNativeSources({ kind: "loading" });

    let client: NativeClient | null;
    try {
      client = await acquireNativeClient();
    } catch (error) {
      if (nativeSourceRequestRef.current === request) {
        setNativeSources({ kind: error instanceof NativeCompatibilityError ? "incompatible" : "unavailable" });
      }
      return;
    }
    if (nativeSourceRequestRef.current !== request) {
      return;
    }
    if (!client) {
      setNativeSources({ kind: "unavailable" });
      return;
    }
    if (
      !client.health.nativeMedia.video ||
      (!client.health.nativeMedia.hardwareH264 &&
        !client.health.nativeMedia.softwareVP8)
    ) {
      setNativeSources({ kind: "unsupported" });
      return;
    }
    try {
      const [adapters, sources] = await Promise.all([
        client.captureOptions(),
        client.sources(),
      ]);
      const codec = nativeModeRef.current ? videoCodecRef.current.primary : videoCodecModeRef.current;
      const path = defaultNativeCapturePath(
        adapters,
        codec,
        client.health.nativeMedia.softwareVP8,
      );
      if (nativeSourceRequestRef.current !== request || nativeClientRef.current !== client) {
        return;
      }
      if (!path) {
        debugEvent("native", "capture-unavailable", { codec });
        setNativeSources({ kind: "unsupported" });
        return;
      }
      nativeSourcePathRef.current = path;
      setNativeSources({
        kind: "ready",
        sources,
        processAudio: client.health.nativeMedia.processAudio,
        systemAudio: client.health.nativeMedia.systemAudio,
        captureBorderControl: client.health.nativeMedia.captureBorderControl,
      });
    } catch (error) {
      if (nativeSourceRequestRef.current !== request || nativeClientRef.current !== client) return;
      debugError("native", "source-list-failed", error);
      if (!nativeShareGenerationRef.current) {
        discardNativeClient(client);
      }
      setNativeSources({ kind: "failed" });
    }
  }

  async function startBrowserNativeIngress(
    generation: number,
    shareGeneration: string,
    captured: MediaStream,
  ): Promise<void> {
    if (!launchedByClient || videoCodecRef.current.primary !== "h264" ||
      !routePolicyRef.current.topologyOptimization) return;
    const client = nativeClientRef.current;
    if (!client || !isCurrentShare(generation, shareGeneration)) return;
    await nativeShareCleanupRef.current;
    if (nativeClientRef.current !== client || !isCurrentShare(generation, shareGeneration)) return;
    const ingress = new NativeMediaIngress(shareGeneration, client, () => {
      recoverBrowserFanout(ingress);
    }, () => qualitySettingsRef.current);
    nativeMediaIngressRef.current = ingress;
    nativeShareGenerationRef.current = shareGeneration;
    try {
      await ingress.start(captured, qualitySettingsRef.current);
      if (!isCurrentShare(generation, shareGeneration)) {
        ingress.dispose();
        return;
      }
    } catch {
      if (nativeMediaIngressRef.current === ingress) disposeNativeShare();
    }
  }

  function recoverBrowserFanout(ingress: NativeMediaIngress): void {
    if (nativeMediaIngressRef.current !== ingress) return;
    disposeNativeShare();
    discardPreparedHostChild();
    const generation = activeGenerationRef.current;
    if (generation === null || !streamRef.current) return;
    for (const [peerId, peer] of peersRef.current) {
      if (!(peer instanceof NativeSenderPeer)) continue;
      removePeer(peerId);
      void startPeer(peerId, generation).catch((error: unknown) => {
        if (isCurrentGeneration(generation)) setNoticeError(error, "connection");
      });
    }
  }

  function requestSharing(): void {
    setJoiningRoom(false);
    void openCaptureSourcePicker();
  }

  function startBrowserShareFromPicker(source: BrowserCaptureSource, deviceId = ""): void {
    if (phase === "live") void switchSource(source, deviceId);
    else void startSharing({ kind: "browser", source, deviceId });
  }

  async function loadNativeSourcePreview(
    target: NativeCaptureTarget,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const client = nativeClientRef.current;
    const request = nativeSourceRequestRef.current;
    if (!client || !request || nativeSources?.kind !== "ready") return null;
    const owns = () => !signal?.aborted &&
      nativeSourceRequestRef.current === request &&
      nativeClientRef.current === client;
    // Keep thumbnails from filling the same control queue used to start media.
    const preview = nativePreviewTailRef.current.then(async () => {
      if (!owns()) return null;
      try {
        const value = await client.sourcePreview(target);
        return owns() ? value : null;
      } catch {
        return null;
      }
    });
    nativePreviewTailRef.current = preview.then(() => undefined);
    return preview;
  }

  function startNativeShareFromPicker(
    target: NativeCaptureTarget,
    audio: boolean,
    showCaptureBorder: boolean,
  ): void {
    if (nativeSources?.kind !== "ready") return;
    const client = nativeClientRef.current;
    const path = nativeSourcePathRef.current;
    if (!client || !path) return;
    setShowCaptureBorder(showCaptureBorder);
    if (phase === "live" && nativeModeRef.current) {
      void switchNativeSource(client, target, audio, path, showCaptureBorder);
      return;
    }
    void startSharing({ kind: "native", client, target, audio, showCaptureBorder, path });
  }

  function disposeNativeShare(expectedShare = nativeShareGenerationRef.current): void {
    if (nativeShareGenerationRef.current !== expectedShare) return;
    const client = nativeClientRef.current;
    const shareGeneration = nativeShareGenerationRef.current;
    const ingress = nativeMediaIngressRef.current;
    nativeMediaIngressRef.current = null;
    nativeMediaBridgeRef.current?.dispose();
    nativeMediaBridgeRef.current = null;
    ingress?.dispose();
    nativeEventCleanupRef.current?.();
    nativeEventCleanupRef.current = null;
    nativeShareGenerationRef.current = null;
    nativeModeRef.current = false;
    nativeSourceAudioRef.current = undefined;
    setNativeActive(false);
    if (!client || !shareGeneration) {
      releaseUnusedNativeClient();
      return;
    }
    nativeShareCleanupRef.current = (ingress
      ? client.stopReceive(shareGeneration)
      : client.stopShare(shareGeneration))
      .catch(() => discardNativeClient(client));
    releaseUnusedNativeClient();
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
      debugEvent("quality", "queued", { requested: nextProfile, generation: activeGenerationRef.current });
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
    const complete = debugOperation("quality", "update", { generation,
      requested: nextProfile, previous: previousProfile, native: nativeModeRef.current });
    let outcome = "superseded";
    let failure: unknown;
    qualityChangeRef.current = token;
    setChangingQuality(true);
    setNoticeValue(null);
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
      const nativeClient = nativeClientRef.current;
      const nativeShareGeneration = nativeShareGenerationRef.current;
      const nativeUpdate = nativeModeRef.current
        ? nativeClient && nativeShareGeneration
          ? { client: nativeClient, shareGeneration: nativeShareGeneration }
          : null
        : undefined;
      if (nativeUpdate === null) {
        throw new Error("Native share is unavailable");
      }
      if (nativeUpdate) {
        await nativeUpdate.client.updateShare(
          nativeUpdate.shareGeneration,
          nextProfile,
        );
      }
      const appliedProfile = nextProfile;
      if (!nativeUpdate && captureChanged) {
        await applyCaptureProfile(activeStream, nextProfile);
      }
      if (
        !isCurrentGeneration(generation) ||
        qualityChangeRef.current !== token ||
        streamRef.current !== activeStream
      ) {
        return;
      }

      commitQuality(appliedProfile);
      debugEvent("quality", "committed", { generation, applied: appliedProfile });
      outcome = "applied";
      if (nativeUpdate) {
        setDetails(captureDetails(activeStream, true, nativeSourceAudioRef.current));
      } else if (captureChanged) {
        setDetails(captureDetails(hostAudioRef.current?.sourceStream ?? activeStream));
      }
      signalRef.current?.setHostQualitySettings(appliedProfile);
      const ingress = nativeMediaIngressRef.current;
      if (ingress) {
        const updated = await ingress.updateProfile(appliedProfile).catch(() => false);
        if (
          !isCurrentGeneration(generation) ||
          qualityChangeRef.current !== token ||
          streamRef.current !== activeStream
        ) {
          return;
        }
        if (!updated && nativeMediaIngressRef.current === ingress) {
          recoverBrowserFanout(ingress);
        }
      }
      const activeSfuRoute = hostSfuRouteRef.current;
      const [results, sfuUpdated] = await Promise.all([
        Promise.all(
          [
            ...[...peersRef.current.values()].map((peer) =>
              peer.updateCaptureProfile(appliedProfile),
            ),
            ...(hostProvisionalChildRef.current
              ? [
                  hostProvisionalChildRef.current.updateProfile(
                    appliedProfile,
                  ),
                ]
              : []),
          ],
        ),
        activeSfuRoute?.updateProfile(appliedProfile) ??
          Promise.resolve(true),
      ]);
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token &&
        streamRef.current === activeStream
      ) {
        const failed = results.filter((updated) => !updated).length;
        if (failed > 0 || !sfuUpdated) outcome = "partial";
        debugEvent("quality", "sender-results", { generation, failed, sfuUpdated, senderCount: results.length });
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
                  label: qualitySettingsLabel(appliedProfile),
                });
        setNotice(connectionWarning ?? (sfuWarning ? null : successNotice),
          connectionWarning ? "settings-failed" : audioChanged && !videoChanged ? "hint-audio-quality" : "hint-quality",
          connectionWarning ? "warn" : "live");
      }
    } catch (error) {
      failure = error;
      outcome = "failed";
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token &&
        streamRef.current === activeStream
      ) {
        if (pendingQualityChangeRef.current === null) {
          advancedQualityRef.current = qualitySettingsRef.current;
          setAdvancedQuality(qualitySettingsRef.current);
        }
        setNoticeError(error, "quality");
      }
    } finally {
      complete(outcome, { generation,
        ...(isCurrentGeneration(generation) ? { applied: qualitySettingsRef.current } : {}) }, failure);
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
    const nativeClient = nativeClientRef.current;
    const nativeShareGeneration = nativeShareGenerationRef.current;
    if (
      phase !== "live" ||
      (!activeStream && (!nativeClient || !nativeShareGeneration))
    ) {
      return;
    }
    if (nativeModeRef.current && nativeClient && nativeShareGeneration) {
      const generation = activeGenerationRef.current;
      if (generation === null) return;
      const nextPaused = !sharingPausedRef.current;
      void nativeClient
        .setPaused(nativeShareGeneration, nextPaused)
        .then(() => {
          if (!isCurrentGeneration(generation)) return;
          const sent = signalRef.current?.setSharingPaused(nextPaused) === true;
          if (!sent && !nextPaused) {
            // Mirror the Browser branch: a resume the server did not hear
            // rolls back to paused and restores the wire intent.
            void nativeClient.setPaused(nativeShareGeneration, true);
            signalRef.current?.confirmSharingPaused();
            setNoticeErrorKey("host.pause.signalRecovering", "signal-recovering", undefined, "warn");
            return;
          }
          if (activeStream) {
            setMediaPaused(activeStream, nextPaused);
          }
          for (const peer of peersRef.current.values()) {
            peer.setPaused(nextPaused);
          }
          hostProvisionalChildRef.current?.setPaused(nextPaused);
          hostSfuRouteRef.current?.setPaused(nextPaused);
          sharingPausedRef.current = nextPaused;
          setSharingPaused(nextPaused);
          if (!sent) {
            setNoticeErrorKey("host.pause.signalRecovering", "signal-recovering", undefined, "warn");
          } else {
            setNoticeValue(null);
          }
        })
        .catch((error: unknown) => {
          if (isCurrentGeneration(generation)) {
            setNoticeError(error, "connection");
          }
        });
      return;
    }
    if (!activeStream) {
      return;
    }
    if (sharingPausedRef.current) {
      if (!setMediaPaused(activeStream, false)) {
        setNoticeErrorKey("host.pause.noTracksResume", "source-failed");
        return;
      }
      nativeMediaIngressRef.current?.setPaused(false);
      for (const peer of peersRef.current.values()) peer.setPaused(false);
      hostProvisionalChildRef.current?.setPaused(false);
      hostSfuRouteRef.current?.setPaused(false);
      if (signalRef.current?.setSharingPaused(false) !== true) {
        setMediaPaused(activeStream, true);
        nativeMediaIngressRef.current?.setPaused(true);
        for (const peer of peersRef.current.values()) peer.setPaused(true);
        hostProvisionalChildRef.current?.setPaused(true);
        hostSfuRouteRef.current?.setPaused(true);
        signalRef.current?.confirmSharingPaused();
        setNoticeErrorKey("host.pause.signalRecovering", "signal-recovering", undefined, "warn");
        return;
      }
      sharingPausedRef.current = false;
      // Before the mixer existed, source audio itself was the paused output.
      // Restore it only on an accepted resume, never during permission handoff.
      if (hostAudioRef.current) setMediaPaused(hostAudioRef.current.sourceStream, false);
      setSharingPaused(false);
      setNoticeValue(null);
      return;
    }
    if (!setMediaPaused(activeStream, true)) {
      setNoticeErrorKey("host.pause.noTracksPause", "source-failed");
      return;
    }
    nativeMediaIngressRef.current?.setPaused(true);
    for (const peer of peersRef.current.values()) peer.setPaused(true);
    hostProvisionalChildRef.current?.setPaused(true);
    sharingPausedRef.current = true;
    setSharingPaused(true);
    hostSfuRouteRef.current?.setPaused(true);
    discardPreparedHostChild();
    if (signalRef.current?.setSharingPaused(true) === true) {
      setNoticeValue(null);
    } else {
      setNoticeErrorKey("host.pause.signalRecovering", "signal-recovering", undefined, "warn");
    }
  }

  function removePeer(peerId: string): void {
    viewerQualityEvidenceStore.set(peerId, null);
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
    const nativeClient = nativeClientRef.current;
    const nativeShareGeneration = nativeShareGenerationRef.current;
    const iceConfig = iceConfigRef.current;
    const signal = signalRef.current;
    if (
      !isCurrentGeneration(generation) ||
      (!stream && !nativeModeRef.current) ||
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
      onPreparedChildFailed: (revision, connectionId) => {
        reportPreparedHostChildFailure(revision, connectionId, generation);
      },
      onPreparedChildConnected: (revision, connectionId) =>
        isCurrentGeneration(generation) && signalRef.current === signal &&
        signal.send({ type: "route-transport-connected", revision, connectionId }),
      createPeer:
        nativeClient && nativeShareGeneration
          ? (candidate, input, events) => {
              const current = peersRef.current.get(candidate.childPeerId);
              if (
                shouldUseBrowserQualityCandidate(current, candidate) &&
                input.stream
              ) {
                return new HostPeer(
                  candidate.childPeerId,
                  input.iceConfig,
                  input.stream,
                  input.profile,
                  events,
                  input.videoCodec,
                  candidate.connectionId,
                  input.natPredictionEnabled,
                );
              }
              return new NativeSenderPeer(
                candidate.childPeerId,
                candidate.connectionId,
                nativeShareGeneration,
                iceConfig!,
                input.natPredictionEnabled,
                nativeClient,
                events,
                videoCodecRef.current.primary,
                nativeMediaIngressRef.current?.source,
              );
            }
          : undefined,
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
      natPredictionEnabled: routePolicyRef.current.natPrediction,
      videoPool: nativeClient && nativeShareGeneration ? undefined : browserVideoPool(),
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

  function browserVideoPool(): BrowserEncodingPool {
    return browserVideoPoolRef.current ??= new BrowserEncodingPool();
  }

  async function startPeer(
    peerId: string,
    generation: number,
  ): Promise<void> {
    if (
      !isCurrentGeneration(generation) ||
      !hostChildIsAssigned(peerId) ||
      peersRef.current.has(peerId)
    ) {
      return;
    }
    const activeStream = streamRef.current;
    const nativeClient = nativeClientRef.current;
    const nativeShareGeneration = nativeShareGenerationRef.current;
    const useNative = nativeClient !== null && nativeShareGeneration !== null;
    const iceConfig = iceConfigRef.current;
    const signal = signalRef.current;
    if ((!activeStream && !useNative) || !iceConfig || !signal) {
      return;
    }

    let peer: HostMediaPeer;
    const peerEvents: {
      sendSignal: (
        targetPeerId: string,
        payload: Extract<SignalPayload, { kind: "description" | "candidate" }>,
      ) => boolean;
      onUpdate: (snapshot: PeerSnapshot) => void;
    } = {
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
    };
    peer = useNative
      ? new NativeSenderPeer(
          peerId,
          createOpaqueId(),
          nativeShareGeneration!,
          iceConfig,
          routePolicyRef.current.natPrediction,
          nativeClient,
          peerEvents,
          videoCodecRef.current.primary,
          nativeMediaIngressRef.current?.source,
        )
      : new HostPeer(
          peerId,
          iceConfig,
          activeStream!,
          qualitySettingsRef.current,
          peerEvents,
          videoCodecRef.current,
          undefined,
          routePolicyRef.current.natPrediction,
          browserVideoPool(),
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
    reportHostChildFailure(peerId, connectionId, generation);
    removePeer(peerId);
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
        hostChildIsAssigned(peerId) &&
        signalRef.current?.send({
          type: "route-failed",
          revision: activeRouteRevisionRef.current,
          phase: "active",
          connectionId,
        }),
    );
  }

  function reportPreparedHostChildFailure(
    revision: number,
    connectionId: string,
    generation: number,
  ): void {
    if (isCurrentGeneration(generation)) {
      signalRef.current?.send({
        type: "route-failed",
        revision,
        phase: "prepare",
        connectionId,
      });
    }
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
      routePolicyRef.current = { ...message.routePolicy };
      setRoutePolicy({ ...message.routePolicy });
      setRoom((current) =>
        mergeAuthenticatedHostRoom(
          current,
          activeRoom.roomId,
          message.codeEntryPolicy,
        ),
      );
      const currentQualitySettings =
        pendingQualitySettings ?? message.qualitySettings;
      activeRouteRevisionRef.current = message.routeRevision;
      if (reauthenticated) {
        // Offers or answers may have been lost with the previous WebSocket.
        for (const [peerId, peer] of peersRef.current) {
          if (!peer.isConnected()) removePeer(peerId);
        }
        const draft = qualityChangeRef.current ? advancedQualityRef.current : null;
        commitQuality(currentQualitySettings);
        if (draft) {
          advancedQualityRef.current = draft;
          setAdvancedQuality(draft);
        }
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
          if (reauthenticated && isCurrentGeneration(generation) && hostSfuRouteRef.current === route) {
            await route.updateProfile(qualitySettingsRef.current);
          }
          syncHostSfuQualityWarning(route, generation);
        });
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
      const nativeClient = nativeClientRef.current;
      const nativeShareGeneration = nativeShareGenerationRef.current;
      if (nativeModeRef.current && nativeClient && nativeShareGeneration) {
        void nativeClient
          .setPaused(nativeShareGeneration, true)
          .catch(() => undefined);
      }
      if (activeStream) {
        setMediaPaused(activeStream, true);
      }
      nativeMediaIngressRef.current?.setPaused(true);
      for (const peer of peersRef.current.values()) peer.setPaused(true);
      hostProvisionalChildRef.current?.setPaused(true);
      hostSfuRouteRef.current?.setPaused(true);
      sharingPausedRef.current = true;
      setSharingPaused(true);
      signalRef.current?.confirmSharingPaused();
      setNoticeErrorKey("host.pause.stillPaused", "host-paused", undefined, "warn");
      return;
    }
    if (message.type === "route-update") {
      const route = ensureHostSfuRoute(generation);
      const accepted = route.accept(message);
      if (accepted === "stale") return;
      if (message.phase === "prepare") {
        if (accepted === "duplicate") return;
        if (message.candidate.transport === "direct") {
          if (
            !prepareHostChild(
              message.revision,
              message.assignment,
              message.candidate,
              generation,
            )
          ) {
            reportPreparedHostChildFailure(
              message.revision,
              message.candidate.connectionId,
              generation,
            );
          }
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
      return;
    }
    if (message.type === "viewer-quality-evidence") {
      acceptViewerQualityEvidence(message);
      return;
    }
    if (message.type === "sfu-config") {
      const route = ensureHostSfuRoute(generation);
      void route
        .acceptConfig(message)
        .then(() => syncHostSfuQualityWarning(route, generation));
      return;
    }
    if (message.type === "sfu-signal") {
      void hostSfuRouteRef.current?.acceptSignal(message);
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
      endSharing(say("host.roomClosed"), false, "room-closed", "off");
      return;
    }
    if (message.type === "error") {
      if (message.code === "INVALID_TOKEN") {
        if (!forgetRoom(activeRoom)) {
          return;
        }
        endSharing({ key: "host.roomInvalid" }, false, "room-not-found", "bad");
        return;
      }
      if (message.code === "AUTH_REQUIRED") {
        return;
      }
      if (message.code === "HOST_ALREADY_CONNECTED") {
        endSharing(hostServerErrorNotice(message.code), false, "signal-failed", "bad");
        return;
      }
      setNotice(hostServerErrorNotice(message.code), "signal-failed", "bad");
    }
  }

  async function startSharing(selection: ShareSourceSelection): Promise<void> {
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
    closeCaptureSourcePicker();
    setNoticeValue(null);
    setCopiedRoomLink(null);
    setPhase("starting");

    let captured: MediaStream | null = null;
    let nativeStarted = false;
    try {
      if (selection.kind === "native") {
        captured = await startNativeShare(
          generation,
          shareGeneration,
          selection,
        );
        nativeStarted = true;
      } else {
        // This must remain the first awaited operation in the button gesture.
        captured = await captureBrowserSource(qualitySettingsRef.current, selection.source ?? "browser", selection.deviceId);
      }
    } catch (error) {
      if (!isCurrentShare(generation, shareGeneration)) {
        disposeNativeShare(shareGeneration);
        return;
      }
      activeGenerationRef.current = null;
      shareGenerationRef.current = null;
      setCaptureError(error, selection.kind === "browser" ? selection.source : undefined, "capture");
      setPhase(isCapturePermissionFailure(error, "capture") ? "idle" : "error");
      return;
    }

    if (!isCurrentShare(generation, shareGeneration)) {
      captured?.getTracks().forEach((track) => track.stop());
      if (nativeStarted) disposeNativeShare(shareGeneration);
      return;
    }
    if (captured) {
      if (selection.kind === "browser") {
        hostAudioRef.current = new HostAudio(captured, setMicrophoneEnabled, selection.source ?? "browser");
        if (selection.source === "camera") setCameraDevice(selection.deviceId ?? "");
      }
      streamRef.current = captured;
      setStream(captured);
      watchCaptureEnd(captured, generation);
      if (selection.kind === "native") {
        setDetails(
          captureDetails(captured, true, nativeSourceAudioRef.current),
        );
      } else {
        setDetails(captureDetails(captured));
        const codec = await resolveStreamVideoCodec(captured);
        if (isCurrentShare(generation, shareGeneration)) {
          videoCodecRef.current = codec;
          await startBrowserNativeIngress(generation, shareGeneration, captured);
          nativeStarted = nativeMediaIngressRef.current !== null;
        }
      }
    }
    if (!isCurrentShare(generation, shareGeneration)) {
      captured?.getTracks().forEach((track) => track.stop());
      if (nativeStarted) disposeNativeShare(shareGeneration);
      return;
    }
    if (captured) setResolvedVideoCodec(videoCodecRef.current.primary);

    let createdRoom: HostRoomState | null = null;
    let claimedRoom = false;
    try {
      await roomInitializationRef.current;
      if (!isCurrentShare(generation, shareGeneration)) return;
      createdRoom = roomRef.current;
      if (!createdRoom) {
        const response = await createRoom(
          creationProfileRef.current.codeEntryPolicy,
          creationProfileRef.current.roomPassword,
          readPreferredRoomId(),
        );
        createdRoom = hostRoomFromCreated(response);
        if (!isCurrentShare(generation, shareGeneration)) {
          captured?.getTracks().forEach((track) => track.stop());
          if (nativeStarted) disposeNativeShare(shareGeneration);
          closeAbandonedRoom(createdRoom);
          return;
        }
        if (!(await writeHostRoom(
          createdRoom,
          () => isCurrentShare(generation, shareGeneration),
        ))) {
          throw new Error("Host room is already open in another tab");
        }
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
        const hostFallback = defaultHostDisplayName(visRef.current);
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
            ...(connectionAttemptProgress4 ? { connectionAttemptProgress4: true } : {}),
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
                endSharing({ key: hostTerminationKey(reason) }, false, "signal-failed", "bad");
                if (reason === "SESSION_REPLACED") forgetRoom(activeRoom, true);
              }
            },
            onAccessRequired: () => {
              if (
                isCurrentShare(generation, shareGeneration) &&
                signalRef.current === signal
              ) {
                endSharing({ key: "gate.expired" }, false, "access-denied", "bad");
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
                message.code === "INVALID_TOKEN" &&
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
                void writeHostRoom(
                  activeRoom,
                  () => isCurrentShare(generation, shareGeneration) &&
                    signalRef.current === signal,
                );
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
            captured?.getTracks().forEach((track) => track.stop());
            disposeNativeShare(shareGeneration);
            closeAbandonedRoom(replacement);
            return;
          }
          if (!(await writeHostRoom(
            replacement,
            () => isCurrentShare(generation, shareGeneration),
          ))) {
            closeAbandonedRoom(replacement);
            throw new Error("Host room is already open in another tab");
          }
          roomRef.current = replacement;
          setRoom(replacement);
          const replacementSignal = connectSignal(replacement);
          signalRef.current = replacementSignal;
          replacementSignal.start();
        } catch (error) {
          if (!isCurrentShare(generation, shareGeneration)) {
            if (nativeStarted) disposeNativeShare(shareGeneration);
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
          setNoticeError(error, "room", "television");
          setPhase("error");
        }
      };
      const signal = connectSignal(createdRoom);
      signalRef.current = signal;
      signal.start();
    } catch (error) {
      if (!isCurrentShare(generation, shareGeneration)) {
        captured?.getTracks().forEach((track) => track.stop());
        if (nativeStarted) disposeNativeShare(shareGeneration);
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
      setNoticeError(error, "room", "television");
      setPhase("error");
    }
    } finally {
      finishRoomMutation(mutation);
    }
  }

  async function switchNativeSource(
    client: NativeClient,
    target: NativeCaptureTarget,
    audio: boolean,
    path: NativeCapturePath,
    showCaptureBorder: boolean,
  ): Promise<void> {
    const generation = activeGenerationRef.current;
    const shareGeneration = nativeShareGenerationRef.current;
    if (
      phase !== "live" ||
      generation === null ||
      !shareGeneration ||
      !isCurrentGeneration(generation) ||
      nativeClientRef.current !== client ||
      sourceSwitchRef.current ||
      qualityChangeRef.current
    ) {
      return;
    }
    const token = {};
    sourceSwitchRef.current = token;
    closeCaptureSourcePicker();
    setSwitchingSource(true);
    setNoticeValue(null);
    try {
      await nativePreviewTailRef.current;
      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token ||
        nativeClientRef.current !== client
      ) return;
      await client.replaceShareSource(
        shareGeneration,
        target,
        audio,
        path,
        showCaptureBorder,
      );
      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token ||
        nativeClientRef.current !== client
      ) {
        return;
      }
      invalidateSenderQualityEvidence();
      if (routePolicyRef.current.topologyOptimization) {
        signalRef.current?.send({ type: "reset-sender-quality" });
      }
      const activeStream = streamRef.current;
      if (activeStream) {
        setDetails(
          captureDetails(activeStream, true, nativeSourceAudioRef.current),
        );
      }
      const sfuUpdated = await hostSfuRouteRef.current?.updateProfile(qualitySettingsRef.current) ?? true;
      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token ||
        nativeClientRef.current !== client
      ) {
        return;
      }
      setNotice(sourceSwitchNotice({
        failedPeerCount: 0,
        sfuReplaced: sfuUpdated,
      }), sfuUpdated ? "hint-switch-source" : "connecting-sfu", sfuUpdated ? "live" : "warn");
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        setNoticeError(error, "source");
      }
    } finally {
      finishSourceSwitch(token);
    }
  }

  async function switchSource(source?: BrowserCaptureSource, deviceId = ""): Promise<void> {
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
    if (!source) {
      await openCaptureSourcePicker();
      return;
    }
    if (nativeModeRef.current) return;

    // Some browsers retire the old camera while opening the new one. That
    // transition belongs to this replacement, not the share-ended observer.
    const token = { replacingVideo: source === "camera" && hostAudioRef.current?.sourceKind === "camera"
      ? streamRef.current?.getVideoTracks()[0] : undefined };
    sourceSwitchRef.current = token;
    closeCaptureSourcePicker();
    setSwitchingSource(true);
    setNoticeValue(null);

    let captured: MediaStream;
    try {
      // Like initial capture, changing source must begin in this button gesture.
      captured = await captureBrowserSource(qualitySettingsRef.current, source, deviceId);
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        if (token.replacingVideo?.readyState === "ended") {
          endSharing({ key: "host.shareEnded" }, true, "source-failed", "bad");
        } else {
          setCaptureError(error, source, "source");
        }
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

    try {
      if (source === "camera") setCameraDevice(deviceId);
      captured = hostAudioRef.current?.attach(captured, source) ?? captured;
      await replaceBrowserStream(captured, generation, token);
    } catch (error) {
      if (isCurrentGeneration(generation)) setNoticeError(error, "source");
    } finally {
      finishSourceSwitch(token);
    }
  }

  function setCaptureError(error: unknown, source: BrowserCaptureSource | undefined, action: "source" | "capture") {
    const target = action === "source" ? "operation" : "television";
    if (source !== "camera") {
      setNoticeError(error, action, target);
      return;
    }
    setNoticeValue({ kind: "key", key: error instanceof DOMException && error.name === "NotAllowedError"
      ? "host.camera.denied" : "host.camera.unavailable", target, comic: "source-failed", tone: "warn" });
  }

  async function changeMicrophone(enabled: boolean, deviceId: string): Promise<void> {
    const audio = hostAudioRef.current;
    const generation = activeGenerationRef.current;
    const client = nativeModeRef.current ? nativeClientRef.current : null;
    const shareId = nativeShareGenerationRef.current;
    if ((!audio && !(client?.health.nativeMedia.microphone && shareId)) || generation === null || sourceSwitchRef.current || qualityChangeRef.current || sharingPausedRef.current) return;
    const token = {};
    sourceSwitchRef.current = token;
    setMicrophonePending(true);
    setNoticeValue(null);
    try {
      if (client && shareId) {
        await client.setMicrophone(shareId, enabled, microphoneVolume, deviceId);
        if (isCurrentGeneration(generation) && nativeClientRef.current === client && sourceSwitchRef.current === token) {
          setMicrophoneDevices(previous => ({ ...previous, native: deviceId }));
        }
        return;
      }
      if (!audio) return;
      audio.setMicrophoneVolume(microphoneVolume);
      const mixed = await audio.setMicrophone(enabled, deviceId);
      if (!isCurrentGeneration(generation) || hostAudioRef.current !== audio) return;
      setMicrophoneDevices(previous => ({ ...previous, browser: deviceId }));
      if (mixed) await replaceBrowserStream(mixed, generation, token);
    } catch (error) {
      if (isCurrentGeneration(generation) && sourceSwitchRef.current === token) {
        debugError("capture", "microphone-failed", error);
        setNoticeValue({ kind: "key", key: error instanceof DOMException && error.name === "NotAllowedError"
          ? "host.microphone.denied" : "host.microphone.unavailable", target: "operation", comic: "warning", tone: "warn" });
      }
    } finally {
      if (sourceSwitchRef.current === token) {
        setMicrophonePending(false);
        finishSourceSwitch(token);
      }
    }
  }

  async function replaceBrowserStream(captured: MediaStream, generation: number, token: object): Promise<void> {
    // The caller retires its operation; this function owns only stream resources.
    const previousStream = streamRef.current;
    if (!previousStream) {
      captured.getTracks().forEach((track) => track.stop());
      setNoticeKey("host.shareEnded", "share-ended", "off");
      return;
    }

    retiringStreamRef.current = previousStream;
    const videoChanged = captured.getVideoTracks()[0] !== previousStream.getVideoTracks()[0];
    // HostAudio owns raw inputs and mixed output. Adding a mixer must not stop
    // the old stream's audio: that track is still feeding the new output.
    const retirePrevious = () => previousStream.getVideoTracks().forEach((track) => {
      if (!captured.getTracks().includes(track)) track.stop();
    });
    if (videoChanged) invalidateSenderQualityEvidence();
    if (videoChanged && routePolicyRef.current.topologyOptimization) {
      signalRef.current?.send({ type: "reset-sender-quality" });
    }
    setMediaPaused(captured, sharingPausedRef.current);
    streamRef.current = captured;
    setStream(captured);
    setDetails(captureDetails(hostAudioRef.current?.sourceStream ?? captured));
    if (videoChanged) watchCaptureEnd(captured, generation);

    try {
      const ingress = nativeMediaIngressRef.current;
      const reboundPeerIds: string[] = [];
      if (ingress) {
        try {
          if (ingress.hasAudio !== (captured.getAudioTracks().length > 0)) {
            const client = nativeClientRef.current;
            if (!client) throw new Error("Native media ingress is unavailable");
            const replacement = new NativeMediaIngress(ingress.shareId, client, () => {
              recoverBrowserFanout(replacement);
            }, () => qualitySettingsRef.current);
            try {
              await replacement.start(captured, qualitySettingsRef.current);
              if (!isCurrentGeneration(generation) || nativeMediaIngressRef.current !== ingress) {
                replacement.dispose();
                return;
              }
              replacement.setPaused(sharingPausedRef.current);
              nativeMediaIngressRef.current = replacement;
            } catch (error) {
              replacement.dispose();
              throw error;
            }
            discardPreparedHostChild();
            for (const [peerId, peer] of peersRef.current) {
              if (!(peer instanceof NativeSenderPeer)) continue;
              removePeer(peerId);
              reboundPeerIds.push(peerId);
            }
            ingress.dispose();
          } else if (!(await ingress.replaceStream(captured))) {
            throw new Error("Native media ingress could not replace its source");
          }
        } catch {
          recoverBrowserFanout(ingress);
        }
      }
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

      const failedPeerIds: string[] = [...reboundPeerIds];
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
      retirePrevious();
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
        videoChanged && isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        const sourceNotice =
          sfuReplaced && sfuWarning && failedPeerIds.length === 0
            ? null
            : sourceSwitchNotice({
                failedPeerCount: failedPeerIds.length,
                sfuReplaced,
              });
        setNotice(
          sourceNotice,
          sourceNotice &&
            (sfuWarning || !sfuReplaced || failedPeerIds.length > 0)
            ? !sfuReplaced ? "connecting-sfu" : "recovering"
            : "hint-switch-source",
          sfuWarning || !sfuReplaced || failedPeerIds.length > 0 ? "warn" : "live",
        );
      }
    } finally {
      retirePrevious();
      if (retiringStreamRef.current === previousStream) {
        retiringStreamRef.current = null;
      }
    }
  }

  async function copyRoomLink(): Promise<void> {
    const activeRoom = roomRef.current;
    const link = includeInviteCredential ? activeRoom?.inviteUrl : activeRoom?.canonicalUrl;
    if (!activeRoom || !link || roomLinkBlocked || roomMutating) {
      return;
    }
    const request = {};
    copyRoomLinkRequestRef.current = request;
    const current = () => copyRoomLinkRequestRef.current === request &&
      isCurrentRoomAuthority(activeRoom) &&
      (includeInviteCredential ? roomRef.current?.inviteUrl : roomRef.current?.canonicalUrl) === link;
    try {
      await navigator.clipboard.writeText(link);
      if (!current()) return;
      setCopiedRoomLink(link);
      setNoticeValue((current) => current?.kind === "key" && current.key === "host.invite.copyFailed" ? null : current);
      // One owner for the confirmation window: a second copy restarts it
      // instead of inheriting the first click's expiry.
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        copiedResetTimerRef.current = null;
        setCopiedRoomLink(null);
      }, 1_500);
    } catch {
      if (!current()) return;
      setCopiedRoomLink(null);
      setNoticeErrorKey("host.invite.copyFailed", "copy-failed");
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
      setNotice(error.message, "access-denied", "bad");
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
      setNoticeValue(null);
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
        roomAdmission(response.codeEntryPolicy, response.viewerPasswordEnabled).comic,
        "live",
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
        response.inviteUrl ? "hint-rotate-invite" : "hint-revoke-invite", "live",
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
      setNoticeErrorKey("host.password.rule", "settings-failed", {
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
        password === null ? "hint-password-remove" : "hint-password", "live",
      );
    } catch (error) {
      handleRoomAccessFailure(error, activeRoom);
    } finally {
      finishRoomMutation(mutation);
    }
  }

  function commitDisplayName(): void {
    const hostFallback = defaultHostDisplayName(vis);
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
    if (signalRef.current && !signalRef.current.setDisplayName(saved)) {
      setNoticeErrorKey("host.nameOffline", "signal-offline", undefined, "warn");
    }
  }

  function joinRoomFromStage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const route = roomRouteForExplicitEntry(joinRoomCode);
    if (!route) {
      setJoinRejectedAttempt(attempt => attempt + 1);
      return;
    }
    window.location.assign(route);
  }

  const activeCodeEntryPolicy = room?.codeEntryPolicy ?? null;
  const hostPeerId = hostPresence?.peerId ?? hostPeerIdRef.current;
  // One identity for the Host body everywhere (couch, name tag, topology) so
  // the pawn is not recoloured per surface while the peer id is still pending.
  const hostIdentity = hostPeerId ?? hostClientIdRef.current ?? "host-pending";

  const couchEntries: CouchEntry[] = viewers.map((viewer) => {
    return {
      key: viewer.peerId,
      name: viewer.label,
      status: deriveParticipantStatus(viewer, phase === "live", viewerQualityEvidence.get(viewer.peerId)),
    };
  });

  type ViewerDetail = {
    route: "p2p" | "sfu" | null;
    metrics: ConnectionMetrics | null;
    direction: "send" | "receive";
    tag?: { icon: "loader"; label: string };
    error: MediaFailure | null;
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
      tag: hasCommittedMedia
        ? undefined
        : {
            icon: "loader",
            label: t(
              viewer.upstream.kind === "none"
                ? "state.peer.routing"
                : "state.peer.connecting",
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
        route: detail?.route ?? null,
        metrics: detail?.metrics ?? null,
      };
    },
  );
  const hostDiagnosticsAvailable = Boolean(
    (details && (stream || nativeActive)) || viewerOverviewEntries.length > 0,
  );

  const noticeText = noticeValue
    ? noticeValue.kind === "text"
      ? noticeValue.text
      : t(noticeValue.key, noticeValue.vars)
    : null;
  const hostSfuWarningText = resolveMediaFailure(hostSfuQualityWarning, copy);

  const statusNotice = noticeValue?.target === "television" ? noticeValue : null;
  const hostStatus = deriveHostStatus({
    phase,
    paused: sharingPaused,
    signal: signalStatus,
    roomReady: Boolean(room),
    sourceNotice: statusNotice ? { tone: statusNotice.tone, tooltip: statusNotice.comic } : undefined,
  });
  // Startup and termination reasons refine the source status. Independent
  // operation results may coexist with it; wording is not a status identity.
  const titleContent = titleFrames(hostStatus.titleFrameKey);
  useDocumentTitle([room?.roomId, titleContent.label, hostStatus.titleMarker], titleContent.variations,
    `${lang}:${vis}:${hostStatus.titleFrameKey}:${room?.roomId ?? ""}`);

  return (
    <div className="lr-app">
      <AppHeader
        led={
          <LedStrip
            state={hostStatus.connection.tone}
            label={t(hostStatus.connection.labelKey)}
            comic={hostStatus.connection.comic}
          />
        }
      />

      <main className="lr-room">
        <h1 className="visually-hidden">
          {t("host.title", { name: hostPresence?.displayName ?? displayName })}
        </h1>
        <div className="lr-scene">
          <StageTv
            live={phase === "live"}
            hasEntry={
              phase === "idle" || phase === "ended" || phase === "error"
            }
            label={t("host.stageAria")}
            indicator={<StatusIndicator status={hostStatus.television}
              label={statusNotice ? noticeText ?? undefined : undefined} />}
          >
            {stream ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : null}
            {nativeSources ? (
              <CaptureSourcePicker
                nativeSources={nativeSources}
                onBrowser={() => startBrowserShareFromPicker("browser")}
                onCamera={deviceId => startBrowserShareFromPicker("camera", deviceId)}
                initialCamera={cameraDevice}
                activeCameraVideo={hostAudioRef.current?.sourceKind === "camera" ? videoRef.current : null}
                onNative={startNativeShareFromPicker}
                onPreview={loadNativeSourcePreview}
                onRefresh={openCaptureSourcePicker}
                onCancel={closeCaptureSourcePicker}
                browserAvailable={!nativeActive && !!navigator.mediaDevices?.getDisplayMedia}
                cameraAvailable={!nativeActive && !!navigator.mediaDevices?.getUserMedia}
                selectionDisabled={roomMutating || switchingSource || changingQuality}
                initialAudio={
                  nativeActive
                    ? nativeSourceAudioRef.current ?? false
                    : true
                }
                audioLocked={nativeActive && !nativeClientRef.current?.health.nativeMedia.microphone}
                initialShowCaptureBorder={showCaptureBorder}
              />
            ) : !stream &&
              (phase === "idle" || phase === "ended" || phase === "error") ? (
              <div className="lr-tv-overlay">
                {phase === "idle" ? <WelcomeLine /> : null}
                <div className="lr-entry-actions">
                  <span className="lr-entry-action">
                    <Tooltip kind="hint-share-start" text={vis ? undefined : t("host.start")} align="start">
                      <button
                        id="host-start-share"
                        type="button"
                        className="lr-tv-big is-action is-ripple"
                        aria-label={t("host.start")}
                        disabled={roomMutating}
                        onClick={requestSharing}
                      >
                        <Glyph name="cast" size={34} draw="entry-cast" />
                      </button>
                    </Tooltip>
                    {vis ? null : (
                      <span className="lr-tv-msg">{t("host.start")}</span>
                    )}
                  </span>
                  <span className="lr-entry-action">
                    <Tooltip kind={joiningRoom ? "hint-collapse" : "hint-join-go"} text={vis ? undefined : t(joiningRoom ? "host.join.hide" : "host.join")} align="end">
                      <button
                        type="button"
                        className="lr-tv-big"
                        aria-label={t(joiningRoom ? "host.join.hide" : "host.join")}
                        aria-expanded={joiningRoom}
                        aria-controls="host-room-code-entry"
                        onClick={() => setJoiningRoom((current) => !current)}
                      >
                        <Glyph name="door" size={30} draw="entry-door" />
                      </button>
                    </Tooltip>
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
                    {!vis && <span className="lr-cap lr-join-site">{t("join.hint", { site: window.location.host })}</span>}
                    <RoomCodeInput value={joinRoomCode} rejectedAttempt={joinRejectedAttempt} autoFocus
                      onChange={value => { setJoinRoomCode(value); setJoinRejectedAttempt(0); }} />
                    <RoomCodeError attempt={joinRejectedAttempt} theme="stage" />
                    <Tooltip kind="hint-join-go" text={vis ? undefined : t("join.submit")}>
                      <button
                        className="lr-join-go"
                        type="submit"
                        aria-label={t("join.submit")}
                        disabled={joinRoomCode.length !== 4}
                      >
                        <Glyph name="arrowRight" size={24} />
                      </button>
                    </Tooltip>
                  </form>
                ) : null}
              </div>
            ) : null}
            {/* The picker owns the stage while it is open: a state overlay
                painted after it would cover and swallow its controls. */}
            {nativeSources ? null : switchingSource ? (
              <StageOverlay
                icon="refresh"
                comic="source-switching"
                tone="busy"
                waiting
                dim
                message={t("host.switchingSource")}
              />
            ) : sharingPaused ? (
              <StageOverlay icon="pause" dim comic="host-paused" tone={hostStatus.activity.tone} message={t("host.pauseNotice")} />
            ) : phase === "starting" ? (
              <>
                <StaticNoise />
                <StageOverlay icon="cast" comic="source-starting" tone="busy" waiting message={t("host.starting")} />
              </>
            ) : stream && localPreviewPaused ? (
              <StageOverlay
                icon="eyeOff"
                comic="preview-paused"
                tone="warn"
                dim
                message={t("host.localPreviewPaused")}
              />
            ) : null}
          </StageTv>
          <div className="lr-host-share-controls lr-media-controls" role="group" aria-label={t("host.shareControls")}>
            {phase === "live" ? <>
              <HostMicrophone enabled={microphoneEnabled} pending={microphonePending}
                unavailable={nativeActive && !nativeClientRef.current?.health.nativeMedia.microphone} paused={sharingPaused} disabled={switchingSource || changingQuality}
                volume={microphoneVolume}
                onToggle={() => void changeMicrophone(!microphoneEnabled, microphoneDevices[nativeActive ? "native" : "browser"])} />
              <Btn
                icon={sharingPaused ? "play" : "pause"}
                cap={sharingPaused ? "host.resume" : "host.pause"}
                title={sharingPaused ? "host.resume" : "host.pause"}
                hint={sharingPaused ? "hint-resume" : "hint-pause"}
                draw="host-share-toggle"
                disabled={switchingSource || changingQuality || microphonePending}
                onClick={toggleSharingPause}
              />
              <Btn
                id="host-switch-source"
                icon="switchSource"
                cap={switchingSource ? "host.switching" : "host.switchSource"}
                title="host.switchSource"
                hint="hint-switch-source"
                disabled={switchingSource || changingQuality || microphonePending}
                onClick={() => void switchSource()}
              />
            </> : null}
            <Btn
              icon="sliders"
              busy={changingQuality}
              cap="host.settings.button"
              title={showAdvanced ? "host.advanced.hide" : "host.advanced"}
              hint={showAdvanced ? "hint-collapse" : "hint-advanced"}
              tone={showAdvanced ? "on" : undefined}
              expanded={showAdvanced}
              controls="host-advanced-door"
              onClick={() => setShowAdvanced((current) => !current)}
            />
            {phase === "live" ? (
              <Btn
                id="host-stop-share"
                icon="stop"
                tone="danger"
                cap="host.stop"
                title="host.stop"
                hint="hint-share-stop"
                onClick={() => endSharing({ key: "host.stopNotice" })}
              />
            ) : phase === "starting" ? (
              <Btn
                id="host-cancel-share"
                icon="x"
                tone="danger"
                cap="host.cancelStart"
                title="host.cancelStart"
                hint="hint-close"
                onClick={() => endSharing({ key: "host.startCancelled" })}
              />
            ) : null}
          </div>
          <div className="lr-stage-notices" role="status" aria-live="polite">
            {details?.hasSourceAudio === false && stream ? (
              <Pill icon="speakerOff" label={t("host.noAudio")} comic="no-audio" tone="off" />
            ) : null}
            {hostSfuWarningText ? (
              <Pill icon="alert" label={hostSfuWarningText} comic="warning" />
            ) : null}
            {noticeValue?.target === "operation" && noticeText ? (
              <Pill icon={noticeValue.tone === "live" ? "check" : noticeValue.tone === "off" ? "stop" : "alert"}
                tone={noticeValue.tone} label={noticeText} comic={noticeValue.comic}
                motion={noticeValue.comic === "signal-recovering" || noticeValue.comic === "recovering" || noticeValue.comic === "connecting-sfu" ? "progress" : "still"} />
            ) : null}
          </div>
          <SharingSettings id="host-advanced-door" open={showAdvanced} busy={changingQuality}
            presets={
              <QualityPresets selected={selectedQualityProfileId} busy={changingQuality}
                disabled={phase === "starting" || switchingSource}
                onSelect={id => void changeQuality({ ...QUALITY_PROFILES[id],
                  screenAudioQuality: resolveScreenAudioQuality(advancedQualityRef.current.screenAudioQuality),
                })} />
            }
            picture={<>
              <div className="lr-door-group">
                <span
                  className="lr-door-glyph"
                >
                  <Glyph name="expand" size={19} />
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
              <div className="lr-sharing-limits">
                <div className="lr-door-group">
                  <span
                    className="lr-door-glyph"
                  >
                    <Glyph name="frames" size={19} />
                    <Cap k="host.advanced.framerate" />
                  </span>
                  <Tooltip kind="hint-metric-fps" text={vis ? undefined : t("host.advanced.framerate")} className="lr-slider-hint">
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
                    </Tooltip>
                </div>
                <div className="lr-door-group">
                  <span
                    className="lr-door-glyph"
                  >
                    <Glyph name="gauge" size={19} />
                    <Cap k="host.advanced.bitrate" />
                  </span>
                  <Tooltip kind="hint-metric-bitrate" text={vis ? undefined : t("host.advanced.bitrate")} className="lr-slider-hint">
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
                    </Tooltip>
                </div>
              </div>
              <div className="lr-door-group">
                <span
                  className="lr-door-glyph"
                >
                  <Glyph name="mountain" size={19} />
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
                      disabled={phase === "starting" || switchingSource}
                      title={`${t(DEGRADATION_PREFERENCE_KEYS[preference])} · ${t(PREFERENCE_PRESENTATION[preference].hint)}`}
                      hint={preference === "maintain-resolution" ? "hint-prefer-resolution" : preference === "maintain-framerate" ? "hint-prefer-framerate" : "hint-degrade-pref"}
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
                      <Cap k={DEGRADATION_PREFERENCE_KEYS[preference]} />
                    </Chip>
                  ))}
                </div>
              </div>
            </>}
            audio={<>
              {phase === "live" && (!nativeActive || nativeClientRef.current?.health.nativeMedia.microphone) ? (
                <HostMicrophoneSettings enabled={microphoneEnabled}
                disabled={microphonePending || switchingSource || changingQuality || sharingPaused}
                  volume={microphoneVolume} onVolume={volume => {
                    setMicrophoneVolume(volume);
                    hostAudioRef.current?.setMicrophoneVolume(volume);
                    const client = nativeClientRef.current;
                    const shareId = nativeShareGenerationRef.current;
                    if (nativeModeRef.current && client && shareId) {
                      void client.setMicrophoneVolume(shareId, volume).catch(error => {
                        if (nativeClientRef.current === client && nativeShareGenerationRef.current === shareId) {
                          debugError("capture", "microphone-volume-failed", error);
                          setNoticeValue({ kind: "key", key: "host.microphone.unavailable", target: "operation", comic: "warning", tone: "warn" });
                        }
                      });
                    }
                  }}
                  native={nativeActive} loadDevices={loadMicrophones}
                  deviceId={microphoneDevices[nativeActive ? "native" : "browser"]}
                  onDevice={deviceId => void changeMicrophone(microphoneEnabled, deviceId)}
                />
              ) : null}
              <div className="lr-door-group">
                <span
                  className="lr-door-glyph"
                >
                  <Glyph name="speaker" size={19} />
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
            </>}
            technical={<>
              <div className="lr-door-group">
                <span
                  className="lr-door-glyph"
                >
                  <Glyph name="branch" size={19} />
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
                    checked={routePolicy.natPrediction}
                    disabled={
                      !natPredictionAvailable || phase === "starting" || phase === "live"
                    }
                    locked={!natPredictionAvailable}
                    onChange={(checked) =>
                      changeRoutePolicy({ natPrediction: checked })
                    }
                    label={t("host.advanced.route.natPrediction")}
                    note={t(
                      natPredictionAvailable
                        ? "host.advanced.route.natPredictionHint"
                        : "host.advanced.route.natPredictionUnavailable",
                    )}
                    hint={
                      natPredictionAvailable ? "hint-nat-prediction" : "hint-nat-unavailable"
                    }
                  />
                  <SwitchItem
                    checked={routePolicy.peerOnly}
                    disabled={
                      !sfuAvailable || phase === "starting" || phase === "live"
                    }
                    locked={!sfuAvailable}
                    onChange={(checked) =>
                      changeRoutePolicy({ peerOnly: checked })
                    }
                    label={t("host.advanced.route.peerOnly")}
                    note={t(
                      sfuAvailable
                        ? "host.advanced.route.peerOnlyHint"
                        : "host.advanced.route.peerOnlyRequired",
                    )}
                    hint={sfuAvailable ? "hint-route-p2p" : "hint-route-p2p-required"}
                  />
                </div>
              </div>
              <div className="lr-door-group">
                <span
                  className="lr-door-glyph"
                >
                  <Glyph name="puzzle" size={19} />
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
            </>}
          />
          <Couch
            view="host"
            host={{
              key: hostIdentity,
              name: labeledHostPresence?.label ?? displayName,
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
                    <Btn
                      icon="x"
                      title="host.nameCancel"
                      hint="hint-close"
                      onClick={() => {
                        setDisplayNameDraft(displayName);
                        setDisplayNameError(null);
                        setEditingDisplayName(false);
                      }}
                    />
                  </form>
                ) : (
                  <>
                    <NameTag
                      name={displayName}
                      identity={hostIdentity}
                    />
                    <Btn
                      icon="pencil"
                      cap="common.edit"
                      title="host.nameEdit"
                      hint="hint-rename"
                      onClick={() => {
                        setDisplayNameDraft(displayName);
                        setDisplayNameError(null);
                        setEditingDisplayName(true);
                      }}
                    />
                  </>
                )}
                {displayNameError ? (
                  <Pill
                    icon="alert"
                    tone="bad"
                    label={displayNameError}
                    alert
                    comic="name-invalid"
                  />
                ) : null}
              </div>
              <div className="lr-row-group lr-group-actions lr-host-diagnostics-slot">
                <Btn
                  icon="gauge"
                  cap="host.details"
                  title={
                    showConnectionDetails
                      ? "host.details.hide"
                      : "host.details"
                  }
                  hint={showConnectionDetails ? "hint-collapse" : "hint-details"}
                  tone={showConnectionDetails ? "on" : undefined}
                  expanded={showConnectionDetails}
                  controls="host-details-panel host-viewer-overview"
                  disabled={!hostDiagnosticsAvailable}
                  onClick={() =>
                    setShowConnectionDetails((current) => !current)
                  }
                />
                <Btn
                  icon="network"
                  cap="host.topology"
                  title={
                    showTopology
                      ? "host.topology.hide"
                      : "host.topology.show"
                  }
                  hint={showTopology ? "hint-collapse" : "hint-topology"}
                  tone={showTopology ? "on" : undefined}
                  expanded={showTopology}
                  controls="room-topology"
                  onClick={() => setShowTopology((current) => !current)}
                />
              </div>

            </div>
          </Row>

          {room ? (
            <Row label={t("host.policy")}>
              <RowGroup actions>
                <Btn
                  icon={copied ? "check" : "link"}
                  cap="common.copy"
                  title={copied ? "common.copied" : roomLinkBlocked ? "host.invite.credentialRequired"
                    : includeInviteCredential ? "host.invite.copy" : "host.invite.copyAddress"}
                  hint={roomLinkBlocked ? "hint-policy-private" : "hint-copy-invite"}
                  hintTone={copied ? "live" : roomLinkBlocked ? "warn" : undefined}
                  hintMotion={copied ? "still" : undefined}
                  disabled={!roomLink || roomMutating || roomLinkBlocked}
                  onClick={() => void copyRoomLink()}
                />
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
              <div className="lr-invite-field">
                {roomLink ? (
                  <Tooltip kind="hint-invite-link" text={roomLink} className="lr-invite-hint">
                    <input
                      className="lr-invite-url"
                      type="text"
                      dir="ltr"
                      value={roomLink}
                      readOnly
                      spellCheck={false}
                      aria-label={t(includeInviteCredential ? "host.invite" : "host.invite.address")}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </Tooltip>
                ) : null}
                <span className="lr-row-group">
                  <Glyph name="key" size={17} />
                  <SwitchItem checked={includeInviteCredential} disabled={roomMutating}
                    label={t("host.invite.includeCredential")} hint="hint-invite-link"
                    note={t("host.invite.credentialHint")}
                    onChange={checked => {
                      copyRoomLinkRequestRef.current = null;
                      setCopiedRoomLink(null);
                      setIncludeInviteCredential(checked);
                    }} />
                </span>
              </div>
              {roomLinkBlocked ? <Pill icon="lock" tone="warn" comic="hint-policy-private"
                label={t("host.invite.credentialRequired")} /> : null}
              <span className="lr-divider" aria-hidden="true" />
              <RowGroup>
                <span
                  className="lr-toggle"
                  role="group"
                  aria-label={t("host.policy")}
                  data-selected={activeCodeEntryPolicy}
                >
                  <Tooltip kind="hint-admission-code"
                    text={vis ? undefined : `${t("host.policy.open")} · ${t("host.policy.openHint")}`}>
                    <button
                      type="button"
                      className={
                        activeCodeEntryPolicy === "open" ? "is-selected" : undefined
                      }
                      aria-label={t("host.policy.open")}
                      aria-pressed={activeCodeEntryPolicy === "open"}
                      disabled={roomMutating}
                      onClick={() => void changeCodeEntryPolicy("open")}
                    >
                      <Glyph name="globe" size={19} />
                      <Cap k="host.policy.open" />
                    </button>
                  </Tooltip>
                  <Tooltip kind="hint-policy-private"
                    text={vis ? undefined : `${t("host.policy.private")} · ${t(viewerPasswordEnabled ? "host.policy.privatePasswordHint" : "host.policy.privateHint")}`}>
                    <button
                      type="button"
                      className={
                        activeCodeEntryPolicy === "private"
                          ? "is-selected"
                          : undefined
                      }
                      aria-label={t("host.policy.private")}
                      aria-pressed={activeCodeEntryPolicy === "private"}
                      disabled={roomMutating}
                      onClick={() => void changeCodeEntryPolicy("private")}
                    >
                      <Glyph name="lock" size={19} />
                      <Cap k="host.policy.private" />
                    </button>
                  </Tooltip>
                </span>
                {activeCodeEntryPolicy === "private" ? (
                  <Tooltip kind={passwordOpen ? "hint-collapse" : "hint-password"} align="end"
                    text={vis ? undefined : `${t(passwordOpen ? "host.password.settingsHide" : "host.password.setAction")} · ${t(viewerPasswordEnabled ? "host.password.set" : "host.password.unset")}`}>
                    <button
                      type="button"
                      className="lr-btn"
                      aria-label={t(passwordOpen ? "host.password.settingsHide" : "host.password.setAction")}
                      aria-expanded={passwordOpen}
                      aria-controls="host-password-form"
                      onClick={() => setPasswordOpen((current) => !current)}
                    >
                      <Glyph name="key" size={19} />
                      {viewerPasswordEnabled ? (
                        <i className="lr-chip-dot" aria-hidden="true" />
                      ) : null}
                      <Cap k="join.password" />
                    </button>
                  </Tooltip>
                ) : null}
                {!room.inviteUrl && activeCodeEntryPolicy !== null ? (
                  <Pill
                    icon="link"
                    label={t(
                      activeCodeEntryPolicy === "open"
                        ? "host.invite.emptyOpen"
                        : viewerPasswordEnabled
                          ? "host.invite.emptyPassword"
                          : "host.invite.emptyPrivate",
                    )}
                    comic="hint-invite-link"
                    tone="off"
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
                      className="lr-input is-password"
                      style={{ flex: 1 }}
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
                        hint={viewerPasswordVisible ? "hint-password-hide" : "hint-password-show"}
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
                        hint="hint-password-remove"
                        disabled={roomMutating}
                        onClick={() => void changeViewerPassword(null)}
                      />
                    ) : null}
                  </form>
                </RowGroup>
              ) : null}
            </Row>
          ) : null}

          {showConnectionDetails && details && (stream || nativeActive) ? (
            <Row sub>
              <div id="host-details-panel" style={{ display: "contents" }}>
                <span
                  className="lr-meter-tag"
                >
                  <Glyph name="share" size={17} />
                  {vis ? null : (
                    <span className="lr-cap">{t("stats.capture")}</span>
                  )}
                </span>
                <div
                  className="lr-meter"
                  role="group"
                  aria-label={t("host.captureAria")}
                >
                  <MetricCell label="stats.resolution" value={details.resolution ?? t("stats.unknown")} />
                  <MetricCell label="stats.fps" value={details.frameRate ? `${details.frameRate.toFixed(0)} fps` : vis ? "—" : t("host.capture.fpsUnknown")} />
                  <MetricCell label="stats.codec" value={resolvedVideoCodec?.toUpperCase() ?? (vis ? "—" : t("host.capture.codecPending"))} />
                  <Tooltip toggleOnClick kind={details.hasSourceAudio ? "hint-source-audio" : "no-audio"}
                    text={vis ? undefined : t(details.hasSourceAudio ? "host.capture.hasAudio" : "host.capture.noAudio")}
                    tone="off">
                    <button type="button" className="lr-meter-cell"
                      style={{ border: 0, color: "inherit", font: "inherit", textAlign: "start" }}
                      aria-label={t(details.hasSourceAudio ? "host.capture.hasAudio" : "host.capture.noAudio")}>
                      <Glyph name={details.hasSourceAudio ? "speaker" : "speakerOff"} size={16} />
                      {!vis && <b>{t(details.hasSourceAudio ? "host.capture.hasAudio" : "host.capture.noAudio")}</b>}
                    </button>
                  </Tooltip>
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
                hostIdentity={hostIdentity}
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
        </div>
      </main>
    </div>
  );
}
