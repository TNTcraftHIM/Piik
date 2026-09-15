import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUALITY_PROFILES } from "../src/client/media/quality.ts";
import { SfuPublisher } from "../src/client/sfu/publisher.ts";
import { SfuSubscriber } from "../src/client/sfu/subscriber.ts";
import {
  clientMessageSchema,
  type SfuSignalMessage,
} from "../src/shared/protocol.ts";

class FakeTrack extends EventTarget {
  readonly id = crypto.randomUUID();
  enabled = true;
  contentHint = "";
  readyState = "live";
  readonly clones: FakeTrack[] = [];
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  readonly getSettings = vi.fn(() => ({
    width: 1920,
    height: 1080,
    frameRate: 30,
  }));
  readonly applyConstraints = vi.fn(
    async (_constraints: MediaTrackConstraints) => undefined,
  );
  readonly clone = vi.fn(() => {
    const next = new FakeTrack(this.kind);
    this.clones.push(next);
    return next;
  });
  constructor(readonly kind: "audio" | "video") {
    super();
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((current) => current !== track);
  }
}

class FakeSender {
  readonly getParameters = vi.fn(() => structuredClone(this.parameters));
  readonly setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
    this.parameters = structuredClone(parameters);
  });
  readonly replaceTrack = vi.fn(async (track: FakeTrack | null) => {
    this.track = track;
  });
  readonly getStats = vi.fn(async () => new Map());
  parameters: RTCRtpSendParameters;
  constructor(
    public track: FakeTrack | null,
    encodings: RTCRtpEncodingParameters[],
  ) {
    this.parameters = {
      encodings,
      codecs: [],
      headerExtensions: [],
      rtcp: {},
      transactionId: "test",
    };
  }
  static getCapabilities(kind: string) {
    return {
      codecs:
        kind === "audio"
          ? [{ mimeType: "audio/opus", clockRate: 48000, channels: 2 }]
          : [
              { mimeType: "video/VP8", clockRate: 90000 },
              {
                mimeType: "video/H264",
                clockRate: 90000,
                sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f",
              },
              { mimeType: "video/VP9", clockRate: 90000 },
            ],
    };
  }
}

