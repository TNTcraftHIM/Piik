import type { IceConfig, SignalPayload } from "../../shared/protocol";
import {
  EMPTY_METRICS,
  type PeerSnapshot,
} from "../types";
import {
  collectConnectionMetrics,
  createStatsAccumulator,
  type StatsAccumulator,
} from "./stats";

const MAX_PENDING_CANDIDATES = 64;
type SignalCandidate = Extract<
  SignalPayload,
  { kind: "candidate" }
>["candidate"];

interface ViewerPeerEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  sendRestartRequest: (
    peerId: string,
    connectionId: string,
    rebuild: boolean,
  ) => boolean;
  onStream: (stream: MediaStream) => void;
  onUpdate: (snapshot: PeerSnapshot) => void;
}

export class ViewerPeer {
  private connection: RTCPeerConnection | null = null;
  private connectionId: string | null = null;
  private parentPeerId: string | null = null;
  private remoteStream = new MediaStream();
  private pendingByConnection = new Map<
    string,
    SignalCandidate[]
  >();
  private statsAccumulator: StatsAccumulator = createStatsAccumulator();
  private statsTimer: number | null = null;
  private disconnectTimer: number | null = null;
  private restartRequested = false;
  private offerRecoveryAttempts = 0;
  private disposed = false;
  private currentIceConfig: IceConfig;
  private snapshot: PeerSnapshot | null = null;

  constructor(
    iceConfig: IceConfig,
    private readonly events: ViewerPeerEvents,
    private readonly forceRelay = false,
  ) {
    this.currentIceConfig = iceConfig;
  }

  async acceptSignal(
    parentPeerId: string,
    payload: SignalPayload,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    let operationConnection: RTCPeerConnection | null = null;
    let operationConnectionId: string | null = null;

    try {
      if (payload.kind === "description") {
        if (payload.description.type !== "offer") {
          return;
        }
        if (
          !this.connection ||
          this.connectionId !== payload.connectionId ||
          this.parentPeerId !== parentPeerId
        ) {
          this.replaceConnection(parentPeerId, payload.connectionId);
        }
        const connection = this.connection;
        if (!connection) {
          return;
        }
        const connectionId = payload.connectionId;
        operationConnection = connection;
        operationConnectionId = connectionId;
        await connection.setRemoteDescription(payload.description);
        if (!this.isCurrentConnection(connection, connectionId)) {
          return;
        }
        await this.flushCandidates(connection, connectionId);
        if (!this.isCurrentConnection(connection, connectionId)) {
          return;
        }
        const answer = await connection.createAnswer();
        if (!this.isCurrentConnection(connection, connectionId)) {
          return;
        }
        await connection.setLocalDescription(answer);
        if (!this.isCurrentConnection(connection, connectionId)) {
          return;
        }
        if (!connection.localDescription) {
          throw new Error("Local description was not created");
        }
        this.events.sendSignal(parentPeerId, {
          kind: "description",
          connectionId,
          description: {
            type: "answer",
            sdp: connection.localDescription.sdp,
          },
        });
        this.restartRequested = false;
        this.offerRecoveryAttempts = 0;
      } else if (
        this.connection &&
        this.parentPeerId === parentPeerId &&
        this.connectionId === payload.connectionId &&
        this.connection.remoteDescription
      ) {
        const connection = this.connection;
        const connectionId = payload.connectionId;
        operationConnection = connection;
        operationConnectionId = connectionId;
        await connection.addIceCandidate(payload.candidate);
        if (!this.isCurrentConnection(connection, connectionId)) {
          return;
        }
      } else {
        this.queueCandidate(payload.connectionId, payload.candidate);
      }
    } catch (error) {
      if (
        !operationConnection ||
        operationConnectionId === null ||
        !this.isCurrentConnection(operationConnection, operationConnectionId)
      ) {
        return;
      }
      this.setError(error, "处理分享端信令失败");
      if (
        payload.kind === "description" &&
        this.offerRecoveryAttempts < 1 &&
        this.events.sendRestartRequest(
          parentPeerId,
          operationConnectionId,
          true,
        )
      ) {
        this.offerRecoveryAttempts += 1;
        this.restartRequested = true;
      }
    }
  }

  updateIceConfig(iceConfig: IceConfig): void {
    this.currentIceConfig = iceConfig;
    if (!this.connection) {
      return;
    }
    try {
      this.connection.setConfiguration({
        iceServers: iceConfig.iceServers,
        iceTransportPolicy: this.forceRelay ? "relay" : "all",
      });
    } catch (error) {
      this.setError(error, "更新 TURN 配置失败");
    }
  }

  requestRecovery(): boolean {
    if (!this.connectionId || !this.parentPeerId) {
      return false;
    }
    const sent = this.events.sendRestartRequest(
      this.parentPeerId,
      this.connectionId,
      false,
    );
    if (sent) {
      this.restartRequested = true;
    }
    return sent;
  }

  hasConnection(): boolean {
    return this.connection !== null;
  }

  hasConnectionId(connectionId: string): boolean {
    return this.connection !== null && this.connectionId === connectionId;
  }

