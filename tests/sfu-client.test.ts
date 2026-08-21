import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SfuPublisher } from "../src/client/sfu/publisher.ts";
import { SfuSubscriber } from "../src/client/sfu/subscriber.ts";
import type { ConnectionMetrics } from "../src/client/types.ts";
import { mergeStatsReports } from "../src/client/webrtc/stats.ts";

type EventHandler = (...args: unknown[]) => void;

const livekit = vi.hoisted(() => {
  class FakeVideoPreset {
    readonly encoding: {
      maxBitrate: number;
      maxFramerate?: number;
    };

    constructor(
      readonly width: number,
      readonly height: number,
      maxBitrate: number,
      maxFramerate?: number,
    ) {
      this.encoding = { maxBitrate, maxFramerate };
    }

    get resolution(): { width: number; height: number; frameRate?: number } {
      return {
        width: this.width,
        height: this.height,
        frameRate: this.encoding.maxFramerate,
      };
    }
  }

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
        const failure = state.nextSenderParameterError;
        if (failure) {
          state.nextSenderParameterError = null;
          throw failure;
        }
        this.parameters = parameters;
      },
    );
  }

  class FakeLocalTrack {
    currentTrack: MediaStreamTrack;
    readonly sender = new FakeSender();
    publishOptions?: Record<string, unknown>;
    savedDegradationPreference: RTCDegradationPreference | null = null;

    constructor(track: MediaStreamTrack) {
      this.currentTrack = track;
    }

    readonly replaceTrack = vi.fn(
      async (nextTrack: MediaStreamTrack): Promise<void> => {
        this.currentTrack = nextTrack;
      },
    );

    readonly setDegradationPreference = vi.fn(
      async (preference: RTCDegradationPreference): Promise<void> => {
        this.savedDegradationPreference = preference;
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
        localTrack.publishOptions = options;
        const simulcastLayers = options.screenShareSimulcastLayers;
        const highEncoding = options.screenShareEncoding;
        if (
          rawTrack.kind === "video" &&
          options.simulcast === true &&
          Array.isArray(simulcastLayers) &&
          simulcastLayers.length === 1 &&
          simulcastLayers[0] instanceof FakeVideoPreset &&
          typeof highEncoding === "object" &&
          highEncoding !== null
        ) {
          const high = highEncoding as {
            maxBitrate?: number;
            maxFramerate?: number;
          };
          localTrack.sender.parameters.encodings = [
            {
              rid: "q",
              maxBitrate: simulcastLayers[0].encoding.maxBitrate,
              maxFramerate: simulcastLayers[0].encoding.maxFramerate,
              scaleResolutionDownBy: 2,
            },
            {
              rid: "h",
              maxBitrate: high.maxBitrate,
              maxFramerate: high.maxFramerate,
              scaleResolutionDownBy: 1,
            },
          ];
        }
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

    republishedOptions: Array<Record<string, unknown>> = [];
    readonly republishAllTracks = vi.fn(async (): Promise<void> => {
      this.republishedOptions = this.publications.map((publication) => ({
        ...publication.options,
      }));
    });

    readonly unpublishTrack = vi.fn(
      async (_track: FakeLocalTrack, _stopOnUnpublish: boolean) => undefined,
    );
  }

  class FakeRemotePublication {
    subscribed = false;
    requestedVideoQuality: string | null = null;
    readonly setSubscribed = vi.fn((subscribed: boolean) => {
      this.subscribed = subscribed;
    });
    readonly setVideoQuality = vi.fn((quality: string) => {
      if (this.subscribed) {
        this.requestedVideoQuality = quality;
      }
    });

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

    constructor(readonly options: Record<string, unknown> = {}) {
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
    nextSenderParameterError: Error | null;
  } = {
    rooms: [],
    connectGate: null,
    nextSenderParameterError: null,
  };

  return {
    FakeRemoteParticipant,
    FakeRemotePublication,
    FakeRoom,
    FakeVideoPreset,
    state,
  };
});

const RoomEvent = {
  Disconnected: "disconnected",
  ParticipantDisconnected: "participant-disconnected",
  Reconnected: "reconnected",
  Reconnecting: "reconnecting",
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

const VideoQuality = {
  HIGH: "high",
} as const;

vi.mock("livekit-client", () => ({
  Room: livekit.FakeRoom,
  RoomEvent,
  Track,
  VideoPreset: livekit.FakeVideoPreset,
  VideoQuality,
}));

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[] = []) {}

  addTrack(track: MediaStreamTrack): void {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack): void {
    const index = this.tracks.indexOf(track);
    if (index >= 0) this.tracks.splice(index, 1);
  }

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
  resolution: "1080p",
  maxFramerate: 60,
  maxBitrate: 8_000_000,
  degradationPreference: "maintain-resolution",
} as const;

