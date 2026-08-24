import type {
  CodecTransitionGeneration,
  IceConfig,
  SignalPayload,
} from "../../shared/protocol";
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

interface CodecPreparationRequest {
  generation: CodecTransitionGeneration;
  videoCodec: QualityProfile["videoCodec"];
  negotiationEpoch: number;
  promise: Promise<boolean>;
  resolve: (accepted: boolean) => void;
  settled: boolean;
}

interface CodecAnswerWaiter {
  request: CodecPreparationRequest;
  epoch: number;
  resolve: (accepted: boolean) => void;
}

type NegotiationAnswerOwner =
  | {
      kind: "ordinary";
      epoch: number;
    }
  | {
      kind: "codec";
      epoch: number;
      waiter: CodecAnswerWaiter;
    };

export class HostPeer {
  readonly connectionId: string;

  private readonly connection: RTCPeerConnection;
  private readonly pendingCandidates: SignalCandidate[] = [];
  private statsAccumulator = createStatsAccumulator();
  private videoTransceiver: RTCRtpTransceiver | null = null;
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
  private codecPreparation: CodecPreparationRequest | null = null;
  private codecAnswerWaiter: CodecAnswerWaiter | null = null;
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
    if (this.desiredProfile.videoCodec !== "automatic") {
      applyVideoCodecPreference(
        videoTransceiver,
        this.desiredProfile.videoCodec,
      );
    }
    this.videoTransceiver = videoTransceiver;
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

  prepareVideoCodec(
    generation: CodecTransitionGeneration,
    videoCodec: QualityProfile["videoCodec"],
  ): Promise<boolean> {
    const current = this.codecPreparation;
    if (
      current?.generation === generation &&
      current.videoCodec === videoCodec
    ) {
      return current.promise;
    }
    if (current) {
      this.finishCodecPreparation(current, false);
    }

    let resolve!: (accepted: boolean) => void;
    const promise = new Promise<boolean>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const request: CodecPreparationRequest = {
      generation,
      videoCodec,
      negotiationEpoch: this.nextNegotiationEpoch(),
      promise,
      resolve,
      settled: false,
    };
    this.codecPreparation = request;
    void this.enqueueSenderMutation(() =>
      this.runCodecPreparation(request),
    ).then(
      (accepted) => this.finishCodecPreparation(request, accepted),
      () => this.finishCodecPreparation(request, false),
    );
    return promise;
  }

