import type { CopyKey } from "../ui/copy";
import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import type { BrowserEncodingPool, BrowserPooledSender } from "../media/browser-encoding-pool";
import { BrowserEncodingOutput, encodedStreams, supportsBrowserEncoding } from "../media/browser-encoding-output";
import { debugError, debugEvent } from "../lib/debug";
import { debugTrack, observeDebugConnection } from "../lib/debug-webrtc";
import {
  applyVideoCaptureProfile,
  cloneSenderVideoTrack,
  configureScreenAudioSender,
  configureVideoSender,
  needsStartupVideoProfile,
  resolveScreenAudioQuality,
  screenAudioQualityEqual,
  STARTUP_VIDEO_ENCODED_FRAMES,
  startupVideoProfile,
  videoQualitySettingsEqual,
  type AudioSenderParameterReadback,
  type QualityProfile,
  type ScreenAudioQuality,
} from "../media/quality";
import { EMPTY_METRICS, type PeerSnapshot } from "../types";
import {
  captureMetrics,
  collectConnectionMetrics,
  createStatsAccumulator,
} from "./stats";
import {
  applyVideoCodecPreference,
  type BrowserVideoCodecPreference,
  VP8_ONLY_VIDEO_CODEC,
} from "./video-codec";
import {
  addRemoteIceCandidate,
  iceServersWithNatPrediction,
  natPredictionSurveyUrls,
  NatPredictionCandidateEmitter,
  type SignalCandidate,
} from "./nat-prediction";

const MAX_PENDING_CANDIDATES = 64;
type PeerIceConfig = Pick<RTCConfiguration, "iceServers"> & {
  natPredictionStunUrls?: readonly string[];
};

export interface HostPeerEvents {
  sendSignal: (peerId: string, payload: SignalPayload) => boolean;
  onUpdate: (snapshot: PeerSnapshot) => void;
}

/** Common lifecycle contract for Browser and native Host direct edges. */
export interface HostMediaPeer {
  readonly peerId: string;
  readonly connectionId: string;
  start(): Promise<boolean>;
  acceptSignal(payload: SignalPayload): Promise<void>;
  restartIce(): Promise<boolean>;
  isConnected(): boolean;
  getSnapshot(): PeerSnapshot;
  updateIceConfig(iceConfig: IceConfig): void;
  updateProfile(profile: QualityProfile): Promise<boolean>;
  updateCaptureProfile(profile: QualityProfile): Promise<boolean>;
  setPaused(paused: boolean): void;
  replaceStream(stream: MediaStream): Promise<boolean>;
  dispose(): void;
}

export class HostPeer {
  readonly connectionId: string;

  private readonly connection: RTCPeerConnection;
  private readonly pendingCandidates: SignalCandidate[] = [];
  private readonly natPredictionEnabled: boolean;
  private readonly localIceCandidates: NatPredictionCandidateEmitter;
  private statsAccumulator = createStatsAccumulator();
  private senderVideoTrack: MediaStreamTrack | null;
  private replacementVideoTrack: MediaStreamTrack | null = null;
  private replacementAudioTrack: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private pooledVideo: BrowserPooledSender | null = null;
  private encodedOutput: BrowserEncodingOutput | null = null;
  private readonly encodedStreamsEnabled: boolean;
  private audioTransceiver: RTCRtpTransceiver | null = null;
  private audioSender: RTCRtpSender | null = null;
  private statsTimer: number | null = null;
  private statsInFlight = false;
  private statsSamplingBlocked = false;
  private appliedVideoProfile: QualityProfile | null = null;
  private appliedAudioQuality: ScreenAudioQuality | null = null;
  private appliedAudioSenderParameters:
    | AudioSenderParameterReadback
    | null = null;
  private disposed = false;
  private profileRevision = 0;
  private negotiationEpoch = 0;
  private ordinaryAnswerEpoch: number | null = null;
  private senderMutationTail: Promise<void> = Promise.resolve();
  private negotiationTail: Promise<void> = Promise.resolve();
  private startupVideoProfilePending: boolean;
  private connectedOnce = false;
  private awaitingReconnect = false;
  private paused = false;
  private snapshot: PeerSnapshot;

