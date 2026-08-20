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
const MAX_AUTOMATIC_RECOVERY_REQUESTS = 2;
const INITIAL_CONNECTION_TIMEOUT_MS = 15_000;
const AUTOMATIC_RECOVERY_TIMEOUT_MS = 3_000;
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
  onRecoveryExhausted?: (
    parentPeerId: string,
    connectionId: string,
  ) => boolean;
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
  private statsInFlightConnection: RTCPeerConnection | null = null;
  private disconnectTimer: number | null = null;
  private initialConnectionTimer: number | null = null;
  private recoveryTimer: number | null = null;
  private offerRecoveryAttempts = 0;
  private automaticRecoveryRequests = 0;
  private recoveryExhaustedReported = false;
  private disposed = false;
  private currentIceConfig: IceConfig;
  private snapshot: PeerSnapshot | null = null;

  constructor(
    iceConfig: IceConfig,
    private readonly events: ViewerPeerEvents,
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
        if (!this.events.sendSignal(parentPeerId, {
          kind: "description",
          connectionId,
          description: {
            type: "answer",
            sdp: connection.localDescription.sdp,
          },
        })) {
          throw new Error("Signaling is unavailable while sending the answer");
        }
        this.offerRecoveryAttempts = 0;
        this.scheduleInitialConnectionDeadline(connection, connectionId);
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
        this.automaticRecoveryRequests = MAX_AUTOMATIC_RECOVERY_REQUESTS;
        this.scheduleRecoveryDeadline();
      } else if (payload.kind === "description") {
        this.reportRecoveryExhausted();
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
      });
    } catch (error) {
      this.setError(error, "更新 ICE 配置失败");
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
      this.clearInitialConnectionTimer();
      this.automaticRecoveryRequests = Math.max(
        this.automaticRecoveryRequests,
        1,
      );
      this.scheduleRecoveryDeadline();
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
    this.clearRecoveryTimer();
    this.disposeConnection();
    this.pendingByConnection.clear();
  }

  private replaceConnection(parentPeerId: string, connectionId: string): void {
    const parentChanged =
      this.parentPeerId !== null && this.parentPeerId !== parentPeerId;
    this.disposeConnection();
    if (parentChanged) {
      this.offerRecoveryAttempts = 0;
      this.resetAutomaticRecovery();
    }
    this.parentPeerId = parentPeerId;
    this.connectionId = connectionId;
    this.remoteStream = new MediaStream();
    this.statsAccumulator = createStatsAccumulator();

    const connection = new RTCPeerConnection({
      iceServers: this.currentIceConfig.iceServers,
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
      this.clearDisconnectTimer();
      this.clearInitialConnectionTimer();
      this.resetAutomaticRecovery();
      return;
    }
    if (state === "failed") {
      this.clearDisconnectTimer();
      this.attemptAutomaticRecovery();
      return;
    }
    if (state === "disconnected" && this.disconnectTimer === null) {
      this.disconnectTimer = window.setTimeout(() => {
        this.disconnectTimer = null;
        if (this.connection?.connectionState === "disconnected") {
          this.attemptAutomaticRecovery();
        }
      }, 3_000);
    }
  }

  private attemptAutomaticRecovery(): void {
    this.clearInitialConnectionTimer();
    if (
      this.disposed ||
      this.recoveryTimer !== null ||
      this.recoveryExhaustedReported ||
      this.connection?.connectionState === "connected" ||
      !this.connectionId ||
      !this.parentPeerId
    ) {
      return;
    }
    if (this.automaticRecoveryRequests >= MAX_AUTOMATIC_RECOVERY_REQUESTS) {
      this.reportRecoveryExhausted();
      return;
    }
    const rebuild = this.automaticRecoveryRequests > 0;
    if (
      !this.events.sendRestartRequest(
        this.parentPeerId,
        this.connectionId,
        rebuild,
      )
    ) {
      this.reportRecoveryExhausted();
      return;
    }
    this.automaticRecoveryRequests += 1;
    this.scheduleRecoveryDeadline();
  }

  private scheduleInitialConnectionDeadline(
    connection: RTCPeerConnection,
    connectionId: string,
  ): void {
    if (!this.isCurrentConnection(connection, connectionId)) {
      return;
    }
    this.clearInitialConnectionTimer();
    if (connection.connectionState === "connected") {
      return;
    }
    const timer = window.setTimeout(() => {
      if (this.initialConnectionTimer !== timer) {
        return;
      }
      this.initialConnectionTimer = null;
      if (
        this.isCurrentConnection(connection, connectionId) &&
        connection.connectionState !== "connected"
      ) {
        this.attemptAutomaticRecovery();
      }
    }, INITIAL_CONNECTION_TIMEOUT_MS);
    this.initialConnectionTimer = timer;
  }

  private scheduleRecoveryDeadline(): void {
    this.clearRecoveryTimer();
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      if (this.connection?.connectionState !== "connected") {
        this.attemptAutomaticRecovery();
      }
    }, AUTOMATIC_RECOVERY_TIMEOUT_MS);
  }

  private reportRecoveryExhausted(): void {
    if (
      this.recoveryExhaustedReported ||
      !this.parentPeerId ||
      !this.connectionId
    ) {
      return;
    }
    this.clearRecoveryTimer();
    const reported =
      this.events.onRecoveryExhausted?.(
        this.parentPeerId,
        this.connectionId,
      ) ?? true;
    if (reported) {
      this.recoveryExhaustedReported = true;
    } else {
      this.scheduleRecoveryDeadline();
    }
  }

  private resetAutomaticRecovery(): void {
    this.clearRecoveryTimer();
    this.automaticRecoveryRequests = 0;
    this.recoveryExhaustedReported = false;
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
    if (this.statsInFlightConnection === connection) {
      return;
    }
    this.statsInFlightConnection = connection;
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
    } finally {
      if (this.statsInFlightConnection === connection) {
        this.statsInFlightConnection = null;
      }
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

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private clearInitialConnectionTimer(): void {
    if (this.initialConnectionTimer !== null) {
      window.clearTimeout(this.initialConnectionTimer);
      this.initialConnectionTimer = null;
    }
  }

  private disposeConnection(): void {
    this.clearDisconnectTimer();
    this.clearInitialConnectionTimer();
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
