import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { EMPTY_METRICS, type PeerSnapshot } from "../types";
import type { HostMediaPeer } from "../webrtc/host-peer";
import { NativeHostEdge, type NativeEdgeControl } from "./host-edge";

interface NativeHostPeerEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate: (snapshot: PeerSnapshot) => void;
}

export class NativeHostPeer implements HostMediaPeer {
  readonly connectionId: string;
  private readonly edge: NativeHostEdge;
  private disposed = false;
  private state: RTCPeerConnectionState = "new";
  private localCandidateType: string | null = null;
  private remoteCandidateType: string | null = null;
  private snapshot: PeerSnapshot;

  constructor(
    readonly peerId: string,
    connectionId: string,
    shareId: string,
    iceConfig: IceConfig,
    control: NativeEdgeControl,
    events: NativeHostPeerEvents,
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
      qualityWarning: null,
      qualityWarningKind: null,
    };
    this.edge = new NativeHostEdge(
      peerId,
      connectionId,
      shareId,
      iceConfig,
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
            error: state === "failed" ? "Native media edge failed" : null,
          };
          events.onUpdate(this.getSnapshot());
        },
        onPath: (local, remote) => {
          this.localCandidateType = local;
          this.remoteCandidateType = remote;
          this.snapshot = {
            ...this.snapshot,
            metrics: {
              ...this.snapshot.metrics,
              localCandidateType: local,
              remoteCandidateType: remote,
              natTraversalPath: "ordinary",
            },
          };
          events.onUpdate(this.getSnapshot());
        },
      },
    );
    this.events = events;
  }

  private readonly events: NativeHostPeerEvents;

  start(): Promise<boolean> {
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
        error: "Native media signaling failed",
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

  updateProfile(_profile: Parameters<HostMediaPeer["updateProfile"]>[0]): Promise<boolean> {
    // The current native generation has a fixed 1280x720 H.264 source. A
    // profile change requires a new capture generation, so report unsupported
    // instead of claiming that the sender changed.
    return Promise.resolve(false);
  }

  updateCaptureProfile(_profile: Parameters<HostMediaPeer["updateCaptureProfile"]>[0]): Promise<boolean> {
    return Promise.resolve(false);
  }

  setPaused(_paused: boolean): void {
    // Native pause is owned by the share session, not an individual edge.
  }

  replaceStream(_stream: MediaStream): Promise<boolean> {
    return Promise.resolve(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.edge.dispose();
  }
}
