import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { parse, parsePayloads } from "sdp-transform";
import { observeDecodedFrameProof } from "../media/decoded-frame-proof";
import { EMPTY_METRICS, type PeerSnapshot } from "../types";
import {
  createStatsAccumulator,
  type StatsAccumulator,
} from "../webrtc/stats";
import {
  type ViewerMediaPeer,
  VIEWER_AUTOMATIC_RECOVERY_TIMEOUT_MS,
  VIEWER_INITIAL_CONNECTION_TIMEOUT_MS,
  VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS,
  VIEWER_MAX_PENDING_CANDIDATES,
  ViewerPeer,
  type ViewerPeerEvents,
  type ViewerPeerOptions,
} from "../webrtc/viewer-peer";
import {
  iceServersWithNatPrediction,
  isNativeNatSurveyCandidate,
  NatPredictionCandidateBatch,
  natPredictionSurveyUrls,
  type SignalCandidate,
} from "../webrtc/nat-prediction";
import { NativeClient } from "./client";
import { NativeMediaBridge } from "./media-bridge";
import type { NativeClientEvent, NativeVideoCodec } from "./wire";


export interface NativeViewerSource {
  client: NativeClient;
  sessionId: string;
  connectionId: string;
  generation: number;
  codec: NativeVideoCodec;
}

type PeerIceConfig = Pick<RTCConfiguration, "iceServers"> & {
  natPredictionStunUrls?: readonly string[];
};

export class NativeCapableViewerPeer implements ViewerMediaPeer {
  private backend: ViewerMediaPeer | null = null;
  private readonly pendingCandidates = new Map<
    string,
    Array<Extract<SignalPayload, { kind: "candidate" }>>
  >();
  private disposed = false;
  private identity: { parentPeerId: string; connectionId: string } | null = null;
  private signalTail: Promise<void> = Promise.resolve();
  private currentIceConfig: PeerIceConfig;

  constructor(
    iceConfig: PeerIceConfig,
    private readonly events: ViewerPeerEvents,
    private readonly options: ViewerPeerOptions,
    private readonly acquireNativeClient: () => Promise<NativeClient | null>,
    private readonly onNativeUnavailable: () => void,
    private readonly nativeSessionId: string,
    private readonly edgeCapacity: number,
  ) {
    this.currentIceConfig = iceConfig;
  }

  acceptSignal(parentPeerId: string, payload: SignalPayload): Promise<void> {
    const work = async () => {
      if (this.disposed) return;
      if (
        payload.kind === "candidate" &&
        (!this.backend ||
          this.identity?.parentPeerId !== parentPeerId ||
          this.identity.connectionId !== payload.connectionId)
      ) {
        this.queueCandidate(payload);
        return;
      }
      if (payload.kind === "description" && payload.description.type === "offer") {
        const nextIdentity = {
          parentPeerId,
          connectionId: payload.connectionId,
        };
        if (
          !this.identity ||
          this.identity.parentPeerId !== parentPeerId ||
          this.identity.connectionId !== payload.connectionId
        ) {
          this.backend?.dispose();
          this.backend = null;
          this.identity = nextIdentity;
        }
        if (!this.backend) {
          const client = offerHasNativeVideoCodec(payload.description.sdp)
            ? await this.acquireNativeClient().catch(() => null)
            : null;
          if (this.disposed) return;
          this.backend = client
            ? new NativeViewerPeer(
                this.currentIceConfig,
                this.events,
                this.options,
                client,
                this.nativeSessionId,
                this.edgeCapacity,
                this.onNativeUnavailable,
              )
            : this.newBrowserPeer();
        }
        await this.backend.acceptSignal(parentPeerId, payload);
        const pending = this.pendingCandidates.get(payload.connectionId) ?? [];
        this.pendingCandidates.delete(payload.connectionId);
        for (const candidate of pending) {
          await this.backend.acceptSignal(parentPeerId, candidate);
        }
        return;
      }
      await this.backend?.acceptSignal(parentPeerId, payload);
    };
    const result = this.signalTail.then(work, work);
    this.signalTail = result.catch(() => undefined);
    return result;
  }

