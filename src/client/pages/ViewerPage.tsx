import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_QUALITY_SETTINGS,
  DEFAULT_ROUTE_POLICY,
  MAX_VIEWER_PASSWORD_LENGTH,
  viewerPasswordSchema,
  type IceConfig,
  type ParticipantPresenceEntry,
  type ParticipantRouteAssignment,
  type ServerMessage,
  type RoutePolicy,
} from "../../shared/protocol";
import { qualityLimitationSummary } from "../components/connection-details";
import {
  viewerReconnectRoute,
  viewerRouteEvidence,
} from "../components/status-badge-model";
import { AppHeader, LedStrip, type LedState } from "../components/living/Header";
import { Couch, type CouchEntry } from "../components/living/Couch";
import { MetricCells, useMetricsExpanded } from "../components/living/Metrics";
import { PawnDetail, RouteGlyph } from "../components/living/PawnDetail";
import { Lcd } from "../components/living/RoomChip";
import { RouteTree } from "../components/living/RouteTree";
import { Comic, type ComicKind } from "../components/living/Comic";
import { ComicTooltip } from "../components/living/ComicTooltip";
import type { HintKind } from "../components/living/hints";
import {
  StageOverlay,
  StageTv,
  type ChinState,
} from "../components/living/Stage";
import { BrandLoader } from "../components/living/BrandMark";
import {
  Btn,
  FieldCap,
  NameTag,
  Pill,
  Row,
  StatusText,
} from "../components/living/primitives";
import { Glyph, type GlyphName } from "../ui/icons";
import { useCopy, type CopyKey } from "../ui/copy";
import {
  defaultViewerDisplayName,
  readDisplayName,
  readStoredDisplayName,
  saveDisplayName,
} from "../lib/display-name";
import { useDocumentTitle } from "../ui/document-title";
import { clearViewerGrant, getStableClientId } from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import { labelParticipantSnapshot } from "../lib/viewer-presence";
import {
  P2pQualityProbe,
  type CandidateQualityProbeResult,
} from "../media/candidate-quality-probe";
import { DecodedFrameStallDetector } from "../media/decoded-frame-stall";
import type { QualitySettings } from "../media/quality";
import { relayCapacityMessageForBrowser } from "../media/relay-capability";
import { SfuStandbyPrewarmer } from "../media/sfu-standby-prewarmer";
import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
} from "../media/sender-quality-evidence";
import {
  metricsFromQualityEvidence,
  nextViewerQualityEvidencePresentationExpiryAt,
  presentViewerQualityEvidence,
  qualityEvidenceMatchesSnapshot,
  reconcileViewerQualityEvidencePresentation,
  refreshViewerQualityEvidencePresentation,
  type ViewerQualityEvidencePresentation,
  ViewerQualityEvidenceReporter,
} from "../media/viewer-quality-evidence";
import { ViewerMessageAuthority } from "../media/viewer-message-authority";
import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  deriveViewerPresentation,
  reduceViewerPresentation,
  viewerFailureFromServerCode,
  type ViewerNoticeKey,
  type ViewerPresentationAction,
  type ViewerRouteKind,
  type ViewerStage,
} from "../media/viewer-presentation";
import { prepareViewerPlayback } from "../media/viewer-playback";
import {
  isAutoplayPolicyRejection,
  observeCompositedVideoFrame,
} from "../media/video-frame-proof";
import { exactPeerSignalOwner } from "../media/route-transition";
import { ViewerSfuRoute } from "../media/viewer-sfu-route";
import type {
  ConnectionMetrics,
  PeerSnapshot,
} from "../types";
import {
  createOwnedViewerRestartSender,
  limitMediaAssignment,
  MAX_ENDPOINT_MEDIA_CHILDREN,
  type MediaAssignment,
  viewerSignalMessage,
} from "../webrtc/media-assignment";
import { ViewerPeer } from "../webrtc/viewer-peer";
import { ViewerRelay } from "../webrtc/viewer-relay";

interface ViewerPageProps {
  roomId: string;
  viewerGrant?: string;
}

type ViewerQualityEvidence = Extract<
  ServerMessage,
  { type: "viewer-quality-evidence" }
>;
interface SfuUpstreamState {
  connectionState: "connected" | "reconnecting";
  metrics: ConnectionMetrics | null;
}
interface PendingPeerRoute {
  revision: number;
  parentPeerId: string;
  peer: ViewerPeer | null;
  decodedFrame: boolean;
  connectedSent: boolean;
  readySent: boolean;
  candidateConnectionId: string;
  stream: MediaStream | null;
  snapshot: PeerSnapshot | null;
  qualityProbe: P2pQualityProbe | null;
  qualityResult: CandidateQualityProbeResult;
}

interface RemoteMediaBinding {
  stream: MediaStream;
  generation: number;
  boundAtRevision: number;
  videoTrackKey: string;
}

function stageOverlayGlyph(stage: ViewerStage): { icon: GlyphName; spin: boolean } {
  switch (stage) {
    case "needs-play":
      return { icon: "play", spin: false };
    case "host-paused":
      return { icon: "pause", spin: false };
    case "host-offline":
      return { icon: "wifiOff", spin: false };
    case "route-failed":
    case "playback-failed":
    case "server-error":
    case "stale-client":
    case "session-replaced":
    case "signal-terminated":
      return { icon: "alert", spin: false };
    case "recovering":
    case "waiting-sfu":
    case "preparing-p2p":
    case "preparing-sfu":
    case "receiving":
    case "allocating":
      return { icon: "loader", spin: true };
    case "waiting-host":
      return { icon: "moon", spin: false };
    default:
      return { icon: "tv", spin: false };
  }
}

// Visual mode tells the stage as a panel comic; the glyph stays as its marker.
function stageOverlayComic(
  stage: ViewerStage,
  route: "p2p" | "sfu" | null,
): ComicKind | undefined {
  switch (stage) {
    case "waiting-host":
      return "waiting-for-host";
    case "preparing-p2p":
      return "connecting-p2p";
    case "preparing-sfu":
    case "waiting-sfu":
      return "connecting-sfu";
    case "needs-play":
      return "tap-to-play";
    case "host-paused":
      return "host-paused";
    case "recovering":
      return "recovering";
    case "route-failed":
      return "route-failed";
    case "server-error":
    case "stale-client":
    case "session-replaced":
    case "signal-terminated":
      return "warning";
    case "playback-failed":
      return "playback-failed";
    case "host-offline":
      return "host-offline";
    case "receiving":
    case "allocating":
      return route === "sfu" ? "connecting-sfu" : "connecting-p2p";
    default:
      return undefined;
  }
}

function viewerNoticeVisual(
  noticeKey: ViewerNoticeKey,
): { icon: GlyphName; comic: ComicKind } {
  switch (noticeKey) {
    case "viewer.notice.hostOffline":
      return { icon: "wifiOff", comic: "host-offline" };
    case "viewer.notice.signalRecovering":
      return { icon: "wifiOff", comic: "recovering" };
    case "viewer.notice.mediaRecovering":
      return { icon: "refresh", comic: "recovering" };
  }
}

function stageChin(stage: ViewerStage): ChinState {
  switch (stage) {
    case "playing":
      return "on";
    case "host-paused":
    case "recovering":
      return "warn";
    case "route-failed":
    case "playback-failed":
    case "host-offline":
    case "server-error":
    case "stale-client":
    case "session-replaced":
    case "signal-terminated":
      return "bad";
    case "waiting-host":
      return "off";
    default:
      return "busy";
  }
}

function MeterTag({ icon, label }: { icon: GlyphName; label: string }) {
  const { vis } = useCopy();
  return (
    <span className="lr-meter-tag" title={vis ? undefined : label} role="img" aria-label={label}>
      <Glyph name={icon} size={17} />
      {vis ? null : <span className="lr-cap">{label}</span>}
    </span>
  );
}

