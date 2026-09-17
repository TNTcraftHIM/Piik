import { PawnSvg } from "../components/living/Pawn";
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_QUALITY_SETTINGS,
  DEFAULT_ROUTE_POLICY,
  MAX_VIEWER_PASSWORD_LENGTH,
  viewerPasswordSchema,
  type IceConfig,
  type ParticipantPresenceEntry,
  type ParticipantRouteAssignment,
  type PreparedRouteCandidate,
  type ServerMessage,
  type RoutePolicy,
} from "../../shared/protocol";
import {
  viewerReconnectRoute,
  viewerRouteEvidence,
} from "../components/status-badge-model";
import { AppHeader, LedStrip } from "../components/living/Header";
import { Couch, type CouchEntry } from "../components/living/Couch";
import { participantColor } from "../components/living/participant-color";
import { MetricCells } from "../components/living/Metrics";
import { PawnDetail, RouteGlyph } from "../components/living/PawnDetail";
import { Lcd } from "../components/living/RoomChip";
import { RouteTree } from "../components/living/RouteTree";
import { Comic, type ComicKind } from "../components/living/Comic";
import {
  StageOverlay,
  StageTv,
} from "../components/living/Stage";
import { StatusIndicator } from "../components/living/StatusIndicator";
import { Tooltip } from "../components/living/Tooltip";
import { PlaybackControls } from "../components/living/PlaybackControls";
import { LoadingStatus } from "../components/living/WaitingStatus";
import {
  Btn,
  FieldCap,
  NameTag,
  Pill,
  Row,
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
import { deriveViewerStatus, deriveParticipantStatus } from "../ui/media-status";
import { clearViewerGrant, getStableClientId } from "../lib/session";
import { createOpaqueId } from "../lib/opaque-id";
import { SignalingClient } from "../lib/signaling";
import { labelParticipantSnapshot } from "../lib/viewer-presence";
import {
  P2pQualityProbe,
  type CandidateQualityProbeResult,
} from "../media/candidate-quality-probe";
import { DecodedFrameStallDetector } from "../media/decoded-frame-stall";
import type { QualitySettings } from "../media/quality";
import { relayCapacityMessageForBrowser } from "../media/relay-capability";
import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
} from "../media/sender-quality-evidence";
import {
  freshViewerQualityEvidence,
  metricsFromQualityEvidence,
  presentViewerQualityEvidence,
  qualityEvidenceMatchesSnapshot,
  reconcileViewerQualityEvidencePresentation,
  type ViewerQualityEvidencePresentation,
  ViewerQualityEvidenceReporter,
} from "../media/viewer-quality-evidence";
import { ViewerQualityEvidenceStore } from "../media/viewer-quality-evidence-store";
import { ViewerMessageAuthority } from "../media/viewer-message-authority";
import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  deriveViewerPresentation,
  reduceViewerPresentation,
  viewerFailureFromServerCode,
  type ViewerPresentationAction,
  type ViewerRouteKind,
} from "../media/viewer-presentation";
import { nextViewerMediaBinding, prepareViewerPlayback, type RemoteMediaBinding } from "../media/viewer-playback";
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
import type {
  ViewerMediaPeer,
  ViewerPeerEvents,
  ViewerPeerOptions,
} from "../webrtc/viewer-peer";
import { ViewerPeer } from "../webrtc/viewer-peer";
import {
  ViewerRelay,
  type ViewerRelayPeerFactory,
} from "../webrtc/viewer-relay";
import { NativeClient } from "../native/client";
import {
  NativeCapableViewerPeer,
} from "../native/native-viewer-peer";
import { NativeSenderPeer } from "../native/native-sender-peer";

interface ViewerPageProps {
  roomId: string;
  viewerGrant?: string;
  invalidGrant?: boolean;
  launchedByClient?: boolean;
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
  peer: ViewerMediaPeer | null;
  decodedFrame: boolean;
  connectedSent: boolean;
  readySent: boolean;
  candidateConnectionId: string;
  stream: MediaStream | null;
  snapshot: PeerSnapshot | null;
  qualityProbe: P2pQualityProbe | null;
  qualityResult: CandidateQualityProbeResult;
}