  updateIceConfig(iceConfig: IceConfig): void {
    this.currentIceConfig = iceConfig;
    this.backend?.updateIceConfig(iceConfig);
  }

  requestRecovery(rebuild = false): boolean {
    return this.backend?.requestRecovery(rebuild) ?? false;
  }

  isRecovering(): boolean { return this.backend?.isRecovering() ?? false; }
  hasConnection(): boolean { return this.backend?.hasConnection() ?? this.identity !== null; }
  hasConnectionId(connectionId: string): boolean {
    return this.backend?.hasConnectionId(connectionId) ??
      this.identity?.connectionId === connectionId;
  }
  getConnectionIdentity(): { parentPeerId: string; connectionId: string } | null {
    return this.backend?.getConnectionIdentity() ?? this.identity;
  }
  isConnected(): boolean { return this.backend?.isConnected() ?? false; }
  get nativeSource(): NativeViewerSource | null {
    return this.backend instanceof NativeViewerPeer
      ? this.backend.source
      : null;
  }
  stopDecodedFrameProof(): void { this.backend?.stopDecodedFrameProof(); }
  activatePreparedRoute(): void { this.backend?.activatePreparedRoute(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.backend?.dispose();
    this.backend = null;
    this.identity = null;
    this.pendingCandidates.clear();
  }

  private queueCandidate(
    payload: Extract<SignalPayload, { kind: "candidate" }>,
  ): void {
    let queue = this.pendingCandidates.get(payload.connectionId);
    if (!queue) {
      if (this.pendingCandidates.size >= 2) {
        const oldest = this.pendingCandidates.keys().next().value;
        if (oldest) this.pendingCandidates.delete(oldest);
      }
      queue = [];
      this.pendingCandidates.set(payload.connectionId, queue);
    }
    if (queue.length < VIEWER_MAX_PENDING_CANDIDATES) queue.push(payload);
  }

  private newBrowserPeer(): ViewerPeer {
    return new ViewerPeer(this.currentIceConfig, this.events, this.options);
  }
}

class NativeViewerPeer implements ViewerMediaPeer {
  private currentIceConfig: PeerIceConfig;
  private parentPeerId: string | null = null;
  private connectionId: string | null = null;
  private bridge: NativeMediaBridge | null = null;
  private localCandidates: NatPredictionCandidateBatch | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private snapshot: PeerSnapshot | null = null;
  private statsAccumulator: StatsAccumulator = createStatsAccumulator();
  private statsTimer: number | null = null;
  private statsInFlight = false;
  private stopDecodedFrameObserver: (() => void) | null = null;
  private disconnectTimer: number | null = null;
  private initialConnectionTimer: number | null = null;
  private recoveryTimer: number | null = null;
  private automaticRecoveryRequests = 0;
  private recoveryExhaustedReported = false;
  private state: RTCPeerConnectionState = "new";
  private localCandidateType: RTCIceCandidateType | null = null;
  private remoteCandidateType: RTCIceCandidateType | null = null;
  private natTraversalPath: "unknown" | "ordinary" | "predicted" = "unknown";
  private recoveryOwner: "viewer" | "route";
  private readonly natPredictionEnabled: boolean;
  private disposed = false;
  private failureNotified = false;
  private sourceGeneration = 0;
  private sourceReady = false;
  private sourceCodec: NativeVideoCodec | null = null;

  get source(): NativeViewerSource | null {
    return this.connectionId && this.sourceReady && this.sourceCodec
      ? {
          client: this.client,
          sessionId: this.sessionId,
          connectionId: this.connectionId,
          generation: this.sourceGeneration,
          codec: this.sourceCodec,
        }
      : null;
  }

