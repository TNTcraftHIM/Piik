import type { IceConfig, SignalPayload } from "../../shared/protocol";
import type { QualityProfile } from "../media/quality";
import { configureVideoSender } from "../media/quality";
import {
  EMPTY_METRICS,
  type PeerSnapshot,
} from "../types";
import {
  collectConnectionMetrics,
  createStatsAccumulator,
} from "./stats";

const MAX_PENDING_CANDIDATES = 64;
type SignalCandidate = Extract<
  SignalPayload,
  { kind: "candidate" }
>["candidate"];

interface HostPeerEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate: (snapshot: PeerSnapshot) => void;
}

export class HostPeer {
  readonly connectionId = crypto.randomUUID();

  private readonly connection: RTCPeerConnection;
  private readonly pendingCandidates: SignalCandidate[] = [];
  private readonly statsAccumulator = createStatsAccumulator();
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private statsTimer: number | null = null;
  private disposed = false;
  private negotiating = false;
  private snapshot: PeerSnapshot;

  constructor(
    readonly peerId: string,
    iceConfig: IceConfig,
    private stream: MediaStream,
    private profile: QualityProfile,
    private readonly events: HostPeerEvents,
    private readonly forceRelay = false,
  ) {
    this.connection = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: forceRelay ? "relay" : "all",
    });
    this.snapshot = {
      peerId,
      connectionId: this.connectionId,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
      metrics: { ...EMPTY_METRICS },
      error: null,
    };
    this.bindConnectionEvents();
  }

  async start(): Promise<boolean> {
    const videoTrack = this.stream.getVideoTracks()[0];
    if (!videoTrack) {
      this.setError(new Error("共享流缺少视频轨道"), "创建连接失败");
      return false;
    }
    const audioTrack = this.stream.getAudioTracks()[0] ?? null;
    this.videoSender = this.connection.addTransceiver(videoTrack, {
      direction: "sendonly",
      streams: [this.stream],
    }).sender;
    this.audioSender = this.connection.addTransceiver(audioTrack ?? "audio", {
      direction: "sendonly",
      streams: [this.stream],
    }).sender;
    try {
      await configureVideoSender(this.videoSender, this.profile);
    } catch (error) {
      console.warn("Browser rejected preferred sender parameters", error);
    }
    if (!(await this.createOffer(false)) || this.disposed) {
      return false;
    }
    this.statsTimer = window.setInterval(() => {
      void this.updateStats();
    }, 2_000);
    this.emit();
    return true;
  }

  async replaceStream(
    nextStream: MediaStream,
    profile: QualityProfile,
  ): Promise<boolean> {
    const nextVideoTrack = nextStream.getVideoTracks()[0];
    if (
      this.disposed ||
      !this.videoSender ||
      !this.audioSender ||
      !nextVideoTrack
    ) {
      return false;
    }

    const nextAudioTrack = nextStream.getAudioTracks()[0] ?? null;
    const previousVideoTrack = this.videoSender.track;
    const previousAudioTrack = this.audioSender.track;

    try {
      await this.videoSender.replaceTrack(nextVideoTrack);
      await this.audioSender.replaceTrack(nextAudioTrack);
    } catch (error) {
      await Promise.allSettled([
        this.videoSender.replaceTrack(previousVideoTrack),
        this.audioSender.replaceTrack(previousAudioTrack),
      ]);
      this.setError(error, "切换共享源失败");
      return false;
    }

    if (this.disposed) {
      return false;
    }
    this.stream = nextStream;
    this.profile = profile;
    this.statsAccumulator.bytes = null;
    this.statsAccumulator.frames = null;
    this.statsAccumulator.timestamp = null;
    try {
      await configureVideoSender(this.videoSender, this.profile);
    } catch (error) {
      console.warn("Browser rejected preferred sender parameters", error);
    }
    this.snapshot = { ...this.snapshot, error: null };
    this.emit();
    return true;
  }

  async acceptSignal(payload: SignalPayload): Promise<void> {
    if (this.disposed || payload.connectionId !== this.connectionId) {
      return;
    }

    try {
      if (payload.kind === "description") {
        if (payload.description.type !== "answer") {
          return;
        }
        await this.connection.setRemoteDescription(payload.description);
        await this.flushCandidates();
      } else if (this.connection.remoteDescription) {
        await this.connection.addIceCandidate(payload.candidate);
      } else if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
        this.pendingCandidates.push(payload.candidate);
      }
    } catch (error) {
      this.setError(error, "处理观看端信令失败");
    }
  }

  async restartIce(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    if (this.negotiating) {
      return true;
    }
    if (this.connection.signalingState !== "stable") {
      return false;
    }
    return this.createOffer(true);
  }

  isConnected(): boolean {
    return this.connection.connectionState === "connected";
  }

  updateIceConfig(iceConfig: IceConfig): void {
    if (this.disposed) {
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.connection.close();
  }

  private bindConnectionEvents(): void {
    this.connection.addEventListener("icecandidate", (event) => {
      this.events.sendSignal(this.peerId, {
        kind: "candidate",
        connectionId: this.connectionId,
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
    this.connection.addEventListener("connectionstatechange", () => this.emit());
    this.connection.addEventListener("iceconnectionstatechange", () => this.emit());
  }

  private async createOffer(restart: boolean): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    this.negotiating = true;
    try {
      if (restart) {
        this.connection.restartIce();
      }
      const offer = await this.connection.createOffer();
      if (this.disposed) {
        return false;
      }
      await this.connection.setLocalDescription(offer);
      if (this.disposed || !this.connection.localDescription) {
        return false;
      }
      if (
        !this.events.sendSignal(this.peerId, {
          kind: "description",
          connectionId: this.connectionId,
          description: {
            type: "offer",
            sdp: this.connection.localDescription.sdp,
          },
        })
      ) {
        throw new Error("信令暂时离线，等待重新协商");
      }
      this.snapshot = { ...this.snapshot, error: null };
      this.emit();
      return true;
    } catch (error) {
      this.setError(error, restart ? "恢复连接失败" : "创建连接失败");
      return false;
    } finally {
      this.negotiating = false;
    }
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  private async updateStats(): Promise<void> {
    if (this.disposed || this.connection.connectionState === "closed") {
      return;
    }
    try {
      const metrics = await collectConnectionMetrics(
        this.connection,
        "send",
        this.statsAccumulator,
      );
      this.snapshot = { ...this.snapshot, metrics };
      this.emit();
    } catch {
      // Stats are observational and must never disrupt a healthy media path.
    }
  }

  private setError(error: unknown, fallback: string): void {
    const message = error instanceof Error ? error.message : fallback;
    this.snapshot = { ...this.snapshot, error: message || fallback };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) {
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
}
