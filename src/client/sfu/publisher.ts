import type {
  LocalTrackPublication,
  Room,
  Track,
  TrackPublishOptions,
} from "livekit-client";

import {
  configureTwoLayerVideoSender,
  QUALITY_RESOLUTIONS,
  SCREEN_SHARE_LOW_SCALE,
  screenShareLowBitrate,
  senderParameterWarning,
  type QualityProfile,
  type VideoSenderParameterReadback,
} from "../media/quality";

export interface SfuConnectionConfig {
  url: string;
  token: string;
}

interface PublisherEvents {
  onDisconnected?: () => void;
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

type LiveKit = typeof import("livekit-client");
type PublisherState =
  | "idle"
  | "connecting"
  | "prepared"
  | "active"
  | "disconnected";

const roomDisconnects = new WeakMap<Room, Promise<void>>();

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

      const room = new sdk.Room();
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

      await room.connect(config.url, config.token, { autoSubscribe: false });
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
        );
        if (!this.owns(room, generation)) {
          return false;
        }

        let audio: PublishedTrack | null = null;
        if (audioTrack) {
          failureStage = "audio-publish";
          audio = await publishTrack(
            room,
            audioTrack,
            sdk.Track.Source.ScreenShareAudio,
            { dtx: false },
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
            { dtx: false },
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
        );
        if (!this.owns(room, generation)) {
          return false;
        }
        previousVideo.rawTrack = nextVideoTrack;
        if (previousAudio && nextAudioTrack) {
          previousAudio.rawTrack = nextAudioTrack;
        }
        this.retainSenderParameters(videoConfiguration);
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
            );
            if (!this.owns(room, generation)) {
              return false;
            }
            this.senderParameters = videoConfiguration.readback;
            this.qualityWarning = mergeQualityWarnings(
              failureWarning,
              videoConfiguration.warning,
            );
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

      try {
        const videoConfiguration = await configurePublishedVideo(
          video,
          profile,
          sdk,
        );
        if (!this.owns(room, generation)) {
          return false;
        }
        this.profile = profile;
        this.retainSenderParameters(videoConfiguration);
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
          );
          if (!this.owns(room, generation)) {
            return false;
          }
          this.senderParameters = videoConfiguration.readback;
          this.qualityWarning = mergeQualityWarnings(
            failureWarning,
            videoConfiguration.warning,
          );
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
): Promise<PublishedVideoConfiguration> {
  const videoTrack = published.publication.videoTrack;
  const sender = videoTrack?.sender;
  if (!sender) {
    throw new Error("SFU video publication has no RTP sender");
  }
  const readbacks = await configureTwoLayerVideoSender(sender, profile);
  videoTrack.publishOptions = {
    ...videoTrack.publishOptions,
    ...videoPublishOptions(sdk, profile),
  };
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
