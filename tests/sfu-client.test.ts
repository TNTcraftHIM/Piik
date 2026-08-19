import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SfuPublisher } from "../src/client/sfu/publisher.ts";
import { SfuSubscriber } from "../src/client/sfu/subscriber.ts";

type EventHandler = (...args: unknown[]) => void;

const livekit = vi.hoisted(() => {
  class FakeSender {
    parameters: RTCRtpSendParameters = {
      codecs: [],
      encodings: [{}],
      headerExtensions: [],
      rtcp: { cname: "fake", reducedSize: true },
      transactionId: "fake",
    };

    readonly getParameters = vi.fn(() => this.parameters);
    readonly setParameters = vi.fn(
      async (parameters: RTCRtpSendParameters): Promise<void> => {
        this.parameters = parameters;
      },
    );
  }

  class FakeLocalTrack {
    currentTrack: MediaStreamTrack;
    readonly sender = new FakeSender();

    constructor(track: MediaStreamTrack) {
      this.currentTrack = track;
    }

    readonly replaceTrack = vi.fn(
      async (nextTrack: MediaStreamTrack): Promise<void> => {
        this.currentTrack = nextTrack;
      },
    );
  }

  class FakeLocalParticipant {
    readonly publications: Array<{
      track: FakeLocalTrack;
      videoTrack?: FakeLocalTrack;
      rawTrack: MediaStreamTrack;
      options: Record<string, unknown>;
    }> = [];

    readonly publishTrack = vi.fn(
      async (
        rawTrack: MediaStreamTrack,
        options: Record<string, unknown>,
      ) => {
        const localTrack = new FakeLocalTrack(rawTrack);
        const publication = {
          track: localTrack,
          videoTrack: rawTrack.kind === "video" ? localTrack : undefined,
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

  class FakeRemotePublication {
    readonly setSubscribed = vi.fn((_subscribed: boolean) => undefined);

    constructor(
      readonly trackSid: string,
      readonly source: string,
    ) {}
  }

  class FakeRemoteParticipant {
    readonly trackPublications = new Map<string, FakeRemotePublication>();

    constructor(readonly identity: string) {}

    add(publication: FakeRemotePublication): this {
      this.trackPublications.set(publication.trackSid, publication);
      return this;
    }
  }

  class FakeRoom {
    readonly localParticipant = new FakeLocalParticipant();
    readonly remoteParticipants = new Map<string, FakeRemoteParticipant>();
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
      state.rooms.push(this);
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

  const state: {
    rooms: FakeRoom[];
    connectGate: Promise<void> | null;
  } = {
    rooms: [],
    connectGate: null,
  };

  return {
    FakeRemoteParticipant,
    FakeRemotePublication,
    FakeRoom,
    state,
  };
});

const RoomEvent = {
  Disconnected: "disconnected",
  ParticipantDisconnected: "participant-disconnected",
  TrackPublished: "track-published",
  TrackSubscribed: "track-subscribed",
  TrackUnpublished: "track-unpublished",
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
    return this.tracks.filter((item) => item.kind === "video");
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((item) => item.kind === "audio");
  }
}

const connection = {
  url: "wss://sfu.example.test",
  token: "short-lived-token",
};

const qualityProfile = {
  label: "1080p 60",
  width: 1920,
  height: 1080,
  frameRate: 60,
  maxBitrate: 8_000_000,
} as const;

function track(kind: "video" | "audio", id: string): MediaStreamTrack {
  return { id, kind } as MediaStreamTrack;
}

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return new FakeMediaStream(tracks) as unknown as MediaStream;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  livekit.state.rooms.length = 0;
  livekit.state.connectGate = null;
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SfuPublisher", () => {
  it("prepares a connection without publishing media", async () => {
    const publisher = new SfuPublisher();

    await expect(publisher.connect(connection)).resolves.toBe(true);

    const room = livekit.state.rooms[0];
    expect(room.connect).toHaveBeenCalledWith(connection.url, connection.token, {
      autoSubscribe: false,
    });
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();

    await publisher.disconnect();
    await publisher.disconnect();
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledWith(false);
  });

  it("publishes one screen video and optional audio only while active", async () => {
    const publisher = new SfuPublisher();
    const video = track("video", "video-1");
    const audio = track("audio", "audio-1");
    await publisher.connect(connection);

    await expect(
      publisher.activate(stream(video, audio), qualityProfile),
    ).resolves.toBe(true);

    const room = livekit.state.rooms[0];
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(1, video, {
      source: Track.Source.ScreenShare,
      simulcast: false,
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      degradationPreference: "balanced",
    });
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, audio, {
      source: Track.Source.ScreenShareAudio,
      dtx: false,
    });

    await expect(publisher.deactivate()).resolves.toBe(true);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(2);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("updates the active sender profile without republishing", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const room = livekit.state.rooms[0];
    const videoPublication = room.localParticipant.publications[0];

    await expect(
      publisher.updateProfile({
        label: "720p 30",
        width: 1280,
        height: 720,
        frameRate: 30,
        maxBitrate: 3_000_000,
      }),
    ).resolves.toBe(true);

    expect(videoPublication.track.sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        degradationPreference: "balanced",
        encodings: [
          expect.objectContaining({
            maxBitrate: 3_000_000,
            maxFramerate: 30,
          }),
        ],
      }),
    );
    expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce();
  });

  it("restores the previous video after a partially applied replacement fails", async () => {
    const previousVideo = track("video", "video-1");
    const nextVideo = track("video", "video-2");
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(previousVideo), qualityProfile);
    const localTrack = livekit.state.rooms[0].localParticipant.publications[0].track;
    localTrack.replaceTrack.mockImplementationOnce(async (replacement) => {
      localTrack.currentTrack = replacement;
      throw new Error("sender swap failed after applying");
    });

    await expect(publisher.replaceStream(stream(nextVideo))).resolves.toBe(false);

    expect(localTrack.replaceTrack).toHaveBeenNthCalledWith(1, nextVideo);
    expect(localTrack.replaceTrack).toHaveBeenNthCalledWith(2, previousVideo);
    expect(localTrack.currentTrack).toBe(previousVideo);
  });

  it("disconnects fail-closed when replacement rollback also fails", async () => {
    const disconnected = vi.fn();
    const previousVideo = track("video", "video-1");
    const publisher = new SfuPublisher({ onDisconnected: disconnected });
    await publisher.connect(connection);
    await publisher.activate(stream(previousVideo), qualityProfile);
    const room = livekit.state.rooms[0];
    const localTrack = room.localParticipant.publications[0].track;
    localTrack.replaceTrack
      .mockRejectedValueOnce(new Error("replace failed"))
      .mockRejectedValueOnce(new Error("rollback failed"));

    await expect(
      publisher.replaceStream(stream(track("video", "video-2"))),
    ).rejects.toThrow("rollback failed");
    expect(room.disconnect).toHaveBeenCalledWith(false);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("does not resurrect a stale connection after disconnect", async () => {
    const gate = deferred();
    livekit.state.connectGate = gate.promise;
    const publisher = new SfuPublisher();
    const connecting = publisher.connect(connection);
    await vi.waitFor(() => expect(livekit.state.rooms).toHaveLength(1));
    const room = livekit.state.rooms[0];

    await publisher.disconnect();
    gate.resolve();

    await expect(connecting).resolves.toBe(false);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledOnce();
  });
});

describe("SfuSubscriber", () => {
  it("stays inactive while prepared and selectively subscribes after activation", async () => {
    const gate = deferred();
    livekit.state.connectGate = gate.promise;
    const streams: Array<MediaStream | null> = [];
    const subscriber = new SfuSubscriber({
      onStream: (nextStream) => streams.push(nextStream),
    });
    const connecting = subscriber.connect(connection);
    await vi.waitFor(() => expect(livekit.state.rooms).toHaveLength(1));
    const room = livekit.state.rooms[0];
    const host = new livekit.FakeRemoteParticipant("host");
    const hostVideo = new livekit.FakeRemotePublication(
      "host-video",
      Track.Source.ScreenShare,
    );
    const hostAudio = new livekit.FakeRemotePublication(
      "host-audio",
      Track.Source.ScreenShareAudio,
    );
    const hostCamera = new livekit.FakeRemotePublication(
      "host-camera",
      Track.Source.Camera,
    );
    host.add(hostVideo).add(hostAudio).add(hostCamera);
    room.remoteParticipants.set("host", host);
    const viewer = new livekit.FakeRemoteParticipant("viewer:other");
    const viewerScreen = new livekit.FakeRemotePublication(
      "viewer-screen",
      Track.Source.ScreenShare,
    );
    viewer.add(viewerScreen);
    room.remoteParticipants.set(viewer.identity, viewer);

    gate.resolve();
    await expect(connecting).resolves.toBe(true);
    expect(room.connect).toHaveBeenCalledWith(connection.url, connection.token, {
      autoSubscribe: false,
    });
    expect(hostVideo.setSubscribed).not.toHaveBeenCalled();
    expect(streams).toEqual([]);

    expect(subscriber.activate()).toBe(true);
    expect(hostVideo.setSubscribed).toHaveBeenCalledWith(true);
    expect(hostAudio.setSubscribed).toHaveBeenCalledWith(true);
    expect(hostCamera.setSubscribed).not.toHaveBeenCalled();
    expect(viewerScreen.setSubscribed).not.toHaveBeenCalled();

    const audio = track("audio", "audio-1");
    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: audio },
      hostAudio,
      host,
    );
    expect(streams).toEqual([]);

    const video = track("video", "video-1");
    room.emit(
      RoomEvent.TrackSubscribed,
      { mediaStreamTrack: video },
      hostVideo,
      host,
    );
    expect(streams.at(-1)?.getTracks()).toEqual([video, audio]);

    expect(subscriber.deactivate()).toBe(true);
    expect(hostVideo.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(hostAudio.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(streams.at(-1)).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("notifies the controller after a terminal room disconnect", async () => {
    const disconnected = vi.fn();
    const subscriber = new SfuSubscriber({
      onStream: vi.fn(),
      onDisconnected: disconnected,
    });
    await subscriber.connect(connection);
    const room = livekit.state.rooms[0];

    room.emit(RoomEvent.Disconnected);
    room.emit(RoomEvent.Disconnected);

    expect(disconnected).toHaveBeenCalledOnce();
    expect(subscriber.deactivate()).toBe(false);
  });

  it("does not activate a stale connection after disconnect", async () => {
    const gate = deferred();
    livekit.state.connectGate = gate.promise;
    const subscriber = new SfuSubscriber({ onStream: vi.fn() });
    const connecting = subscriber.connect(connection);
    await vi.waitFor(() => expect(livekit.state.rooms).toHaveLength(1));
    const room = livekit.state.rooms[0];

    await subscriber.disconnect();
    await subscriber.disconnect();
    gate.resolve();

    await expect(connecting).resolves.toBe(false);
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(() => subscriber.activate()).toThrow("expected prepared");
  });
});