  constructor(
    iceConfig: PeerIceConfig,
    private readonly events: ViewerPeerEvents,
    options: ViewerPeerOptions,
    private readonly client: NativeClient,
    private readonly sessionId: string,
    private readonly edgeCapacity: number,
    private readonly onFailure: () => void,
  ) {
    this.currentIceConfig = iceConfig;
    this.recoveryOwner = options.recoveryOwner ?? "viewer";
    this.natPredictionEnabled = options.natPredictionEnabled ?? false;
    this.unsubscribe = client.onEvent((event) => this.onEvent(event));
    this.unsubscribeClose = client.onClose(() => {
      this.handleBridgeFailure(this.connectionId ?? "");
    });
  }

  async acceptSignal(parentPeerId: string, payload: SignalPayload): Promise<void> {
    if (this.disposed) return;
    if (payload.kind === "candidate") {
      if (
        this.parentPeerId !== parentPeerId ||
        this.connectionId !== payload.connectionId
      ) {
        return;
      }
      try {
        await this.client.addReceiveCandidate(
          this.sessionId,
          payload.connectionId,
          payload.candidate,
        );
      } catch {
        this.handleBridgeFailure(payload.connectionId);
      }
      return;
    }
    if (payload.description.type !== "offer") return;
    try {
      await this.acceptOffer(parentPeerId, payload);
    } catch {
      this.handleBridgeFailure(payload.connectionId);
    }
  }

  updateIceConfig(iceConfig: IceConfig): void {
    this.currentIceConfig = iceConfig;
  }

  requestRecovery(rebuild = false): boolean {
    if (
      this.recoveryOwner !== "viewer" ||
      this.recoveryTimer !== null ||
      !this.connectionId ||
      !this.parentPeerId
    ) {
      return false;
    }
    const sent = this.events.sendRestartRequest(
      this.parentPeerId,
      this.connectionId,
      rebuild,
    );
    if (sent) {
      this.clearInitialConnectionTimer();
      this.automaticRecoveryRequests = Math.max(
        this.automaticRecoveryRequests,
        rebuild ? VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS : 1,
      );
      this.scheduleRecoveryDeadline();
    }
    return sent;
  }

  isRecovering(): boolean { return this.recoveryTimer !== null; }
  hasConnection(): boolean { return this.connectionId !== null; }
  hasConnectionId(connectionId: string): boolean {
    return this.connectionId === connectionId;
  }
  getConnectionIdentity(): { parentPeerId: string; connectionId: string } | null {
    return this.parentPeerId && this.connectionId
      ? { parentPeerId: this.parentPeerId, connectionId: this.connectionId }
      : null;
  }
  isConnected(): boolean { return this.state === "connected"; }
  stopDecodedFrameProof(): void {
    this.stopDecodedFrameObserver?.();
    this.stopDecodedFrameObserver = null;
  }
  activatePreparedRoute(): void {
    if (this.recoveryOwner === "viewer") return;
    this.recoveryOwner = "viewer";
    this.handleConnectionState(this.state);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.disposeBridge();
    this.localCandidates?.discard();
    this.localCandidates = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeClose?.();
    this.unsubscribeClose = null;
    const connectionId = this.connectionId;
    this.connectionId = null;
    this.parentPeerId = null;
    this.sourceReady = false;
    this.sourceCodec = null;
    if (connectionId) {
      void this.client.closeReceiver(this.sessionId, connectionId).catch(
        () => undefined,
      );
    }
  }

