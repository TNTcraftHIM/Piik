import {
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  RefreshCw,
  Save,
  VideoOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DEFAULT_QUALITY_SETTINGS,
  MAX_VIEWER_PASSWORD_LENGTH,
  viewerPasswordSchema,
  type IceConfig,
  type MediaAssignment,
  type ParticipantPresenceEntry,
  type ParticipantRouteAssignment,
  type ServerMessage,
} from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import { ConnectionDetailsToggle } from "../components/ConnectionDetailsToggle";
import { RoomCode } from "../components/RoomCode";
import { qualityLimitationSummary } from "../components/connection-details";
import {
  MediaRouteBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { TopologyView } from "../components/TopologyView";
import {
  viewerReconnectRoute,
  viewerRouteEvidence,
} from "../components/status-badge-model";
import { readDisplayName, saveDisplayName } from "../lib/display-name";
import { clearViewerGrant, getStableClientId } from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import { labelParticipantSnapshot } from "../lib/viewer-presence";
import { DecodedFrameStallDetector } from "../media/decoded-frame-stall";
import type { QualitySettings } from "../media/quality";
import { relayCapacityMessageForBrowser } from "../media/relay-capability";
import { SfuStandbyPrewarmer } from "../media/sfu-standby-prewarmer";
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
  type ViewerFailureCode,
  type ViewerRouteKind,
} from "../media/viewer-presentation";
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
  limitMediaAssignment,
  MAX_ENDPOINT_MEDIA_CHILDREN,
  viewerRestartMessage,
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
  readySent: boolean;
  candidateConnectionId: string;
  stream: MediaStream | null;
  snapshot: PeerSnapshot | null;
}

interface RemoteMediaBinding {
  stream: MediaStream;
  generation: number;
  revision: number;
  videoTrackKey: string;
}