function MeterTag({ icon, label }: { icon: GlyphName; label: string }) {
  const { vis } = useCopy();
  return (
    <span className="lr-meter-tag" role="img" aria-label={label}>
      <Glyph name={icon} size={17} />
      {vis ? null : <span className="lr-cap">{label}</span>}
    </span>
  );
}

export function ViewerPage({
  roomId,
  viewerGrant,
  invalidGrant = false,
  launchedByClient = false,
}: ViewerPageProps) {
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
    connectionAttempt?: PreparedRouteCandidate["connectionAttempt"];
  } | null>(null);
  const [relaySnapshot, setRelaySnapshot] = useState<PeerSnapshot | null>(null);
  const [relayChildEvidence, setRelayChildEvidence] = useState<
    ReadonlyMap<string, ViewerQualityEvidencePresentation>
  >(() => new Map());
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [showTopology, setShowTopology] = useState(false);
  const [theaterMode, setTheaterMode] = useState(false);
  const [hasCustomDisplayName, setHasCustomDisplayName] = useState(
    () => readStoredDisplayName() !== null,
  );
  const [displayName, setDisplayName] = useState(() =>
    readDisplayName(defaultViewerDisplayName(vis)),
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
  const [routeMetricsExpanded, setRouteMetricsExpanded] = useState(false);
  const [relayMetricsExpanded, setRelayMetricsExpanded] = useState(false);
  const [downstreamMetricsExpanded, setDownstreamMetricsExpanded] =
    useState(false);
  const [pawnMetricsExpanded, setPawnMetricsExpanded] = useState(false);

  const mediaProofGeneration = presentationState.media?.generation ?? null;
  const mediaProofEpoch = presentationState.media?.proofEpoch ?? null;
  useEffect(() => {
    if (!theaterMode) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setTheaterMode(false);
    };
    document.body.classList.add("lr-theater-open");
    window.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.classList.remove("lr-theater-open");
      window.removeEventListener("keydown", exitOnEscape);
    };
  }, [theaterMode]);

  const { host: labeledHostPresence, viewers } = useMemo(
    () => labelParticipantSnapshot(participantPresence ?? []),
    [participantPresence],
  );
  const currentHostDisplayName = labeledHostPresence?.label ?? null;
  const hostDisplayName = currentHostDisplayName ?? lastHostDisplayName;

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
  const peerRef = useRef<ViewerMediaPeer | null>(null);
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
    const fallback = defaultViewerDisplayName(vis);
    if (displayNameRef.current === fallback) return;
    displayNameRef.current = fallback;
    setDisplayName(fallback);
    if (!editingDisplayName) setDisplayNameDraft(fallback);
    signalRef.current?.setDisplayName(fallback);
  }, [hasCustomDisplayName, lang, vis, viewerClientId]);
  const remoteMediaRef = useRef<RemoteMediaBinding | null>(null);
  const mediaGenerationRef = useRef(0);
  const hostPlaybackPauseRef = useRef({ active: false, resume: false });
  const routePresentation = viewerRouteEvidence(
    assignedRoute?.upstream ?? null,
    peerSnapshot,
    sfuUpstream,
  );
  const assignedRouteKind =
    assignedRoute?.upstream.kind === "sfu"
      ? "sfu"
      : assignedRoute?.upstream.kind === "peer"
        ? "p2p"
        : routePresentation.route;
  const viewerStatus = deriveViewerStatus(
    presentation,
    signalStatus,
    assignedRouteKind,
  );
  const titleContent = titleFrames(viewerStatus.titleFrameKey);
  useDocumentTitle(
    [
      accessState === "ready" ? roomId : null,
      titleContent.label,
      viewerStatus.titleMarker,
    ],
    titleContent.variations,
    `${lang}:${vis}:${viewerStatus.titleFrameKey}:${roomId}`,
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
    const current = remoteMediaRef.current;
    const next = nextViewerMediaBinding(current, stream, revision, mediaGenerationRef.current + 1);
    if (next === current) return;
    const pictureChanged = next.generation !== current?.generation;
    mediaGenerationRef.current = next.generation;
    remoteMediaRef.current = next;
    setRemoteMedia(next);
    if (!pictureChanged) return;
    invalidateQualityPresentation();
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
    connectionAttempt?: PreparedRouteCandidate["connectionAttempt"],
    authoritative = false,
  ): void {
    setAssignedRoute((current) =>
      !authoritative && current && revision < current.revision
        ? current
        : { revision, phase, upstream, connectionAttempt },
    );
    dispatchPresentation({
      type: "route",
      revision,
      phase,
      kind: routeKindFromAssignment(upstream),
      authoritative,
    });
  }

  useEffect(() => {
    let active = true;
    let currentIceConfig: IceConfig | null = null;
    let currentHostOnline = false;
    let currentHostPaused = false;
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
    let viewerRelaySourceKey: string | null = null;
    let viewerSfuRoute: ViewerSfuRoute | null = null;
    let preparedParentPeerId: string | null = null;
    let preparedParentSignals: Array<
      Extract<ServerMessage, { type: "signal" }>
    > = [];
    let pendingPeer: PendingPeerRoute | null = null;
    const decodedFrameStall = new DecodedFrameStallDetector();
    const messageAuthority = new ViewerMessageAuthority();
    const relayChildEvidenceStore = new ViewerQualityEvidenceStore((values) => {
      if (active) setRelayChildEvidence(values);
    });
    setRelayChildEvidence(relayChildEvidenceStore.getSnapshot());
    let sfuTransportConnected = false;
    let nativeClientPromise: Promise<NativeClient | null> | null = null;
    let nativeViewerAvailable = true;
    const nativeViewerSessionId = createOpaqueId();

    const acquireNativeClient = async (): Promise<NativeClient | null> => {
      if (!active || !launchedByClient || !nativeViewerAvailable) return null;
      if (!nativeClientPromise) {
        const connecting: Promise<NativeClient | null> = NativeClient.connect({ waitForPermission: false }).catch(() => null).then((client) => {
          if (!client || !active) {
            if (nativeClientPromise === connecting) nativeClientPromise = null;
            client?.close();
            return null;
          }
          client.onClose(() => {
            if (nativeClientPromise === connecting) nativeClientPromise = null;
          });
          return client;
        });
        nativeClientPromise = connecting;
      }
      const connecting = nativeClientPromise;
      const client = await connecting;
      return active && nativeViewerAvailable && nativeClientPromise === connecting ? client : null;
    };

    function createViewerMediaPeer(
      iceConfig: IceConfig,
      events: ViewerPeerEvents,
      options: ViewerPeerOptions,
    ): ViewerMediaPeer {
      if (!launchedByClient) {
        return new ViewerPeer(iceConfig, events, options);
      }
      return new NativeCapableViewerPeer(
        iceConfig,
        events,
        options,
        acquireNativeClient,
        () => { nativeViewerAvailable = false; },
        nativeViewerSessionId,
        MAX_ENDPOINT_MEDIA_CHILDREN,
      );
    }

    let pageSuspended = document.visibilityState !== "visible";
    const syncDecodedFrameStallPause = (): void => {
      decodedFrameStall.setPaused(currentHostPaused || pageSuspended);
    };
    const suspendForPageLifecycle = (): void => {
      // Losing observation does not invalidate media already proved playable.
      invalidateQualityPresentation();
      rearmCurrentFrameProof();
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
      invalidateQualityPresentation();
      rearmCurrentFrameProof();
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
    function committedTransportConnected(): boolean {
      if (currentRouteAssignment?.upstream.kind === "peer") {
        return (
          peerRef.current?.isConnected() === true &&
          peerRef.current.isRecovering() === false
        );
      }
      return currentRouteAssignment?.upstream.kind === "sfu"
        ? sfuTransportConnected
        : false;
    }
    function offerPeerQualityEvidence(
      snapshot: PeerSnapshot,
      peer: ViewerMediaPeer,
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

    function acceptRelayChildEvidence(evidence: ViewerQualityEvidence): void {
      const relaySnapshot =
        viewerRelay?.getSnapshot(evidence.viewerPeerId) ?? null;
      if (
        evidence.upstream.kind !== "peer" ||
        evidence.upstream.peerId !== currentPeerId ||
        evidence.guard.routeRevision !== currentRouteRevision ||
        !qualityEvidenceMatchesSnapshot(evidence, relaySnapshot)
      ) {
        return;
      }
      relayChildEvidenceStore.set(
        evidence.viewerPeerId,
        presentViewerQualityEvidence(
          relayChildEvidenceStore.getSnapshot().get(evidence.viewerPeerId) ?? null,
          evidence,
        ),
      );
    }

    function ensureViewerRelay(
      upstreamKind = currentRouteAssignment?.upstream.kind,
    ): ViewerRelay | null {
      if (!currentIceConfig) {
        return null;
      }
      const source =
        upstreamKind === "peer" &&
        peerRef.current instanceof NativeCapableViewerPeer
          ? peerRef.current.nativeSource
          : null;
      // Wait until the upstream media identity is known. This lets a native
      // Viewer choose the encoded relay source before any child edge exists.
      if (!remoteMediaRef.current?.stream) {
        return null;
      }
      const sourceKey = source
        ? `native:${source.sessionId}:${source.connectionId}:${source.generation}`
        : "browser";
      if (viewerRelay && viewerRelaySourceKey === sourceKey) {
        return viewerRelay;
      }
      if (viewerRelay) {
        viewerRelay.dispose();
        viewerRelay = null;
        viewerRelaySourceKey = null;
      }
      const peerFactory: ViewerRelayPeerFactory | null = source
        ? {
            requiresStream: false,
            create: (childPeerId, connectionId, peerEvents, candidate) =>
              candidate?.qualityProbe
                ? null
                : new NativeSenderPeer(
                    childPeerId,
                    connectionId ?? createOpaqueId(),
                    source.sessionId,
                    currentIceConfig!,
                    currentRoutePolicy.natPrediction,
                    source.client,
                    peerEvents,
                    source.codec,
                    {
                      connectionId: source.connectionId,
                      getProfile: () => currentQualitySettings,
                      format: () => {
                        const settings = remoteMediaRef.current?.stream
                          .getVideoTracks()[0]
                          ?.getSettings();
                        return {
                          width:
                            typeof settings?.width === "number"
                              ? settings.width
                              : null,
                          height:
                            typeof settings?.height === "number"
                              ? settings.height
                              : null,
                        };
                      },
                    },
                  ),
          }
        : null;
      viewerRelay = new ViewerRelay(
        currentIceConfig,
        currentQualitySettings,
        {
          sendSignal: (targetPeerId, payload) =>
            active
              ? signal.send({
                  type: "signal",
                  targetPeerId,
                  payload,
                })
              : false,
          onUpdate: (snapshot) => {
            if (active) {
              setRelaySnapshot(snapshot);
              for (const [peerId, presentation] of [
                ...relayChildEvidenceStore.getSnapshot(),
              ]) {
                const reconciled =
                  reconcileViewerQualityEvidencePresentation(
                    presentation,
                    viewerRelay?.getSnapshot(peerId) ?? null,
                  );
                if (reconciled !== presentation) {
                  relayChildEvidenceStore.set(peerId, reconciled);
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
          onPreparedChildFailed: reportPreparedChildFailure,
          onPreparedChildConnected: (revision, connectionId) =>
            active && signal.send({ type: "route-transport-connected", revision, connectionId }),
        },
        endpointMediaCopyCapacity,
        currentRoutePolicy.natPrediction,
        peerFactory,
      );
      viewerRelaySourceKey = sourceKey;
      viewerRelay.setChildren(currentAssignment.childPeerIds);
      return viewerRelay;
    }

    function reportPreparedChildFailure(
      revision: number,
      connectionId: string,
    ): void {
      if (active) {
        signal.send({
          type: "route-failed",
          revision,
          phase: "prepare",
          connectionId,
        });
      }
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
        relayChildEvidenceStore.clear();
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
      peer: ViewerMediaPeer,
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
    ): probe is PendingPeerRoute & { peer: ViewerMediaPeer; snapshot: PeerSnapshot } {
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
            const activatedPeer = probe.peer;
            activatedPeer.stopDecodedFrameProof();
            pendingPeer = null;
            prepareParent(null);
            peerRef.current = activatedPeer;
            activatedPeer.activatePreparedRoute();
            previousPeer?.dispose();
            applyMediaAssignment(
              {
                parentPeerId: probe.parentPeerId,
                childPeerIds: currentAssignment.childPeerIds,
              },
              true,
            );
            bindRemoteStream(probe.stream, revision);
            ensureViewerRelay("peer")?.setStream(probe.stream);
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
            if (!ensureViewerRelay()?.prepareChild(revision, candidate, childPeerIds)) {
              reportPreparedChildFailure(revision, candidate.connectionId);
            }
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
        qualityProbeEligible: () =>
          qualityPresentationEligible(committedTransportConnected()),
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
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          if (available) {
            setSfuUpstream((current) =>
              current ? { ...current, connectionState: "connected" } : current,
            );
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
          bindRemoteStream(nextStream, revision);
          const relay = ensureViewerRelay("sfu");
          relay?.setStream(nextStream);
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
      relayChildEvidenceStore.clear();
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

    function ensurePendingPeerRoute(): ViewerMediaPeer | null {
      const probe = pendingPeer;
      if (!probe || !currentIceConfig) return null;
      if (probe.peer) return probe.peer;
      const peer = createViewerMediaPeer(
        currentIceConfig,
        {
          sendSignal: (targetPeerId, payload) =>
            signal.send(viewerSignalMessage(targetPeerId, payload)),
          sendRestartRequest: createOwnedViewerRestartSender(
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
                connection: peer.isRecovering()
                  ? "reconnecting"
                  : connectionFact(snapshot.connectionState),
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
        {
          natPredictionEnabled: currentRoutePolicy.natPrediction,
          recoveryOwner: "route",
        },
      );
      probe.peer = peer;
      return peer;
    }

    function ensurePeer(): ViewerMediaPeer | null {
      if (peerRef.current) {
        return peerRef.current;
      }
      if (!currentIceConfig) {
        return null;
      }
      const peer = createViewerMediaPeer(
        currentIceConfig,
        {
          sendSignal: (targetPeerId, payload) =>
              signal.send(viewerSignalMessage(targetPeerId, payload)),
          sendRestartRequest: createOwnedViewerRestartSender(
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
        { natPredictionEnabled: currentRoutePolicy.natPrediction },
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
        relayChildEvidenceStore.clear();
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
        currentRoutePolicy = message.routePolicy;
        const nextRouteRevision = message.routeRevision;
        if (nextRouteRevision !== currentRouteRevision) {
          relayChildEvidenceStore.clear();
        }
        currentRouteRevision = nextRouteRevision;
        activateRouteIdentity(
          message.routeRevision,
          message.routeAssignment,
          message.connectionId,
        );
        acceptAssignedRoute(
          message.routeRevision,
          message.routeAssignment.upstream,
          "active",
          undefined,
          true,
        );
        signal.send(relayCapacityMessageForBrowser());
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
        currentQualitySettings = message.qualitySettings;
        currentShareGeneration = message.shareGeneration;
        void viewerRelay?.updateProfile(currentQualitySettings);
        const route = ensureViewerSfuRoute();
        route.setPaused(sharingPaused);
        viewerRelay?.resyncSignaling();
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
          if (parentPeerId) {
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
                message.candidate.connectionAttempt,
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
                relayChildEvidenceStore.clear();
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
        await ensureViewerSfuRoute().acceptConfig(message);
        return;
      }
      if (message.type === "sfu-signal") {
        await viewerSfuRoute?.acceptSignal(message);
        return;
      }
      if (message.type === "quality-settings") {
        currentQualitySettings = message.qualitySettings;
        void viewerRelay?.updateProfile(currentQualitySettings);
        return;
      }
      if (message.type === "route-policy") {
        if (
          currentShareGeneration === null ||
          currentShareGeneration === message.shareGeneration
        ) {
          currentShareGeneration = message.shareGeneration;
          currentRoutePolicy = message.routePolicy;
        }
        return;
      }
      if (message.type === "signal") {
        if (pendingPeer?.parentPeerId === message.fromPeerId) {
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
        if (preparedParentPeerId === message.fromPeerId) {
          preparedParentSignals.push(message);
          return;
        }
        if (
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
        if (currentAssignment.parentPeerId !== message.fromPeerId) {
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
        await viewerRelay?.recover(
          message.fromPeerId,
          message.connectionId,
          message.rebuild,
        );
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
        setAssignedRoute(null);
        clearViewerSfuRoute();
        clearPeerState(true);
        clearParticipantPresence();
        dispatchPresentation({
          type: "access",
          access: "denied",
          failure: "ROOM_CLOSED",
        });
        signal.stop();
        return;
      }
      if (message.type === "error") {
        const failure = viewerFailureFromServerCode(message.code);
        if (failure !== null && failure !== "SERVER_ERROR") {
          setAssignedRoute(null);
          clearViewerSfuRoute();
          clearPeerState(true);
          clearParticipantPresence();
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
            setViewerPasswordError("join.passwordError");
            setViewerPasswordExpanded(true);
          }
          return;
        }
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
      relayChildEvidenceStore.clear();
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
      discardPendingPeer();
      peerRef.current?.dispose();
      peerRef.current = null;
      viewerRelay?.dispose();
      viewerRelay = null;
      viewerRelaySourceKey = null;
      void nativeClientPromise?.then((client) => client?.close());
    };
  }, [roomId, viewerGrant, viewerPasswordAttempt, launchedByClient]);

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
  }, [remoteMedia?.generation]);

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
  }, [presentationState.host, remoteMedia?.generation]);

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
    remoteMedia?.generation,
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
    const fallback = defaultViewerDisplayName(vis);
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
    signalRef.current?.setDisplayName(saved);
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
    const missingCredential = failureCode === "INVALID_TOKEN" && !viewerGrant && !invalidGrant;
    const malformedInvite = invalidGrant && (failureCode === "INVALID_TOKEN" || failureCode === "ROOM_ACCESS_DENIED");
    const deniedMessageKey = malformedInvite ? "viewer.msg.invalidInvite"
      : missingCredential ? "viewer.msg.accessFailed" : presentation.messageKey;
    const codeOnlyDenied =
      !viewerGrant && failureCode === "ROOM_ACCESS_DENIED";
    const canRefresh =
      failureCode === null || missingCredential ||
      // ROOM_FULL is transient by nature: a seat frees when a Viewer leaves,
      // so the hint that says "try again" needs something to try.
      [
        "ROOM_FULL",
        "STALE_CLIENT",
        "SERVER_ERROR",
        "SESSION_REPLACED",
        "SIGNAL_TERMINATED",
      ].includes(failureCode);
    const deniedComic: ComicKind = malformedInvite ? "invalid-invite"
      : missingCredential ? "access-denied" : viewerStatus.activity.comic ?? "signal-failed";
    const deniedHintKey: CopyKey = malformedInvite ? "viewer.hint.invite"
      : missingCredential ? "viewer.hint.accessFailed"
      : failureCode === "ROOM_FULL" ? "viewer.hint.full"
      : codeOnlyDenied
      ? "viewer.hint.denied"
      : failureCode === "ROOM_NOT_FOUND" ||
          failureCode === "ROOM_CLOSED"
        ? "viewer.hint.notFound"
        : failureCode === "INVALID_TOKEN"
          // A grant that the room no longer accepts is not a retry case:
          // the recovery is a new invite, not another attempt.
          ? "viewer.hint.invite"
          : "viewer.hint.generic";
    return (
      <div className="lr-app">
        <AppHeader
          led={
            accessState === "checking" ? (
              <LedStrip state="busy" label={t(presentation.messageKey)} comic="signal-connecting" />
            ) : undefined
          }
        />
        <main className="lr-join">
          {accessState === "checking" ? (
            <div className="lr-join-panel">
              <LoadingStatus label={presentation.messageKey} />
            </div>
          ) : (
            <div className="lr-join-panel">
              <Comic kind={deniedComic} theme="paper" tone={viewerStatus.activity.tone} />
              <span className="visually-hidden" role="alert">
                {t(deniedMessageKey)} · {t(deniedHintKey)}
              </span>
              {vis ? null : (
                <div className="lr-access-text">
                  <h1>{t(deniedMessageKey)}</h1>
                  <p>{t(deniedHintKey)}</p>
                </div>
              )}
              {codeOnlyDenied && (
                <>
                  <Btn
                    icon="key"
                    cap="join.passwordAction"
                    title="join.passwordAction"
                    hint={viewerPasswordExpanded ? "hint-collapse" : "hint-password"}
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
                  <span className="lr-input is-password">
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
                  hint="page-refresh"
                  onClick={() => window.location.reload()}
                />
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  const connectionAttempt = presentation.stage === "preparing-p2p" &&
    assignedRoute?.phase === "prepare" &&
    assignedRoute.revision === presentationState.revision
      ? assignedRoute.connectionAttempt
      : undefined;
  // Keep the first candidate quiet; the counter describes a retry, not normal setup.
  const retryAttempt =
    connectionAttempt && connectionAttempt.current > 1
      ? {
        ...connectionAttempt,
        current: connectionAttempt.current - 1,
        total: Math.max(1, connectionAttempt.total - 1),
        }
      : undefined;
  const stageMessage = retryAttempt
    ? t("viewer.msg.connectionRetry", {
        current: String(retryAttempt.current),
        total: String(retryAttempt.total),
      })
    : t(viewerStatus.activity.labelKey);
  const connectionProgress = retryAttempt
    ? `${retryAttempt.current}/${retryAttempt.total}`
    : undefined;
  const selectedChildEvidence =
    selectedPawn !== null && selectedPawn !== selfPeerId
      ? freshViewerQualityEvidence(relayChildEvidence.get(selectedPawn))
      : null;
  // Downstream rows describe one named child each; expired evidence stops
  // rendering instead of freezing the last numbers on screen.
  const freshRelayChildEvidence = viewers
    .map((viewer) => ({
      viewer,
      evidence: freshViewerQualityEvidence(
        relayChildEvidence.get(viewer.peerId),
      ),
    }))
    .filter(
      (entry): entry is { viewer: typeof entry.viewer; evidence: ViewerQualityEvidence } =>
        entry.evidence !== null,
    );
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
      status: deriveParticipantStatus(viewer, presentationState.host === "online" || presentationState.host === "paused"),
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

  return (
    <div className="lr-app">
      <AppHeader
        led={
          <LedStrip
            state={viewerStatus.connection.tone}
            label={t(viewerStatus.connection.labelKey)}
            comic={viewerStatus.connection.comic}
          />
        }
      />
      <main className={`lr-room${theaterMode ? " is-theater" : ""}`}>
        <h1 className="visually-hidden">
          {hostDisplayName
            ? t("viewer.title", { name: hostDisplayName })
            : t("viewer.titleFallback")}
        </h1>
        <div className="lr-scene" id="viewer-stage">
          <StageTv
            live={presentation.hasCurrentFrame || presentation.hasRetainedFrame}
            label={t("viewer.stageAria")}
            indicator={<StatusIndicator status={viewerStatus.television}
              label={retryAttempt ? stageMessage : undefined} />}
          >
            <video
              ref={videoRef}
              autoPlay
              tabIndex={0}
              aria-label={t("viewer.stageAria")}
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
            <PlaybackControls
              videoRef={videoRef}
              stream={remoteMedia?.stream ?? null}
              audioTrackKey={remoteMedia?.audioTrackKey}
              theaterMode={theaterMode}
              onToggleTheater={() => setTheaterMode((current) => !current)}
              onReconnect={retryConnection}
              reconnectAvailable={reconnectAvailable}
              canPlay={presentation.overlay === "none" ||
                presentation.stage === "needs-play" ||
                (presentation.stage === "receiving" && presentation.hasRetainedFrame)}
              onPlay={() => {
                const video = videoRef.current;
                const binding = remoteMediaRef.current;
                if (video && binding) attemptPlayback(video, binding);
              }}
            />
            {presentation.overlay === "blocking" && (
              <StageOverlay
                dim
                icon={viewerStatus.activity.icon}
                waiting={viewerStatus.overlay?.waiting}
                comic={viewerStatus.activity.comic}
                tone={viewerStatus.activity.tone}
                message={stageMessage}
                progress={connectionProgress}
              />
            )}
            {presentation.overlay === "status" &&
              presentation.stage === "needs-play" && (
                <StageOverlay
                  dim
                  icon={viewerStatus.activity.icon}
                  comic={viewerStatus.activity.comic}
                  tone={viewerStatus.activity.tone}
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
                  icon={viewerStatus.activity.icon}
                  comic={viewerStatus.activity.comic}
                  tone={viewerStatus.activity.tone}
                  message={stageMessage}
                  progress={connectionProgress}
                  waiting={viewerStatus.overlay?.waiting}
                />
              )}
          </StageTv>
          <div className="lr-stage-notices" role="status" aria-live="polite">
            {viewerStatus.notice && (
              <Pill
                icon={viewerStatus.notice.icon}
                label={t(viewerStatus.notice.labelKey)}
                comic={(viewerStatus.notice.comic ?? viewerStatus.notice.tooltip)!}
                tone={viewerStatus.notice.tone}
                motion={viewerStatus.notice.pulse ? "progress" : "still"}
              />
            )}
          </div>
          <Couch
            view="viewer"
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
          <div className="lr-row lr-viewer-summary-row">
            <div className="lr-row-group lr-viewer-room-slot">
              <FieldCap k="common.roomCode" />
              <Lcd code={roomId} />
            </div>
            <div
              className="lr-row-group lr-viewer-host-slot"
            >
              <Glyph name="tv" size={17} />
              <Tooltip overflow={{ text: hostDisplayName ?? t("common.host"), selector: "b" }} className="lr-name-hint">
                <b>{hostDisplayName ?? t("common.host")}</b>
              </Tooltip>
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
                      key="save-name"
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
                  </>
                ) : (
                  <>
                    <NameTag
                      name={displayName}
                      identity={selfPeerId ?? viewerClientId}
                    />
                    <Btn
                      key="edit-name"
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
                {displayNameError && (
                  <Pill
                    icon="alert"
                    tone="bad"
                    label={t("host.nameError")}
                    alert
                    comic="name-invalid"
                  />
                )}
              </form>
              <div className="lr-row-group lr-group-actions lr-viewer-actions-slot">
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
                    hint={showConnectionDetails ? "hint-collapse" : "hint-details"}
                    tone={showConnectionDetails ? "on" : undefined}
                    expanded={showConnectionDetails}
                    controls="viewer-details-panel"
                    disabled={
                      !routePresentation.route &&
                      !relaySnapshot &&
                      freshRelayChildEvidence.length === 0
                    }
                    onClick={() =>
                      setShowConnectionDetails((current) => !current)
                    }
                  />
                  <Btn
                    icon="network"
                    cap="host.topology"
                    title={
                      labeledHostPresence && showTopology
                        ? "host.topology.hide"
                        : "host.topology.show"
                    }
                    hint={labeledHostPresence && showTopology ? "hint-collapse" : "hint-topology"}
                    tone={
                      labeledHostPresence && showTopology ? "on" : undefined
                    }
                    expanded={Boolean(labeledHostPresence && showTopology)}
                    controls="room-topology"
                    disabled={!labeledHostPresence}
                    onClick={() =>
                      setShowTopology((current) => !current)
                    }
                  />
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
          {showConnectionDetails
            ? freshRelayChildEvidence.map(({ viewer, evidence }) => (
                <Row sub key={viewer.peerId} label={viewer.label}>
                  <MeterTag icon="arrowUp" label={t("stats.downstream")} />
                  <span className="lr-pawn-mini">
                    <PawnSvg color={participantColor(viewer.peerId)} identity={viewer.peerId} />
                  </span>
                  <span className="lr-pawn-detail-name">{viewer.label}</span>
                  <MetricCells
                    metrics={metricsFromQualityEvidence(evidence)}
                    direction="receive"
                    expanded={downstreamMetricsExpanded}
                    onToggle={setDownstreamMetricsExpanded}
                  />
                </Row>
              ))
            : null}
          {selectedPawn !== null && selectedChildEvidence ? (
            <PawnDetail
              pawnKey={selectedPawn}
              name={
                viewers.find((viewer) => viewer.peerId === selectedPawn)
                  ?.label ?? selectedPawn
              }
              route={null}
              metrics={metricsFromQualityEvidence(selectedChildEvidence)}
              direction="receive"
              tag={{ icon: "arrowUp", label: t("stats.downstream") }}
              expanded={pawnMetricsExpanded}
              onToggleMetrics={setPawnMetricsExpanded}
              onClose={() => setSelectedPawn(null)}
            />
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