  constructor(
    readonly peerId: string,
    iceConfig: PeerIceConfig,
    private stream: MediaStream,
    private desiredProfile: QualityProfile,
    private readonly events: HostPeerEvents,
    private readonly videoCodec: BrowserVideoCodecPreference =
      VP8_ONLY_VIDEO_CODEC,
    connectionId = createOpaqueId(),
    natPredictionEnabled = false,
    private readonly videoPool: BrowserEncodingPool | null = null,
  ) {
    this.connectionId = connectionId;
    this.natPredictionEnabled = natPredictionEnabled;
    const sourceVideoTrack = stream.getVideoTracks()[0] ?? null;
    this.paused = sourceVideoTrack?.enabled === false;
    this.senderVideoTrack = sourceVideoTrack
      ? cloneSenderVideoTrack(sourceVideoTrack)
      : null;
    this.startupVideoProfilePending = needsStartupVideoProfile(desiredProfile);
    this.encodedStreamsEnabled = !!videoPool && supportsBrowserEncoding();
    this.connection = new RTCPeerConnection({
      ...(this.encodedStreamsEnabled ? { encodedInsertableStreams: true } : {}),
      iceServers: iceServersWithNatPrediction(
        iceConfig.iceServers,
        this.natPredictionEnabled,
        iceConfig.natPredictionStunUrls,
      ),
    });
    observeDebugConnection(this.connection, { connectionId, peerId, role: "send" });
    this.localIceCandidates = new NatPredictionCandidateEmitter(
      this.natPredictionEnabled,
      (candidate) => this.sendIceCandidate(candidate),
      natPredictionSurveyUrls(
        iceConfig.iceServers,
        iceConfig.natPredictionStunUrls,
      ),
    );
    this.snapshot = {
      peerId,
      connectionId: this.connectionId,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
      metrics: { ...EMPTY_METRICS },
      error: null,
      senderParameters: null,
      audioSenderParameters: null,
    };
    this.bindConnectionEvents();
  }

