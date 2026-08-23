import type {
  LocalTrackPublication,
  Room,
  Track,
  TrackPublishOptions,
} from "livekit-client";

import {
  configureTwoLayerVideoSender,
  QUALITY_RESOLUTIONS,
  resolveScreenAudioQuality,
  SCREEN_SHARE_LOW_SCALE,
  screenAudioBitrate,
  screenShareLowBitrate,
  senderParameterWarning,
  type QualityProfile,
  type ScreenAudioQuality,
  type VideoSenderParameterReadback,
} from "../media/quality";
import type { ConnectionMetrics } from "../types";
import {
  captureMetrics,
  collectConnectionMetricsFromReport,
  createStatsAccumulator,
  type StatsAccumulator,
} from "../webrtc/stats";

export interface SfuConnectionConfig {
  url: string;
  token: string;
}

interface PublisherEvents {
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

interface PublishedTrack {
  publication: LocalTrackPublication;
  rawTrack: MediaStreamTrack;
}

interface PublishedVideoConfiguration {
  readback: VideoSenderParameterReadback;
  warning: string | null;
}

interface PublisherStatsIdentity {
  video: PublishedTrack;
  sender: RTCRtpSender;
  rawTrack: MediaStreamTrack;
  accumulator: StatsAccumulator;
}

type LiveKit = typeof import("livekit-client");
type PublisherState =
  | "idle"
  | "connecting"
  | "prepared"
  | "active"
  | "disconnected";

const roomDisconnects = new WeakMap<Room, Promise<void>>();
const STATS_INTERVAL_MS = 2_000;

export class SfuPublisher {
  private room: Room | null = null;
  private sdk: LiveKit | null = null;
  private video: PublishedTrack | null = null;
  private audio: PublishedTrack | null = null;
  private profile: QualityProfile | null = null;
  private senderParameters: VideoSenderParameterReadback | null = null;
  private qualityWarning: string | null = null;
  private failureStage: SfuPublisherFailureStage | null = null;
  private state: PublisherState = "idle";
  private generation = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private terminalNotified = false;
  private statsVideo: PublishedTrack | null = null;
  private statsIdentity: PublisherStatsIdentity | null = null;
  private statsInFlight: PublisherStatsIdentity | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly events: PublisherEvents = {}) {}

  async connect(config: SfuConnectionConfig): Promise<boolean> {
    if (this.state !== "idle") {
      throw new Error("SFU publisher cannot be connected twice");
    }

    const generation = ++this.generation;
    this.failureStage = null;
    this.state = "connecting";

    try {
      const sdk = await import("livekit-client");
      if (!this.ownsGeneration(generation)) {
        return false;
      }

      const room = new sdk.Room({ dynacast: false });
      this.room = room;
      this.sdk = sdk;
      room.on(sdk.RoomEvent.Disconnected, () => {
        if (this.owns(room, generation)) {
          const notify = this.state !== "connecting";
          this.failureStage = "transport";
          this.invalidate();
          if (notify) {
            this.notifyTerminalDisconnect();
          }
        }
      });

      await room.connect(config.url, config.token, {
        autoSubscribe: false,
      });
      if (!this.owns(room, generation)) {
        await safeDisconnect(room);
        return false;
      }

      this.state = "prepared";
      return true;
    } catch (error) {
      if (!this.ownsGeneration(generation)) {
        return false;
      }
      this.failureStage = "connect";
      const room = this.invalidate();
      if (room) {
        await safeDisconnect(room);
      }
      throw error;
    }
  }

