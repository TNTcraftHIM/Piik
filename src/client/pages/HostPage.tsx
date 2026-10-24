import { stopUserMediaTrack } from "../media/user-media";
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
import { AppHeader, LedStrip } from "../components/living/Header";
import { WelcomeLine } from "../components/living/WelcomeLine";
import type { CouchEntry } from "../components/living/Couch";
import { SharingSettings } from "../components/living/SharingSettings";
import { HostShareControls } from "../components/living/HostShareControls";
import { LiveAudioExclusion } from "../components/living/AudioExclusionSelect";
import { RoomInteractions } from "../components/living/RoomInteractions";
import { RoomChatOverlay, RoomChatOverlaySettings, RoomChatToggle } from "../components/living/RoomChatOverlay";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { useTheaterMode } from "../components/living/use-theater-mode";
import { useHostPreviewPlayback } from "../components/living/use-host-preview-playback";
import { readRoomPreferences, saveRoomPreferences } from "../lib/room-preferences";
import type { VideoFit } from "../media/video-geometry";
import type { RoomInteractionSession } from "../lib/room-interactions";
import type { RoomVoiceSession } from "../room-voice/session";
import { useRoomVoiceMetrics, useRoomVoiceSnapshot } from "../room-voice/use-room-voice-state";
import { describeVoiceConnection, voiceConnectionDetails } from "../room-voice/VoiceConnectionDetails";
import { RoomVoicePanel, RoomVoiceControls, RoomVoiceSettings } from "../room-voice/RoomVoicePanel";
import { HostAudio } from "../media/host-audio";
import { browserCaptureDevices } from "../media/capture-devices";
import { ShareMicrophoneSettings } from "../components/living/ShareMicrophoneSettings";
import {
  CaptureSourcePicker,
  nativeAppDetected,
  type NativeSourceList,
} from "../components/living/CaptureSourcePicker";
import { PawnDetail } from "../components/living/PawnDetail";
import {
  RoomAdmissionBadge,
  roomAdmission,
  RoomChip,
  RoomCodePlaceholder,
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
import { AudioBitrateControl, PicturePreferenceControl, PictureSettingsSummary, QualityPresets, ResolutionControl, VideoRateControls } from "../components/living/QualityPresets";
import { RoomCodeInput, RoomCodeError } from "../components/living/RoomCodeInput";
import { CaptureMetricCells } from "../components/living/Metrics";
import { ConnectionDetails } from "../components/living/ConnectionDetails";
import {
  StageOverlay,
  StageTv,
  StaticNoise,
} from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { ShareFailureHelp } from "../components/living/ShareFailureHelp";
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
import { Glyph } from "../ui/icons";
import { say, useCopy, type CopyKey } from "../ui/copy";
import { resolveMediaFailure, type MediaFailure } from "../ui/media-failure";
import {
  ApiError,
  getRuntimeCapabilities,
  createRoom,
  replaceOwnedRoom,
  updateRoomAccess,
} from "../lib/api";
import {
  readCreationProfile,
  saveCreationProfile,
  type HostCreationProfile,
} from "../lib/creation-profile";
import { readPreferredQuality, savePreferredQuality } from "../lib/quality-preference";
import { AppQualityPreference } from "../native/quality-preference";
import { createOpaqueId } from "../lib/opaque-id";
import { debugError, debugEvent, debugOperation } from "../lib/debug";
import { observeDebugPlayback } from "../lib/debug-webrtc";
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
  isClientActivated,
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
  videoCaptureLimits,
  captureFramerateCeiling,
  supportsCaptureProfile,
  qualityResolutionEqual,
  qualitySettingsEqual,
  qualitySettingsLabel,
  screenAudioBitrate,
  MAX_AUDIO_SEND_BITRATE,
  setMediaPaused,
  videoQualitySettingsEqual,
  type QualitySettings,
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
import { NativeClient, NativeCompatibilityError, NativeRequestError } from "../native/client";
import { NativeClientConnection } from "../native/client-connection";
import {
  NativeSenderPeer,
  shouldUseBrowserQualityCandidate,
} from "../native/native-sender-peer";
import { NativeSfuPublisher } from "../native/native-sfu-publisher";
import { SfuPublisher } from "../sfu/publisher";
import { NativeMediaBridge, NativeMediaBridgeError } from "../native/media-bridge";
import { NativeMediaIngress } from "../native/media-ingress";
import {
  defaultNativeCapturePath,
  nativeCaptureTargetKey,
  type NativeCapturePath,
} from "../native/capture-selection";
import type { NativeCaptureTarget, RemoteControlState } from "../native/wire";
import { HostRemoteControl } from "../components/living/HostRemoteControl";
import { InputRoute } from "../remote-control/input-route";
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
  hostActionErrorKey,
  hostServerErrorKey,
  sourceSwitchNotice,
  isCapturePermissionFailure,
  hostFailureCode,
  hostFailureChecks,
  type HostAction,
} from "./host-page-notices";

type NoticeValue = (
  | { kind: "text"; text: string }
  | { kind: "key"; key: CopyKey; vars?: Record<string, string> }
) & {
  target: "television" | "operation";
  comic: ComicKind | HintKind;
  tone: ComicTone;
  failureCode?: string;
};

type StatusNoticeMessage = string | { key: CopyKey; vars?: Record<string, string>; failureCode?: string };

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
    hasSourceAudio: sourceAudio ?? stream.getAudioTracks().some(track => track.readyState === "live"),
  };
}

function readableError(error: unknown, action: HostAction): StatusNoticeMessage {
  return error instanceof ApiError
    ? error.message
    : { key: hostActionErrorKey(error, action) };
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
  roomInteractionsAvailable?: boolean;
  roomReactionIds?: readonly string[];
  hostRoomSessionAvailable?: boolean;
  sfuAvailable?: boolean;
  sfuOnly?: boolean;
  natPredictionAvailable?: boolean;
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
      excludeAudio?: NativeCaptureTarget;
      showCaptureBorder: boolean;
      path: NativeCapturePath;
    };