class FakePc {
  static instances: FakePc[] = [];
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly transceivers: Array<{
    sender: FakeSender;
    setCodecPreferences: ReturnType<typeof vi.fn>;
  }> = [];
  report = new Map();
  readonly getStats = vi.fn(async () => this.report);
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });
  readonly createOffer = vi.fn(async (_options?: RTCOfferOptions) => ({
    type: "offer" as const,
    sdp: "offer",
  }));
  readonly createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "answer",
  }));
  readonly setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.localDescription = description;
      this.signalingState =
        description.type === "offer" ? "have-local-offer" : "stable";
      this.onicecandidate?.({
        candidate: {
          protocol: "udp",
          candidate: "candidate:1 1 UDP 1 127.0.0.1 4000 typ host",
          toJSON: () => ({
            candidate: "candidate:1 1 UDP 1 127.0.0.1 4000 typ host",
          }),
        },
      });
    },
  );
  readonly setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.remoteDescription = description;
      this.signalingState =
        description.type === "offer" ? "have-remote-offer" : "stable";
    },
  );
  readonly addIceCandidate = vi.fn(
    async (_candidate: RTCIceCandidateInit) => undefined,
  );
  constructor(readonly configuration: RTCConfiguration) {
    FakePc.instances.push(this);
  }
  addTransceiver(track: FakeTrack | string, options: RTCRtpTransceiverInit) {
    const transceiver = {
      sender: new FakeSender(
        typeof track === "string" ? null : track,
        options.sendEncodings ?? [{}],
      ),
      setCodecPreferences: vi.fn(),
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  state(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const config = {
  revision: 4,
  publicationGeneration: "publication_12345678",
  connectionId: "connection_12345678",
};
const signal = (payload: Partial<SfuSignalMessage>): SfuSignalMessage => ({
  type: "sfu-signal",
  ...config,
  kind: "description",
  ...payload,
});
const cleanups: Array<() => Promise<void>> = [];
const stream = (...tracks: FakeTrack[]): MediaStream =>
  new FakeStream(tracks) as unknown as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  FakePc.instances = [];
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal("RTCPeerConnection", FakePc);
  vi.stubGlobal("RTCRtpSender", FakeSender);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function publisher(audio = true) {
  const send = vi.fn((_message: SfuSignalMessage) => true);
  const onDisconnected = vi.fn();
  const video = new FakeTrack("video");
  const sound = new FakeTrack("audio");
  const publisher = new SfuPublisher({ send, onDisconnected });
  cleanups.push(() => publisher.disconnect());
  await publisher.connect(config);
  await publisher.activate(
    stream(video, ...(audio ? [sound] : [])),
    QUALITY_PROFILES["1080p30"],
    "h264",
  );
  return {
    publisher,
    send,
    onDisconnected,
    video,
    sound,
    pc: FakePc.instances[0]!,
  };
}

function feedVideoStats(
  pc: FakePc,
  trackId: string,
  framesEncoded: number,
): void {
  pc.report.clear();
  pc.report.set("outbound-video", {
    id: "outbound-video",
    type: "outbound-rtp",
    kind: "video",
    timestamp: 1_000,
    ssrc: 10,
    framesEncoded,
    mediaSourceId: "media-source-video",
  });
  pc.report.set("media-source-video", {
    id: "media-source-video",
    type: "media-source",
    kind: "video",
    timestamp: 1_000,
    trackIdentifier: trackId,
  });
}

describe("embedded SFU browser transport", () => {
  it("publishes one bounded simulcast PC, offers before ICE and admits only the selected codec", async () => {
    const { publisher: host, pc, send, video } = await publisher();
    expect(pc.configuration).toEqual({ iceServers: [] });
    expect(pc.transceivers).toHaveLength(2);
    expect(pc.transceivers[0]!.sender.track).toBe(video.clones[0]);
    const offer = send.mock.calls[0]![0];
    expect(offer.kind).toBe("description");
    expect(offer.media).toEqual({
      codec: "h264",
      layers: [
        { rid: "q", width: 960, height: 540, bitrate: 1_250_000 },
        { rid: "h", width: 1920, height: 1080, bitrate: 5_000_000 },
      ],
      audio: true,
      audioBitrate: 128_000,
    });
    expect(send.mock.calls[1]![0].kind).toBe("candidate");
    expect(clientMessageSchema.safeParse(offer).success).toBe(true);
    expect(pc.transceivers[0]!.setCodecPreferences.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ mimeType: "video/H264" }),
    ]);
    await host.acceptSignal(
      signal({ description: { type: "answer", sdp: "answer" } }),
    );
    expect(pc.remoteDescription?.type).toBe("answer");
  });

  it("queues remote ICE and rejects retired connection/publication identities", async () => {
    const { publisher: host, pc } = await publisher();
    const candidate = {
      candidate: "candidate:1 1 UDP 1 127.0.0.1 4100 typ host",
    };
    await host.acceptSignal(signal({ kind: "candidate", candidate }));
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    await host.acceptSignal(
      signal({
        connectionId: "retired_12345678",
        description: { type: "answer", sdp: "stale" },
      }),
    );
    await host.acceptSignal(
      signal({
        publicationGeneration: "retired_12345678",
        description: { type: "answer", sdp: "stale" },
      }),
    );
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    await host.acceptSignal(
      signal({ description: { type: "answer", sdp: "answer" } }),
    );
    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  it("updates all existing encodings and audio without changing the PC or codec", async () => {
    const { publisher: host, pc, send } = await publisher();
    const profile = {
      ...QUALITY_PROFILES["720p30"],
      screenAudioQuality: "very-high" as const,
    };
    expect(await host.updateProfile(profile)).toBe(true);
    expect(pc.transceivers[0]!.sender.parameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        maxBitrate: 750_000,
        scaleResolutionDownBy: 3,
      }),
      expect.objectContaining({
        rid: "h",
        maxBitrate: 3_000_000,
        scaleResolutionDownBy: 1.5,
      }),
    ]);
    expect(pc.transceivers[1]!.sender.parameters.encodings[0]!.maxBitrate).toBe(192_000);
    expect(send.mock.calls.at(-1)![0]).toMatchObject({
      kind: "media",
      media: { codec: "h264", audioBitrate: 192_000 },
    });
    expect(FakePc.instances).toHaveLength(1);
    expect(pc.createOffer).toHaveBeenCalledOnce();
  });

  it("reuses the audio transceiver when source audio appears and retires clones only", async () => {
    const { publisher: host, pc, video, send } = await publisher(false);
    const nextVideo = new FakeTrack("video");
    const nextAudio = new FakeTrack("audio");
    host.setPaused(true);
    expect(await host.replaceStream(stream(nextVideo, nextAudio))).toBe(true);
    expect(video.clones[0]!.stop).toHaveBeenCalledOnce();
    expect(video.stop).not.toHaveBeenCalled();
    expect(pc.transceivers).toHaveLength(2);
    expect(nextVideo.clones[0]!.enabled).toBe(false);
    expect(nextAudio.clones[0]!.enabled).toBe(false);
    expect(send.mock.calls.at(-1)![0]).toMatchObject({
      kind: "media",
      media: { audio: true },
    });
    await host.disconnect();
    expect(nextVideo.clones[0]!.stop).toHaveBeenCalledOnce();
    expect(nextAudio.clones[0]!.stop).toHaveBeenCalledOnce();
    expect(nextVideo.stop).not.toHaveBeenCalled();
    expect(nextAudio.stop).not.toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it.each([0, 250])("counts new publication frames from a valid baseline of %s", async (baseline) => {
    const { publisher: host, pc, video } = await publisher();
    const sender = pc.transceivers[0]!.sender;
    expect(sender.parameters.degradationPreference).toBe(
      "maintain-resolution",
    );
    feedVideoStats(pc, video.clones[0]!.id, 6);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sender.parameters.degradationPreference).toBe("balanced");

    const nextVideo = new FakeTrack("video");
    expect(await host.replaceStream(stream(nextVideo))).toBe(true);
    expect(sender.parameters.degradationPreference).toBe(
      "maintain-resolution",
    );

    // The old source, an empty report, and an absent counter are all unknown.
    await vi.advanceTimersByTimeAsync(2_000);
    pc.report.clear();
    await vi.advanceTimersByTimeAsync(2_000);
    feedVideoStats(pc, nextVideo.clones[0]!.id, 0);
    delete pc.report.get("outbound-video").framesEncoded;
    await vi.advanceTimersByTimeAsync(2_000);

    feedVideoStats(pc, nextVideo.clones[0]!.id, baseline);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sender.parameters.degradationPreference).toBe(
      "maintain-resolution",
    );
    feedVideoStats(pc, nextVideo.clones[0]!.id, baseline + 4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sender.parameters.degradationPreference).toBe(
      "maintain-resolution",
    );
    feedVideoStats(pc, nextVideo.clones[0]!.id, baseline + 5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sender.parameters.degradationPreference).toBe("balanced");
  });

  it("applies the latest committed profile when startup recovery lands", async () => {
    const { publisher: host, pc, video } = await publisher();
    const sender = pc.transceivers[0]!.sender;
    const clone = video.clones[0]!;
    let releaseConstraints!: () => void;
    clone.applyConstraints.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseConstraints = () => resolve(undefined);
        }),
    );
    const update = host.updateProfile(QUALITY_PROFILES["720p30"]);
    await vi.advanceTimersByTimeAsync(0);
    feedVideoStats(pc, clone.id, 6);
    await vi.advanceTimersByTimeAsync(2_000);
    releaseConstraints();
    expect(await update).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    // The user's 720p30 change must survive the queued startup recovery; a
    // stats-time snapshot must not re-apply the previous 1080p30 profile.
    expect(sender.parameters.degradationPreference).toBe("balanced");
    expect(sender.parameters.encodings[1]).toMatchObject({
      maxBitrate: 3_000_000,
    });
  });

  it("rolls back a failed source replacement and releases its unused clone", async () => {
    const { publisher: host, pc, video } = await publisher();
    pc.transceivers[0]!.sender.replaceTrack.mockRejectedValueOnce(
      new Error("replace rejected"),
    );
    const replacement = new FakeTrack("video");
    expect(await host.replaceStream(stream(replacement))).toBe(false);
    expect(pc.transceivers[0]!.sender.track).toBe(video.clones[0]);
    expect(video.clones[0]!.stop).not.toHaveBeenCalled();
    expect(replacement.clones[0]!.stop).toHaveBeenCalledOnce();
    expect(pc.close).not.toHaveBeenCalled();
  });

  it("preserves media during a signaling outage and updates only the route fence", async () => {
    const { publisher: host, pc, send, onDisconnected } = await publisher();
    await host.acceptSignal(
      signal({ description: { type: "answer", sdp: "answer" } }),
    );
    pc.state("connected");
    send.mockReturnValue(false);
    expect(await host.updateProfile(QUALITY_PROFILES["720p30"])).toBe(false);
    expect(pc.close).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    send.mockReturnValue(true);
    host.updateConfig({ ...config, revision: 9 });
    expect(await host.updateProfile(QUALITY_PROFILES["720p30"])).toBe(true);
    const updated = send.mock.calls.at(-1)![0];
    expect(updated.revision).toBe(9);
    expect(clientMessageSchema.safeParse(updated).success).toBe(true);
  });

  it("answers the server offer and commits only decoded video, preserving media during ICE restart", async () => {
    const send = vi.fn(() => true);
    const onFirstDecodedFrame = vi.fn(() => true);
    const onStream = vi.fn();
    const onDisconnected = vi.fn();
    const subscriber = new SfuSubscriber({
      send,
      onStream,
      onFirstDecodedFrame,
      onDisconnected,
    });
    cleanups.push(() => subscriber.disconnect());
    await subscriber.connect(config);
    subscriber.activate();
    subscriber.armDecodedFrameProof();
    const pc = FakePc.instances[0]!;
    await subscriber.acceptSignal(
      signal({ description: { type: "offer", sdp: "offer" } }),
    );
    let framesDecoded = 0;
    const video = new FakeTrack("video");
    pc.ontrack?.({
      track: video,
      receiver: {
        getStats: async () =>
          new Map([
            [
              "video",
              {
                id: "video",
                type: "inbound-rtp",
                kind: "video",
                framesDecoded,
              },
            ],
          ]),
      },
    });
    pc.state("connected");
    await vi.advanceTimersByTimeAsync(100);
    expect(onFirstDecodedFrame).not.toHaveBeenCalled();
    framesDecoded = 1;
    await vi.advanceTimersByTimeAsync(100);
    expect(onFirstDecodedFrame).toHaveBeenCalledOnce();
    expect(onStream).toHaveBeenCalledOnce();
    expect(subscriber.reconnect()).toBe(true);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "subscribe",
        connectionId: config.connectionId,
      }),
    );
    expect(pc.close).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    await subscriber.disconnect();
    expect(onStream).toHaveBeenLastCalledWith(null);
  });

  it("bounds pending ICE and reports one terminal failure", async () => {
    const { publisher: host, pc, onDisconnected } = await publisher();
    for (let index = 0; index < 65; index++) {
      await host.acceptSignal(
        signal({
          kind: "candidate",
          candidate: { candidate: `candidate:${index}` },
        }),
      );
    }
    expect(pc.close).toHaveBeenCalledOnce();
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(host.getFailureStage()).toBe("transport");
  });

  it("changes audio ceilings without touching video capture or sender parameters", async () => {
    const { publisher: host, pc, video } = await publisher();
    const constraints = video.clones[0]!.applyConstraints.mock.calls.length;
    const parameters =
      pc.transceivers[0]!.sender.setParameters.mock.calls.length;
    expect(
      await host.updateProfile({
        ...QUALITY_PROFILES["1080p30"],
        screenAudioQuality: "saver",
      }),
    ).toBe(true);
    expect(video.clones[0]!.applyConstraints).toHaveBeenCalledTimes(
      constraints,
    );
    expect(pc.transceivers[0]!.sender.setParameters).toHaveBeenCalledTimes(
      parameters,
    );
    expect(pc.transceivers[1]!.sender.parameters.encodings[0]!.maxBitrate).toBe(64_000);
  });

  it("closes every owned clone during in-flight replacement without stopping the sources", async () => {
    const { publisher: host, pc, video, sound } = await publisher();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    pc.transceivers[0]!.sender.setParameters.mockImplementationOnce(
      async () => blocked,
    );
    const replacement = new FakeTrack("video");
    const replacing = host.replaceStream(stream(replacement));
    await vi.advanceTimersByTimeAsync(0);
    host.setPaused(true);
    expect(replacement.clones[0]!.enabled).toBe(false);
    await host.disconnect();
    release();
    expect(await replacing).toBe(false);
    for (const track of [
      video.clones[0]!,
      sound.clones[0]!,
      replacement.clones[0]!,
    ])
      expect(track.stop).toHaveBeenCalledOnce();
    for (const source of [video, sound, replacement])
      expect(source.stop).not.toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("fails closed when restoring a replaced sender fails", async () => {
    const { publisher: host, pc, onDisconnected, video } = await publisher();
    pc.transceivers[0]!.sender.replaceTrack.mockRejectedValue(
      new Error("sender failed"),
    );
    const replacement = new FakeTrack("video");
    expect(await host.replaceStream(stream(replacement))).toBe(false);
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(video.clones[0]!.stop).toHaveBeenCalledOnce();
    expect(replacement.clones[0]!.stop).toHaveBeenCalledOnce();
  });

  it("uses the fenced SFU demand prefix without live profiles reactivating upper layers", async () => {
    const { publisher: host, pc } = await publisher();
    await host.acceptSignal(signal({ kind: "layers", activeCount: 1 }));
    expect(
      pc.transceivers[0]!.sender.parameters.encodings.map(
        (encoding) => encoding.active,
      ),
    ).toEqual([true, false]);
    await host.updateProfile(QUALITY_PROFILES["720p30"]);
    expect(
      pc.transceivers[0]!.sender.parameters.encodings.map(
        (encoding) => encoding.active,
      ),
    ).toEqual([true, false]);
    await host.acceptSignal(
      signal({
        kind: "layers",
        activeCount: 0,
        connectionId: "retired_connection",
      }),
    );
    expect(
      pc.transceivers[0]!.sender.parameters.encodings.map(
        (encoding) => encoding.active,
      ),
    ).toEqual([true, false]);
    await host.acceptSignal(signal({ kind: "layers", activeCount: 0 }));
    expect(
      pc.transceivers[0]!.sender.parameters.encodings.map(
        (encoding) => encoding.active,
      ),
    ).toEqual([false, false]);
    await host.acceptSignal(signal({ kind: "layers", activeCount: 2 }));
    expect(
      pc.transceivers[0]!.sender.parameters.encodings.map(
        (encoding) => encoding.active,
      ),
    ).toEqual([true, true]);
    expect(FakePc.instances).toHaveLength(1);
  });

  it("resumes an unsent ICE-restart offer after signaling returns on the same connection", async () => {
    const { publisher: host, pc, send, onDisconnected } = await publisher();
    await host.acceptSignal(
      signal({ description: { type: "answer", sdp: "answer" } }),
    );
    send.mockReturnValue(false);
    pc.state("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
    expect(pc.close).not.toHaveBeenCalled();
    send.mockClear();
    send.mockReturnValue(true);
    host.updateConfig({ ...config, revision: 5 });
    expect(send.mock.calls.map(([message]) => message.kind)).toEqual([
      "description",
      "candidate",
    ]);
    expect(send.mock.calls[0]![0].revision).toBe(5);
    expect(pc.close).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});
