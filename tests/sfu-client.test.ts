import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SfuPublisher } from "../src/client/sfu/publisher.ts";
import { SfuSubscriber } from "../src/client/sfu/subscriber.ts";

type EventHandler = (...args: unknown[]) => void;

const livekit = vi.hoisted(() => {
  const rooms: FakeRoom[] = [];
  const state: { connectGate: Promise<void> | null } = { connectGate: null };

  class FakeLocalTrack {
    currentTrack: MediaStreamTrack;

    constructor(track: MediaStreamTrack) {
      this.currentTrack = track;
    }

    readonly replaceTrack = vi.fn(
      async (track: MediaStreamTrack): Promise<void> => {
        this.currentTrack = track;
      },
    );
  }

  class FakeLocalParticipant {
    readonly publications: Array<{
      track: FakeLocalTrack;
      rawTrack: MediaStreamTrack;
      options: Record<string, unknown>;
    }> = [];

    readonly publishTrack = vi.fn(
      async (
        rawTrack: MediaStreamTrack,
        options: Record<string, unknown>,
      ) => {
        const publication = {
          track: new FakeLocalTrack(rawTrack),
          rawTrack,
          options,
        };
        this.publications.push(publication);
        return publication;
      },
    );

    readonly unpublishTrack = vi.fn(
      async (_track: FakeLocalTrack, _stopOnUnpublish: boolean) => undefined,
    );
  }

  class FakeRoom {
    readonly localParticipant = new FakeLocalParticipant();
    readonly remoteParticipants = new Map<string, {
      identity: string;
      trackPublications: Map<string, unknown>;
    }>();
    readonly handlers = new Map<string, EventHandler[]>();
    readonly connect = vi.fn(
      async (
        _url: string,
        _token: string,
        _options: Record<string, unknown>,
      ): Promise<void> => {
        await state.connectGate;
      },
    );
    readonly disconnect = vi.fn(async (_stopTracks?: boolean) => undefined);

    constructor() {
      rooms.push(this);
    }

    on(event: string, handler: EventHandler): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return { FakeRoom, rooms, state };
});

const RoomEvent = {
  Disconnected: "disconnected",
  ParticipantDisconnected: "participant-disconnected",
  TrackSubscribed: "track-subscribed",
  TrackUnsubscribed: "track-unsubscribed",
} as const;

const Track = {
  Source: {
    Camera: "camera",
    ScreenShare: "screen-share",
    ScreenShareAudio: "screen-share-audio",
  },
} as const;

vi.mock("livekit-client", () => ({
  Room: livekit.FakeRoom,
  RoomEvent,
  Track,
}));

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[] = []) {}

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

function track(kind: "video" | "audio", id: string): MediaStreamTrack {
  return { id, kind } as MediaStreamTrack;
}

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return new FakeMediaStream(tracks) as unknown as MediaStream;
}

