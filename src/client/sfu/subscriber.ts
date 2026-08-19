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

type SubscriberState =
  | "idle"
  | "connecting"
  | "prepared"
  | "active"
  | "disconnected";
type LiveKit = typeof import("livekit-client");

const HOST_IDENTITY = "host";
const roomDisconnects = new WeakMap<Room, Promise<void>>();

export class SfuSubscriber {
  private room: Room | null = null;
  private sdk: LiveKit | null = null;
  private video: SubscribedTrack | null = null;
  private audio: SubscribedTrack | null = null;
  private readonly desiredTrackSids = new Set<string>();
  private state: SubscriberState = "idle";
  private generation = 0;
  private terminalNotified = false;

  constructor(private readonly events: SubscriberEvents) {}

  async connect(config: SfuConnectionConfig): Promise<boolean> {
    if (this.state !== "idle") {
      throw new Error("SFU subscriber cannot be connected twice");
    }

    const generation = ++this.generation;
    this.state = "connecting";

    try {
      const sdk = await import("livekit-client");
      if (!this.ownsGeneration(generation)) {
        return false;
      }

      const room = new sdk.Room();
      this.room = room;
      this.sdk = sdk;
      this.bindRoomEvents(room, sdk, generation);

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
      const room = this.invalidate(false);
      if (room) {
        await safeDisconnect(room);
      }
      throw error;
    }
  }

  activate(): boolean {
    if (this.state === "active") {
      return true;
    }
    if (this.state !== "prepared" || !this.room || !this.sdk) {
      throw new Error(`SFU subscriber is ${this.state}, expected prepared`);
    }

    const room = this.room;
    const generation = this.generation;
    this.state = "active";
    try {
      const host = room.remoteParticipants.get(HOST_IDENTITY);
      if (host) {
        for (const publication of host.trackPublications.values()) {
          this.subscribeIfAllowed(publication, host, this.sdk.Track);
        }
      }
      return true;
    } catch (error) {
      if (this.owns(room, generation)) {
        try {
          this.rollbackSubscriptions(room);
          this.state = "prepared";
          this.clearMedia(true);
        } catch {
          void this.failClosed(room, generation);
        }
      }
      throw error;
    }
  }

  deactivate(): boolean {
    if (this.state === "prepared") {
      return true;
    }
    if (this.state !== "active" || !this.room) {
      if (this.state === "disconnected") {
        return false;
      }
      throw new Error(`SFU subscriber is ${this.state}, expected active`);
    }

    const room = this.room;
    try {
      this.rollbackSubscriptions(room);
    } catch (error) {
      void this.failClosed(room, this.generation);
      throw error;
    }
    this.state = "prepared";
    this.clearMedia(true);
    return true;
  }

  async disconnect(): Promise<void> {
    const room = this.invalidate(true);
    if (room) {
      await safeDisconnect(room);
    }
  }

  private bindRoomEvents(
    room: Room,
    sdk: LiveKit,
    generation: number,
  ): void {
    room.on(
      sdk.RoomEvent.TrackPublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (this.state !== "active" || !this.owns(room, generation)) {
          return;
        }
        try {
          this.subscribeIfAllowed(publication, participant, sdk.Track);
        } catch {
          void this.failClosed(room, generation);
        }
      },
    );
    room.on(
      sdk.RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          this.state !== "active" ||
          !this.owns(room, generation) ||
          participant.identity !== HOST_IDENTITY ||
          !this.desiredTrackSids.has(publication.trackSid)
        ) {
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
        if (this.owns(room, generation) && participant.identity === HOST_IDENTITY) {
          this.removeTrack(publication.trackSid);
        }
      },
    );
    room.on(
      sdk.RoomEvent.TrackUnpublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (this.owns(room, generation) && participant.identity === HOST_IDENTITY) {
          this.desiredTrackSids.delete(publication.trackSid);
          this.removeTrack(publication.trackSid);
        }
      },
    );
    room.on(
      sdk.RoomEvent.ParticipantDisconnected,
      (participant: RemoteParticipant) => {
        if (this.owns(room, generation) && participant.identity === HOST_IDENTITY) {
          this.desiredTrackSids.clear();
          this.clearMedia(true);
        }
      },
    );
    room.on(sdk.RoomEvent.Disconnected, () => {
      if (this.owns(room, generation)) {
        const notify = this.state !== "connecting";
        this.invalidate(true);
        if (notify) {
          this.notifyTerminalDisconnect();
        }
      }
    });
  }

  private subscribeIfAllowed(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    trackType: typeof Track,
  ): void {
    if (
      participant.identity !== HOST_IDENTITY ||
      !isScreenSource(publication.source, trackType)
    ) {
      return;
    }
    this.desiredTrackSids.add(publication.trackSid);
    publication.setSubscribed(true);
  }

  private rollbackSubscriptions(room: Room): void {
    const host = room.remoteParticipants.get(HOST_IDENTITY);
    for (const publication of host?.trackPublications.values() ?? []) {
      if (this.desiredTrackSids.has(publication.trackSid)) {
        publication.setSubscribed(false);
      }
    }
    this.desiredTrackSids.clear();
  }

  private addTrack(
    sid: string,
    source: Track.Source,
    track: MediaStreamTrack,
    trackType: typeof Track,
  ): void {
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

  private emitStream(): void {
    if (!this.video) {
      return;
    }
    const tracks = [this.video.track];
    if (this.audio) {
      tracks.push(this.audio.track);
    }
    this.events.onStream(new MediaStream(tracks));
  }

  private clearMedia(notify: boolean): void {
    const hadVideo = this.video !== null;
    this.video = null;
    this.audio = null;
    if (notify && hadVideo) {
      this.events.onStream(null);
    }
  }

  private ownsGeneration(generation: number): boolean {
    return this.generation === generation && this.state !== "disconnected";
  }

  private owns(room: Room, generation: number): boolean {
    return this.room === room && this.ownsGeneration(generation);
  }

  private invalidate(notifyStream: boolean): Room | null {
    if (this.state === "disconnected") {
      return null;
    }
    ++this.generation;
    this.state = "disconnected";
    const room = this.room;
    this.room = null;
    this.sdk = null;
    this.desiredTrackSids.clear();
    this.clearMedia(notifyStream);
    return room;
  }

  private async failClosed(room: Room, generation: number): Promise<void> {
    if (!this.owns(room, generation)) {
      return;
    }
    this.invalidate(true);
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
}

function isScreenSource(source: Track.Source, trackType: typeof Track): boolean {
  return (
    source === trackType.Source.ScreenShare ||
    source === trackType.Source.ScreenShareAudio
  );
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