function track(kind: "video" | "audio", id: string): MediaStreamTrack {
  return Object.assign(new EventTarget(), { id, kind }) as MediaStreamTrack;
}

function remoteTrack(
  mediaStreamTrack: MediaStreamTrack,
  getStats: () => RTCStatsReport | Promise<RTCStatsReport> = () =>
    new Map() as unknown as RTCStatsReport,
) {
  return {
    mediaStreamTrack,
    getRTCStatsReport: vi.fn(async () => getStats()),
  };
}

function statsReport(
  records: Array<Record<string, unknown> & { id: string }>,
): RTCStatsReport {
  return new Map(
    records.map((record) => [record.id, record]),
  ) as unknown as RTCStatsReport;
}

function receiverReport(kind: "video" | "audio"): RTCStatsReport {
  return statsReport([
    {
      id: `${kind}-in`,
      type: "inbound-rtp",
      timestamp: 1_000,
      kind,
      trackIdentifier: `${kind}-1`,
    },
  ]);
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
  livekit.state.nextSenderParameterError = null;
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: vi.fn(() => ({
      codecs: [
        { mimeType: "video/VP8", clockRate: 90_000 },
        { mimeType: "video/H264", clockRate: 90_000 },
      ],
      headerExtensions: [],
    })),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SfuPublisher", () => {
  it("prepares a connection without publishing media", async () => {
    const publisher = new SfuPublisher();

    await expect(publisher.connect(connection)).resolves.toBe(true);

    const room = livekit.state.rooms[0];
    expect(room.options).toEqual({});
    expect(room.connect).toHaveBeenCalledWith(connection.url, connection.token, {
      autoSubscribe: false,
    });
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();

    await publisher.disconnect();
    await publisher.disconnect();
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledWith(false);
  });

  it("passes a controller-selected relay-only RTC configuration to LiveKit", async () => {
    const iceServer = {
      urls: ["turn:relay.example.test:3478?transport=udp"],
      username: `1787076000:${"a".repeat(32)}`,
      credential: "short-lived-credential",
    };
    const publisher = new SfuPublisher();

    await expect(
      publisher.connect({
        ...connection,
        rtcConfig: {
          iceServers: [iceServer],
          iceTransportPolicy: "relay",
        },
      }),
    ).resolves.toBe(true);

    expect(livekit.state.rooms[0].connect).toHaveBeenCalledWith(
      connection.url,
      connection.token,
      {
        autoSubscribe: false,
        rtcConfig: {
          iceServers: [iceServer],
          iceTransportPolicy: "relay",
        },
      },
    );
  });

  it("retains the bounded stage after connection setup fails", async () => {
    livekit.state.connectGate = Promise.reject(new Error("connect failed"));
    const publisher = new SfuPublisher();

    await expect(publisher.connect(connection)).rejects.toThrow("connect failed");

    expect(publisher.getFailureStage()).toBe("connect");
    expect(livekit.state.rooms[0]?.disconnect).toHaveBeenCalledWith(false);
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
    const sender = room.localParticipant.publications[0].track.sender;
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(1, video, {
      source: Track.Source.ScreenShare,
      backupCodec: false,
      videoCodec: "h264",
      simulcast: true,
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      screenShareSimulcastLayers: [
        expect.objectContaining({
          width: 960,
          height: 540,
          encoding: {
            maxBitrate: 2_000_000,
            maxFramerate: 60,
          },
        }),
      ],
      degradationPreference: "maintain-resolution",
    });
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: 128_000 },
      dtx: false,
    });
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(sender.parameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        maxBitrate: 2_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 2,
      }),
      expect.objectContaining({
        rid: "h",
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      }),
    ]);
    expect(publisher.getSenderParameters()).toEqual({
      requested: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
        degradationPreference: "maintain-resolution",
        scalabilityMode: null,
      },
      applied: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
        degradationPreference: "maintain-resolution",
        scalabilityMode: null,
      },
      mismatches: [],
    });

    await expect(publisher.deactivate()).resolves.toBe(true);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(2);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("keeps VP8 for SFU publication when H.264 send capability is absent", async () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: vi.fn(() => ({
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        headerExtensions: [],
      })),
    });
    const publisher = new SfuPublisher();
    await publisher.connect(connection);

    await expect(
      publisher.activate(stream(track("video", "video-1")), qualityProfile),
    ).resolves.toBe(true);

    expect(
      livekit.state.rooms[0].localParticipant.publications[0].options,
    ).toMatchObject({ videoCodec: "vp8", backupCodec: false });
  });

  it("fails closed when initial sender configuration is rejected", async () => {
    const disconnected = vi.fn();
    const publisher = new SfuPublisher({ onDisconnected: disconnected });
    await publisher.connect(connection);
    livekit.state.nextSenderParameterError = new Error("parameters rejected");

    await expect(
      publisher.activate(stream(track("video", "video-1")), qualityProfile),
    ).rejects.toThrow("parameters rejected");

    expect(livekit.state.rooms[0].disconnect).toHaveBeenCalledWith(false);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(publisher.getSenderParameters()).toBeNull();
    expect(publisher.getFailureStage()).toBe("sender-config");
  });

  it("records an unexpected active transport disconnect", async () => {
    const disconnected = vi.fn();
    const publisher = new SfuPublisher({ onDisconnected: disconnected });
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);

    livekit.state.rooms[0].emit(RoomEvent.Disconnected);

    expect(publisher.getFailureStage()).toBe("transport");
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("updates the active sender profile without republishing", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const room = livekit.state.rooms[0];
    const videoPublication = room.localParticipant.publications[0];

    await expect(
      publisher.updateProfile({
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        degradationPreference: "balanced",
      }),
    ).resolves.toBe(true);

    expect(videoPublication.track.sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        degradationPreference: "balanced",
        encodings: [
          expect.objectContaining({
            rid: "q",
            maxBitrate: 750_000,
            maxFramerate: 30,
            scaleResolutionDownBy: 2,
          }),
          expect.objectContaining({
            rid: "h",
            maxBitrate: 3_000_000,
            maxFramerate: 30,
            scaleResolutionDownBy: 1,
          }),
        ],
      }),
    );
    expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce();
    expect(publisher.getQualityWarning()).toBeNull();
  });

  it("retains the active profile for LiveKit track restart and republish", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const publication = livekit.state.rooms[0].localParticipant.publications[0];
    const localTrack = publication.track;

    await expect(
      publisher.updateProfile({
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        degradationPreference: "maintain-framerate",
      }),
    ).resolves.toBe(true);

    expect(localTrack.setDegradationPreference).toHaveBeenLastCalledWith(
      "maintain-framerate",
    );
    expect(
      localTrack.setDegradationPreference.mock.invocationCallOrder.at(-1)!,
    ).toBeLessThan(
      localTrack.sender.setParameters.mock.invocationCallOrder.at(-1)!,
    );
    expect(localTrack.savedDegradationPreference).toBe("maintain-framerate");
    expect(localTrack.sender.parameters).toMatchObject({
      degradationPreference: "maintain-framerate",
      encodings: [
        {
          rid: "q",
          maxBitrate: 750_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 2,
        },
        {
          rid: "h",
          maxBitrate: 3_000_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 1,
        },
      ],
    });
    expect(localTrack.publishOptions).toBe(publication.options);
    expect(publication.options).toMatchObject({
      source: Track.Source.ScreenShare,
      backupCodec: false,
      videoCodec: "h264",
      screenShareEncoding: {
        maxBitrate: 3_000_000,
        maxFramerate: 30,
      },
      degradationPreference: "maintain-framerate",
    });

    await livekit.state.rooms[0].localParticipant.republishAllTracks();
    expect(
      livekit.state.rooms[0].localParticipant.republishedOptions[0],
    ).toMatchObject({
      screenShareEncoding: {
        maxBitrate: 3_000_000,
        maxFramerate: 30,
      },
      degradationPreference: "maintain-framerate",
    });
  });

  it("restores LiveKit retained state when saving a new profile fails", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const publication = livekit.state.rooms[0].localParticipant.publications[0];
    const localTrack = publication.track;
    localTrack.setDegradationPreference.mockRejectedValueOnce(
      new Error("preference save failed"),
    );

    await expect(
      publisher.updateProfile({
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        degradationPreference: "maintain-framerate",
      }),
    ).resolves.toBe(false);

    expect(localTrack.setDegradationPreference).toHaveBeenLastCalledWith(
      "maintain-resolution",
    );
    expect(localTrack.savedDegradationPreference).toBe("maintain-resolution");
    expect(localTrack.publishOptions).toBe(publication.options);
    expect(publication.options).toMatchObject({
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      degradationPreference: "maintain-resolution",
    });
    expect(publisher.getSenderParameters()?.applied).toMatchObject({
      maxBitrate: 8_000_000,
      maxFramerate: 60,
      degradationPreference: "maintain-resolution",
    });
    expect(publisher.getQualityWarning()).toContain("preference save failed");
  });

  it("does not retain an update from a disconnected publisher generation", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const localTrack = livekit.state.rooms[0].localParticipant.publications[0].track;
    const publication = livekit.state.rooms[0].localParticipant.publications[0];
    const gate = deferred();
    localTrack.setDegradationPreference.mockImplementationOnce(
      async (preference) => {
        await gate.promise;
        localTrack.savedDegradationPreference = preference;
      },
    );

    const updating = publisher.updateProfile({
      resolution: "720p",
      maxFramerate: 30,
      maxBitrate: 3_000_000,
      degradationPreference: "maintain-framerate",
    });
    await vi.waitFor(() =>
      expect(localTrack.setDegradationPreference).toHaveBeenCalledTimes(2),
    );
    await publisher.disconnect();
    gate.resolve();

    await expect(updating).resolves.toBe(false);
    expect(publisher.getSenderParameters()).toBeNull();
    expect(publisher.getQualityWarning()).toBeNull();
    expect(localTrack.savedDegradationPreference).toBe("maintain-resolution");
    expect(localTrack.sender.setParameters).toHaveBeenCalledTimes(1);
    expect(publication.options).toMatchObject({
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      degradationPreference: "maintain-resolution",
    });
  });

  it("retains a visible warning when the SFU sender rewrites a parameter", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const sender = livekit.state.rooms[0].localParticipant.publications[0].track
      .sender;
    sender.setParameters.mockImplementationOnce(async (parameters) => {
      sender.parameters = {
        ...parameters,
        encodings: parameters.encodings.map((encoding) => ({
          ...encoding,
          maxBitrate: 2_000_000,
        })),
      };
    });

    await expect(
      publisher.updateProfile({
        resolution: "1080p",
        maxFramerate: 30,
        maxBitrate: 5_000_000,
        degradationPreference: "balanced",
      }),
    ).resolves.toBe(true);

    expect(publisher.getQualityWarning()).toContain("码率上限");
  });

  it("reports a LOW rewrite while retaining HIGH sender readback", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const sender = livekit.state.rooms[0].localParticipant.publications[0].track
      .sender;
    sender.setParameters.mockImplementationOnce(async (parameters) => {
      sender.parameters = {
        ...parameters,
        encodings: parameters.encodings.map((encoding, index) =>
          index === 0
            ? { ...encoding, maxBitrate: 200_000 }
            : { ...encoding },
        ),
      };
    });

    await expect(
      publisher.updateProfile({
        resolution: "1080p",
        maxFramerate: 30,
        maxBitrate: 5_000_000,
        degradationPreference: "balanced",
      }),
    ).resolves.toBe(true);

    expect(publisher.getSenderParameters()).toMatchObject({
      requested: { maxBitrate: 5_000_000 },
      applied: { maxBitrate: 5_000_000 },
      mismatches: [],
    });
    expect(publisher.getQualityWarning()).toContain("低档表示");
    expect(publisher.getQualityWarning()).toContain("码率上限");
  });

  it("retains a visible warning when SFU sender parameters are rejected", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const publication = livekit.state.rooms[0].localParticipant.publications[0];
    const localTrack = publication.track;
    const sender = localTrack.sender;
    sender.setParameters.mockRejectedValueOnce(new Error("unsupported"));

    await expect(
      publisher.updateProfile({
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        degradationPreference: "maintain-framerate",
      }),
    ).resolves.toBe(false);

    expect(localTrack.setDegradationPreference).toHaveBeenLastCalledWith(
      "maintain-resolution",
    );
    expect(localTrack.savedDegradationPreference).toBe("maintain-resolution");
    expect(publication.options).toMatchObject({
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      degradationPreference: "maintain-resolution",
    });
    expect(sender.parameters).toMatchObject({
      degradationPreference: "maintain-resolution",
      encodings: [
        expect.objectContaining({
          rid: "q",
          maxBitrate: 2_000_000,
          maxFramerate: 60,
        }),
        expect.objectContaining({
          rid: "h",
          maxBitrate: 8_000_000,
          maxFramerate: 60,
        }),
      ],
    });
    expect(publisher.getQualityWarning()).toBe(
      "应用 SFU 发送参数失败：unsupported",
    );
  });

  it("retains a LOW rewrite warning after rolling back sender parameters", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const sender = livekit.state.rooms[0].localParticipant.publications[0].track
      .sender;
    sender.setParameters
      .mockRejectedValueOnce(new Error("unsupported"))
      .mockImplementationOnce(async (parameters) => {
        sender.parameters = {
          ...parameters,
          encodings: parameters.encodings.map((encoding, index) =>
            index === 0
              ? { ...encoding, maxBitrate: 1_500_000 }
              : { ...encoding },
          ),
        };
      });

    await expect(
      publisher.updateProfile({
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 3_000_000,
        degradationPreference: "balanced",
      }),
    ).resolves.toBe(false);

    expect(publisher.getSenderParameters()).toMatchObject({
      requested: { maxBitrate: 8_000_000 },
      applied: { maxBitrate: 8_000_000 },
      mismatches: [],
    });
    expect(publisher.getQualityWarning()).toContain(
      "应用 SFU 发送参数失败：unsupported",
    );
    expect(publisher.getQualityWarning()).toContain("低档表示");
    expect(publisher.getQualityWarning()).toContain("码率上限");
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

  it("uses the screen audio preset when a replacement adds audio", async () => {
    const publisher = new SfuPublisher();
    const audio = track("audio", "audio-2");
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const room = livekit.state.rooms[0];

    await expect(
      publisher.replaceStream(stream(track("video", "video-2"), audio)),
    ).resolves.toBe(true);

    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: 128_000 },
      dtx: false,
    });
  });

  it("reapplies and retains the current sender settings after replacing video", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(track("video", "video-1")), qualityProfile);
    const localTrack = livekit.state.rooms[0].localParticipant.publications[0].track;

    await expect(
      publisher.replaceStream(stream(track("video", "video-2"))),
    ).resolves.toBe(true);

    expect(localTrack.sender.setParameters).toHaveBeenCalledTimes(2);
    expect(publisher.getSenderParameters()?.requested).toMatchObject({
      maxBitrate: 8_000_000,
      maxFramerate: 60,
      degradationPreference: "maintain-resolution",
    });
  });

  it("restores sender settings when replacement configuration is rejected", async () => {
    const previousVideo = track("video", "video-1");
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(stream(previousVideo), qualityProfile);
    const localTrack = livekit.state.rooms[0].localParticipant.publications[0].track;
    localTrack.sender.setParameters.mockRejectedValueOnce(
      new Error("replacement parameters rejected"),
    );

    await expect(
      publisher.replaceStream(stream(track("video", "video-2"))),
    ).resolves.toBe(false);

    expect(localTrack.replaceTrack).toHaveBeenCalledTimes(2);
    expect(localTrack.currentTrack).toBe(previousVideo);
    expect(localTrack.sender.setParameters).toHaveBeenCalledTimes(3);
    expect(publisher.getSenderParameters()?.applied.maxBitrate).toBe(8_000_000);
    expect(publisher.getQualityWarning()).toBe(
      "切换 SFU 分享来源失败：replacement parameters rejected",
    );
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

    hostVideo.setVideoQuality(VideoQuality.HIGH);
    expect(hostVideo.requestedVideoQuality).toBeNull();
    hostVideo.setVideoQuality.mockClear();

    expect(subscriber.activate()).toBe(true);
    expect(hostVideo.setSubscribed).toHaveBeenCalledWith(true);
    expect(hostAudio.setSubscribed).toHaveBeenCalledWith(true);
    expect(hostVideo.setVideoQuality).toHaveBeenCalledWith(VideoQuality.HIGH);
    expect(hostVideo.requestedVideoQuality).toBe(VideoQuality.HIGH);
    expect(hostVideo.setSubscribed.mock.invocationCallOrder[0]).toBeLessThan(
      hostVideo.setVideoQuality.mock.invocationCallOrder[0]!,
    );
    expect(hostAudio.setVideoQuality).not.toHaveBeenCalled();
    expect(hostCamera.setSubscribed).not.toHaveBeenCalled();
    expect(viewerScreen.setSubscribed).not.toHaveBeenCalled();

    const audio = track("audio", "audio-1");
    room.emit(
      RoomEvent.TrackSubscribed,
      remoteTrack(audio),
      hostAudio,
      host,
    );
    expect(streams).toEqual([]);

    const video = track("video", "video-1");
    room.emit(
      RoomEvent.TrackSubscribed,
      remoteTrack(video),
      hostVideo,
      host,
    );
    expect(streams.at(-1)?.getVideoTracks()).toEqual([video]);
    expect(streams.at(-1)?.getAudioTracks()).toEqual([audio]);

    expect(subscriber.deactivate()).toBe(true);
    expect(hostVideo.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(hostAudio.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(streams.at(-1)).toBeNull();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("keeps one stream while video-first tracks change", async () => {
    const streams: Array<MediaStream | null> = [];
    const availability: boolean[] = [];
    const subscriber = new SfuSubscriber({
      onStream: (nextStream) => streams.push(nextStream),
      onVideoAvailability: (available) => availability.push(available),
    });
    await subscriber.connect(connection);
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
    host.add(hostVideo).add(hostAudio);
    room.remoteParticipants.set("host", host);
    expect(subscriber.activate()).toBe(true);
    const video = track("video", "video-1");
    room.emit(RoomEvent.TrackSubscribed, remoteTrack(video), hostVideo, host);
    const stableStream = streams.at(-1);
    expect(stableStream?.getTracks()).toEqual([video]);
    expect(availability).toEqual([true]);
    const audio = track("audio", "audio-1");
    room.emit(RoomEvent.TrackSubscribed, remoteTrack(audio), hostAudio, host);
    expect(streams.at(-1)).toBe(stableStream);
    expect(stableStream?.getAudioTracks()).toEqual([audio]);
    const callbacksBeforeReplacement = streams.length;
    const replacement = track("video", "video-2");
    room.emit(RoomEvent.TrackSubscribed, remoteTrack(replacement), hostVideo, host);
    expect(streams).toHaveLength(callbacksBeforeReplacement + 1);
    expect(streams.at(-1)).toBe(stableStream);
    expect(stableStream?.getVideoTracks()).toEqual([replacement]);
    video.dispatchEvent(new Event("ended"));
    expect(stableStream?.getVideoTracks()).toEqual([replacement]);
    expect(availability).toEqual([true]);
    replacement.dispatchEvent(new Event("ended"));
    expect(stableStream?.getVideoTracks()).toEqual([]);
    expect(streams).toHaveLength(callbacksBeforeReplacement + 1);
    expect(availability).toEqual([true, false]);

    const recovered = track("video", "video-3");
    room.emit(RoomEvent.TrackSubscribed, remoteTrack(recovered), hostVideo, host);
    expect(streams.at(-1)).toBe(stableStream);
    expect(stableStream?.getVideoTracks()).toEqual([recovered]);
    expect(availability).toEqual([true, false, true]);
  });

  it.each(["unsubscribed", "unpublished", "host-disconnected"] as const)(
    "reports the last video unavailable when it is %s",
    async (loss) => {
      const availability: boolean[] = [];
      const subscriber = new SfuSubscriber({
        onStream: vi.fn(),
        onVideoAvailability: (available) => availability.push(available),
      });
      await subscriber.connect(connection);
      const room = livekit.state.rooms[0];
      const host = new livekit.FakeRemoteParticipant("host");
      const publication = new livekit.FakeRemotePublication(
        "host-video",
        Track.Source.ScreenShare,
      );
      host.add(publication);
      room.remoteParticipants.set("host", host);
      subscriber.activate();
      const video = track("video", "video-1");
      const remoteVideo = remoteTrack(video);
      room.emit(RoomEvent.TrackSubscribed, remoteVideo, publication, host);
      availability.length = 0;

      if (loss === "unsubscribed") {
        room.emit(RoomEvent.TrackUnsubscribed, remoteVideo, publication, host);
      } else if (loss === "unpublished") {
        room.emit(RoomEvent.TrackUnpublished, publication, host);
      } else {
        room.emit(RoomEvent.ParticipantDisconnected, host);
      }

      expect(availability).toEqual([false]);
    },
  );

  it("reports merged receiver stats and drops a stale sample", async () => {
    const updates: ConnectionMetrics[] = [];
    const states: string[] = [];
    const subscriber = new SfuSubscriber({
      onStream: vi.fn(),
      onStats: (metrics) => updates.push(metrics),
      onState: (state) => states.push(state),
    });
    await subscriber.connect(connection);
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
    host.add(hostVideo).add(hostAudio);
    room.remoteParticipants.set("host", host);
    expect(subscriber.activate()).toBe(true);

    const reports = {
      video: receiverReport("video"),
      audio: receiverReport("audio"),
    };
    expect(
      Array.from(mergeStatsReports([reports.video, reports.audio])!.keys()),
    ).toEqual(["video-in", "audio-in"]);
    const video = track("video", "video-1");
    const audio = track("audio", "audio-1");
    let videoStats: RTCStatsReport | Promise<RTCStatsReport> = reports.video;
    const remoteVideo = remoteTrack(video, () => videoStats);
    room.emit(
      RoomEvent.TrackSubscribed,
      remoteTrack(audio, () => reports.audio),
      hostAudio,
      host,
    );
    room.emit(
      RoomEvent.TrackSubscribed,
      remoteVideo,
      hostVideo,
      host,
    );
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(updates.at(-1)).toMatchObject({
      rtpStatsId: "video-in",
      trackIdentifier: "video-1",
    });

    let releaseStats = (): void => undefined;
    videoStats = new Promise<RTCStatsReport>((resolve) => {
      releaseStats = () => resolve(reports.video);
    });
    room.emit(RoomEvent.Reconnecting);
    room.emit(RoomEvent.Reconnected);
    expect(states).toEqual(["reconnecting", "connected"]);
    await vi.waitFor(() =>
      expect(remoteVideo.getRTCStatsReport).toHaveBeenCalledTimes(2),
    );

    expect(subscriber.deactivate()).toBe(true);
    releaseStats();
    await Promise.resolve();
    await Promise.resolve();
    expect(updates).toHaveLength(1);
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