const qualityProfile = {
  label: "1080p 60",
  width: 1920,
  height: 1080,
  frameRate: 60,
  maxBitrate: 8_000_000,
} as const;

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  livekit.rooms.length = 0;
  livekit.state.connectGate = null;
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SfuPublisher", () => {
  it("publishes raw screen tracks without simulcast or audio DTX", async () => {
    const video = track("video", "video-1");
    const audio = track("audio", "audio-1");
    const publisher = new SfuPublisher();

    await publisher.connect(
      { url: "wss://sfu.example.test", token: "publisher-token" },
      stream(video, audio),
      qualityProfile,
    );

    const room = livekit.rooms[0];
    expect(room.connect).toHaveBeenCalledWith(
      "wss://sfu.example.test",
      "publisher-token",
      { autoSubscribe: false },
    );
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      video,
      {
        source: Track.Source.ScreenShare,
        simulcast: false,
        screenShareEncoding: {
          maxBitrate: 8_000_000,
          maxFramerate: 60,
        },
        degradationPreference: "maintain-framerate",
      },
    );
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      2,
      audio,
      { source: Track.Source.ScreenShareAudio, dtx: false },
    );

    publisher.disconnect();
    expect(room.disconnect).toHaveBeenCalledWith(false);
  });

  it("does not continue a source replacement after disconnect", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(
      { url: "wss://sfu.example.test", token: "publisher-token" },
      stream(track("video", "video-1"), track("audio", "audio-1")),
      qualityProfile,
    );
    const room = livekit.rooms[0];
    const videoReplacement = deferred();
    room.localParticipant.publications[0].track.replaceTrack.mockImplementationOnce(
      () => videoReplacement.promise,
    );

    const replacing = publisher.replaceStream(
      stream(track("video", "video-2"), track("audio", "audio-2")),
    );
    publisher.disconnect();
    videoReplacement.resolve();

    await expect(replacing).resolves.toBe(false);
    expect(
      room.localParticipant.publications[1].track.replaceTrack,
    ).not.toHaveBeenCalled();
  });

  it("restores the previous video after a partially committed replacement fails", async () => {
    const previousVideo = track("video", "video-1");
    const nextVideo = track("video", "video-2");
    const publisher = new SfuPublisher();
    await publisher.connect(
      { url: "wss://sfu.example.test", token: "publisher-token" },
      stream(previousVideo),
      qualityProfile,
    );
    const localTrack = livekit.rooms[0].localParticipant.publications[0].track;
    localTrack.replaceTrack.mockImplementationOnce(async (replacement) => {
      localTrack.currentTrack = replacement;
      throw new Error("encoding update failed after sender swap");
    });

    await expect(publisher.replaceStream(stream(nextVideo))).resolves.toBe(false);
    expect(localTrack.replaceTrack).toHaveBeenNthCalledWith(1, nextVideo);
    expect(localTrack.replaceTrack).toHaveBeenNthCalledWith(2, previousVideo);
    expect(localTrack.currentTrack).toBe(previousVideo);
  });

  it("does not publish when stopped while the SFU connection is pending", async () => {
    const connectGate = deferred();
    livekit.state.connectGate = connectGate.promise;
    const publisher = new SfuPublisher();

    const connecting = publisher.connect(
      { url: "wss://sfu.example.test", token: "publisher-token" },
      stream(track("video", "video-1"), track("audio", "audio-1")),
      qualityProfile,
    );
    await vi.waitFor(() => expect(livekit.rooms).toHaveLength(1));
    const room = livekit.rooms[0];
    await vi.waitFor(() => expect(room.connect).toHaveBeenCalledOnce());

    publisher.disconnect();
    connectGate.resolve();
    await connecting;

    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
  });

  it("adds and removes screen-share audio while replacing the source", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(
      { url: "wss://sfu.example.test", token: "publisher-token" },
      stream(track("video", "video-1")),
      qualityProfile,
    );
    const room = livekit.rooms[0];
    const nextAudio = track("audio", "audio-2");

    await expect(
      publisher.replaceStream(
        stream(track("video", "video-2"), nextAudio),
      ),
    ).resolves.toBe(true);
    expect(room.localParticipant.publishTrack).toHaveBeenLastCalledWith(
      nextAudio,
      { source: Track.Source.ScreenShareAudio, dtx: false },
    );
    const audioPublication = room.localParticipant.publications[1];

    await expect(
      publisher.replaceStream(stream(track("video", "video-3"))),
    ).resolves.toBe(true);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(
      audioPublication.track,
      false,
    );
  });
});

describe("SfuSubscriber", () => {
  it("accepts only host screen tracks and stays connected while media is cleared", async () => {
    const streams: Array<MediaStream | null> = [];
    const subscriber = new SfuSubscriber({
      onStream: (nextStream) => streams.push(nextStream),
    });
    await subscriber.connect({
      url: "wss://sfu.example.test",
      token: "subscriber-token",
    });
    const room = livekit.rooms[0];
    const video = track("video", "video-1");
    const audio = track("audio", "audio-1");

    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: video },
      { trackSid: "camera", source: Track.Source.Camera },
      { identity: "host" },
    );
    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: video },
      { trackSid: "viewer-screen", source: Track.Source.ScreenShare },
      { identity: "viewer:other" },
    );
    expect(streams).toEqual([]);

    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: video },
      { trackSid: "host-video", source: Track.Source.ScreenShare },
      { identity: "host" },
    );
    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: audio },
      { trackSid: "host-audio", source: Track.Source.ScreenShareAudio },
      { identity: "host" },
    );
    expect(streams.at(-1)?.getTracks()).toEqual([video, audio]);

    subscriber.clearMedia();
    expect(streams.at(-1)).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();

    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: video },
      { trackSid: "host-video", source: Track.Source.ScreenShare },
      { identity: "host" },
    );
    expect(streams.at(-1)).toBeNull();

    const nextVideo = track("video", "video-2");
    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: nextVideo },
      { trackSid: "host-video-2", source: Track.Source.ScreenShare },
      { identity: "host" },
    );
    expect(streams.at(-1)?.getTracks()).toEqual([nextVideo]);
  });
});
