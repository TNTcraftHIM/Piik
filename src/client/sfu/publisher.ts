import type { SfuMedia, SfuSignalMessage } from "../../shared/protocol";
import type { MediaFailure } from "../ui/media-failure";
import { debugError } from "../lib/debug";
import { debugRtcFailure, debugRtcStats, debugTrack } from "../lib/debug-webrtc";
import {
  audioSenderParameterWarning,
  applyVideoCaptureProfile,
  cloneSenderVideoTrack,
  configureScreenAudioSender,
  configureVideoSender,
  needsStartupVideoProfile,
  QUALITY_RESOLUTIONS,
  screenAudioBitrate,
  senderParameterWarning,
  STARTUP_VIDEO_ENCODED_FRAMES,
  startupVideoProfile,
  videoQualitySettingsEqual,
  type QualityProfile,
  type VideoSenderParameterReadback,
} from "../media/quality";
import type { ConnectionMetrics } from "../types";
import {
  applyVideoCodecPreference,
  manualVideoCodecPreference,
  type BrowserVideoCodec,
} from "../webrtc/video-codec";
import {
  captureMetrics,
  collectConnectionMetricsFromReport,
  collectNativeSenderQualityFromReport,
  createNativeSenderQualityAccumulator,
  createStatsAccumulator,
  highestActiveVideoRid,
  maxEncodedVideoFrames,
} from "../webrtc/stats";
import { SfuPeer, type SfuConnectionConfig } from "./peer";

export type { SfuConnectionConfig } from "./peer";

interface PublisherEvents {
  send: (message: SfuSignalMessage) => boolean;
  onDisconnected?: () => void;
  onStats?: (metrics: ConnectionMetrics | null) => void;
}

export type SfuPublisherFailureStage =
  | "connect"
  | "source"
  | "video-publish"
  | "sender-config"
  | "audio-publish"
  | "transport";