  async start(): Promise<boolean> {
    const videoTrack = this.senderVideoTrack;
    if (!videoTrack) {
      this.setError(null, "host.capture.noSource");
      return false;
    }
    const audioTrack = this.stream.getAudioTracks()[0] ?? null;
    const videoTransceiver = this.connection.addTransceiver(videoTrack, {
      direction: "sendonly",
      streams: [this.stream],
    });
    if (!applyVideoCodecPreference(videoTransceiver, this.videoCodec)) {
      this.setError(null, "host.err.codecUnsupported");
      return false;
    }
    this.videoSender = videoTransceiver.sender;
    if (this.encodedStreamsEnabled) {
      this.encodedOutput = new BrowserEncodingOutput(this.videoSender, () => {
        if (!this.disposed) { this.dispose(); this.emit(); }
      }, { connectionId: this.connectionId, peerId: this.peerId });
    }
    this.attachVideoPool(this.stream.getVideoTracks()[0]!);
    this.audioTransceiver = this.connection.addTransceiver(audioTrack ?? "audio", {
      direction: audioTrack ? "sendonly" : "inactive",
      streams: [this.stream],
    });
    this.audioSender = this.audioTransceiver.sender;
    if (this.encodedStreamsEnabled) {
      // The connection flag also owns audio, including a later source with audio.
      const audio = encodedStreams(this.audioSender);
      void audio.readable.pipeTo(audio.writable).catch(() => {
        if (!this.disposed) { this.dispose(); this.emit(); }
      });
    }
    await this.enqueueSenderMutation(async () => {
      if (this.disposed || !this.videoSender || !this.audioSender) {
        return false;
      }
      return this.configureSender(this.videoSender, this.audioSender, {
        profile: startupVideoProfile(this.desiredProfile),
        profileRevision: this.profileRevision,
        video: true,
        audio: true,
      });
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
    const nextSourceVideoTrack = nextStream.getVideoTracks()[0];
    if (this.disposed || !nextSourceVideoTrack) {
      return false;
    }

    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender;
      const audioSender = this.audioSender;
      const audioTransceiver = this.audioTransceiver;
      const previousVideoTrack = this.senderVideoTrack;
      if (
        this.disposed ||
        !videoSender ||
        !audioSender ||
        !audioTransceiver ||
        !previousVideoTrack
      ) {
        return false;
      }

      const nextVideoTrack = cloneSenderVideoTrack(nextSourceVideoTrack);
      let retainedNextVideoTrack = false;
      const nextAudioTrack = nextStream.getAudioTracks()[0] ?? null;
      const nextAudioDirection = nextAudioTrack ? "sendonly" : "inactive";
      const audioDirectionChanged =
        audioTransceiver.direction !== nextAudioDirection;
      const previousAudioDirection = audioTransceiver.direction;
      this.replacementVideoTrack = nextVideoTrack;
      this.replacementAudioTrack = nextAudioTrack;
      this.applyPausedState(nextVideoTrack, nextAudioTrack);
      const previousAudioTrack = audioSender.track;
      this.statsSamplingBlocked = true;
      this.statsAccumulator = createStatsAccumulator();

      try {
        try {
          await videoSender.replaceTrack(nextVideoTrack);
          await audioSender.replaceTrack(nextAudioTrack);
          if (audioDirectionChanged) {
            audioTransceiver.direction = nextAudioDirection;
          }
        } catch (error) {
          const [videoRollback] = await Promise.allSettled([
            videoSender.replaceTrack(previousVideoTrack),
            audioSender.replaceTrack(previousAudioTrack),
          ]);
          if (audioDirectionChanged) {
            audioTransceiver.direction = previousAudioDirection;
          }
          if (videoRollback.status === "rejected") {
            this.dispose();
          }
          this.setError(error, "host.fail.source");
          return false;
        }

        if (this.disposed) {
          return false;
        }
        this.applyPausedState(nextVideoTrack, nextAudioTrack);
        this.senderVideoTrack = nextVideoTrack;
        this.stream = nextStream;
        retainedNextVideoTrack = true;
        this.pooledVideo?.dispose();
        this.pooledVideo = null;
        this.attachVideoPool(nextSourceVideoTrack);
        if (previousVideoTrack !== this.encodedOutput?.track) previousVideoTrack.stop();
        this.startupVideoProfilePending = needsStartupVideoProfile(
          this.desiredProfile,
        );
        this.snapshot = { ...this.snapshot, metrics: { ...EMPTY_METRICS } };
        await this.configureSender(videoSender, audioSender, {
          profile: startupVideoProfile(this.desiredProfile),
          profileRevision: this.profileRevision,
          video: this.connection.connectionState === "connected",
          audio: true,
        });
        this.snapshot = { ...this.snapshot, error: null };
        this.emit();
        return !audioDirectionChanged || (await this.createOffer(false));
      } finally {
        if (!retainedNextVideoTrack) {
          nextVideoTrack.stop();
        }
        if (this.replacementVideoTrack === nextVideoTrack) {
          this.replacementVideoTrack = null;
          this.replacementAudioTrack = null;
        }
        this.statsAccumulator = createStatsAccumulator();
        this.statsSamplingBlocked = false;
      }
    });
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    return this.updateOwnedProfile(profile, false);
  }

  updateCaptureProfile(profile: QualityProfile): Promise<boolean> {
    return this.updateOwnedProfile(profile, true);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.pooledVideo?.setPaused(paused);
    this.applyPausedState(this.senderVideoTrack, this.audioSender?.track ?? null);
    this.applyPausedState(this.replacementVideoTrack, this.replacementAudioTrack);
  }

  private applyPausedState(
    videoTrack: MediaStreamTrack | null,
    audioTrack: MediaStreamTrack | null,
  ): void {
    if (videoTrack) videoTrack.enabled = !this.paused;
    if (audioTrack) audioTrack.enabled = !this.paused;
  }

