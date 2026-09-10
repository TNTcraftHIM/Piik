import type {
  IceConfig,
  PreparedRouteCandidate,
  QualitySettings,
  SignalPayload,
} from "../../shared/protocol";
import { EMPTY_METRICS, type PeerSnapshot } from "../types";
import type { HostMediaPeer } from "../webrtc/host-peer";
import { NativeSenderEdge, type NativeEdgeControl } from "./native-sender-edge";
import type { NativeVideoCodec } from "./wire";

interface NativeSenderPeerEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate: (snapshot: PeerSnapshot) => void;
}

export interface NativeSourceFormat {
  width: number | null;
  height: number | null;
}

export interface NativeSenderSource {
  connectionId: string;
  getProfile: () => QualitySettings;
  format?: () => NativeSourceFormat;
}

export class NativeSenderPeer implements HostMediaPeer {
  readonly connectionId: string;
  private readonly edge: NativeSenderEdge;
  private disposed = false;
  private state: RTCPeerConnectionState = "new";
  private localCandidateType: string | null = null;
  private remoteCandidateType: string | null = null;
  private snapshot: PeerSnapshot;

  constructor(
    readonly peerId: string,
    connectionId: string,
    private readonly shareId: string,
    iceConfig: IceConfig,
    natPredictionEnabled: boolean,
    private readonly control: NativeEdgeControl,
    events: NativeSenderPeerEvents,
    codec: NativeVideoCodec,
    private readonly source?: NativeSenderSource,
  ) {
    this.connectionId = connectionId;
    this.snapshot = {
      peerId,
      connectionId,
      connectionState: this.state,
      iceConnectionState: "new",
      metrics: { ...EMPTY_METRICS, path: "direct" },
      error: null,
      senderParameters: null,
      audioSenderParameters: null,
    };
    this.edge = new NativeSenderEdge(
      peerId,
      connectionId,
      shareId,
      iceConfig,
      natPredictionEnabled,
      control,
      {
        sendSignal: events.sendSignal,
        onState: (state) => {
          this.state = state;
          this.snapshot = {
            ...this.snapshot,
            connectionState: state,
            iceConnectionState:
              state === "connected"
                ? "connected"
                : state === "failed"
                  ? "failed"
                  : state === "closed"
                    ? "closed"
                    : "checking",
            error: state === "failed" ? { key: "native.fail.edge" } : null,
          };
          events.onUpdate(this.getSnapshot());
        },
        onPath: (local, remote, natTraversalPath) => {
          this.localCandidateType = local;
          this.remoteCandidateType = remote;
          this.snapshot = {
            ...this.snapshot,
            metrics: {
              ...this.snapshot.metrics,
              localCandidateType: local,
              remoteCandidateType: remote,
              natTraversalPath,
            },
          };
          events.onUpdate(this.getSnapshot());
        },
        onQuality: (quality) => {
          const known = quality.state !== "unknown";
          const format = this.source?.format?.();
          const width = quality.width || format?.width || null;
          const height = quality.height || format?.height || null;
          this.snapshot = {
            ...this.snapshot,
            metrics: {
              ...this.snapshot.metrics,
              sampleTimestampMs: quality.sampleTimestampMs,
              sampleWindowMs: quality.sampleWindowMs,
              rtpStatsId: quality.rtpStatsId,
              trackIdentifier: quality.trackIdentifier,
              videoEncodingCount: 1,
              activeVideoEncodingCount: this.isConnected() ? 1 : 0,
              captureWidth: width,
              captureHeight: height,
              captureFramesPerSecond: quality.framesPerSecond,
              mediaSourceFramesPerSecond: quality.framesPerSecond,
              bitrateKbps: quality.bitrateKbps,
              availableOutgoingKbps: known
                ? quality.availableOutgoingKbps
                : null,
              framesPerSecond: quality.framesPerSecond,
              frameWidth: width,
              frameHeight: height,
              resolution:
                width !== null && height !== null
                  ? `${width}x${height}`
                  : null,
              codec: `video/${codec.toUpperCase()}`,
              codecProfile: null,
              codecParameters: null,
              powerEfficientEncoder: this.source ? null : codec === "h264",
              intervalFramesEncoded: quality.intervalFramesEncoded,
              qualityLimitationReason: quality.reason,
              nativeEdgeQualityState: quality.state,
            },
          };
          events.onUpdate(this.getSnapshot());
        },
      },
      this.source?.connectionId,
    );
    this.events = events;
  }

  private readonly events: NativeSenderPeerEvents;

  async start(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.source && !(await this.updateProfile(this.source.getProfile()))) return false;
    if (this.disposed) return false;
    return this.edge.start();
  }

  async acceptSignal(payload: SignalPayload): Promise<void> {
    if (this.disposed) return;
    try {
      await this.edge.acceptSignal(payload);
    } catch {
      this.state = "failed";
      this.snapshot = {
        ...this.snapshot,
        connectionState: "failed",
        iceConnectionState: "failed",
        error: { key: "native.fail.signaling" },
      };
      this.events.onUpdate(this.getSnapshot());
    }
  }

  restartIce(): Promise<boolean> {
    return Promise.resolve(false);
  }

  isConnected(): boolean {
    return !this.disposed && this.edge.isConnected();
  }

  getSnapshot(): PeerSnapshot {
    return {
      ...this.snapshot,
      metrics: {
        ...this.snapshot.metrics,
        localCandidateType: this.localCandidateType,
        remoteCandidateType: this.remoteCandidateType,
      },
    };
  }

  updateIceConfig(_iceConfig: IceConfig): void {
    // A new generation receives the new ICE configuration. Pion does not
    // mutate a live edge's server list behind the route owner's fence.
  }

  async updateProfile(profile: Parameters<HostMediaPeer["updateProfile"]>[0]): Promise<boolean> {
    if (this.disposed) return false;
    // Native Host capture remains share-owned; only received sources need a relay ceiling.
    if (!this.source) return true;
    try {
      await this.control.updateShare(this.shareId, profile);
      return !this.disposed;
    } catch {
      return false;
    }
  }

  updateCaptureProfile(profile: Parameters<HostMediaPeer["updateCaptureProfile"]>[0]): Promise<boolean> {
    return this.updateProfile(profile);
  }

  setPaused(_paused: boolean): void {
    // Native pause is owned by the share session, not an individual edge.
  }

  replaceStream(_stream: MediaStream): Promise<boolean> {
    // A received native source is independent of its Browser preview stream.
    // A capture-backed Host source is replaced by its share-level owner.
    return Promise.resolve(this.source !== undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.edge.dispose();
  }
}

export function shouldUseBrowserQualityCandidate(
  current: HostMediaPeer | undefined,
  candidate: PreparedRouteCandidate,
): boolean {
  return candidate.qualityProbe && current instanceof NativeSenderPeer;
}
