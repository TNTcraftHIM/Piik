import {
  LoaderCircle,
  Maximize2,
  Play,
  RefreshCw,
  Save,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_QUALITY_SETTINGS,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
  type IceConfig,
  type MediaAssignment,
  type ServerMessage,
} from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import { ConnectionDetailsToggle } from "../components/ConnectionDetailsToggle";
import { RoomCode } from "../components/RoomCode";
import { qualityLimitationSummary } from "../components/connection-details";
import {
  PathBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { readDisplayName, saveDisplayName } from "../lib/display-name";
import { clearViewerGrant, getStableClientId } from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import type { QualitySettings } from "../media/quality";
import {
  ParentEdgeQualityEvidenceReporter,
} from "../media/parent-edge-quality-evidence";
import { relayCapacityMessageForBrowser } from "../media/relay-capability";
import { SfuStandbyPrewarmer } from "../media/sfu-standby-prewarmer";
import {
  metricsFromQualityEvidence,
  qualityEvidenceMatchesSnapshot,
  ViewerQualityEvidenceReporter,
} from "../media/viewer-quality-evidence";
import { ViewerMessageAuthority } from "../media/viewer-message-authority";
import { ViewerSfuRoute } from "../media/viewer-sfu-route";
import {
  applyViewerVolume,
  DEFAULT_VIEWER_VOLUME_STATE,
  setViewerVolume,
  toggleViewerMuted,
} from "../media/viewer-volume";
import type {
  PeerSnapshot,
  SignalConnectionState,
} from "../types";
import {
  limitMediaAssignment,
  MAX_VIEWER_MEDIA_CHILDREN,
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
type SelectedEdgeTurn = Extract<ServerMessage, { type: "selected-edge-turn" }>;

export function ViewerPage({ roomId, viewerGrant }: ViewerPageProps) {
  const [accessState, setAccessState] = useState<
    "checking" | "ready" | "denied"
  >("checking");
  const [signalStatus, setSignalStatus] =
    useState<SignalConnectionState>("offline");
  const [statusText, setStatusText] = useState("正在连接");
  const [hostOnline, setHostOnline] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [peerSnapshot, setPeerSnapshot] = useState<PeerSnapshot | null>(null);
  const [relaySnapshot, setRelaySnapshot] = useState<PeerSnapshot | null>(null);
  const [relayChildEvidence, setRelayChildEvidence] =
    useState<ViewerQualityEvidence | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(
    DEFAULT_VIEWER_VOLUME_STATE,
  );
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [displayName, setDisplayName] = useState(() => readDisplayName());
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);

  const qualityLimitation = useMemo(
    () =>
      qualityLimitationSummary(
        [peerSnapshot, relaySnapshot].filter(
          (snapshot): snapshot is PeerSnapshot => snapshot !== null,
        ),
      ),
    [peerSnapshot, relaySnapshot],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<ViewerPeer | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const displayNameRef = useRef(displayName);
  const { muted, volumePercent } = playbackVolume;

  useEffect(() => {
    let active = true;
    let viewerAuthenticated = false;
    let currentIceConfig: IceConfig | null = null;
    let currentHostOnline = false;
    let peerAssisted = false;
    let currentPeerId: string | null = null;
    let currentRouteRevision = 0;
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
    let retiredUpstream: {
      parentPeerId: string;
      connectionId: string;
    } | null = null;
    let selectedEdgeTurn: SelectedEdgeTurn | null = null;
    const messageAuthority = new ViewerMessageAuthority();
    let sfuStandbyPrewarmer: SfuStandbyPrewarmer | null = null;
    let relayChildEvidenceCurrent: ViewerQualityEvidence | null = null;
    let relayChildEvidenceTimer: number | null = null;

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
        displayName: displayNameRef.current,
      },
      {
        onStatus: (status) => {
          if (active) {
            setSignalStatus(status);
          }
        },
        onTerminated: (message) => {
          if (!active) {
            return;
          }
          messageAuthority.invalidate();
          setSfuStandbyUrl(null);
          clearViewerSfuRoute();
          clearPeerState();
          if (!viewerAuthenticated) {
            setAccessState("denied");
          }
          setStatusText(message);
        },
        onAccessRequired: () => {
          if (active) {
            messageAuthority.invalidate();
            setSfuStandbyUrl(null);
            clearViewerSfuRoute();
            clearPeerState();
            viewerAuthenticated = false;
            setAccessState("denied");
            setStatusText("邀请无效或已失效");
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
    const parentEdgeQualityEvidenceReporter =
      new ParentEdgeQualityEvidenceReporter();

    function clearRelayChildEvidence(): void {
      relayChildEvidenceCurrent = null;
      setRelayChildEvidence(null);
      if (relayChildEvidenceTimer !== null) {
        window.clearTimeout(relayChildEvidenceTimer);
        relayChildEvidenceTimer = null;
      }
    }

    function acceptRelayChildEvidence(evidence: ViewerQualityEvidence): void {
      const relaySnapshot = viewerRelay?.getSnapshot() ?? null;
      if (
        !peerAssisted ||
        evidence.parentPeerId !== currentPeerId ||
        evidence.guard.routeRevision !== currentRouteRevision ||
        !qualityEvidenceMatchesSnapshot(evidence, relaySnapshot)
      ) {
        return;
      }
      const parentEvidence = parentEdgeQualityEvidenceReporter.offer(
        evidence,
        relaySnapshot,
      );
      if (parentEvidence) {
        signal.send(parentEvidence);
      }
      clearRelayChildEvidence();
      relayChildEvidenceCurrent = evidence;
      setRelayChildEvidence(evidence);
      relayChildEvidenceTimer = window.setTimeout(() => {
        if (relayChildEvidenceCurrent === evidence) {
          clearRelayChildEvidence();
        }
      }, VIEWER_QUALITY_EVIDENCE_EXPIRY_MS);
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
              if (
                relayChildEvidenceCurrent &&
                !qualityEvidenceMatchesSnapshot(
                  relayChildEvidenceCurrent,
                  snapshot,
                )
              ) {
                clearRelayChildEvidence();
              }
            }
          },
        },
      );
      viewerRelay.setChild(currentAssignment.childPeerIds[0] ?? null);
      return viewerRelay;
    }

    function ensureViewerSfuRoute(): ViewerSfuRoute {
      if (viewerSfuRoute) {
        return viewerSfuRoute;
      }
      let route: ViewerSfuRoute;
      route = new ViewerSfuRoute({
        activatePeer: (assignment) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          applyMediaAssignment({
            parentPeerId:
              assignment.upstream.kind === "peer"
                ? assignment.upstream.peerId
                : null,
            childPeerIds: assignment.childPeerIds,
          });
          if (assignment.upstream.kind === "peer") {
            return drainPreparedParentSignals(assignment.upstream.peerId);
          }
        },
        preparePeer: (assignment) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          prepareParent(
            assignment?.upstream.kind === "peer"
              ? assignment.upstream.peerId
              : null,
          );
        },
        resetMedia: () => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          currentAssignment = { parentPeerId: null, childPeerIds: [] };
          parentEdgeQualityEvidenceReporter.reset();
          clearPeerState();
          viewerRelay?.setChild(null);
        },
        reconcileSfuChildren: (childPeerIds) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          const previousChildId = currentAssignment.childPeerIds[0] ?? null;
          currentAssignment = limitMediaAssignment(
            {
              parentPeerId: currentAssignment.parentPeerId,
              childPeerIds,
            },
            MAX_VIEWER_MEDIA_CHILDREN,
          );
          if (
            previousChildId &&
            previousChildId !== (currentAssignment.childPeerIds[0] ?? null)
          ) {
            parentEdgeQualityEvidenceReporter.forget(previousChildId);
          }
          ensureViewerRelay()?.setChild(
            currentAssignment.childPeerIds[0] ?? null,
          );
        },
        onSfuStream: (nextStream, assignment, initialVideoStream) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          const previousChildId = currentAssignment.childPeerIds[0] ?? null;
          currentAssignment = limitMediaAssignment(
            { parentPeerId: null, childPeerIds: assignment.childPeerIds },
            MAX_VIEWER_MEDIA_CHILDREN,
          );
          if (
            previousChildId &&
            previousChildId !== (currentAssignment.childPeerIds[0] ?? null)
          ) {
            parentEdgeQualityEvidenceReporter.forget(previousChildId);
          }
          const relay = ensureViewerRelay();
          relay?.setChild(currentAssignment.childPeerIds[0] ?? null);
          relay?.setStream(nextStream);
          setRemoteStream(nextStream);
          setStatusText("正在播放");
          if (initialVideoStream) {
            peerRef.current?.dispose();
            peerRef.current = null;
            setPeerSnapshot(null);
          }
        },
        send: (message) =>
          active && viewerSfuRoute === route ? signal.send(message) : false,
      });
      viewerSfuRoute = route;
      return route;
    }

    function clearViewerSfuRoute(): void {
      const route = viewerSfuRoute;
      viewerSfuRoute = null;
      prepareParent(null);
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

    function clearUpstreamState(): void {
      qualityEvidenceReporter.reset();
      const peer = peerRef.current;
      retiredUpstream = peer?.getConnectionIdentity() ?? retiredUpstream;
      peer?.dispose();
      peerRef.current = null;
      setRemoteStream(null);
      setPeerSnapshot(null);
      setPlaybackBlocked(false);
    }

    function clearPeerState(): void {
      clearUpstreamState();
      viewerRelay?.stop();
    }

    function applyMediaAssignment(assignment: MediaAssignment): void {
      const nextAssignment = limitMediaAssignment(
        assignment,
        MAX_VIEWER_MEDIA_CHILDREN,
      );
      const previousParentId = currentAssignment.parentPeerId;
      const previousChildId = currentAssignment.childPeerIds[0] ?? null;
      currentAssignment = nextAssignment;

      if (previousParentId !== nextAssignment.parentPeerId) {
        clearUpstreamState();
        setStatusText("正在恢复连接");
      }
      if (previousChildId !== (nextAssignment.childPeerIds[0] ?? null)) {
        if (previousChildId) {
          parentEdgeQualityEvidenceReporter.forget(previousChildId);
        }
        clearRelayChildEvidence();
      }
      ensureViewerRelay()?.setChild(nextAssignment.childPeerIds[0] ?? null);
    }

    function ensurePeer(): ViewerPeer | null {
      if (peerRef.current) {
        return peerRef.current;
      }
      if (!currentIceConfig) {
        return null;
      }
      const peer = new ViewerPeer(
        selectedEdgeTurn
          ? { iceServers: [selectedEdgeTurn.iceServer] }
          : currentIceConfig,
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
              setRemoteStream(nextStream);
              setStatusText("正在播放");
              // Audio and video can arrive as separate track events on the
              // same MediaStream, so refresh both downstream senders each time.
              ensureViewerRelay()?.setStream(nextStream);
            }
          },
          onUpdate: (snapshot) => {
            if (active) {
              qualityEvidenceReporter.offer(snapshot, currentRouteRevision);
              if (
                !currentHostOnline &&
                snapshot.connectionState === "failed"
              ) {
                clearPeerState();
                setStatusText("等待开始分享");
                return;
              }
              setPeerSnapshot(snapshot);
              if (snapshot.connectionState === "connected") {
                setStatusText("已连接");
              } else if (
                snapshot.connectionState === "failed" ||
                snapshot.connectionState === "disconnected"
              ) {
                setStatusText("正在恢复连接");
              }
            }
          },
          onRecoveryExhausted: (parentPeerId, connectionId) => {
            if (
              selectedEdgeTurn?.parentPeerId === parentPeerId &&
              selectedEdgeTurn.newConnectionId === connectionId
            ) {
              signal.send({
                type: "route-failed",
                revision: selectedEdgeTurn.revision,
                phase: "active",
                connectionId,
              });
              selectedEdgeTurn = null;
              clearUpstreamState();
              setStatusText("无法建立媒体连接");
              return true;
            }
            if (viewerSfuRoute) {
              return viewerSfuRoute.reportPeerFailure(parentPeerId, connectionId);
            }
            setStatusText("无法建立媒体连接");
            return true;
          },
        },
        selectedEdgeTurn !== null,
      );
      peerRef.current = peer;
      return peer;
    }

    async function handleMessage(
      message: ServerMessage,
      authorityToken: number,
    ): Promise<void> {
      if (message.type === "authenticated") {
        selectedEdgeTurn = null;
        viewerAuthenticated = true;
        setAccessState("ready");
        clearRelayChildEvidence();
        currentPeerId = message.peerId;
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
        const relayCapacity = relayCapacityMessageForBrowser(nextPeerAssisted);
        if (relayCapacity) {
          signal.send(relayCapacity);
        }
        currentIceConfig = message.iceConfig;
        currentHostOnline = message.hostOnline;
        setHostOnline(message.hostOnline);
        if (nextPeerAssisted && "qualitySettings" in message) {
          currentQualitySettings = message.qualitySettings;
          void viewerRelay?.updateProfile(currentQualitySettings);
          await ensureViewerSfuRoute().resyncAuthoritative(
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
        setStatusText(message.hostOnline ? "正在连接" : "等待开始分享");
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
      if (message.type === "selected-edge-turn") {
        if (
          !peerAssisted ||
          message.revision !== currentRouteRevision ||
          Date.parse(message.expiresAt) <= Date.now()
        ) {
          return;
        }
        if (message.parentPeerId === currentPeerId) {
          ensureViewerRelay()?.startSelectedEdgeTurn(message);
          return;
        }
        const currentIdentity =
          peerRef.current?.getConnectionIdentity() ?? retiredUpstream;
        if (
          message.viewerPeerId !== currentPeerId ||
          currentIdentity?.parentPeerId !== message.parentPeerId ||
          currentIdentity.connectionId !== message.oldConnectionId
        ) {
          return;
        }
        selectedEdgeTurn = message;
        clearViewerSfuRoute();
        clearUpstreamState();
        currentAssignment = {
          parentPeerId: message.parentPeerId,
          childPeerIds: currentAssignment.childPeerIds,
        };
        setStatusText("正在恢复连接");
        return;
      }
      if (message.type === "route-update") {
        if (peerAssisted) {
          if (message.phase === "active") {
            if (selectedEdgeTurn?.revision !== message.revision) {
              selectedEdgeTurn = null;
            }
            if (message.revision !== currentRouteRevision) {
              clearRelayChildEvidence();
            }
            currentRouteRevision = message.revision;
          }
          ensureViewerSfuRoute().accept(message);
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
        if (
          peerAssisted &&
          preparedParentPeerId === message.fromPeerId
        ) {
          preparedParentSignals.push(message);
          return;
        }
        if (
          peerAssisted &&
          currentAssignment.childPeerIds[0] === message.fromPeerId
        ) {
          await viewerRelay?.acceptSignal(
            message.fromPeerId,
            message.payload,
          );
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
          setStatusText("正在连接");
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
        setHostOnline(message.online);
        if (!message.online && !peerRef.current?.isConnected()) {
          setStatusText("等待开始分享");
        } else if (message.online && !peerRef.current?.isConnected()) {
          setStatusText("正在连接");
        }
        return;
      }
      if (message.type === "sharing-stopped") {
        setSfuStandbyUrl(null);
        currentHostOnline = false;
        clearViewerSfuRoute();
        clearPeerState();
        setHostOnline(false);
        setStatusText("等待开始分享");
        return;
      }
      if (message.type === "viewer-access-revoked") {
        if (
          viewerAuthorizationGeneration !==
          message.viewerAuthorizationGeneration
        ) {
          return;
        }
        viewerAuthorizationGeneration = null;
        viewerAuthenticated = false;
        setAccessState("denied");
        clearViewerGrant(roomId);
        setSfuStandbyUrl(null);
        clearViewerSfuRoute();
        clearPeerState();
        setStatusText("邀请已失效，请向分享者获取新链接");
        signal.stop();
        return;
      }
      if (message.type === "room-closed") {
        viewerAuthenticated = false;
        setAccessState("denied");
        setSfuStandbyUrl(null);
        clearViewerSfuRoute();
        clearPeerState();
        setStatusText(message.reason === "expired" ? "房间已过期" : "房间已关闭");
        signal.stop();
        return;
      }
      if (message.type === "error") {
        if (message.code === "PEER_NOT_FOUND" && !currentHostOnline) {
          clearPeerState();
          setStatusText("等待开始分享");
          return;
        }
        if (
          [
            "AUTH_REQUIRED",
            "INVALID_TOKEN",
            "ROOM_EXPIRED",
            "ROOM_FULL",
          ].includes(message.code)
        ) {
          setSfuStandbyUrl(null);
          clearViewerSfuRoute();
          clearPeerState();
          viewerAuthenticated = false;
          setAccessState("denied");
        }
        if (message.code === "INVALID_TOKEN") {
          clearViewerGrant(roomId);
          setStatusText("邀请无效或已失效");
          return;
        }
        setStatusText(message.message);
      }
    }

    signal.start();
    return () => {
      active = false;
      currentPeerId = null;
      qualityEvidenceReporter.reset();
      parentEdgeQualityEvidenceReporter.reset();
      relayChildEvidenceCurrent = null;
      if (relayChildEvidenceTimer !== null) {
        window.clearTimeout(relayChildEvidenceTimer);
        relayChildEvidenceTimer = null;
      }
      sfuStandbyPrewarmer?.dispose();
      signal.stop();
      if (signalRef.current === signal) {
        signalRef.current = null;
      }
      void viewerSfuRoute?.disconnect();
      viewerSfuRoute = null;
      preparedParentPeerId = null;
      preparedParentSignals = [];
      peerRef.current?.dispose();
      peerRef.current = null;
      viewerRelay?.dispose();
      viewerRelay = null;
    };
  }, [roomId, viewerGrant]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = remoteStream;
    if (remoteStream) {
      void video.play().then(
        () => setPlaybackBlocked(false),
        () => setPlaybackBlocked(true),
      );
    }
  }, [remoteStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    applyViewerVolume(video, playbackVolume);
  }, [muted, remoteStream, volumePercent]);

  async function playVideo(): Promise<void> {
    if (!videoRef.current) {
      return;
    }
    try {
      await videoRef.current.play();
      setPlaybackBlocked(false);
    } catch {
      setPlaybackBlocked(true);
    }
  }

  function toggleMuted(): void {
    const next = toggleViewerMuted(playbackVolume);
    setPlaybackVolume(next);
    if (videoRef.current) {
      applyViewerVolume(videoRef.current, next);
    }
    if (!next.muted) {
      void playVideo();
    }
  }

  function changeVolume(nextPercent: number): void {
    const next = setViewerVolume(playbackVolume, nextPercent);
    setPlaybackVolume(next);
    if (videoRef.current) {
      applyViewerVolume(videoRef.current, next);
    }
    if (!next.muted) {
      void playVideo();
    }
  }

  async function enterFullscreen(): Promise<void> {
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
      setStatusText("当前浏览器无法进入全屏");
    }
  }

  function retryConnection(): void {
    if (!peerRef.current?.requestRecovery()) {
      setStatusText(hostOnline ? "正在连接" : "等待开始分享");
    } else {
      setStatusText("正在恢复连接");
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
    signalRef.current?.setViewerDisplayName(saved);
  }

  if (accessState !== "ready") {
    return (
      <div className="app-shell">
        <main className="access-workspace access-workspace-full">
          {accessState === "checking" ? (
            <div className="access-loading" role="status">
              <LoaderCircle size={20} className="spin" aria-hidden="true" />
              正在验证
            </div>
          ) : (
            <section className="access-panel">
              <h1>无法访问</h1>
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
              <h1>好友屏幕</h1>
              <RoomCode roomId={roomId} />
            </div>
          </div>
          <div className="viewer-badges">
            <PeerStatusBadge state={peerSnapshot?.connectionState ?? "waiting"} />
            {showConnectionDetails && (
              <PathBadge path={peerSnapshot?.metrics.path ?? "unknown"} />
            )}
          </div>
        </div>

        <form
          className="viewer-name-control"
          onSubmit={(event) => {
            event.preventDefault();
            commitDisplayName();
          }}
        >
          <label htmlFor="viewer-display-name">显示名</label>
          <input
            id="viewer-display-name"
            type="text"
            value={displayNameDraft}
            maxLength={96}
            autoComplete="nickname"
            aria-invalid={displayNameError ? "true" : undefined}
            onChange={(event) => {
              setDisplayNameDraft(event.target.value);
              setDisplayNameError(null);
            }}
          />
          <button
            type="submit"
            className="icon-button"
            title="保存显示名"
            aria-label="保存显示名"
            disabled={displayNameDraft === displayName}
          >
            <Save size={17} />
          </button>
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
            playsInline
            muted={muted}
            onPlaying={() => setPlaybackBlocked(false)}
          />
          {!remoteStream && (
            <div className="stage-placeholder">
              <VideoOff size={36} strokeWidth={1.5} aria-hidden="true" />
              <span>{statusText}</span>
            </div>
          )}
          {playbackBlocked && remoteStream && (
            <button
              type="button"
              className="play-overlay"
              onClick={() => void playVideo()}
            >
              <Play size={22} fill="currentColor" aria-hidden="true" />
              播放
            </button>
          )}
        </section>

        <div className="viewer-toolbar">
          <div className="toolbar-status" role="status" aria-live="polite">
            {statusText}
          </div>
          <div className="toolbar-actions">
            <div className="viewer-volume-control">
              <button
                type="button"
                className="icon-button"
                title={muted ? "打开声音" : "静音"}
                aria-label={muted ? "打开声音" : "静音"}
                onClick={toggleMuted}
              >
                {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <input
                id="viewer-volume"
                type="range"
                min="0"
                max="100"
                step="1"
                value={volumePercent}
                title="播放音量"
                aria-label="播放音量"
                aria-valuetext={`${volumePercent}%${muted ? "，已静音" : ""}`}
                onChange={(event) => changeVolume(Number(event.target.value))}
              />
              <output htmlFor="viewer-volume">{volumePercent}%</output>
            </div>
            <button
              type="button"
              className="icon-button"
              title="恢复连接"
              aria-label="恢复连接"
              disabled={!peerSnapshot}
              onClick={retryConnection}
            >
              <RefreshCw size={19} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="全屏"
              aria-label="全屏"
              disabled={!remoteStream}
              onClick={() => void enterFullscreen()}
            >
              <Maximize2 size={19} />
            </button>
          </div>
        </div>

        <ConnectionDetailsToggle
          checked={showConnectionDetails}
          onChange={setShowConnectionDetails}
        />

        {peerSnapshot?.error && (
          <div className="notice notice-error" role="status">
            {peerSnapshot.error}
          </div>
        )}
        {relaySnapshot?.error && (
          <div className="notice notice-error" role="status">
            {relaySnapshot.error}
          </div>
        )}
        {qualityLimitation && (
          <WarningBanner>{qualityLimitation}</WarningBanner>
        )}
        {showConnectionDetails && peerSnapshot && (
          <section className="viewer-stats" aria-labelledby="stats-heading">
            <h2 id="stats-heading">连接数据</h2>
            <StatsGrid metrics={peerSnapshot.metrics} direction="receive" />
          </section>
        )}
        {showConnectionDetails && relaySnapshot && (
          <section className="viewer-stats" aria-labelledby="relay-stats-heading">
            <h2 id="relay-stats-heading">转发数据</h2>
            <StatsGrid
              metrics={relaySnapshot.metrics}
              direction="send"
              senderParameters={relaySnapshot.senderParameters}
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
              metrics={metricsFromQualityEvidence(relayChildEvidence)}
              direction="receive"
            />
          </section>
        )}
      </main>
    </div>
  );
}