export function ViewerPage({ roomId, viewerGrant }: ViewerPageProps) {
  const [presentationState, dispatchPresentation] = useReducer(
    reduceViewerPresentation,
    INITIAL_VIEWER_PRESENTATION_STATE,
  );
  const presentation = deriveViewerPresentation(presentationState);
  const accessState = presentationState.access;
  const signalStatus = presentationState.signal;
  const [hostOnline, setHostOnline] = useState(false);
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
  const [displayName, setDisplayName] = useState(() => readDisplayName());
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [participantPresence, setParticipantPresence] = useState<
    ParticipantPresenceEntry[] | null
  >(null);
  const [viewerPasswordDraft, setViewerPasswordDraft] = useState("");
  const [viewerPasswordError, setViewerPasswordError] = useState<string | null>(
    null,
  );
  const [viewerPasswordAttempt, setViewerPasswordAttempt] = useState<{
    password: string;
    sequence: number;
  } | null>(null);
  const [viewerPasswordExpanded, setViewerPasswordExpanded] = useState(false);
  const [frameProofEpoch, setFrameProofEpoch] = useState(0);

  const qualityLimitation = useMemo(
    () =>
      qualityLimitationSummary(
        [peerSnapshot, relaySnapshot].filter(
          (snapshot): snapshot is PeerSnapshot => snapshot !== null,
        ),
      ),
    [peerSnapshot, relaySnapshot],
  );
  const hostPresence = useMemo(
    () =>
      participantPresence?.find(
        (participant): participant is Extract<
          ParticipantPresenceEntry,
          { role: "host" }
        > => participant.role === "host",
      ) ?? null,
    [participantPresence],
  );
  const { host: labeledHostPresence, viewers } = useMemo(
    () => labelParticipantSnapshot(participantPresence ?? []),
    [participantPresence],
  );

  function clearParticipantPresence(): void {
    setParticipantPresence(null);
  }

  function clearHostPresence(): void {
    setParticipantPresence((current) =>
      current?.filter((participant) => participant.role !== "host") ?? null,
    );
  }

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<ViewerPeer | null>(null);
  const viewerSfuRouteRef = useRef<ViewerSfuRoute | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const displayNameRef = useRef(displayName);
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
  const routeConnectionState =
    routePresentation.evidence?.connectionState ??
    (hostOnline ? "routing" : "waiting");
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
      current.revision === revision &&
      current.videoTrackKey === videoTrackKey
    ) {
      return;
    }
    const next: RemoteMediaBinding = {
      stream,
      revision,
      videoTrackKey,
      generation: ++mediaGenerationRef.current,
    };
    remoteMediaRef.current = next;
    setRemoteMedia(next);
    dispatchPresentation({
      type: "media-bound",
      generation: next.generation,
      revision: next.revision,
    });
  }

  function clearRemoteMedia(): void {
    remoteMediaRef.current = null;
    setRemoteMedia(null);
    dispatchPresentation({ type: "media-cleared" });
  }

  function attemptPlayback(
    video: HTMLVideoElement,
    binding: RemoteMediaBinding,
  ): void {
    void video.play().then(
      () =>
        dispatchPresentation({
          type: "autoplay-cleared",
          generation: binding.generation,
        }),
      (error: unknown) => {
        if (isAutoplayPolicyRejection(error)) {
          dispatchPresentation({
            type: "autoplay-blocked",
            generation: binding.generation,
            revision: binding.revision,
          });
        } else {
          dispatchPresentation({
            type: "playback-failed",
            generation: binding.generation,
            revision: binding.revision,
          });
        }
      },
    );
  }

  function acceptAssignedRoute(
    revision: number,
    upstream: ParticipantRouteAssignment["upstream"],
    phase: "prepare" | "active" = "active",
    preserveMedia = false,
  ): void {
    if (preserveMedia) {
      const current = remoteMediaRef.current;
      if (current && current.revision !== revision) {
        const rebased = { ...current, revision };
        remoteMediaRef.current = rebased;
        setRemoteMedia(rebased);
      }
    }
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
      preserveMedia,
    });
  }

  useEffect(() => {
    let active = true;
    let hadAuthenticated = false;
    let currentIceConfig: IceConfig | null = null;
    let currentHostOnline = false;
    let currentHostPaused = false;
    let peerAssisted = false;
    let currentPeerId: string | null = null;
    let currentRouteRevision = 0;
    let currentRouteAssignment: ParticipantRouteAssignment | null = null;
    let currentRouteConnectionId: string | null = null;
    let pendingRouteConnection: {
      revision: number;
      connectionId: string;
    } | null = null;
    let endpointMediaCopyCapacity = MAX_ENDPOINT_MEDIA_CHILDREN;
    let viewerAuthorizationGeneration: string | null = null;
    let currentQualitySettings: QualitySettings = DEFAULT_QUALITY_SETTINGS;
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

    const rebaselineAfterResume = (): void => {
      decodedFrameStall.rebaseline();
    };
    const rebaselineAfterVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      decodedFrameStall.rebaseline();
      setFrameProofEpoch((current) => current + 1);
    };
    document.addEventListener("resume", rebaselineAfterResume);
    document.addEventListener(
      "visibilitychange",
      rebaselineAfterVisibilityChange,
    );

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
        clientId: getStableClientId("viewer", roomId),
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
    function activateRouteIdentity(
      revision: number,
      assignment: ParticipantRouteAssignment,
      connectionId: string | null,
    ): void {
      currentRouteRevision = revision;
      currentRouteAssignment = assignment;
      currentRouteConnectionId =
        assignment.upstream.kind === "none" ? null : connectionId;
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

    function observeActiveDecodedFrames(
      route: "peer" | "sfu",
      identity: string,
      framesDecodedDelta: number | null,
      connectionId?: string,
    ): void {
      if (
        !peerAssisted ||
        currentHostPaused ||
        !decodedFrameStall.observe(
          `${route}:${currentRouteRevision}:${identity}`,
          framesDecodedDelta,
        )
      ) {
        return;
      }
      if (route === "peer" && connectionId) {
        signal.send({
          type: "route-failed",
          revision: currentRouteRevision,
          phase: "active",
          connectionId,
        });
      } else if (route === "sfu") {
        signal.send({
          type: "route-media-unavailable",
          revision: currentRouteRevision,
        });
      }
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
      if (!pendingPeerHasDecodedFrame(probe)) {
        return false;
      }
      probe.readySent = signal.send({
        type: "route-ready",
        revision: probe.revision,
        phase: "prepare",
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
              readySent: false,
              candidateConnectionId: candidate.connectionId,
              stream: null,
              snapshot: null,
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
        onSfuDecodedFrameSample: (framesDecodedDelta, revision) => {
          if (active && viewerSfuRoute === route) {
            observeActiveDecodedFrames(
              "sfu",
              String(revision),
              framesDecodedDelta,
            );
          }
        },
        onSfuUpdate: (metrics, revision) => {
          if (active && viewerSfuRoute === route) {
            if (metrics) {
              if (
                currentRouteAssignment?.upstream.kind === "sfu" &&
                currentRouteConnectionId &&
                revision === currentRouteRevision
              ) {
                qualityEvidenceReporter.offerMetrics(
                  currentRouteConnectionId,
                  metrics,
                  revision,
                );
              }
            }
            setSfuUpstream((current) =>
              metrics && current ? { ...current, metrics } : null,
            );
          }
        },
        onSfuState: (state, revision) => {
          if (active && viewerSfuRoute === route) {
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
          sendRestartRequest: () => false,
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
              provePendingPeer();
            } else if (active && peerRef.current === peer) {
              observeActiveDecodedFrames(
                "peer",
                `${probe.parentPeerId}:${snapshot.connectionId}`,
                snapshot.metrics.intervalFramesDecoded,
                snapshot.connectionId,
              );
              qualityEvidenceReporter.offer(snapshot, currentRouteRevision);
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
              probe.readySent = false;
              peer.dispose();
              return true;
            }
            return peerRef.current === peer && viewerSfuRoute
              ? viewerSfuRoute.reportPeerFailure(parentPeerId, connectionId)
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
      const peer = new ViewerPeer(
        currentIceConfig,
        {
          sendSignal: (targetPeerId, payload) =>
            signal.send(
              viewerSignalMessage(peerAssisted, targetPeerId, payload),
            ),
          sendRestartRequest: (targetPeerId, connectionId, rebuild) =>
            signal.send(
              viewerRestartMessage(
                peerAssisted,
                targetPeerId,
                connectionId,
                rebuild,
              ),
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
              observeActiveDecodedFrames(
                "peer",
                `${snapshot.peerId}:${snapshot.connectionId}`,
                snapshot.metrics.intervalFramesDecoded,
                snapshot.connectionId,
              );
              qualityEvidenceReporter.offer(snapshot, currentRouteRevision);
              if (
                !currentHostOnline &&
                (snapshot.connectionState === "failed" ||
                  snapshot.connectionState === "closed")
              ) {
                clearPeerState();
                dispatchPresentation({
                  type: "media-invalidated",
                  revision: currentRouteRevision,
                });
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
          onRecoveryExhausted: (parentPeerId, connectionId) => {
            if (viewerSfuRoute) {
              return viewerSfuRoute.reportPeerFailure(parentPeerId, connectionId);
            }
            dispatchPresentation({
              type: "failure",
              failure: "ROUTE_EXHAUSTED",
              revision: currentRouteRevision,
            });
            setFrameProofEpoch((current) => current + 1);
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
        hadAuthenticated = true;
        dispatchPresentation({ type: "access", access: "ready" });
        setViewerPasswordDraft("");
        setViewerPasswordError(null);
        clearRelayChildEvidence();
        currentPeerId = message.peerId;
        endpointMediaCopyCapacity = message.endpointMediaCopyCapacity;
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
        setHostOnline(message.hostOnline);
        const sharingPaused = message.hostPaused ?? false;
        currentHostPaused = sharingPaused;
        decodedFrameStall.setPaused(sharingPaused);
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
          void viewerRelay?.updateProfile(currentQualitySettings);
          const route = ensureViewerSfuRoute();
          route.setPaused(sharingPaused);
          await route.resyncAuthoritative(
            {
              revision: message.routeRevision,
              phase: "active",
              assignment: message.routeAssignment,
            },
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
              const peerIdentity = peerRef.current?.getConnectionIdentity();
              const exactPeerUpstream =
                samePeerUpstream &&
                currentRouteAssignment?.upstream.kind === "peer" &&
                currentRouteConnectionId !== null &&
                peerIdentity != null &&
                peerIdentity.parentPeerId ===
                  currentRouteAssignment.upstream.peerId &&
                peerIdentity.connectionId === currentRouteConnectionId;
              const preserveMedia =
                remoteMediaRef.current !== null &&
                (sameSfuUpstream || exactPeerUpstream);
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
                preserveMedia,
              );
            }
          }
        }
        return;
      }
      if (message.type === "route-status") {
        dispatchPresentation({
          type: "route-status",
          revision: message.revision,
          state: message.state,
        });
        if (message.state === "failed") {
          setFrameProofEpoch((current) => current + 1);
        }
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
      if (message.type === "media-assignment") {
        if (peerAssisted && !viewerSfuRoute) {
          applyMediaAssignment(message.mediaAssignment);
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
        currentHostPaused = message.paused;
        decodedFrameStall.setPaused(message.paused);
        setHostOnline(message.online);
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
        setParticipantPresence(message.viewers);
        return;
      }
      if (message.type === "sharing-stopped") {
        currentRouteAssignment = null;
        currentRouteConnectionId = null;
        pendingRouteConnection = null;
        setSfuStandbyUrl(null);
        setAssignedRoute(null);
        currentHostOnline = false;
        currentHostPaused = false;
        decodedFrameStall.reset();
        clearViewerSfuRoute();
        clearPeerState(true);
        clearHostPresence();
        setHostOnline(false);
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
          clearHostPresence();
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
          const failure =
            hadAuthenticated &&
            (message.code === "INVALID_TOKEN" ||
              message.code === "ROOM_NOT_FOUND" ||
              message.code === "ROOM_ACCESS_DENIED")
              ? "ROOM_LOST"
              : viewerFailureFromServerCode(message.code);
          dispatchPresentation({
            type: "access",
            access: "denied",
            failure,
          });
        }
        if (message.code === "INVALID_TOKEN") {
          clearViewerGrant(roomId);
          if (!viewerGrant && viewerPasswordAttempt) {
            setViewerPasswordError("无法加入房间，请重试");
          }
          return;
        }
        if (message.code === "ROOM_ACCESS_DENIED") {
          if (viewerPasswordAttempt) {
            setViewerPasswordError("当前无法通过房间号加入");
            setViewerPasswordExpanded(true);
          }
          return;
        }
        const failure = viewerFailureFromServerCode(message.code);
        if (failure) {
          dispatchPresentation({ type: "failure", failure });
        } else if (message.code !== "PEER_NOT_FOUND") {
          dispatchPresentation({ type: "failure", failure: "SERVER_ERROR" });
        }
      }
    }

    signal.start();
    return () => {
      active = false;
      document.removeEventListener("resume", rebaselineAfterResume);
      document.removeEventListener(
        "visibilitychange",
        rebaselineAfterVisibilityChange,
      );
      currentPeerId = null;
      qualityEvidenceReporter.reset();
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
    video.srcObject = remoteMedia.stream;
    if (presentationState.host === "paused") {
      video.pause();
      return;
    }
    attemptPlayback(video, remoteMedia);
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
    if (!video || !remoteMedia) {
      return;
    }
    return observeCompositedVideoFrame(video, remoteMedia.stream, () =>
      dispatchPresentation({
        type: "frame-presented",
        generation: remoteMedia.generation,
        revision: remoteMedia.revision,
      }),
    );
  }, [frameProofEpoch, presentationState.connection, remoteMedia]);

  useEffect(() => {
    if (presentation.overlay === "none") {
      return;
    }
    const video = videoRef.current as
      | (HTMLVideoElement & {
          webkitDisplayingFullscreen?: boolean;
          webkitExitFullscreen?: () => void;
        })
      | null;
    if (!video) {
      return;
    }
    if (document.fullscreenElement === video) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (video.webkitDisplayingFullscreen) {
      try {
        video.webkitExitFullscreen?.();
      } catch {}
    }
  }, [presentation.overlay]);

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
    const saved = saveDisplayName(displayNameDraft);
    if (!saved) {
      setDisplayNameError("名称格式无效或超过 24 个字符");
      return;
    }
    displayNameRef.current = saved;
    setDisplayName(saved);
    setDisplayNameDraft(saved);
    setDisplayNameError(null);
    setEditingDisplayName(false);
    signalRef.current?.setViewerDisplayName(saved);
  }

  function submitViewerPassword(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!viewerPasswordSchema.safeParse(viewerPasswordDraft).success) {
      setViewerPasswordError(
        `请输入 1-${MAX_VIEWER_PASSWORD_LENGTH} 个可见字符`,
      );
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
    const codeOnlyDenied =
      !viewerGrant && presentationState.failure === "ROOM_ACCESS_DENIED";
    const canRefresh = [
      "ROOM_LOST",
      "STALE_CLIENT",
      "SERVER_ERROR",
      "SESSION_REPLACED",
      "SIGNAL_TERMINATED",
    ].includes(presentationState.failure ?? "");
    return (
      <div className="app-shell">
        <main className="access-workspace access-workspace-full">
          {accessState === "checking" ? (
            <div className="access-loading" role="status">
              <LoaderCircle size={20} className="spin" aria-hidden="true" />
              正在加入房间
            </div>
          ) : (
            <section className="access-panel">
              <div>
                <h1>{presentation.message}</h1>
                <p className="section-meta">
                  {codeOnlyDenied
                    ? "请使用分享者提供的邀请链接，或尝试房间密码。"
                    : presentationState.failure === "ROOM_NOT_FOUND"
                      ? "请确认房间号，或向分享者获取新的邀请链接。"
                    : viewerGrant
                      ? "请向分享者获取新的邀请链接。"
                      : "请检查入口后重试。"}
                </p>
              </div>
              {codeOnlyDenied && !viewerPasswordExpanded && (
                <button
                  className="button button-secondary"
                  type="button"
                  aria-expanded="false"
                  aria-controls="viewer-password-retry"
                  onClick={() => setViewerPasswordExpanded(true)}
                >
                  <KeyRound size={16} aria-hidden="true" />
                  输入房间密码
                </button>
              )}
              {codeOnlyDenied && viewerPasswordExpanded && (
                <form
                  id="viewer-password-retry"
                  className="access-password-retry"
                  onSubmit={submitViewerPassword}
                >
                  <label className="token-field">
                    <span>房间密码</span>
                    <span className="input-with-icon">
                      <KeyRound size={16} aria-hidden="true" />
                      <input
                        type="password"
                        value={viewerPasswordDraft}
                        maxLength={MAX_VIEWER_PASSWORD_LENGTH}
                        autoComplete="current-password"
                        autoFocus
                        onChange={(event) => {
                          setViewerPasswordDraft(event.target.value);
                          setViewerPasswordError(null);
                        }}
                      />
                    </span>
                  </label>
                  {viewerPasswordError && (
                    <p className="access-error" role="alert">
                      {viewerPasswordError}
                    </p>
                  )}
                  <button className="button button-primary" type="submit">
                    加入
                  </button>
                </form>
              )}
              {canRefresh && (
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => window.location.reload()}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  刷新页面
                </button>
              )}
            </section>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell viewer-shell">
      <AppHeader
        status={
          showConnectionDetails ? (
            <SignalStatusBadge state={signalStatus} />
          ) : null
        }
      />

      <main className="viewer-workspace">
        <div className="viewer-title-row">
          <div>
            <div className="title-line">
              <h1>
                {hostPresence ? `${hostPresence.displayName} 的屏幕` : "好友屏幕"}
              </h1>
              <RoomCode roomId={roomId} />
            </div>
          </div>
          <div className="viewer-badges">
            <PeerStatusBadge
              state={routeConnectionState}
            />
            {showConnectionDetails && routePresentation.route && (
              <>
                <MediaRouteBadge route={routePresentation.route} />
              </>
            )}
          </div>
        </div>

        <form
          className={`viewer-name-control${
            editingDisplayName ? " is-editing" : ""
          }`}
          onSubmit={(event) => {
            event.preventDefault();
            commitDisplayName();
          }}
        >
          <label
            htmlFor={editingDisplayName ? "viewer-display-name" : undefined}
          >
            昵称
          </label>
          {editingDisplayName ? (
            <>
              <input
                id="viewer-display-name"
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

        <section className="video-stage remote-stage" aria-label="共享画面">
          <video
            ref={videoRef}
            autoPlay
            controls={
              presentation.overlay === "none" ||
              presentation.stage === "needs-play"
            }
            playsInline
            onPlay={() => {
              const binding = remoteMediaRef.current;
              if (binding) {
                dispatchPresentation({
                  type: "autoplay-cleared",
                  generation: binding.generation,
                });
              }
            }}
          />
          {presentation.overlay === "blocking" && (
            <div className="stage-placeholder" role="status">
              <VideoOff size={36} strokeWidth={1.5} aria-hidden="true" />
              <span>{presentation.message}</span>
            </div>
          )}
          {presentation.overlay === "status" && (
            <div className="stage-overlay" role="status">
              {presentation.message}
            </div>
          )}
        </section>

        <div className="viewer-status-row">
          <div className="toolbar-status" role="status" aria-live="polite">
            {presentation.message}
          </div>
          <div className="viewer-status-actions">
            {labeledHostPresence ? (
              <button
                className="icon-button viewer-status-action"
                type="button"
                title={showTopology ? "隐藏连接拓扑" : "显示连接拓扑"}
                aria-label={showTopology ? "隐藏连接拓扑" : "显示连接拓扑"}
                aria-controls="room-topology"
                aria-expanded={showTopology}
                onClick={() => setShowTopology((current) => !current)}
              >
                <Network size={18} aria-hidden="true" />
              </button>
            ) : (
              <span className="viewer-status-action-placeholder" aria-hidden="true" />
            )}
            <button
              type="button"
              className="icon-button viewer-status-action"
              title="重新连接媒体"
              aria-label="重新连接媒体"
              disabled={!reconnectAvailable}
              onClick={retryConnection}
            >
              <RefreshCw size={18} />
            </button>
          </div>
        </div>

        {presentation.notice && (
          <div className="notice" role="status">
            {presentation.notice}
          </div>
        )}
        {participantPresence && (
          <section
            className="viewer-roster"
            aria-labelledby="viewer-roster-heading"
          >
            <div className="viewer-roster-heading">
              <div>
                <h2 id="viewer-roster-heading">观看者</h2>
                <span>在线 {viewers.length}</span>
              </div>
            </div>
            {showTopology && labeledHostPresence && (
              <TopologyView
                hostPeerId={labeledHostPresence.peerId}
                hostLabel={labeledHostPresence.label}
                viewers={viewers}
              />
            )}
            <ul className="viewer-roster-list">
              {viewers.map((viewer) => (
                <li key={viewer.peerId} title={viewer.label}>
                  {viewer.label}
                </li>
              ))}
            </ul>
          </section>
        )}

        <ConnectionDetailsToggle
          checked={showConnectionDetails}
          onChange={setShowConnectionDetails}
        />

        {routePresentation.evidence === peerSnapshot && peerSnapshot?.error && (
          <div className="notice notice-error" role="status">
            P2P 媒体连接异常
          </div>
        )}
        {relaySnapshot?.error && (
          <div className="notice notice-error" role="status">
            下游媒体连接异常
          </div>
        )}
        {qualityLimitation && (
          <WarningBanner>{qualityLimitation}</WarningBanner>
        )}
        {showConnectionDetails && routePresentation.route && (
          <section className="viewer-stats" aria-labelledby="stats-heading">
            <h2 id="stats-heading">连接数据</h2>
            <div className="viewer-transport-heading">
              <MediaRouteBadge route={routePresentation.route} />
            </div>
            {routeMetrics && (
              <StatsGrid
                metrics={routeMetrics}
                direction="receive"
              />
            )}
          </section>
        )}
        {showConnectionDetails && relaySnapshot && (
          <section className="viewer-stats" aria-labelledby="relay-stats-heading">
            <h2 id="relay-stats-heading">转发数据</h2>
            <StatsGrid
              metrics={relaySnapshot.metrics}
              direction="send"
            />
          </section>
        )}
        {showConnectionDetails && relayChildEvidence && (
          <section
            className="viewer-stats"
            aria-labelledby="relay-child-stats-heading"
          >
            <h2 id="relay-child-stats-heading">下游接收数据</h2>
            <StatsGrid
              metrics={metricsFromQualityEvidence(relayChildEvidence.evidence)}
              direction="receive"
            />
          </section>
        )}
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

function viewerFailureFromServerCode(
  code: Extract<ServerMessage, { type: "error" }>["code"],
): ViewerFailureCode | null {
  switch (code) {
    case "ROOM_NOT_FOUND":
      return "ROOM_NOT_FOUND";
    case "ROOM_ACCESS_DENIED":
      return "ROOM_ACCESS_DENIED";
    case "INVALID_TOKEN":
    case "AUTH_REQUIRED":
      return "INVALID_TOKEN";
    case "ROOM_EXPIRED":
      return "ROOM_EXPIRED";
    case "ROOM_FULL":
      return "ROOM_FULL";
    case "SERVER_ERROR":
      return "SERVER_ERROR";
    default:
      return null;
  }
}
