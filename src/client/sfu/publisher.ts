import type {
  LocalTrackPublication,
  Room,
  Track,
} from "livekit-client";

import type { QualityProfile } from "../media/quality";

export interface SfuConnectionConfig {
  url: string;
  token: string;
}

interface PublisherEvents {
  onDisconnected?: () => void;
}

interface PublishedTrack {
  publication: LocalTrackPublication;
  rawTrack: MediaStreamTrack;
}

export class SfuPublisher {
  private room: Room | null = null;
  private video: PublishedTrack | null = null;
  private audio: PublishedTrack | null = null;
  private disposed = false;

  constructor(private readonly events: PublisherEvents = {}) {}

  async connect(
    config: SfuConnectionConfig,
    stream: MediaStream,
    profile: QualityProfile,
  ): Promise<void> {
    if (this.room || this.disposed) {
      throw new Error("SFU publisher cannot be connected twice");
    }

    const videoTrack = requiredVideoTrack(stream);
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const sdk = await import("livekit-client");
    if (this.disposed) {
      return;
    }

    const room = new sdk.Room();
    this.room = room;
    room.on(sdk.RoomEvent.Disconnected, () => {
      if (!this.disposed && this.room === room) {
        this.events.onDisconnected?.();
      }
    });

    try {
      await room.connect(config.url, config.token, { autoSubscribe: false });
      if (this.disposed || this.room !== room) {
        await room.disconnect(false);
        return;
      }

      const video = await publishTrack(
        room,
        videoTrack,
        sdk.Track.Source.ScreenShare,
        {
          simulcast: false,
          screenShareEncoding: {
            maxBitrate: profile.maxBitrate,
            maxFramerate: profile.frameRate,
          },
          degradationPreference: "maintain-framerate",
        },
      );
      if (!this.owns(room)) {
        return;
      }
      this.video = video;
      if (audioTrack) {
        const audio = await publishTrack(
          room,
          audioTrack,
          sdk.Track.Source.ScreenShareAudio,
          { dtx: false },
        );
        if (!this.owns(room)) {
          return;
        }
        this.audio = audio;
      }
    } catch (error) {
      if (!this.owns(room)) {
        return;
      }
      if (this.room === room) {
        this.room = null;
        this.video = null;
        this.audio = null;
      }
      await room.disconnect(false).catch(() => undefined);
      throw error;
    }
  }

  async replaceStream(stream: MediaStream): Promise<boolean> {
    const room = this.room;
    const previousVideo = this.video;
    if (!room || !previousVideo || this.disposed) {
      throw new Error("SFU publisher is not connected");
    }

    const nextVideoTrack = requiredVideoTrack(stream);
    const nextAudioTrack = stream.getAudioTracks()[0] ?? null;
    const previousAudio = this.audio;
    const sdk = await import("livekit-client");
    if (!this.owns(room)) {
      return false;
    }
    let videoReplaceAttempted = false;
    let audioReplaceAttempted = false;
    let publicationStateUncertain = false;
    let audioAdded: PublishedTrack | null = null;

    try {
      videoReplaceAttempted = true;
      await replacePublishedTrack(previousVideo, nextVideoTrack);
      if (!this.owns(room)) {
        return false;
      }

      if (previousAudio && nextAudioTrack) {
        audioReplaceAttempted = true;
        await replacePublishedTrack(previousAudio, nextAudioTrack);
        if (!this.owns(room)) {
          return false;
        }
      } else if (previousAudio) {
        publicationStateUncertain = true;
        await unpublishTrack(room, previousAudio);
        if (!this.owns(room)) {
          return false;
        }
        publicationStateUncertain = false;
        this.audio = null;
      } else if (nextAudioTrack) {
        publicationStateUncertain = true;
        audioAdded = await publishTrack(
          room,
          nextAudioTrack,
          sdk.Track.Source.ScreenShareAudio,
          { dtx: false },
        );
        if (!this.owns(room)) {
          return false;
        }
        publicationStateUncertain = false;
        this.audio = audioAdded;
      }

      previousVideo.rawTrack = nextVideoTrack;
      if (previousAudio && nextAudioTrack) {
        previousAudio.rawTrack = nextAudioTrack;
      }
      return true;
    } catch (error) {
      if (publicationStateUncertain) {
        this.disconnect();
        throw error;
      }
      try {
        if (!this.owns(room)) {
          return false;
        }
        if (audioAdded) {
          await unpublishTrack(room, audioAdded);
          if (!this.owns(room)) {
            return false;
          }
          if (this.audio === audioAdded) {
            this.audio = null;
          }
        }
        if (audioReplaceAttempted && previousAudio) {
          await replacePublishedTrack(previousAudio, previousAudio.rawTrack);
          if (!this.owns(room)) {
            return false;
          }
        }
        if (videoReplaceAttempted) {
          await replacePublishedTrack(previousVideo, previousVideo.rawTrack);
          if (!this.owns(room)) {
            return false;
          }
        }
        return false;
      } catch (rollbackError) {
        this.disconnect();
        throw rollbackError;
      }
    }
  }

  private owns(room: Room): boolean {
    return !this.disposed && this.room === room;
  }

  disconnect(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const room = this.room;
    this.room = null;
    this.video = null;
    this.audio = null;
    if (room) {
      void room.disconnect(false).catch(() => undefined);
    }
  }
}

async function publishTrack(
  room: Room,
  rawTrack: MediaStreamTrack,
  source: Track.Source,
  options: {
    simulcast?: boolean;
    dtx?: boolean;
    screenShareEncoding?: {
      maxBitrate: number;
      maxFramerate: number;
    };
    degradationPreference?: RTCDegradationPreference;
  } = {},
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

function requiredVideoTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("屏幕共享没有视频轨道");
  }
  return track;
}
