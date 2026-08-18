import {
  Check,
  Copy,
  KeyRound,
  MonitorUp,
  Square,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateRoomResponse,
  IceConfig,
  ServerMessage,
} from "../../shared/protocol";
import { AppHeader } from "../components/AppHeader";
import {
  PathBadge,
  PeerStatusBadge,
  SignalStatusBadge,
  WarningBanner,
} from "../components/StatusBadge";
import { StatsGrid } from "../components/StatsGrid";
import { createRoom } from "../lib/api";
import { getStableClientId } from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import {
  captureDisplay,
  QUALITY_PROFILES,
  type QualityProfileId,
} from "../media/quality";
import type {
  PeerSnapshot,
  SignalConnectionState,
} from "../types";
import { HostPeer } from "../webrtc/host-peer";

type HostPhase = "idle" | "starting" | "live" | "ended" | "error";

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

function readableError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "屏幕选择已取消或没有共享权限";
  }
  return error instanceof Error && error.message ? error.message : "启动分享失败";
}

function closeAbandonedRoom(room: CreateRoomResponse): void {
  try {
    const signal = new SignalingClient(
      {
        roomId: room.roomId,
        role: "host",
        token: room.hostToken,
        clientId: getStableClientId("host", room.roomId),
      },
      {
      onMessage: () => undefined,
      onStatus: () => undefined,
      onProtocolError: () => undefined,
      onTerminated: () => undefined,
      },
    );
    signal.start();
    signal.sendThenStop({ type: "close-room" });
  } catch {
    // The room will still expire naturally if the bounded cleanup cannot start.
  }
}