export class SfuPublisher {
  private peer: SfuPeer | null = null;
  private video: MediaStreamTrack | null = null;
  private audio: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private profile: QualityProfile | null = null;
  private codec: BrowserVideoCodec = "vp8";
  private layerCount = 2;
  private activeCount = 2;
  private paused = false;
  private closed = false;
  private readonly ownedTracks = new Set<MediaStreamTrack>();
  private startupPending = false;
  // RTP frame counts can survive replaceTrack; 0 suits a fresh sender, while
  // a replacement needs a valid current-track sample to establish its baseline.
  private startupFramesBaseline: number | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private failureStage: SfuPublisherFailureStage | null = null;
  private senderParameters: VideoSenderParameterReadback | null = null;
  private videoWarning: MediaFailure | null = null;
  private audioWarning: MediaFailure | null = null;
  private stats = createStatsAccumulator();
  private nativeStats = createNativeSenderQualityAccumulator();
  private statsInFlight: typeof this.stats | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly events: PublisherEvents) {}

  async connect(config: SfuConnectionConfig): Promise<boolean> {
    if (this.peer || this.closed)
      throw new Error("SFU publisher cannot be connected twice");
    this.peer = new SfuPeer(config, {
      send: this.events.send,
      onState: (state) => {
        if (state === "failed") this.fail("transport");
        else if (state === "disconnected") void this.restartIce();
      },
    });
    return true;
  }

  updateConfig(config: SfuConnectionConfig): void {
    this.peer?.updateConfig(config);
  }

  async acceptSignal(message: SfuSignalMessage): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    try {
      await peer.acceptSignal(
        message,
        async (description) => {
          if (description.type !== "answer")
            throw new Error("SFU publisher expected an answer");
          await peer.pc.setRemoteDescription(description);
        },
        async (activeCount) => {
          await this.enqueue(async () => {
            const sender = this.videoSender;
            if (this.peer !== peer || !sender) return false;
            if (activeCount > this.layerCount)
              throw new Error("SFU requested an unavailable encoding");
            this.activeCount = activeCount;
            const parameters = sender.getParameters();
            parameters.encodings.forEach((encoding, index) => {
              encoding.active = index < activeCount;
            });
            await sender.setParameters(parameters);
            return this.peer === peer;
          });
        },
      );
    } catch {
      if (this.peer === peer) this.fail("transport");
    }
  }

  activate(
    stream: MediaStream,
    profile: QualityProfile,
    codec: BrowserVideoCodec = "vp8",
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const peer = this.peer;
      if (!peer || this.video) return false;
      this.profile = profile;
      this.codec = codec;
      this.startupPending = needsStartupVideoProfile(profile);
      this.startupFramesBaseline = 0;
      let video: MediaStreamTrack | null = null;
      try {
        this.failureStage = "source";
        video = this.ownTrack(cloneSenderVideoTrack(requiredVideo(stream)));
        await applyVideoCaptureProfile(video, profile);
        if (this.peer !== peer) {
          this.releaseTrack(video);
          return false;
        }
        this.video = video;
        this.audio = this.ownTrack(stream.getAudioTracks()[0]?.clone() ?? null);
        this.setPaused(this.paused);
        const dimensions = video.getSettings();
        this.layerCount =
          Math.max(dimensions.width ?? 0, dimensions.height ?? 0) >= 480
            ? 2
            : 1;
        const videoTransceiver = peer.pc.addTransceiver(video, {
          direction: "sendonly",
          streams: [stream],
          sendEncodings: this.encodings(profile),
        });
        this.failureStage = "video-publish";
        if (
          !applyVideoCodecPreference(
            videoTransceiver,
            manualVideoCodecPreference(codec),
          )
        ) {
          throw new Error("SFU video codec is unavailable");
        }
        this.videoSender = videoTransceiver.sender;
        const audioTransceiver = peer.pc.addTransceiver(this.audio ?? "audio", {
          direction: "sendonly",
          streams: [stream],
          sendEncodings: [
            { maxBitrate: screenAudioBitrate(profile.screenAudioQuality) },
          ],
        });
        const opus = RTCRtpSender.getCapabilities("audio")?.codecs.filter(
          ({ mimeType }) => mimeType.toLowerCase() === "audio/opus",
        );
        if (!opus?.length) throw new Error("SFU Opus codec is unavailable");
        audioTransceiver.setCodecPreferences(opus);
        this.audioSender = audioTransceiver.sender;
        this.failureStage = "sender-config";
        await this.configure(profile);
        if (this.peer !== peer) return false;
        await peer.sendDescription(
          await peer.pc.createOffer(),
          this.media(profile),
        );
        if (this.peer !== peer) return false;
        this.failureStage = null;
        this.startStats();
        return true;
      } catch (error) {
        debugError("webrtc", "sfu-activate-failed", error, {
          stage: this.failureStage ?? "connect",
        });
        if (video && this.video !== video) this.releaseTrack(video);
        if (this.peer === peer) this.fail(this.failureStage ?? "connect");
        throw error;
      }
    });
  }

  async deactivate(): Promise<boolean> {
    await this.disconnect();
    return true;
  }

  replaceStream(stream: MediaStream): Promise<boolean> {
    return this.enqueue(async () => {
      const peer = this.peer;
      const profile = this.profile;
      const previousVideo = this.video;
      const previousAudio = this.audio;
      const videoSender = this.videoSender;
      const audioSender = this.audioSender;
      if (!peer || !profile || !previousVideo || !videoSender || !audioSender)
        return false;
      const nextVideo = this.ownTrack(
        cloneSenderVideoTrack(requiredVideo(stream)),
      );
      const nextAudio = this.ownTrack(
        stream.getAudioTracks()[0]?.clone() ?? null,
      );
      let retained = false;
      this.resetStats();
      try {
        await applyVideoCaptureProfile(nextVideo, profile);
        if (this.peer !== peer) return false;
        nextVideo.enabled = !this.paused;
        if (nextAudio) {
          nextAudio.enabled = !this.paused;
          nextAudio.contentHint = "music";
        }
        await videoSender.replaceTrack(nextVideo);
        await audioSender.replaceTrack(nextAudio);
        if (this.peer !== peer) return false;
        this.video = nextVideo;
        this.audio = nextAudio;
        this.startupPending = needsStartupVideoProfile(profile);
        this.startupFramesBaseline = null;
        await this.configure(profile);
        if (this.peer !== peer) return false;
        if (!peer.send({ kind: "media", media: this.media(profile) }))
          throw new Error("SFU signaling is unavailable");
        retained = true;
        this.releaseTrack(previousVideo);
        this.releaseTrack(previousAudio);
        this.setPaused(this.paused);
        return true;
      } catch (error) {
        debugError("webrtc", "sfu-source-failed", error);
        if (this.peer !== peer) return false;
        this.video = previousVideo;
        this.audio = previousAudio;
        try {
          await videoSender.replaceTrack(previousVideo);
          await audioSender.replaceTrack(previousAudio);
          await this.configure(profile);
          this.videoWarning = { key: "host.fail.sfuSwitch" };
          return false;
        } catch {
          this.fail("source");
          return false;
        }
      } finally {
        if (!retained) {
          this.releaseTrack(nextVideo);
          this.releaseTrack(nextAudio);
        }
      }
    });
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    return this.enqueue(() => this.applyProfile(profile));
  }

  private async applyProfile(profile: QualityProfile): Promise<boolean> {
    const peer = this.peer;
    const video = this.video;
    const previous = this.profile;
    if (!peer || !video || !previous) return false;
    if (!needsStartupVideoProfile(profile)) this.startupPending = false;
    const videoChanged = !videoQualitySettingsEqual(previous, profile);
    const configureVideo =
      videoChanged ||
      this.senderParameters?.applied.degradationPreference !==
        (this.startupPending ? startupVideoProfile(profile) : profile)
          .degradationPreference;
    if (configureVideo) this.resetStats();
    try {
      if (videoChanged) await applyVideoCaptureProfile(video, profile);
      const result = await this.configure(profile, configureVideo);
      if (this.peer !== peer) return false;
      if (!peer.send({ kind: "media", media: this.media(profile) }))
        throw new Error("SFU signaling is unavailable");
      this.profile = profile;
      return result;
    } catch (error) {
      debugError("webrtc", "sfu-profile-failed", error, { requested: profile });
      if (this.peer !== peer) return false;
      try {
        if (videoChanged) await applyVideoCaptureProfile(video, previous);
        await this.configure(previous, configureVideo);
        this.videoWarning = { key: "host.fail.sfuParams" };
        return false;
      } catch {
        this.fail("sender-config");
        return false;
      }
    }
  }

  getQualityWarning(): MediaFailure[] | null {
    const warnings = [this.videoWarning, this.audioWarning].filter(
      (warning): warning is MediaFailure => warning !== null,
    );
    return warnings.length > 0 ? warnings : null;
  }
  getFailureStage(): SfuPublisherFailureStage | null {
    return this.failureStage;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const track of this.ownedTracks) {
      track.enabled = !paused;
      if (track.kind === "audio") track.contentHint = "music";
    }
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    peer?.close();
    for (const track of this.ownedTracks) this.releaseTrack(track);
    this.video = null;
    this.audio = null;
    this.videoSender = null;
    this.audioSender = null;
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.resetStats();
  }

  private fail(stage: SfuPublisherFailureStage): void {
    if (this.closed) return;
    this.failureStage = stage;
    void this.disconnect();
    this.events.onDisconnected?.();
  }

  private ownTrack<T extends MediaStreamTrack | null>(track: T): T {
    if (track) this.ownedTracks.add(track);
    return track;
  }

  private releaseTrack(track: MediaStreamTrack | null): void {
    if (track && this.ownedTracks.delete(track)) track.stop();
  }

  private restartIce(): Promise<boolean> {
    return this.enqueue(async () => {
      const peer = this.peer;
      if (!peer || !this.profile || peer.pc.signalingState !== "stable")
        return false;
      try {
        await peer.sendDescription(
          await peer.pc.createOffer({ iceRestart: true }),
          this.media(this.profile),
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  private enqueue(work: () => Promise<boolean>): Promise<boolean> {
    const next = this.operationTail.then(work, work);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private encodings(profile: QualityProfile): RTCRtpEncodingParameters[] {
    const settings = this.video?.getSettings();
    const ceiling = QUALITY_RESOLUTIONS[profile.resolution];
    const width = settings?.width ?? ceiling.width;
    const height = settings?.height ?? ceiling.height;
    const scale = Math.max(1, width / ceiling.width, height / ceiling.height);
    // LiveKit 2.22.1 publishUtils: screen share uses half size, same FPS,
    // and quarter bitrate with a 150 kbps floor. WebRTC budgets the entire PC.
    const high = {
      rid: this.layerCount === 2 ? "h" : "q",
      active: this.activeCount >= this.layerCount,
      scaleResolutionDownBy: scale,
      maxBitrate: profile.maxBitrate,
      maxFramerate: profile.maxFramerate,
    };
    return this.layerCount === 2
      ? [
          {
            rid: "q",
            active: this.activeCount > 0,
            scaleResolutionDownBy: 2 * scale,
            maxBitrate: Math.max(150_000, Math.floor(profile.maxBitrate / 4)),
            maxFramerate: profile.maxFramerate,
          },
          high,
        ]
      : [high];
  }

  private media(profile: QualityProfile): SfuMedia {
    const settings = this.video!.getSettings();
    const ceiling = QUALITY_RESOLUTIONS[profile.resolution];
    return {
      codec: this.codec,
      layers: this.encodings(profile).map((encoding) => ({
        rid: encoding.rid!,
        width: Math.max(
          1,
          Math.floor(
            (settings.width ?? ceiling.width) / encoding.scaleResolutionDownBy!,
          ),
        ),
        height: Math.max(
          1,
          Math.floor(
            (settings.height ?? ceiling.height) /
              encoding.scaleResolutionDownBy!,
          ),
        ),
        bitrate: encoding.maxBitrate!,
      })),
      audio: this.audio !== null,
      audioBitrate: screenAudioBitrate(profile.screenAudioQuality),
    };
  }

  private async configure(
    profile: QualityProfile,
    configureVideo = true,
  ): Promise<boolean> {
    const peer = this.peer;
    const sender = this.videoSender;
    if (!peer || !sender) return false;
    if (configureVideo) {
      const parameters = sender.getParameters();
      const encodings = this.encodings(profile);
      parameters.encodings.forEach((encoding, index) =>
        Object.assign(encoding, encodings[index]),
      );
      await sender.setParameters(parameters);
      if (this.peer !== peer) return false;
      const readback = await configureVideoSender(
        sender,
        this.startupPending ? startupVideoProfile(profile) : profile,
      );
      if (this.peer !== peer) return false;
      this.senderParameters = readback;
      this.videoWarning = senderParameterWarning(readback);
    }
    if (!this.audio || !this.audioSender) {
      this.audioWarning = null;
      return true;
    }
    try {
      const audio = await configureScreenAudioSender(
        this.audioSender,
        profile.screenAudioQuality,
      );
      if (this.peer !== peer) return false;
      this.audioWarning = audioSenderParameterWarning(audio);
      return true;
    } catch {
      this.audioWarning = { key: "host.fail.sfuAudioParams" };
      return false;
    }
  }

  private startStats(): void {
    this.resetStats();
    this.statsTimer = setInterval(() => void this.updateStats(), 2_000);
  }

  private resetStats(): void {
    this.stats = createStatsAccumulator();
    this.nativeStats = createNativeSenderQualityAccumulator();
    this.statsInFlight = null;
    this.events.onStats?.(null);
  }

  private async updateStats(): Promise<void> {
    const peer = this.peer;
    const video = this.video;
    const sender = this.videoSender;
    const stats = this.stats;
    const nativeStats = this.nativeStats;
    if (!peer || !video || !sender || this.statsInFlight === stats) return;
    this.statsInFlight = stats;
    try {
      const report = await peer.pc.getStats();
      debugRtcStats(peer.pc, report);
      debugTrack(video, { event: "sfu-sample" });
      if (this.peer !== peer || this.video !== video || this.stats !== stats)
        return;
      const native = collectNativeSenderQualityFromReport(
        report,
        video.id,
        nativeStats,
      );
      const connection = collectConnectionMetricsFromReport(
        report,
        "send",
        stats,
        {
          trackIdentifier: video.id,
          rid: highestActiveVideoRid(report, video.id),
          audioTrackIdentifier: this.audio?.id ?? null,
        },
      );
      const encodings = sender.getParameters().encodings;
      this.events.onStats?.({
        ...connection,
        ...captureMetrics(video),
        videoEncodingCount: encodings.length,
        activeVideoEncodingCount: encodings.filter(
          (encoding) => encoding.active !== false,
        ).length,
        bitrateKbps: native.bitrateKbps ?? connection.bitrateKbps,
        nativeEdgeQualityState: native.nativeEdgeQualityState,
        ...(native.nativeEdgeQualityState === "unknown"
          ? {}
          : {
              qualityLimitationReason: native.qualityLimitationReason,
              sampleTimestampMs: native.sampleTimestampMs,
              sampleWindowMs: native.sampleWindowMs,
              intervalFramesEncoded: native.intervalFramesEncoded,
            }),
      });
      if (this.startupPending) {
        const encodedFrames = maxEncodedVideoFrames(report, video.id);
        if (encodedFrames === null) return;
        if (this.startupFramesBaseline === null) {
          this.startupFramesBaseline = encodedFrames;
        } else if (
          encodedFrames - this.startupFramesBaseline >=
          STARTUP_VIDEO_ENCODED_FRAMES
        ) {
          this.startupPending = false;
          // Re-read at execution: an in-flight user update commits this.profile
          // first, so the recovery must not replay a stats-time snapshot.
          void this.enqueue(async () => {
            const profile = this.profile;
            return profile ? this.applyProfile(profile) : false;
          });
        }
      }
    } catch (error) {
      debugRtcFailure(peer.pc, error);
    } finally {
      if (this.statsInFlight === stats) this.statsInFlight = null;
    }
  }
}

function requiredVideo(stream: MediaStream): MediaStreamTrack {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended")
    throw new Error("SFU source has no live video track");
  return track;
}