  private async acceptOffer(
    parentPeerId: string,
    payload: Extract<SignalPayload, { kind: "description" }>,
  ): Promise<void> {
    const connectionId = payload.connectionId;
    const identityChanged =
      this.parentPeerId !== parentPeerId || this.connectionId !== connectionId;
    if (identityChanged) {
      const previous = this.connectionId;
      this.disposeBridge();
      this.localCandidates?.discard();
      if (previous) {
        await this.client.closeReceiver(this.sessionId, previous).catch(
          () => undefined,
        );
      }
      this.parentPeerId = parentPeerId;
      this.connectionId = connectionId;
      this.resetAutomaticRecovery();
    } else {
      this.disposeBridge();
      this.localCandidates?.discard();
    }
    this.state = "connecting";
    this.failureNotified = false;
    this.sourceGeneration += 1;
    this.sourceReady = false;
    this.sourceCodec = null;
    this.statsAccumulator = createStatsAccumulator();
    this.snapshot = {
      peerId: parentPeerId,
      connectionId,
      connectionState: "connecting",
      iceConnectionState: "checking",
      metrics: { ...EMPTY_METRICS },
      error: null,
    };
    const predictionEnabled =
      this.natPredictionEnabled &&
      natPredictionSurveyUrls(
        this.currentIceConfig.iceServers,
        this.currentIceConfig.natPredictionStunUrls,
      ).size > 0;
    const nativeIceConfig: IceConfig = {
      natPredictionStunUrls: this.currentIceConfig.natPredictionStunUrls
        ? [...this.currentIceConfig.natPredictionStunUrls]
        : undefined,
      iceServers: iceServersWithNatPrediction(
        this.currentIceConfig.iceServers,
        predictionEnabled,
        this.currentIceConfig.natPredictionStunUrls,
      ),
    };
    const sendCandidate = (candidate: SignalCandidate) => {
      if (
        this.disposed ||
        this.connectionId !== connectionId ||
        this.parentPeerId !== parentPeerId
      ) {
        return;
      }
      this.events.sendSignal(parentPeerId, {
        kind: "candidate",
        connectionId,
        candidate,
      });
    };
    const candidates = predictionEnabled
      ? new NatPredictionCandidateBatch(sendCandidate)
      : null;
    this.localCandidates = candidates;
    this.emit();
    const result = await this.client.receiveOffer(
      this.sessionId,
      connectionId,
      payload.description,
      nativeIceConfig,
      this.edgeCapacity,
    );
    if (
      this.disposed ||
      this.connectionId !== connectionId ||
      this.parentPeerId !== parentPeerId
    ) {
      await this.client.closeReceiver(this.sessionId, connectionId).catch(
        () => undefined,
      );
      return;
    }
    this.sourceCodec = result.codec;
    this.sourceReady = true;
    if (!this.events.sendSignal(parentPeerId, {
      kind: "description",
      connectionId,
      description: result.answer,
    })) {
      // A room-signaling outage is not evidence the local Native capability is
      // unavailable: close only this receiver and use the ordinary recovery
      // path, like the Browser peer's "signal send rejected" handling.
      this.sourceReady = false;
      this.sourceCodec = null;
      void this.client.closeReceiver(this.sessionId, connectionId).catch(
        () => undefined,
      );
      if (this.recoveryOwner === "route") {
        this.reportRecoveryExhausted();
      } else if (!this.requestRecovery(true)) {
        this.reportRecoveryExhausted();
      }
      return;
    }
    this.scheduleInitialConnectionDeadline(connectionId);
    const bridge = new NativeMediaBridge(
      this.sessionId,
      this.client,
      () => this.handleBridgeFailure(connectionId),
      result.audio,
      connectionId,
    );
    this.bridge = bridge;
    void bridge.start().then((stream) => {
      if (this.disposed || this.bridge !== bridge || this.connectionId !== connectionId) {
        bridge.dispose();
        return;
      }
      this.events.onStream(stream);
      this.startObservation(bridge, connectionId);
    }).catch(() => {
      if (this.bridge === bridge) this.handleBridgeFailure(connectionId);
    });
  }