export function HostPage() {
  const forceRelay = useMemo(
    () => new URLSearchParams(window.location.search).get("relay") === "1",
    [],
  );
  const [qualityId, setQualityId] = useState<QualityProfileId>("1080p60");
  const [creationToken, setCreationToken] = useState("");
  const [phase, setPhase] = useState<HostPhase>("idle");
  const [signalStatus, setSignalStatus] =
    useState<SignalConnectionState>("offline");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [details, setDetails] = useState<CaptureDetails | null>(null);
  const [room, setRoom] = useState<CreateRoomResponse | null>(null);
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [peerSnapshots, setPeerSnapshots] = useState<Map<string, PeerSnapshot>>(
    () => new Map(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const peersRef = useRef(new Map<string, HostPeer>());
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);

  const viewers = useMemo(
    () => Array.from(peerSnapshots.values()),
    [peerSnapshots],
  );

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(
    () => () => {
      activeGenerationRef.current = null;
      generationRef.current += 1;
      signalRef.current?.stop();
      peersRef.current.forEach((peer) => peer.dispose());
      peersRef.current.clear();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  function isCurrentGeneration(generation: number): boolean {
    return (
      generationRef.current === generation &&
      activeGenerationRef.current === generation
    );
  }

  function disposeResources(notifyServer: boolean): void {
    const signal = signalRef.current;
    if (signal) {
      if (notifyServer) {
        signal.sendThenStop({ type: "close-room" });
      } else {
        signal.stop();
      }
    }
    signalRef.current = null;
    peersRef.current.forEach((peer) => peer.dispose());
    peersRef.current.clear();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    iceConfigRef.current = null;
    setStream(null);
    setRoom(null);
    setPeerSnapshots(new Map());
    setSignalStatus("offline");
  }

  function endSharing(message: string, notifyServer = true): void {
    const generation = activeGenerationRef.current;
    if (generation === null || generationRef.current !== generation) {
      return;
    }
    activeGenerationRef.current = null;
    generationRef.current += 1;
    disposeResources(notifyServer);
    setNotice(message);
    setPhase("ended");
  }

  function updatePeerSnapshot(snapshot: PeerSnapshot): void {
    setPeerSnapshots((current) => {
      const next = new Map(current);
      next.set(snapshot.peerId, snapshot);
      return next;
    });
  }

  function removePeer(peerId: string): void {
    peersRef.current.get(peerId)?.dispose();
    peersRef.current.delete(peerId);
    setPeerSnapshots((current) => {
      const next = new Map(current);
      next.delete(peerId);
      return next;
    });
  }

  async function startPeer(
    peerId: string,
    generation: number,
    attempt = 0,
  ): Promise<void> {
    if (!isCurrentGeneration(generation)) {
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
      QUALITY_PROFILES[qualityId],
      {
        sendSignal: (targetPeerId, payload) =>
          isCurrentGeneration(generation) && signalRef.current === signal
            ? signal.send({ type: "signal", targetPeerId, payload })
            : false,
        onUpdate: (snapshot) => {
          if (
            isCurrentGeneration(generation) &&
            peersRef.current.get(peerId) === peer
          ) {
            updatePeerSnapshot(snapshot);
          }
        },
      },
      forceRelay,
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
    if (!isCurrentGeneration(generation) || attempt >= 1) {
      return;
    }
    window.setTimeout(() => {
      if (
        isCurrentGeneration(generation) &&
        !peersRef.current.has(peerId)
      ) {
        void startPeer(peerId, generation, attempt + 1).catch(
          (error: unknown) => {
            if (isCurrentGeneration(generation)) {
              setNotice(readableError(error));
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

  function handleSignalMessage(message: ServerMessage, generation: number): void {
    if (!isCurrentGeneration(generation)) {
      return;
    }
    if (message.type === "authenticated" && message.role === "host") {
      const currentViewerIds = new Set(message.viewerPeerIds);
      for (const peerId of peersRef.current.keys()) {
        if (!currentViewerIds.has(peerId)) {
          removePeer(peerId);
        }
      }
      return;
    }
    if (message.type === "peer-joined") {
      void startPeer(message.peerId, generation).catch((error: unknown) => {
        if (isCurrentGeneration(generation)) {
          setNotice(readableError(error));
        }
      });
      return;
    }
    if (message.type === "peer-left") {
      removePeer(message.peerId);
      return;
    }
    if (message.type === "signal") {
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
          setNotice(readableError(error));
        }
      });
      return;
    }
    if (message.type === "ice-config") {
      iceConfigRef.current = message.iceConfig;
      setRelayAvailable(message.iceConfig.relayAvailable);
      peersRef.current.forEach((peer) => peer.updateIceConfig(message.iceConfig));
      return;
    }
    if (message.type === "room-closed") {
      endSharing(
        message.reason === "expired" ? "房间已过期" : "房间已关闭",
        false,
      );
      return;
    }
    if (message.type === "error") {
      if (
        [
          "AUTH_REQUIRED",
          "INVALID_TOKEN",
          "ROOM_CLOSED",
          "ROOM_EXPIRED",
          "HOST_ALREADY_CONNECTED",
        ].includes(message.code)
      ) {
        endSharing(message.message, false);
        return;
      }
      setNotice(message.message);
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
    generationRef.current = generation;
    activeGenerationRef.current = generation;
    setNotice(null);
    setCopied(false);
    setPhase("starting");

    let captured: MediaStream;
    try {
      // This must remain the first awaited operation in the button gesture.
      captured = await captureDisplay(QUALITY_PROFILES[qualityId]);
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        return;
      }
      activeGenerationRef.current = null;
      setNotice(readableError(error));
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
    captured.getVideoTracks()[0]?.addEventListener(
      "ended",
      () => {
        if (isCurrentGeneration(generation)) {
          endSharing("屏幕分享已结束");
        }
      },
      { once: true },
    );

    let createdRoom: CreateRoomResponse | null = null;
    try {
      createdRoom = await createRoom(creationToken);
      if (!isCurrentGeneration(generation)) {
        captured.getTracks().forEach((track) => track.stop());
        closeAbandonedRoom(createdRoom);
        return;
      }
      iceConfigRef.current = createdRoom.iceConfig;
      setRelayAvailable(createdRoom.iceConfig.relayAvailable);

      const signal = new SignalingClient(
        {
          roomId: createdRoom.roomId,
          role: "host",
          token: createdRoom.hostToken,
          clientId: getStableClientId("host", createdRoom.roomId),
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
          onProtocolError: (message) => {
            if (
              isCurrentGeneration(generation) &&
              signalRef.current === signal
            ) {
              setNotice(message);
            }
          },
          onTerminated: (message) => {
            if (
              isCurrentGeneration(generation) &&
              signalRef.current === signal
            ) {
              endSharing(message, false);
            }
          },
          onMessage: (message) => {
            if (
              !isCurrentGeneration(generation) ||
              signalRef.current !== signal
            ) {
              return;
            }
            if (message.type === "authenticated") {
              iceConfigRef.current = message.iceConfig;
              setRelayAvailable(message.iceConfig.relayAvailable);
              setCreationToken("");
              setRoom(createdRoom);
              setPhase("live");
            }
            handleSignalMessage(message, generation);
          },
        },
      );
      signalRef.current = signal;
      signal.start();
    } catch (error) {
      captured.getTracks().forEach((track) => track.stop());
      if (!isCurrentGeneration(generation)) {
        if (createdRoom) {
          closeAbandonedRoom(createdRoom);
        }
        return;
      }
      activeGenerationRef.current = null;
      if (createdRoom) {
        closeAbandonedRoom(createdRoom);
      }
      if (streamRef.current === captured) {
        streamRef.current = null;
        setStream(null);
      }
      setNotice(readableError(error));
      setPhase("error");
    }
  }

  async function copyInvite(): Promise<void> {
    if (!room) {
      return;
    }
    const generation = activeGenerationRef.current;
    if (generation === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(room.inviteUrl);
      if (!isCurrentGeneration(generation)) {
        return;
      }
      setCopied(true);
      window.setTimeout(() => {
        if (isCurrentGeneration(generation)) {
          setCopied(false);
        }
      }, 1_500);
    } catch {
      if (isCurrentGeneration(generation)) {
        setNotice("无法写入剪贴板，请手动复制邀请链接");
      }
    }
  }

  const expiresAt = room
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(room.expiresAt))
    : null;

  return (
    <div className="app-shell">
      <AppHeader status={<SignalStatusBadge state={signalStatus} />} />

      <main className="host-workspace">
        <section className="broadcast-area" aria-labelledby="broadcast-heading">
          <div className="section-heading">
            <div>
              <h1 id="broadcast-heading">屏幕分享</h1>
              <p className="section-meta">
                {phase === "live"
                  ? `${viewers.length}/3 人正在观看`
                  : phase === "starting"
                    ? "正在建立房间"
                    : "尚未开始"}
              </p>
            </div>
            {forceRelay && <span className="diagnostic-badge">强制中继</span>}
            {(phase === "live" || phase === "starting") && (
              <button
                className="button button-danger"
                type="button"
                onClick={() =>
                  endSharing(
                    phase === "starting" ? "启动已取消" : "屏幕分享已结束",
                  )
                }
              >
                <Square size={16} fill="currentColor" aria-hidden="true" />
                {phase === "starting" ? "取消" : "停止分享"}
              </button>
            )}
          </div>

          <div className="video-stage local-stage">
            {stream ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : (
              <div className="stage-placeholder">
                <MonitorUp size={36} strokeWidth={1.5} aria-hidden="true" />
                <span>{phase === "ended" ? "分享已结束" : "未分享画面"}</span>
              </div>
            )}
            {phase === "starting" && (
              <div className="stage-overlay" role="status">
                正在连接
              </div>
            )}
          </div>

          {details && stream && (
            <div className="capture-strip" aria-label="实际捕获参数">
              <span>{details.resolution}</span>
              <span>{details.frameRate ? `${details.frameRate.toFixed(0)} fps` : "帧率未知"}</span>
              <span>{details.hasAudio ? "含音频" : "无音频"}</span>
            </div>
          )}

          {!details?.hasAudio && stream && (
            <WarningBanner>当前来源没有可共享音频</WarningBanner>
          )}
          {room && !relayAvailable && (
            <WarningBanner>TURN 未配置，严格网络可能无法连接</WarningBanner>
          )}
          {notice && (
            <div className="notice" role="status" aria-live="polite">
              {notice}
            </div>
          )}

          {phase !== "live" ? (
            <div className="setup-controls">
              <fieldset className="control-group">
                <legend>画质</legend>
                <div className="segmented-control">
                  {(Object.keys(QUALITY_PROFILES) as QualityProfileId[]).map(
                    (id) => (
                      <button
                        key={id}
                        type="button"
                        className={qualityId === id ? "is-selected" : undefined}
                        aria-pressed={qualityId === id}
                        disabled={phase === "starting"}
                        onClick={() => setQualityId(id)}
                      >
                        {QUALITY_PROFILES[id].label}
                      </button>
                    ),
                  )}
                </div>
              </fieldset>

              <label className="token-field">
                <span>建房密钥（可选）</span>
                <span className="input-with-icon">
                  <KeyRound size={16} aria-hidden="true" />
                  <input
                    type="password"
                    value={creationToken}
                    disabled={phase === "starting"}
                    autoComplete="off"
                    onChange={(event) => setCreationToken(event.target.value)}
                  />
                </span>
              </label>

              <button
                className="button button-primary start-button"
                type="button"
                disabled={phase === "starting"}
                onClick={() => void startSharing()}
              >
                <MonitorUp size={18} aria-hidden="true" />
                {phase === "starting" ? "正在启动" : "开始分享"}
              </button>
            </div>
          ) : (
            room && (
              <div className="invite-bar">
                <div className="invite-copy">
                  <span className="field-label">邀请链接 · {expiresAt} 过期</span>
                  <span className="invite-url" title={room.inviteUrl}>
                    {room.inviteUrl}
                  </span>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  title="复制邀请链接"
                  aria-label="复制邀请链接"
                  onClick={() => void copyInvite()}
                >
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                </button>
              </div>
            )
          )}
        </section>

        <aside className="viewer-panel" aria-labelledby="viewer-heading">
          <div className="viewer-panel-heading">
            <div>
              <h2 id="viewer-heading">观看者</h2>
              <span>{viewers.length}/3</span>
            </div>
            <Users size={18} aria-hidden="true" />
          </div>

          <div className="viewer-list">
            {viewers.map((viewer, index) => (
              <article className="viewer-item" key={viewer.peerId}>
                <div className="viewer-item-heading">
                  <div>
                    <h3>朋友 {index + 1}</h3>
                    <PeerStatusBadge state={viewer.connectionState} />
                  </div>
                  <PathBadge path={viewer.metrics.path} />
                </div>
                <StatsGrid metrics={viewer.metrics} direction="send" />
                {viewer.error && <p className="inline-error">{viewer.error}</p>}
              </article>
            ))}
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
