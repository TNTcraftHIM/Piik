import {
  Maximize2,
  Play,
  RefreshCw,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_QUALITY_SETTINGS,
  type IceConfig,
  type MediaAssignment,
  type ServerMessage,
} from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import { ConnectionDetailsToggle } from "../components/ConnectionDetailsToggle";
import { qualityLimitationSummary } from "../components/connection-details";
import {
  PathBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { getStableClientId } from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import type { QualitySettings } from "../media/quality";
import { relayCapacityMessageForBrowser } from "../media/relay-capability";
import { SfuStandbyPrewarmer } from "../media/sfu-standby-prewarmer";
import { ViewerMessageAuthority } from "../media/viewer-message-authority";
import { ViewerSfuRoute } from "../media/viewer-sfu-route";
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
  onAuthorizationRequired: () => void;
}

export function ViewerPage({ roomId, onAuthorizationRequired }: ViewerPageProps) {
  const forceRelay = useMemo(
    () => new URLSearchParams(window.location.search).get("relay") === "1",
    [],
  );
  const [signalStatus, setSignalStatus] =
    useState<SignalConnectionState>("offline");
  const [statusText, setStatusText] = useState("正在连接");
  const [hostOnline, setHostOnline] = useState(false);
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [peerSnapshot, setPeerSnapshot] = useState<PeerSnapshot | null>(null);
  const [relaySnapshot, setRelaySnapshot] = useState<PeerSnapshot | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);

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

  useEffect(() => {
    let active = true;
    let currentIceConfig: IceConfig | null = null;
    let currentHostOnline = false;
    let peerAssisted = false;
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
    const messageAuthority = new ViewerMessageAuthority();
    let sfuStandbyPrewarmer: SfuStandbyPrewarmer | null = null;

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
      },
      {
        onStatus: (status) => {
          if (active) {
            setSignalStatus(status);
          }
        },
        onProtocolError: (message) => {
          if (active) {
            messageAuthority.invalidate();
            setSfuStandbyUrl(null);
            setStatusText(message);
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
          setStatusText(message);
        },
        onAccessRequired: () => {
          if (active) {
            messageAuthority.invalidate();
            setSfuStandbyUrl(null);
            onAuthorizationRequired();
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
            active &&
            peerAssisted &&
            currentAssignment.childPeerIds[0] === targetPeerId
              ? signal.send({
                  type: "signal",
                  targetPeerId,
                  payload,
                })
              : false,
          onUpdate: (snapshot) => {
            if (active) {
              setRelaySnapshot(snapshot);
            }
          },
        },
        forceRelay,
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
          clearPeerState();
          viewerRelay?.setChild(null);
        },
        reconcileSfuChildren: (childPeerIds) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          currentAssignment = limitMediaAssignment(
            {
              parentPeerId: currentAssignment.parentPeerId,
              childPeerIds,
            },
            MAX_VIEWER_MEDIA_CHILDREN,
          );
          ensureViewerRelay()?.setChild(
            currentAssignment.childPeerIds[0] ?? null,
          );
        },
        onSfuStream: (nextStream, assignment, initialVideoStream) => {
          if (!active || viewerSfuRoute !== route) {
            return;
          }
          currentAssignment = limitMediaAssignment(
            { parentPeerId: null, childPeerIds: assignment.childPeerIds },
            MAX_VIEWER_MEDIA_CHILDREN,
          );
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
      peerRef.current?.dispose();
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
      currentAssignment = nextAssignment;

      if (previousParentId !== nextAssignment.parentPeerId) {
        clearUpstreamState();
        setStatusText("正在恢复连接");
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
              setRemoteStream(nextStream);
              setStatusText("正在播放");
              // Audio and video can arrive as separate track events on the
              // same MediaStream, so refresh both downstream senders each time.
              ensureViewerRelay()?.setStream(nextStream);
            }
          },
          onUpdate: (snapshot) => {
            if (active) {
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
          onRecoveryExhausted: (parentPeerId, connectionId) =>
            viewerSfuRoute?.reportPeerFailure(parentPeerId, connectionId) ?? true,
        },
        forceRelay,
      );
      peerRef.current = peer;
      return peer;
    }

    async function handleMessage(
      message: ServerMessage,
      authorityToken: number,
    ): Promise<void> {
      if (message.type === "authenticated") {
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
        const relayCapacity = relayCapacityMessageForBrowser(nextPeerAssisted);
        if (relayCapacity) {
          signal.send(relayCapacity);
        }
        currentIceConfig = message.iceConfig;
        currentHostOnline = message.hostOnline;
        setRelayAvailable(message.iceConfig.relayAvailable);
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
      if (message.type === "route-update") {
        if (peerAssisted) {
          ensureViewerSfuRoute().accept(message);
        }
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
      if (message.type === "ice-config") {
        currentIceConfig = message.iceConfig;
        setRelayAvailable(message.iceConfig.relayAvailable);
        peerRef.current?.updateIceConfig(message.iceConfig);
        viewerRelay?.updateIceConfig(message.iceConfig);
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
      if (message.type === "room-closed") {
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
        }
        setStatusText(message.message);
      }
    }

    signal.start();
    return () => {
      active = false;
      sfuStandbyPrewarmer?.dispose();
      signal.stop();
      void viewerSfuRoute?.disconnect();
      viewerSfuRoute = null;
      preparedParentPeerId = null;
      preparedParentSignals = [];
      peerRef.current?.dispose();
      peerRef.current = null;
      viewerRelay?.dispose();
      viewerRelay = null;
    };
  }, [forceRelay, onAuthorizationRequired, roomId]);

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
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (videoRef.current) {
      videoRef.current.muted = nextMuted;
      if (!nextMuted) {
        void playVideo();
      }
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
            <h1>好友屏幕</h1>
            <p className="section-meta">房间 {roomId}</p>
          </div>
          <div className="viewer-badges">
            {showConnectionDetails && forceRelay && (
              <span className="diagnostic-badge">强制中继</span>
            )}
            <PeerStatusBadge state={peerSnapshot?.connectionState ?? "waiting"} />
            {showConnectionDetails && (
              <PathBadge path={peerSnapshot?.metrics.path ?? "unknown"} />
            )}
          </div>
        </div>

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
            <button
              type="button"
              className="icon-button"
              title={muted ? "打开声音" : "静音"}
              aria-label={muted ? "打开声音" : "静音"}
              onClick={toggleMuted}
            >
              {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
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

        {showConnectionDetails &&
          !relayAvailable &&
          signalStatus === "connected" &&
          (hostOnline || peerSnapshot) && (
          <WarningBanner>TURN 未配置，严格网络可能无法连接</WarningBanner>
        )}
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
      </main>
    </div>
  );
}
