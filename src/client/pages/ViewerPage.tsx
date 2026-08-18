import {
  Maximize2,
  Play,
  RefreshCw,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IceConfig, ServerMessage } from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import {
  PathBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { getStableClientId } from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import { SfuSubscriber } from "../sfu/subscriber";
import type {
  PeerSnapshot,
  SignalConnectionState,
} from "../types";
import { ViewerPeer } from "../webrtc/viewer-peer";

type ActiveMediaMode = "p2p" | "sfu";

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
  const [statusText, setStatusText] = useState("正在进入房间");
  const [hostOnline, setHostOnline] = useState(false);
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [mediaMode, setMediaMode] = useState<ActiveMediaMode | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [peerSnapshot, setPeerSnapshot] = useState<PeerSnapshot | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [sfuRetryAvailable, setSfuRetryAvailable] = useState(false);
  const [muted, setMuted] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<ViewerPeer | null>(null);
  const subscriberRef = useRef<SfuSubscriber | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);

  useEffect(() => {
    let active = true;
    let currentIceConfig: IceConfig | null = null;
    let currentHostOnline = false;
    let currentMediaMode: ActiveMediaMode | null = null;
    let currentSfuStream: MediaStream | null = null;

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
            setStatusText(message);
          }
        },
        onTerminated: (message) => {
          if (!active) {
            return;
          }
          clearPeerState();
          clearSubscriberState();
          setStatusText(message);
        },
        onAccessRequired: () => {
          if (active) {
            onAuthorizationRequired();
          }
        },
        onMessage: (message) => {
          if (!active) {
            return;
          }
          void handleMessage(message);
        },
      },
    );

    function clearPeerState(): void {
      peerRef.current?.dispose();
      peerRef.current = null;
      setRemoteStream(null);
      setPeerSnapshot(null);
      setPlaybackBlocked(false);
    }

    function clearSubscriberState(): void {
      subscriberRef.current?.disconnect();
      subscriberRef.current = null;
      currentSfuStream = null;
      setRemoteStream(null);
      setPlaybackBlocked(false);
      setSfuRetryAvailable(false);
    }

    function ensurePeer(): ViewerPeer | null {
      if (peerRef.current) {
        return peerRef.current;
      }
      if (currentMediaMode !== "p2p" || !currentIceConfig) {
        return null;
      }
      const peer = new ViewerPeer(
        currentIceConfig,
        {
          sendSignal: (payload) => signal.send({ type: "signal", payload }),
          sendRestartRequest: (connectionId, rebuild) =>
            signal.send({ type: "restart-request", connectionId, rebuild }),
          onStream: (nextStream) => {
            if (active) {
              setRemoteStream(nextStream);
              setStatusText("正在播放");
            }
          },
          onUpdate: (snapshot) => {
            if (active) {
              if (
                !currentHostOnline &&
                snapshot.connectionState === "failed"
              ) {
                clearPeerState();
                setStatusText("等待分享者再次开始");
                return;
              }
              setPeerSnapshot(snapshot);
              if (snapshot.connectionState === "connected") {
                setStatusText("已连接");
              } else if (
                snapshot.connectionState === "failed" ||
                snapshot.connectionState === "disconnected"
              ) {
                setStatusText("正在恢复媒体连接");
              }
            }
          },
        },
        forceRelay,
      );
      peerRef.current = peer;
      return peer;
    }

    async function handleMessage(message: ServerMessage): Promise<void> {
      if (message.type === "authenticated") {
        const nextMediaMode = message.mediaMode ?? "p2p";
        currentMediaMode = nextMediaMode;
        currentHostOnline = message.hostOnline;
        setMediaMode(nextMediaMode);
        setHostOnline(message.hostOnline);
        if (message.mediaMode === "sfu") {
          currentIceConfig = null;
          setRelayAvailable(false);
          if (peerRef.current) {
            clearPeerState();
          }
          if (!currentSfuStream) {
            setStatusText(
              message.hostOnline ? "等待分享画面" : "等待分享者开始分享",
            );
          }
          return;
        }

        currentIceConfig = message.iceConfig;
        setRelayAvailable(message.iceConfig.relayAvailable);
        if (subscriberRef.current) {
          clearSubscriberState();
        }
        if (
          !message.hostOnline &&
          message.connectionId === null &&
          !peerRef.current?.isConnected()
        ) {
          clearPeerState();
        }
        setStatusText(
          message.hostOnline ? "等待分享画面" : "等待分享者开始分享",
        );
        const peer = peerRef.current;
        peer?.updateIceConfig(message.iceConfig);
        if (
          message.connectionId &&
          !peer?.hasConnectionId(message.connectionId)
        ) {
          signal.send({
            type: "restart-request",
            connectionId: message.connectionId,
            rebuild: true,
          });
        } else if (peer?.hasConnection() && !peer.isConnected()) {
          peer.requestRecovery();
        }
        return;
      }
      if (message.type === "signal") {
        if (currentMediaMode !== "p2p") {
          return;
        }
        const peer = ensurePeer();
        if (!peer) {
          setStatusText("尚未收到可用的 ICE 配置");
          return;
        }
        await peer.acceptSignal(message.fromPeerId, message.payload);
        return;
      }
      if (message.type === "ice-config") {
        if (currentMediaMode !== "p2p") {
          return;
        }
        currentIceConfig = message.iceConfig;
        setRelayAvailable(message.iceConfig.relayAvailable);
        peerRef.current?.updateIceConfig(message.iceConfig);
        return;
      }
      if (message.type === "sfu-config") {
        if (currentMediaMode !== "sfu" || subscriberRef.current) {
          return;
        }
        const subscriber = new SfuSubscriber({
          onStream: (nextStream) => {
            if (!active || subscriberRef.current !== subscriber) {
              return;
            }
            currentSfuStream = nextStream;
            setRemoteStream(nextStream);
            setPlaybackBlocked(false);
            setStatusText(
              nextStream
                ? "正在播放"
                : currentHostOnline
                  ? "等待分享画面"
                  : "等待分享者开始分享",
            );
          },
          onDisconnected: () => {
            if (!active || subscriberRef.current !== subscriber) {
              return;
            }
            subscriberRef.current = null;
            subscriber.disconnect();
            currentSfuStream = null;
            setRemoteStream(null);
            setPlaybackBlocked(false);
            setSfuRetryAvailable(true);
            setStatusText("SFU 媒体连接已断开，请重试");
          },
        });
        subscriberRef.current = subscriber;
        setSfuRetryAvailable(false);
        try {
          await subscriber.connect({ url: message.url, token: message.token });
        } catch (error) {
          if (active && subscriberRef.current === subscriber) {
            subscriberRef.current = null;
            subscriber.disconnect();
            currentSfuStream = null;
            setRemoteStream(null);
            setSfuRetryAvailable(true);
            setStatusText(
              error instanceof Error && error.message
                ? error.message
                : "无法连接 SFU 媒体服务",
            );
          }
        }
        return;
      }
      if (message.type === "host-status") {
        currentHostOnline = message.online;
        setHostOnline(message.online);
        if (currentMediaMode === "sfu") {
          if (!currentSfuStream) {
            setStatusText(
              message.online ? "等待分享画面" : "等待分享者开始分享",
            );
          }
          return;
        }
        if (!message.online && !peerRef.current?.isConnected()) {
          setStatusText("等待分享者开始分享");
        } else if (message.online && !peerRef.current?.isConnected()) {
          setStatusText("等待分享画面");
        }
        return;
      }
      if (message.type === "sharing-stopped") {
        currentHostOnline = false;
        if (currentMediaMode === "sfu") {
          subscriberRef.current?.clearMedia();
        } else {
          clearPeerState();
        }
        setHostOnline(false);
        setStatusText("分享已停止，等待分享者再次开始");
        return;
      }
      if (message.type === "room-closed") {
        clearPeerState();
        clearSubscriberState();
        setStatusText(message.reason === "expired" ? "房间已过期" : "分享已结束");
        signal.stop();
        return;
      }
      if (message.type === "error") {
        if (message.code === "PEER_NOT_FOUND" && !currentHostOnline) {
          if (currentMediaMode === "p2p") {
            clearPeerState();
          }
          setStatusText("等待分享者再次开始");
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
          clearPeerState();
          clearSubscriberState();
        }
        setStatusText(message.message);
      }
    }

    signalRef.current = signal;
    signal.start();
    return () => {
      active = false;
      if (signalRef.current === signal) {
        signalRef.current = null;
      }
      signal.stop();
      peerRef.current?.dispose();
      peerRef.current = null;
      subscriberRef.current?.disconnect();
      subscriberRef.current = null;
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
    if (mediaMode === "sfu") {
      if (signalRef.current?.send({ type: "refresh-sfu" })) {
        setSfuRetryAvailable(false);
        setStatusText("正在重新连接 SFU 媒体服务");
      }
      return;
    }
    if (!peerRef.current?.requestRecovery()) {
      setStatusText(hostOnline ? "等待分享画面" : "等待分享者开始分享");
    } else {
      setStatusText("正在恢复媒体连接");
    }
  }

  return (
    <div className="app-shell viewer-shell">
      <AppHeader status={<SignalStatusBadge state={signalStatus} />} />

      <main className="viewer-workspace">
        <div className="viewer-title-row">
          <div>
            <h1>好友屏幕</h1>
            <p className="section-meta">房间 {roomId}</p>
          </div>
          <div className="viewer-badges">
            {forceRelay && mediaMode !== "sfu" && (
              <span className="diagnostic-badge">强制中继</span>
            )}
            {mediaMode === "sfu" ? (
              <PathBadge path="sfu" />
            ) : (
              <>
                <PeerStatusBadge state={peerSnapshot?.connectionState ?? "waiting"} />
                <PathBadge path={peerSnapshot?.metrics.path ?? "unknown"} />
              </>
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
            {(mediaMode !== "sfu" || sfuRetryAvailable) && (
              <button
                type="button"
                className="icon-button"
                title="恢复连接"
                aria-label="恢复连接"
                disabled={mediaMode === "sfu" ? !sfuRetryAvailable : !peerSnapshot}
                onClick={retryConnection}
              >
                <RefreshCw size={19} />
              </button>
            )}
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

        {mediaMode === "p2p" &&
          !relayAvailable &&
          signalStatus === "connected" && (
          <WarningBanner>TURN 未配置，严格网络可能无法连接</WarningBanner>
        )}
        {mediaMode !== "sfu" && peerSnapshot?.error && (
          <div className="notice notice-error" role="status">
            {peerSnapshot.error}
          </div>
        )}
        {mediaMode !== "sfu" && peerSnapshot && (
          <section className="viewer-stats" aria-labelledby="stats-heading">
            <h2 id="stats-heading">连接数据</h2>
            <StatsGrid metrics={peerSnapshot.metrics} direction="receive" />
          </section>
        )}
      </main>
    </div>
  );
}