  private onEvent(event: NativeClientEvent): void {
    if (this.disposed || event.shareId !== this.sessionId) {
      return;
    }
    if (event.type === "share-ended") {
      this.handleBridgeFailure(this.connectionId ?? "");
      return;
    }
    if (!("connectionId" in event) || event.connectionId !== this.connectionId) {
      return;
    }
    if (event.type === "edge-candidate") {
      if (this.localCandidates) {
        if (event.candidate) {
          this.localCandidates.add(
            event.candidate,
            isNativeNatSurveyCandidate(event.candidate),
          );
        } else this.localCandidates.complete();
      } else if (this.parentPeerId && this.connectionId) {
        this.events.sendSignal(this.parentPeerId, {
          kind: "candidate",
          connectionId: this.connectionId,
          candidate: event.candidate,
        });
      }
      return;
    }
    if (event.type === "edge-path") {
      this.localCandidateType = event.localType;
      this.remoteCandidateType = event.remoteType;
      this.natTraversalPath = event.natTraversalPath;
      this.emit();
      return;
    }
    if (event.type === "edge-state") {
      this.state = event.state;
      this.handleConnectionState(event.state);
      this.emit();
    }
  }

  private startObservation(bridge: NativeMediaBridge, connectionId: string): void {
    this.stopDecodedFrameProof();
    this.stopDecodedFrameObserver = observeDecodedFrameProof({
      readFramesDecoded: () => bridge.decodedVideoFrames(),
      owns: () =>
        !this.disposed && this.bridge === bridge && this.connectionId === connectionId,
      onProof: () => this.events.onFirstDecodedFrame?.(connectionId) ?? true,
    });
    this.statsTimer = window.setInterval(() => {
      void this.updateStats(bridge, connectionId);
    }, 2_000);
    void this.updateStats(bridge, connectionId);
  }

