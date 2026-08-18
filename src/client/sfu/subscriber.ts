import type {
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  Track,
} from "livekit-client";

import type { SfuConnectionConfig } from "./publisher";

interface SubscriberEvents {
  onStream: (stream: MediaStream | null) => void;
  onDisconnected?: () => void;
}

interface SubscribedTrack {
  sid: string;
  track: MediaStreamTrack;
}

const HOST_IDENTITY = "host";

export class SfuSubscriber {
  private room: Room | null = null;
  private video: SubscribedTrack | null = null;
  private audio: SubscribedTrack | null = null;
  private readonly blockedTrackSids = new Set<string>();
  private disposed = false;

  constructor(private readonly events: SubscriberEvents) {}

  async connect(config: SfuConnectionConfig): Promise<void> {
    if (this.room || this.disposed) {
      throw new Error("SFU subscriber cannot be connected twice");
    }

    const sdk = await import("livekit-client");
    if (this.disposed) {
      return;
    }

    const room = new sdk.Room();
    this.room = room;
    room.on(
      sdk.RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (this.room !== room || participant.identity !== HOST_IDENTITY) {
          return;
        }
        this.addTrack(
          publication.trackSid,
          publication.source,
          track.mediaStreamTrack,
          sdk.Track,
        );
      },
    );
    room.on(
      sdk.RoomEvent.TrackUnsubscribed,
      (
        _track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (this.room === room && participant.identity === HOST_IDENTITY) {
          this.removeTrack(publication.trackSid);
        }
      },
    );
    room.on(sdk.RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (this.room === room && participant.identity === HOST_IDENTITY) {
        this.clearMedia();
      }
    });
    room.on(sdk.RoomEvent.Disconnected, () => {
      if (!this.disposed && this.room === room) {
        this.clearMedia();
        this.events.onDisconnected?.();
      }
    });

    try {
      await room.connect(config.url, config.token, { autoSubscribe: true });
      if (this.disposed || this.room !== room) {
        await room.disconnect();
        return;
      }
      const host = room.remoteParticipants.get(HOST_IDENTITY);
      if (host) {
        this.collectExistingTracks(host, sdk.Track);
      }
    } catch (error) {
      if (this.room === room) {
        this.room = null;
      }
      await room.disconnect().catch(() => undefined);
      throw error;
    }
  }

  clearMedia(): void {
    this.blockCurrentHostPublications();
    this.video = null;
    this.audio = null;
    this.events.onStream(null);
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
    this.events.onStream(null);
    if (room) {
      void room.disconnect().catch(() => undefined);
    }
  }

  private collectExistingTracks(
    participant: RemoteParticipant,
    trackType: typeof Track,
  ): void {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track) {
        this.addTrack(
          publication.trackSid,
          publication.source,
          publication.track.mediaStreamTrack,
          trackType,
        );
      }
    }
  }

  private addTrack(
    sid: string,
    source: Track.Source,
    track: MediaStreamTrack,
    trackType: typeof Track,
  ): void {
    if (this.blockedTrackSids.has(sid)) {
      return;
    }
    if (source === trackType.Source.ScreenShare) {
      this.video = { sid, track };
    } else if (source === trackType.Source.ScreenShareAudio) {
      this.audio = { sid, track };
    } else {
      return;
    }
    this.emitStream();
  }

  private removeTrack(sid: string): void {
    if (this.video?.sid === sid) {
      this.video = null;
    }
    if (this.audio?.sid === sid) {
      this.audio = null;
    }
    this.emitStream();
  }

  private blockCurrentHostPublications(): void {
    if (this.video) {
      this.blockedTrackSids.add(this.video.sid);
    }
    if (this.audio) {
      this.blockedTrackSids.add(this.audio.sid);
    }
    const host = this.room?.remoteParticipants.get(HOST_IDENTITY);
    for (const publication of host?.trackPublications.values() ?? []) {
      this.blockedTrackSids.add(publication.trackSid);
    }
  }

  private emitStream(): void {
    if (!this.video) {
      this.events.onStream(null);
      return;
    }
    const tracks = [this.video.track];
    if (this.audio) {
      tracks.push(this.audio.track);
    }
    this.events.onStream(new MediaStream(tracks));
  }
}