  cancelVideoCodecPreparation(): void {
    const request = this.codecPreparation;
    if (!request) {
      return;
    }
    this.finishCodecPreparation(request, false);
    if (this.disposed) {
      return;
    }
    const epoch = this.nextNegotiationEpoch();
    void this.enqueueNegotiation(async () => {
      if (
        this.disposed ||
        epoch !== this.negotiationEpoch ||
        this.codecPreparation
      ) {
        return;
      }
      await this.rollbackPendingLocalOffer();
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
      this.setError(error, "处理观看端信令失败");
    }
  }

  async restartIce(): Promise<boolean> {
    while (!this.disposed) {
      const codecPreparation = this.codecPreparation;
      if (codecPreparation) {
        await codecPreparation.promise;
        continue;
      }
      const restarted = await this.enqueueNegotiation(async () => {
        if (this.disposed) {
          return false;
        }
        if (this.codecPreparation) {
          return null;
        }
        if (this.connection.signalingState !== "stable") {
          return false;
        }
        const accepted = await this.createOwnedOffer(
          true,
          this.nextNegotiationEpoch(),
          null,
        );
        return !accepted && this.codecPreparation ? null : accepted;
      });
      if (restarted !== null) {
        return restarted;
      }
    }
    return false;
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
    this.cancelVideoCodecPreparation();
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
      if (this.disposed || this.codecPreparation) {
        return false;
      }
      return this.createOwnedOffer(
        restart,
        this.nextNegotiationEpoch(),
        null,
      );
    });
  }

  private async createOwnedOffer(
    restart: boolean,
    epoch: number,
    negotiationGeneration: CodecTransitionGeneration | null,
    request: CodecPreparationRequest | null = null,
  ): Promise<boolean> {
    if (!this.ownsLocalOffer(epoch, request)) {
      return false;
    }
    try {
      if (restart) {
        this.connection.restartIce();
      }
      const offer = await this.connection.createOffer();
      if (!this.ownsLocalOffer(epoch, request)) {
        return false;
      }
      await this.connection.setLocalDescription(offer);
      if (
        !this.ownsLocalOffer(epoch, request) ||
        !this.connection.localDescription
      ) {
        return false;
      }
      if (negotiationGeneration === null) {
        this.ordinaryAnswerEpoch = epoch;
      }
      if (
        !this.events.sendSignal(this.peerId, {
          kind: "description",
          connectionId: this.connectionId,
          negotiationGeneration,
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
      if (!this.ownsLocalOffer(epoch, request)) {
        return false;
      }
      if (
        negotiationGeneration === null &&
        this.ordinaryAnswerEpoch === epoch
      ) {
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
    const owner = this.currentAnswerOwner(payload.negotiationGeneration);
    if (!owner) {
      return;
    }
    try {
      await this.connection.setRemoteDescription(payload.description);
      if (!this.ownsAnswer(owner)) {
        return;
      }
      await this.flushCandidates();
      if (this.ownsAnswer(owner)) {
        this.completeAnswer(owner, true);
      }
    } catch (error) {
      if (!this.ownsAnswer(owner)) {
        return;
      }
      this.completeAnswer(owner, false);
      throw error;
    }
  }

  private currentAnswerOwner(
    generation: CodecTransitionGeneration | null,
  ): NegotiationAnswerOwner | null {
    if (generation === null) {
      const epoch = this.ordinaryAnswerEpoch;
      return epoch !== null && epoch === this.negotiationEpoch
        ? { kind: "ordinary", epoch }
        : null;
    }
    const waiter = this.codecAnswerWaiter;
    return waiter &&
      waiter.epoch === this.negotiationEpoch &&
      waiter.request.generation === generation &&
      this.ownsCodecPreparation(waiter.request)
      ? { kind: "codec", epoch: waiter.epoch, waiter }
      : null;
  }

  private ownsAnswer(owner: NegotiationAnswerOwner): boolean {
    if (this.disposed || owner.epoch !== this.negotiationEpoch) {
      return false;
    }
    return owner.kind === "ordinary"
      ? this.ordinaryAnswerEpoch === owner.epoch
      : this.codecAnswerWaiter === owner.waiter &&
          this.ownsCodecPreparation(owner.waiter.request);
  }

  private completeAnswer(
    owner: NegotiationAnswerOwner,
    accepted: boolean,
  ): void {
    if (!this.ownsAnswer(owner)) {
      return;
    }
    if (owner.kind === "ordinary") {
      this.ordinaryAnswerEpoch = null;
      return;
    }
    this.codecAnswerWaiter = null;
    owner.waiter.resolve(accepted);
  }

  private settleCodecAnswer(
    accepted: boolean,
    generation?: CodecTransitionGeneration,
    epoch?: number,
  ): void {
    const waiter = this.codecAnswerWaiter;
    if (
      (generation !== undefined &&
        waiter?.request.generation !== generation) ||
      (epoch !== undefined && waiter?.epoch !== epoch)
    ) {
      return;
    }
    this.codecAnswerWaiter = null;
    waiter?.resolve(accepted);
  }

  private async runCodecPreparation(
    request: CodecPreparationRequest,
  ): Promise<boolean> {
    const negotiation = await this.enqueueNegotiation(async () => {
      const transceiver = this.videoTransceiver;
      if (
        !this.ownsCodecPreparation(request) ||
        request.negotiationEpoch !== this.negotiationEpoch ||
        !transceiver ||
        !(await this.rollbackPendingLocalOffer()) ||
        !this.ownsCodecPreparation(request) ||
        request.negotiationEpoch !== this.negotiationEpoch ||
        !applyVideoCodecPreference(transceiver, request.videoCodec)
      ) {
        return null;
      }
      const answer = new Promise<boolean>((resolve) => {
        this.codecAnswerWaiter = {
          request,
          epoch: request.negotiationEpoch,
          resolve,
        };
      });
      if (
        !(await this.createOwnedOffer(
          false,
          request.negotiationEpoch,
          request.generation,
          request,
        ))
      ) {
        this.settleCodecAnswer(
          false,
          request.generation,
          request.negotiationEpoch,
        );
        return null;
      }
      return { answer };
    });
    if (!negotiation) {
      return false;
    }
    const accepted = await negotiation.answer;
    if (!accepted || !this.ownsCodecPreparation(request)) {
      return false;
    }
    this.desiredProfile = {
      ...this.desiredProfile,
      videoCodec: request.videoCodec,
    };
    this.appliedVideoProfile = this.appliedVideoProfile
      ? { ...this.appliedVideoProfile, videoCodec: request.videoCodec }
      : { ...this.desiredProfile };
    return true;
  }

  private ownsLocalOffer(
    epoch: number,
    request: CodecPreparationRequest | null,
  ): boolean {
    return (
      !this.disposed &&
      epoch === this.negotiationEpoch &&
      (request === null ||
        (request.negotiationEpoch === epoch &&
          this.ownsCodecPreparation(request)))
    );
  }

  private nextNegotiationEpoch(): number {
    this.ordinaryAnswerEpoch = null;
    this.negotiationEpoch += 1;
    return this.negotiationEpoch;
  }

  private ownsCodecPreparation(request: CodecPreparationRequest): boolean {
    return (
      !this.disposed &&
      !request.settled &&
      this.codecPreparation === request
    );
  }

  private finishCodecPreparation(
    request: CodecPreparationRequest,
    accepted: boolean,
  ): void {
    if (request.settled) {
      return;
    }
    request.settled = true;
    if (this.codecAnswerWaiter?.request === request) {
      const waiter = this.codecAnswerWaiter;
      this.codecAnswerWaiter = null;
      waiter.resolve(false);
    }
    if (this.codecPreparation === request) {
      this.codecPreparation = null;
    }
    request.resolve(accepted);
  }

  private async rollbackPendingLocalOffer(): Promise<boolean> {
    if (this.connection.signalingState === "stable") {
      return true;
    }
    if (this.connection.signalingState !== "have-local-offer") {
      return false;
    }
    try {
      await this.connection.setLocalDescription({ type: "rollback" });
      return (this.connection.signalingState as RTCSignalingState) === "stable";
    } catch {
      return false;
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
