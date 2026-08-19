import {
  Check,
  Copy,
  Hash,
  MonitorUp,
  Pause,
  Play,
  RefreshCw,
  Square,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_QUALITY_PROFILE_ID,
  type CreateRoomResponse,
  type IceConfig,
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
import { ApiError, createRoom } from "../lib/api";
import { createOpaqueId } from "../lib/opaque-id";
import {
  clearHostRoom,
  getStableClientId,
  isHostRoomExpired,
  readHostRoom,
  writeHostRoom,
} from "../lib/session";
import { SignalingClient } from "../lib/signaling";
import {
  applyCaptureProfile,
  captureDisplay,
  QUALITY_PROFILES,
  setVideoPaused,
  type QualityProfileId,
} from "../media/quality";
import { HostSfuRoute } from "../media/host-sfu-route";
import type {
  PeerSnapshot,
  SignalConnectionState,
} from "../types";
import { HostPeer } from "../webrtc/host-peer";
import {
  limitMediaAssignment,
  MAX_HOST_MEDIA_CHILDREN,
} from "../webrtc/media-assignment";

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
        shareGeneration: createOpaqueId(),
      },
      {
        onMessage: () => undefined,
        onStatus: () => undefined,
        onProtocolError: () => undefined,
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

interface HostPageProps {
  onAuthorizationRequired?: () => void;
}

export function HostPage({ onAuthorizationRequired }: HostPageProps = {}) {
  const forceRelay = useMemo(
    () => new URLSearchParams(window.location.search).get("relay") === "1",
    [],
  );
  const [qualityId, setQualityId] = useState<QualityProfileId>(
    DEFAULT_QUALITY_PROFILE_ID,
  );
  const shareGenerationRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<HostPhase>("idle");
  const [signalStatus, setSignalStatus] =
    useState<SignalConnectionState>("offline");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [details, setDetails] = useState<CaptureDetails | null>(null);
  const [room, setRoom] = useState<CreateRoomResponse | null>(readHostRoom);
  const [relayAvailable, setRelayAvailable] = useState(false);
  const [maxViewers, setMaxViewers] = useState<number | null>(null);
  const [peerSnapshots, setPeerSnapshots] = useState<Map<string, PeerSnapshot>>(
    () => new Map(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [changingQuality, setChangingQuality] = useState(false);
  const [picturePaused, setPicturePaused] = useState(false);
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const signalRef = useRef<SignalingClient | null>(null);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const peersRef = useRef(new Map<string, HostPeer>());
  const peerAssistedRef = useRef(false);
  const generationRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);
  const sourceSwitchRef = useRef<object | null>(null);
  const qualityChangeRef = useRef<object | null>(null);
  const qualityIdRef = useRef<QualityProfileId>(DEFAULT_QUALITY_PROFILE_ID);
  const picturePausedRef = useRef(false);
  const retiringStreamRef = useRef<MediaStream | null>(null);
  const hostSfuRouteRef = useRef<HostSfuRoute | null>(null);

  const viewers = useMemo(
    () => Array.from(peerSnapshots.values()),
    [peerSnapshots],
  );
  const qualityLimitation = useMemo(
    () => qualityLimitationSummary(viewers),
    [viewers],
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
      sourceSwitchRef.current = null;
      qualityChangeRef.current = null;
      signalRef.current?.stop();
      peersRef.current.forEach((peer) => peer.dispose());
      peersRef.current.clear();
      void hostSfuRouteRef.current?.disconnect();
      hostSfuRouteRef.current = null;
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

  function ensureHostSfuRoute(generation: number): HostSfuRoute {
    const existing = hostSfuRouteRef.current;
    if (existing) {
      return existing;
    }
    let route: HostSfuRoute;
    route = new HostSfuRoute({
      getStream: () => streamRef.current,
      getProfile: () => QUALITY_PROFILES[qualityIdRef.current],
      reconcileChildren: (childPeerIds) => {
        if (
          isCurrentGeneration(generation) &&
          hostSfuRouteRef.current === route
        ) {
          reconcilePeerAssistedChildren(childPeerIds, generation);
        }
      },
      send: (message) =>
        isCurrentGeneration(generation) && hostSfuRouteRef.current === route
          ? signalRef.current?.send(message) === true
          : false,
    });
    hostSfuRouteRef.current = route;
    return route;
  }

  function clearHostSfuRoute(): void {
    const route = hostSfuRouteRef.current;
    hostSfuRouteRef.current = null;
    void route?.disconnect();
  }

  function disposeResources(notifyServer: boolean): void {
    sourceSwitchRef.current = null;
    qualityChangeRef.current = null;
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
    void hostSfuRouteRef.current?.disconnect();
    hostSfuRouteRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    retiringStreamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    retiringStreamRef.current = null;
    iceConfigRef.current = null;
    peerAssistedRef.current = false;
    setStream(null);
    setDetails(null);
    setRelayAvailable(false);
    setMaxViewers(null);
    setPeerSnapshots(new Map());
    setSignalStatus("offline");
    setSwitchingSource(false);
    setChangingQuality(false);
    picturePausedRef.current = false;
    setPicturePaused(false);
  }

  function forgetRoom(): void {
    clearHostRoom();
    setRoom(null);
    setCopied(false);
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
          endSharing("已停止分享");
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

  function commitQuality(id: QualityProfileId): void {
    qualityIdRef.current = id;
    setQualityId(id);
  }

  async function changeQuality(nextId: QualityProfileId): Promise<void> {
    if (phase !== "live") {
      commitQuality(nextId);
      return;
    }

    const generation = activeGenerationRef.current;
    const activeStream = streamRef.current;
    if (
      generation === null ||
      !activeStream ||
      !isCurrentGeneration(generation) ||
      sourceSwitchRef.current ||
      qualityChangeRef.current
    ) {
      return;
    }

    const token = {};
    qualityChangeRef.current = token;
    setChangingQuality(true);
    setNotice(null);
    const profile = QUALITY_PROFILES[nextId];

    try {
      await applyCaptureProfile(activeStream, profile);
      if (
        !isCurrentGeneration(generation) ||
        qualityChangeRef.current !== token ||
        streamRef.current !== activeStream
      ) {
        return;
      }

      commitQuality(nextId);
      setDetails(captureDetails(activeStream));
      if (peerAssistedRef.current) {
        signalRef.current?.send({
          type: "set-quality-profile",
          qualityProfileId: nextId,
        });
      }
      const [results, sfuUpdated] = await Promise.all([
        Promise.all(
          [...peersRef.current.values()].map((peer) => peer.updateProfile(profile)),
        ),
        hostSfuRouteRef.current?.updateProfile(profile) ?? Promise.resolve(true),
      ]);
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token
      ) {
        const failed = results.filter((updated) => !updated).length;
        setNotice(
          failed > 0 || !sfuUpdated
            ? "画质已切换，但部分观看连接未能应用新参数"
            : `画质已切换为 ${profile.label}`,
        );
      }
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        qualityChangeRef.current === token
      ) {
        setNotice(readableError(error));
      }
    } finally {
      if (qualityChangeRef.current === token) {
        qualityChangeRef.current = null;
        setChangingQuality(false);
      }
    }
  }

  function togglePicturePause(): void {
    const activeStream = streamRef.current;
    if (phase !== "live" || !activeStream) {
      return;
    }
    const nextPaused = !picturePausedRef.current;
    if (!setVideoPaused(activeStream, nextPaused)) {
      setNotice("当前分享没有可暂停的视频轨道");
      return;
    }
    picturePausedRef.current = nextPaused;
    setPicturePaused(nextPaused);
    setNotice(nextPaused ? "画面已暂停，音频不受影响" : "画面已恢复");
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
      QUALITY_PROFILES[qualityIdRef.current],
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

  function reconcilePeerAssistedChildren(
    childPeerIds: string[],
    generation: number,
  ): void {
    const assignment = limitMediaAssignment(
      { parentPeerId: null, childPeerIds },
      MAX_HOST_MEDIA_CHILDREN,
    );
    const assignedChildren = new Set(assignment.childPeerIds);
    for (const peerId of peersRef.current.keys()) {
      if (!assignedChildren.has(peerId)) {
        removePeer(peerId);
      }
    }
    for (const peerId of assignedChildren) {
      void startPeer(peerId, generation).catch((error: unknown) => {
        if (isCurrentGeneration(generation)) {
          setNotice(readableError(error));
        }
      });
    }
  }

  function handleSignalMessage(message: ServerMessage, generation: number): void {
    if (!isCurrentGeneration(generation)) {
      return;
    }
    if (message.type === "authenticated" && message.role === "host") {
      setMaxViewers(message.maxViewers);
      if (
        "mediaMode" in message &&
        message.mediaMode === "peer-assisted"
      ) {
        peerAssistedRef.current = true;
        signalRef.current?.send({
          type: "set-quality-profile",
          qualityProfileId: qualityIdRef.current,
        });
        void ensureHostSfuRoute(generation).resyncAuthoritative(
          {
            revision: message.routeRevision,
            phase: "active",
            assignment: message.routeAssignment,
          },
        );
        return;
      }
      peerAssistedRef.current = false;
      clearHostSfuRoute();
      const currentViewerIds = new Set(message.viewerPeerIds);
      for (const peerId of peersRef.current.keys()) {
        if (!currentViewerIds.has(peerId)) {
          removePeer(peerId);
        }
      }
      return;
    }
    if (message.type === "route-update") {
      if (peerAssistedRef.current) {
        ensureHostSfuRoute(generation).accept(message);
      }
      return;
    }
    if (message.type === "sfu-config") {
      if (peerAssistedRef.current) {
        void ensureHostSfuRoute(generation).acceptConfig(message);
      }
      return;
    }
    if (message.type === "media-assignment") {
      if (peerAssistedRef.current && !hostSfuRouteRef.current) {
        reconcilePeerAssistedChildren(
          message.mediaAssignment.childPeerIds,
          generation,
        );
      }
      return;
    }
    if (message.type === "peer-joined") {
      if (peerAssistedRef.current) {
        return;
      }
      void startPeer(message.peerId, generation).catch((error: unknown) => {
        if (isCurrentGeneration(generation)) {
          setNotice(readableError(error));
        }
      });
      return;
    }
    if (message.type === "peer-left") {
      if (peerAssistedRef.current) {
        return;
      }
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
      forgetRoom();
      endSharing(
        message.reason === "expired" ? "房间已过期" : "房间已关闭",
        false,
      );
      return;
    }
    if (message.type === "error") {
      if (["INVALID_TOKEN", "ROOM_EXPIRED"].includes(message.code)) {
        forgetRoom();
        endSharing("房间已失效，再次点击将创建新房", false);
        return;
      }
      if (
        [
          "AUTH_REQUIRED",
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
      captured = await captureDisplay(QUALITY_PROFILES[qualityIdRef.current]);
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        return;
      }
      activeGenerationRef.current = null;
      shareGenerationRef.current = null;
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
    watchCaptureEnd(captured, generation);

    let createdRoom: CreateRoomResponse | null = null;
    let claimedRoom = false;
    try {
      let reusableRoom = room;
      if (reusableRoom && isHostRoomExpired(reusableRoom)) {
        forgetRoom();
        reusableRoom = null;
      }
      createdRoom = reusableRoom ?? readHostRoom();
      if (!createdRoom) {
        createdRoom = await createRoom();
        if (!isCurrentGeneration(generation)) {
          captured.getTracks().forEach((track) => track.stop());
          closeAbandonedRoom(createdRoom);
          return;
        }
        writeHostRoom(createdRoom);
        setRoom(createdRoom);
        claimedRoom = true;
      } else {
        setRoom(createdRoom);
        claimedRoom = true;
      }
      const activeRoom = createdRoom;
      const signal = new SignalingClient(
        {
          roomId: activeRoom.roomId,
          role: "host",
          token: activeRoom.hostToken,
          clientId: getStableClientId("host", activeRoom.roomId),
          shareGeneration,
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
          onAccessRequired: () => {
            if (
              isCurrentGeneration(generation) &&
              signalRef.current === signal
            ) {
              endSharing("验证已失效，请重新登录", false);
              onAuthorizationRequired?.();
            }
          },
          onMessage: (message) => {
            if (
              !isCurrentGeneration(generation) ||
              signalRef.current !== signal
            ) {
              return;
            }
            if (message.type === "authenticated" && message.role === "host") {
              const authenticatedRoom = {
                ...activeRoom,
                expiresAt: message.roomExpiresAt,
              };
              iceConfigRef.current = message.iceConfig;
              setRelayAvailable(message.iceConfig.relayAvailable);
              writeHostRoom(authenticatedRoom);
              setRoom(authenticatedRoom);
              setPhase("live");
            }
            handleSignalMessage(message, generation);
          },
        },
      );
      signalRef.current = signal;
      signal.start();
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
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
      setNotice(readableError(error));
      setPhase("error");
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
      captured = await captureDisplay(QUALITY_PROFILES[qualityIdRef.current]);
    } catch (error) {
      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        setNotice(readableError(error));
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
      setNotice("当前分享已经结束");
      finishSourceSwitch(token);
      return;
    }

    retiringStreamRef.current = previousStream;
    setVideoPaused(captured, picturePausedRef.current);
    streamRef.current = captured;
    setStream(captured);
    setDetails(captureDetails(captured));
    watchCaptureEnd(captured, generation);

    try {
      const activeSfuRoute = hostSfuRouteRef.current;
      const [replacements, sfuReplaced] = await Promise.all([
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
      if (
        !sfuReplaced &&
        activeSfuRoute &&
        hostSfuRouteRef.current === activeSfuRoute
      ) {
        await activeSfuRoute.failActivePublisher();
      }

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
              setNotice(readableError(error));
            }
          }
        }),
      );

      if (
        isCurrentGeneration(generation) &&
        sourceSwitchRef.current === token
      ) {
        setNotice(
          failedPeerIds.length > 0
            ? "分享来源已切换，部分观看者正在重新连接"
            : "分享来源已切换",
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
      setNotice("无法写入剪贴板，请手动复制邀请链接");
    }
  }

  const expirationText = room
    ? room.expiresAt
      ? `${new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(room.expiresAt))} 过期`
      : "长期有效"
    : null;

  return (
    <div className="app-shell">
      <AppHeader
        status={
          showConnectionDetails ? (
            <SignalStatusBadge state={signalStatus} />
          ) : null
        }
      />

      <main className="host-workspace">
        <section className="broadcast-area" aria-labelledby="broadcast-heading">
          <div className="section-heading">
            <div>
              <h1 id="broadcast-heading">屏幕分享</h1>
              <p className="section-meta">
                {phase === "live"
                  ? `${viewers.length}/${maxViewers ?? "-"} 人正在观看`
                  : phase === "starting"
                    ? "正在连接"
                    : phase === "ended" && room
                      ? "已停止分享"
                      : room
                        ? "房间已就绪"
                        : "尚未开始"}
              </p>
            </div>
            {showConnectionDetails && forceRelay && (
              <span className="diagnostic-badge">强制中继</span>
            )}
            {(phase === "live" || phase === "starting") && (
              <div className="broadcast-actions">
                {phase === "live" && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={switchingSource || changingQuality}
                    onClick={togglePicturePause}
                  >
                    {picturePaused ? (
                      <Play size={16} fill="currentColor" aria-hidden="true" />
                    ) : (
                      <Pause size={16} fill="currentColor" aria-hidden="true" />
                    )}
                    {picturePaused ? "恢复画面" : "暂停画面"}
                  </button>
                )}
                {phase === "live" && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={switchingSource || changingQuality}
                    onClick={() => void switchSource()}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    {switchingSource ? "正在选择" : "切换来源"}
                  </button>
                )}
                <button
                  className="button button-danger"
                  type="button"
                  onClick={() =>
                    endSharing(
                      phase === "starting"
                        ? "启动已取消"
                        : "已停止分享",
                    )
                  }
                >
                  <Square size={16} fill="currentColor" aria-hidden="true" />
                  {phase === "starting" ? "取消" : "停止分享"}
                </button>
              </div>
            )}
          </div>

          <div
            className="video-stage local-stage"
            role="group"
            aria-label="分享或加入房间"
          >
            {stream ? (
              <video ref={videoRef} autoPlay muted playsInline />
            ) : phase === "idle" ||
              phase === "ended" ||
              phase === "error" ? (
              <div className="stage-placeholder stage-entry">
                {phase === "ended" && room && (
                  <span className="stage-status">已停止分享</span>
                )}
                <div className="entry-actions">
                  <button
                    className="entry-action"
                    type="button"
                    title="开始分享屏幕"
                    onClick={() => void startSharing()}
                  >
                    <MonitorUp size={18} aria-hidden="true" />
                    开始分享
                  </button>
                  <span className="entry-divider" aria-hidden="true">
                    或
                  </span>
                  <a
                    className="entry-action"
                    href="/join"
                    title="输入房间码加入观看"
                  >
                    <Hash size={18} aria-hidden="true" />
                    加入房间
                  </a>
                </div>
              </div>
            ) : (
              <div className="stage-placeholder">
                <MonitorUp size={36} strokeWidth={1.5} aria-hidden="true" />
              </div>
            )}
            {(phase === "starting" || switchingSource || picturePaused) && (
              <div className="stage-overlay" role="status">
                {switchingSource
                  ? "正在切换来源"
                  : picturePaused
                    ? "画面已暂停"
                    : "正在连接"}
              </div>
            )}
          </div>

          {showConnectionDetails && details && stream && (
            <div className="capture-strip" aria-label="实际捕获参数">
              <span>{details.resolution}</span>
              <span>{details.frameRate ? `${details.frameRate.toFixed(0)} fps` : "帧率未知"}</span>
              <span>{details.hasAudio ? "含音频" : "无音频"}</span>
            </div>
          )}

          {!details?.hasAudio && stream && (
            <WarningBanner>当前来源没有可共享音频</WarningBanner>
          )}
          {showConnectionDetails &&
            room &&
            signalStatus === "connected" &&
            !relayAvailable && (
            <WarningBanner>TURN 未配置，严格网络可能无法连接</WarningBanner>
          )}
          {qualityLimitation && (
            <WarningBanner>{qualityLimitation}</WarningBanner>
          )}
          {notice && (
            <div className="notice" role="status" aria-live="polite">
              {notice}
            </div>
          )}

          <ConnectionDetailsToggle
            checked={showConnectionDetails}
            onChange={setShowConnectionDetails}
          />

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
                      disabled={
                        phase === "starting" ||
                        switchingSource ||
                        changingQuality
                      }
                      onClick={() => void changeQuality(id)}
                    >
                      {QUALITY_PROFILES[id].label}
                    </button>
                  ),
                )}
              </div>
            </fieldset>
          </div>
          {room && (
            <div className="invite-bar">
              <div className="invite-copy">
                <span className="field-label">
                  房间 {room.roomId} · {expirationText}
                </span>
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
          )}
        </section>

        <aside className="viewer-panel" aria-labelledby="viewer-heading">
          <div className="viewer-panel-heading">
            <div>
              <h2 id="viewer-heading">观看者</h2>
              <span>{viewers.length}/{maxViewers ?? "-"}</span>
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
                  {showConnectionDetails && (
                    <PathBadge path={viewer.metrics.path} />
                  )}
                </div>
                {showConnectionDetails && (
                  <StatsGrid metrics={viewer.metrics} direction="send" />
                )}
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
