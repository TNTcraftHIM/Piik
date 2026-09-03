import type { IceConfig, SignalPayload } from "../../shared/protocol";
import type { NativeClientEvent } from "./wire";

const MAX_PENDING_CANDIDATES = 64;

export interface NativeEdgeControl {
  prepareEdge(
    shareId: string,
    connectionId: string,
    iceConfig: IceConfig,
  ): Promise<RTCSessionDescriptionInit>;
  acceptSignal(
    shareId: string,
    connectionId: string,
    payload: SignalPayload,
  ): Promise<void>;
  closeEdge(shareId: string, connectionId: string): Promise<void>;
  onEvent(listener: (event: NativeClientEvent) => void): () => void;
}

interface NativeHostEdgeEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onState: (state: RTCPeerConnectionState) => void;
  onPath?: (local: RTCIceCandidateType, remote: RTCIceCandidateType) => void;
  onQuality?: (
    quality: Extract<NativeClientEvent, { type: "edge-quality" }>,
  ) => void;
}

export class NativeHostEdge {
  private readonly pendingCandidates: SignalPayload[] = [];
  private unsubscribe: (() => void) | null = null;
  private offerSent = false;
  private disposed = false;
  private connected = false;

  constructor(
    readonly peerId: string,
    readonly connectionId: string,
    private readonly shareId: string,
    private readonly iceConfig: IceConfig,
    private readonly control: NativeEdgeControl,
    private readonly events: NativeHostEdgeEvents,
  ) {}

  async start(): Promise<boolean> {
    if (this.disposed || this.unsubscribe) return false;
    this.unsubscribe = this.control.onEvent((event) => this.onEvent(event));
    try {
      const offer = await this.control.prepareEdge(
        this.shareId,
        this.connectionId,
        this.iceConfig,
      );
      if (
        this.disposed ||
        offer.type !== "offer" ||
        !offer.sdp ||
        !this.events.sendSignal(this.peerId, {
          kind: "description",
          connectionId: this.connectionId,
          description: { type: "offer", sdp: offer.sdp },
        })
      ) {
        this.dispose();
        return false;
      }
      this.offerSent = true;
      for (const candidate of this.pendingCandidates.splice(0)) {
        if (!this.events.sendSignal(this.peerId, candidate)) {
          this.dispose();
          return false;
        }
      }
      return true;
    } catch {
      this.dispose();
      return false;
    }
  }

  async acceptSignal(payload: SignalPayload): Promise<void> {
    if (this.disposed || payload.connectionId !== this.connectionId) return;
    await this.control.acceptSignal(
      this.shareId,
      this.connectionId,
      payload,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    this.pendingCandidates.length = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.control.closeEdge(this.shareId, this.connectionId).catch(
      () => undefined,
    );
  }

  private onEvent(event: NativeClientEvent): void {
    if (this.disposed || event.shareId !== this.shareId) return;
    if (event.type === "share-ended") {
      this.connected = false;
      this.events.onState(event.failed ? "failed" : "closed");
      return;
    }
    if (
      !("connectionId" in event) ||
      event.connectionId !== this.connectionId
    ) {
      return;
    }
    if (event.type === "edge-candidate") {
      const payload: SignalPayload = {
        kind: "candidate",
        connectionId: this.connectionId,
        candidate: event.candidate,
      };
      if (!this.offerSent) {
        if (this.pendingCandidates.length >= MAX_PENDING_CANDIDATES) {
          this.dispose();
          this.events.onState("failed");
          return;
        }
        this.pendingCandidates.push(payload);
        return;
      }
      if (!this.events.sendSignal(this.peerId, payload)) {
        this.dispose();
        this.events.onState("failed");
      }
      return;
    }
    if (event.type === "edge-state") {
      this.connected = event.state === "connected";
      this.events.onState(event.state);
      return;
    }
    if (event.type === "edge-path") {
      this.events.onPath?.(event.localType, event.remoteType);
      return;
    }
    if (event.type === "edge-quality") {
      this.events.onQuality?.(event);
    }
  }
}
