import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QUALITY_PROFILES } from "../src/client/media/quality.ts";
import { SfuPublisher } from "../src/client/sfu/publisher.ts";
import { SfuSubscriber } from "../src/client/sfu/subscriber.ts";
import type { ConnectionMetrics } from "../src/client/types.ts";
import { mergeStatsReports } from "../src/client/webrtc/stats.ts";

type EventHandler = (...args: unknown[]) => void;

const livekit = vi.hoisted(() => {
  class FakeSender {
    track: MediaStreamTrack;
    failNextSetParameters = false;
    deferNextSetParameters = false;
    private releaseSetParameters: (() => void) | null = null;
    parameters: RTCRtpSendParameters = {
      codecs: [],
      encodings: [{}],
      headerExtensions: [],
      rtcp: { cname: "fake", reducedSize: true },
      transactionId: "fake",
    };

    constructor(track: MediaStreamTrack) {
      this.track = track;
    }

    readonly getParameters = vi.fn(() => this.parameters);
    readonly setParameters = vi.fn(
      async (parameters: RTCRtpSendParameters): Promise<void> => {
        if (this.failNextSetParameters) {
          this.failNextSetParameters = false;
          throw new Error("audio parameters rejected");
        }
        const failure = state.nextSenderParameterError;
        if (failure) {
          state.nextSenderParameterError = null;
          throw failure;
        }
        if (this.deferNextSetParameters) {
          this.deferNextSetParameters = false;
          await new Promise<void>((resolve) => {
            this.releaseSetParameters = resolve;
          });
        }
        this.parameters = parameters;
      },
    );
    readonly getStats = vi.fn(
      async (): Promise<RTCStatsReport> =>
        new Map() as unknown as RTCStatsReport,
    );

    releaseDeferredSetParameters(): void {
      this.releaseSetParameters?.();
      this.releaseSetParameters = null;
    }
  }

  class FakeLocalTrack {
    currentTrack: MediaStreamTrack;
    sender: FakeSender;
    publishOptions?: Record<string, unknown>;
    savedDegradationPreference: RTCDegradationPreference | null = null;

    constructor(track: MediaStreamTrack) {
      this.currentTrack = track;
      this.sender = new FakeSender(track);
    }

    get mediaStreamTrack(): MediaStreamTrack {
      return this.currentTrack;
    }

    readonly replaceTrack = vi.fn(
      async (nextTrack: MediaStreamTrack): Promise<void> => {
        this.currentTrack = nextTrack;
        this.sender.track = nextTrack;
      },
    );

    readonly setDegradationPreference = vi.fn(
      async (preference: RTCDegradationPreference): Promise<void> => {
        this.savedDegradationPreference = preference;
      },
    );

    replaceSenderForTest(): FakeSender {
      this.sender = new FakeSender(this.currentTrack);
      return this.sender;
    }
  }

  class FakeLocalParticipant {
    readonly publications: Array<{
      track: FakeLocalTrack;
      videoTrack?: FakeLocalTrack;
      audioTrack?: FakeLocalTrack;
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
        const audioPreset = options.audioPreset;
        if (
          rawTrack.kind === "audio" &&
          typeof audioPreset === "object" &&
          audioPreset !== null &&
          "maxBitrate" in audioPreset &&
          typeof audioPreset.maxBitrate === "number"
        ) {
          localTrack.sender.parameters.encodings = [
            { maxBitrate: audioPreset.maxBitrate },
          ];
        }
        const screenShareEncoding = options.screenShareEncoding;
        if (
          rawTrack.kind === "video" &&
          options.simulcast === false &&
          typeof screenShareEncoding === "object" &&
          screenShareEncoding !== null
        ) {
          const encoding = screenShareEncoding as {
            maxBitrate?: number;
            maxFramerate?: number;
          };
          localTrack.sender.parameters.encodings = [
            {
              maxBitrate: encoding.maxBitrate,
              maxFramerate: encoding.maxFramerate,
              scaleResolutionDownBy: 1,
            },
          ];
        }
        const publication = {
          track: localTrack,
          videoTrack: rawTrack.kind === "video" ? localTrack : undefined,
          audioTrack: rawTrack.kind === "audio" ? localTrack : undefined,
          rawTrack,
          options,
        };
        this.publications.push(publication);
        return publication;
      },
    );

    getTrackPublication(source: string) {
      return this.publications.find(
        (publication) => publication.options.source === source,
      );
    }

    async republishForReconnect(): Promise<void> {
      const previous = [...this.publications];
      this.publications.length = 0;
      for (const publication of previous) {
        delete publication.videoTrack;
        delete publication.audioTrack;
        await this.publishTrack(publication.rawTrack, {
          ...publication.options,
        });
      }
    }

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
    readonly setSubscribed = vi.fn((subscribed: boolean) => {
      this.subscribed = subscribed;
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

  const AudioPresets = {
    musicStereo: { maxBitrate: 64_000 },
    musicHighQualityStereo: { maxBitrate: 128_000 },
  } as const;

  return {
    AudioPresets,
    FakeRemoteParticipant,
    FakeRemotePublication,
    FakeRoom,
    state,
  };
});

const RoomEvent = {
  Disconnected: "disconnected",
  ParticipantConnected: "participant-connected",
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

vi.mock("livekit-client", () => ({
  AudioPresets: livekit.AudioPresets,
  Room: livekit.FakeRoom,
  RoomEvent,
  Track,
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
  return Object.assign(new EventTarget(), {
    id,
    kind,
    getSettings: () => ({}),
  }) as MediaStreamTrack;
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
      estimatedPlayoutTimestamp: kind === "video" ? 10_000 : 10_012,
    },
  ]);
}

function senderReport(
  trackId: string,
  timestamp: number,
  bytesSent: number,
  framesEncoded: number,
): RTCStatsReport {
  return statsReport([
    {
      id: "video-out",
      type: "outbound-rtp",
      timestamp,
      kind: "video",
      transportId: "transport",
      codecId: "codec",
      mediaSourceId: "video-source",
      bytesSent,
      framesEncoded,
      framesPerSecond: 57,
      frameWidth: 1920,
      frameHeight: 1080,
      totalEncodeTime: framesEncoded * 0.004,
      qualityLimitationReason: "bandwidth",
      encoderImplementation: "ExternalEncoder",
      powerEfficientEncoder: true,
    },
    {
      id: "video-source",
      type: "media-source",
      timestamp,
      trackIdentifier: trackId,
      framesPerSecond: 59,
    },
    {
      id: "transport",
      type: "transport",
      timestamp,
    },
    {
      id: "codec",
      type: "codec",
      timestamp,
      transportId: "transport",
      mimeType: "video/H264",
      sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1",
    },
  ]);
}

function audioSenderReport(
  trackId: string,
  timestamp: number,
  bytesSent: number,
): RTCStatsReport {
  return statsReport([
    {
      id: "audio-out",
      type: "outbound-rtp",
      timestamp,
      kind: "audio",
      ssrc: 202,
      transportId: "audio-transport",
      mediaSourceId: "audio-source",
      codecId: "audio-codec",
      bytesSent,
    },
    {
      id: "audio-source",
      type: "media-source",
      timestamp,
      kind: "audio",
      trackIdentifier: trackId,
    },
    {
      id: "audio-transport",
      type: "transport",
      timestamp,
    },
    {
      id: "audio-codec",
      type: "codec",
      timestamp,
      transportId: "audio-transport",
      mimeType: "audio/opus",
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
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SfuPublisher", () => {
  it("enables balanced SFU adaptation after startup frames", async () => {
    vi.useFakeTimers();
    const publisher = new SfuPublisher();
    const video = track("video", "startup-video");
    const balancedProfile = {
      ...qualityProfile,
      degradationPreference: "balanced",
    } as const;

    await publisher.connect(connection);
    await publisher.activate(stream(video), balancedProfile);
    const localTrack = livekit.state.rooms[0].localParticipant.publications[0]
      .track;
    const sender = localTrack.sender;
    expect(localTrack.savedDegradationPreference).toBe("maintain-resolution");
    expect(sender.parameters.degradationPreference).toBe(
      "maintain-resolution",
    );

    sender.getStats
      .mockResolvedValueOnce(senderReport(video.id, 1_000, 10_000, 4))
      .mockResolvedValueOnce(senderReport(video.id, 2_000, 20_000, 5));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(localTrack.savedDegradationPreference).toBe("maintain-resolution");
    expect(sender.setParameters).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(localTrack.savedDegradationPreference).toBe("balanced"),
    );
    expect(sender.parameters.degradationPreference).toBe("balanced");
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
  });

  it("samples only the current published sender and clears replaced evidence", async () => {
    vi.useFakeTimers();
    const updates: Array<ConnectionMetrics | null> = [];
    const publisher = new SfuPublisher({
      onStats: (metrics) => updates.push(metrics),
    });
    const previousVideo = track("video", "video-1");
    previousVideo.getSettings = () => ({
      width: 1920,
      height: 1080,
      frameRate: 60,
    });
    await publisher.connect(connection);
    await publisher.activate(stream(previousVideo), qualityProfile);
    const sender = livekit.state.rooms[0].localParticipant.publications[0].track
      .sender;
    sender.getStats.mockResolvedValueOnce(
      senderReport(previousVideo.id, 1_000, 100_000, 60),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-1)).toMatchObject({
      captureWidth: 1920,
      captureHeight: 1080,
      captureFramesPerSecond: 60,
      trackIdentifier: previousVideo.id,
      rtpRid: null,
      mediaSourceFramesPerSecond: 59,
      framesPerSecond: 57,
      resolution: "1920x1080",
      codec: "video/H264",
      codecProfile: "profile-level-id=42e01f",
      encoderImplementation: "ExternalEncoder",
      powerEfficientEncoder: true,
      qualityLimitationReason: "bandwidth",
      nativeEdgeQualityState: "unknown",
    });

    sender.getStats.mockResolvedValueOnce(
      senderReport(previousVideo.id, 3_000, 300_000, 180),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-1)).toMatchObject({
      bitrateKbps: 800,
      intervalFramesEncoded: 120,
      intervalEncodeTimeMs: 480,
      intervalEncodeMs: 4,
    });

    let resolveOld!: (report: RTCStatsReport) => void;
    sender.getStats.mockImplementationOnce(
      () => new Promise<RTCStatsReport>((resolve) => { resolveOld = resolve; }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const nextVideo = track("video", "video-2");
    nextVideo.getSettings = () => ({
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    await expect(publisher.replaceStream(stream(nextVideo))).resolves.toBe(true);
    expect(updates.at(-1)).toBeNull();
    resolveOld(senderReport(previousVideo.id, 5_000, 500_000, 300));
    await Promise.resolve();
    expect(updates.at(-1)).toBeNull();

    sender.getStats.mockResolvedValueOnce(
      senderReport(nextVideo.id, 4_000, 400_000, 240),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-1)?.trackIdentifier).toBe(nextVideo.id);

    const updateCount = updates.length;
    const localTrack = livekit.state.rooms[0].localParticipant.publications[0]
      .track;
    const replacementSender = localTrack.replaceSenderForTest();
    replacementSender.getStats.mockResolvedValueOnce(
      senderReport(nextVideo.id, 6_000, 500_000, 270),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates[updateCount]).toBeNull();
    expect(updates.at(-1)).toMatchObject({
      trackIdentifier: nextVideo.id,
      framesPerSecond: 57,
    });

    await publisher.deactivate();
    expect(updates.at(-1)).toBeNull();
  });

  it("merges the current audio sender report and resets after its sender changes", async () => {
    vi.useFakeTimers();
    const updates: Array<ConnectionMetrics | null> = [];
    const publisher = new SfuPublisher({
      onStats: (metrics) => updates.push(metrics),
    });
    const video = track("video", "video-1");
    const audio = track("audio", "audio-1");
    await publisher.connect(connection);
    await publisher.activate(stream(video, audio), qualityProfile);
    const room = livekit.state.rooms[0];
    const videoSender = room.localParticipant.publications[0].track.sender;
    const audioTrack = room.localParticipant.publications[1].track;
    const audioSender = audioTrack.sender;
    videoSender.getStats
      .mockResolvedValueOnce(senderReport(video.id, 1_000, 100_000, 60))
      .mockResolvedValueOnce(senderReport(video.id, 3_000, 300_000, 180));
    audioSender.getStats
      .mockResolvedValueOnce(audioSenderReport(audio.id, 1_000, 10_000))
      .mockResolvedValueOnce(audioSenderReport(audio.id, 3_000, 50_000));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-1)).toMatchObject({
      audioBitrateKbps: null,
      audioCodec: "audio/opus",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-1)).toMatchObject({
      audioBitrateKbps: 160,
      audioCodec: "audio/opus",
    });

    const replacementSender = audioTrack.replaceSenderForTest();
    videoSender.getStats
      .mockResolvedValueOnce(senderReport(video.id, 5_000, 500_000, 300))
      .mockResolvedValueOnce(senderReport(video.id, 7_000, 700_000, 420));
    replacementSender.getStats
      .mockResolvedValueOnce(audioSenderReport(audio.id, 5_000, 90_000))
      .mockResolvedValueOnce(audioSenderReport(audio.id, 7_000, 130_000));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-2)).toBeNull();
    expect(updates.at(-1)?.audioBitrateKbps).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.at(-1)?.audioBitrateKbps).toBe(160);
    expect(audioSender.getStats).toHaveBeenCalledTimes(2);
    expect(replacementSender.getStats).toHaveBeenCalledTimes(2);
  });

  it("enables Dynacast while preparing SFU fallback", async () => {
    const publisher = new SfuPublisher();

    await expect(publisher.connect(connection)).resolves.toBe(true);

    const room = livekit.state.rooms[0];
    expect(room.options).toEqual({
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
    });
    expect(room.connect).toHaveBeenCalledWith(connection.url, connection.token, {
      autoSubscribe: false,
      rtcConfig: { iceServers: [] },
    });
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();

    await publisher.disconnect();
    await publisher.disconnect();
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledWith(false);
  });

  it("retains the bounded stage after connection setup fails", async () => {
    livekit.state.connectGate = Promise.reject(new Error("connect failed"));
    const publisher = new SfuPublisher();

    await expect(publisher.connect(connection)).rejects.toThrow("connect failed");

    expect(publisher.getFailureStage()).toBe("connect");
    expect(livekit.state.rooms[0]?.disconnect).toHaveBeenCalledWith(false);
  });

  it("leaves VP8 screen-share simulcast layers to LiveKit defaults", async () => {
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
      videoCodec: "vp8",
      screenShareEncoding: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
      },
      degradationPreference: "maintain-resolution",
    });
    expect(
      room.localParticipant.publishTrack.mock.calls[0]?.[1],
    ).not.toHaveProperty("simulcast");
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: 128_000 },
      forceStereo: true,
      dtx: false,
      red: false,
    });
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(sender.parameters.encodings).toEqual([
      {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      },
    ]);
    expect(sender.parameters.encodings[0]).not.toHaveProperty("rid");
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

  it.each([
    ["saver", 64_000],
    ["music", 128_000],
    ["very-high", 192_000],
  ] as const)("maps the %s audio preset to %i bps", async (screenAudioQuality, bitrate) => {
    const publisher = new SfuPublisher();
    const video = track("video", `video-${screenAudioQuality}`);
    const audio = track("audio", `audio-${screenAudioQuality}`);
    await publisher.connect(connection);

    await expect(
      publisher.activate(stream(video, audio), {
        ...qualityProfile,
        screenAudioQuality,
      }),
    ).resolves.toBe(true);

    expect(
      livekit.state.rooms[0]?.localParticipant.publishTrack,
    ).toHaveBeenNthCalledWith(2, audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: bitrate },
      forceStereo: true,
      dtx: false,
      red: false,
    });
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

  it("updates an active audio sender and retained options without republishing", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(
      stream(track("video", "video-1"), track("audio", "audio-1")),
      { ...qualityProfile, screenAudioQuality: "saver" },
    );
    const room = livekit.state.rooms[0];
    const videoPublication = room.localParticipant.publications[0];
    const audioPublication = room.localParticipant.publications[1];

    await expect(
      publisher.updateProfile({
        ...qualityProfile,
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);

    expect(videoPublication.track.sender.setParameters).toHaveBeenCalledOnce();
    expect(audioPublication.track.sender.setParameters).toHaveBeenCalledTimes(2);
    expect(audioPublication.track.sender.parameters.encodings[0]?.maxBitrate).toBe(
      192_000,
    );
    expect(audioPublication.options).toMatchObject({
      audioPreset: { maxBitrate: 192_000 },
      forceStereo: true,
      dtx: false,
      red: false,
    });
    expect(publisher.getAudioSenderParameters()).toEqual({
      requestedMaxBitrate: 192_000,
      appliedMaxBitrate: 192_000,
      mismatch: false,
    });
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);

    await room.localParticipant.republishAllTracks();
    expect(room.localParticipant.republishedOptions[1]).toMatchObject({
      audioPreset: { maxBitrate: 192_000 },
      forceStereo: true,
      dtx: false,
      red: false,
    });
  });

  it("publishes one H264 source without a backup codec", async () => {
    const publisher = new SfuPublisher();
    const video = track("video", "video-h264");
    await publisher.connect(connection);

    await expect(
      publisher.activate(stream(video), qualityProfile, "h264"),
    ).resolves.toBe(true);

    const publication = livekit.state.rooms[0].localParticipant.publications[0];
    expect(publication.options).toMatchObject({
      source: Track.Source.ScreenShare,
      backupCodec: false,
      videoCodec: "h264",
    });
    await expect(
      publisher.updateProfile(QUALITY_PROFILES["720p30"]),
    ).resolves.toBe(true);
    expect(publication.options.videoCodec).toBe("h264");
  });

  it("keeps media and prior audio readback when a live update fails", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(
      stream(track("video", "video-1"), track("audio", "audio-1")),
      { ...qualityProfile, screenAudioQuality: "music" },
    );
    const room = livekit.state.rooms[0];
    const videoPublication = room.localParticipant.publications[0];
    const audioPublication = room.localParticipant.publications[1];
    audioPublication.track.sender.failNextSetParameters = true;

    await expect(
      publisher.updateProfile({
        ...qualityProfile,
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(false);

    expect(publisher.getAudioSenderParameters()?.appliedMaxBitrate).toBe(
      128_000,
    );
    expect(publisher.getQualityWarning()).toContain(
      "应用 SFU 音频发送参数失败",
    );
    expect(audioPublication.track.sender.parameters.encodings[0]?.maxBitrate).toBe(
      128_000,
    );
    expect(audioPublication.options).toMatchObject({
      audioPreset: { maxBitrate: 192_000 },
    });
    expect(videoPublication.track.sender.setParameters).toHaveBeenCalledOnce();
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);

    await expect(
      publisher.updateProfile({
        ...qualityProfile,
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);
    expect(publisher.getAudioSenderParameters()?.appliedMaxBitrate).toBe(
      192_000,
    );
    expect(publisher.getQualityWarning()).toBeNull();
  });

  it("keeps rapid SFU audio updates last-wins", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(
      stream(track("video", "video-1"), track("audio", "audio-1")),
      { ...qualityProfile, screenAudioQuality: "music" },
    );
    const room = livekit.state.rooms[0];
    const audioPublication = room.localParticipant.publications[1];
    const audioSender = audioPublication.track.sender;
    audioSender.deferNextSetParameters = true;

    const saver = publisher.updateProfile({
      ...qualityProfile,
      screenAudioQuality: "saver",
    });
    await vi.waitFor(() =>
      expect(audioSender.setParameters).toHaveBeenCalledTimes(2),
    );
    const music = publisher.updateProfile({
      ...qualityProfile,
      screenAudioQuality: "music",
    });
    expect(audioPublication.options).toMatchObject({
      audioPreset: { maxBitrate: 128_000 },
    });
    audioSender.releaseDeferredSetParameters();

    await expect(saver).resolves.toBe(false);
    await expect(music).resolves.toBe(true);
    expect(audioSender.parameters.encodings[0]?.maxBitrate).toBe(128_000);
    expect(publisher.getAudioSenderParameters()?.appliedMaxBitrate).toBe(
      128_000,
    );
    expect(room.localParticipant.republishAllTracks).not.toHaveBeenCalled();
  });

  it("reapplies the latest audio ceiling to a replacement sender after reconnect", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(
      stream(track("video", "video-1"), track("audio", "audio-1")),
      { ...qualityProfile, screenAudioQuality: "music" },
    );
    const room = livekit.state.rooms[0];
    const audioPublication = room.localParticipant.publications[1];
    const oldSender = audioPublication.track.sender;
    oldSender.deferNextSetParameters = true;

    const updating = publisher.updateProfile({
      ...qualityProfile,
      screenAudioQuality: "very-high",
    });
    await vi.waitFor(() =>
      expect(oldSender.setParameters).toHaveBeenCalledTimes(2),
    );
    const replacementSender = audioPublication.track.replaceSenderForTest();

    room.emit(RoomEvent.Reconnected);
    oldSender.releaseDeferredSetParameters();

    await expect(updating).resolves.toBe(false);
    await vi.waitFor(() =>
      expect(replacementSender.setParameters).toHaveBeenCalledOnce(),
    );
    expect(replacementSender.parameters.encodings[0]?.maxBitrate).toBe(192_000);
    expect(publisher.getAudioSenderParameters()?.appliedMaxBitrate).toBe(
      192_000,
    );
    expect(room.localParticipant.republishAllTracks).not.toHaveBeenCalled();
  });

  it("rebinds republished tracks after a full reconnect", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(
      stream(track("video", "video-1"), track("audio", "audio-1")),
      { ...qualityProfile, screenAudioQuality: "music" },
    );
    await expect(
      publisher.updateProfile({
        ...qualityProfile,
        screenAudioQuality: "very-high",
      }),
    ).resolves.toBe(true);
    const room = livekit.state.rooms[0];
    const oldVideoPublication = room.localParticipant.publications[0];
    const oldAudioPublication = room.localParticipant.publications[1];

    await room.localParticipant.republishForReconnect();
    const videoPublication = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    )!;
    const audioPublication = room.localParticipant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    )!;
    expect(videoPublication).not.toBe(oldVideoPublication);
    expect(audioPublication).not.toBe(oldAudioPublication);

    room.emit(RoomEvent.Reconnected);

    await vi.waitFor(() =>
      expect(publisher.getAudioSenderParameters()).not.toBeNull(),
    );
    expect(audioPublication.track.sender.setParameters).not.toHaveBeenCalled();
    expect(audioPublication.track.sender.parameters.encodings[0]?.maxBitrate).toBe(
      192_000,
    );
    expect(publisher.getAudioSenderParameters()?.appliedMaxBitrate).toBe(
      192_000,
    );
    expect(publisher.getSenderParameters()).toBeNull();
    expect(publisher.getQualityWarning()).toBeNull();
  });

  it("retains video sender readback across a signal-only reconnect", async () => {
    const publisher = new SfuPublisher();
    await publisher.connect(connection);
    await publisher.activate(
      stream(track("video", "video-1"), track("audio", "audio-1")),
      { ...qualityProfile, screenAudioQuality: "music" },
    );
    const room = livekit.state.rooms[0];
    const videoSender = room.localParticipant.publications[0].track.sender;
    const audioSender = room.localParticipant.publications[1].track.sender;
    videoSender.setParameters.mockImplementationOnce(async (parameters) => {
      videoSender.parameters = {
        ...parameters,
        encodings: parameters.encodings.map((encoding) => ({
          ...encoding,
          maxBitrate: 2_000_000,
        })),
      };
    });
    await expect(
      publisher.updateProfile({
        ...qualityProfile,
        maxBitrate: 5_000_000,
        degradationPreference: "balanced",
        screenAudioQuality: "music",
      }),
    ).resolves.toBe(true);
    const senderParameters = publisher.getSenderParameters();
    const qualityWarning = publisher.getQualityWarning();
    expect(senderParameters).not.toBeNull();
    expect(qualityWarning).not.toBeNull();
    const audioUpdates = audioSender.setParameters.mock.calls.length;

    room.emit(RoomEvent.Reconnected);

    await vi.waitFor(() =>
      expect(publisher.getAudioSenderParameters()?.appliedMaxBitrate).toBe(
        128_000,
      ),
    );
    expect(audioSender.setParameters).toHaveBeenCalledTimes(audioUpdates);
    expect(publisher.getSenderParameters()).toBe(senderParameters);
    expect(publisher.getQualityWarning()).toBe(qualityWarning);
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("keeps publisher stats continuous across a signal-only reconnect", async () => {
    vi.useFakeTimers();
    const updates: Array<ConnectionMetrics | null> = [];
    const publisher = new SfuPublisher({
      onStats: (metrics) => updates.push(metrics),
    });
    const video = track("video", "video-1");
    await publisher.connect(connection);
    await publisher.activate(stream(video), qualityProfile);
    const room = livekit.state.rooms[0];
    const sender = room.localParticipant.publications[0].track.sender;
    sender.getStats
      .mockResolvedValueOnce(senderReport(video.id, 1_000, 100_000, 60))
      .mockResolvedValueOnce(senderReport(video.id, 3_000, 300_000, 180))
      .mockResolvedValueOnce(senderReport(video.id, 5_000, 500_000, 300));

    await vi.advanceTimersByTimeAsync(4_000);
    const resets = updates.filter((update) => update === null).length;
    room.emit(RoomEvent.Reconnected);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(updates.filter((update) => update === null)).toHaveLength(resets);
    expect(updates.at(-1)).toMatchObject({
      bitrateKbps: 800,
      intervalFramesEncoded: 120,
    });
  });

  it.each(["publication", "sender"] as const)(
    "fails the SFU route when republished audio loses its %s",
    async (missing) => {
      const disconnected = vi.fn();
      const publisher = new SfuPublisher({ onDisconnected: disconnected });
      await publisher.connect(connection);
      await publisher.activate(
        stream(track("video", "video-1"), track("audio", "audio-1")),
        { ...qualityProfile, screenAudioQuality: "music" },
      );
      const room = livekit.state.rooms[0];
      await room.localParticipant.republishForReconnect();
      const audioPublication = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      )!;
      if (missing === "publication") {
        room.localParticipant.publications.splice(
          room.localParticipant.publications.indexOf(audioPublication),
          1,
        );
      } else {
        delete audioPublication.audioTrack;
      }

      room.emit(RoomEvent.Reconnected);

      await vi.waitFor(() => expect(room.disconnect).toHaveBeenCalledWith(false));
      expect(publisher.getFailureStage()).toBe("transport");
      expect(disconnected).toHaveBeenCalledOnce();
    },
  );

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
    expect(publisher.getQualityWarning()).toContain("应用 SFU 发送参数失败");
    expect(publisher.getQualityWarning()).not.toContain("preference save failed");
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
          maxBitrate: 8_000_000,
          maxFramerate: 60,
        }),
      ],
    });
    expect(publisher.getQualityWarning()).toBe("应用 SFU 发送参数失败");
    expect(publisher.getQualityWarning()).not.toContain("unsupported");
  });

  it("retains a sender rewrite warning after rolling back parameters", async () => {
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
          encodings: parameters.encodings.map((encoding) => ({
            ...encoding,
            maxBitrate: 1_500_000,
          })),
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
      applied: { maxBitrate: 1_500_000 },
      mismatches: ["maxBitrate"],
    });
    expect(publisher.getQualityWarning()).toContain("应用 SFU 发送参数失败");
    expect(publisher.getQualityWarning()).not.toContain("unsupported");
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
    await publisher.activate(stream(track("video", "video-1")), {
      ...qualityProfile,
      screenAudioQuality: "very-high",
    });
    const room = livekit.state.rooms[0];

    await expect(
      publisher.replaceStream(stream(track("video", "video-2"), audio)),
    ).resolves.toBe(true);

    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: 192_000 },
      forceStereo: true,
      dtx: false,
      red: false,
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
    expect(publisher.getQualityWarning()).toBe("切换 SFU 分享来源失败");
    expect(publisher.getQualityWarning()).not.toContain(
      "replacement parameters rejected",
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
  it("uses cumulative frames for a fresh exact subscriber and growth after rearm", async () => {
    vi.useFakeTimers();
    let framesDecoded = 1;
    const proofs: number[] = [];
    const subscriber = new SfuSubscriber({
      onStream: vi.fn(),
      onFirstDecodedFrame: () => {
        proofs.push(framesDecoded);
        return true;
      },
    });
    await subscriber.connect(connection);
    const room = livekit.state.rooms[0];
    expect(room.options).toEqual({ disconnectOnPageLeave: false });
    const host = new livekit.FakeRemoteParticipant("host");
    const publication = new livekit.FakeRemotePublication(
      "host-video",
      Track.Source.ScreenShare,
    );
    host.add(publication);
    room.remoteParticipants.set("host", host);
    expect(subscriber.activate()).toBe(true);
    subscriber.armDecodedFrameProof();
    const video = track("video", "video-1");
    room.emit(
      RoomEvent.TrackSubscribed,
      remoteTrack(video, () =>
        statsReport([
          {
            id: "video-in",
            type: "inbound-rtp",
            timestamp: 1_000,
            kind: "video",
            framesDecoded,
          },
        ]),
      ),
      publication,
      host,
    );
    await vi.waitFor(() => expect(proofs).toEqual([1]));

    proofs.length = 0;
    framesDecoded = 7;
    subscriber.armDecodedFrameProof(true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(proofs).toEqual([]);
    framesDecoded = 8;
    await vi.advanceTimersByTimeAsync(300);
    expect(proofs).toEqual([8]);

    subscriber.deactivate();
    framesDecoded = 9;
    await vi.advanceTimersByTimeAsync(500);
    expect(proofs).toEqual([8]);
  });

  it("reconciles a Host publication announced while connect is pending", async () => {
    const gate = deferred();
    livekit.state.connectGate = gate.promise;
    const subscriber = new SfuSubscriber({ onStream: vi.fn() });
    const connecting = subscriber.connect(connection);
    await vi.waitFor(() => expect(livekit.state.rooms).toHaveLength(1));
    const room = livekit.state.rooms[0];
    const host = new livekit.FakeRemoteParticipant("host");
    const hostVideo = new livekit.FakeRemotePublication(
      "host-video-pending",
      Track.Source.ScreenShare,
    );
    host.add(hostVideo);

    room.emit(RoomEvent.TrackPublished, hostVideo, host);
    expect(hostVideo.setSubscribed).not.toHaveBeenCalled();
    gate.resolve();
    await expect(connecting).resolves.toBe(true);

    expect(subscriber.activate()).toBe(true);
    expect(hostVideo.setSubscribed).toHaveBeenCalledWith(true);
  });

  it("reconciles a Host participant that appears after activation", async () => {
    const subscriber = new SfuSubscriber({ onStream: vi.fn() });
    await subscriber.connect(connection);
    const room = livekit.state.rooms[0];
    expect(subscriber.activate()).toBe(true);

    const host = new livekit.FakeRemoteParticipant("host");
    const hostVideo = new livekit.FakeRemotePublication(
      "host-video-late",
      Track.Source.ScreenShare,
    );
    host.add(hostVideo);
    room.emit(RoomEvent.ParticipantConnected, host);

    expect(hostVideo.setSubscribed).toHaveBeenCalledWith(true);
  });

  it("subscribes only to assigned Host screen tracks", async () => {
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
      rtcConfig: { iceServers: [] },
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

  it("keeps active decoded-frame sampling through unavailable receiver stats", async () => {
    vi.useFakeTimers();
    const samples: Array<number | null> = [];
    const updates: ConnectionMetrics[] = [];
    const subscriber = new SfuSubscriber({
      onStream: vi.fn(),
      onStats: (metrics) => updates.push(metrics),
      onDecodedFrameSample: (framesDecodedDelta) =>
        samples.push(framesDecodedDelta),
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

    expect(subscriber.activate()).toBe(true);
    expect(samples).toEqual([null]);

    let receiverStats: RTCStatsReport | Promise<RTCStatsReport> | Error =
      statsReport([]);
    const video = track("video", "video-1");
    const remoteVideo = remoteTrack(video, () => {
      if (receiverStats instanceof Error) throw receiverStats;
      return receiverStats;
    });
    room.emit(RoomEvent.TrackSubscribed, remoteVideo, publication, host);
    await vi.advanceTimersByTimeAsync(0);
    expect(samples).toEqual([null, null]);
    expect(updates).toEqual([]);

    receiverStats = new Error("stats unavailable");
    const samplesBeforeStatsError = samples.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples).toHaveLength(samplesBeforeStatsError + 1);
    expect(samples.at(-1)).toBeNull();
    expect(updates).toEqual([]);

    receiverStats = statsReport([
      {
        id: "video-in",
        type: "inbound-rtp",
        timestamp: 1_000,
        kind: "video",
        trackIdentifier: video.id,
        framesDecoded: 1,
      },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.at(-1)).toBeNull();
    expect(updates).toHaveLength(1);

    receiverStats = statsReport([
      {
        id: "video-in",
        type: "inbound-rtp",
        timestamp: 3_000,
        kind: "video",
        trackIdentifier: video.id,
        framesDecoded: 5,
      },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.at(-1)).toBe(4);
    expect(updates).toHaveLength(2);

    let releasePendingStats!: (report: RTCStatsReport) => void;
    receiverStats = new Promise<RTCStatsReport>((resolve) => {
      releasePendingStats = resolve;
    });
    const statsCallsBeforePending = remoteVideo.getRTCStatsReport.mock.calls.length;
    const samplesBeforePending = samples.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(remoteVideo.getRTCStatsReport).toHaveBeenCalledTimes(
      statsCallsBeforePending + 1,
    );
    expect(samples).toHaveLength(samplesBeforePending);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(remoteVideo.getRTCStatsReport).toHaveBeenCalledTimes(
      statsCallsBeforePending + 1,
    );
    expect(samples).toHaveLength(samplesBeforePending + 1);
    expect(samples.at(-1)).toBeNull();

    const replacementVideo = track("video", "video-2");
    let replacementStats = statsReport([
      {
        id: "replacement-video-in",
        type: "inbound-rtp",
        timestamp: 1_000,
        kind: "video",
        trackIdentifier: replacementVideo.id,
        framesDecoded: 2,
      },
    ]);
    const replacementRemoteVideo = remoteTrack(
      replacementVideo,
      () => replacementStats,
    );
    room.emit(
      RoomEvent.TrackSubscribed,
      replacementRemoteVideo,
      publication,
      host,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.at(-1)?.trackIdentifier).toBe(replacementVideo.id);
    const samplesAfterReplacement = samples.length;
    const updatesAfterReplacement = updates.length;
    releasePendingStats(
      statsReport([
        {
          id: "video-in",
          type: "inbound-rtp",
          timestamp: 5_000,
          kind: "video",
          trackIdentifier: video.id,
          framesDecoded: 9,
        },
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(samples).toHaveLength(samplesAfterReplacement);
    expect(updates).toHaveLength(updatesAfterReplacement);

    replacementStats = statsReport([
      {
        id: "replacement-video-in",
        type: "inbound-rtp",
        timestamp: 3_000,
        kind: "video",
        trackIdentifier: replacementVideo.id,
        framesDecoded: 7,
      },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.at(-1)).toBe(5);

    room.emit(
      RoomEvent.TrackUnsubscribed,
      replacementRemoteVideo,
      publication,
      host,
    );
    const samplesBeforeMissingTrack = samples.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples).toHaveLength(samplesBeforeMissingTrack + 1);
    expect(samples.at(-1)).toBeNull();

    expect(subscriber.deactivate()).toBe(true);
    const samplesAfterDeactivate = samples.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(samples).toHaveLength(samplesAfterDeactivate);
  });

  it("keeps video liveness independent from optional audio stats", async () => {
    vi.useFakeTimers();
    const samples: Array<number | null> = [];
    const updates: ConnectionMetrics[] = [];
    const subscriber = new SfuSubscriber({
      onStream: vi.fn(),
      onStats: (metrics) => updates.push(metrics),
      onDecodedFrameSample: (framesDecodedDelta) =>
        samples.push(framesDecodedDelta),
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
    let videoTimestamp = 1_000;
    let videoFrames = 1;
    const remoteVideo = remoteTrack(video, () =>
      statsReport([
        {
          id: "video-in",
          type: "inbound-rtp",
          timestamp: videoTimestamp,
          kind: "video",
          trackIdentifier: video.id,
          framesDecoded: videoFrames,
          estimatedPlayoutTimestamp: 10_000,
        },
      ]),
    );
    const audio = track("audio", "audio-1");
    let audioStats: RTCStatsReport | Promise<RTCStatsReport> | Error =
      new Error("audio stats unavailable");
    const remoteAudio = remoteTrack(audio, () => {
      if (audioStats instanceof Error) throw audioStats;
      return audioStats;
    });
    room.emit(RoomEvent.TrackSubscribed, remoteAudio, hostAudio, host);
    room.emit(RoomEvent.TrackSubscribed, remoteVideo, hostVideo, host);
    await vi.advanceTimersByTimeAsync(0);
    expect(samples.at(-1)).toBeNull();
    expect(updates).toHaveLength(1);

    videoTimestamp = 3_000;
    videoFrames = 5;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.at(-1)).toBe(4);
    expect(remoteAudio.getRTCStatsReport).toHaveBeenCalledTimes(2);

    audioStats = receiverReport("audio");
    videoTimestamp = 5_000;
    videoFrames = 9;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.at(-1)).toBe(4);
    expect(updates.at(-1)?.audioVideoPlayoutDeltaMs).toBe(12);
    expect(remoteAudio.getRTCStatsReport).toHaveBeenCalledTimes(3);

    audioStats = new Promise<RTCStatsReport>(() => undefined);
    videoTimestamp = 7_000;
    videoFrames = 13;
    const samplesBeforePendingAudio = samples.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples).toHaveLength(samplesBeforePendingAudio + 1);
    expect(samples.at(-1)).toBe(4);
    expect(updates.at(-1)?.audioVideoPlayoutDeltaMs).toBeNull();
    expect(remoteAudio.getRTCStatsReport).toHaveBeenCalledTimes(4);

    videoTimestamp = 9_000;
    videoFrames = 17;
    const samplesBeforeSecondPendingAudioTick = samples.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples).toHaveLength(samplesBeforeSecondPendingAudioTick + 1);
    expect(samples.at(-1)).toBe(4);
    expect(updates.at(-1)?.audioVideoPlayoutDeltaMs).toBeNull();
    expect(remoteAudio.getRTCStatsReport).toHaveBeenCalledTimes(4);
    expect(remoteVideo.getRTCStatsReport).toHaveBeenCalledTimes(5);

    expect(subscriber.deactivate()).toBe(true);
  });

  it("reports merged receiver stats and drops a stale sample", async () => {
    const updates: ConnectionMetrics[] = [];
    const samples: Array<number | null> = [];
    const states: string[] = [];
    const subscriber = new SfuSubscriber({
      onStream: vi.fn(),
      onStats: (metrics) => updates.push(metrics),
      onDecodedFrameSample: (framesDecodedDelta) =>
        samples.push(framesDecodedDelta),
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
    expect(samples).toEqual([null, null]);

    expect(updates.at(-1)).toMatchObject({
      rtpStatsId: "video-in",
      trackIdentifier: "video-1",
      audioVideoPlayoutDeltaMs: 12,
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
    const samplesAfterDeactivate = samples.length;
    releaseStats();
    await Promise.resolve();
    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(samples).toHaveLength(samplesAfterDeactivate);
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