export function HostPage({
  roomInteractionsAvailable = false,
  roomReactionIds,
  hostRoomSessionAvailable = false,
  sfuAvailable = false,
  sfuOnly = false,
  natPredictionAvailable = false,
  launchedByClient = false,
  onAuthorizationRequired,
}: HostPageProps = {}) {
  const copy = useCopy();
  const { lang, vis, t, titleFrames } = copy;
  const [qualitySettings, setQualitySettings] = useState<QualitySettings>(
    readPreferredQuality,
  );
  const [advancedQuality, setAdvancedQuality] = useState<QualitySettings>(
    qualitySettings,
  );
  const [routePolicy, setRoutePolicy] = useState<RoutePolicy>(
    () => ({
      ...DEFAULT_ROUTE_POLICY,
      peerOnly: !sfuAvailable,
      topologyOptimization: !sfuOnly,
      natPrediction: natPredictionAvailable && !sfuOnly,
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
  const [shareVolume, setShareVolume] = useState({ level: 1, muted: false });
  const shareVolumeChangeRef = useRef<object | null>(null);
  const audioAvailableRef = useRef(false);
  const [commentary, setCommentary] = useState(false);
  const [commentaryBusy, setCommentaryBusy] = useState(false);
  const [commentaryInput, setCommentaryInput] = useState({ deviceId: "", volume: 1, voiceProcessing: true });
  const commentaryOperationRef = useRef<object | null>(null);
  const [interactionSession, setInteractionSession] = useState<RoomInteractionSession | null>(null);
  const [roomVoiceSession, setRoomVoiceSession] = useState<RoomVoiceSession | null>(null);
  const roomVoiceSnapshot = useRoomVoiceSnapshot(roomVoiceSession);
  const roomVoice = roomVoiceSnapshot?.connected ? roomVoiceSnapshot.room : null;
  const ownVoiceConnection = describeVoiceConnection(roomVoiceSnapshot);
  const [cameraDevice, setCameraDevice] = useState("");
  const [nativeActive, setNativeActive] = useState(false);
  const [remoteControlState, setRemoteControlState] = useState<RemoteControlState | null>(null);
  const remoteStopShortcut = useCallback(async (key?: number) => {
    const client = nativeConnection.current;
    const shareId = nativeShareGenerationRef.current;
    if (!client || !shareId) throw new Error("Native share is unavailable");
    return client.remoteStopShortcut(shareId, key);
  }, []);
  const remoteInputPeersRef = useRef<Extract<ServerMessage, { type: "remote-input-peers" }>["peers"]>([]);
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
  useEffect(() => {
    let active = true;
    if (hostRoomSessionAvailable && room) void roomInitializationRef.current.then(() => {
      if (active && isCurrentRoomAuthority(room)) connectRoomSignal(room).start();
    });
    return () => { active = false; };
  }, [hostRoomSessionAvailable, room?.roomId, room?.hostToken]);
  const [creationProfile, setCreationProfile] =
    useState<HostCreationProfile>(readCreationProfile);
  const creationProfileRef = useRef(creationProfile);
  const [roomMutation, setRoomMutation] = useState<
    "access" | "replacement" | "sharing" | "creation" | null
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
  const [displayNameError, setDisplayNameError] = useState(false);
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
  function setStatusNotice(
    message: StatusNoticeMessage,
    comic: ComicKind,
    tone: ComicTone,
  ): void {
    setNoticeValue({
      ...(typeof message === "string"
        ? { kind: "text", text: message }
        : { kind: "key", ...message, vars: message.vars }),
      target: "television",
      comic,
      tone,
    });
  }
  function setNoticeError(
    error: unknown,
    action: HostAction,
    target: NoticeValue["target"] = "operation",
  ): void {
    if (error instanceof NativeMediaBridgeError || (error instanceof NativeRequestError &&
      (["unavailable", "disconnected", "send-failed"].includes(error.reason) || error.operation === "prepare-edge"))) action = "connection";
    const permissionMissing = isCapturePermissionFailure(error, action);
    const message = readableError(error, action);
    setNoticeValue({ ...(typeof message === "string" ? { kind: "text", text: message } : { kind: "key", ...message }),
      target, tone: permissionMissing ? "warn" : "bad",
      failureCode: error instanceof ApiError ? `site/http-${error.status}` : hostFailureCode(error, action),
      comic: permissionMissing ? "hint-capture-browser" : action === "connection" ? "route-failed" : action === "capture" || action === "source"
        ? "source-failed" : action === "quality" || action === "sourceAudio" ? "settings-failed" : "warning" });
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
  const [previewAutoPause, setPreviewAutoPause] = useState(() => readRoomPreferences().previewAutoPause);
  const [theaterMode, setTheaterMode] = useTheaterMode();
  const [pictureFit, setPictureFit] = useState<VideoFit>(() => readRoomPreferences().pictureFit);
  const [pictureRotation, setPictureRotation] = useState(() => readRoomPreferences().pictureRotation);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [selectedPawn, setSelectedPawn] = useState<string | null>(null);
  const voiceMetrics = useRoomVoiceMetrics(roomVoiceSession, showConnectionDetails || selectedPawn !== null, roomVoice);
  const [joinRoomCode, setJoinRoomCode] = useState("");
  const [joinRejectedAttempt, setJoinRejectedAttempt] = useState(0);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
  const sourceSwitchRef = useRef<{ replacingVideo?: MediaStreamTrack; audioOnly?: boolean } | null>(null);
  const qualityChangeRef = useRef<object | null>(null);
  const pendingQualityChangeRef = useRef<QualitySettings | null>(null);
  const qualitySettingsRef = useRef<QualitySettings>(qualitySettings);
  const appQualityPreferenceRef = useRef<AppQualityPreference | null>(null);
  const qualityPreferenceEditedRef = useRef(false);
  const pendingAppQualityPreferenceRef = useRef<QualitySettings | null>(null);
  const routePolicyRef = useRef<RoutePolicy>(routePolicy);
  const advancedQualityRef = useRef<QualitySettings>(advancedQuality);
  const videoCodecModeRef = useRef<BrowserVideoCodecMode>(videoCodecMode);
  const roomMutationRef = useRef<object | null>(null);
  const videoCodecRef = useRef<BrowserVideoCodecPreference>(
    VP8_ONLY_VIDEO_CODEC,
  );
  const codecProbeAbortRef = useRef<AbortController | null>(null);
  const sharingPausedRef = useRef(false);
  const sharingPauseOperationRef = useRef<object | null>(null);
  const retiringStreamRef = useRef<MediaStream | null>(null);
  const hostSfuRouteRef = useRef<HostSfuRoute | null>(null);
  const [nativeConnection] = useState(() => new NativeClientConnection(connectNativeClient, handleNativeClientClosed));
  const nativeShareGenerationRef = useRef<string | null>(null);
  const serverShareGenerationRef = useRef<string | null>(null);
  const nativeMediaBridgeRef = useRef<NativeMediaBridge | null>(null);
  const nativeInputRoute = useMemo(() => new InputRoute(() => {}), []);
  const nativeMediaIngressRef = useRef<NativeMediaIngress | null>(null);
  const nativeEventCleanupRef = useRef<(() => void) | null>(null);
  const nativeModeRef = useRef(false);
  const nativeSourceAudioRef = useRef<boolean | undefined>(undefined);
  const nativeSourceSelectionRef = useRef<Extract<ShareSourceSelection, { kind: "native" }> | null>(null);
  const loadAudioApplications = useCallback(async () => {
    const client = nativeConnection.current;
    if (!client || !nativeModeRef.current) throw new Error("Piik App is unavailable");
    return client.sources();
  }, []);
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
    if (!launchedByClient) return;
    const controller = new AbortController();
    void loadAppQualityPreference(controller.signal).catch(error => {
      if (!controller.signal.aborted) debugError("native", "quality-preference-load-failed", error);
    });
    return () => {
      controller.abort();
      appQualityPreferenceRef.current = null;
    };
  }, [launchedByClient]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
    if (!stream) {
      setTheaterMode(false);
    }
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!stream || !video) return;
    return observeDebugPlayback(video, {
      role: "host-preview", generation: activeGenerationRef.current,
      source: nativeModeRef.current ? "native" : "browser",
    });
  }, [stream]);

  const previewPlayback = useHostPreviewPlayback(videoRef, stream, previewAutoPause);

  useEffect(() => {
    if (!stream) return;
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
    const syncSenderQualityAuthority = () => {
      if (document.visibilityState !== "visible") {
        resetSenderQualityAuthority();
      } else {
        senderQualitySuspended = false;
      }
    };

    document.addEventListener("visibilitychange", syncSenderQualityAuthority);
    window.addEventListener("pagehide", resetSenderQualityAuthority);
    syncSenderQualityAuthority();
    return () => {
      document.removeEventListener("visibilitychange", syncSenderQualityAuthority);
      window.removeEventListener("pagehide", resetSenderQualityAuthority);
    };
  }, [stream]);

  useEffect(
    () => () => {
      activeGenerationRef.current = null;
      generationRef.current += 1;
      roomMutationRef.current = null;
      sourceSwitchRef.current = null;
      sharingPauseOperationRef.current = null;
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
      serverShareGenerationRef.current = null;
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
      nativeConnection.release();
      hostAudioRef.current?.dispose();
      hostAudioRef.current = null;
      streamRef.current?.getTracks().forEach((track) => stopUserMediaTrack(track));
      retiringStreamRef.current?.getTracks().forEach((track) => stopUserMediaTrack(track));
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
          const client = nativeConnection.current;
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

  function disposeResources(notifyServer: boolean, keepRoomSession = false): void {
    closeCaptureSourcePicker();
    sharingPauseOperationRef.current = null;
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
          if (keepRoomSession) signal.stopSharing(shareGeneration);
          else signal.send({ type: "stop-sharing", shareGeneration });
        }
      }
      if (!keepRoomSession) {
        // Never carry a terminal message into a later authentication: the next
        // sharing generation may already be reusing this room.
        signal.stop();
      }
    }
    if (!keepRoomSession) {
      signalRef.current = null;
      setInteractionSession(null);
    }
    shareGenerationRef.current = null;
    disposeNativeShare();
    peersRef.current.forEach((peer) => peer.dispose());
    peersRef.current.clear();
    hostProvisionalChildRef.current?.discard();
    hostProvisionalChildRef.current = null;
    browserVideoPoolRef.current?.dispose();
    browserVideoPoolRef.current = null;
    activeHostChildPeerIdsRef.current = [];
    if (!keepRoomSession) {
      endpointMediaCopyCapacityRef.current = MAX_ENDPOINT_MEDIA_CHILDREN;
      hostPeerIdRef.current = null;
    }
    serverShareGenerationRef.current = null;
    void hostSfuRouteRef.current?.disconnect();
    hostSfuRouteRef.current = null;
    hostAudioRef.current?.dispose();
    hostAudioRef.current = null;
    audioAvailableRef.current = false;
    commentaryOperationRef.current = null;
    setCommentary(false); setCommentaryBusy(false);
    setCommentaryInput({ deviceId: "", volume: 1, voiceProcessing: true });
    shareVolumeChangeRef.current = null;
    setShareVolume({ level: 1, muted: false });
    streamRef.current?.getTracks().forEach((track) => stopUserMediaTrack(track));
    retiringStreamRef.current?.getTracks().forEach((track) => stopUserMediaTrack(track));
    streamRef.current = null;
    retiringStreamRef.current = null;
    if (!keepRoomSession) iceConfigRef.current = null;
    setStream(null);
    setDetails(null);
    setPeerSnapshots(new Map());
    if (!keepRoomSession) setParticipantPresence([]);
    viewerQualityEvidenceStore.clear();
    cancelViewerQualityEvidenceRender();
    setViewerQualityEvidence(viewerQualityEvidenceStore.getSnapshot());
    activeRouteRevisionRef.current = 0;
    if (!keepRoomSession) setSignalStatus("offline");
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
    kind: "access" | "replacement" | "sharing" | "creation",
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
    message: StatusNoticeMessage,
    notifyServer = true,
    comic: ComicKind = "share-ended",
    tone: ComicTone = "off",
    keepRoomSession = hostRoomSessionAvailable,
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
    disposeResources(notifyServer, keepRoomSession);
    setStatusNotice(message, comic, tone);
    setPhase("ended");
  }

  function endRoomSession(
    message: StatusNoticeMessage,
    comic: ComicKind,
    tone: ComicTone = "bad",
    idlePhase: "error" | "ended" = "error",
  ): void {
    if (activeGenerationRef.current !== null) {
      endSharing(message, false, comic, tone, false);
    } else {
      disposeResources(false);
      setStatusNotice(message, comic, tone);
      setPhase(idlePhase);
    }
  }

  async function createIdleRoom(): Promise<void> {
    if (!hostRoomSessionAvailable || roomRef.current || phase === "starting") return;
    const mutation = beginRoomMutation("creation");
    if (!mutation) return;
    try {
      await roomInitializationRef.current;
      if (roomMutationRef.current !== mutation || roomRef.current) return;
      const profile = creationProfileRef.current;
      const response = await createRoom(
        profile.codeEntryPolicy, profile.roomPassword, readPreferredRoomId(),
      );
      const created = hostRoomFromCreated(response);
      if (roomMutationRef.current !== mutation) {
        closeAbandonedRoom(created);
        return;
      }
      if (!(await writeHostRoom(created, () => roomMutationRef.current === mutation))) {
        closeAbandonedRoom(created);
        throw new Error("Host room is already open in another tab");
      }
      roomRef.current = created;
      setRoom(created);
      setViewerPasswordEnabled(profile.roomPassword !== null);
    } catch (error) {
      if (roomMutationRef.current === mutation) setNoticeError(error, "room");
    } finally {
      finishRoomMutation(mutation);
    }
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
      if (roomMutationRef.current !== mutation) {
        closeAbandonedRoom(replacement);
        return;
      }
      if (wasSharing) {
        endSharing({ key: "host.roomReplaced" }, false, "share-ended", "off", false);
      } else if (signalRef.current) {
        disposeResources(false);
      }
      replaceViewerInvite(activeRoom.roomId, null);
      if (!(await writeHostRoom(
        replacement,
        () => roomMutationRef.current === mutation,
      ))) {
        closeAbandonedRoom(replacement);
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
      if (roomMutationRef.current !== mutation) return;
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
              closeAbandonedRoom(replacement);
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
            if (roomMutationRef.current === mutation) setNoticeError(replacementError, "room");
            return;
          }
        }
        if (forgetRoom(activeRoom)) {
          endRoomSession({ key: "host.roomInvalid" }, "room-not-found");
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
    const { client, target, audio, excludeAudio, showCaptureBorder, path } = selection;
    let bridge: NativeMediaBridge | null = null;
    let shareStarted = false;
    let nativeEventCleanup: (() => void) | null = null;
    try {
      await nativeShareCleanupRef.current;
      await nativePreviewTailRef.current;
      if (!isCurrentShare(generation, shareGeneration)) return null;
      if (nativeConnection.current !== client) throw new NativeRequestError("unavailable", "start-share");
      // Acquire the required Browser peer before starting capture. Pending
      // cancellation owns this bridge, but still closes control to abort startup.
      bridge = new NativeMediaBridge(
        shareGeneration,
        client,
        () => {
          if (
            nativeMediaBridgeRef.current === bridge &&
            isCurrentShare(generation, shareGeneration)
          ) {
            endSharing({ key: "native.fail.edge", failureCode: "app/browser-media/connection" }, true, "route-failed", "bad");
          }
        },
        undefined,
        () => {
          if (nativeMediaBridgeRef.current === bridge && isCurrentShare(generation, shareGeneration)) {
            nativeInputRoute.setUpstream(bridge?.getRemoteInput() ?? null);
          }
        },
      );
      nativeMediaBridgeRef.current = bridge;
      nativeSourceAudioRef.current = undefined;
      audioAvailableRef.current = false;
      nativeSourceSelectionRef.current = selection;
      nativeEventCleanup = client.onEvent((event) => {
        if (event.shareId !== shareGeneration || !isCurrentShare(generation, shareGeneration) || nativeConnection.current !== client) return;
        if (event.type === "remote-control-state") {
          setRemoteControlState(event);
          signalRef.current?.setCoPlayGrants(event.coPlay ? event.requests.flatMap(request =>
            request.state !== "pending" && request.endpointId
              ? [{ endpointId: request.endpointId }] : []) : []);
        }
        if (event.type === "audio-state") {
          setCommentary(event.microphone);
          nativeSourceAudioRef.current = event.sourceAudio;
          audioAvailableRef.current = event.sourceAudio || event.microphone;
          signalRef.current?.setAudioAvailable(audioAvailableRef.current);
          setDetails(previous => previous ? { ...previous, hasSourceAudio: event.sourceAudio } : previous);
          if (event.failed) setNoticeValue({ kind: "key", key: "host.audioInput.stopped", target: "operation", comic: "warning", tone: "warn" });
        }
        if (event.type === "share-ended") {
          endSharing(
            event.failed ? { key: "host.shareEnded", failureCode: "app/capture/failed" } : { key: "host.stopNotice" },
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
        excludeAudio: audio ? excludeAudio : undefined,
        showCaptureBorder,
        adapterIndex: path.adapterIndex,
        encoderIndex: path.encoderIndex,
        edgeCapacity: MAX_ENDPOINT_MEDIA_CHILDREN,
        profile: qualitySettingsRef.current,
        codec: videoCodecModeRef.current,
      });
      shareStarted = true;
      if (!isCurrentShare(generation, shareGeneration)) {
        if (nativeMediaBridgeRef.current === bridge) nativeMediaBridgeRef.current = null;
        bridge.dispose();
        await client.stopShare(shareGeneration).catch(() => nativeConnection.discard(client));
        return null;
      }
      if (nativeConnection.current !== client) throw new NativeRequestError("unavailable", "start-share");
      nativeSourceAudioRef.current ??= started.sourceAudio ?? started.audio;
      audioAvailableRef.current = nativeSourceAudioRef.current || audioAvailableRef.current;
      videoCodecRef.current = manualVideoCodecPreference(started.codec);
      // Register ownership before waiting for the local bridge. A native edge
      // may fail immediately after becoming ready.
      nativeConnection.adopt(client);
      nativeShareGenerationRef.current = shareGeneration;
      nativeModeRef.current = true;
      if (client.health.nativeMedia.remoteInput) await client.setRemoteInputPeers(shareGeneration, remoteInputPeersRef.current);
      setNativeActive(true);
      const stream = await bridge.start(started.audio);
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
        nativeConnection.current === client &&
        nativeShareGenerationRef.current === shareGeneration
      ) {
        disposeNativeShare();
      } else {
        if (nativeMediaBridgeRef.current === bridge) nativeMediaBridgeRef.current = null;
        bridge?.dispose();
        if (shareStarted) {
          nativeShareCleanupRef.current = client
            .stopShare(shareGeneration)
            .catch(() => nativeConnection.discard(client));
        } else {
          nativeConnection.discard(client);
        }
      }
      throw error;
    }
  }

  function handleNativeClientClosed(): void {
    if (nativeSourceRequestRef.current) {
      nativeSourcePathRef.current = null;
      setNativeSources({ kind: "unavailable" });
    }
    if (nativeMediaIngressRef.current) {
      recoverBrowserFanout(nativeMediaIngressRef.current);
    } else if (nativeModeRef.current && activeGenerationRef.current !== null) {
      endSharing({ key: "native.fail.controlDisconnected", failureCode: "app/control/disconnected" }, true, "route-failed", "bad");
    }
  }

  function connectNativeClient(signal: AbortSignal): Promise<NativeClient | null> {
    return NativeClient.connect({ signal }).catch((error) => {
      debugError("native", "discovery-failed", error);
      if (error instanceof NativeCompatibilityError) throw error;
      return null;
    });
  }

  function acquireNativeClient(): Promise<NativeClient | null> {
    return nativeConnection.acquire(nativeShareCleanupRef.current);
  }

  function releaseUnusedNativeClient(): void {
    // The picker may hand its connection to a starting share; only Native media
    // needs to keep it after startup. Merely visiting the page owns no session.
    if (nativeSourceRequestRef.current || nativeShareGenerationRef.current ||
      (activeGenerationRef.current !== null && roomMutationRef.current !== null)) return;
    nativeConnection.release();
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
    if (!isClientActivated() || (phase === "live" && !nativeModeRef.current)) {
      setNativeSources({ kind: "browser" });
      return;
    }
    setNativeSources(previous => ({ kind: "loading", appDetected: nativeAppDetected(previous) }));

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
      if (nativeSourceRequestRef.current !== request || nativeConnection.current !== client) {
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
        processAudioExclusion: client.health.nativeMedia.processAudioExclusion,
        captureBorderControl: client.health.nativeMedia.captureBorderControl,
      });
    } catch (error) {
      if (nativeSourceRequestRef.current !== request || nativeConnection.current !== client) return;
      debugError("native", "source-list-failed", error);
      if (!nativeShareGenerationRef.current) {
        nativeConnection.discard(client);
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
    const client = nativeConnection.current;
    if (!client || !isCurrentShare(generation, shareGeneration)) return;
    await nativeShareCleanupRef.current;
    if (nativeConnection.current !== client || !isCurrentShare(generation, shareGeneration)) return;
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
    const client = nativeConnection.current;
    const request = nativeSourceRequestRef.current;
    if (!client || !request || nativeSources?.kind !== "ready") return null;
    const owns = () => !signal?.aborted &&
      nativeSourceRequestRef.current === request &&
      nativeConnection.current === client;
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
    excludeAudio?: NativeCaptureTarget,
  ): void {
    if (nativeSources?.kind !== "ready") return;
    const client = nativeConnection.current;
    const path = nativeSourcePathRef.current;
    if (!client || !path) return;
    setShowCaptureBorder(showCaptureBorder);
    if (phase === "live" && nativeModeRef.current) {
      void switchNativeSource(client, target, audio, path, showCaptureBorder, excludeAudio);
      return;
    }
    void startSharing({ kind: "native", client, target, audio, excludeAudio, showCaptureBorder, path });
  }

  function disposeNativeShare(expectedShare = nativeShareGenerationRef.current): void {
    if (nativeShareGenerationRef.current !== expectedShare) return;
    const client = nativeConnection.current;
    const shareGeneration = nativeShareGenerationRef.current;
    const ingress = nativeMediaIngressRef.current;
    nativeMediaIngressRef.current = null;
    nativeInputRoute.dispose();
    nativeMediaBridgeRef.current?.dispose();
    nativeMediaBridgeRef.current = null;
    ingress?.dispose();
    nativeEventCleanupRef.current?.();
    nativeEventCleanupRef.current = null;
    nativeShareGenerationRef.current = null;
    nativeModeRef.current = false;
    nativeSourceAudioRef.current = undefined;
    nativeSourceSelectionRef.current = null;
    setNativeActive(false);
    setRemoteControlState(null);
    signalRef.current?.setCoPlayGrants([]);
    if (!client || !shareGeneration) {
      releaseUnusedNativeClient();
      return;
    }
    nativeShareCleanupRef.current = (ingress
      ? client.stopReceive(shareGeneration)
      : client.stopShare(shareGeneration))
      .catch(() => nativeConnection.discard(client));
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

  function rememberQuality(settings: QualitySettings): void {
    const preference = appQualityPreferenceRef.current;
    if (preference) preference.save(settings);
    else {
      pendingAppQualityPreferenceRef.current = settings;
      savePreferredQuality(settings);
    }
  }

  async function loadAppQualityPreference(signal: AbortSignal): Promise<void> {
    const initial = qualitySettingsRef.current;
    const preference = await AppQualityPreference.connect(signal);
    if (!preference || signal.aborted) return;
    appQualityPreferenceRef.current = preference;
    // An explicit choice made during discovery wins, even before permission resolves.
    const pending = pendingAppQualityPreferenceRef.current;
    pendingAppQualityPreferenceRef.current = null;
    if (pending) preference.save(pending);
    const saved = await preference.read();
    if (!signal.aborted && saved && supportsCaptureProfile(saved) && !qualityPreferenceEditedRef.current &&
      qualitySettingsRef.current === initial && activeGenerationRef.current === null &&
      roomMutationRef.current === null) {
      commitQuality(saved);
    }
  }

  function changeMaxAudioBitrate(
    maxAudioBitrate: number,
  ): void {
    if (phase === "starting") {
      return;
    }
    const next = { ...advancedQualityRef.current, maxAudioBitrate };
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

  function changeRoutePolicy(patch: Partial<Pick<RoutePolicy, "peerOnly" | "topologyOptimization">>): void {
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
    if (!supportsCaptureProfile(nextProfile, videoLimits, audioBitrateCeiling)) {
      advancedQualityRef.current = qualitySettingsRef.current;
      setAdvancedQuality(qualitySettingsRef.current);
      setNoticeError(new Error("Capture quality is not supported by this implementation"), "quality");
      return;
    }
    qualityPreferenceEditedRef.current = true;
    advancedQualityRef.current = nextProfile;
    setAdvancedQuality(nextProfile);
    if (phase !== "live") {
      if (qualitySettingsEqual(qualitySettingsRef.current, nextProfile)) {
        return;
      }
      commitQuality(nextProfile);
      rememberQuality(nextProfile);
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
      !qualityResolutionEqual(previousProfile.resolution, nextProfile.resolution) ||
      previousProfile.maxFramerate !== nextProfile.maxFramerate;
    const audioChanged =
      screenAudioBitrate(previousProfile.maxAudioBitrate) !==
      screenAudioBitrate(nextProfile.maxAudioBitrate);
    try {
      const nativeClient = nativeConnection.current;
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
      rememberQuality(appliedProfile);
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
            ? say("host.notice.audioSet", { kbps: String(screenAudioBitrate(nextProfile.maxAudioBitrate) / 1_000) })
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

  function changeShareVolume(level: number, muted: boolean): void {
    const generation = activeGenerationRef.current;
    const shareId = nativeShareGenerationRef.current;
    if (generation === null) return;
    const token = {};
    shareVolumeChangeRef.current = token;
    const volume = muted ? 0 : level;
    const update = nativeModeRef.current && shareId
      ? nativeConnection.current!.setShareVolume(shareId, volume)
      : Promise.resolve(hostAudioRef.current?.setVolume(volume));
    void update.then(() => {
      if (isCurrentGeneration(generation) && shareVolumeChangeRef.current === token) setShareVolume({ level, muted });
    }).catch(error => {
      if (isCurrentGeneration(generation) && shareVolumeChangeRef.current === token) setNoticeError(error, "sourceAudio");
    });
  }

  function toggleSharingPause(): void {
    const activeStream = streamRef.current;
    const nativeClient = nativeConnection.current;
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
      const operation = {};
      sharingPauseOperationRef.current = operation;
      const owns = () => isCurrentGeneration(generation) && sharingPauseOperationRef.current === operation;
      const nextPaused = !sharingPausedRef.current;
      void nativeClient
        .setPaused(nativeShareGeneration, nextPaused)
        .then(async () => {
          if (!owns()) return;
          const sent = signalRef.current?.setSharingPaused(nextPaused) === true;
          if (!sent && !nextPaused) {
            // Mirror the Browser branch: a resume the server did not hear
            // rolls back to paused and restores the wire intent.
            await nativeClient.setPaused(nativeShareGeneration, true);
            if (!owns()) return;
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
          if (owns()) {
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

  function acceptHostPeerUpdate(peer: HostMediaPeer, snapshot: PeerSnapshot, generation: number): void {
    if (!isCurrentGeneration(generation) || peersRef.current.get(peer.peerId) !== peer) return;
    if (snapshot.connectionState === "failed" || snapshot.connectionState === "closed") {
      reportHostChildFailure(peer.peerId, peer.connectionId, generation);
      removePeer(peer.peerId);
      return;
    }
    updatePeerSnapshot(snapshot);
    reportSenderQuality(snapshot, activeRouteRevisionRef.current);
  }

  function prepareHostChild(
    revision: number,
    assignment: HostRouteAssignment,
    candidate: PreparedRouteCandidate,
    generation: number,
  ): boolean {
    const stream = streamRef.current;
    const nativeClient = nativeConnection.current;
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
          reportHostChildFailure(peer.peerId, peer.connectionId, generation);
          removePeer(peer.peerId);
        }
      },
      onPromotedUpdate: (peer, snapshot) => {
        acceptHostPeerUpdate(peer, snapshot, generation);
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
                  { ...events, onInputChannel: nativeModeRef.current
                    ? (channel, connection) => nativeInputRoute.attachChild(channel, connection)
                    : undefined },
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
                (candidate.connectionAttempt?.current ?? 1) > 1,
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
    const nativeClient = nativeConnection.current;
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
        payload: SignalPayload,
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
        acceptHostPeerUpdate(peer, snapshot, generation);
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
    reauthenticated: boolean,
    pendingQualitySettings: QualitySettings | null,
  ): void {
    if (!isCurrentGeneration(generation)) {
      return;
    }
    if (message.type === "authenticated" && message.role === "host") {
      discardPreparedHostChild();
      routePolicyRef.current = { ...message.routePolicy };
      setRoutePolicy({ ...message.routePolicy });
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
    if (message.type === "sharing-started") {
      if (message.shareGeneration !== shareGenerationRef.current) return;
      serverShareGenerationRef.current = message.shareGeneration;
      routePolicyRef.current = { ...message.routePolicy };
      setRoutePolicy({ ...message.routePolicy });
      commitQuality(message.qualitySettings);
      activeRouteRevisionRef.current = message.routeRevision;
      sharingPausedRef.current = message.paused;
      setSharingPaused(message.paused);
      setPhase("live");
      const route = ensureHostSfuRoute(generation);
      void route
        .resyncAuthoritative({
          revision: message.routeRevision,
          phase: "active",
          assignment: message.routeAssignment,
        })
        .then(() => syncHostSfuQualityWarning(route, generation));
      return;
    }
    if (message.type === "pause-sharing-source") {
      if (message.shareGeneration !== shareGenerationRef.current) {
        return;
      }
      sharingPauseOperationRef.current = null;
      const activeStream = streamRef.current;
      const nativeClient = nativeConnection.current;
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
  }

  function connectRoomSignal(activeRoom: HostRoomState, shareGeneration?: string, allowReplacement = true): SignalingClient {
    const previous = signalRef.current;
    if (hostRoomSessionAvailable && previous?.ownsHostRoom(activeRoom.roomId, activeRoom.hostToken)) {
      previous.setAudioAvailable(audioAvailableRef.current);
      return previous;
    }
    previous?.stop();
    let authenticated = false;
    const hostClientId = getStableClientId("host", activeRoom.roomId);
    hostClientIdRef.current = hostClientId;
    const hostFallback = defaultHostDisplayName(visRef.current);
    const initialDisplayName = readDisplayName(hostFallback);
    displayNameRef.current = initialDisplayName;
    setDisplayName(initialDisplayName);
    setDisplayNameDraft(initialDisplayName);
    setDisplayNameError(false);
    const signal = new SignalingClient(
      {
        roomId: activeRoom.roomId,
        role: "host",
        token: activeRoom.hostToken,
        clientId: hostClientId,
        ...(hostRoomSessionAvailable ? { roomSession: true as const, roomOnly: true as const } : { shareGeneration }),
        sharingPaused: false,
        qualitySettings: qualitySettingsRef.current,
        routePolicy: routePolicyRef.current,
        viewerPresence: true,
        displayName: initialDisplayName,
      },
      {
        onStatus: (status) => {
          if (signalRef.current === signal && isCurrentRoomAuthority(activeRoom)) {
            setSignalStatus(status);
            if (status === "connected") {
              setNoticeValue(current => current?.kind === "key" && current.key === "host.pause.signalRecovering" ? null : current);
            }
          }
        },
        onTerminated: (reason) => {
          if (signalRef.current !== signal || !isCurrentRoomAuthority(activeRoom)) return;
          endRoomSession({ key: hostTerminationKey(reason) }, "signal-failed");
          if (reason === "SESSION_REPLACED") forgetRoom(activeRoom, true);
        },
        onAccessRequired: () => {
          if (signalRef.current !== signal || !isCurrentRoomAuthority(activeRoom)) return;
          endRoomSession({ key: "gate.expired" }, "access-denied");
          onAuthorizationRequired?.();
        },
        onMessage: (message) => {
          if (signalRef.current !== signal || !isCurrentRoomAuthority(activeRoom)) return;
          if (message.type === "remote-input-peers") {
            remoteInputPeersRef.current = message.peers;
            const client = nativeConnection.current, shareId = nativeShareGenerationRef.current;
            if (client?.health.nativeMedia.remoteInput && nativeModeRef.current && shareId) {
              void client.setRemoteInputPeers(shareId, message.peers).catch(error => debugError("native", "input-endpoints", error));
            }
            return;
          }
          const currentGeneration = activeGenerationRef.current;
          const currentShareGeneration = shareGenerationRef.current;
          const localShareActive =
            currentGeneration !== null && currentShareGeneration !== null;
          if (
            !authenticated &&
            message.type === "error" &&
            message.code === "INVALID_TOKEN" &&
            allowReplacement
          ) {
            if (!localShareActive || !signal.wantsHostPublication(currentShareGeneration!)) {
              signalRef.current = null;
              signal.stop();
              setInteractionSession(null);
              setSignalStatus("offline");
              forgetRoom(activeRoom);
              // Capture may still be awaiting permission. Its ready path owns
              // creation/publication; room recovery must not start it early.
              if (!localShareActive) {
                endRoomSession({ key: "host.roomInvalid" }, "room-not-found");
              }
              return;
            }
            signalRef.current = null;
            signal.stop();
            setSignalStatus("offline");
            roomInitializationRef.current = createReplacementRoom(activeRoom, currentGeneration!, currentShareGeneration!);
            return;
          }
          if (message.type === "error" && message.code === "INVALID_TOKEN") {
            forgetRoom(activeRoom);
            endRoomSession({ key: "host.roomInvalid" }, "room-not-found");
            return;
          }
          if (message.type === "room-closed") {
            if (!forgetRoom(activeRoom)) return;
            endRoomSession({ key: "host.roomClosed" }, "room-closed", "off", "ended");
            return;
          }
          if (message.type === "error" && message.code === "HOST_ALREADY_CONNECTED") {
            endRoomSession({ key: hostServerErrorKey(message.code) }, "signal-failed");
            return;
          }
          const reauthenticated =
            authenticated &&
            message.type === "authenticated" &&
            message.role === "host";
          if (message.type === "authenticated" && message.role === "host") {
            authenticated = true;
            iceConfigRef.current = message.iceConfig;
            hostPeerIdRef.current = message.peerId;
            endpointMediaCopyCapacityRef.current = message.endpointMediaCopyCapacity;
            serverShareGenerationRef.current = message.shareGeneration;
            const profile = {
              codeEntryPolicy: message.codeEntryPolicy,
              roomPassword: message.viewerPasswordEnabled ? creationProfileRef.current.roomPassword : null,
            };
            saveCreationProfile(profile);
            creationProfileRef.current = profile;
            setCreationProfile(profile);
            setViewerPasswordEnabled(message.viewerPasswordEnabled);
            setViewerPasswordDraft(profile.roomPassword ?? "");
            setViewerPasswordVisible(false);
            setRoom(current => mergeAuthenticatedHostRoom(current, activeRoom.roomId, message.codeEntryPolicy));
            peersRef.current.forEach((peer) =>
              peer.updateIceConfig(message.iceConfig),
            );
            void writeHostRoom(
              activeRoom,
              () => signalRef.current === signal && isCurrentRoomAuthority(activeRoom),
            );
            writePreferredRoom(activeRoom.roomId);
          }
          if (
            message.type === "sharing-started" &&
            currentShareGeneration !== null &&
            message.shareGeneration === currentShareGeneration
          ) {
            serverShareGenerationRef.current = message.shareGeneration;
          }
          if (message.type === "sharing-start-failed") {
            if (localShareActive && message.shareGeneration === currentShareGeneration) {
              endSharing({ key: hostServerErrorKey(message.code) }, false, "signal-failed", "bad");
            }
            return;
          }
          if (message.type === "viewer-presence") {
            retainViewerQualityEvidenceForPresence(message.viewers);
            setParticipantPresence(message.viewers);
            return;
          }
          if (message.type === "error") {
            setNoticeKey(hostServerErrorKey(message.code), "signal-failed", "bad");
            return;
          }
          const mediaActive =
            currentGeneration !== null &&
            currentShareGeneration !== null &&
            serverShareGenerationRef.current === currentShareGeneration;
          if (message.type === "authenticated" && message.role === "host" && mediaActive) {
            setPhase("live");
          }
          if (!mediaActive) return;
          handleSignalMessage(
            message,
            currentGeneration!,
            reauthenticated,
            reauthenticated
              ? signal.pendingHostQualitySettings(currentShareGeneration!)
              : null,
          );
        },
      },
      undefined,
      { roomInteractions: roomInteractionsAvailable, roomReactionIds },
    );
    signalRef.current = signal;
    signal.setAudioAvailable(audioAvailableRef.current);
    remoteInputPeersRef.current = [];
    void getRuntimeCapabilities().then(capabilities => {
      if (signalRef.current === signal && capabilities.roomInteractions) setInteractionSession(signal.enableRoomInteractions(capabilities.roomReactionIds));
      if (signalRef.current === signal && capabilities.roomVoice) setRoomVoiceSession(signal.enableRoomVoice({ listeningPresence: capabilities.roomVoiceListeningPresence, bitrate: capabilities.roomVoiceBitrate }));
      if (signalRef.current === signal && capabilities.remoteInput) signal.enableRemoteInput();
      if (signalRef.current === signal && capabilities.coPlayPresence) signal.enableCoPlayPresence();
      if (signalRef.current === signal && capabilities.audioPresence) signal.enableAudioPresence();
    }).catch(() => { /* Optional input does not block sharing. */ });
    setInteractionSession(signal.interactions);
    return signal;
  }

  async function createReplacementRoom(activeRoom: HostRoomState, generation: number, shareGeneration: string): Promise<void> {
    try {
      const response = await createRoom(
        creationProfileRef.current.codeEntryPolicy,
        creationProfileRef.current.roomPassword,
        readPreferredRoomId(),
      );
      const replacement = hostRoomFromCreated(response);
      if (!isCurrentShare(generation, shareGeneration) || !isCurrentRoomAuthority(activeRoom)) {
        closeAbandonedRoom(replacement);
        return;
      }
      forgetRoom(activeRoom);
      if (!(await writeHostRoom(replacement, () => isCurrentShare(generation, shareGeneration)))) {
        closeAbandonedRoom(replacement);
        throw new Error("Host room is already open in another tab");
      }
      roomRef.current = replacement;
      setRoom(replacement);
      const signal = connectRoomSignal(replacement, shareGeneration, false);
      if (hostRoomSessionAvailable) signal.startSharing(shareGeneration, qualitySettingsRef.current, routePolicyRef.current);
      signal.start();
    } catch (error) {
      if (!isCurrentShare(generation, shareGeneration)) return;
      endSharing({ key: "host.roomInvalid" }, false, "room-not-found", "bad", false);
      if (error instanceof ApiError && error.status === 401 && onAuthorizationRequired) {
        onAuthorizationRequired();
        return;
      }
      setNoticeError(error, "room", "television");
      setPhase("error");
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
      captured?.getTracks().forEach((track) => stopUserMediaTrack(track));
      if (nativeStarted) disposeNativeShare(shareGeneration);
      return;
    }
    if (captured) {
      if (selection.kind === "browser") {
        hostAudioRef.current = new HostAudio(captured, selection.source ?? "browser", available => {
          if (!isCurrentShare(generation, shareGeneration)) return;
          audioAvailableRef.current = available;
          signalRef.current?.setAudioAvailable(available);
          const source = hostAudioRef.current?.sourceStream;
          if (source) setDetails(captureDetails(source, false, hostAudioRef.current?.sourceAudioAvailable));
        }, enabled => { if (isCurrentShare(generation, shareGeneration)) setCommentary(enabled); });
        const audio = hostAudioRef.current;
        try {
          captured = await audio.start();
          if (!isCurrentShare(generation, shareGeneration)) {
            audio.sourceStream.getTracks().forEach(track => stopUserMediaTrack(track)); audio.dispose(); return;
          }
        } catch (error) {
          audio.sourceStream.getTracks().forEach(track => stopUserMediaTrack(track)); audio.dispose();
          if (isCurrentShare(generation, shareGeneration)) {
            activeGenerationRef.current = null;
            disposeResources(false); setNoticeError(error, "sourceAudio"); setPhase("error");
          }
          return;
        }
        audioAvailableRef.current = hostAudioRef.current.audioAvailable;
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
        setDetails(captureDetails(hostAudioRef.current?.sourceStream ?? captured));
        const codec = await resolveStreamVideoCodec(captured);
        if (isCurrentShare(generation, shareGeneration)) {
          videoCodecRef.current = codec;
          await startBrowserNativeIngress(generation, shareGeneration, captured);
          nativeStarted = nativeMediaIngressRef.current !== null;
        }
      }
    }
    if (!isCurrentShare(generation, shareGeneration)) {
      captured?.getTracks().forEach((track) => stopUserMediaTrack(track));
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
          captured?.getTracks().forEach((track) => stopUserMediaTrack(track));
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
      const signal = connectRoomSignal(createdRoom, shareGeneration);
      if (hostRoomSessionAvailable) signal.startSharing(shareGeneration, qualitySettingsRef.current, routePolicyRef.current);

      signal.start();
    } catch (error) {
      if (!isCurrentShare(generation, shareGeneration)) {
        captured?.getTracks().forEach((track) => stopUserMediaTrack(track));
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
    excludeAudio?: NativeCaptureTarget,
  ): Promise<void> {
    const generation = activeGenerationRef.current;
    const shareGeneration = nativeShareGenerationRef.current;
    if (
      phase !== "live" ||
      generation === null ||
      !shareGeneration ||
      !isCurrentGeneration(generation) ||
      nativeConnection.current !== client ||
      sourceSwitchRef.current ||
      qualityChangeRef.current
    ) {
      return;
    }
    const previous = nativeSourceSelectionRef.current;
    const token = { audioOnly: target.kind !== "picker" && !!previous &&
      nativeCaptureTargetKey(previous.target) === nativeCaptureTargetKey(target) &&
      previous.showCaptureBorder === showCaptureBorder };
    sourceSwitchRef.current = token;
    closeCaptureSourcePicker();
    setSwitchingSource(true);
    setNoticeValue(null);
    try {
      await nativePreviewTailRef.current;
      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token ||
        nativeConnection.current !== client
      ) return;
      // Preserve an exclusion request even on failure: the App mutes source
      // audio before replacing it, and the next picker must not default to all.
      if (audio && excludeAudio && previous) nativeSourceSelectionRef.current = { ...previous, audio, excludeAudio };
      await client.replaceShareSource(
        shareGeneration,
        target,
        audio,
        path,
        showCaptureBorder,
        audio ? excludeAudio : undefined,
      );
      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token ||
        nativeConnection.current !== client
      ) {
        return;
      }
      nativeSourceSelectionRef.current = { kind: "native", client, target, audio, path, showCaptureBorder, excludeAudio };
      const activeStream = streamRef.current;
      if (activeStream) {
        setDetails(
          captureDetails(activeStream, true, nativeSourceAudioRef.current),
        );
      }
      if (token.audioOnly) return;
      invalidateSenderQualityEvidence();
      if (routePolicyRef.current.topologyOptimization) {
        signalRef.current?.send({ type: "reset-sender-quality" });
      }
      const sfuUpdated = await hostSfuRouteRef.current?.updateProfile(qualitySettingsRef.current) ?? true;
      if (
        !isCurrentGeneration(generation) ||
        sourceSwitchRef.current !== token ||
        nativeConnection.current !== client
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
        setNoticeError(error, token.audioOnly ? "sourceAudio" : "source");
      }
    } finally {
      finishSourceSwitch(token);
    }
  }

  async function changeCommentary(enabled: boolean, input = commentaryInput): Promise<void> {
    const generation = activeGenerationRef.current;
    if (generation === null || commentaryOperationRef.current) return;
    const operation = {}; commentaryOperationRef.current = operation; setCommentaryBusy(true);
    try {
      const client = nativeConnection.current, shareId = nativeShareGenerationRef.current;
      if (nativeActive && client && shareId) await client.setMicrophone(shareId, enabled, input.volume, input.deviceId);
      else if (hostAudioRef.current) await hostAudioRef.current.setMicrophone(enabled, input);
      else throw new Error("Shared audio is unavailable");
      if (isCurrentGeneration(generation) && commentaryOperationRef.current === operation) {
        setCommentaryInput(input);
      }
    } catch (error) {
      if (isCurrentGeneration(generation) && commentaryOperationRef.current === operation) {
        debugError("capture", "commentary-failed", error);
        setNoticeValue({ kind: "key", key: "host.commentary.failed", target: "operation", comic: "warning", tone: "warn" });
      }
    } finally {
      if (commentaryOperationRef.current === operation) { commentaryOperationRef.current = null; setCommentaryBusy(false); }
    }
  }

  function changeCommentaryVolume(volume: number): void {
    setCommentaryInput(previous => ({ ...previous, volume }));
    const generation = activeGenerationRef.current;
    const client = nativeConnection.current, shareId = nativeShareGenerationRef.current;
    if (nativeActive && client && shareId) void client.setMicrophoneVolume(shareId, volume).catch(error => {
      if (generation !== null && isCurrentGeneration(generation)) setNoticeError(error, "sourceAudio");
    });
    else hostAudioRef.current?.microphoneVolume(volume);
  }

  function changeNativeSourceAudio(audio: boolean, excludeAudio?: NativeCaptureTarget): void {
    const selection = nativeSourceSelectionRef.current;
    if (!selection || selection.target.kind !== "display") return;
    void switchNativeSource(selection.client, selection.target, audio, selection.path, selection.showCaptureBorder, excludeAudio);
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
      captured.getTracks().forEach((track) => stopUserMediaTrack(track));
      return;
    }

    try {
      if (source === "camera") setCameraDevice(deviceId);
      captured = hostAudioRef.current?.attach(captured, source) ?? captured;
      await replaceBrowserStream(captured, generation, token);
    } catch (error) {
      if (captured !== streamRef.current) captured.getVideoTracks().forEach(track => stopUserMediaTrack(track));
      if (isCurrentGeneration(generation)) setNoticeError(error, "source");
    } finally {
      finishSourceSwitch(token);
    }
  }

  function setCaptureError(error: unknown, source: BrowserCaptureSource | undefined, action: "source" | "capture") {
    debugError("capture", "failed", error, { action, source });
    const target = action === "source" ? "operation" : "television";
    if (source !== "camera") {
      setNoticeError(error, action, target);
      return;
    }
    setNoticeValue({ kind: "key", key: error instanceof DOMException && error.name === "NotAllowedError"
      ? "host.camera.denied" : "host.camera.unavailable", target, comic: "source-failed", tone: "warn",
      failureCode: hostFailureCode(error, action, "camera") });
  }

  async function replaceBrowserStream(captured: MediaStream, generation: number, token: object): Promise<void> {
    // The caller retires its operation; this function owns only stream resources.
    const previousStream = streamRef.current;
    if (!previousStream) {
      captured.getTracks().forEach((track) => stopUserMediaTrack(track));
      setStatusNotice({ key: "host.shareEnded" }, "share-ended", "off");
      return;
    }

    retiringStreamRef.current = previousStream;
    const videoChanged = captured.getVideoTracks()[0] !== previousStream.getVideoTracks()[0];
    // HostAudio retires source audio; this operation retires replaced video.
    const retirePrevious = () => previousStream.getVideoTracks().forEach((track) => {
      if (!captured.getTracks().includes(track)) stopUserMediaTrack(track);
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
            const client = nativeConnection.current;
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
      if (!isCurrentGeneration(generation) || sourceSwitchRef.current !== token) {
        captured.getTracks().forEach((track) => stopUserMediaTrack(track));
        return;
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
        captured.getTracks().forEach((track) => stopUserMediaTrack(track));
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
      if (forgetRoom(activeRoom)) endRoomSession({ key: "host.roomInvalid" }, "room-not-found");
      return;
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
      setDisplayNameError(true);
      return;
    }
    displayNameRef.current = saved;
    setDisplayName(saved);
    setDisplayNameDraft(saved);
    setDisplayNameError(false);
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
    const grant = nativeActive && remoteControlState?.coPlay
      ? remoteControlState.requests.find(request => request.peerId === viewer.peerId && request.state !== "pending") : undefined;
    return {
      key: viewer.peerId,
      name: viewer.label,
      collaboration: Boolean(grant),
      status: deriveParticipantStatus(viewer, phase === "live", viewerQualityEvidence.get(viewer.peerId), roomVoice),
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
    if (phase !== "live") return { route: null, metrics: null, direction: "receive", error: null };
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
    showConnectionDetails || (details && (stream || nativeActive)) || ownVoiceConnection || viewerOverviewEntries.length > 0,
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
  const audioBitrateCeiling = Math.min(MAX_AUDIO_SEND_BITRATE, nativeActive
    ? nativeConnection.current?.health.nativeMedia.maxAudioBitrate ?? MAX_AUDIO_SEND_BITRATE
    : MAX_AUDIO_SEND_BITRATE);
  const videoLimits = videoCaptureLimits(nativeActive ? nativeConnection.current?.health.nativeMedia : undefined);

  return (
    <div className="lr-app">
      <AppHeader
        atHome
        showAppConnection={!sourcePickerOpen}
        led={
          <LedStrip
            state={hostStatus.connection.tone}
            label={t(hostStatus.connection.labelKey)}
            comic={hostStatus.connection.comic}
          />
        }
      />

      <main className={`lr-room${theaterMode ? " is-theater" : ""}`}>
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
            indicator={<>
              {statusNotice && noticeText && (statusNotice.failureCode || statusNotice.tone === "bad")
                ? <ShareFailureHelp key={`${statusNotice.failureCode}:${noticeText}`} status={hostStatus.television}
                    label={noticeText} code={statusNotice.failureCode ?? "status/unknown"}
                    checks={hostFailureChecks(statusNotice.failureCode ?? "status/unknown")} />
                : <StatusIndicator status={hostStatus.television}
                    label={statusNotice ? noticeText ?? undefined : undefined} />}
              <span className="visually-hidden" role="status" aria-live="polite">
                {statusNotice ? noticeText : null}
              </span>
            </>}
          >
            {stream ? (
              <video ref={videoRef} muted playsInline tabIndex={0}
                style={{ objectFit: pictureFit }} aria-label={t("host.stageAria")} />
            ) : null}
            {stream && <PlaybackControls videoRef={videoRef} stream={stream}
              sharingAudio={{ ...shareVolume, available: nativeActive
                ? !!nativeConnection.current?.health.nativeMedia.shareVolume : hostAudioRef.current?.commentaryAvailable === true,
                onChange: changeShareVolume }}
              audioAvailable={audioAvailableRef.current}
              canPlay={phase === "live" && !nativeSources && !sharingPaused && !previewPlayback.suspended}
              theaterMode={theaterMode} onToggleTheater={() => setTheaterMode(value => !value)}
              onPlay={previewPlayback.onPlay}
              onPause={previewPlayback.onPause}
              overlayAction={<RoomChatToggle session={interactionSession} />}
              overlaySettings={interactionSession && <RoomChatOverlaySettings session={interactionSession} />}
              settings={{ pictureFit, pictureRotation,
                preview: { autoPause: previewAutoPause, onChange: autoPause => {
                  setPreviewAutoPause(autoPause); saveRoomPreferences({ previewAutoPause: autoPause });
                } },
                setPictureFit: fit => { setPictureFit(fit); saveRoomPreferences({ pictureFit: fit }); },
                setPictureRotation: rotation => { setPictureRotation(rotation); saveRoomPreferences({ pictureRotation: rotation }); },
              }} />}
            <RoomChatOverlay session={room ? interactionSession : null}
              visible={phase === "live" && !nativeSources && !sharingPaused && !(switchingSource && !sourceSwitchRef.current?.audioOnly) && !previewPlayback.suspended} />
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
                onAppConnected={phase !== "live" ? () => {
                  if (nativeSourceRequestRef.current) void openCaptureSourcePicker();
                } : undefined}
                browserAvailable={!nativeActive && !!navigator.mediaDevices?.getDisplayMedia}
                cameraAvailable={!nativeActive && !!navigator.mediaDevices?.getUserMedia}
                selectionDisabled={roomMutating || switchingSource || changingQuality}
                initialAudio={
                  nativeActive
                    ? nativeSourceSelectionRef.current?.excludeAudio
                      ? nativeSourceSelectionRef.current.audio
                      : nativeSourceAudioRef.current ?? false
                    : true
                }
                audioLocked={false}
                initialShowCaptureBorder={showCaptureBorder}
                initialExcludeAudio={nativeSourceSelectionRef.current?.excludeAudio}
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
            {nativeSources ? null : switchingSource && !sourceSwitchRef.current?.audioOnly ? (
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
            ) : stream && previewPlayback.suspended ? (
              <StageOverlay
                icon="eyeOff"
                comic="preview-paused"
                tone="warn"
                dim
                message={t("host.localPreviewPaused")}
              />
            ) : null}
          </StageTv>
          <HostShareControls
            actions={phase === "live" ? <>
              <Btn
                id="host-switch-source"
                icon="switchSource"
                cap={switchingSource && !sourceSwitchRef.current?.audioOnly ? "host.switching" : "host.switchSource"}
                title="host.switchSource"
                hint="hint-switch-source"
                disabled={switchingSource || changingQuality}
                onClick={() => void switchSource()}
              />
            </> : null}
            remote={nativeActive && remoteControlState && <HostRemoteControl
              mode={remoteControlState.mode}
              platform={remoteControlState.platform}
              gamepad={remoteControlState.gamepad}
              simultaneous={remoteControlState.simultaneous}
              onSimultaneous={remoteControlState.simultaneous !== undefined ? async enabled => {
                const client = nativeConnection.current;
                const shareId = nativeShareGenerationRef.current;
                if (!client || !shareId) throw new Error("Native share is unavailable");
                await client.setRemoteControlSimultaneous(shareId, enabled);
              } : undefined}
              onShortcut={nativeConnection.current?.health.nativeMedia.remoteStopShortcut ? remoteStopShortcut : undefined}
              disabled={sharingPaused || switchingSource}
              requests={remoteControlState.requests.map(request => {
                return { ...request, name: viewers.find(viewer => viewer.peerId === request.peerId)?.label ?? t("common.name.viewerDefault") };
              })}
              onPolicy={async (mode, password) => {
                const client = nativeConnection.current;
                const shareId = nativeShareGenerationRef.current;
                if (!client || !shareId) throw new Error("Native share is unavailable");
                await client.setRemoteControlPolicy(shareId, mode, password);
              }}
              onDecide={async (id, allow) => {
                const client = nativeConnection.current;
                const shareId = nativeShareGenerationRef.current;
                if (!client || !shareId) throw new Error("Native share is unavailable");
                await client.setRemoteControl(shareId, id, allow);
              }} />}
            settings={<Btn
              icon="sliders"
              busy={changingQuality}
              cap="host.settings.button"

              title={showAdvanced ? "host.advanced.hide" : "host.advanced"}
              hint={showAdvanced ? "hint-collapse" : "hint-advanced"}
              tone={showAdvanced ? "on" : undefined}
              expanded={showAdvanced}
              controls="host-advanced-door"
              onClick={() => setShowAdvanced((current) => !current)}
            />}
            pause={phase === "live" && <Btn
              icon={sharingPaused ? "play" : "pause"}
              cap={sharingPaused ? "host.resume" : "host.pause"}
              title={sharingPaused ? "host.resume" : "host.pause"}
              hint={sharingPaused ? "hint-resume" : "hint-pause"}
              draw="host-share-toggle"
              disabled={switchingSource || changingQuality}
              onClick={toggleSharingPause}
            />}
            ending={phase === "live" ? (
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
          />
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
                onDismiss={() => setNoticeValue(null)}
                motion={noticeValue.comic === "signal-recovering" || noticeValue.comic === "recovering" || noticeValue.comic === "connecting-sfu" ? "progress" : "still"} />
            ) : null}
          </div>
          <SharingSettings id="host-advanced-door" open={showAdvanced} busy={changingQuality}
            presets={
              <QualityPresets selected={selectedQualityProfileId} limits={videoLimits} busy={changingQuality}
                disabled={phase === "starting" || switchingSource}
                onSelect={id => void changeQuality({ ...QUALITY_PROFILES[id],
                  maxAudioBitrate: screenAudioBitrate(advancedQualityRef.current.maxAudioBitrate),
                })} />
            }
            pictureSummary={<PictureSettingsSummary value={advancedQuality} />}
            picture={<>
              <ResolutionControl value={advancedQuality.resolution} limits={videoLimits}
                disabled={phase === "starting" || switchingSource}
                onChange={resolution => changeAdvancedQuality({ resolution,
                  maxFramerate: Math.min(advancedQualityRef.current.maxFramerate, captureFramerateCeiling(resolution, videoLimits)),
                })} />
              <VideoRateControls value={advancedQuality} limits={videoLimits}
                disabled={phase === "starting" || switchingSource} onChange={changeAdvancedQuality} />
              <PicturePreferenceControl value={advancedQuality.degradationPreference}
                disabled={phase === "starting" || switchingSource}
                onChange={degradationPreference => changeAdvancedQuality({ degradationPreference })} />
              <div className="lr-door-group">
                <span className="lr-door-glyph"><Glyph name="puzzle" size={19} /><Cap k="host.advanced.codec" /></span>
                <div className="lr-row-group" role="group" aria-label={t("host.advanced.codec")}>
                  {(["vp8", "auto", "h264"] as const).map(mode => (
                    <Chip key={mode} name="videoCodec" value={mode} selected={displayedVideoCodecMode === mode}
                      disabled={phase === "starting" || phase === "live"}
                      title={mode === "auto"
                        ? resolvedVideoCodec
                          ? `${t("host.advanced.codec.auto")} (${resolvedVideoCodec.toUpperCase()})`
                          : `${t("host.advanced.codec.auto")}\n${t("host.advanced.codec.autoHint")}`
                        : `${mode.toUpperCase()}\n${t(mode === "vp8" ? "host.advanced.codec.vp8Hint" : "host.advanced.codec.h264Hint")}`}
                      hint="hint-codec" onClick={() => changeVideoCodecMode(mode)}>
                      {mode === "auto" && !vis ? t("host.advanced.codec.auto") : mode.toUpperCase()}
                    </Chip>
                  ))}
                </div>
              </div>
            </>}
            audio={<>
              {phase === "live" && (!nativeActive || nativeConnection.current?.health.nativeMedia.microphone) ?
                  <ShareMicrophoneSettings enabled={commentary}
                    browser={!nativeActive}
                    available={nativeActive || hostAudioRef.current?.commentaryAvailable === true}
                    roomMicrophone={roomVoiceSnapshot?.microphone}
                    onEnabled={enabled => { void changeCommentary(enabled); }}
                    disabled={commentaryBusy || switchingSource}
                    volume={commentaryInput.volume} onVolume={changeCommentaryVolume}
                    deviceId={commentaryInput.deviceId}
                    onDevice={deviceId => { void changeCommentary(true, { ...commentaryInput, deviceId }); }}
                    loadDevices={() => nativeActive && nativeConnection.current
                      ? nativeConnection.current.microphones() : browserCaptureDevices("audioinput")}
                    voiceProcessing={nativeActive ? undefined : commentaryInput.voiceProcessing}
                    onVoiceProcessing={voiceProcessing => { void changeCommentary(true, { ...commentaryInput, voiceProcessing }); }} /> : null}
              {phase === "live" && nativeActive && nativeSourceSelectionRef.current?.target.kind === "display" &&
                nativeConnection.current?.health.nativeMedia.microphone && nativeConnection.current.health.nativeMedia.processAudioExclusion ? (
                <div className="lr-door-group lr-source-audio-settings">
                  <SwitchItem checked={nativeSourceSelectionRef.current.audio}
                    label={t("host.sourcePicker.systemAudio")} hint={nativeSourceSelectionRef.current.audio ? "hint-stop-audio" : "hint-share-audio"}
                    disabled={switchingSource || changingQuality || sharingPaused}
                    onChange={audio => changeNativeSourceAudio(audio, nativeSourceSelectionRef.current?.excludeAudio)} />
                  <LiveAudioExclusion load={loadAudioApplications} value={nativeSourceSelectionRef.current.excludeAudio}
                    disabled={!nativeSourceSelectionRef.current.audio || switchingSource || changingQuality || sharingPaused}
                    onChange={target => changeNativeSourceAudio(true, target)} />
                </div>
              ) : null}
              <AudioBitrateControl value={screenAudioBitrate(advancedQuality.maxAudioBitrate)}
                max={audioBitrateCeiling} disabled={phase === "starting" || switchingSource}
                onChange={changeMaxAudioBitrate} />
            </>}
            connection={
              <div className="lr-row-group" role="group" aria-label={t("host.advanced.route")}>
                {sfuOnly ? <SwitchItem checked disabled locked
                  onChange={() => {}}
                  label={t("host.advanced.route.sfuOnly")}
                  note={t("host.advanced.route.sfuOnlyHint")}
                  hint="hint-route-sfu"
                /> : <>
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
                </>}
              </div>
            }
          />
          <RoomInteractions session={room ? interactionSession : null}
            voiceState={roomVoice}
            voice={room && roomVoiceSession ? {
              content: onSelect => <RoomVoicePanel session={roomVoiceSession} onSelectParticipant={onSelect}
                names={new Map(participantPresence.map(person => [person.peerId, person.displayName]))} />,
              settings: <RoomVoiceSettings session={roomVoiceSession} />,
              controls: <RoomVoiceControls session={roomVoiceSession} />,
            } : undefined}
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
          <div className="lr-row lr-host-summary-row">
            <div className="lr-row-group lr-host-room-slot">
              <FieldCap k="common.roomCode" />
              {room ? <>
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
              </> : <RoomCodePlaceholder
                onCreate={hostRoomSessionAvailable ? () => void createIdleRoom() : undefined}
                disabled={roomMutating || phase === "starting"}
                busy={roomMutation === "creation"}
              />}
            </div>
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
                          setDisplayNameError(false);
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
                        setDisplayNameError(false);
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
                        setDisplayNameError(false);
                        setEditingDisplayName(true);
                      }}
                    />
                  </>
                )}
                {displayNameError ? (
                  <Pill
                    icon="alert"
                    tone="bad"
                    label={t("host.nameError")}
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
                      : "host.details.show"
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
          </div>

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
                >
                  <Tooltip kind="hint-admission-code"
                    text={vis ? undefined : `${t("host.policy.open")}\n${t("host.policy.openHint")}`}>
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
                    text={vis ? undefined : `${t("host.policy.private")}\n${t(viewerPasswordEnabled ? "host.policy.privatePasswordHint" : "host.policy.privateHint")}`}>
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
                    text={vis ? undefined : `${t(passwordOpen ? "host.password.settingsHide" : "host.password.setAction")}\n${t(viewerPasswordEnabled ? "host.password.set" : "host.password.unset")}`}>
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

          {showConnectionDetails && (details && (stream || nativeActive) || ownVoiceConnection) ? (
            <Row sub>
              <ConnectionDetails id="host-details-panel" rows={[
                ...(details && (stream || nativeActive) ? [{ key: "capture", media: "video" as const,
                  label: t("stats.localCapture"), icon: "share" as const, direction: "send" as const,
                  cells: <CaptureMetricCells resolution={details.resolution} frameRate={details.frameRate}
                    codec={resolvedVideoCodec} hasSourceAudio={details.hasSourceAudio} />,
                }] : []),
                ...voiceConnectionDetails({ voice: roomVoiceSnapshot, metrics: voiceMetrics, t,
                  peerName: id => viewers.find(viewer => viewer.peerId === id)?.label ?? t("common.name.viewerDefault") }),
              ]} />
            </Row>
          ) : null}
          {showConnectionDetails && viewerOverviewEntries.length > 0 ? (
            <ViewerOverview
              entries={viewerOverviewEntries}
              pictureActive={phase === "live"}
              voice={roomVoiceSnapshot}
              voiceMetrics={voiceMetrics}
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
              onClose={() => setSelectedPawn(null)}
              voiceDetails={voiceConnectionDetails({ voice: roomVoiceSnapshot, peerId: selectedViewer.peerId, metrics: voiceMetrics, t,
                peerName: id => id === hostPeerId ? displayName : viewers.find(viewer => viewer.peerId === id)?.label ?? t("common.name.viewerDefault") })}
            />
          ) : null}
          {showTopology ? (
            <Row sub>
              <RouteTree
                hostPeerId={hostPeerId}
                pictureActive={phase === "live"}
                voice={roomVoice}
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