  private async updateStats(bridge: NativeMediaBridge, connectionId: string): Promise<void> {
    if (
      this.disposed ||
      this.bridge !== bridge ||
      this.connectionId !== connectionId ||
      this.statsInFlight
    ) {
      return;
    }
    this.statsInFlight = true;
    try {
      const metrics = await bridge.collectMetrics(this.statsAccumulator);
      if (this.bridge !== bridge || this.connectionId !== connectionId || !this.snapshot) return;
      this.snapshot = {
        ...this.snapshot,
        metrics: {
          ...metrics,
          path: this.localCandidateType && this.remoteCandidateType ? "direct" : metrics.path,
          natTraversalPath: this.natTraversalPath,
          selectedCandidatePairId: null,
          iceProtocol:
            this.localCandidateType && this.remoteCandidateType ? "udp" : null,
          localCandidateType: this.localCandidateType,
          remoteCandidateType: this.remoteCandidateType,
          localCandidateAddress: null,
          localCandidatePort: null,
          remoteCandidateAddress: null,
          remoteCandidatePort: null,
          rttMs: null,
          jitterMs: null,
          audioJitterMs: null,
        },
      };
      this.emit();
    } catch {
      // Metrics are observational and never own the media connection.
    } finally {
      this.statsInFlight = false;
    }
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    if (state === "connected") {
      this.clearDisconnectTimer();
      this.clearInitialConnectionTimer();
      this.resetAutomaticRecovery();
      return;
    }
    if (this.recoveryOwner === "route") {
      this.clearDisconnectTimer();
      if (state === "failed") this.reportRecoveryExhausted();
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
        if (this.state === "disconnected") this.attemptAutomaticRecovery();
      }, 3_000);
    }
  }

  private handleBridgeFailure(connectionId: string): void {
    if (this.disposed || this.connectionId !== connectionId) return;
    this.disposeBridge();
    if (this.failureNotified) return;
    this.failureNotified = true;
    this.sourceReady = false;
    void this.client.closeReceiver(this.sessionId, connectionId).catch(
      () => undefined,
    );
    this.onFailure();
    if (this.recoveryOwner === "route") {
      this.reportRecoveryExhausted();
      return;
    }
    if (!this.requestRecovery(true)) {
      this.reportRecoveryExhausted();
    }
  }

  private attemptAutomaticRecovery(): void {
    this.clearInitialConnectionTimer();
    if (
      this.disposed ||
      this.recoveryTimer !== null ||
      this.recoveryExhaustedReported ||
      !this.connectionId ||
      !this.parentPeerId
    ) {
      return;
    }
    if (
      this.automaticRecoveryRequests >=
      VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS
    ) {
      this.reportRecoveryExhausted();
      return;
    }
    const rebuild = this.automaticRecoveryRequests > 0;
    if (!this.events.sendRestartRequest(this.parentPeerId, this.connectionId, rebuild)) {
      this.reportRecoveryExhausted();
      return;
    }
    this.automaticRecoveryRequests += 1;
    this.scheduleRecoveryDeadline();
  }

  private reportRecoveryExhausted(): void {
    if (
      this.recoveryExhaustedReported ||
      !this.parentPeerId ||
      !this.connectionId
    ) return;
    this.clearRecoveryTimer();
    const reported = this.events.onRecoveryExhausted?.(
      this.parentPeerId,
      this.connectionId,
    ) ?? true;
    if (reported) this.recoveryExhaustedReported = true;
    else this.scheduleRecoveryDeadline();
  }

  private scheduleInitialConnectionDeadline(connectionId: string): void {
    if (this.recoveryOwner !== "viewer") return;
    this.clearInitialConnectionTimer();
    const timer = window.setTimeout(() => {
      if (this.initialConnectionTimer !== timer) return;
      this.initialConnectionTimer = null;
      if (this.connectionId === connectionId && this.state !== "connected") {
        this.attemptAutomaticRecovery();
      }
    }, VIEWER_INITIAL_CONNECTION_TIMEOUT_MS);
    this.initialConnectionTimer = timer;
  }

  private scheduleRecoveryDeadline(): void {
    this.clearRecoveryTimer();
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      if (this.state !== "connected") this.attemptAutomaticRecovery();
      this.emit();
    }, VIEWER_AUTOMATIC_RECOVERY_TIMEOUT_MS);
  }

  private resetAutomaticRecovery(): void {
    this.clearRecoveryTimer();
    this.automaticRecoveryRequests = 0;
    this.recoveryExhaustedReported = false;
  }

  private disposeBridge(): void {
    this.stopDecodedFrameProof();
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.statsInFlight = false;
    this.bridge?.dispose();
    this.bridge = null;
  }

  private emit(): void {
    if (!this.snapshot) return;
    this.snapshot = {
      ...this.snapshot,
      connectionState: this.state,
      iceConnectionState:
        this.state === "connected"
          ? "connected"
          : this.state === "failed"
            ? "failed"
            : this.state === "closed"
              ? "closed"
              : this.state === "disconnected"
                ? "disconnected"
                : "checking",
      error: this.state === "failed" ? { key: "native.fail.receiver" } : null,
    };
    this.events.onUpdate({
      ...this.snapshot,
      metrics: { ...this.snapshot.metrics },
    });
  }

  private clearTimers(): void {
    this.clearDisconnectTimer();
    this.clearInitialConnectionTimer();
    this.clearRecoveryTimer();
  }
  private clearDisconnectTimer(): void {
    if (this.disconnectTimer === null) return;
    window.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }
  private clearInitialConnectionTimer(): void {
    if (this.initialConnectionTimer === null) return;
    window.clearTimeout(this.initialConnectionTimer);
    this.initialConnectionTimer = null;
  }
  private clearRecoveryTimer(): void {
    if (this.recoveryTimer === null) return;
    window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

}

export function offerHasNativeVideoCodec(sdp: string): boolean {
  try {
    const session = parse(sdp);
    const video = session.media.filter((media) => {
      const direction = media.direction ?? session.direction ?? "sendrecv";
      return media.type === "video" && media.port > 0 &&
        (direction === "sendonly" || direction === "sendrecv");
    });
    if (video.length !== 1) return false;
    const media = video[0]!;
    const payloads = new Set(parsePayloads(media.payloads ?? ""));
    return media.rtp.some((codec) => payloads.has(codec.payload) &&
      codec.rate === 90_000 && /^(h264|vp8)$/i.test(codec.codec));
  } catch {
    return false;
  }
}
