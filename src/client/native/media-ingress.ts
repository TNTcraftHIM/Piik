import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import type { QualityProfile } from "../media/quality";
import type { PeerSnapshot } from "../types";
import { HostPeer } from "../webrtc/host-peer";
import { MAX_ENDPOINT_MEDIA_CHILDREN } from "../webrtc/media-assignment";
import { manualVideoCodecPreference } from "../webrtc/video-codec";
import { preferScreenAudioStereo } from "../webrtc/screen-audio-sdp";
import type { NativeSenderSource } from "./native-sender-peer";
import type { NativeClientEvent, NativeIceCandidate } from "./wire";

const INGRESS_TIMEOUT_MS = 8_000;
const MAX_PENDING_CANDIDATES = 64;
const LOCAL_ICE_CONFIG: IceConfig = { iceServers: [] };

export interface NativeMediaIngressControl {
  receiveOffer(
    shareId: string,
    connectionId: string,
    offer: RTCSessionDescriptionInit,
    iceConfig: IceConfig,
    edgeCapacity: number,
  ): Promise<{ answer: { type: "answer"; sdp: string }; audio: boolean }>;
  addReceiveCandidate(
    shareId: string,
    connectionId: string,
    candidate: NativeIceCandidate | null,
  ): Promise<void>;
  closeReceiver(shareId: string, connectionId: string): Promise<void>;
  onEvent(listener: (event: NativeClientEvent) => void): () => void;
}

/** One ordinary Browser sender supplies the App's encoded fanout source. */
export class NativeMediaIngress {
  readonly connectionId = createOpaqueId();
  readonly source: NativeSenderSource = {
    connectionId: this.connectionId,
    getProfile: () => this.getProfile(),
    format: () => {
      const metrics = this.sender?.getSnapshot().metrics;
      return { width: metrics?.frameWidth ?? null, height: metrics?.frameHeight ?? null };
    },
  };

  private sender: HostPeer | null = null;
  private unsubscribe: (() => void) | null = null;
  private receiverReady = false;
  private ready = false;
  private disposed = false;
  private audio = false;
  private startTimer: number | null = null;
  private settleStart: ((error?: Error) => void) | null = null;
  private readonly pendingCandidates: Array<NativeIceCandidate | null> = [];

  constructor(
    readonly shareId: string,
    private readonly client: NativeMediaIngressControl,
    private readonly onFailed: () => void,
    private readonly getProfile: () => QualityProfile,
  ) {}

  get hasAudio(): boolean { return this.audio; }

  async start(stream: MediaStream, profile: QualityProfile): Promise<void> {
    if (this.disposed || this.sender) throw new Error("Native media ingress is unavailable");
    this.audio = stream.getAudioTracks().length > 0;
    const started = new Promise<void>((resolve, reject) => {
      this.settleStart = (error) => {
        this.clearStart();
        if (error) reject(error);
        else resolve();
      };
      this.startTimer = window.setTimeout(() => this.fail(), INGRESS_TIMEOUT_MS);
    });
    try {
      this.unsubscribe = this.client.onEvent((event) => this.onEvent(event));
      this.sender = new HostPeer(
        this.connectionId, LOCAL_ICE_CONFIG, stream, profile,
        {
          sendSignal: (_peerId, payload) => {
            if (this.disposed) return false;
            void this.sendSignal(payload).catch(() => this.fail());
            return true;
          },
          onUpdate: (snapshot) => this.onUpdate(snapshot),
        },
        manualVideoCodecPreference("h264"), this.connectionId,
      );
      void this.sender.start().then((sent) => {
        if (!sent) this.fail();
      }).catch(() => this.fail());
    } catch {
      this.fail();
    }
    try {
      await started;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    return this.sender?.updateCaptureProfile(profile) ?? Promise.resolve(false);
  }

  setPaused(paused: boolean): void { this.sender?.setPaused(paused); }

  replaceStream(stream: MediaStream): Promise<boolean> {
    if ((stream.getAudioTracks().length > 0) !== this.audio) return Promise.resolve(false);
    return this.sender?.replaceStream(stream) ?? Promise.resolve(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleStart?.(new Error("Native media ingress was closed"));
    this.clearStart();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingCandidates.length = 0;
    this.sender?.dispose();
    void this.client.closeReceiver(this.shareId, this.connectionId).catch(() => undefined);
  }

  private async sendSignal(payload: SignalPayload): Promise<void> {
    if (payload.kind === "candidate") {
      if (!this.receiverReady) {
        if (this.pendingCandidates.length >= MAX_PENDING_CANDIDATES) throw new Error("Native candidate queue is full");
        this.pendingCandidates.push(payload.candidate);
      } else {
        await this.client.addReceiveCandidate(this.shareId, this.connectionId, payload.candidate);
      }
      return;
    }
    const result = await this.client.receiveOffer(
      this.shareId, this.connectionId, payload.description,
      LOCAL_ICE_CONFIG, MAX_ENDPOINT_MEDIA_CHILDREN,
    );
    if (this.disposed) {
      await this.client.closeReceiver(this.shareId, this.connectionId);
      return;
    }
    this.receiverReady = true;
    await this.sender?.acceptSignal({
      kind: "description", connectionId: this.connectionId,
      description: { type: "answer", sdp: preferScreenAudioStereo(result.answer).sdp! },
    });
    for (const candidate of this.pendingCandidates.splice(0)) {
      if (this.disposed) return;
      await this.client.addReceiveCandidate(this.shareId, this.connectionId, candidate);
    }
  }

  private onEvent(event: NativeClientEvent): void {
    if (this.disposed || event.shareId !== this.shareId ||
      !("connectionId" in event) || event.connectionId !== this.connectionId) return;
    if (event.type === "edge-candidate") {
      void this.sender?.acceptSignal({
        kind: "candidate", connectionId: this.connectionId, candidate: event.candidate,
      }).catch(() => this.fail());
    } else if (event.type === "edge-state" && (event.state === "failed" || event.state === "closed")) {
      this.fail();
    }
  }

  private onUpdate(snapshot: PeerSnapshot): void {
    if (this.disposed) return;
    if (snapshot.connectionState === "failed" || snapshot.connectionState === "closed" ||
      (!this.ready && snapshot.error)) {
      this.fail();
    } else if (!this.ready && snapshot.connectionState === "connected") {
      this.ready = true;
      this.settleStart?.();
    }
  }

  private fail(): void {
    if (this.disposed) return;
    const notify = this.ready;
    this.dispose();
    if (notify) this.onFailed();
  }

  private clearStart(): void {
    if (this.startTimer !== null) window.clearTimeout(this.startTimer);
    this.startTimer = null;
    this.settleStart = null;
  }
}
