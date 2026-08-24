import type {
  LocalTrackPublication,
  Room,
  Track,
  TrackPublishOptions,
} from "livekit-client";

import {
  audioSenderParameterWarning,
  configureScreenAudioSender,
  configureTwoLayerVideoSender,
  QUALITY_RESOLUTIONS,
  resolveScreenAudioQuality,
  screenAudioQualityEqual,
  SCREEN_SHARE_LOW_SCALE,
  screenAudioBitrate,
  screenShareLowBitrate,
  senderParameterWarning,
  videoQualitySettingsEqual,
  type AudioSenderParameterReadback,
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

interface PublishedAudioConfiguration {
  sender: RTCRtpSender;
  readback: AudioSenderParameterReadback;
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
  private desiredProfile: QualityProfile | null = null;
  private appliedVideoProfile: QualityProfile | null = null;
  private profileRevision = 0;
  private senderParameters: VideoSenderParameterReadback | null = null;
  private audioSenderParameters: AudioSenderParameterReadback | null = null;
  private audioParametersSender: RTCRtpSender | null = null;
  private videoQualityWarning: string | null = null;
  private audioQualityWarning: string | null = null;
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
      room.on(sdk.RoomEvent.Reconnected, () => {
        if (this.owns(room, generation) && this.state === "active") {
          this.reapplyAudioAfterReconnect(room, generation);
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
    this.desiredProfile = profile;
    ++this.profileRevision;
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
        let audioConfiguration: PublishedAudioConfiguration | null = null;
        let audioWarning: string | null = null;
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
          retainPublishedAudioOptions(audio, profile, sdk);
          try {
            const audioSender = publishedAudioSender(audio);
            audioConfiguration = await configurePublishedAudio(
              audio,
              audioSender,
              profile,
              () => this.owns(room, generation),
            );
            if (!audioConfiguration || !this.owns(room, generation)) {
              return false;
            }
            audioWarning = audioConfiguration.warning;
          } catch (error) {
            if (!this.owns(room, generation)) {
              return false;
            }
            audioWarning = audioSenderFailureWarning(error);
          }
        }

        this.video = video;
        this.audio = audio;
        this.appliedVideoProfile = profile;
        this.retainSenderParameters(
          videoConfiguration,
          audioConfiguration?.readback ?? null,
          audioWarning,
          audioConfiguration?.sender ?? null,
        );
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
      this.desiredProfile = null;
      this.appliedVideoProfile = null;
      ++this.profileRevision;
      this.senderParameters = null;
      this.audioSenderParameters = null;
      this.audioParametersSender = null;
      this.videoQualityWarning = null;
      this.audioQualityWarning = null;
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
      const profile = this.desiredProfile;
      const previousVideoProfile = this.appliedVideoProfile;
      if (!sdk || !previousVideo || !profile || !previousVideoProfile) {
        throw new Error("SFU publisher has no active video publication");
      }

      const nextVideoTrack = requiredVideoTrack(stream);
      const nextAudioTrack = stream.getAudioTracks()[0] ?? null;
      const previousAudio = this.audio;
      let videoReplaceAttempted = false;
      let audioReplaceAttempted = false;
      let audioConfiguration: PublishedAudioConfiguration | null = null;
      let audioWarning: string | null = null;
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

        const currentAudio = this.audio;
        if (currentAudio && nextAudioTrack) {
          retainPublishedAudioOptions(currentAudio, profile, sdk);
          try {
            const audioSender = publishedAudioSender(currentAudio);
            audioConfiguration = await configurePublishedAudio(
              currentAudio,
              audioSender,
              profile,
              () => this.owns(room, generation),
            );
            if (!audioConfiguration || !this.owns(room, generation)) {
              return false;
            }
            audioWarning = audioConfiguration.warning;
          } catch (error) {
            if (!this.owns(room, generation)) {
              return false;
            }
            audioWarning = audioSenderFailureWarning(error);
          }
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
        this.appliedVideoProfile = profile;
        this.retainSenderParameters(
          videoConfiguration,
          nextAudioTrack
            ? (audioConfiguration?.readback ?? this.audioSenderParameters)
            : null,
          nextAudioTrack ? audioWarning : null,
          nextAudioTrack
            ? (audioConfiguration?.sender ?? this.audioParametersSender)
            : null,
        );
        this.startStats(previousVideo);
        return true;
      } catch (error) {
        if (!this.owns(room, generation)) {
          return false;
        }
        const failureWarning = "切换 SFU 分享来源失败";

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
              previousVideoProfile,
              sdk,
              () => this.owns(room, generation),
            );
            if (!videoConfiguration || !this.owns(room, generation)) {
              return false;
            }
            this.appliedVideoProfile = previousVideoProfile;
            this.senderParameters = videoConfiguration.readback;
            this.videoQualityWarning = mergeQualityWarnings(
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
    const previousDesiredProfile = this.desiredProfile;
    const requestedVideo =
      previousDesiredProfile === null ||
      !videoQualitySettingsEqual(previousDesiredProfile, profile) ||
      this.appliedVideoProfile === null ||
      !videoQualitySettingsEqual(this.appliedVideoProfile, profile);
    const requestedAudio =
      previousDesiredProfile === null ||
      !screenAudioQualityEqual(previousDesiredProfile, profile) ||
      (this.audio !== null &&
        (this.audio.publication.audioTrack?.sender !==
          this.audioParametersSender ||
          this.audioSenderParameters?.requestedMaxBitrate !==
            screenAudioBitrate(profile.screenAudioQuality)));
    this.desiredProfile = profile;
    const requestedRevision = ++this.profileRevision;
    if (this.state === "active" && this.audio && this.sdk) {
      retainPublishedAudioOptions(this.audio, profile, this.sdk);
    }
    const generation = this.generation;
    return this.enqueue(async () => {
      const room = this.requireOwnedRoom(generation, "active");
      if (!room || requestedRevision !== this.profileRevision) {
        return false;
      }
      const video = this.video;
      const audio = this.audio;
      const previousVideoProfile = this.appliedVideoProfile;
      const sdk = this.sdk;
      if (!video || !previousVideoProfile || !sdk) {
        throw new Error("SFU publisher has no active video publication");
      }
      const updateVideo =
        requestedVideo ||
        !videoQualitySettingsEqual(previousVideoProfile, profile);
      const currentAudioSender = audio?.publication.audioTrack?.sender ?? null;
      const updateAudio =
        audio !== null &&
        (requestedAudio ||
          currentAudioSender !== this.audioParametersSender ||
          this.audioSenderParameters?.requestedMaxBitrate !==
            screenAudioBitrate(profile.screenAudioQuality));
      if (!updateVideo && !updateAudio) {
        return true;
      }
      if (audio) {
        retainPublishedAudioOptions(audio, profile, sdk);
      }
      if (updateVideo) {
        this.stopStats();
      }

      let senderParameters = this.senderParameters;
      let videoWarning = this.videoQualityWarning;
      let appliedVideoProfile = previousVideoProfile;
      let videoSucceeded = true;
      if (updateVideo) {
        try {
          const configured = await configurePublishedVideo(
            video,
            profile,
            sdk,
            () =>
              this.owns(room, generation) &&
              requestedRevision === this.profileRevision &&
              this.video === video,
          );
          if (!configured) {
            if (this.video === video) {
              this.startStats(video);
            }
            return false;
          }
          senderParameters = configured.readback;
          videoWarning = configured.warning;
          appliedVideoProfile = profile;
        } catch {
          if (
            !this.owns(room, generation) ||
            requestedRevision !== this.profileRevision ||
            this.video !== video
          ) {
            if (this.video === video) {
              this.startStats(video);
            }
            return false;
          }
          videoSucceeded = false;
          const failureWarning = "应用 SFU 发送参数失败";
          try {
            const rolledBack = await configurePublishedVideo(
              video,
              previousVideoProfile,
              sdk,
              () =>
                this.owns(room, generation) &&
                requestedRevision === this.profileRevision &&
                this.video === video,
            );
            if (!rolledBack) {
              if (this.video === video) {
                this.startStats(video);
              }
              return false;
            }
            senderParameters = rolledBack.readback;
            videoWarning = mergeQualityWarnings(
              failureWarning,
              rolledBack.warning,
            );
          } catch (rollbackError) {
            if (
              this.owns(room, generation) &&
              requestedRevision === this.profileRevision &&
              this.video === video
            ) {
              await this.failClosed(room, generation);
              throw rollbackError;
            }
            if (this.video === video) {
              this.startStats(video);
            }
            return false;
          }
        }
      }

      if (
        !this.owns(room, generation) ||
        requestedRevision !== this.profileRevision ||
        this.video !== video ||
        this.audio !== audio
      ) {
        if (updateVideo && this.video === video) {
          this.startStats(video);
        }
        return false;
      }

      let audioSenderParameters = this.audioSenderParameters;
      let audioParametersSender = this.audioParametersSender;
      let audioWarning = this.audioQualityWarning;
      let audioSucceeded = true;
      if (updateAudio && audio) {
        let audioSender: RTCRtpSender | null = null;
        try {
          audioSender = publishedAudioSender(audio);
          const ownedAudioSender = audioSender;
          const configured = await configurePublishedAudio(
            audio,
            ownedAudioSender,
            profile,
            () =>
              this.ownsAudioMutation(
                room,
                generation,
                requestedRevision,
                audio,
                ownedAudioSender,
              ),
          );
          if (!configured) {
            if (updateVideo && this.video === video) {
              this.startStats(video);
            }
            return false;
          }
          audioSenderParameters = configured.readback;
          audioParametersSender = configured.sender;
          audioWarning = configured.warning;
        } catch (error) {
          if (
            !this.owns(room, generation) ||
            requestedRevision !== this.profileRevision ||
            this.audio !== audio ||
            (audioSender !== null &&
              audio.publication.audioTrack?.sender !== audioSender)
          ) {
            if (updateVideo && this.video === video) {
              this.startStats(video);
            }
            return false;
          }
          audioSucceeded = false;
          audioWarning = audioSenderFailureWarning(error);
        }
      }

      if (
        !this.owns(room, generation) ||
        requestedRevision !== this.profileRevision ||
        this.video !== video ||
        this.audio !== audio
      ) {
        if (updateVideo && this.video === video) {
          this.startStats(video);
        }
        return false;
      }
      this.senderParameters = senderParameters;
      this.audioSenderParameters = audioSenderParameters;
      this.audioParametersSender = audioParametersSender;
      this.appliedVideoProfile = appliedVideoProfile;
      this.videoQualityWarning = videoWarning;
      this.audioQualityWarning = audioWarning;
      if (updateVideo) {
        this.startStats(video);
      }
      return videoSucceeded && audioSucceeded;
    });
  }

  getQualityWarning(): string | null {
    return mergeQualityWarnings(
      this.videoQualityWarning,
      this.audioQualityWarning,
    );
  }

  getFailureStage(): SfuPublisherFailureStage | null {
    return this.failureStage;
  }

  getSenderParameters(): VideoSenderParameterReadback | null {
    return this.senderParameters;
  }

  getAudioSenderParameters(): AudioSenderParameterReadback | null {
    return this.audioSenderParameters;
  }

  private reapplyAudioAfterReconnect(room: Room, generation: number): void {
    void this.enqueue(async () => {
      if (!this.owns(room, generation) || this.state !== "active") {
        return false;
      }
      const audio = this.audio;
      const profile = this.desiredProfile;
      const sdk = this.sdk;
      const profileRevision = this.profileRevision;
      if (!audio || !profile || !sdk) {
        return true;
      }
      retainPublishedAudioOptions(audio, profile, sdk);

      let audioSender: RTCRtpSender | null = null;
      try {
        audioSender = publishedAudioSender(audio);
        const ownedAudioSender = audioSender;
        const configured = await configurePublishedAudio(
          audio,
          ownedAudioSender,
          profile,
          () =>
            this.ownsAudioMutation(
              room,
              generation,
              profileRevision,
              audio,
              ownedAudioSender,
            ),
        );
        if (!configured) {
          return false;
        }
        this.audioSenderParameters = configured.readback;
        this.audioParametersSender = configured.sender;
        this.audioQualityWarning = configured.warning;
        return true;
      } catch (error) {
        if (
          !this.owns(room, generation) ||
          profileRevision !== this.profileRevision ||
          this.audio !== audio ||
          (audioSender !== null &&
            audio.publication.audioTrack?.sender !== audioSender)
        ) {
          return false;
        }
        this.audioQualityWarning = audioSenderFailureWarning(error);
        return false;
      }
    });
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

  private ownsAudioMutation(
    room: Room,
    generation: number,
    profileRevision: number,
    audio: PublishedTrack,
    sender: RTCRtpSender,
  ): boolean {
    return (
      this.owns(room, generation) &&
      this.state === "active" &&
      this.profileRevision === profileRevision &&
      this.audio === audio &&
      audio.publication.audioTrack?.sender === sender
    );
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
    this.desiredProfile = null;
    this.appliedVideoProfile = null;
    ++this.profileRevision;
    this.senderParameters = null;
    this.audioSenderParameters = null;
    this.audioParametersSender = null;
    this.videoQualityWarning = null;
    this.audioQualityWarning = null;
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
    audioSenderParameters: AudioSenderParameterReadback | null,
    audioWarning: string | null,
    audioParametersSender: RTCRtpSender | null,
  ): void {
    this.senderParameters = configuration.readback;
    this.audioSenderParameters = audioSenderParameters;
    this.audioParametersSender = audioParametersSender;
    this.videoQualityWarning = configuration.warning;
    this.audioQualityWarning = audioWarning;
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

async function configurePublishedAudio(
  published: PublishedTrack,
  sender: RTCRtpSender,
  profile: QualityProfile,
  ownsPublication: () => boolean,
): Promise<PublishedAudioConfiguration | null> {
  if (published.publication.audioTrack?.sender !== sender) {
    return null;
  }
  const readback = await configureScreenAudioSender(
    sender,
    profile.screenAudioQuality,
  );
  if (
    !ownsPublication() ||
    published.publication.audioTrack?.sender !== sender
  ) {
    return null;
  }
  return {
    sender,
    readback,
    warning: audioSenderParameterWarning(readback),
  };
}

function publishedAudioSender(published: PublishedTrack): RTCRtpSender {
  const sender = published.publication.audioTrack?.sender;
  if (!sender) {
    throw new Error("SFU audio publication has no RTP sender");
  }
  return sender;
}

function retainPublishedAudioOptions(
  published: PublishedTrack,
  profile: QualityProfile,
  sdk: LiveKit,
): void {
  published.publication.options = {
    ...published.publication.options,
    ...audioPublishOptions(sdk, profile.screenAudioQuality),
  };
}

function audioSenderFailureWarning(_error: unknown): string {
  return "应用 SFU 音频发送参数失败";
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
  const videoCodec = profile.videoCodec ?? "vp8";
  return {
    backupCodec: false,
    ...(videoCodec === "automatic" ? {} : { videoCodec }),
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
