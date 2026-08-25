import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import {
  audioSenderParameterWarning,
  configureScreenAudioSender,
  configureVideoSender,
  resolveScreenAudioQuality,
  screenAudioQualityEqual,
  senderParameterWarning,
  videoQualitySettingsEqual,
  type AudioSenderParameterReadback,
  type QualityProfile,
  type ScreenAudioQuality,
} from "../media/quality";
import {
  EMPTY_METRICS,
  type PeerSnapshot,
} from "../types";
import {
  captureMetrics,
  collectConnectionMetrics,
  createStatsAccumulator,
} from "./stats";
import { applyVp8Codec } from "./vp8-codec";

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
  private videoSenderWarning: string | null = null;
  private audioSenderWarning: string | null = null;
  private appliedVideoProfile: QualityProfile | null = null;
  private appliedAudioQuality: ScreenAudioQuality | null = null;
  private appliedAudioSenderParameters:
    | AudioSenderParameterReadback
    | null = null;
  private limitationReason: string | null = null;
  private limitationSamples = 0;
  private disposed = false;
  private profileRevision = 0;
  private negotiationEpoch = 0;
  private ordinaryAnswerEpoch: number | null = null;
  private senderMutationTail: Promise<void> = Promise.resolve();
  private negotiationTail: Promise<void> = Promise.resolve();
  private snapshot: PeerSnapshot;

  constructor(
    readonly peerId: string,
    iceConfig: PeerIceConfig,
    private stream: MediaStream,
    private desiredProfile: QualityProfile,
    private readonly events: HostPeerEvents,
    connectionId = createOpaqueId(),
  ) {
    this.connectionId = connectionId;
    this.connection = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
    });
    this.snapshot = {
      peerId,
      connectionId: this.connectionId,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
      metrics: { ...EMPTY_METRICS },
      error: null,
      senderParameters: null,
      audioSenderParameters: null,
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
    if (!applyVp8Codec(videoTransceiver)) {
      this.setError(null, "当前浏览器无法使用 VP8 视频编码");
      return false;
    }
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
    const requestedVideo =
      !videoQualitySettingsEqual(this.desiredProfile, profile) ||
      this.appliedVideoProfile === null ||
      !videoQualitySettingsEqual(this.appliedVideoProfile, profile);
    const requestedAudio =
      !screenAudioQualityEqual(this.desiredProfile, profile) ||
      this.appliedAudioQuality !==
        resolveScreenAudioQuality(profile.screenAudioQuality);
    this.desiredProfile = profile;
    const requestedRevision = ++this.profileRevision;
    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender;
      const audioSender = this.audioSender;
      if (
        this.disposed ||
        !videoSender ||
        !audioSender ||
        requestedRevision !== this.profileRevision
      ) {
        return false;
      }
      const updateVideo =
        requestedVideo ||
        this.appliedVideoProfile === null ||
        !videoQualitySettingsEqual(this.appliedVideoProfile, profile);
      const updateAudio =
        requestedAudio ||
        this.appliedAudioQuality !==
          resolveScreenAudioQuality(profile.screenAudioQuality);
      if (!updateVideo && !updateAudio) {
        return true;
      }
      if (
        !(await this.configureSender(videoSender, audioSender, {
          profile,
          profileRevision: requestedRevision,
          video: updateVideo,
          audio: updateAudio,
        }))
      ) {
        return false;
      }
      if (this.disposed || requestedRevision !== this.profileRevision) {
        return false;
      }
      if (updateVideo) {
        this.statsAccumulator = createStatsAccumulator();
        this.limitationReason = null;
        this.limitationSamples = 0;
      }
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
        await this.enqueueNegotiation(() => this.acceptAnswer(payload));
      } else if (this.connection.remoteDescription) {
        await this.connection.addIceCandidate(payload.candidate);
      } else if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
        this.pendingCandidates.push(payload.candidate);
      }
    } catch (error) {
      this.setError(error, "建立观看连接失败");
    }
  }

  async restartIce(): Promise<boolean> {
    return this.enqueueNegotiation(async () => {
      if (
        this.disposed ||
        this.connection.signalingState !== "stable"
      ) {
        return false;
      }
      return this.createOwnedOffer(true, this.nextNegotiationEpoch());
    });
  }

  isConnected(): boolean {
    return this.connection.connectionState === "connected";
  }

  getSnapshot(): PeerSnapshot {
    return { ...this.snapshot, metrics: { ...this.snapshot.metrics } };
  }

  updateIceConfig(iceConfig: IceConfig): void {
    if (this.disposed) {
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
    this.nextNegotiationEpoch();
    this.ordinaryAnswerEpoch = null;
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

  private enqueueNegotiation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.negotiationTail.then(operation, operation);
    this.negotiationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createOffer(restart: boolean): Promise<boolean> {
    return this.enqueueNegotiation(async () => {
      if (this.disposed) {
        return false;
      }
      return this.createOwnedOffer(restart, this.nextNegotiationEpoch());
    });
  }

  private async createOwnedOffer(
    restart: boolean,
    epoch: number,
  ): Promise<boolean> {
    if (!this.ownsLocalOffer(epoch)) {
      return false;
    }
    try {
      if (restart) {
        this.connection.restartIce();
      }
      const offer = await this.connection.createOffer();
      if (!this.ownsLocalOffer(epoch)) {
        return false;
      }
      await this.connection.setLocalDescription(offer);
      if (
        !this.ownsLocalOffer(epoch) ||
        !this.connection.localDescription
      ) {
        return false;
      }
      this.ordinaryAnswerEpoch = epoch;
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
        throw new Error("服务器暂时离线，等待重新连接");
      }
      this.snapshot = { ...this.snapshot, error: null };
      this.emit();
      return true;
    } catch (error) {
      if (!this.ownsLocalOffer(epoch)) {
        return false;
      }
      if (this.ordinaryAnswerEpoch === epoch) {
        this.ordinaryAnswerEpoch = null;
      }
      this.setError(error, restart ? "恢复连接失败" : "创建连接失败");
      return false;
    }
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await this.connection.addIceCandidate(candidate);
    }
  }

  private async acceptAnswer(
    payload: Extract<SignalPayload, { kind: "description" }>,
  ): Promise<void> {
    const epoch = this.ordinaryAnswerEpoch;
    if (epoch === null || !this.ownsAnswer(epoch)) {
      return;
    }
    try {
      await this.connection.setRemoteDescription(payload.description);
      if (!this.ownsAnswer(epoch)) {
        return;
      }
      await this.flushCandidates();
      await this.enqueueSenderMutation(async () => {
        const videoSender = this.videoSender;
        const audioSender = this.audioSender;
        if (this.disposed || !videoSender || !audioSender) {
          return false;
        }
        return this.configureSender(videoSender, audioSender, {
          profile: this.desiredProfile,
          profileRevision: this.profileRevision,
          video: true,
          audio: false,
        });
      });
      if (this.ownsAnswer(epoch)) {
        this.ordinaryAnswerEpoch = null;
      }
    } catch (error) {
      if (!this.ownsAnswer(epoch)) {
        return;
      }
      this.ordinaryAnswerEpoch = null;
      throw error;
    }
  }

  private ownsAnswer(epoch: number): boolean {
    return (
      !this.disposed &&
      epoch === this.negotiationEpoch &&
      this.ordinaryAnswerEpoch === epoch
    );
  }

  private ownsLocalOffer(epoch: number): boolean {
    return !this.disposed && epoch === this.negotiationEpoch;
  }

  private nextNegotiationEpoch(): number {
    this.ordinaryAnswerEpoch = null;
    this.negotiationEpoch += 1;
    return this.negotiationEpoch;
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
    const captureAudioTrack = this.audioSender?.track ?? null;
    if (
      !captureTrack ||
      this.stream.getVideoTracks()[0] !== captureTrack ||
      (this.stream.getAudioTracks()[0] ?? null) !== captureAudioTrack
    ) {
      return;
    }
    this.statsInFlight = true;
    const statsAccumulator = this.statsAccumulator;
    try {
      const metricsPromise = collectConnectionMetrics(
        this.connection,
        "send",
        statsAccumulator,
        {
          trackIdentifier: captureTrack.id,
          audioTrackIdentifier: captureAudioTrack?.id ?? null,
        },
      );
      const capture = captureMetrics(captureTrack);
      const metrics = { ...(await metricsPromise), ...capture };
      if (
        this.disposed ||
        this.statsSamplingBlocked ||
        this.statsAccumulator !== statsAccumulator ||
        this.videoSender?.track !== captureTrack ||
        this.stream.getVideoTracks()[0] !== captureTrack ||
        (this.audioSender?.track ?? null) !== captureAudioTrack ||
        (this.stream.getAudioTracks()[0] ?? null) !== captureAudioTrack ||
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
          this.combinedSenderWarning() ?? this.persistentLimitationWarning(),
      };
      this.emit();
    } catch {
      // Stats are observational and must never disrupt a healthy media path.
    } finally {
      this.statsInFlight = false;
    }
  }

  private setError(_error: unknown, fallback: string): void {
    this.snapshot = { ...this.snapshot, error: fallback };
    this.emit();
  }

  private async configureSender(
    sender: RTCRtpSender,
    audioSender?: RTCRtpSender,
    mutation: {
      profile: QualityProfile;
      profileRevision: number;
      video: boolean;
      audio: boolean;
    } = {
      profile: this.desiredProfile,
      profileRevision: this.profileRevision,
      video: true,
      audio: true,
    },
  ): Promise<boolean> {
    const { profile, profileRevision } = mutation;
    let senderParameters = this.snapshot.senderParameters ?? null;
    let audioSenderParameters = this.appliedAudioSenderParameters;
    let videoWarning = this.videoSenderWarning;
    let audioWarning = this.audioSenderWarning;
    let videoSucceeded = true;
    let audioSucceeded = true;

    if (mutation.video) {
      try {
        senderParameters = await configureVideoSender(sender, profile);
        videoWarning = senderParameterWarning(senderParameters);
      } catch {
        videoSucceeded = false;
        videoWarning = "应用发送参数失败";
      }
    }

    if (
      this.disposed ||
      profileRevision !== this.profileRevision ||
      (mutation.video && this.videoSender !== sender)
    ) {
      return false;
    }

    if (mutation.audio && audioSender) {
      if (audioSender.track) {
        try {
          audioSenderParameters = await configureScreenAudioSender(
            audioSender,
            profile.screenAudioQuality,
          );
          audioWarning = audioSenderParameterWarning(audioSenderParameters);
        } catch {
          audioSucceeded = false;
          audioWarning = "应用音频发送参数失败";
        }
      } else {
        audioSenderParameters = null;
        audioWarning = null;
      }
    }

    if (
      this.disposed ||
      profileRevision !== this.profileRevision ||
      (mutation.video && this.videoSender !== sender) ||
      (mutation.audio && this.audioSender !== audioSender)
    ) {
      return false;
    }
    this.videoSenderWarning = videoWarning;
    this.audioSenderWarning = audioWarning;
    if (mutation.video && videoSucceeded) {
      this.appliedVideoProfile = profile;
    }
    if (mutation.audio && audioSucceeded) {
      this.appliedAudioQuality = resolveScreenAudioQuality(
        profile.screenAudioQuality,
      );
      this.appliedAudioSenderParameters = audioSenderParameters;
    }
    this.snapshot = {
      ...this.snapshot,
      senderParameters,
      audioSenderParameters: this.appliedAudioSenderParameters,
      qualityWarning:
        this.combinedSenderWarning() ?? this.persistentLimitationWarning(),
    };
    this.emit();
    return videoSucceeded && audioSucceeded;
  }

  private combinedSenderWarning(): string | null {
    const warnings = [
      this.videoSenderWarning,
      this.audioSenderWarning,
    ].filter((warning): warning is string => warning !== null);
    return warnings.length > 0 ? warnings.join("；") : null;
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
          ? "浏览器持续报告未分类的画质限制"
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
