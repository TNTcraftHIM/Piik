import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import type { QualityProfile } from "../media/quality";
import {
  configureScreenAudioSender,
  configureVideoSender,
  senderParameterWarning,
} from "../media/quality";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
  type PeerSnapshot,
} from "../types";
import {
  collectConnectionMetrics,
  createStatsAccumulator,
} from "./stats";
import { applyVideoCodecPreference } from "./video-codec-preference";

const MAX_PENDING_CANDIDATES = 64;
type PeerIceConfig = Pick<RTCConfiguration, "iceServers">;
type SignalCandidate = Extract<
  SignalPayload,
  { kind: "candidate" }
>["candidate"];

interface HostPeerEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate: (snapshot: PeerSnapshot) => void;
}

type CaptureMetrics = Pick<
  ConnectionMetrics,
  "captureWidth" | "captureHeight" | "captureFramesPerSecond"
>;

function captureMetrics(track: MediaStreamTrack): CaptureMetrics {
  if (typeof track.getSettings !== "function") {
    return {
      captureWidth: null,
      captureHeight: null,
      captureFramesPerSecond: null,
    };
  }

  try {
    const settings = track.getSettings();
    const finiteNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      captureWidth: finiteNumber(settings.width),
      captureHeight: finiteNumber(settings.height),
      captureFramesPerSecond: finiteNumber(settings.frameRate),
    };
  } catch {
    return {
      captureWidth: null,
      captureHeight: null,
      captureFramesPerSecond: null,
    };
  }
}

export class HostPeer {
  readonly connectionId: string;

  private readonly connection: RTCPeerConnection;
  private readonly pendingCandidates: SignalCandidate[] = [];
  private statsAccumulator = createStatsAccumulator();
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private statsTimer: number | null = null;
  private statsInFlight = false;
  private statsSamplingBlocked = false;
  private senderWarning: string | null = null;
  private limitationReason: string | null = null;
  private limitationSamples = 0;
  private disposed = false;
  private negotiating = false;
  private senderMutationTail: Promise<void> = Promise.resolve();
  private snapshot: PeerSnapshot;