  isConnected(): boolean {
    return this.connection?.connectionState === "connected";
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeConnection();
    this.pendingByConnection.clear();
  }

  private replaceConnection(parentPeerId: string, connectionId: string): void {
    const parentChanged =
      this.parentPeerId !== null && this.parentPeerId !== parentPeerId;
    this.disposeConnection();
    if (parentChanged) {
      this.offerRecoveryAttempts = 0;
    }
    this.parentPeerId = parentPeerId;
    this.connectionId = connectionId;
    this.remoteStream = new MediaStream();
    this.statsAccumulator = createStatsAccumulator();
    this.restartRequested = false;

    const connection = new RTCPeerConnection({
      iceServers: this.currentIceConfig.iceServers,
      iceTransportPolicy: this.forceRelay ? "relay" : "all",
    });
    this.connection = connection;
    this.snapshot = {
      peerId: parentPeerId,
      connectionId,
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      metrics: { ...EMPTY_METRICS },
      error: null,
    };

    connection.addEventListener("icecandidate", (event) => {
      if (!this.parentPeerId || this.connection !== connection) {
        return;
      }
      this.events.sendSignal(parentPeerId, {
        kind: "candidate",
        connectionId,
        candidate: event.candidate
          ? {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            }
          : null,
      });
    });
    connection.addEventListener("track", (event) => {
      if (this.connection !== connection) {
        return;
      }
      const sourceStream = event.streams[0];
      if (sourceStream) {
        this.remoteStream = sourceStream;
      } else if (!this.remoteStream.getTrackById(event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      this.events.onStream(this.remoteStream);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (this.connection !== connection) {
        return;
      }
      this.handleConnectionState(connection.connectionState);
      this.emit();
    });
    connection.addEventListener("iceconnectionstatechange", () => {
      if (this.connection === connection) {
        this.emit();
      }
    });

    this.statsTimer = window.setInterval(() => {
      void this.updateStats(connection, connectionId);
    }, 2_000);
    this.emit();
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    if (state === "connected") {
      this.restartRequested = false;
      this.clearDisconnectTimer();
      return;
    }
    if (state === "failed") {
      this.clearDisconnectTimer();
      if (!this.restartRequested) {
        this.requestRecovery();
      }
      return;
    }
    if (state === "disconnected" && this.disconnectTimer === null) {
      this.disconnectTimer = window.setTimeout(() => {
        this.disconnectTimer = null;
        if (this.connection?.connectionState === "disconnected") {
          this.requestRecovery();
        }
      }, 3_000);
    }
  }

  private queueCandidate(
    connectionId: string,
    candidate: SignalCandidate,
  ): void {
    let queue = this.pendingByConnection.get(connectionId);
    if (!queue) {
      if (this.pendingByConnection.size >= 2) {
        const oldestKey = this.pendingByConnection.keys().next().value as
          | string
          | undefined;
        if (oldestKey) {
          this.pendingByConnection.delete(oldestKey);
        }
      }
      queue = [];
      this.pendingByConnection.set(connectionId, queue);
    }
    if (queue.length < MAX_PENDING_CANDIDATES) {
      queue.push(candidate);
    }
  }

  private async flushCandidates(
    connection: RTCPeerConnection,
    connectionId: string,
  ): Promise<void> {
    if (!this.isCurrentConnection(connection, connectionId)) {
      return;
    }
    const candidates = this.pendingByConnection.get(connectionId) ?? [];
    this.pendingByConnection.delete(connectionId);
    for (const candidate of candidates) {
      await connection.addIceCandidate(candidate);
      if (!this.isCurrentConnection(connection, connectionId)) {
        return;
      }
    }
  }

  private async updateStats(
    connection: RTCPeerConnection,
    connectionId: string,
  ): Promise<void> {
    if (!this.isCurrentConnection(connection, connectionId)) {
      return;
    }
    const statsAccumulator = this.statsAccumulator;
    try {
      const metrics = await collectConnectionMetrics(
        connection,
        "receive",
        statsAccumulator,
      );
      if (!this.isCurrentConnection(connection, connectionId)) {
        return;
      }
      if (this.snapshot) {
        this.snapshot = { ...this.snapshot, metrics };
        this.emit();
      }
    } catch {
      // Stats are observational and must never disrupt a healthy media path.
    }
  }

  private isCurrentConnection(
    connection: RTCPeerConnection,
    connectionId: string,
  ): boolean {
    return (
      !this.disposed &&
      this.connection === connection &&
      this.connectionId === connectionId
    );
  }

  private setError(error: unknown, fallback: string): void {
    if (!this.snapshot) {
      return;
    }
    const message = error instanceof Error ? error.message : fallback;
    this.snapshot = { ...this.snapshot, error: message || fallback };
    this.emit();
  }

  private emit(): void {
    if (this.disposed || !this.connection || !this.snapshot) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
    };
    this.events.onUpdate({
      ...this.snapshot,
      metrics: { ...this.snapshot.metrics },
    });
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) {
      window.clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private disposeConnection(): void {
    this.clearDisconnectTimer();
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.connection?.close();
    this.connection = null;
    this.connectionId = null;
    this.parentPeerId = null;
    this.snapshot = null;
  }
}