  activate(stream: MediaStream, profile: QualityProfile): Promise<boolean> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const room = this.requireOwnedRoom(generation, "prepared");
      if (!room) {
        return false;
      }
      let failureStage: SfuPublisherFailureStage = "source";
      try {
        const sdk = this.sdk;
        if (!sdk) {
          throw new Error("SFU publisher SDK is unavailable");
        }

        const videoTrack = requiredVideoTrack(stream);
        const audioTrack = stream.getAudioTracks()[0] ?? null;

        failureStage = "video-publish";
        const video = await publishTrack(
          room,
          videoTrack,
          sdk.Track.Source.ScreenShare,
          videoPublishOptions(sdk, profile),
        );
        if (!this.owns(room, generation)) {
          return false;
        }
        failureStage = "sender-config";
        const videoConfiguration = await configurePublishedVideo(
          video,
          profile,
          sdk,
          () => this.owns(room, generation),
        );
        if (!videoConfiguration || !this.owns(room, generation)) {
          return false;
        }

        let audio: PublishedTrack | null = null;
        if (audioTrack) {
          failureStage = "audio-publish";
          audio = await publishTrack(
            room,
            audioTrack,
            sdk.Track.Source.ScreenShareAudio,
            audioPublishOptions(sdk, profile.screenAudioQuality),
          );
          if (!this.owns(room, generation)) {
            return false;
          }
        }

        this.video = video;
        this.audio = audio;
        this.profile = profile;
        this.retainSenderParameters(videoConfiguration);
        this.failureStage = null;
        this.state = "active";
        this.startStats(video);
        return true;
      } catch (error) {
        if (this.owns(room, generation)) {
          this.failureStage = failureStage;
          await this.failClosed(room, generation);
        }
        throw error;
      }
    });
  }

  deactivate(): Promise<boolean> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const room = this.requireOwnedRoom(generation, ["prepared", "active"]);
      if (!room) {
        return false;
      }
      if (this.state === "prepared") {
        return true;
      }
      this.stopStats();

      const video = this.video;
      const audio = this.audio;
      try {
        if (audio) {
          await unpublishTrack(room, audio);
          if (!this.owns(room, generation)) {
            return false;
          }
        }
        if (video) {
          await unpublishTrack(room, video);
          if (!this.owns(room, generation)) {
            return false;
          }
        }
      } catch (error) {
        if (this.owns(room, generation)) {
          await this.failClosed(room, generation);
        }
        throw error;
      }

      this.video = null;
      this.audio = null;
      this.profile = null;
      this.senderParameters = null;
      this.qualityWarning = null;
      this.state = "prepared";
      return true;
    });
  }

  replaceStream(stream: MediaStream): Promise<boolean> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const room = this.requireOwnedRoom(generation, "active");
      if (!room) {
        return false;
      }
      const sdk = this.sdk;
      const previousVideo = this.video;
      const profile = this.profile;
      if (!sdk || !previousVideo || !profile) {
        throw new Error("SFU publisher has no active video publication");
      }

      const nextVideoTrack = requiredVideoTrack(stream);
      const nextAudioTrack = stream.getAudioTracks()[0] ?? null;
      const previousAudio = this.audio;
      let videoReplaceAttempted = false;
      let audioReplaceAttempted = false;
      this.stopStats();

      try {
        videoReplaceAttempted = true;
        await replacePublishedTrack(previousVideo, nextVideoTrack);
        if (!this.owns(room, generation)) {
          return false;
        }

        if (previousAudio && nextAudioTrack) {
          audioReplaceAttempted = true;
          await replacePublishedTrack(previousAudio, nextAudioTrack);
          if (!this.owns(room, generation)) {
            return false;
          }
        } else if (previousAudio) {
          await unpublishTrack(room, previousAudio);
          if (!this.owns(room, generation)) {
            return false;
          }
          this.audio = null;
        } else if (nextAudioTrack) {
          const nextAudio = await publishTrack(
            room,
            nextAudioTrack,
            sdk.Track.Source.ScreenShareAudio,
            audioPublishOptions(sdk, profile.screenAudioQuality),
          );
          if (!this.owns(room, generation)) {
            return false;
          }
          this.audio = nextAudio;
        }

        const videoConfiguration = await configurePublishedVideo(
          previousVideo,
          profile,
          sdk,
          () => this.owns(room, generation),
        );
        if (!videoConfiguration || !this.owns(room, generation)) {
          return false;
        }
        previousVideo.rawTrack = nextVideoTrack;
        if (previousAudio && nextAudioTrack) {
          previousAudio.rawTrack = nextAudioTrack;
        }
        this.retainSenderParameters(videoConfiguration);
        this.startStats(previousVideo);
        return true;
      } catch (error) {
        if (!this.owns(room, generation)) {
          return false;
        }
        const failureWarning =
          error instanceof Error && error.message
            ? `切换 SFU 分享来源失败：${error.message}`
            : "切换 SFU 分享来源失败";

        // A rejected publish/unpublish may have changed server state without
        // returning enough ownership information to undo it safely.
        if (
          (previousAudio === null && nextAudioTrack !== null) ||
          (previousAudio !== null && nextAudioTrack === null)
        ) {
          await this.failClosed(room, generation);
          throw error;
        }

        try {
          if (audioReplaceAttempted && previousAudio) {
            await replacePublishedTrack(previousAudio, previousAudio.rawTrack);
            if (!this.owns(room, generation)) {
              return false;
            }
          }
          if (videoReplaceAttempted) {
            await replacePublishedTrack(previousVideo, previousVideo.rawTrack);
            if (!this.owns(room, generation)) {
              return false;
            }
            const videoConfiguration = await configurePublishedVideo(
              previousVideo,
              profile,
              sdk,
              () => this.owns(room, generation),
            );
            if (!videoConfiguration || !this.owns(room, generation)) {
              return false;
            }
            this.senderParameters = videoConfiguration.readback;
            this.qualityWarning = mergeQualityWarnings(
              failureWarning,
              videoConfiguration.warning,
            );
            this.startStats(previousVideo);
          }
          return false;
        } catch (rollbackError) {
          if (this.owns(room, generation)) {
            await this.failClosed(room, generation);
          }
          throw rollbackError;
        }
      }
    });
  }

  updateProfile(profile: QualityProfile): Promise<boolean> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const room = this.requireOwnedRoom(generation, "active");
      if (!room) {
        return false;
      }
      const video = this.video;
      const previousProfile = this.profile;
      const sdk = this.sdk;
      if (!video || !previousProfile || !sdk) {
        throw new Error("SFU publisher has no active video publication");
      }
      if (
        resolveScreenAudioQuality(profile.screenAudioQuality) !==
        resolveScreenAudioQuality(previousProfile.screenAudioQuality)
      ) {
        return false;
      }
      this.stopStats();

      try {
        const videoConfiguration = await configurePublishedVideo(
          video,
          profile,
          sdk,
          () => this.owns(room, generation),
        );
        if (!videoConfiguration || !this.owns(room, generation)) {
          return false;
        }
        this.profile = profile;
        this.retainSenderParameters(videoConfiguration);
        this.startStats(video);
        return true;
      } catch (error) {
        if (!this.owns(room, generation)) {
          return false;
        }
        const failureWarning =
          error instanceof Error && error.message
            ? `应用 SFU 发送参数失败：${error.message}`
            : "应用 SFU 发送参数失败";
        try {
          const videoConfiguration = await configurePublishedVideo(
            video,
            previousProfile,
            sdk,
            () => this.owns(room, generation),
          );
          if (!videoConfiguration || !this.owns(room, generation)) {
            return false;
          }
          this.senderParameters = videoConfiguration.readback;
          this.qualityWarning = mergeQualityWarnings(
            failureWarning,
            videoConfiguration.warning,
          );
          this.startStats(video);
          return false;
        } catch (rollbackError) {
          if (this.owns(room, generation)) {
            await this.failClosed(room, generation);
          }
          throw rollbackError;
        }
      }
    });
  }

  getQualityWarning(): string | null {
    return this.qualityWarning;
  }

  getFailureStage(): SfuPublisherFailureStage | null {
    return this.failureStage;
  }

  getSenderParameters(): VideoSenderParameterReadback | null {
    return this.senderParameters;
  }

  async disconnect(): Promise<void> {
    const room = this.invalidate();
    if (room) {
      await safeDisconnect(room);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireOwnedRoom(
    generation: number,
    expectedState: PublisherState | PublisherState[],
  ): Room | null {
    if (!this.ownsGeneration(generation)) {
      return null;
    }
    const expected = Array.isArray(expectedState)
      ? expectedState
      : [expectedState];
    if (!expected.includes(this.state)) {
      throw new Error(`SFU publisher is ${this.state}, expected ${expected.join(" or ")}`);
    }
    if (!this.room) {
      throw new Error("SFU publisher room is unavailable");
    }
    return this.room;
  }

  private ownsGeneration(generation: number): boolean {
    return this.generation === generation && this.state !== "disconnected";
  }

  private owns(room: Room, generation: number): boolean {
    return this.room === room && this.ownsGeneration(generation);
  }

  private invalidate(): Room | null {
    if (this.state === "disconnected") {
      return null;
    }
    ++this.generation;
    this.stopStats();
    this.state = "disconnected";
    const room = this.room;
    this.room = null;
    this.sdk = null;
    this.video = null;
    this.audio = null;
    this.profile = null;
    this.senderParameters = null;
    this.qualityWarning = null;
    return room;
  }

  private async failClosed(room: Room, generation: number): Promise<void> {
    if (!this.owns(room, generation)) {
      return;
    }
    this.invalidate();
    await safeDisconnect(room);
    this.notifyTerminalDisconnect();
  }

  private notifyTerminalDisconnect(): void {
    if (this.terminalNotified) {
      return;
    }
    this.terminalNotified = true;
    this.events.onDisconnected?.();
  }

  private retainSenderParameters(
    configuration: PublishedVideoConfiguration,
  ): void {
    this.senderParameters = configuration.readback;
    this.qualityWarning = configuration.warning;
  }

  private startStats(video: PublishedTrack): void {
    this.stopStats();
    this.statsVideo = video;
    this.statsTimer = setInterval(() => {
      void this.updateStats(video);
    }, STATS_INTERVAL_MS);
  }

  private async updateStats(video: PublishedTrack): Promise<void> {
    if (
      this.state !== "active" ||
      this.statsVideo !== video ||
      this.video !== video
    ) {
      return;
    }
    const sender = video.publication.videoTrack?.sender;
    if (!sender || sender.track !== video.rawTrack) {
      this.resetStatsIdentity();
      return;
    }
    let identity = this.statsIdentity;
    if (
      !identity ||
      identity.video !== video ||
      identity.sender !== sender ||
      identity.rawTrack !== video.rawTrack
    ) {
      this.resetStatsIdentity();
      identity = {
        video,
        sender,
        rawTrack: video.rawTrack,
        accumulator: createStatsAccumulator(),
      };
      this.statsIdentity = identity;
    }
    if (this.statsInFlight === identity) {
      return;
    }
    this.statsInFlight = identity;
    try {
      const report = await identity.sender.getStats();
      if (
        this.state !== "active" ||
        this.statsIdentity !== identity ||
        this.video !== identity.video ||
        identity.video.rawTrack !== identity.rawTrack ||
        identity.video.publication.videoTrack?.sender !== identity.sender ||
        identity.sender.track !== identity.rawTrack
      ) {
        return;
      }
      const metrics = {
        ...collectConnectionMetricsFromReport(
          report,
          "send",
          identity.accumulator,
          { trackIdentifier: identity.rawTrack.id, rid: "h" },
        ),
        ...captureMetrics(identity.rawTrack),
      };
      this.events.onStats?.(metrics);
    } catch {
      // Stats are observational and must never disrupt active SFU media.
    } finally {
      if (this.statsInFlight === identity) {
        this.statsInFlight = null;
      }
    }
  }

  private stopStats(): void {
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.statsVideo = null;
    this.statsInFlight = null;
    this.resetStatsIdentity();
  }

  private resetStatsIdentity(): void {
    const hadIdentity = this.statsIdentity !== null;
    this.statsIdentity = null;
    if (hadIdentity) {
      this.events.onStats?.(null);
    }
  }
}

async function publishTrack(
  room: Room,
  rawTrack: MediaStreamTrack,
  source: Track.Source,
  options: TrackPublishOptions,
): Promise<PublishedTrack> {
  const publication = await room.localParticipant.publishTrack(rawTrack, {
    source,
    ...options,
  });
  if (!publication.track) {
    throw new Error("SFU did not retain the published track");
  }
  return { publication, rawTrack };
}

async function replacePublishedTrack(
  published: PublishedTrack,
  nextTrack: MediaStreamTrack,
): Promise<void> {
  const localTrack = published.publication.track;
  if (!localTrack) {
    throw new Error("SFU publication has no local track");
  }
  await localTrack.replaceTrack(nextTrack);
}

async function unpublishTrack(room: Room, published: PublishedTrack): Promise<void> {
  const localTrack = published.publication.track;
  if (!localTrack) {
    throw new Error("SFU publication has no local track");
  }
  await room.localParticipant.unpublishTrack(localTrack, false);
}

async function configurePublishedVideo(
  published: PublishedTrack,
  profile: QualityProfile,
  sdk: LiveKit,
  ownsPublication: () => boolean,
): Promise<PublishedVideoConfiguration | null> {
  const videoTrack = published.publication.videoTrack;
  const sender = videoTrack?.sender;
  if (!sender) {
    throw new Error("SFU video publication has no RTP sender");
  }
  const previousPreference = videoTrack.publishOptions?.degradationPreference;
  await videoTrack.setDegradationPreference(profile.degradationPreference);
  if (!ownsPublication()) {
    if (previousPreference) {
      await videoTrack.setDegradationPreference(previousPreference);
    }
    return null;
  }
  const readbacks = await configureTwoLayerVideoSender(sender, profile);
  if (!ownsPublication()) {
    if (previousPreference) {
      await videoTrack.setDegradationPreference(previousPreference);
    }
    return null;
  }
  const retainedPublishOptions = {
    ...published.publication.options,
    ...videoTrack.publishOptions,
    ...videoPublishOptions(sdk, profile),
  };
  published.publication.options = retainedPublishOptions;
  videoTrack.publishOptions = retainedPublishOptions;
  const highWarning = senderParameterWarning(readbacks.high);
  const lowWarning = senderParameterWarning(readbacks.low);
  return {
    readback: readbacks.high,
    warning: mergeQualityWarnings(
      highWarning,
      lowWarning ? `低档表示：${lowWarning}` : null,
    ),
  };
}

function mergeQualityWarnings(...warnings: Array<string | null>): string | null {
  const present = warnings.filter(
    (warning): warning is string => warning !== null,
  );
  return present.length > 0 ? present.join("；") : null;
}

function videoPublishOptions(
  sdk: LiveKit,
  profile: QualityProfile,
): TrackPublishOptions {
  const highResolution = QUALITY_RESOLUTIONS[profile.resolution];
  return {
    backupCodec: false,
    ...(!profile.videoCodec || profile.videoCodec === "automatic"
      ? {}
      : { videoCodec: profile.videoCodec }),
    simulcast: true,
    screenShareEncoding: {
      maxBitrate: profile.maxBitrate,
      maxFramerate: profile.maxFramerate,
    },
    screenShareSimulcastLayers: [
      new sdk.VideoPreset(
        Math.floor(highResolution.width / SCREEN_SHARE_LOW_SCALE),
        Math.floor(highResolution.height / SCREEN_SHARE_LOW_SCALE),
        screenShareLowBitrate(profile),
        profile.maxFramerate,
      ),
    ],
    degradationPreference: profile.degradationPreference,
  };
}

function audioPublishOptions(
  sdk: LiveKit,
  quality: ScreenAudioQuality | undefined,
): TrackPublishOptions {
  const resolvedQuality = resolveScreenAudioQuality(quality);
  const audioPreset =
    resolvedQuality === "saver"
      ? sdk.AudioPresets.musicStereo
      : resolvedQuality === "music"
        ? sdk.AudioPresets.musicHighQualityStereo
        : { maxBitrate: screenAudioBitrate(resolvedQuality) };
  return {
    audioPreset,
    forceStereo: true,
    dtx: false,
  };
}

async function safeDisconnect(room: Room): Promise<void> {
  const existing = roomDisconnects.get(room);
  if (existing) {
    await existing;
    return;
  }
  const disconnecting = room.disconnect(false).catch(() => undefined);
  roomDisconnects.set(room, disconnecting);
  await disconnecting;
}

function requiredVideoTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("屏幕共享没有视频轨道");
  }
  return track;
}