  constructor(
    readonly peerId: string,
    iceConfig: PeerIceConfig,
    private stream: MediaStream,
    private desiredProfile: QualityProfile,
    private readonly events: HostPeerEvents,
    private readonly relayOnly = false,
    connectionId = createOpaqueId(),
  ) {
    this.connectionId = connectionId;
    this.connection = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      ...(relayOnly ? { iceTransportPolicy: "relay" } : {}),
    });
    this.snapshot = {
      peerId,
      connectionId: this.connectionId,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
      metrics: { ...EMPTY_METRICS },
      error: null,
      senderParameters: null,
      qualityWarning: null,
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
    const videoTransceiver = this.connection.addTransceiver(videoTrack, {
      direction: "sendonly",
      streams: [this.stream],
    });
    applyVideoCodecPreference(
      videoTransceiver,
      this.desiredProfile.videoCodec,
    );
    this.videoSender = videoTransceiver.sender;
    this.audioSender = this.connection.addTransceiver(audioTrack ?? "audio", {
      direction: "sendonly",
      streams: [this.stream],
    }).sender;
    await this.enqueueSenderMutation(async () => {
      if (this.disposed || !this.videoSender || !this.audioSender) {
        return false;
      }
      return this.configureSender(this.videoSender, this.audioSender);
    });
    if (!(await this.createOffer(false)) || this.disposed) {
      return false;
    }
    this.statsTimer = window.setInterval(() => {
      void this.updateStats();
    }, 2_000);
    this.emit();
    return true;
  }

  async replaceStream(nextStream: MediaStream): Promise<boolean> {
    const nextVideoTrack = nextStream.getVideoTracks()[0];
    if (this.disposed || !nextVideoTrack) {
      return false;
    }

    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender;
      const audioSender = this.audioSender;
      if (this.disposed || !videoSender || !audioSender) {
        return false;
      }

      const nextAudioTrack = nextStream.getAudioTracks()[0] ?? null;
      const previousVideoTrack = videoSender.track;
      const previousAudioTrack = audioSender.track;
      this.statsSamplingBlocked = true;
      this.statsAccumulator = createStatsAccumulator();

      try {
        try {
          await videoSender.replaceTrack(nextVideoTrack);
          await audioSender.replaceTrack(nextAudioTrack);
        } catch (error) {
          await Promise.allSettled([
            videoSender.replaceTrack(previousVideoTrack),
            audioSender.replaceTrack(previousAudioTrack),
          ]);
          this.setError(error, "切换共享源失败");
          return false;
        }

        if (this.disposed) {
          return false;
        }
        this.stream = nextStream;
        this.limitationReason = null;
        this.limitationSamples = 0;
        this.snapshot = { ...this.snapshot, metrics: { ...EMPTY_METRICS } };
        await this.configureSender(videoSender, audioSender);
        this.snapshot = { ...this.snapshot, error: null };
        this.emit();
        return true;
      } finally {
        this.statsAccumulator = createStatsAccumulator();
        this.statsSamplingBlocked = false;
      }
    });
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    this.desiredProfile = profile;
    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender;
      if (this.disposed || !videoSender) {
        return false;
      }
      if (!(await this.configureSender(videoSender))) {
        return false;
      }
      if (this.disposed) {
        return false;
      }
      this.statsAccumulator = createStatsAccumulator();
      this.limitationReason = null;
      this.limitationSamples = 0;
      this.snapshot = { ...this.snapshot, error: null };
      this.emit();
      return true;
    });
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

  getSnapshot(): PeerSnapshot {
    return { ...this.snapshot, metrics: { ...this.snapshot.metrics } };
  }

  updateIceConfig(iceConfig: IceConfig): void {
    if (this.disposed || this.relayOnly) {
      return;
    }
    try {
      this.connection.setConfiguration({
        iceServers: iceConfig.iceServers,
      });
    } catch (error) {
      this.setError(error, "更新网络配置失败");
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

  private enqueueSenderMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.senderMutationTail.then(operation);
    this.senderMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    if (
      this.disposed ||
      this.connection.connectionState === "closed" ||
      this.statsInFlight ||
      this.statsSamplingBlocked
    ) {
      return;
    }
    const captureTrack = this.videoSender?.track ?? null;
    if (!captureTrack || this.stream.getVideoTracks()[0] !== captureTrack) {
      return;
    }
    this.statsInFlight = true;
    const statsAccumulator = this.statsAccumulator;
    try {
      const metricsPromise = collectConnectionMetrics(
        this.connection,
        "send",
        statsAccumulator,
        { trackIdentifier: captureTrack.id },
      );
      const capture = captureMetrics(captureTrack);
      const metrics = { ...(await metricsPromise), ...capture };
      if (
        this.disposed ||
        this.statsSamplingBlocked ||
        this.statsAccumulator !== statsAccumulator ||
        this.videoSender?.track !== captureTrack ||
        this.stream.getVideoTracks()[0] !== captureTrack ||
        (metrics.trackIdentifier !== null &&
          metrics.trackIdentifier !== captureTrack.id)
      ) {
        return;
      }
      this.updateLimitationWarning(metrics.qualityLimitationReason);
      this.snapshot = {
        ...this.snapshot,
        metrics,
        qualityWarning:
          this.senderWarning ?? this.persistentLimitationWarning(),
      };
      this.emit();
    } catch {
      // Stats are observational and must never disrupt a healthy media path.
    } finally {
      this.statsInFlight = false;
    }
  }

  private setError(error: unknown, fallback: string): void {
    const message = error instanceof Error ? error.message : fallback;
    this.snapshot = { ...this.snapshot, error: message || fallback };
    this.emit();
  }

  private async configureSender(
    sender: RTCRtpSender,
    audioSender?: RTCRtpSender,
  ): Promise<boolean> {
    try {
      const senderParameters = await configureVideoSender(
        sender,
        this.desiredProfile,
      );
      if (audioSender?.track) {
        await configureScreenAudioSender(audioSender);
      }
      if (this.disposed) {
        return false;
      }
      this.senderWarning = senderParameterWarning(senderParameters);
      this.snapshot = {
        ...this.snapshot,
        senderParameters,
        qualityWarning:
          this.senderWarning ?? this.persistentLimitationWarning(),
      };
      this.emit();
      return true;
    } catch (error) {
      if (this.disposed) {
        return false;
      }
      this.senderWarning =
        error instanceof Error && error.message
          ? `应用发送参数失败：${error.message}`
          : "应用发送参数失败";
      this.snapshot = {
        ...this.snapshot,
        qualityWarning: this.senderWarning,
      };
      this.emit();
      return false;
    }
  }

  private updateLimitationWarning(reason: string | null): void {
    if (!reason || reason === "none") {
      this.limitationReason = null;
      this.limitationSamples = 0;
      return;
    }
    if (reason === this.limitationReason) {
      this.limitationSamples += 1;
      return;
    }
    this.limitationReason = reason;
    this.limitationSamples = 1;
  }

  private persistentLimitationWarning(): string | null {
    if (this.limitationSamples < 3) {
      return null;
    }
    switch (this.limitationReason) {
      case "bandwidth":
        return "持续受带宽限制，浏览器正在降低画面质量";
      case "cpu":
        return "持续受编码性能限制，浏览器正在降低画面质量";
      case "other":
        return "浏览器持续报告其他画质限制";
      default:
        return this.limitationReason
          ? `浏览器持续报告画质限制：${this.limitationReason}`
          : null;
    }
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