  private updateOwnedProfile(
    profile: QualityProfile,
    updateCaptureConstraints: boolean,
  ): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    if (!needsStartupVideoProfile(profile)) {
      this.startupVideoProfilePending = false;
    }
    const effectiveVideoProfile = this.startupVideoProfilePending
      ? startupVideoProfile(profile)
      : profile;
    const changed =
      !videoQualitySettingsEqual(this.desiredProfile, profile) ||
      !screenAudioQualityEqual(this.desiredProfile, profile);
    this.desiredProfile = profile;
    // Connection recovery replays the same intent, not a new user mutation.
    const requestedRevision = changed ? ++this.profileRevision : this.profileRevision;
    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender;
      const audioSender = this.audioSender;
      const videoTrack = this.senderVideoTrack;
      if (
        this.disposed ||
        !videoSender ||
        !audioSender ||
        !videoTrack ||
        requestedRevision !== this.profileRevision
      ) {
        return false;
      }
      if (updateCaptureConstraints) {
        await applyVideoCaptureProfile(videoTrack, profile);
        if (
          this.disposed ||
          this.senderVideoTrack !== videoTrack ||
          requestedRevision !== this.profileRevision
        ) {
          return false;
        }
      }
      const updateVideo =
        this.connection.connectionState === "connected" &&
        (this.appliedVideoProfile === null ||
          !videoQualitySettingsEqual(
            this.appliedVideoProfile,
            effectiveVideoProfile,
          ));
      const updateAudio =
        this.appliedAudioQuality !==
          resolveScreenAudioQuality(profile.screenAudioQuality);
      if (!updateVideo && !updateAudio) {
        return true;
      }
      if (
        !(await this.configureSender(videoSender, audioSender, {
          profile: effectiveVideoProfile,
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
        await addRemoteIceCandidate(this.connection, payload.candidate);
      } else if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
        this.pendingCandidates.push(payload.candidate);
      }
    } catch (error) {
      this.setError(error, "host.err.createConnection");
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
        iceServers: iceServersWithNatPrediction(
          iceConfig.iceServers,
          this.natPredictionEnabled,
          iceConfig.natPredictionStunUrls,
        ),
      });
      this.localIceCandidates.setSurveyUrls(
        natPredictionSurveyUrls(
          iceConfig.iceServers,
          iceConfig.natPredictionStunUrls,
        ),
      );
    } catch (error) {
      this.setError(error, "host.err.createConnection");
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
    this.pooledVideo?.dispose();
    this.pooledVideo = null;
    this.encodedOutput?.dispose();
    this.encodedOutput = null;
    this.localIceCandidates.discard();
    this.senderVideoTrack?.stop();
    this.senderVideoTrack = null;
    this.audioTransceiver = null;
  }

  private bindConnectionEvents(): void {
    this.connection.addEventListener("icecandidate", (event) => {
      this.localIceCandidates.add(event.candidate);
    });
    this.connection.addEventListener("icegatheringstatechange", () => {
      if (
        this.natPredictionEnabled &&
        this.connection.iceGatheringState === "complete"
      ) {
        this.localIceCandidates.gatheringComplete();
      }
    });
    this.connection.addEventListener("connectionstatechange", () => {
      const state = this.connection.connectionState;
      if (state === "connected") {
        const replayProfile = this.awaitingReconnect;
        this.connectedOnce = true;
        this.awaitingReconnect = false;
        if (replayProfile) {
          this.appliedVideoProfile = null;
          this.appliedAudioQuality = null;
          this.appliedAudioSenderParameters = null;
        }
        if (replayProfile || !this.startupVideoProfilePending) {
          void this.updateProfile(this.desiredProfile);
        }
      } else if (this.connectedOnce && state !== "closed") {
        this.awaitingReconnect = true;
      }
      this.emit();
    });
    this.connection.addEventListener("iceconnectionstatechange", () => this.emit());
  }

  private attachVideoPool(source: MediaStreamTrack): void {
    const sender = this.videoSender;
    if (!sender || !this.videoPool || !this.encodedOutput) return;
    let binding: BrowserPooledSender | null = null;
    const owns = () => !this.disposed && this.pooledVideo === binding &&
      this.videoSender === sender && this.stream.getVideoTracks()[0] === source;
    const requestKey = () => this.enqueueSenderMutation(async () => {
      if (!owns()) return;
      const request = sender.setParameters as (parameters: RTCRtpSendParameters,
        options: { encodingOptions: Array<{ keyFrame: boolean }> }) => Promise<void>;
      await request.call(sender, sender.getParameters(), { encodingOptions: [{ keyFrame: true }] });
    });
    binding = this.videoPool.create(source, sender, this.connection, this.desiredProfile, this.encodedOutput,
      () => this.enqueueSenderMutation(async () => {
        if (!owns()) return false;
        const previous = this.senderVideoTrack!;
        const next = binding?.carrierScale() === undefined ? cloneSenderVideoTrack(source) : this.encodedOutput!.track;
        try {
          this.applyPausedState(next, null);
          await applyVideoCaptureProfile(next, this.desiredProfile);
          if (!owns()) { if (next !== this.encodedOutput?.track) next.stop(); return false; }
          if (next !== previous) await sender.replaceTrack(next);
          await configureVideoSender(sender,
            this.startupVideoProfilePending ? startupVideoProfile(this.desiredProfile) : this.desiredProfile,
            binding?.carrierScale());
          if (!owns()) throw new DOMException("Retired Browser pool binding", "AbortError");
          this.senderVideoTrack = next;
          if (previous !== next && previous !== this.encodedOutput?.track) previous.stop();
          this.statsAccumulator = createStatsAccumulator();
          return true;
        } catch (error) {
          if (!this.disposed && sender.track !== previous) {
            try { await sender.replaceTrack(previous); } catch { this.dispose(); }
          }
          if (next !== previous && next !== this.encodedOutput?.track) next.stop();
          debugError("encoding-pool", "carrier-attachment-failed", error, { connectionId: this.connectionId });
          return false;
        }
      }),
      requestKey,
      () => { if (owns()) { this.dispose(); this.emit(); } });
    this.pooledVideo = binding;
    if (!binding) this.encodedOutput.passthrough(requestKey);
    binding?.setPaused(this.paused);
  }

  private sendIceCandidate(candidate: SignalCandidate | null): void {
    this.events.sendSignal(this.peerId, {
      kind: "candidate",
      connectionId: this.connectionId,
      candidate,
    });
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
        throw new Error("signal send rejected");
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
      this.setError(error, "host.err.createConnection");
      return false;
    }
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await addRemoteIceCandidate(this.connection, candidate);
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
    const captureTrack = this.senderVideoTrack;
    const captureAudioTrack = this.audioSender?.track ?? null;
    if (
      !captureTrack ||
      this.videoSender?.track !== captureTrack ||
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
      debugTrack(captureTrack, { connectionId: this.connectionId, event: "sample" });
      const metrics = { ...(await metricsPromise), ...capture };
      if (
        this.disposed ||
        this.statsSamplingBlocked ||
        this.statsAccumulator !== statsAccumulator ||
        this.senderVideoTrack !== captureTrack ||
        this.videoSender?.track !== captureTrack ||
        (this.audioSender?.track ?? null) !== captureAudioTrack ||
        (this.stream.getAudioTracks()[0] ?? null) !== captureAudioTrack ||
        (metrics.trackIdentifier !== null &&
          metrics.trackIdentifier !== captureTrack.id)
      ) {
        return;
      }
      if (
        this.startupVideoProfilePending &&
        (statsAccumulator.frames ?? 0) >= STARTUP_VIDEO_ENCODED_FRAMES
      ) {
        this.startupVideoProfilePending = false;
        void this.updateProfile(this.desiredProfile);
      }
      const deliveredMetrics = this.pooledVideo?.metrics(metrics) ?? metrics;
      this.snapshot = { ...this.snapshot, metrics: deliveredMetrics };
      this.emit();
    } catch {
      // Stats are observational and must never disrupt a healthy media path.
    } finally {
      this.statsInFlight = false;
    }
  }

  private setError(error: unknown, key: CopyKey): void {
    debugError("webrtc", "sender-failed", error, { connectionId: this.connectionId, reason: key });
    this.snapshot = { ...this.snapshot, error: { key } };
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
    let videoSucceeded = true;
    let audioSucceeded = true;

    if (mutation.video) {
      try {
        senderParameters = await configureVideoSender(sender, profile, this.pooledVideo?.carrierScale());
      } catch (error) {
        videoSucceeded = false;
        debugError("webrtc", "sender-parameters-failed", error, { connectionId: this.connectionId, profileRevision, requested: profile });
      }
    }

    if (
      this.disposed ||
      profileRevision !== this.profileRevision ||
      (mutation.video && this.videoSender !== sender)
    ) {
      return false;
    }

    if (mutation.video && videoSucceeded && this.pooledVideo) {
      try { await this.pooledVideo.updateProfile(this.desiredProfile); }
      catch { videoSucceeded = false; }
    }

    if (mutation.audio && audioSender) {
      if (audioSender.track) {
        try {
          audioSenderParameters = await configureScreenAudioSender(
            audioSender,
            profile.screenAudioQuality,
          );
        } catch (error) {
          audioSucceeded = false;
          debugError("webrtc", "audio-parameters-failed", error, { connectionId: this.connectionId, profileRevision });
        }
      } else {
        audioSenderParameters = null;
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
    debugEvent("webrtc", "sender-parameters", { connectionId: this.connectionId, profileRevision,
      requested: profile, videoSucceeded, audioSucceeded, senderParameters, audioSenderParameters });
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
    };
    this.emit();
    return videoSucceeded && audioSucceeded;
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