export function ViewerPage({ roomId, viewerGrant }: ViewerPageProps) {
  const { lang, t, vis, titleFrames } = useCopy();
  const viewerClientId = useMemo(
    () => getStableClientId("viewer", roomId),
    [roomId],
  );
  const [presentationState, dispatchPresentationState] = useReducer(
    reduceViewerPresentation,
    INITIAL_VIEWER_PRESENTATION_STATE,
  );
  const presentation = deriveViewerPresentation(presentationState);
  const accessState = presentationState.access;
  const signalStatus = presentationState.signal;
  const [remoteMedia, setRemoteMedia] = useState<RemoteMediaBinding | null>(
    null,
  );
  const [peerSnapshot, setPeerSnapshot] = useState<PeerSnapshot | null>(null);
  const [sfuUpstream, setSfuUpstream] = useState<SfuUpstreamState | null>(null);
  const [assignedRoute, setAssignedRoute] = useState<{
    revision: number;
    phase: "prepare" | "active";
    upstream: ParticipantRouteAssignment["upstream"];
  } | null>(null);
  const [relaySnapshot, setRelaySnapshot] = useState<PeerSnapshot | null>(null);
  const [relayChildEvidence, setRelayChildEvidence] =
    useState<ViewerQualityEvidencePresentation | null>(null);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [theaterMode, setTheaterMode] = useState(false);
  const [hasCustomDisplayName, setHasCustomDisplayName] = useState(
    () => readStoredDisplayName() !== null,
  );
  const [displayName, setDisplayName] = useState(() =>
    readDisplayName(defaultViewerDisplayName(viewerClientId, vis)),
  );
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameError, setDisplayNameError] = useState(false);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [participantPresence, setParticipantPresence] = useState<
    ParticipantPresenceEntry[] | null
  >(null);
  const [lastHostDisplayName, setLastHostDisplayName] = useState<string | null>(
    null,
  );
  const [viewerPasswordDraft, setViewerPasswordDraft] = useState("");
  const [viewerPasswordError, setViewerPasswordError] = useState<CopyKey | null>(
    null,
  );
  const [viewerPasswordAttempt, setViewerPasswordAttempt] = useState<{
    password: string;
    sequence: number;
  } | null>(null);
  const [viewerPasswordExpanded, setViewerPasswordExpanded] = useState(false);
  // Presentation-only: which couch pawn is drilled into, and this viewer's
  // own peer id (mirrors the authenticated message for couch/route-tree).
  const [selectedPawn, setSelectedPawn] = useState<string | null>(null);
  const [selfPeerId, setSelfPeerId] = useState<string | null>(null);
  const [routeMetricsExpanded, setRouteMetricsExpanded] = useMetricsExpanded();
  const [relayMetricsExpanded, setRelayMetricsExpanded] = useMetricsExpanded();
  const [downstreamMetricsExpanded, setDownstreamMetricsExpanded] =
    useMetricsExpanded();
  const [pawnMetricsExpanded, setPawnMetricsExpanded] = useMetricsExpanded();

  const mediaProofGeneration = presentationState.media?.generation ?? null;
  const mediaProofEpoch = presentationState.media?.proofEpoch ?? null;
  useEffect(() => {
    if (!theaterMode) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTheaterMode(false);
    };
    document.body.classList.add("lr-theater-open");
    window.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.classList.remove("lr-theater-open");
      window.removeEventListener("keydown", exitOnEscape);
    };
  }, [theaterMode]);

  const qualityLimitation = useMemo(
    () =>
      qualityLimitationSummary(
        [peerSnapshot, relaySnapshot].filter(
          (snapshot): snapshot is PeerSnapshot => snapshot !== null,
        ),
      ),
    [peerSnapshot, relaySnapshot],
  );
  const { host: labeledHostPresence, viewers } = useMemo(
    () => labelParticipantSnapshot(participantPresence ?? []),
    [participantPresence],
  );
  const currentHostDisplayName = labeledHostPresence?.label ?? null;
  const hostDisplayName = currentHostDisplayName ?? lastHostDisplayName;
  const titleFrameKey =
    presentationState.host === "paused"
      ? "paused"
      : presentation.hasCurrentFrame
        ? "viewerActive"
        : "viewerWaiting";
  const titleContent = titleFrames(titleFrameKey);
  useDocumentTitle(
    [
      accessState === "ready" ? roomId : null,
      accessState === "ready" ? titleContent[0] : null,
    ],
    accessState === "ready" ? titleContent.slice(1) : [],
  );

  function clearParticipantPresence(): void {
    setParticipantPresence(null);
    setLastHostDisplayName(null);
  }

  function clearHostPresence(forgetDisplayName = true): void {
    setParticipantPresence((current) =>
      current?.filter((participant) => participant.role !== "host") ?? null,
    );
    if (forgetDisplayName) {
      setLastHostDisplayName(null);
    }
  }

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<ViewerPeer | null>(null);
  const viewerSfuRouteRef = useRef<ViewerSfuRoute | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const presentationStateRef = useRef(presentationState);
  presentationStateRef.current = presentationState;
  function dispatchPresentation(action: ViewerPresentationAction): void {
    presentationStateRef.current = reduceViewerPresentation(
      presentationStateRef.current,
      action,
    );
    dispatchPresentationState(action);
  }
  const qualityEvidenceReporterRef =
    useRef<ViewerQualityEvidenceReporter | null>(null);
  const qualityFrameProofGenerationRef = useRef<number | null>(null);
  const displayNameRef = useRef(displayName);
  useEffect(() => {
    if (hasCustomDisplayName) return;
    const fallback = defaultViewerDisplayName(viewerClientId, vis);
    if (displayNameRef.current === fallback) return;
    displayNameRef.current = fallback;
    setDisplayName(fallback);
    if (!editingDisplayName) setDisplayNameDraft(fallback);
    signalRef.current?.setViewerDisplayName(fallback);
  }, [hasCustomDisplayName, lang, vis, viewerClientId]);
  const remoteMediaRef = useRef<RemoteMediaBinding | null>(null);
  const mediaGenerationRef = useRef(0);
  const hostPlaybackPauseRef = useRef({ active: false, resume: false });
  const routePresentation = viewerRouteEvidence(
    assignedRoute?.upstream ?? null,
    peerSnapshot,
    sfuUpstream,
  );
  const peerConnectionIdentity = peerRef.current?.getConnectionIdentity() ?? null;
  const reconnectRoute = viewerReconnectRoute(
    assignedRoute?.upstream ?? null,
    peerSnapshot,
    sfuUpstream,
    peerConnectionIdentity,
  );
  const reconnectAvailable =
    signalStatus === "connected" &&
    reconnectRoute !== null &&
    presentationState.connection !== "reconnecting";
  const routeMetrics = routePresentation.evidence?.metrics ?? null;

  function bindRemoteStream(stream: MediaStream, revision: number): void {
    const videoTrackKey = stream
      .getVideoTracks()
      .map((track) => track.id)
      .sort()
      .join(":");
    const current = remoteMediaRef.current;
    if (
      current?.stream === stream &&
      current.videoTrackKey === videoTrackKey
    ) {
      return;
    }
    const next: RemoteMediaBinding = {
      stream,
      boundAtRevision: revision,
      videoTrackKey,
      generation: ++mediaGenerationRef.current,
    };
    invalidateQualityPresentation();
    remoteMediaRef.current = next;
    setRemoteMedia(next);
    dispatchPresentation({
      type: "media-bound",
      generation: next.generation,
      revision: next.boundAtRevision,
    });
  }

  function clearRemoteMedia(): void {
    invalidateQualityPresentation();
    remoteMediaRef.current = null;
    setRemoteMedia(null);
    dispatchPresentation({ type: "media-cleared" });
  }

  function resetCurrentFrameProof(): void {
    const binding = remoteMediaRef.current;
    if (!binding) {
      return;
    }
    dispatchPresentation({
      type: "frame-proof-reset",
      generation: binding.generation,
      revision: binding.boundAtRevision,
    });
  }

  function rearmCurrentFrameProof(): void {
    const binding = remoteMediaRef.current;
    if (!binding) {
      return;
    }
    dispatchPresentation({
      type: "frame-proof-rearm",
      generation: binding.generation,
    });
  }

  function invalidateQualityPresentation(): void {
    qualityEvidenceReporterRef.current?.invalidatePresentation();
    qualityFrameProofGenerationRef.current = null;
  }

  function invalidatePresentedMedia(): void {
    invalidateQualityPresentation();
    resetCurrentFrameProof();
  }

  function mediaBindingIsCurrent(binding: RemoteMediaBinding): boolean {
    const current = remoteMediaRef.current;
    return (
      current?.generation === binding.generation &&
      current.stream === binding.stream
    );
  }

  function attemptPlayback(
    video: HTMLVideoElement,
    binding: RemoteMediaBinding,
  ): void {
    void video.play().then(
      () => {
        if (!mediaBindingIsCurrent(binding)) {
          return;
        }
        dispatchPresentation({
          type: "autoplay-cleared",
          generation: binding.generation,
        });
      },
      (error: unknown) => {
        if (!mediaBindingIsCurrent(binding)) {
          return;
        }
        invalidatePresentedMedia();
        if (isAutoplayPolicyRejection(error)) {
          dispatchPresentation({
            type: "autoplay-blocked",
            generation: binding.generation,
            revision: binding.boundAtRevision,
          });
        } else {
          dispatchPresentation({
            type: "playback-failed",
            generation: binding.generation,
            revision: binding.boundAtRevision,
          });
        }
      },
    );
  }

  function acceptAssignedRoute(
    revision: number,
    upstream: ParticipantRouteAssignment["upstream"],
    phase: "prepare" | "active" = "active",
  ): void {
    setAssignedRoute((current) =>
      current && revision < current.revision
        ? current
        : { revision, phase, upstream },
    );
    dispatchPresentation({
      type: "route",
      revision,
      phase,
      kind: routeKindFromAssignment(upstream),
    });
  }

  useEffect(() => {
    let active = true;
    let currentIceConfig: IceConfig | null = null;
    let currentHostOnline = false;
    let currentHostPaused = false;
    let peerAssisted = false;
    let currentPeerId: string | null = null;
    let currentRouteRevision = 0;
    let currentRouteAssignment: ParticipantRouteAssignment | null = null;
    let currentRouteConnectionId: string | null = null;
    let activePeerMetrics: ConnectionMetrics | null = null;
    let pendingRouteConnection: {
      revision: number;
      connectionId: string;
    } | null = null;
    let endpointMediaCopyCapacity = MAX_ENDPOINT_MEDIA_CHILDREN;
    let viewerAuthorizationGeneration: string | null = null;
    let currentQualitySettings: QualitySettings = DEFAULT_QUALITY_SETTINGS;
    let currentRoutePolicy: RoutePolicy = DEFAULT_ROUTE_POLICY;
    let currentShareGeneration: string | null = null;
    let currentAssignment: MediaAssignment = {
      parentPeerId: null,
      childPeerIds: [],
    };
    let viewerRelay: ViewerRelay | null = null;
    let viewerSfuRoute: ViewerSfuRoute | null = null;
    let preparedParentPeerId: string | null = null;
    let preparedParentSignals: Array<
      Extract<ServerMessage, { type: "signal" }>
    > = [];
    let pendingPeer: PendingPeerRoute | null = null;
    const decodedFrameStall = new DecodedFrameStallDetector();
    const messageAuthority = new ViewerMessageAuthority();
    let sfuStandbyPrewarmer: SfuStandbyPrewarmer | null = null;
    let relayChildEvidenceCurrent: ViewerQualityEvidencePresentation | null =
      null;
    let relayChildEvidenceTimer: number | null = null;
    let sfuTransportConnected = false;

    let pageSuspended = document.visibilityState !== "visible";
    const syncDecodedFrameStallPause = (): void => {
      decodedFrameStall.setPaused(currentHostPaused || pageSuspended);
    };
    const suspendForPageLifecycle = (): void => {
      invalidatePresentedMedia();
      const newlySuspended = !pageSuspended;
      pageSuspended = true;
      viewerSfuRoute?.resetQualityProbe();
      pendingPeer?.qualityProbe?.reset();
      if (pendingPeer) pendingPeer.qualityResult = "pending";
      syncDecodedFrameStallPause();
      if (newlySuspended) {
        invalidateSenderQualityEvidence();
        if (currentRoutePolicy.topologyOptimization) {
          signal.send({ type: "reset-sender-quality" });
        }
      }
    };
    const recoverFromPageLifecycle = (): void => {
      invalidatePresentedMedia();
      pageSuspended = document.visibilityState !== "visible";
      syncDecodedFrameStallPause();
      if (pageSuspended) return;
      decodedFrameStall.rebaseline();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        recoverFromPageLifecycle();
      } else {
        suspendForPageLifecycle();
      }
    };
    syncDecodedFrameStallPause();
    document.addEventListener("freeze", suspendForPageLifecycle);
    document.addEventListener("resume", recoverFromPageLifecycle);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", suspendForPageLifecycle);
    window.addEventListener("pageshow", recoverFromPageLifecycle);

    function setSfuStandbyUrl(url: string | null | undefined): void {
      if (!url) {
        sfuStandbyPrewarmer?.setUrl(null);
        return;
      }
      sfuStandbyPrewarmer ??= new SfuStandbyPrewarmer();
      sfuStandbyPrewarmer.setUrl(url);
    }

    const signal = new SignalingClient(
      {
        roomId,
        role: "viewer",
        clientId: viewerClientId,
        ...(viewerGrant ? { viewerGrant } : {}),
        ...(!viewerGrant && viewerPasswordAttempt
          ? { viewerPassword: viewerPasswordAttempt.password }
          : {}),
        displayName: displayNameRef.current,
        viewerPresence: true,
      },
      {
        onStatus: (status) => {
          if (active) {
            if (status !== "connected") decodedFrameStall.allowReportRetry();
            dispatchPresentation({ type: "signal", signal: status });
          }
        },
        onTerminated: (reason) => {
          if (!active) {
            return;
          }
          messageAuthority.invalidate();
          setSfuStandbyUrl(null);
          setAssignedRoute(null);
          clearViewerSfuRoute();
          clearPeerState(true);
          clearParticipantPresence();
          dispatchPresentation({
            type: "access",
            access: "denied",
            failure: reason,
          });
        },
        onAccessRequired: () => {
          if (active) {
            messageAuthority.invalidate();
            setSfuStandbyUrl(null);
            setAssignedRoute(null);
            clearViewerSfuRoute();
            clearPeerState(true);
            clearParticipantPresence();
            dispatchPresentation({
              type: "access",
              access: "denied",
              failure: "INVALID_TOKEN",
            });
          }
        },
        onMessage: (message) => {
          if (!active) {
            return;
          }
          void handleMessage(message, messageAuthority.tokenFor(message));
        },
      },
    );
    signalRef.current = signal;
    const qualityEvidenceReporter = new ViewerQualityEvidenceReporter(
      (message) => active && signal.send(message),
    );
    qualityEvidenceReporterRef.current = qualityEvidenceReporter;
    function qualityPresentationEligible(
      connectionConnected: boolean,
    ): boolean {
      const state = presentationStateRef.current;
      const binding = remoteMediaRef.current;
      const video = videoRef.current;
      return Boolean(
        connectionConnected &&
          !pageSuspended &&
          document.visibilityState === "visible" &&
          !currentHostPaused &&
          currentRouteAssignment !== null &&
          currentRouteAssignment.upstream.kind !== "none" &&
          currentRouteConnectionId !== null &&
          binding &&
          qualityFrameProofGenerationRef.current === binding.generation &&
          state.routeStatus?.state !== "failed" &&
          video &&
          !video.paused &&
          !video.ended,
      );
    }
    function offerPeerQualityEvidence(
      snapshot: PeerSnapshot,
      peer: ViewerPeer,
    ): void {
      const connectionHealthy =
        snapshot.connectionState === "connected" && !peer.isRecovering();
      const qualityEligible =
        qualityPresentationEligible(connectionHealthy);
      if (!connectionHealthy) {
        invalidatePresentedMedia();
        return;
      }
      if (!qualityEligible) {
        invalidateQualityPresentation();
      }
      qualityEvidenceReporter.offer(
        snapshot,
        currentRouteRevision,
        qualityEligible,
      );
    }
    function activateRouteIdentity(
      revision: number,
      assignment: ParticipantRouteAssignment,
      connectionId: string | null,
    ): void {
      currentRouteRevision = revision;
      currentRouteAssignment = assignment;
      currentRouteConnectionId =
        assignment.upstream.kind === "none" ? null : connectionId;
      if (assignment.upstream.kind !== "peer") {
        activePeerMetrics = null;
      }
      pendingRouteConnection = null;
    }

    function commitRelayChildEvidence(
      presentation: ViewerQualityEvidencePresentation | null,
    ): void {
      if (relayChildEvidenceTimer !== null) {
        window.clearTimeout(relayChildEvidenceTimer);
        relayChildEvidenceTimer = null;
      }
      const current = relayChildEvidenceCurrent;
      relayChildEvidenceCurrent = presentation;
      if (current !== presentation) {
        setRelayChildEvidence(presentation);
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
      relayChildEvidenceTimer = window.setTimeout(() => {
        if (relayChildEvidenceCurrent !== expected) {
          return;
        }
        commitRelayChildEvidence(
          refreshViewerQualityEvidencePresentation(expected),
        );
      }, Math.max(0, expiryAt - nowMs));
    }

    function clearRelayChildEvidence(): void {
      commitRelayChildEvidence(null);
    }

    function acceptRelayChildEvidence(evidence: ViewerQualityEvidence): void {
      const relaySnapshot =
        viewerRelay?.getSnapshot(evidence.viewerPeerId) ?? null;
      if (
        !peerAssisted ||
        evidence.upstream.kind !== "peer" ||
        evidence.upstream.peerId !== currentPeerId ||
        evidence.guard.routeRevision !== currentRouteRevision ||
        !qualityEvidenceMatchesSnapshot(evidence, relaySnapshot)
      ) {
        return;
      }
      commitRelayChildEvidence(
        presentViewerQualityEvidence(
          relayChildEvidenceCurrent,
          evidence,
        ),
      );
    }

    function ensureViewerRelay(): ViewerRelay | null {
      if (viewerRelay) {
        return viewerRelay;
      }
      if (!peerAssisted || !currentIceConfig) {
        return null;
      }
      viewerRelay = new ViewerRelay(
        currentIceConfig,
        currentQualitySettings,
        {
          sendSignal: (targetPeerId, payload) =>
            active && peerAssisted
              ? signal.send({
                  type: "signal",
                  targetPeerId,
                  payload,
                })
              : false,
          onUpdate: (snapshot) => {
            if (active) {
              setRelaySnapshot(snapshot);
              if (relayChildEvidenceCurrent) {
                const reconciled =
                  reconcileViewerQualityEvidencePresentation(
                    relayChildEvidenceCurrent,
                    viewerRelay?.getSnapshot(
                      relayChildEvidenceCurrent.evidence.viewerPeerId,
                    ) ?? null,
                  );
                if (reconciled !== relayChildEvidenceCurrent) {
                  commitRelayChildEvidence(reconciled);
                }
              }
            }
          },
          onSenderUpdate: (snapshot, preparedRevision) => {
            if (
              !active ||
              pageSuspended ||
              !currentRoutePolicy.topologyOptimization
            ) {
              return;
            }
            const evidence = senderQualityEvidenceFromSnapshot(
              snapshot,
              preparedRevision ?? currentRouteRevision,
            );
            if (evidence) {
              signal.send(evidence);
            }
          },
        },
        endpointMediaCopyCapacity,
      );
      viewerRelay.setChildren(currentAssignment.childPeerIds);
      return viewerRelay;
    }

    function reconcileRelayChildren(
      previousChildPeerIds: readonly string[],
      activeRevision?: number,
    ): void {
      const nextChildPeerIds = currentAssignment.childPeerIds;
      const changed =
        previousChildPeerIds.length !== nextChildPeerIds.length ||
        previousChildPeerIds.some(
          (peerId, index) => peerId !== nextChildPeerIds[index],
        );
      if (changed) {
        clearRelayChildEvidence();
      }
      const relay = ensureViewerRelay();
      if (activeRevision === undefined) {
        relay?.setChildren(nextChildPeerIds);
      } else {
        relay?.activateChildren(activeRevision, nextChildPeerIds);
      }
    }

    function discardPendingPeer(): void {
      const probe = pendingPeer;
      pendingPeer = null;
      prepareParent(null);
      probe?.peer?.dispose();
    }

    function reportActivePeerFailure(
      parentPeerId: string,
      connectionId: string,
      peer: ViewerPeer,
    ): boolean {
      if (
        currentRouteAssignment?.upstream.kind !== "peer" ||
        currentRouteAssignment.upstream.peerId !== parentPeerId ||
        peerRef.current !== peer ||
        peer.getConnectionIdentity()?.parentPeerId !== parentPeerId ||
        !peer.hasConnectionId(connectionId)
      ) {
        return true;
      }
      return (
        viewerSfuRoute?.reportPeerFailure(
          parentPeerId,
          connectionId,
        ) ?? true
      );
    }

    function observeActiveDecodedFrames(
      route: "peer" | "sfu",
      identity: string,
      framesDecodedDelta: number | null,
      authorityRevision: number,
      connectionId?: string,
    ): void {
      if (
        !peerAssisted ||
        currentHostPaused ||
        !decodedFrameStall.observe(`${route}:${identity}`, framesDecodedDelta)
      ) {
        return;
      }
      if (authorityRevision !== currentRouteRevision) {
        decodedFrameStall.allowReportRetry();
        return;
      }
      let sent = false;
      if (route === "peer" && connectionId) {
        sent = signal.send({
          type: "route-failed",
          revision: authorityRevision,
          phase: "active",
          connectionId,
        });
      } else if (route === "sfu") {
        sent = signal.send({
          type: "route-media-unavailable",
          revision: authorityRevision,
        });
      }
      if (!sent) decodedFrameStall.allowReportRetry();
    }

    function pendingPeerHasDecodedFrame(
      probe: PendingPeerRoute,
    ): probe is PendingPeerRoute & { peer: ViewerPeer; snapshot: PeerSnapshot } {
      const { snapshot } = probe;
      return (
        snapshot !== null &&
        snapshot.peerId === probe.parentPeerId &&
        probe.peer?.hasConnectionId(snapshot.connectionId) === true &&
        probe.decodedFrame
      );
    }

    function provePendingPeer(): boolean {
      const probe = pendingPeer;
      if (!probe || probe.readySent) {
        return true;
      }
      if (
        !probe.connectedSent &&
        probe.snapshot?.connectionState === "connected" &&
        probe.snapshot.connectionId === probe.candidateConnectionId
      ) {
        probe.connectedSent = signal.send({
          type: "route-transport-connected",
          revision: probe.revision,
          connectionId: probe.candidateConnectionId,
        });
      }
      if (!pendingPeerHasDecodedFrame(probe)) {
        return false;
      }
      if (probe.qualityProbe && probe.qualityResult !== "approved") {
        return false;
      }
      probe.readySent = signal.send({
        type: "route-ready",
        revision: probe.revision,
        phase: "prepare",
        ...(probe.qualityProbe ? { qualityApproved: true as const } : {}),
      });
      return probe.readySent;
    }

    function ensureViewerSfuRoute(): ViewerSfuRoute {
      if (viewerSfuRoute) {
        return viewerSfuRoute;
      }
      let route: ViewerSfuRoute;
      route = new ViewerSfuRoute(currentPeerId!, {
        activatePeer: async (assignment, revision) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          if (revision !== undefined) {
            const probe = pendingPeer;
            if (
              !probe ||
              !probe.readySent ||
              probe.revision !== revision ||
              assignment.upstream.kind !== "peer" ||
              assignment.upstream.peerId !== probe.parentPeerId ||
              !probe.peer ||
              !probe.stream ||
              !probe.snapshot
            ) {
              discardPendingPeer();
              return false;
            }
            const previousPeer = peerRef.current;
            probe.peer.stopDecodedFrameProof();
            pendingPeer = null;
            prepareParent(null);
            peerRef.current = probe.peer;
            previousPeer?.dispose();
            applyMediaAssignment(
              {
                parentPeerId: probe.parentPeerId,
                childPeerIds: currentAssignment.childPeerIds,
              },
              true,
            );
            ensureViewerRelay()?.setStream(probe.stream);
            bindRemoteStream(probe.stream, revision);
            setPeerSnapshot(probe.snapshot);
            setSfuUpstream(null);
            return true;
          }
          applyMediaAssignment({
            parentPeerId:
              assignment.upstream.kind === "peer"
                ? assignment.upstream.peerId
                : null,
            childPeerIds: currentAssignment.childPeerIds,
          });
          if (assignment.upstream.kind === "peer") {
            await drainPreparedParentSignals(assignment.upstream.peerId);
          }
        },
        preparePeer: (assignment, revision, candidate) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          discardPendingPeer();
          if (
            revision !== undefined &&
            candidate &&
            candidate.childPeerId === currentPeerId &&
            candidate.transport !== "sfu" &&
            assignment?.upstream.kind === "peer"
          ) {
            pendingPeer = {
              revision,
              parentPeerId: assignment.upstream.peerId,
              peer: null,
              decodedFrame: false,
              connectedSent: false,
              readySent: false,
              candidateConnectionId: candidate.connectionId,
              stream: null,
              snapshot: null,
              qualityProbe: candidate.qualityProbe
                ? new P2pQualityProbe()
                : null,
              qualityResult: "pending",
            };
          }
          prepareParent(
            assignment?.upstream.kind === "peer"
              ? assignment.upstream.peerId
              : null,
          );
        },
        prepareChild: (candidate, childPeerIds, revision) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          if (candidate && childPeerIds && revision !== undefined) {
            ensureViewerRelay()?.prepareChild(revision, candidate, childPeerIds);
          } else {
            viewerRelay?.discardPreparedChild();
          }
        },
        resetMedia: () => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          currentAssignment = { parentPeerId: null, childPeerIds: [] };
          sfuTransportConnected = false;
          setSfuUpstream(null);
          clearPeerState();
          viewerRelay?.setChildren([]);
        },
        activateChildren: (childPeerIds, revision) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          const previousChildPeerIds = currentAssignment.childPeerIds;
          currentAssignment = limitMediaAssignment(
            {
              parentPeerId: currentAssignment.parentPeerId,
              childPeerIds: [...childPeerIds],
            },
            endpointMediaCopyCapacity,
          );
          reconcileRelayChildren(previousChildPeerIds, revision);
        },
        onSfuDecodedFrameSample: (
          framesDecodedDelta,
          revision,
          mediaIdentity,
        ) => {
          if (active && viewerSfuRoute === route) {
            observeActiveDecodedFrames(
              "sfu",
              mediaIdentity,
              framesDecodedDelta,
              revision,
            );
          }
        },
        onSfuUpdate: (metrics, revision) => {
          if (active && viewerSfuRoute === route) {
            if (metrics) {
              if (
                currentRouteAssignment?.upstream.kind === "sfu" &&
                currentRouteConnectionId &&
                revision === currentRouteRevision &&
                sfuTransportConnected
              ) {
                qualityEvidenceReporter.offerMetrics(
                  currentRouteConnectionId,
                  metrics,
                  revision,
                  qualityPresentationEligible(sfuTransportConnected),
                );
              }
            }
            setSfuUpstream((current) =>
              metrics && current ? { ...current, metrics } : null,
            );
          }
        },
        currentPeerMetrics: () => activePeerMetrics,
        qualityProbeEligible: () => !pageSuspended,
        onSfuState: (state, revision) => {
          if (active && viewerSfuRoute === route) {
            const connected = state === "connected";
            if (sfuTransportConnected !== connected) {
              sfuTransportConnected = connected;
              if (!connected) {
                invalidatePresentedMedia();
              }
            }
            setSfuUpstream((current) =>
              current ? { ...current, connectionState: state } : null,
            );
            dispatchPresentation({
              type: "connection",
              revision,
              connection: state,
            });
          }
        },
        onSfuVideoAvailability: (available, revision) => {
          if (!active || viewerSfuRoute !== route || available) {
            return;
          }
          invalidatePresentedMedia();
          setSfuUpstream((current) =>
            current ? { ...current, connectionState: "reconnecting" } : current,
          );
          dispatchPresentation({
            type: "connection",
            revision,
            connection: "reconnecting",
          });
        },
        onSfuStream: (
          nextStream,
          assignment,
          initialVideoStream,
          revision,
        ) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          const previousChildPeerIds = currentAssignment.childPeerIds;
          currentAssignment = limitMediaAssignment(
            { parentPeerId: null, childPeerIds: assignment.childPeerIds },
            endpointMediaCopyCapacity,
          );
          reconcileRelayChildren(previousChildPeerIds);
          const relay = ensureViewerRelay();
          relay?.setStream(nextStream);
          bindRemoteStream(nextStream, revision);
          if (initialVideoStream) {
            sfuTransportConnected = true;
          }
          setSfuUpstream(
            (current) =>
              current ?? { connectionState: "connected", metrics: null },
          );
          if (initialVideoStream) {
            if (!pendingPeer) {
              peerRef.current?.dispose();
              peerRef.current = null;
              setPeerSnapshot(null);
            }
          }
        },
        send: (message) =>
          active && viewerSfuRoute === route ? signal.send(message) : false,
      });
      viewerSfuRoute = route;
      viewerSfuRouteRef.current = route;
      return route;
    }

    function clearViewerSfuRoute(): void {
      const route = viewerSfuRoute;
      discardPendingPeer();
      viewerSfuRoute = null;
      sfuTransportConnected = false;
      invalidatePresentedMedia();
      if (viewerSfuRouteRef.current === route) {
        viewerSfuRouteRef.current = null;
      }
      setSfuUpstream(null);
      void route?.disconnect();
    }

    function prepareParent(parentPeerId: string | null): void {
      if (preparedParentPeerId === parentPeerId) {
        return;
      }
      preparedParentPeerId = parentPeerId;
      preparedParentSignals = [];
    }

    async function drainPreparedParentSignals(
      parentPeerId: string,
    ): Promise<void> {
      while (
        active &&
        peerAssisted &&
        preparedParentPeerId === parentPeerId
      ) {
        const message = preparedParentSignals.shift();
        if (!message) {
          preparedParentPeerId = null;
          return;
        }
        const peer = ensurePeer();
        if (!peer) {
          return;
        }
        await peer.acceptSignal(message.fromPeerId, message.payload);
      }
    }

    function clearUpstreamState(clearMedia = false): void {
      qualityEvidenceReporter.reset();
      const peer = peerRef.current;
      peer?.dispose();
      peerRef.current = null;
      activePeerMetrics = null;
      setPeerSnapshot(null);
      if (clearMedia) {
        clearRemoteMedia();
      } else {
        dispatchPresentation({
          type: "connection",
          revision: currentRouteRevision,
          connection: "reconnecting",
        });
      }
    }

    function clearPeerState(clearMedia = false): void {
      clearUpstreamState(clearMedia);
      clearRelayChildEvidence();
      viewerRelay?.stop();
    }

    function applyMediaAssignment(assignment: MediaAssignment, preserveUpstream = false): void {
      const nextAssignment = limitMediaAssignment(
        assignment,
        endpointMediaCopyCapacity,
      );
      const previousParentId = currentAssignment.parentPeerId;
      const previousChildPeerIds = currentAssignment.childPeerIds;
      currentAssignment = nextAssignment;

      if (!preserveUpstream && previousParentId !== nextAssignment.parentPeerId) {
        clearUpstreamState();
      }
      reconcileRelayChildren(previousChildPeerIds);
    }

    function ensurePendingPeerRoute(): ViewerPeer | null {
      const probe = pendingPeer;
      if (!probe || !currentIceConfig) return null;
      if (probe.peer) return probe.peer;
      const peer: ViewerPeer = new ViewerPeer(
        currentIceConfig,
        {
          sendSignal: (targetPeerId, payload) =>
            signal.send(viewerSignalMessage(peerAssisted, targetPeerId, payload)),
          sendRestartRequest: createOwnedViewerRestartSender(
            peerAssisted,
            (targetPeerId, connectionId) => {
              const identity = peer.getConnectionIdentity();
              return (
                active &&
                pendingPeer !== probe &&
                peerRef.current === peer &&
                identity?.parentPeerId === targetPeerId &&
                identity.connectionId === connectionId
              );
            },
            (message) => signal.send(message),
          ),
          onStream: (stream) => {
            if (pendingPeer === probe) {
              probe.stream = stream;
              provePendingPeer();
            } else if (active && peerRef.current === peer) {
              bindRemoteStream(stream, currentRouteRevision);
              ensureViewerRelay()?.setStream(stream);
            }
          },
          onUpdate: (snapshot) => {
            if (pendingPeer === probe) {
              if (snapshot.connectionId !== probe.candidateConnectionId) return;
              probe.snapshot = snapshot;
              if (probe.qualityProbe) {
                if (
                  pageSuspended ||
                  currentHostPaused ||
                  !qualityPresentationEligible(
                    peerRef.current?.isConnected() === true,
                  )
                ) {
                  probe.qualityProbe.reset();
                  probe.qualityResult = "pending";
                } else {
                  probe.qualityResult = probe.qualityProbe.observe(
                    activePeerMetrics,
                    snapshot.metrics,
                  );
                  if (
                    probe.qualityResult === "rejected" &&
                    signal.send({
                      type: "route-failed",
                      revision: probe.revision,
                      phase: "prepare",
                      connectionId: probe.candidateConnectionId,
                    })
                  ) {
                    discardPendingPeer();
                    return;
                  }
                }
              }
              provePendingPeer();
            } else if (active && peerRef.current === peer) {
              activePeerMetrics = snapshot.metrics;
              observeActiveDecodedFrames(
                "peer",
                `${probe.parentPeerId}:${snapshot.connectionId}`,
                snapshot.metrics.intervalFramesDecoded,
                currentRouteRevision,
                snapshot.connectionId,
              );
              offerPeerQualityEvidence(snapshot, peer);
              setPeerSnapshot(snapshot);
              dispatchPresentation({
                type: "connection",
                revision: currentRouteRevision,
                connection: connectionFact(snapshot.connectionState),
              });
            }
          },
          onFirstDecodedFrame: (connectionId): boolean => {
            if (
              pendingPeer !== probe ||
              !peer.hasConnectionId(connectionId) ||
              connectionId !== probe.candidateConnectionId
            ) {
              return true;
            }
            probe.decodedFrame = true;
            return provePendingPeer();
          },
          onRecoveryExhausted: (parentPeerId, connectionId): boolean => {
            if (pendingPeer === probe && peer.hasConnectionId(connectionId)) {
              signal.send({
                type: "route-failed",
                revision: probe.revision,
                phase: "prepare",
                connectionId,
              });
              probe.peer = null;
              probe.stream = null;
              probe.snapshot = null;
              probe.decodedFrame = false;
              probe.connectedSent = false;
              probe.readySent = false;
              peer.dispose();
              return true;
            }
            return peerRef.current === peer
              ? reportActivePeerFailure(parentPeerId, connectionId, peer)
              : true;
          },
        },
      );
      probe.peer = peer;
      return peer;
    }

    function ensurePeer(): ViewerPeer | null {
      if (peerRef.current) {
        return peerRef.current;
      }
      if (!currentIceConfig) {
        return null;
      }
      const peer: ViewerPeer = new ViewerPeer(
        currentIceConfig,
        {
          sendSignal: (targetPeerId, payload) =>
            signal.send(
              viewerSignalMessage(peerAssisted, targetPeerId, payload),
            ),
          sendRestartRequest: createOwnedViewerRestartSender(
            peerAssisted,
            (targetPeerId, connectionId) => {
              const identity = peer.getConnectionIdentity();
              return (
                active &&
                peerRef.current === peer &&
                identity?.parentPeerId === targetPeerId &&
                identity.connectionId === connectionId
              );
            },
            (message) => signal.send(message),
          ),
          onStream: (nextStream) => {
            if (active) {
              bindRemoteStream(nextStream, currentRouteRevision);
              // Audio and video can arrive as separate track events on the
              // same MediaStream, so refresh both downstream senders each time.
              ensureViewerRelay()?.setStream(nextStream);
            }
          },
          onUpdate: (snapshot) => {
            if (active) {
              activePeerMetrics = snapshot.metrics;
              observeActiveDecodedFrames(
                "peer",
                `${snapshot.peerId}:${snapshot.connectionId}`,
                snapshot.metrics.intervalFramesDecoded,
                currentRouteRevision,
                snapshot.connectionId,
              );
              offerPeerQualityEvidence(snapshot, peer);
              if (
                !currentHostOnline &&
                (snapshot.connectionState === "failed" ||
                  snapshot.connectionState === "closed")
              ) {
                clearPeerState();
                invalidatePresentedMedia();
                return;
              }
              setPeerSnapshot(snapshot);
              dispatchPresentation({
                type: "connection",
                revision: currentRouteRevision,
                connection: peer.isRecovering()
                  ? "reconnecting"
                  : connectionFact(snapshot.connectionState),
              });
            }
          },
          onRecoveryExhausted: (
            parentPeerId,
            connectionId,
          ): boolean => {
            if (viewerSfuRoute) {
              return reportActivePeerFailure(
                parentPeerId,
                connectionId,
                peer,
              );
            }
            invalidateQualityPresentation();
            dispatchPresentation({
              type: "route-status",
              revision: currentRouteRevision,
              state: "failed",
            });
            return true;
          },
        },
      );
      peerRef.current = peer;
      return peer;
    }

    async function handleMessage(
      message: ServerMessage,
      authorityToken: number,
    ): Promise<void> {
      if (message.type === "authenticated") {
        dispatchPresentation({ type: "access", access: "ready" });
        setViewerPasswordDraft("");
        setViewerPasswordError(null);
        clearRelayChildEvidence();
        currentPeerId = message.peerId;
        setSelfPeerId(message.peerId);
        endpointMediaCopyCapacity = message.endpointMediaCopyCapacity;
        currentAssignment = limitMediaAssignment(
          currentAssignment,
          endpointMediaCopyCapacity,
        );
        viewerRelay?.updateCapacity(endpointMediaCopyCapacity);
        viewerAuthorizationGeneration =
          message.viewerAuthorizationGeneration;
        setSfuStandbyUrl(
          "sfuStandbyUrl" in message ? message.sfuStandbyUrl : null,
        );
        const nextPeerAssisted =
          "mediaMode" in message && message.mediaMode === "peer-assisted";
        if (!nextPeerAssisted && peerAssisted) {
          clearViewerSfuRoute();
          clearPeerState();
          viewerRelay?.dispose();
          viewerRelay = null;
          currentAssignment = { parentPeerId: null, childPeerIds: [] };
        }
        peerAssisted = nextPeerAssisted;
        const nextRouteRevision =
          nextPeerAssisted && "routeRevision" in message
            ? message.routeRevision
            : 0;
        if (nextRouteRevision !== currentRouteRevision) {
          clearRelayChildEvidence();
        }
        currentRouteRevision = nextRouteRevision;
        if (nextPeerAssisted && "routeAssignment" in message) {
          activateRouteIdentity(
            message.routeRevision,
            message.routeAssignment,
            message.connectionId,
          );
          acceptAssignedRoute(
            message.routeRevision,
            message.routeAssignment.upstream,
          );
        } else {
          currentRouteAssignment = null;
          currentRouteConnectionId = null;
          pendingRouteConnection = null;
          setAssignedRoute(null);
          dispatchPresentation({
            type: "route",
            revision: 0,
            phase: "active",
            kind: message.hostOnline ? "p2p" : "none",
          });
        }
        const relayCapacity = relayCapacityMessageForBrowser(nextPeerAssisted);
        if (relayCapacity) {
          signal.send(relayCapacity);
        }
        currentIceConfig = message.iceConfig;
        currentHostOnline = message.hostOnline;
        const sharingPaused = message.hostPaused ?? false;
        if (currentHostPaused !== sharingPaused && sharingPaused) {
          invalidatePresentedMedia();
        }
        currentHostPaused = sharingPaused;
        syncDecodedFrameStallPause();
        dispatchPresentation({
          type: "host",
          host: sharingPaused
            ? "paused"
            : message.hostOnline
              ? "online"
              : "stopped",
        });
        if (nextPeerAssisted && "qualitySettings" in message) {
          currentQualitySettings = message.qualitySettings;
          currentRoutePolicy = message.routePolicy;
          currentShareGeneration = message.shareGeneration;
          void viewerRelay?.updateProfile(currentQualitySettings);
          const route = ensureViewerSfuRoute();
          route.setPaused(sharingPaused);
          await route.resyncAuthoritative(
            {
              revision: message.routeRevision,
              phase: "active",
              assignment: message.routeAssignment,
            },
            message.peerId,
          );
          if (!active || !messageAuthority.owns(authorityToken)) {
            return;
          }
        }
        if (
          !message.hostOnline &&
          message.connectionId === null &&
          !peerRef.current?.isConnected()
        ) {
          clearPeerState();
        }
        const peer = peerRef.current;
        peer?.updateIceConfig(message.iceConfig);
        viewerRelay?.updateIceConfig(message.iceConfig);
        if (
          message.connectionId &&
          !peer?.hasConnectionId(message.connectionId)
        ) {
          const parentPeerId = currentAssignment.parentPeerId;
          if (!peerAssisted) {
            signal.send({
              type: "restart-request",
              connectionId: message.connectionId,
              rebuild: true,
            });
          } else if (parentPeerId) {
            signal.send({
              type: "restart-request",
              targetPeerId: parentPeerId,
              connectionId: message.connectionId,
              rebuild: true,
            });
          }
        } else if (peer?.hasConnection() && !peer.isConnected()) {
          peer.requestRecovery();
        }
        return;
      }
      if (message.type === "route-update") {
        if (peerAssisted) {
          const result = ensureViewerSfuRoute().accept(message);
          if (result !== "stale") {
            if (
              result === "accepted" &&
              message.phase === "prepare" &&
              message.candidate.childPeerId === currentPeerId
            ) {
              pendingRouteConnection = {
                revision: message.revision,
                connectionId: message.candidate.connectionId,
              };
              if (remoteMediaRef.current === null) {
                acceptAssignedRoute(
                  message.revision,
                  message.assignment.upstream,
                  "prepare",
                );
              }
            }
            if (message.phase === "active") {
              const samePeerUpstream =
                currentRouteAssignment?.upstream.kind === "peer" &&
                message.assignment.upstream.kind === "peer" &&
                currentRouteAssignment.upstream.peerId ===
                  message.assignment.upstream.peerId;
              const sameSfuUpstream =
                currentRouteAssignment?.upstream.kind === "sfu" &&
                message.assignment.upstream.kind === "sfu" &&
                currentRouteAssignment.sfuPublicationGeneration ===
                  message.assignment.sfuPublicationGeneration;
              const connectionId =
                pendingRouteConnection?.revision === message.revision
                  ? pendingRouteConnection.connectionId
                  : samePeerUpstream || sameSfuUpstream
                    ? currentRouteConnectionId
                    : null;
              if (result === "accepted") {
                if (message.revision !== currentRouteRevision) {
                  clearRelayChildEvidence();
                }
                activateRouteIdentity(
                  message.revision,
                  message.assignment,
                  connectionId,
                );
              }
              acceptAssignedRoute(
                message.revision,
                message.assignment.upstream,
                "active",
              );
            }
          }
        }
        return;
      }
      if (message.type === "route-status") {
        if (message.state === "failed") {
          invalidateQualityPresentation();
        }
        dispatchPresentation({
          type: "route-status",
          revision: message.revision,
          state: message.state,
        });
        return;
      }
      if (message.type === "viewer-quality-evidence") {
        acceptRelayChildEvidence(message);
        return;
      }
      if (message.type === "sfu-config") {
        if (peerAssisted) {
          await ensureViewerSfuRoute().acceptConfig(message);
        }
        return;
      }
      if (message.type === "quality-settings") {
        if (peerAssisted) {
          currentQualitySettings = message.qualitySettings;
          void viewerRelay?.updateProfile(currentQualitySettings);
        }
        return;
      }
      if (message.type === "route-policy") {
        if (
          peerAssisted &&
          (currentShareGeneration === null ||
            currentShareGeneration === message.shareGeneration)
        ) {
          currentShareGeneration = message.shareGeneration;
          currentRoutePolicy = message.routePolicy;
          setSfuStandbyUrl(message.sfuStandbyUrl ?? null);
        }
        return;
      }
      if (message.type === "signal") {
        if (peerAssisted && pendingPeer?.parentPeerId === message.fromPeerId) {
          if (currentAssignment.parentPeerId !== message.fromPeerId) {
            await ensurePendingPeerRoute()?.acceptSignal(
              message.fromPeerId,
              message.payload,
            );
            return;
          }
          const activeIdentity = peerRef.current?.getConnectionIdentity();
          const owner = exactPeerSignalOwner(
            message.payload.connectionId,
            pendingPeer.candidateConnectionId,
            activeIdentity?.parentPeerId === message.fromPeerId
              ? activeIdentity.connectionId
              : null,
          );
          if (owner === "pending") {
            await ensurePendingPeerRoute()?.acceptSignal(
              message.fromPeerId,
              message.payload,
            );
          } else if (owner === "active") {
            await peerRef.current?.acceptSignal(
              message.fromPeerId,
              message.payload,
            );
          }
          return;
        }
        if (
          peerAssisted &&
          preparedParentPeerId === message.fromPeerId
        ) {
          preparedParentSignals.push(message);
          return;
        }
        if (
          peerAssisted &&
          viewerRelay &&
          (await viewerRelay.acceptSignal(
            message.fromPeerId,
            message.payload,
            viewerRelay.getSignalRouteRevision(
              message.fromPeerId,
              message.payload.connectionId,
              currentRouteRevision,
            ),
          ))
        ) {
          return;
        }
        if (
          peerAssisted &&
          currentAssignment.parentPeerId !== message.fromPeerId
        ) {
          return;
        }
        const peer = ensurePeer();
        if (!peer) {
          return;
        }
        await peer.acceptSignal(message.fromPeerId, message.payload);
        return;
      }
      if (message.type === "restart-request") {
        if (peerAssisted) {
          await viewerRelay?.recover(
            message.fromPeerId,
            message.connectionId,
            message.rebuild,
          );
        }
        return;
      }
      if (message.type === "host-status") {
        currentHostOnline = message.online;
        if (currentHostPaused !== message.paused && message.paused) {
          invalidatePresentedMedia();
        }
        currentHostPaused = message.paused;
        syncDecodedFrameStallPause();
        dispatchPresentation({
          type: "host",
          host: message.paused
            ? "paused"
            : message.online
              ? "online"
              : "offline",
        });
        viewerSfuRoute?.setPaused(message.paused);
        return;
      }
      if (message.type === "viewer-presence") {
        const hostLabel = labelParticipantSnapshot(message.viewers).host?.label;
        if (hostLabel) {
          setLastHostDisplayName(hostLabel);
        }
        setParticipantPresence(message.viewers);
        return;
      }
      if (message.type === "sharing-stopped") {
        invalidatePresentedMedia();
        currentRouteAssignment = null;
        currentRouteConnectionId = null;
        pendingRouteConnection = null;
        currentShareGeneration = null;
        currentRoutePolicy = DEFAULT_ROUTE_POLICY;
        setSfuStandbyUrl(null);
        setAssignedRoute(null);
        currentHostOnline = false;
        currentHostPaused = false;
        decodedFrameStall.reset();
        syncDecodedFrameStallPause();
        clearViewerSfuRoute();
        clearPeerState(true);
        clearHostPresence();
        dispatchPresentation({ type: "sharing-stopped" });
        return;
      }
      if (message.type === "viewer-grant-revoked") {
        if (
          viewerAuthorizationGeneration !==
          message.viewerAuthorizationGeneration
        ) {
          return;
        }
        viewerAuthorizationGeneration = null;
        clearViewerGrant(roomId);
        setSfuStandbyUrl(null);
        setAssignedRoute(null);
        clearViewerSfuRoute();
        clearPeerState(true);
        clearParticipantPresence();
        dispatchPresentation({
          type: "access",
          access: "denied",
          failure: "INVALID_TOKEN",
        });
        signal.stop();
        return;
      }
      if (message.type === "room-closed") {
        setSfuStandbyUrl(null);
        setAssignedRoute(null);
        clearViewerSfuRoute();
        clearPeerState(true);
        clearParticipantPresence();
        dispatchPresentation({
          type: "access",
          access: "denied",
          failure:
            message.reason === "expired" ? "ROOM_EXPIRED" : "ROOM_CLOSED",
        });
        signal.stop();
        return;
      }
      if (message.type === "error") {
        if (message.code === "PEER_NOT_FOUND" && !currentHostOnline) {
          clearPeerState();
          clearHostPresence(false);
          dispatchPresentation({ type: "host", host: "offline" });
          return;
        }
        if (
          [
            "AUTH_REQUIRED",
            "INVALID_TOKEN",
            "ROOM_NOT_FOUND",
            "ROOM_ACCESS_DENIED",
            "ROOM_EXPIRED",
            "ROOM_FULL",
          ].includes(message.code)
        ) {
          setSfuStandbyUrl(null);
          setAssignedRoute(null);
          clearViewerSfuRoute();
          clearPeerState(true);
          clearParticipantPresence();
          const failure = viewerFailureFromServerCode(message.code);
          dispatchPresentation({
            type: "access",
            access: "denied",
            failure,
          });
        }
        if (message.code === "INVALID_TOKEN") {
          clearViewerGrant(roomId);
          if (!viewerGrant && viewerPasswordAttempt) {
            setViewerPasswordError("join.passwordError");
          }
          return;
        }
        if (message.code === "ROOM_ACCESS_DENIED") {
          if (viewerPasswordAttempt) {
            setViewerPasswordError("viewer.msg.denied");
            setViewerPasswordExpanded(true);
          }
          return;
        }
        const failure = viewerFailureFromServerCode(message.code);
        if (failure === "SERVER_ERROR") {
          dispatchPresentation({ type: "server-error" });
        }
      }
    }

    signal.start();
    return () => {
      active = false;
      document.removeEventListener("freeze", suspendForPageLifecycle);
      document.removeEventListener("resume", recoverFromPageLifecycle);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", suspendForPageLifecycle);
      window.removeEventListener("pageshow", recoverFromPageLifecycle);
      currentPeerId = null;
      qualityEvidenceReporter.reset();
      if (qualityEvidenceReporterRef.current === qualityEvidenceReporter) {
        qualityEvidenceReporterRef.current = null;
      }
      clearRelayChildEvidence();
      sfuStandbyPrewarmer?.dispose();
      signal.stop();
      clearParticipantPresence();
      if (signalRef.current === signal) {
        signalRef.current = null;
      }
      void viewerSfuRoute?.disconnect();
      if (viewerSfuRouteRef.current === viewerSfuRoute) {
        viewerSfuRouteRef.current = null;
      }
      viewerSfuRoute = null;
      preparedParentPeerId = null;
      preparedParentSignals = [];
      peerRef.current?.dispose();
      peerRef.current = null;
      viewerRelay?.dispose();
      viewerRelay = null;
    };
  }, [roomId, viewerGrant, viewerPasswordAttempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !remoteMedia) {
      if (video) {
        video.srcObject = null;
      }
      return;
    }
    if (
      prepareViewerPlayback(
        video,
        remoteMedia.stream,
        presentationState.host === "paused",
      )
    ) {
      attemptPlayback(video, remoteMedia);
    }
  }, [remoteMedia]);

  useEffect(() => {
    const paused = presentationState.host === "paused";
    const pauseState = hostPlaybackPauseRef.current;
    const video = videoRef.current;
    if (paused) {
      if (!pauseState.active) {
        pauseState.active = true;
        pauseState.resume = video && remoteMedia ? !video.paused : true;
      }
      video?.pause();
      return;
    }
    if (!pauseState.active) {
      return;
    }
    pauseState.active = false;
    const shouldResume = pauseState.resume;
    pauseState.resume = false;
    if (shouldResume && video && remoteMedia) {
      attemptPlayback(video, remoteMedia);
    }
  }, [presentationState.host, remoteMedia]);

  useEffect(() => {
    const video = videoRef.current;
    const mediaFact = presentationState.media;
    if (
      !video ||
      !remoteMedia ||
      !mediaFact ||
      mediaFact.generation !== remoteMedia.generation ||
      presentationState.host === "paused" ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const binding = remoteMedia;
    const proofEpoch = mediaFact.proofEpoch;
    return observeCompositedVideoFrame(video, binding.stream, () => {
      const currentMedia = presentationStateRef.current.media;
      if (
        !mediaBindingIsCurrent(binding) ||
        currentMedia?.generation !== binding.generation ||
        currentMedia.proofEpoch !== proofEpoch
      ) {
        return;
      }
      qualityFrameProofGenerationRef.current = binding.generation;
      dispatchPresentation({
        type: "frame-presented",
        generation: binding.generation,
        proofEpoch,
        revision: binding.boundAtRevision,
      });
    });
  }, [
    mediaProofEpoch,
    mediaProofGeneration,
    presentationState.host,
    remoteMedia,
  ]);

  function retryConnection(): void {
    if (reconnectRoute === "sfu") {
      viewerSfuRouteRef.current?.reconnectActive();
    } else if (reconnectRoute === "p2p") {
      if (peerRef.current?.requestRecovery(true)) {
        dispatchPresentation({
          type: "connection",
          revision: presentationState.revision ?? assignedRoute?.revision ?? 0,
          connection: "reconnecting",
        });
      }
    }
  }

  function commitDisplayName(): void {
    const fallback = defaultViewerDisplayName(viewerClientId, vis);
    const saved = saveDisplayName(displayNameDraft, fallback);
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
    signalRef.current?.setViewerDisplayName(saved);
  }

  function submitViewerPassword(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!viewerPasswordSchema.safeParse(viewerPasswordDraft).success) {
      setViewerPasswordError("join.passwordRule");
      return;
    }
    setViewerPasswordError(null);
    dispatchPresentation({
      type: "access",
      access: "checking",
      failure: null,
    });
    setViewerPasswordAttempt((current) => ({
      password: viewerPasswordDraft,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }

  if (accessState !== "ready") {
    const failureCode = presentation.failureCode;
    const codeOnlyDenied =
      !viewerGrant && failureCode === "ROOM_ACCESS_DENIED";
    const canRefresh = [
      "STALE_CLIENT",
      "SERVER_ERROR",
      "SESSION_REPLACED",
      "SIGNAL_TERMINATED",
    ].includes(failureCode ?? "");
    const deniedComic: ComicKind =
      failureCode === "ROOM_FULL"
        ? "room-full"
        : codeOnlyDenied
          ? "access-denied"
          : failureCode === "INVALID_TOKEN"
            ? "invalid-invite"
            : failureCode === "ROOM_NOT_FOUND" ||
                failureCode === "ROOM_EXPIRED" ||
                failureCode === "ROOM_CLOSED"
              ? "room-not-found"
              : "warning";
    const deniedIcon: GlyphName =
      failureCode === "ROOM_NOT_FOUND" ||
      failureCode === "ROOM_EXPIRED" ||
      failureCode === "ROOM_CLOSED"
        ? "door"
        : failureCode === "ROOM_ACCESS_DENIED"
          ? "lock"
          : failureCode === "ROOM_FULL"
            ? "users"
            : "alert";
    const deniedHintKey: CopyKey = codeOnlyDenied
      ? "viewer.hint.denied"
      : failureCode === "ROOM_NOT_FOUND" ||
          failureCode === "ROOM_EXPIRED" ||
          failureCode === "ROOM_CLOSED"
        ? "viewer.hint.notFound"
        : failureCode === "INVALID_TOKEN"
          ? "viewer.hint.invite"
          : "viewer.hint.generic";
    return (
      <div className="lr-app">
        <AppHeader
          led={
            accessState === "checking" ? (
              <LedStrip state="busy" label={t(presentation.messageKey)} />
            ) : undefined
          }
        />
        <main className="lr-join">
          {accessState === "checking" ? (
            <div className="lr-join-panel">
              <span
                className="lr-viewer-entry-brand"
                role="status"
                aria-label={t(presentation.messageKey)}
              >
                <BrandLoader />
              </span>
              {vis ? null : (
                <span className="lr-tv-msg">{t(presentation.messageKey)}</span>
              )}
            </div>
          ) : (
            <div className="lr-join-panel">
              {vis ? (
                <>
                  <Comic kind={deniedComic} theme="paper" />
                  <span className="visually-hidden" role="alert">
                    {t(presentation.messageKey)} · {t(deniedHintKey)}
                  </span>
                </>
              ) : (
              <span
                className="lr-tv-big"
                style={{
                  borderColor: "var(--ink)",
                  color: "var(--ink)",
                  background: "var(--paper)",
                }}
                title={t(presentation.messageKey)}
                role="img"
                aria-label={t(presentation.messageKey)}
              >
                <Glyph name={deniedIcon} size={30} />
              </span>
              )}
              {vis ? null : (
                <div className="lr-access-text">
                  <h1>{t(presentation.messageKey)}</h1>
                  <p>{t(deniedHintKey)}</p>
                </div>
              )}
              {codeOnlyDenied && (
                <>
                  <Btn
                    icon="key"
                    cap="join.passwordAction"
                    title="join.passwordAction"
                    expanded={viewerPasswordExpanded}
                    controls="viewer-password-retry"
                    onClick={() => setViewerPasswordExpanded((current) => !current)}
                  />
                  {viewerPasswordExpanded ? (
                    <div id="viewer-password-retry">
                      <form
                      style={{ display: "grid", justifyItems: "center", gap: 14 }}
                      onSubmit={submitViewerPassword}
                    >
                  <span className="lr-input" style={{ minWidth: 220 }}>
                    <Glyph name="key" size={17} />
                    <input
                      type="password"
                      value={viewerPasswordDraft}
                      maxLength={MAX_VIEWER_PASSWORD_LENGTH}
                      autoComplete="current-password"
                      autoFocus
                      aria-label={t("join.password")}
                      onChange={(event) => {
                        setViewerPasswordDraft(event.target.value);
                        setViewerPasswordError(null);
                      }}
                    />
                  </span>
                  {viewerPasswordError && (
                    <Pill icon="alert" tone="bad" label={t(viewerPasswordError, { max: String(MAX_VIEWER_PASSWORD_LENGTH) })} alert comic="access-denied" />
                  )}
                  <Btn
                    icon="arrowRight"
                    tone="primary"
                    cap="join.submit"
                    title="join.submit"
                    type="submit"
                    hint="hint-password"
                  />
                      </form>
                    </div>
                  ) : null}
                </>
              )}
              {canRefresh && (
                <Btn
                  icon="refresh"
                  cap="common.refresh"
                  title="common.refresh"
                  onClick={() => window.location.reload()}
                />
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  const chin = stageChin(presentation.stage);
  const ledState: LedState = chin === "on" ? "live" : chin;
  const overlayGlyph = stageOverlayGlyph(presentation.stage);
  const assignedRouteKind =
    assignedRoute?.upstream.kind === "sfu"
      ? "sfu"
      : assignedRoute?.upstream.kind === "peer"
        ? "p2p"
        : routePresentation.route;
  const overlayComic = stageOverlayComic(
    presentation.stage,
    assignedRouteKind,
  );
  const noticeVisual = presentation.noticeKey
    ? viewerNoticeVisual(presentation.noticeKey)
    : null;
  const selectedChildEvidence =
    selectedPawn !== null &&
    selectedPawn !== selfPeerId &&
    relayChildEvidence?.evidence.viewerPeerId === selectedPawn
      ? relayChildEvidence
      : null;
  const couchEntries: CouchEntry[] = viewers.map((viewer) => {
    const isSelf = selfPeerId !== null && viewer.peerId === selfPeerId;
    const isChild =
      !isSelf &&
      selfPeerId !== null &&
      viewer.upstream.kind === "peer" &&
      viewer.upstream.peerId === selfPeerId;
    return {
      key: viewer.peerId,
      name: viewer.label,
      connected: viewer.mediaReady === true,
      statusLabel: t(
        isSelf
          ? (`state.peer.${presentation.connectionState}` as CopyKey)
          : viewer.upstream.kind === "none"
            ? "state.peer.routing"
            : "state.peer.connecting",
      ),
      you: isSelf,
      selectable: isChild ? undefined : false,
    };
  });
  const selectableRelayChildren = viewers
    .filter(
      (viewer) =>
        selfPeerId !== null &&
        viewer.upstream.kind === "peer" &&
        viewer.upstream.peerId === selfPeerId,
    )
    .map((viewer) => viewer.peerId);

  // Vis mode swaps native title tooltips for 2-panel hint comics; text modes
  // render the trigger unchanged, so markup structure stays identical. Edge
  // alignment keeps the panel on-screen for triggers near a viewport edge.
  const hintWrap = (
    kind: HintKind,
    node: ReactNode,
    align: "start" | "center" | "end" = "center",
  ): ReactNode =>
    vis ? (
      <ComicTooltip kind={kind} align={align}>
        {node}
      </ComicTooltip>
    ) : (
      node
    );

  return (
    <div className="lr-app">
      <style>{`
/* The video fills the screen exactly, so its own :focus-visible outline is
   clipped by .lr-tv-screen's overflow: hidden. Ring the screen container
   instead; :focus-visible keeps mouse clicks ring-free like every control. */
.lr-tv-screen:has(:focus-visible) { outline: 3px solid var(--action); outline-offset: 2px; }
`}</style>
      <AppHeader
        led={<LedStrip state={ledState} label={t(presentation.messageKey)} />}
      />
      <main className={`lr-room${theaterMode ? " is-theater" : ""}`}>
        <h1 className="visually-hidden">
          {hostDisplayName
            ? t("viewer.title", { name: hostDisplayName })
            : t("viewer.titleFallback")}
        </h1>
        <div className="lr-scene" id="viewer-stage">
          <StageTv
            chin={chin}
            live={presentation.stage === "playing"}
            label={t("viewer.stageAria")}
          >
            <video
              ref={videoRef}
              autoPlay
              tabIndex={0}
              aria-label={t("viewer.stageAria")}
              controls={
                presentation.overlay === "none" ||
                presentation.stage === "needs-play" ||
                (presentation.stage === "receiving" &&
                  presentation.hasRetainedFrame)
              }
              controlsList={theaterMode ? "nofullscreen" : undefined}
              playsInline
              onPlay={() => {
                invalidateQualityPresentation();
                rearmCurrentFrameProof();
                const binding = remoteMediaRef.current;
                if (binding) {
                  dispatchPresentation({
                    type: "autoplay-cleared",
                    generation: binding.generation,
                  });
                }
              }}
              onPause={invalidateQualityPresentation}
              onEnded={invalidateQualityPresentation}
            />
            {presentation.overlay === "blocking" && (
              <StageOverlay
                dim
                icon={overlayGlyph.icon}
                transition={overlayGlyph.spin}
                comic={overlayComic}
                message={t(presentation.messageKey)}
              />
            )}
            {presentation.overlay === "status" &&
              presentation.stage === "needs-play" && (
                <StageOverlay
                  dim
                  icon="play"
                  comic="tap-to-play"
                  message={t(presentation.messageKey)}
                  onActivate={() => {
                    const video = videoRef.current;
                    const binding = remoteMediaRef.current;
                    if (video && binding) attemptPlayback(video, binding);
                  }}
                />
              )}
            {presentation.overlay === "status" &&
              presentation.stage !== "needs-play" && (
                <StageOverlay
                  dim
                  icon={overlayGlyph.icon}
                  comic={overlayComic}
                  message={t(presentation.messageKey)}
                  spin={overlayGlyph.spin}
                />
              )}
          </StageTv>
          {(presentation.noticeKey ||
            (routePresentation.evidence === peerSnapshot &&
              peerSnapshot?.error) ||
            relaySnapshot?.error ||
            qualityLimitation) && (
            <div className="lr-stage-notices">
              {presentation.noticeKey && noticeVisual ? (
                <Pill
                  icon={noticeVisual.icon}
                  label={t(presentation.noticeKey)}
                  comic={noticeVisual.comic}
                />
              ) : null}
              {routePresentation.evidence === peerSnapshot &&
              peerSnapshot?.error ? (
                <Pill
                  icon="alert"
                  tone="bad"
                  label={t("viewer.error.p2p")}
                  comic="warning"
                />
              ) : null}
              {relaySnapshot?.error ? (
                <Pill
                  icon="alert"
                  tone="bad"
                  label={t("viewer.error.relay")}
                  comic="warning"
                />
              ) : null}
              {qualityLimitation ? (
                <Pill
                  icon="alert"
                  label={qualityLimitation}
                  comic="warning"
                />
              ) : null}
            </div>
          )}
          {theaterMode ? (
            <div className="lr-theater-exit">
              <Btn
                icon="contract"
                cap="viewer.theater.exit"
                title="viewer.theater.exit"
                onClick={() => setTheaterMode(false)}
              />
            </div>
          ) : null}
          <div className="lr-shelf" aria-hidden="true" />
          <Couch
            host={
              labeledHostPresence
                ? {
                    key: labeledHostPresence.peerId,
                    name: labeledHostPresence.label,
                  }
                : null
            }
            entries={couchEntries}
            selectedKey={selectedPawn}
            onSelect={(key) =>
              setSelectedPawn((current) => (current === key ? null : key))
            }
          />
        </div>
        <div className="lr-deck">
          {selectedPawn !== null && selectedChildEvidence ? (
            <PawnDetail
              pawnKey={selectedPawn}
              name={
                viewers.find((viewer) => viewer.peerId === selectedPawn)
                  ?.label ?? selectedPawn
              }
              route={null}
              metrics={metricsFromQualityEvidence(selectedChildEvidence.evidence)}
              direction="receive"
              tag={{ icon: "arrowUp", label: t("stats.downstream") }}
              expanded={pawnMetricsExpanded}
              onToggleMetrics={setPawnMetricsExpanded}
              onClose={() => setSelectedPawn(null)}
            />
          ) : null}
          <div className="lr-row lr-viewer-summary-row">
            <div className="lr-row-group lr-viewer-room-slot">
              <FieldCap k="common.roomCode" />
              <Lcd code={roomId} />
            </div>
            <div
              className="lr-row-group lr-viewer-host-slot"
              aria-label={t(
                hostDisplayName ? "viewer.title" : "viewer.titleFallback",
                hostDisplayName ? { name: hostDisplayName } : undefined,
              )}
            >
              <Glyph name="tv" size={17} />
              <b>{hostDisplayName ?? t("common.host")}</b>
            </div>
            <div className="lr-row-group lr-viewer-state-slot">
              <StatusText>{t(presentation.messageKey)}</StatusText>
            </div>
            <div className="lr-viewer-personal-controls">
              <form
                className="lr-row-group lr-group-name lr-viewer-self-slot"
                onSubmit={(event) => {
                  event.preventDefault();
                  commitDisplayName();
                }}
              >
                {editingDisplayName ? (
                  <>
                    <span className="lr-input lr-name-editor">
                      <input
                        id="viewer-display-name"
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
                      type="submit"
                      disabled={displayNameDraft === displayName}
                    />
                    <Btn
                      icon="x"
                      title="host.nameCancel"
                      onClick={() => {
                        setDisplayNameDraft(displayName);
                        setDisplayNameError(false);
                        setEditingDisplayName(false);
                      }}
                    />
                  </>
                ) : (
                  <>
                    <NameTag
                      name={displayName}
                      identity={selfPeerId ?? viewerClientId}
                    />
                    {hintWrap(
                      "hint-rename",
                      <Btn
                        icon="pencil"
                        cap="common.edit"
                        title="host.nameEdit"
                        onClick={() => {
                          setDisplayNameDraft(displayName);
                          setDisplayNameError(false);
                          setEditingDisplayName(true);
                        }}
                      />,
                      "end",
                    )}
                  </>
                )}
                {displayNameError && (
                  <Pill
                    icon="alert"
                    tone="bad"
                    label={t("host.nameError")}
                    alert
                    comic="warning"
                  />
                )}
              </form>
              <div className="lr-row-group lr-group-actions lr-viewer-actions-slot">
                <span className="lr-viewer-action-cluster">
                  <Btn
                    icon={theaterMode ? "contract" : "expand"}
                    cap={theaterMode ? "viewer.theater.exit" : "viewer.theater"}
                    title={
                      theaterMode ? "viewer.theater.exit" : "viewer.theater"
                    }
                    tone={theaterMode ? "on" : undefined}
                    pressed={theaterMode}
                    controls="viewer-stage"
                    onClick={() => setTheaterMode((current) => !current)}
                  />
                  {hintWrap(
                    "hint-reconnect",
                    <Btn
                      icon="refresh"
                      cap="viewer.reconnect"
                      title="viewer.reconnect"
                      disabled={!reconnectAvailable}
                      onClick={retryConnection}
                    />,
                    "end",
                  )}
                </span>
                <span
                  className="lr-viewer-action-separator"
                  aria-hidden="true"
                />
                <span className="lr-viewer-action-cluster">
                  <Btn
                    icon="gauge"
                    cap="host.details"
                    title={
                      showConnectionDetails ? "host.details.hide" : "host.details"
                    }
                    hint="hint-details"
                    tone={showConnectionDetails ? "on" : undefined}
                    expanded={showConnectionDetails}
                    controls="viewer-details-panel"
                    disabled={
                      !routePresentation.route &&
                      !relaySnapshot &&
                      !relayChildEvidence
                    }
                    onClick={() =>
                      setShowConnectionDetails((current) => !current)
                    }
                  />
                  {hintWrap(
                    "hint-topology",
                    <Btn
                      icon="network"
                      cap="host.topology"
                      title={
                        labeledHostPresence && showTopology
                          ? "host.topology.hide"
                          : "host.topology.show"
                      }
                      tone={
                        labeledHostPresence && showTopology ? "on" : undefined
                      }
                      expanded={Boolean(labeledHostPresence && showTopology)}
                      controls="room-topology"
                      disabled={!labeledHostPresence}
                      onClick={() =>
                        setShowTopology((current) => !current)
                      }
                    />,
                    "start",
                  )}
                </span>
              </div>
            </div>
          </div>
          {showConnectionDetails && routePresentation.route ? (
            <Row sub>
              <div id="viewer-details-panel" style={{ display: "contents" }}>
                <MeterTag icon="arrowDown" label={t("stats.title")} />
                <RouteGlyph route={routePresentation.route} />
                {routeMetrics ? (
                  <MetricCells
                    metrics={routeMetrics}
                    direction="receive"
                    expanded={routeMetricsExpanded}
                    onToggle={setRouteMetricsExpanded}
                  />
                ) : null}
              </div>
            </Row>
          ) : null}
          {showConnectionDetails && relaySnapshot ? (
            <Row sub>
              <MeterTag icon="arrowUp" label={t("stats.relay")} />
              <MetricCells
                metrics={relaySnapshot.metrics}
                direction="send"
                expanded={relayMetricsExpanded}
                onToggle={setRelayMetricsExpanded}
              />
            </Row>
          ) : null}
          {showConnectionDetails && relayChildEvidence ? (
            <Row sub>
              <MeterTag icon="arrowUp" label={t("stats.downstream")} />
              <MetricCells
                metrics={metricsFromQualityEvidence(relayChildEvidence.evidence)}
                direction="receive"
                expanded={downstreamMetricsExpanded}
                onToggle={setDownstreamMetricsExpanded}
              />
            </Row>
          ) : null}
          {showTopology && labeledHostPresence ? (
            <Row sub>
              <RouteTree
                hostPeerId={labeledHostPresence.peerId}
                hostLabel={labeledHostPresence.label}
                viewers={viewers}
                selfPeerId={selfPeerId}
                selectedPeerId={selectedPawn}
                selectablePeerIds={selectableRelayChildren}
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

function routeKindFromAssignment(
  upstream: ParticipantRouteAssignment["upstream"],
): ViewerRouteKind {
  return upstream.kind === "peer"
    ? "p2p"
    : upstream.kind === "sfu"
      ? "sfu"
      : "none";
}

function connectionFact(
  state: RTCPeerConnectionState,
): "idle" | "connecting" | "connected" | "reconnecting" | "failed" {
  switch (state) {
    case "connected":
      return "connected";
    case "new":
    case "connecting":
      return "connecting";
    case "disconnected":
      return "reconnecting";
    case "failed":
    case "closed":
      return "failed";
  }
}
